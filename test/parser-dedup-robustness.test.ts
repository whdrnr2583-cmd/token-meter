import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonlFile } from '../src/parser.js';

/**
 * Generalization tests for the request_id dedup / sub-agent split-entry
 * accounting in src/parser.ts. Every fixture here is HAND-SYNTHESIZED in code
 * (not copied from any real Claude Code session file) so a pass proves the
 * contract holds for shapes the committed fixtures don't cover — reordered
 * growth, many split entries, corrupt lines, unknown models, and missing
 * request_ids — rather than just re-confirming one captured log.
 */

const BASE = '2026-07-09T12:00:00.000Z';

function assistant(opts: {
  requestId?: string | null;
  model?: string;
  output: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tsOffsetMs?: number;
}): string {
  const ts = new Date(Date.parse(BASE) + (opts.tsOffsetMs ?? 0)).toISOString();
  const entry: Record<string, unknown> = {
    type: 'assistant',
    message: {
      model: opts.model ?? 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'x' }],
      usage: {
        input_tokens: opts.input ?? 5,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        output_tokens: opts.output,
      },
    },
    timestamp: ts,
    sessionId: 'synthetic-session',
  };
  if (opts.requestId !== undefined && opts.requestId !== null) entry.requestId = opts.requestId;
  return JSON.stringify(entry);
}

function withTempFile(lines: string[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tm-parser-'));
  const path = join(dir, 'synthetic.jsonl');
  writeFileSync(path, lines.join('\n'), 'utf-8');
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('billed usage is the largest split entry even when it is NOT last in the file (reordered growth)', () => {
  // Growth streamed out of append order: max output is the MIDDLE entry, and a
  // smaller entry arrives last. A naive last-write-wins would undercount.
  withTempFile(
    [
      assistant({ requestId: 'req_shuffle', output: 100, tsOffsetMs: 0 }),
      assistant({ requestId: 'req_shuffle', output: 900, tsOffsetMs: 1000 }),
      assistant({ requestId: 'req_shuffle', output: 300, tsOffsetMs: 2000 }),
    ],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      const row = tokens.filter((t) => t.request_id === 'req_shuffle');
      assert.equal(row.length, 1, 'exactly one billed row per request_id');
      assert.equal(row[0]?.output_tokens, 900, 'must bill the largest (completed) total, not the file-last entry');
    },
  );
});

test('handles many (>3) split entries for one request_id and bills the completed total', () => {
  withTempFile(
    [1, 2, 3, 4, 5, 600].map((o, i) =>
      assistant({ requestId: 'req_many', output: o, cacheRead: 42, tsOffsetMs: i * 500 }),
    ),
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      const rows = tokens.filter((t) => t.request_id === 'req_many');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.output_tokens, 600);
      assert.equal(rows[0]?.cache_read_tokens, 42, 'fixed cache tokens preserved from the completed entry');
    },
  );
});

test('corrupt / truncated / garbage lines are skipped without dropping surrounding valid events', () => {
  withTempFile(
    [
      'this is not json at all',
      assistant({ requestId: 'req_ok1', output: 111 }),
      '{"type":"assistant","message":{"model":"claude-sonnet-5","usage":{"input_toke', // truncated partial write
      '', // blank line
      '   ', // whitespace-only
      '{}', // valid json, no usable fields
      assistant({ requestId: 'req_ok2', output: 222 }),
    ],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      const ids = new Set(tokens.map((t) => t.request_id));
      assert.deepEqual(ids, new Set(['req_ok1', 'req_ok2']), 'both valid events survive; corrupt lines ignored');
      assert.equal(tokens.length, 2);
    },
  );
});

test('an unrecognized model name is still billed with a non-zero USD estimate (graceful pricing fallback)', () => {
  withTempFile(
    [assistant({ requestId: 'req_unknown', model: 'claude-zeta-9-experimental', output: 1000, input: 1000 })],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      const row = tokens.find((t) => t.request_id === 'req_unknown');
      assert.ok(row, 'unknown-model event is not dropped');
      assert.ok((row?.usd_estimate ?? 0) > 0, 'unknown model must not silently price at $0');
    },
  );
});

test('entries with no request_id each bill immediately (nothing to dedup against)', () => {
  withTempFile(
    [
      assistant({ output: 10, tsOffsetMs: 0 }),
      assistant({ output: 20, tsOffsetMs: 1000 }),
    ],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      assert.equal(tokens.length, 2, 'two request_id-less events => two separate rows');
      assert.deepEqual(
        tokens.map((t) => t.output_tokens).sort((a, b) => a - b),
        [10, 20],
      );
      assert.ok(tokens.every((t) => t.request_id === null));
    },
  );
});

test('identical main-session duplicates keep the LATEST timestamp (last-write-wins on exact ties)', () => {
  // All three carry the same (backfilled) usage — the main-session case where
  // last-vs-first is only observable via `ts`. The `>=` tie rule must still
  // land on the final entry so downstream session timing stays consistent.
  withTempFile(
    [0, 1000, 2000].map((off) =>
      assistant({ requestId: 'req_ident', output: 50, input: 5, cacheRead: 7, tsOffsetMs: off }),
    ),
    (path) => {
      const { tokens } = parseJsonlFile(path, 'synthetic');
      const rows = tokens.filter((t) => t.request_id === 'req_ident');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.ts, Date.parse(BASE) + 2000, 'ties resolve to the latest sighting');
    },
  );
});
