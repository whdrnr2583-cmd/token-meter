import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb } from '../src/db.js';
import { readLines } from '../src/jsonl-lines.js';
import { ingestClaudeCode } from '../src/ingest.js';
import { ingestCodex } from '../src/codex-ingest.js';
import { parseJsonlFile } from '../src/parser.js';
import { parseCodexSession } from '../src/codex-parser.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tm-robust-'));
}

function withHome<T>(home: string, fn: () => T): T {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('readLines: splits correctly across tiny chunks incl. multi-byte chars and no trailing newline', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'a.jsonl');
    const lines = ['{"a":"한글🙂"}', '', '{"b":"é"}', '{"c":1}'];
    writeFileSync(f, lines.join('\n')); // no trailing newline
    for (const chunk of [1, 2, 3, 5, 64]) {
      assert.deepEqual([...readLines(f, chunk)], lines, `chunk=${chunk}`);
    }
    writeFileSync(f, lines.join('\n') + '\n');
    assert.deepEqual([...readLines(f, 4)], lines);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseJsonlFile handles a file larger than one read chunk', () => {
  const dir = tmp();
  try {
    const f = join(dir, 'sess.jsonl');
    const n = 3000;
    const rows: string[] = [];
    for (let i = 0; i < n; i++) {
      rows.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(),
          requestId: `req_${i}`,
          message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
        }),
      );
    }
    writeFileSync(f, rows.join('\n') + '\n');
    assert.equal(parseJsonlFile(f, 'p').tokens.length, n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestClaudeCode: a file that fails to parse is skipped and reported, others still ingest, and it is retried next run', () => {
  const home = tmp();
  try {
    const proj = join(home, '.claude', 'projects', '-tmp-proj');
    mkdirSync(proj, { recursive: true });
    const good = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T00:00:00.000Z',
      requestId: 'req_good',
      message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
    });
    writeFileSync(join(proj, 'good.jsonl'), good + '\n');
    writeFileSync(join(proj, 'bad.jsonl'), good + '\n');

    withHome(home, () => {
      const db = openDb(':memory:');
      migrate(db);
      const failing = (path: string, project: string, agentId: string | null) => {
        if (path.endsWith('bad.jsonl')) throw new Error('EBUSY: resource busy');
        return parseJsonlFile(path, project, agentId);
      };
      const s1 = ingestClaudeCode(db, { parse: failing });
      assert.equal(s1.files_failed, 1);
      assert.equal(s1.files_processed, 1);
      assert.match(s1.errors[0]!, /bad\.jsonl: EBUSY/);
      // The failed file must not be marked as ingested -> next run retries it.
      const s2 = ingestClaudeCode(db);
      assert.equal(s2.files_failed, 0);
      assert.equal(s2.files_processed, 1);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ingestCodex: a failing session file is skipped and reported instead of aborting', () => {
  const home = tmp();
  try {
    const dir = join(home, '.codex', 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-a.jsonl'), '{}\n');
    writeFileSync(join(dir, 'rollout-b.jsonl'), '{}\n');
    withHome(home, () => {
      const db = openDb(':memory:');
      migrate(db);
      const s = ingestCodex(db, {
        parse: (p) => {
          if (p.endsWith('rollout-a.jsonl')) throw new Error('boom');
          return parseCodexSession(p);
        },
      });
      assert.equal(s.files_failed, 1);
      assert.equal(s.files_processed, 1);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function codexFile(dir: string, events: unknown[]): string {
  const f = join(dir, 'rollout.jsonl');
  const head = { timestamp: '2026-10-01T00:00:00.000Z', type: 'session_meta', payload: { id: 'sess-abcdef-123456789012', cwd: '/x' } };
  writeFileSync(f, [head, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return f;
}
const tc = (ts: string, last: Record<string, number>, total?: Record<string, number>) => ({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: last, ...(total ? { total_token_usage: total } : {}) } },
});

test('codex: reasoning tokens already inside output_tokens (total_tokens = input+output) are not added twice', () => {
  const dir = tmp();
  try {
    const f = codexFile(dir, [
      tc('2026-10-01T00:00:01.000Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 30, total_tokens: 150 }),
    ]);
    assert.equal(parseCodexSession(f).tokens[0]!.output_tokens, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: reasoning is added when total_tokens shows it is separate, and when total_tokens is absent (legacy behaviour)', () => {
  const dir = tmp();
  try {
    const sep = codexFile(dir, [
      tc('2026-10-01T00:00:01.000Z', { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 30, total_tokens: 180 }),
    ]);
    assert.equal(parseCodexSession(sep).tokens[0]!.output_tokens, 80);
    const none = codexFile(dir, [
      tc('2026-10-01T00:00:01.000Z', { input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 30 }),
    ]);
    assert.equal(parseCodexSession(none).tokens[0]!.output_tokens, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: a repeated token_count whose cumulative total did not change is not billed twice', () => {
  const dir = tmp();
  try {
    const last = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 150 };
    const total = { ...last };
    const total2 = { input_tokens: 220, cached_input_tokens: 0, output_tokens: 90, reasoning_output_tokens: 0, total_tokens: 310 };
    const f = codexFile(dir, [
      tc('2026-10-01T00:00:01.000Z', last, total),
      tc('2026-10-01T00:00:05.000Z', last, total), // stale repeat
      tc('2026-10-01T00:00:09.000Z', { input_tokens: 120, output_tokens: 40, total_tokens: 160 }, total2),
    ]);
    assert.equal(parseCodexSession(f).tokens.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
