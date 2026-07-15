import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import { cacheInefficiencyDetector } from '../src/audit/detectors/cache-inefficiency.js';
import { CACHE_INEFFICIENCY_MIN_TOKENS } from '../src/audit/config.js';
import type { DetectorContext } from '../src/audit/types.js';
import type { TokenEvent } from '../src/types.js';

// A handful of hours ago — safely "today" and inside any reasonable window,
// same pattern stats-future-ts.test.ts uses to avoid day-boundary flake.
const BASE_TS = Date.now() - 2 * 60 * 60 * 1000;

function tokenEvent(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: BASE_TS,
    source: 'claude-code',
    source_kind: 'cloud',
    model: 'claude-sonnet-4-6',
    project: '/tmp/fake-project',
    session_id: 'sess-cache-1',
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

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function ctxFor(db: ReturnType<typeof freshDb>, overrides: Partial<DetectorContext> = {}): DetectorContext {
  const days = 30;
  return {
    db,
    sinceMs: Date.now() - days * 86_400_000,
    untilMs: Date.now(),
    days,
    source: 'all',
    project: null,
    limit: 10,
    ...overrides,
  };
}

test('flags a day whose wasted cache writes clear the min-tokens bar', () => {
  const db = freshDb();
  const wasted = CACHE_INEFFICIENCY_MIN_TOKENS + 1000; // clears the noise floor
  insertTokenEvents(db, [
    tokenEvent({
      request_id: 'req-flagged-1',
      cache_read_tokens: 1000,
      cache_write_tokens: 1000 + wasted,
    }),
  ]);

  const findings = cacheInefficiencyDetector(ctxFor(db));

  assert.equal(findings.length, 1);
  const finding = findings[0]!;
  assert.equal(finding.type, 'cache_inefficiency');
  assert.equal(finding.source, 'claude-code');
  assert.equal(finding.sessionId, null);
  assert.equal(finding.toolName, null);
  assert.equal(finding.confidence, 'medium');
  assert.match(finding.title, /1 day/);
  assert.equal(finding.metrics.totalWastedWriteTokens, wasted);
  const days = finding.metrics.days as Array<{ wastedWriteTokens: number }>;
  assert.equal(days.length, 1);
  assert.equal(days[0]!.wastedWriteTokens, wasted);
  // A single model wrote all the cache tokens, so cost attribution should be
  // fully resolvable rather than falling back to not_available.
  assert.equal(finding.costLabel, 'estimated_cost');
  assert.ok(typeof finding.estimatedCostUsd === 'number' && finding.estimatedCostUsd > 0);
});

test('does not flag a day with normal cache reuse (reads >= writes)', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({
      request_id: 'req-reuse-1',
      cache_read_tokens: 50_000,
      cache_write_tokens: 2_000,
    }),
  ]);

  const findings = cacheInefficiencyDetector(ctxFor(db));

  assert.deepEqual(findings, []);
});

test('does not flag a day whose wasted writes stay below the noise floor', () => {
  const db = freshDb();
  const wasted = Math.min(200, CACHE_INEFFICIENCY_MIN_TOKENS - 1); // > 0 but below the bar
  insertTokenEvents(db, [
    tokenEvent({
      request_id: 'req-noise-1',
      cache_read_tokens: 1_000,
      cache_write_tokens: 1_000 + wasted,
    }),
  ]);

  const findings = cacheInefficiencyDetector(ctxFor(db));

  assert.deepEqual(findings, []);
});

test('source: codex returns an empty capability-status result, not a fabricated finding', () => {
  const db = freshDb();
  const wasted = CACHE_INEFFICIENCY_MIN_TOKENS + 1000;
  // Same claude-code data that triggers a finding in the first test above —
  // proves the empty result comes from an explicit source check, not from
  // there being no underlying waste to find.
  insertTokenEvents(db, [
    tokenEvent({
      request_id: 'req-codex-guard-1',
      cache_read_tokens: 1000,
      cache_write_tokens: 1000 + wasted,
    }),
  ]);

  const findings = cacheInefficiencyDetector(ctxFor(db, { source: 'codex' }));

  assert.deepEqual(findings, []);
});
