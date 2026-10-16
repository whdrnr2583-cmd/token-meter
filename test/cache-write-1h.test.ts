import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import { parseJsonlFile } from '../src/parser.js';
import { estimateUsd } from '../src/pricing.js';
import { cacheStats } from '../src/stats.js';
import type { TokenEvent } from '../src/types.js';

// 1h cache writes bill at 2x input (official pricing table, "1h cache writes"
// column); 5m writes at 1.25x. Claude Code JSONL splits the two under
// usage.cache_creation. All fixtures here are synthetic, written at runtime.

const TS = '2026-10-10T00:00:00.000Z';

function line(usage: Record<string, unknown>, requestId: string, model = 'claude-sonnet-4-6'): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: TS,
    requestId,
    sessionId: 'sess-1h',
    message: { model, usage },
  });
}

function withJsonl(lines: string[], fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tm-1h-'));
  try {
    const path = join(dir, 'sess-1h.jsonl');
    writeFileSync(path, lines.join('\n') + '\n');
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('estimateUsd bills the 1h portion of cache writes at 2x input', () => {
  // sonnet-4-6: input $3 -> 5m $3.75, 1h $6.
  const usd = estimateUsd({
    model: 'claude-sonnet-4-6',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000_000,
    cacheWrite1h: 400_000,
  });
  assert.equal(usd, 4.65); // 600k*3.75 + 400k*6 per million
  // Omitted 1h portion = all 5m (unchanged behaviour).
  assert.equal(
    estimateUsd({ model: 'claude-sonnet-4-6', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000 }),
    3.75,
  );
});

test('estimateUsd does not invent a 1h rate for models with no cache-write fee (OpenAI)', () => {
  const usd = estimateUsd({
    model: 'gpt-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 1000,
  });
  assert.equal(usd, 0);
});

test('parser splits usage.cache_creation into 5m/1h and prices the 1h part at 2x', () => {
  withJsonl(
    [
      line(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: { ephemeral_5m_input_tokens: 600_000, ephemeral_1h_input_tokens: 400_000 },
        },
        'req_split',
      ),
    ],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'p');
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0]!.cache_write_tokens, 1_000_000, 'cache_write_tokens stays the total');
      assert.equal(tokens[0]!.cache_write_1h_tokens, 400_000);
      assert.equal(tokens[0]!.usd_estimate, 4.65);
    },
  );
});

test('parser without usage.cache_creation treats all cache writes as 5m', () => {
  withJsonl(
    [line({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }, 'req_flat')],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'p');
      assert.equal(tokens[0]!.cache_write_tokens, 1_000_000);
      assert.equal(tokens[0]!.cache_write_1h_tokens ?? 0, 0);
      assert.equal(tokens[0]!.usd_estimate, 3.75);
    },
  );
});

test('parser: 1h portion larger than the total is clamped to the total', () => {
  withJsonl(
    [
      line(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 },
        },
        'req_clamp',
      ),
    ],
    (path) => {
      const { tokens } = parseJsonlFile(path, 'p');
      assert.equal(tokens[0]!.cache_write_tokens, 1000);
      assert.equal(tokens[0]!.cache_write_1h_tokens, 1000);
    },
  );
});

test('migrate adds cache_write_1h_tokens to a DB created with the old schema; old rows keep their stored values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-1h-db-'));
  try {
    const dbPath = join(dir, 'old.db');
    // Old schema: token_events without cache_write_1h_tokens (and without the later additive columns).
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE token_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, source TEXT NOT NULL, source_kind TEXT NOT NULL,
        model TEXT NOT NULL, project TEXT NOT NULL, session_id TEXT NOT NULL, request_id TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER, tps REAL, usd_estimate REAL NOT NULL DEFAULT 0
      );
      INSERT INTO token_events (ts, source, source_kind, model, project, session_id, request_id,
        cache_write_tokens, usd_estimate)
      VALUES (1, 'claude-code', 'cloud', 'claude-sonnet-4-6', 'p', 's', 'req_old', 1000000, 3.75);
    `);
    old.close();

    const db = openDb(dbPath);
    migrate(db);
    migrate(db); // idempotent
    const cols = (db.prepare('PRAGMA table_info(token_events)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('cache_write_1h_tokens'));
    const oldRow = db.prepare(`SELECT cache_write_tokens, cache_write_1h_tokens, usd_estimate FROM token_events WHERE request_id = 'req_old'`).get() as
      { cache_write_tokens: number; cache_write_1h_tokens: number; usd_estimate: number };
    assert.equal(oldRow.cache_write_1h_tokens, 0);
    assert.equal(oldRow.usd_estimate, 3.75, 'stored rows are not recomputed');

    const ev: TokenEvent = {
      ts: 2, source: 'claude-code', source_kind: 'cloud', model: 'claude-sonnet-4-6', project: 'p',
      session_id: 's', request_id: 'req_new', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0,
      cache_write_tokens: 1_000_000, cache_write_1h_tokens: 400_000, total_duration_ms: null, tps: null,
      usd_estimate: 4.65,
    };
    insertTokenEvents(db, [ev]);
    const newRow = db.prepare(`SELECT cache_write_1h_tokens FROM token_events WHERE request_id = 'req_new'`).get() as { cache_write_1h_tokens: number };
    assert.equal(newRow.cache_write_1h_tokens, 400_000);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cacheStats write_cost_usd prices stored 1h cache writes at 2x', () => {
  const db = openDb(':memory:');
  migrate(db);
  insertTokenEvents(db, [{
    ts: Date.now() - 60_000, source: 'claude-code', source_kind: 'cloud', model: 'claude-sonnet-4-6',
    project: 'p', session_id: 's', request_id: 'req_stats', input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 1_000_000, cache_write_1h_tokens: 400_000,
    total_duration_ms: null, tps: null, usd_estimate: 4.65,
  }]);
  const s = cacheStats(db, 1);
  assert.equal(s.write_cost_usd, 4.65);
  db.close();
});
