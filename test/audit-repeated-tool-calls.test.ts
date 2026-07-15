import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { migrate, openDb } from '../src/db.js';
import { repeatedSimilarToolCalls } from '../src/audit/detectors/repeated-tool-calls.js';
import type { DetectorContext } from '../src/audit/types.js';
import {
  REPEATED_CALL_TIME_WINDOW_MS,
  REPEATED_CALL_SIZE_TOLERANCE_PCT,
} from '../src/audit/config.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-audit-repeated-'));
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

let toolUseCounter = 0;

function insertToolEvent(
  db: ReturnType<typeof openDb>,
  opts: {
    ts: number;
    session_id: string;
    tool_name: string;
    mcp_server?: string | null;
    response_chars: number;
    source?: 'claude-code' | 'codex';
    project?: string;
  },
): void {
  toolUseCounter += 1;
  db.prepare(
    `INSERT INTO tool_events
      (ts, source, project, session_id, tool_name, mcp_server,
       tool_use_id, response_chars, response_tokens_est, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.ts,
    opts.source ?? 'claude-code',
    opts.project ?? '/proj',
    opts.session_id,
    opts.tool_name,
    opts.mcp_server ?? null,
    `use-${toolUseCounter}`,
    opts.response_chars,
    Math.round(opts.response_chars / 4),
    100,
  );
}

// Fixed epoch anchor so test data timing is deterministic regardless of
// wall-clock time the suite happens to run at.
const BASE_TS = 1_800_000_000_000;

function makeCtx(overrides: Partial<DetectorContext> = {}): DetectorContext {
  return {
    db: overrides.db!,
    sinceMs: BASE_TS - 24 * 3600_000,
    untilMs: BASE_TS + 24 * 3600_000,
    days: 2,
    source: 'all',
    project: null,
    limit: 20,
    ...overrides,
  };
}

test('fires for clearly repeated same-shape calls within the window', () => {
  const { db, cleanup } = freshDb();
  try {
    // 5 calls, same tool/session/mcp, identical response size, 10s apart —
    // comfortably inside REPEATED_CALL_TIME_WINDOW_MS.
    for (let i = 0; i < 5; i++) {
      insertToolEvent(db, {
        ts: BASE_TS + i * 10_000,
        session_id: 'sess-1',
        tool_name: 'Read',
        response_chars: 1000,
      });
    }

    const findings = repeatedSimilarToolCalls(makeCtx({ db }));
    assert.equal(findings.length, 1, 'should produce exactly one cluster finding');

    const f = findings[0]!;
    assert.equal(f.type, 'repeated_similar_tool_calls');
    assert.equal(f.toolName, 'Read');
    assert.equal(f.sessionId, 'sess-1');
    assert.equal(f.confidence, 'medium', 'fuzzy match must never claim high confidence');
    assert.equal(f.estimatedCostUsd, null);
    assert.equal(f.costLabel, 'not_available');
    assert.equal(f.metrics.callCount, 5);
    assert.equal(f.metrics.toolName, 'Read');
    assert.equal(f.metrics.sessionId, 'sess-1');
    assert.equal(f.metrics.windowMs, REPEATED_CALL_TIME_WINDOW_MS);
    assert.equal(f.metrics.avgResponseChars, 1000);

    // expose_similarity_basis: evidence must explicitly state the proxy
    // nature of the match and that arguments aren't stored.
    const evidenceText = f.evidence.join(' ');
    assert.match(evidenceText, /same tool/i);
    assert.match(evidenceText, /same session/i);
    assert.match(evidenceText, /response size within/i);
    assert.match(evidenceText, /window/i);
    assert.match(evidenceText, /arguments are not stored/i);
    assert.match(evidenceText, /proxy signal/i);
    assert.match(evidenceText, /not confirmed duplicate calls/i);
  } finally {
    cleanup();
  }
});

test('calls spread far apart in time are not grouped', () => {
  const { db, cleanup } = freshDb();
  try {
    // Same tool/session/size, but spaced well beyond the time window so no
    // two consecutive calls can share a cluster.
    const gap = REPEATED_CALL_TIME_WINDOW_MS * 3;
    for (let i = 0; i < 5; i++) {
      insertToolEvent(db, {
        ts: BASE_TS + i * gap,
        session_id: 'sess-2',
        tool_name: 'Read',
        response_chars: 1000,
      });
    }

    const findings = repeatedSimilarToolCalls(makeCtx({ db }));
    assert.equal(findings.length, 0, 'time-scattered calls must not be grouped');
  } finally {
    cleanup();
  }
});

test('calls with very different response sizes are not grouped', () => {
  const { db, cleanup } = freshDb();
  try {
    // Same tool/session, all within the time window, but alternating
    // response sizes far outside REPEATED_CALL_SIZE_TOLERANCE_PCT of each
    // other — no run of >=3 should ever share a cluster.
    const sizes = [100, 5000, 100, 5000, 100];
    sizes.forEach((chars, i) => {
      insertToolEvent(db, {
        ts: BASE_TS + i * 10_000,
        session_id: 'sess-3',
        tool_name: 'Read',
        response_chars: chars,
      });
    });

    const findings = repeatedSimilarToolCalls(makeCtx({ db }));
    assert.equal(findings.length, 0, 'size-dissimilar calls must not be grouped');
  } finally {
    cleanup();
  }
});

test('single/no calls never fire', () => {
  const { db, cleanup } = freshDb();
  try {
    // No calls at all.
    assert.equal(repeatedSimilarToolCalls(makeCtx({ db })).length, 0);

    // A single call.
    insertToolEvent(db, {
      ts: BASE_TS,
      session_id: 'sess-4',
      tool_name: 'Read',
      response_chars: 1000,
    });
    assert.equal(repeatedSimilarToolCalls(makeCtx({ db })).length, 0);

    // Two similar calls — still below MIN_CALLS_TO_FIRE (3).
    insertToolEvent(db, {
      ts: BASE_TS + 10_000,
      session_id: 'sess-4',
      tool_name: 'Read',
      response_chars: 1000,
    });
    assert.equal(
      repeatedSimilarToolCalls(makeCtx({ db })).length,
      0,
      '2 similar calls must not fire (avoid 2-call false positives)',
    );

    // A third similar call tips it over the threshold.
    insertToolEvent(db, {
      ts: BASE_TS + 20_000,
      session_id: 'sess-4',
      tool_name: 'Read',
      response_chars: 1000,
    });
    assert.equal(repeatedSimilarToolCalls(makeCtx({ db })).length, 1);
  } finally {
    cleanup();
  }
});

test('different sessions/tools/mcp servers are not merged into one cluster', () => {
  const { db, cleanup } = freshDb();
  try {
    // 2 calls in session A, 2 calls in session B, same tool/size/time —
    // grouping is per-session, so neither reaches the >=3 threshold alone.
    insertToolEvent(db, { ts: BASE_TS, session_id: 'sess-A', tool_name: 'Read', response_chars: 1000 });
    insertToolEvent(db, { ts: BASE_TS + 5_000, session_id: 'sess-A', tool_name: 'Read', response_chars: 1000 });
    insertToolEvent(db, { ts: BASE_TS, session_id: 'sess-B', tool_name: 'Read', response_chars: 1000 });
    insertToolEvent(db, { ts: BASE_TS + 5_000, session_id: 'sess-B', tool_name: 'Read', response_chars: 1000 });

    const findings = repeatedSimilarToolCalls(makeCtx({ db }));
    assert.equal(findings.length, 0, 'cross-session pairs must not combine into a single finding');
  } finally {
    cleanup();
  }
});

test('respects ctx.limit by returning the most-repeated clusters first', () => {
  const { db, cleanup } = freshDb();
  try {
    // Session A: 3 calls. Session B: 6 calls. Both clusters qualify.
    for (let i = 0; i < 3; i++) {
      insertToolEvent(db, { ts: BASE_TS + i * 10_000, session_id: 'sess-small', tool_name: 'Read', response_chars: 1000 });
    }
    for (let i = 0; i < 6; i++) {
      insertToolEvent(db, { ts: BASE_TS + i * 10_000, session_id: 'sess-big', tool_name: 'Read', response_chars: 1000 });
    }

    const findings = repeatedSimilarToolCalls(makeCtx({ db, limit: 1 }));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.metrics.callCount, 6, 'the larger cluster should be kept under a tight limit');
  } finally {
    cleanup();
  }
});
