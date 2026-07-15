import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { migrate, openDb } from '../src/db.js';
import { expensiveSessionDetector } from '../src/audit/detectors/expensive-session.js';
import type { DetectorContext } from '../src/audit/types.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-audit-expensive-session-'));
  const path = join(dir, 'usage.db');
  const db = openDb(path);
  migrate(db);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// Seeds `opts.eventCount` token_events belonging to a single session, each
// worth `opts.usdPerEvent`. This detector reads only token_events (unlike
// trim-suggestions.ts's detectors, which also need tool_events), so this
// helper is intentionally narrower than trim-suggestions.test.ts's
// seedToolEvents().
function seedSessionEvents(
  db: ReturnType<typeof openDb>,
  opts: {
    sessionId: string;
    project?: string;
    source?: string;
    model?: string;
    eventCount: number;
    usdPerEvent: number;
    startTs?: number;
    spacingMs?: number;
  },
): void {
  const project = opts.project ?? '/proj';
  const source = opts.source ?? 'claude-code';
  const model = opts.model ?? 'claude-sonnet-4-5';
  const startTs = opts.startTs ?? Date.now();
  const spacingMs = opts.spacingMs ?? 60_000;
  for (let i = 0; i < opts.eventCount; i++) {
    db.prepare(
      `INSERT OR IGNORE INTO token_events
        (ts, source, source_kind, model, project, session_id, request_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_estimate)
       VALUES (?, ?, 'cloud', ?, ?, ?, ?, 500, 200, 0, 0, ?)`,
    ).run(
      startTs + i * spacingMs,
      source,
      model,
      project,
      opts.sessionId,
      `req-${opts.sessionId}-${i}`,
      opts.usdPerEvent,
    );
  }
}

function baseCtx(db: ReturnType<typeof openDb>, overrides: Partial<DetectorContext> = {}): DetectorContext {
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

test('expensiveSessionDetector: returns no findings on an empty DB without throwing', () => {
  const { db, cleanup } = freshDb();
  try {
    const findings = expensiveSessionDetector(baseCtx(db));
    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('expensiveSessionDetector: flags a session that clearly dominates the period cost', () => {
  const { db, cleanup } = freshDb();
  try {
    // One expensive session: 5 events x $0.50 = $2.50.
    seedSessionEvents(db, {
      sessionId: 'sess-expensive',
      eventCount: 5,
      usdPerEvent: 0.5,
    });
    // Four cheap sessions: 3 events x $0.02 = $0.06 each ($0.24 total).
    for (let i = 0; i < 4; i++) {
      seedSessionEvents(db, {
        sessionId: `sess-cheap-${i}`,
        eventCount: 3,
        usdPerEvent: 0.02,
      });
    }
    // Total analyzed cost: $2.74. Expensive session's share: ~91.2%.

    const findings = expensiveSessionDetector(baseCtx(db));
    assert.equal(findings.length, 1, 'exactly the one dominant session should be flagged');

    const finding = findings[0]!;
    assert.equal(finding.type, 'expensive_session');
    assert.equal(finding.sessionId, 'sess-expensive');
    assert.equal(finding.source, 'claude-code');
    assert.equal(finding.project, '/proj');
    assert.equal(finding.toolName, null);
    assert.equal(finding.costLabel, 'estimated_cost');
    assert.equal(finding.confidence, 'high', '5 underlying events >= 3 should be high confidence');
    assert.ok(finding.estimatedCostUsd !== null && Math.abs(finding.estimatedCostUsd - 2.5) < 1e-9);
    assert.deepEqual(finding.costEventIds, ['session:claude-code:sess-expensive']);

    const metrics = finding.metrics as {
      totalUsd: number;
      costSharePct: number;
      events: number;
      durationMs: number;
      topModel: string;
      project: string;
    };
    assert.ok(Math.abs(metrics.totalUsd - 2.5) < 1e-9);
    assert.ok(metrics.costSharePct > 15, `expected costSharePct > 15, got ${metrics.costSharePct}`);
    assert.equal(metrics.events, 5);
    assert.equal(metrics.topModel, 'claude-sonnet-4-5');
    assert.equal(metrics.project, '/proj');

    assert.ok(finding.title.includes('%'));
    assert.ok(finding.title.toLowerCase().includes('accounted for'));
    // Language rule: never call it "waste" or a problem.
    assert.ok(!finding.title.toLowerCase().includes('waste'));
    assert.ok(!finding.description.toLowerCase().includes('waste'));
    assert.ok(finding.description.includes('accounted for'));
  } finally {
    cleanup();
  }
});

test('expensiveSessionDetector: does NOT fire when no session stands out from the rest', () => {
  const { db, cleanup } = freshDb();
  try {
    // 10 sessions, all the same cost: 3 events x $0.05 = $0.15 each (10% share each).
    // Below the 15% threshold and no outlier ratio (all equal cost).
    for (let i = 0; i < 10; i++) {
      seedSessionEvents(db, {
        sessionId: `sess-even-${i}`,
        eventCount: 3,
        usdPerEvent: 0.05,
      });
    }

    const findings = expensiveSessionDetector(baseCtx(db));
    assert.deepEqual(findings, [], 'no session should be flagged when cost is evenly distributed');
  } finally {
    cleanup();
  }
});

test('expensiveSessionDetector: reports medium confidence when the dominant session has < 3 events', () => {
  const { db, cleanup } = freshDb();
  try {
    // One dominant session with only 2 underlying events.
    seedSessionEvents(db, {
      sessionId: 'sess-thin',
      eventCount: 2,
      usdPerEvent: 1.0,
    });
    // A handful of cheap sessions so the total isn't just this one session.
    for (let i = 0; i < 3; i++) {
      seedSessionEvents(db, {
        sessionId: `sess-cheap-${i}`,
        eventCount: 3,
        usdPerEvent: 0.02,
      });
    }

    const findings = expensiveSessionDetector(baseCtx(db));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.sessionId, 'sess-thin');
    assert.equal(findings[0]!.confidence, 'medium', '2 underlying events < 3 should be medium confidence');
  } finally {
    cleanup();
  }
});
