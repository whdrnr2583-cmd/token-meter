import http from 'node:http';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb } from '../src/db.js';
import { ChatMetricsCollector, createProxyServer, backendLabel } from '../src/proxy.js';
import { localPerf } from '../src/stats.js';
import type { TokenEvent } from '../src/types.js';

// ---- pure collector unit tests (no sockets) ----

test('ChatMetricsCollector: non-streaming body uses server-reported usage', () => {
  const c = new ChatMetricsCollector(1000, 'fallback');
  c.setFullBody(
    JSON.stringify({
      model: 'llama3.2',
      choices: [{ message: { content: 'hello there' } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),
  );
  const m = c.finalize(1500);
  assert.equal(m.model, 'llama3.2');
  assert.equal(m.input_tokens, 11);
  assert.equal(m.output_tokens, 7);
  assert.equal(m.output_estimated, false);
  assert.equal(m.ttft_ms, null, 'non-streaming has no TTFT');
  assert.equal(m.duration_ms, 500);
  assert.ok(m.tps && m.tps > 0);
});

test('ChatMetricsCollector: streaming captures TTFT and usage', () => {
  const c = new ChatMetricsCollector(1000, 'fallback');
  c.pushStreamChunk('data: {"model":"qwen2.5","choices":[{"delta":{"content":"He"}}]}\n\n', 1100);
  c.pushStreamChunk('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n', 1150);
  c.pushStreamChunk(
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    1200,
  );
  c.pushStreamChunk('data: [DONE]\n\n', 1200);
  const m = c.finalize(1300);
  assert.equal(m.model, 'qwen2.5');
  assert.equal(m.ttft_ms, 100, 'first content chunk at 1100, start 1000');
  assert.equal(m.output_tokens, 2, 'from final usage block');
  assert.equal(m.output_estimated, false);
});

test('ChatMetricsCollector: streaming without usage estimates output from chars', () => {
  const c = new ChatMetricsCollector(0, 'm');
  c.pushStreamChunk('data: {"choices":[{"delta":{"content":"1234567"}}]}\n\n', 10);
  c.pushStreamChunk('data: [DONE]\n\n', 20);
  const m = c.finalize(100);
  assert.equal(m.output_estimated, true);
  assert.equal(m.output_tokens, Math.ceil(7 / 3.5)); // 2
  assert.equal(m.ttft_ms, 10);
});

test('backendLabel derives a label or honors override', () => {
  assert.equal(backendLabel('http://127.0.0.1:11434'), 'local');
  assert.equal(backendLabel('http://localhost:1234'), 'local');
  assert.equal(backendLabel('http://127.0.0.1:11434', 'ollama'), 'ollama');
  assert.equal(backendLabel('http://gpu-box.lan:8000'), 'gpu-box');
});

// ---- end-to-end: proxy in front of a fake OpenAI-compatible upstream ----

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function postJson(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('proxy forwards a non-streaming chat call and records a local event', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'llama3.2',
          choices: [{ message: { content: 'hi there friend' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      );
    });
  });
  const upstreamPort = await listen(upstream);

  const db = openDb(':memory:');
  migrate(db);
  let recorded: TokenEvent | null = null;
  let resolveRec!: () => void;
  const recP = new Promise<void>((r) => (resolveRec = r));
  const proxy = createProxyServer({
    backend: `http://127.0.0.1:${upstreamPort}`,
    label: 'ollama',
    db,
    onRecord: (e) => {
      recorded = e;
      resolveRec();
    },
  });
  const proxyPort = await listen(proxy);

  try {
    const resp = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(resp.status, 200, 'passthrough status');
    assert.ok(resp.body.includes('hi there friend'), 'passthrough body intact');

    await recP;
    const e = recorded as unknown as TokenEvent;
    assert.ok(e, 'event recorded');
    assert.equal(e.source, 'ollama');
    assert.equal(e.source_kind, 'local');
    assert.equal(e.model, 'llama3.2');
    assert.equal(e.input_tokens, 12);
    assert.equal(e.output_tokens, 4);
    assert.equal(e.usd_estimate, 0);

    // and it shows up in the localPerf view
    const perf = localPerf(db, 3650);
    assert.equal(perf.length, 1);
    assert.equal(perf[0]!.source, 'ollama');
    assert.equal(perf[0]!.calls, 1);
  } finally {
    proxy.close();
    upstream.close();
  }
});

test('proxy measures TTFT on a streaming chat call', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"model":"qwen2.5","choices":[{"delta":{"content":"He"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
      res.write(
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const upstreamPort = await listen(upstream);

  const db = openDb(':memory:');
  migrate(db);
  let recorded: TokenEvent | null = null;
  let resolveRec!: () => void;
  const recP = new Promise<void>((r) => (resolveRec = r));
  const proxy = createProxyServer({
    backend: `http://127.0.0.1:${upstreamPort}`,
    label: 'ollama',
    db,
    onRecord: (e) => {
      recorded = e;
      resolveRec();
    },
  });
  const proxyPort = await listen(proxy);

  try {
    const resp = await postJson(proxyPort, '/v1/chat/completions', {
      model: 'qwen2.5',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(resp.status, 200);
    assert.ok(resp.body.includes('[DONE]'), 'stream passed through');

    await recP;
    const e = recorded as unknown as TokenEvent;
    assert.equal(e.model, 'qwen2.5');
    assert.equal(e.output_tokens, 2, 'from streamed usage block');
    assert.ok(e.ttft_ms !== null && e.ttft_ms! >= 0, 'TTFT measured');
  } finally {
    proxy.close();
    upstream.close();
  }
});
