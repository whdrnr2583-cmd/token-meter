import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { migrate, openDb } from '../src/db.js';
import { slowToolDetector } from '../src/audit/detectors/slow-tool.js';
import type { DetectorContext } from '../src/audit/types.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-audit-slow-tool-'));
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

// Seeds one tool_events row per entry in `latenciesMs` (null entries insert a
// row with latency_ms = NULL, i.e. "call happened but latency wasn't
// recorded" — distinct from a 0ms call). No matching token_events rows are
// needed: unlike trim-suggestions.ts's detectors, slow-tool.ts never joins
// or reads token_events.
function seedToolEvents(
  db: ReturnType<typeof openDb>,
  opts: {
    toolName: string;
    mcpServer?: string | null;
    project?: string;
    source?: 'claude-code' | 'codex';
    latenciesMs: (number | null)[];
    startTs?: number;
    spacingMs?: number;
  },
): void {
  const project = opts.project ?? '/proj';
  const source = opts.source ?? 'claude-code';
  const startTs = opts.startTs ?? Date.now();
  const spacingMs = opts.spacingMs ?? 60_000;
  const stmt = db.prepare(
    `INSERT INTO tool_events
      (ts, source, project, session_id, tool_name, mcp_server,
       tool_use_id, response_chars, response_tokens_est, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  opts.latenciesMs.forEach((latency, i) => {
    stmt.run(
      // Step backward from startTs (each subsequent event further in the
      // past), not forward — ctx.untilMs is computed as Date.now() shortly
      // AFTER seeding, and the detector's query is `ts < untilMs` (an
      // exclusive upper bound). Forward-stepping timestamps would land in
      // what is, at query time, "the future" and get silently excluded.
      startTs - i * spacingMs,
      source,
      project,
      `sess-${opts.toolName}-${i}`,
      opts.toolName,
      opts.mcpServer ?? null,
      `use-${opts.toolName}-${i}`,
      400,
      100,
      latency,
    );
  });
}

function baseCtx(db: ReturnType<typeof openDb>, overrides: Partial<DetectorContext> = {}): DetectorContext {
  const days = 30;
  return {
    db,
    sinceMs: Date.now() - days * 86_400_000,
    // A few minutes of slack past "now", not a bare Date.now(): the
    // detector's window end is exclusive (`ts < untilMs`), and
    // seedToolEvents() above anchors its most recent row at Date.now() too.
    // Without slack, a fast test run can call Date.now() for the seed and
    // for untilMs within the same millisecond, making the exclusive bound
    // silently drop that one most-recent row (flaky off-by-one).
    untilMs: Date.now() + 5 * 60_000,
    days,
    source: 'all',
    project: null,
    limit: 10,
    ...overrides,
  };
}

test('slowToolDetector: returns no findings on an empty DB without throwing', () => {
  const { db, cleanup } = freshDb();
  try {
    const findings = slowToolDetector(baseCtx(db));
    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('slowToolDetector: flags a tool with high latency across many calls, with sane percentile ordering', () => {
  const { db, cleanup } = freshDb();
  try {
    // 25 calls, latency stepping from 60s to 132s (min 60_000, max 132_000).
    const latencies = Array.from({ length: 25 }, (_, i) => 60_000 + i * 3_000);
    seedToolEvents(db, {
      toolName: 'sub_agent_call',
      mcpServer: 'agent-mcp',
      latenciesMs: latencies,
    });

    const findings = slowToolDetector(baseCtx(db));
    assert.equal(findings.length, 1);

    const finding = findings[0]!;
    assert.equal(finding.type, 'slow_tool');
    assert.equal(finding.toolName, 'sub_agent_call');
    assert.equal(finding.source, 'claude-code');
    assert.equal(finding.project, '/proj');
    assert.equal(finding.estimatedCostUsd, null);
    assert.equal(finding.costLabel, 'not_available');
    assert.deepEqual(finding.costEventIds, []);
    assert.equal(finding.confidence, 'high', '25 calls >= 20 should be high confidence');

    const metrics = finding.metrics as {
      toolName: string;
      mcpServer: string | null;
      meanMs: number;
      p50Ms: number;
      p95Ms: number;
      maxMs: number;
      callCount: number;
      failureRate: number | null;
    };
    assert.equal(metrics.toolName, 'sub_agent_call');
    assert.equal(metrics.mcpServer, 'agent-mcp');
    assert.equal(metrics.callCount, 25);
    assert.equal(metrics.failureRate, null);

    // Percentile ordering sanity (max >= p95 >= median is not a universal
    // mathematical law, but must hold for this monotonic latency series).
    assert.ok(metrics.maxMs >= metrics.p95Ms, `expected maxMs(${metrics.maxMs}) >= p95Ms(${metrics.p95Ms})`);
    assert.ok(metrics.p95Ms >= metrics.p50Ms, `expected p95Ms(${metrics.p95Ms}) >= p50Ms(${metrics.p50Ms})`);
    assert.equal(metrics.maxMs, Math.max(...latencies));

    // Mean must fall within [min, max] of the underlying sample.
    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    assert.ok(metrics.meanMs >= min && metrics.meanMs <= max, `expected meanMs(${metrics.meanMs}) in [${min}, ${max}]`);

    // failure_rate unavailability must be called out explicitly in evidence.
    assert.ok(
      finding.evidence.some((e) => e.toLowerCase().includes('failure_rate') && e.toLowerCase().includes('not available')),
      'evidence should note failure_rate is unavailable',
    );
    assert.ok(finding.title.toLowerCase().includes('averaging'));
  } finally {
    cleanup();
  }
});

test('slowToolDetector: does NOT fire for a fast tool', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      toolName: 'fast_tool',
      latenciesMs: Array.from({ length: 10 }, () => 200),
    });

    const findings = slowToolDetector(baseCtx(db));
    const forFastTool = findings.filter((f) => f.toolName === 'fast_tool');
    assert.equal(forFastTool.length, 0, 'a tool averaging 200ms should never be flagged as slow');
  } finally {
    cleanup();
  }
});

test('slowToolDetector: does NOT fire when call count is too low, even if the few calls are very slow', () => {
  const { db, cleanup } = freshDb();
  try {
    // Only 3 calls (below SLOW_TOOL_MIN_CALLS = 5), each extremely slow.
    seedToolEvents(db, {
      toolName: 'rare_slow_tool',
      latenciesMs: [50_000, 60_000, 70_000],
    });

    const findings = slowToolDetector(baseCtx(db));
    const forRareTool = findings.filter((f) => f.toolName === 'rare_slow_tool');
    assert.equal(forRareTool.length, 0, 'too few samples must not fire regardless of how slow they are');
  } finally {
    cleanup();
  }
});

test('slowToolDetector: reports medium confidence for 5-19 calls', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      toolName: 'moderately_used_slow_tool',
      latenciesMs: Array.from({ length: 10 }, () => 5_000),
    });

    const findings = slowToolDetector(baseCtx(db));
    const finding = findings.find((f) => f.toolName === 'moderately_used_slow_tool');
    assert.ok(finding, 'expected a finding for 10 calls averaging 5000ms');
    assert.equal(finding!.confidence, 'medium');
    assert.equal((finding!.metrics as { callCount: number }).callCount, 10);
  } finally {
    cleanup();
  }
});

test('slowToolDetector: calls with NULL latency_ms are excluded from stats, not treated as 0, and tracked separately', () => {
  const { db, cleanup } = freshDb();
  try {
    // 5 calls with real latency (avg 6000ms) + 3 calls with no recorded latency.
    // If nulls were coerced to 0ms, the mean would drop to 3750ms and the
    // sample size would silently read as 8 instead of 5.
    seedToolEvents(db, {
      toolName: 'partially_measured_tool',
      latenciesMs: [4_000, 5_000, 6_000, 7_000, 8_000, null, null, null],
    });

    const findings = slowToolDetector(baseCtx(db));
    const finding = findings.find((f) => f.toolName === 'partially_measured_tool');
    assert.ok(finding, 'expected a finding: 5 valid-latency calls averaging 6000ms clears the bar');

    const metrics = finding!.metrics as { callCount: number; meanMs: number };
    assert.equal(metrics.callCount, 5, 'callCount must reflect only calls with a recorded latency');
    assert.equal(metrics.meanMs, 6000, 'mean must be computed only over the 5 real latency values');

    assert.ok(
      finding!.evidence.some((e) => e.includes('3') && e.toLowerCase().includes('no recorded latency_ms')),
      'evidence should surface the 3 calls excluded for missing latency_ms',
    );
  } finally {
    cleanup();
  }
});

test('slowToolDetector: does NOT fire for a tool whose calls all have NULL latency_ms', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      toolName: 'never_measured_tool',
      latenciesMs: [null, null, null, null, null, null],
    });

    const findings = slowToolDetector(baseCtx(db));
    const finding = findings.find((f) => f.toolName === 'never_measured_tool');
    assert.equal(finding, undefined, 'zero calls with a recorded latency means zero sample size, must not fire');
  } finally {
    cleanup();
  }
});
