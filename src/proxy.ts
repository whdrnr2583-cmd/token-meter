import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import type Database from 'better-sqlite3';
import { insertTokenEvents, migrate, openDb } from './db.js';
import type { TokenEvent } from './types.js';

/**
 * Local LLM proxy (v0.1.20 foundation). A transparent reverse proxy in front
 * of any OpenAI-compatible local server (Ollama :11434, LM Studio :1234,
 * llama.cpp :8080, vLLM :8000). Everything is passed through byte-for-byte;
 * the only added work is *measuring* `/v1/chat/completions` calls so we can
 * record TTFT / TPS / token counts that the cloud JSONL path can't see.
 *
 * Instrumentation is strictly best-effort: if metric parsing throws, the
 * proxy still forwards the response unchanged. Local calls are recorded with
 * source_kind='local' and usd_estimate=0 (no API cost; GPU/electricity cost
 * modelling is a later Pro+ increment).
 */

export interface ProxyOptions {
  port?: number;
  backend?: string; // base URL of the OpenAI-compatible local server
  label?: string; // source label, e.g. 'ollama'
  db?: Database.Database;
  onRecord?: (e: TokenEvent) => void; // test/observability hook
}

const DEFAULT_BACKEND = 'http://127.0.0.1:11434';
const DEFAULT_PORT = 11435;
const CHAT_PATH_RE = /\/chat\/completions$/;

export interface ChatMetrics {
  model: string;
  input_tokens: number;
  output_tokens: number;
  output_estimated: boolean; // true when counted from chars, not a usage block
  ttft_ms: number | null;
  duration_ms: number;
  tps: number | null;
}

interface UsageBlock {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/**
 * Accumulates an OpenAI chat-completions response (streaming SSE or one JSON
 * body) and derives the per-call metrics. Pure and feed-driven so it unit
 * tests without sockets.
 */
export class ChatMetricsCollector {
  private firstContentTs: number | null = null;
  private content = '';
  private model: string;
  private usage: UsageBlock | null = null;
  private buf = '';

  constructor(
    private readonly startTs: number,
    fallbackModel: string,
  ) {
    this.model = fallbackModel;
  }

  /** Feed a streaming SSE chunk (may contain partial / multiple `data:` lines). */
  pushStreamChunk(s: string, ts: number): void {
    this.buf += s;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      this.handleLine(line, ts);
    }
  }

  private handleLine(line: string, ts: number): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let obj: {
      model?: string;
      usage?: UsageBlock;
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
    };
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (obj.model) this.model = obj.model;
    if (obj.usage) this.usage = obj.usage;
    const piece = obj.choices?.[0]?.delta?.content ?? obj.choices?.[0]?.message?.content;
    if (typeof piece === 'string' && piece.length > 0) {
      if (this.firstContentTs === null) this.firstContentTs = ts;
      this.content += piece;
    }
  }

  /** Feed a complete non-streaming JSON body. */
  setFullBody(s: string): void {
    let obj: {
      model?: string;
      usage?: UsageBlock;
      choices?: Array<{ message?: { content?: string } }>;
    };
    try {
      obj = JSON.parse(s);
    } catch {
      return;
    }
    if (obj.model) this.model = obj.model;
    if (obj.usage) this.usage = obj.usage;
    const c = obj.choices?.[0]?.message?.content;
    if (typeof c === 'string') this.content += c;
  }

  finalize(endTs: number): ChatMetrics {
    const duration_ms = Math.max(0, endTs - this.startTs);
    let output_tokens = this.usage?.completion_tokens ?? 0;
    let output_estimated = false;
    if (!output_tokens && this.content) {
      // ~3.5 chars/token heuristic — same as the cloud parser. Flagged so the
      // UI can mark it as estimated rather than server-reported.
      output_tokens = Math.ceil(this.content.length / 3.5);
      output_estimated = true;
    }
    const input_tokens = this.usage?.prompt_tokens ?? 0;
    const ttft_ms = this.firstContentTs !== null ? this.firstContentTs - this.startTs : null;
    const tps =
      duration_ms > 0 && output_tokens > 0 ? output_tokens / (duration_ms / 1000) : null;
    return { model: this.model, input_tokens, output_tokens, output_estimated, ttft_ms, duration_ms, tps };
  }
}

export function backendLabel(backend: string, override?: string): string {
  if (override) return override;
  try {
    const host = new URL(backend).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return 'local';
    return host.split('.')[0] || 'local';
  } catch {
    return 'local';
  }
}

function recordLocalCall(
  db: Database.Database,
  label: string,
  m: ChatMetrics,
  onRecord?: (e: TokenEvent) => void,
): void {
  const e: TokenEvent = {
    ts: Date.now(),
    source: label,
    source_kind: 'local',
    model: m.model,
    project: `local:${label}`,
    session_id: 'proxy',
    request_id: `local-${randomUUID()}`,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_duration_ms: m.duration_ms,
    tps: m.tps,
    ttft_ms: m.ttft_ms,
    usd_estimate: 0, // local compute — no per-token API charge
    agent_id: null,
  };
  insertTokenEvents(db, [e]);
  onRecord?.(e);
}

export function createProxyServer(opts: ProxyOptions = {}): http.Server {
  const backend = new URL(opts.backend ?? DEFAULT_BACKEND);
  const label = backendLabel(opts.backend ?? DEFAULT_BACKEND, opts.label);
  let db = opts.db;
  if (!db) {
    db = openDb();
    migrate(db);
  }
  const theDb = db;

  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const reqBody = Buffer.concat(chunks);
      const path = (req.url ?? '').split('?')[0] ?? '';
      const instrument = req.method === 'POST' && CHAT_PATH_RE.test(path);
      let reqJson: { stream?: boolean; model?: string } | null = null;
      if (instrument) {
        try {
          reqJson = JSON.parse(reqBody.toString('utf8'));
        } catch {
          /* not JSON — forward without instrumenting */
        }
      }
      const wantStream = !!reqJson?.stream;
      const fallbackModel = reqJson?.model ?? 'unknown';

      const headers = { ...req.headers };
      delete headers['host'];
      delete headers['connection'];
      delete headers['transfer-encoding'];
      headers['content-length'] = String(reqBody.length);

      const upstreamReq = http.request(
        {
          hostname: backend.hostname,
          port: backend.port || 80,
          path: req.url,
          method: req.method,
          headers,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          const startTs = Date.now();
          const ctype = String(upstream.headers['content-type'] ?? '');
          const streaming = wantStream || ctype.includes('event-stream');
          const collector = instrument
            ? new ChatMetricsCollector(startTs, fallbackModel)
            : null;
          const bodyChunks: Buffer[] = [];
          upstream.on('data', (c: Buffer) => {
            res.write(c);
            if (!collector) return;
            if (streaming) collector.pushStreamChunk(c.toString('utf8'), Date.now());
            else bodyChunks.push(c);
          });
          upstream.on('end', () => {
            res.end();
            if (!collector) return;
            try {
              if (!streaming) collector.setFullBody(Buffer.concat(bodyChunks).toString('utf8'));
              recordLocalCall(theDb, label, collector.finalize(Date.now()), opts.onRecord);
            } catch {
              /* metrics best-effort — passthrough already completed */
            }
          });
        },
      );
      upstreamReq.on('error', (err: Error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`token-meter proxy: upstream error: ${err.message}`);
      });
      upstreamReq.write(reqBody);
      upstreamReq.end();
    });
  });
}

export async function startProxy(opts: ProxyOptions = {}): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const backend = opts.backend ?? DEFAULT_BACKEND;
  const label = backendLabel(backend, opts.label);
  const server = createProxyServer(opts);
  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(
        `token-meter proxy listening on http://127.0.0.1:${port} → ${backend} ` +
          `(source label: ${label})`,
      );
      console.log(
        'Point your OpenAI-compatible client base URL at the proxy; calls to ' +
          '/v1/chat/completions are measured (TTFT / TPS / tokens), everything else passes through.',
      );
      resolve();
    });
  });
  // Keep the process alive.
  await new Promise<never>(() => {});
}
