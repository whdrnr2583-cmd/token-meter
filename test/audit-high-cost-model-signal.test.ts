import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb } from '../src/db.js';
import { highCostModelSignalDetector } from '../src/audit/detectors/high-cost-model-signal.js';
import {
  HIGH_COST_MODEL_MIN_OUTPUT_TOKENS,
  HIGH_COST_MODEL_SHORT_SESSION_MS,
} from '../src/audit/config.js';
import type { DetectorContext } from '../src/audit/types.js';

// A handful of hours ago — safely "today" and inside any reasonable window,
// same pattern audit-cache-inefficiency.test.ts uses to avoid day-boundary flake.
const BASE_TS = Date.now() - 2 * 60 * 60 * 1000;

// Comfortably under the configured bars, derived from the constants
// themselves rather than hardcoded numbers, so these tests keep meaning if
// ../src/audit/config.ts's thresholds ever change.
const LOW_OUTPUT_PER_EVENT = Math.max(1, Math.floor(HIGH_COST_MODEL_MIN_OUTPUT_TOKENS / 5));
const SHORT_SPACING_MS = Math.max(1, Math.floor(HIGH_COST_MODEL_SHORT_SESSION_MS / 6));
// Comfortably over the short-session bar.
const LONG_SPACING_MS = HIGH_COST_MODEL_SHORT_SESSION_MS * 2;

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function ctxFor(
  db: ReturnType<typeof freshDb>,
  overrides: Partial<DetectorContext> = {},
): DetectorContext {
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

/** Seeds `opts.eventCount` token_events rows belonging to a single session. */
function seedSession(
  db: ReturnType<typeof freshDb>,
  opts: {
    sessionId: string;
    project?: string;
    source?: string;
    model?: string;
    eventCount: number;
    outputPerEvent: number;
    usdPerEvent: number;
    startTs?: number;
    spacingMs?: number;
  },
): void {
  const project = opts.project ?? '/proj';
  const source = opts.source ?? 'claude-code';
  const model = opts.model ?? 'claude-opus-4-7';
  const startTs = opts.startTs ?? BASE_TS;
  const spacingMs = opts.spacingMs ?? SHORT_SPACING_MS;
  for (let i = 0; i < opts.eventCount; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO token_events
        (ts, source, source_kind, model, project, session_id, request_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_estimate)
       VALUES (?, ?, 'cloud', ?, ?, ?, ?, 200, ?, 0, 0, ?)`,
    ).run(
      startTs + i * spacingMs,
      source,
      model,
      project,
      opts.sessionId,
      `req-${opts.sessionId}-${i}`,
      opts.outputPerEvent,
      opts.usdPerEvent,
    );
  }
}

test('returns no findings on an empty DB without throwing', () => {
  const db = freshDb();
  assert.deepEqual(highCostModelSignalDetector(ctxFor(db)), []);
});

test('flags a batch of short, low-output sessions on a high-cost model with confidence "low"', () => {
  const db = freshDb();
  const sessionIds = ['sess-a', 'sess-b', 'sess-c'];
  for (const id of sessionIds) {
    seedSession(db, {
      sessionId: id,
      eventCount: 2,
      outputPerEvent: LOW_OUTPUT_PER_EVENT,
      usdPerEvent: 0.05,
    });
  }

  const findings = highCostModelSignalDetector(ctxFor(db));

  assert.equal(findings.length, 1, 'one finding, grouped by model');
  const finding = findings[0]!;
  assert.equal(finding.type, 'high_cost_model_signal');
  assert.equal(finding.confidence, 'low', 'capped at low per the audit spec judgment-call rule');
  assert.equal(finding.costLabel, 'cost_associated');
  assert.equal(finding.sessionId, null, 'aggregate finding spans multiple sessions');
  assert.equal(finding.source, 'claude-code');
  assert.equal(finding.project, '/proj');

  const metrics = finding.metrics as {
    model: string;
    sessionCount: number;
    avgDurationMs: number;
    avgOutputTokens: number;
  };
  assert.equal(metrics.model, 'claude-opus-4-7');
  assert.equal(metrics.sessionCount, 3);
  assert.equal(metrics.avgOutputTokens, LOW_OUTPUT_PER_EVENT * 2);
  assert.equal(metrics.avgDurationMs, SHORT_SPACING_MS);
  assert.ok(metrics.avgDurationMs < HIGH_COST_MODEL_SHORT_SESSION_MS);
  assert.ok(metrics.avgOutputTokens < HIGH_COST_MODEL_MIN_OUTPUT_TOKENS);

  assert.ok(
    finding.estimatedCostUsd !== null && Math.abs(finding.estimatedCostUsd - 0.3) < 1e-9,
    'sum of the 3 sessions\' total_usd (0.05 * 2 events * 3 sessions)',
  );

  assert.equal(finding.costEventIds.length, 3);
  for (const id of sessionIds) {
    assert.ok(
      finding.costEventIds.includes(`session:claude-code:${id}`),
      `costEventIds should include session:claude-code:${id}`,
    );
  }

  assert.ok(finding.title.toLowerCase().includes('short'));
  assert.ok(finding.title.toLowerCase().includes('minimal output'));
  assert.equal(finding.title.match(/^3\s/) !== null, true, 'title leads with the session count');

  // Required review-prompt phrasing.
  assert.ok(
    finding.recommendations.includes('Review whether every short session required this model.'),
  );
  // Must not fabricate a specific cheaper-model-equivalent savings figure.
  for (const rec of finding.recommendations) {
    assert.ok(!/save[s]? \$\d/i.test(rec), `recommendation must not promise a $ savings figure: "${rec}"`);
    assert.ok(!/switch to (haiku|sonnet)/i.test(rec), `recommendation must not prescribe a replacement model: "${rec}"`);
  }
});

test('normal-length sessions on the same high-cost model are not flagged', () => {
  const db = freshDb();
  // Short + low-output — should be flagged.
  seedSession(db, {
    sessionId: 'sess-short',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.05,
    spacingMs: SHORT_SPACING_MS,
  });
  // Same model, same low output per call, but the session itself runs well
  // past the short-session bar — duration alone should disqualify it.
  seedSession(db, {
    sessionId: 'sess-normal',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.05,
    spacingMs: LONG_SPACING_MS,
  });

  const findings = highCostModelSignalDetector(ctxFor(db));

  assert.equal(findings.length, 1);
  const finding = findings[0]!;
  assert.equal(finding.metrics.sessionCount, 1, 'only the short session qualifies');
  assert.deepEqual(finding.costEventIds, ['session:claude-code:sess-short']);
});

test('a low-cost model (haiku) is never flagged, even with the same short/low-output shape', () => {
  const db = freshDb();
  for (const id of ['sess-h1', 'sess-h2', 'sess-h3']) {
    seedSession(db, {
      sessionId: id,
      model: 'claude-haiku-4-5',
      eventCount: 2,
      outputPerEvent: LOW_OUTPUT_PER_EVENT,
      usdPerEvent: 0.01,
      spacingMs: SHORT_SPACING_MS,
    });
  }

  const findings = highCostModelSignalDetector(ctxFor(db));
  assert.deepEqual(findings, []);
});

test('a low-cost model (sonnet) mixed with a high-cost model only flags the high-cost group', () => {
  const db = freshDb();
  seedSession(db, {
    sessionId: 'sess-opus',
    model: 'claude-opus-4-7',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.05,
  });
  seedSession(db, {
    sessionId: 'sess-sonnet',
    model: 'claude-sonnet-4-6',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.02,
  });

  const findings = highCostModelSignalDetector(ctxFor(db));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.metrics.model, 'claude-opus-4-7');
  assert.deepEqual(findings[0]!.costEventIds, ['session:claude-code:sess-opus']);
});

test('folds a project cost-concentration note into the top finding\'s evidence', () => {
  const db = freshDb();
  for (const id of ['sess-a', 'sess-b', 'sess-c']) {
    seedSession(db, {
      sessionId: id,
      project: '/dominant-proj',
      eventCount: 2,
      outputPerEvent: LOW_OUTPUT_PER_EVENT,
      usdPerEvent: 0.5,
    });
  }

  const findings = highCostModelSignalDetector(ctxFor(db));

  assert.equal(findings.length, 1);
  const finding = findings[0]!;
  assert.equal(finding.project, '/dominant-proj');
  assert.ok(
    finding.evidence.some((line) => line.includes('/dominant-proj') && line.includes('%')),
    'evidence should note the dominant project\'s cost share as a secondary signal',
  );
});

test('respects ctx.limit by capping the number of model-group findings returned', () => {
  const db = freshDb();
  seedSession(db, {
    sessionId: 'sess-opus',
    model: 'claude-opus-4-7',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.9,
  });
  seedSession(db, {
    sessionId: 'sess-fable',
    model: 'claude-fable-5',
    eventCount: 2,
    outputPerEvent: LOW_OUTPUT_PER_EVENT,
    usdPerEvent: 0.1,
  });

  const findings = highCostModelSignalDetector(ctxFor(db, { limit: 1 }));

  assert.equal(findings.length, 1);
  // Costliest model group first.
  assert.equal(findings[0]!.metrics.model, 'claude-opus-4-7');
});
