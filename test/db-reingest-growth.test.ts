import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import { parseJsonlFile } from '../src/parser.js';
import { estimateUsd } from '../src/pricing.js';
import type { TokenEvent } from '../src/types.js';

// Regression for the "30s re-ingest freezes a partial sub-agent total forever"
// bug: the dashboard re-scans every file on a 30s timer, so an early poll can
// persist a request_id while its sub-agent JSONL file is still mid-flush
// (output_tokens=2, before the tool_use block lands at 772). A plain
// INSERT OR IGNORE would then skip the completed re-parse and leave the row
// frozen at the partial value. insertTokenEvents must instead overwrite the
// stored row when a later re-parse carries a strictly larger total.
//
// Uses SYNTHETIC fixtures written at runtime (not a checked-in real-log
// fixture) so the assertion can't pass just because a captured sample happens
// to line up — the two flush states are constructed to isolate exactly this
// path.

/** One assistant JSONL line sharing `req_grow`, with a chosen output_tokens. */
function assistantLine(outputTokens: number, tsIso: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: tsIso,
    requestId: 'req_grow',
    sessionId: 'sess-grow',
    message: {
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 59965,
        cache_read_input_tokens: 12023,
        output_tokens: outputTokens,
      },
    },
  });
}

// Partial flush: only the thinking + text blocks are on disk (output=2 each).
const PARTIAL =
  assistantLine(2, '2026-07-11T04:00:00.000Z') + '\n' +
  assistantLine(2, '2026-07-11T04:00:01.000Z') + '\n';

// Complete flush: the tool_use block has landed, carrying the real total (772).
const COMPLETE = PARTIAL + assistantLine(772, '2026-07-11T04:00:02.000Z') + '\n';

test('re-ingesting a grown sub-agent file corrects a partially-flushed total (not frozen by INSERT OR IGNORE)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-reingest-'));
  try {
    const file = join(dir, 'agent-grow.jsonl');
    const db = openDb(':memory:');
    migrate(db);

    // First poll sees the mid-flush file → persists the partial total.
    writeFileSync(file, PARTIAL);
    const first = parseJsonlFile(file, 'proj', 'agent-grow');
    insertTokenEvents(db, first.tokens);
    let row = db
      .prepare(`SELECT output_tokens, usd_estimate FROM token_events WHERE request_id = 'req_grow'`)
      .get() as { output_tokens: number; usd_estimate: number };
    assert.equal(row.output_tokens, 2, 'first ingest stores the partial (mid-flush) total');

    // Later poll sees the completed file → must overwrite the partial row.
    writeFileSync(file, COMPLETE);
    const second = parseJsonlFile(file, 'proj', 'agent-grow');
    insertTokenEvents(db, second.tokens);
    row = db
      .prepare(`SELECT output_tokens, usd_estimate FROM token_events WHERE request_id = 'req_grow'`)
      .get() as { output_tokens: number; usd_estimate: number };
    assert.equal(row.output_tokens, 772, 're-ingest must correct the frozen partial total to the completed value');
    assert.equal(
      row.usd_estimate,
      estimateUsd({ model: 'claude-sonnet-5', input: 2, output: 772, cacheRead: 12023, cacheWrite: 59965 }),
      'usd_estimate is re-priced to the corrected total',
    );

    const count = db
      .prepare(`SELECT COUNT(*) AS c FROM token_events WHERE request_id = 'req_grow'`)
      .get() as { c: number };
    assert.equal(count.c, 1, 'still exactly one row per request_id (D-027 dedup intact)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tokenEvent(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: Date.parse('2026-07-11T04:00:00.000Z'),
    source: 'claude-code',
    source_kind: 'cloud',
    model: 'claude-sonnet-5',
    project: '/tmp/p',
    session_id: 'sess-x',
    request_id: 'req-x',
    input_tokens: 2,
    output_tokens: 772,
    cache_read_tokens: 12023,
    cache_write_tokens: 59965,
    total_duration_ms: null,
    tps: null,
    usd_estimate: 1,
    agent_id: null,
    ...over,
  };
}

test('a smaller/truncated re-read never clobbers an already-completed total', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Completed row lands first (output=772).
  insertTokenEvents(db, [tokenEvent({ request_id: 'req-done', output_tokens: 772 })]);
  // A later truncated/partial read of the same request_id (output=2) must NOT win.
  insertTokenEvents(db, [tokenEvent({ request_id: 'req-done', output_tokens: 2 })]);
  const row = db
    .prepare(`SELECT output_tokens FROM token_events WHERE request_id = 'req-done'`)
    .get() as { output_tokens: number };
  assert.equal(row.output_tokens, 772, 'strictly-larger-wins guards against shrinking on a bad read');
});

test('NULL request_id rows still dedup via the fallback index without throwing', () => {
  const db = openDb(':memory:');
  migrate(db);
  // Two rows with no request_id but identical (session_id, ts, model): the
  // fallback unique index + INSERT OR IGNORE must keep exactly one, and the
  // ON CONFLICT(source, request_id) upsert must not turn this into an error.
  const base = tokenEvent({ request_id: null, session_id: 'sess-null', output_tokens: 10 });
  insertTokenEvents(db, [base]);
  assert.doesNotThrow(() => insertTokenEvents(db, [{ ...base, output_tokens: 99 }]));
  const rows = db
    .prepare(`SELECT COUNT(*) AS c FROM token_events WHERE request_id IS NULL AND session_id = 'sess-null'`)
    .get() as { c: number };
  assert.equal(rows.c, 1, 'fallback index keeps exactly one NULL-request_id row');
});
