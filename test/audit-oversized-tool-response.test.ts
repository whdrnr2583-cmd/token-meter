import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { migrate, openDb } from '../src/db.js';
import { oversizedToolResponseDetector } from '../src/audit/detectors/oversized-tool-response.js';
import type { DetectorContext } from '../src/audit/types.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-audit-oversized-tool-response-'));
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

// Mirrors trim-suggestions.test.ts's seedToolEvents() helper: one matching
// token_event per tool_event (computeTrimSuggestions()'s avgTokenCostPerEvent()
// needs at least one token_events row to produce a non-zero usd/token rate),
// plus the tool_events rows themselves.
function seedToolEvents(
  db: ReturnType<typeof openDb>,
  opts: {
    tool_name: string;
    mcp_server?: string | null;
    count: number;
    response_tokens?: number;
  },
): void {
  for (let i = 0; i < opts.count; i++) {
    const ts = Date.now() - i * 3_600_000;
    const sessionId = `sess-${opts.tool_name}-${i}`;
    db.prepare(
      `INSERT OR IGNORE INTO token_events
        (ts, source, source_kind, model, project, session_id, request_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         usd_estimate)
       VALUES (?, 'claude-code', 'cloud', 'claude-sonnet-4-5',
               '/proj', ?, ?, 100, 50, 0, 0, 0.01)`,
    ).run(ts, sessionId, `req-tok-${opts.tool_name}-${i}`);
    db.prepare(
      `INSERT INTO tool_events
        (ts, source, project, session_id, tool_name, mcp_server,
         tool_use_id, response_chars, response_tokens_est, latency_ms)
       VALUES (?, 'claude-code', '/proj', ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      ts,
      sessionId,
      opts.tool_name,
      opts.mcp_server ?? null,
      `use-${opts.tool_name}-${i}`,
      (opts.response_tokens ?? 100) * 4,
      opts.response_tokens ?? 100,
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

test('oversizedToolResponseDetector: returns no findings on an empty DB without throwing', () => {
  const { db, cleanup } = freshDb();
  try {
    const findings = oversizedToolResponseDetector(baseCtx(db));
    assert.deepEqual(findings, []);
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: flags a tool with clearly oversized responses', () => {
  const { db, cleanup } = freshDb();
  try {
    // 8 calls averaging 12,000 tokens each — well past the 5000-token /
    // 5-call LARGE_RESPONSE bar in trim-suggestions.ts.
    seedToolEvents(db, {
      tool_name: 'Bash',
      count: 8,
      response_tokens: 12_000,
    });

    const findings = oversizedToolResponseDetector(baseCtx(db));
    assert.equal(findings.length, 1);

    const finding = findings[0]!;
    assert.equal(finding.type, 'oversized_tool_response');
    assert.equal(finding.toolName, 'Bash');
    assert.equal(finding.sessionId, null, 'tool-level finding must not carry a sessionId');
    assert.equal(finding.source, 'claude-code');
    assert.ok(finding.title.includes('Bash'));
    assert.ok(finding.title.toLowerCase().includes('averaging'));
    assert.ok(finding.title.includes('12k'), `expected compact "12k" in title, got: ${finding.title}`);

    assert.equal(finding.costLabel, 'cost_associated', 'a linked/projected savings estimate is cost_associated, not estimated_cost');
    assert.ok(finding.estimatedCostUsd !== null && finding.estimatedCostUsd > 0);
    assert.deepEqual(finding.costEventIds, ['tool:Bash:'], 'tool-level costEventIds use the tool:<name>:<mcpServer> convention');

    const metrics = finding.metrics as {
      toolName: string;
      mcpServer: string | null;
      callCount: number;
      meanTokens: number;
      maxTokens: number;
    };
    assert.equal(metrics.toolName, 'Bash');
    assert.equal(metrics.mcpServer, null);
    assert.equal(metrics.callCount, 8);
    assert.equal(metrics.meanTokens, 12_000);
    assert.equal(metrics.maxTokens, 12_000);

    assert.ok(finding.evidence.length > 0);
    assert.ok(finding.recommendations.length > 0);
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: does NOT fire for a tool with small/consistent responses', () => {
  const { db, cleanup } = freshDb();
  try {
    // 10 calls, well above the call-count floor, but tiny/consistent
    // response sizes — should never cross the 5000-avg-token bar.
    seedToolEvents(db, {
      tool_name: 'small_tool',
      count: 10,
      response_tokens: 200,
    });

    const findings = oversizedToolResponseDetector(baseCtx(db));
    assert.deepEqual(findings, [], 'small/consistent responses should not be flagged');
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: does NOT fire for low sample count below trim-suggestions\' minimum call threshold', () => {
  const { db, cleanup } = freshDb();
  try {
    // Only 3 calls (below the LARGE_RESPONSE detector's >= 5 call floor),
    // even though each response is huge.
    seedToolEvents(db, {
      tool_name: 'rare_tool',
      count: 3,
      response_tokens: 20_000,
    });

    const findings = oversizedToolResponseDetector(baseCtx(db));
    assert.deepEqual(findings, [], 'below the minimum call count, no finding should fire regardless of response size');
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: reports high confidence at >= 20 calls, medium below it', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'medium_confidence_tool',
      count: 8, // >= 5 (fires) but < 20 (not high confidence)
      response_tokens: 9_000,
    });
    seedToolEvents(db, {
      tool_name: 'high_confidence_tool',
      count: 25, // >= 20
      response_tokens: 9_000,
    });

    const findings = oversizedToolResponseDetector(baseCtx(db));
    const byName = new Map(findings.map((f) => [f.toolName, f]));

    assert.equal(byName.get('medium_confidence_tool')?.confidence, 'medium');
    assert.equal(byName.get('high_confidence_tool')?.confidence, 'high');
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: includes mcp_server in the costEventId and metrics when present', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'search_pages',
      mcp_server: 'notion',
      count: 8,
      response_tokens: 8_000,
    });

    const findings = oversizedToolResponseDetector(baseCtx(db));
    assert.equal(findings.length, 1);
    const finding = findings[0]!;
    assert.deepEqual(finding.costEventIds, ['tool:search_pages:notion']);
    assert.equal((finding.metrics as { mcpServer: string | null }).mcpServer, 'notion');
  } finally {
    cleanup();
  }
});

test('oversizedToolResponseDetector: respects ctx.limit', () => {
  const { db, cleanup } = freshDb();
  try {
    for (let i = 0; i < 8; i++) {
      seedToolEvents(db, {
        tool_name: `big_tool_${i}`,
        count: 8,
        response_tokens: 6_000 + i * 100,
      });
    }
    const findings = oversizedToolResponseDetector(baseCtx(db, { limit: 2 }));
    assert.ok(findings.length <= 2, `expected <= 2 findings, got ${findings.length}`);
  } finally {
    cleanup();
  }
});
