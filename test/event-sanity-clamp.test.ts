import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import type { TokenEvent } from '../src/types.js';

// H2 hardening: a corrupt/malformed usage line (e.g. a field that
// deserializes to a 12-digit number) must be clamped at insert time instead
// of silently inflating every downstream total (overview, daily, by-model,
// forecast, ...). Thresholds are calibrated off a read-only audit of a real
// usage.db — see the EVENT_TOKEN_FIELD_CEILING/EVENT_USD_CEILING comment in
// src/db.ts.

function tokenEvent(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: Date.now(),
    source: 'claude-code',
    source_kind: 'cloud',
    model: 'claude-opus-4-7',
    project: '/tmp/fake-project',
    session_id: 'sess-clamp',
    request_id: `req-${Math.random()}`,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_duration_ms: null,
    tps: null,
    usd_estimate: 1,
    agent_id: null,
    ...over,
  };
}

test('a synthetic 999999999999-token row is clamped, not left to pollute the total', () => {
  const db = openDb(':memory:');
  migrate(db);
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned++;
  };
  try {
    insertTokenEvents(db, [
      tokenEvent({ request_id: 'bogus-1', input_tokens: 999_999_999_999, usd_estimate: 5 }),
    ]);
  } finally {
    console.warn = originalWarn;
  }
  const row = db
    .prepare(`SELECT input_tokens FROM token_events WHERE request_id = 'bogus-1'`)
    .get() as { input_tokens: number };
  assert.ok(row.input_tokens < 999_999_999_999, 'the raw 999999999999 value must not reach the DB unclamped');
  assert.ok(row.input_tokens > 0, 'clamp must not zero out the field');
  assert.equal(warned, 1, 'exactly one console.warn for the anomalous row');

  const total = db
    .prepare(`SELECT COALESCE(SUM(input_tokens),0) AS v FROM token_events`)
    .get() as { v: number };
  assert.ok(total.v < 999_999_999_999, 'aggregate SUM must not be dominated by the clamped field');
});

test('an anomalously large usd_estimate is clamped independently of the token fields', () => {
  const db = openDb(':memory:');
  migrate(db);
  console.warn = () => {};
  insertTokenEvents(db, [tokenEvent({ request_id: 'bogus-usd', usd_estimate: 999_999 })]);
  const row = db
    .prepare(`SELECT usd_estimate FROM token_events WHERE request_id = 'bogus-usd'`)
    .get() as { usd_estimate: number };
  assert.ok(row.usd_estimate < 999_999, 'anomalous usd_estimate must be clamped');
  assert.ok(row.usd_estimate > 0);
});

test('a legitimate large cache_read burst (near a real 1M-token context window) is NOT clamped', () => {
  // Regression guard: the ceiling must sit well above real long-context
  // traffic. 985,005 was the largest real cache_read_tokens value observed
  // in a live audit — must pass through untouched.
  const db = openDb(':memory:');
  migrate(db);
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned++;
  };
  try {
    insertTokenEvents(db, [
      tokenEvent({ request_id: 'legit-huge-cache', cache_read_tokens: 985_005, usd_estimate: 0.99 }),
    ]);
  } finally {
    console.warn = originalWarn;
  }
  const row = db
    .prepare(`SELECT cache_read_tokens, usd_estimate FROM token_events WHERE request_id = 'legit-huge-cache'`)
    .get() as { cache_read_tokens: number; usd_estimate: number };
  assert.equal(row.cache_read_tokens, 985_005, 'a real-world-sized cache_read burst must not be clamped');
  assert.equal(row.usd_estimate, 0.99);
  assert.equal(warned, 0, 'no warning for a legitimate event');
});

test('a normal small event is untouched and never triggers a warning', () => {
  const db = openDb(':memory:');
  migrate(db);
  const originalWarn = console.warn;
  let warned = 0;
  console.warn = () => {
    warned++;
  };
  try {
    insertTokenEvents(db, [tokenEvent({ request_id: 'normal-1' })]);
  } finally {
    console.warn = originalWarn;
  }
  const row = db
    .prepare(`SELECT input_tokens, output_tokens, usd_estimate FROM token_events WHERE request_id = 'normal-1'`)
    .get() as { input_tokens: number; output_tokens: number; usd_estimate: number };
  assert.equal(row.input_tokens, 100);
  assert.equal(row.output_tokens, 50);
  assert.equal(row.usd_estimate, 1);
  assert.equal(warned, 0);
});
