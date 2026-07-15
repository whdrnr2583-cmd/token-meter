/**
 * Detector D3 "slow_tool" — surfaces tool/MCP-server pairs whose calls are
 * consistently slow, so the user can decide whether the call is worth the
 * wall-clock cost (cache it, drop it, or find a faster alternative).
 *
 * Builds on the same `tool_events` table as ../../trim-suggestions.ts's
 * HIGH_LATENCY pattern (mean `latency_ms` over a `(tool_name, mcp_server)`
 * group, gated by a minimum call count) but exposes a fuller latency
 * profile: mean, p50 (median), p95, max, the sample size behind those
 * numbers, and a failure_rate placeholder. The "slow" bar itself
 * (SLOW_TOOL_LATENCY_MS_THRESHOLD / SLOW_TOOL_MIN_CALLS, see ../config.ts)
 * is intentionally identical to trim-suggestions.ts's HIGH_LATENCY bar so
 * "slow" means the same thing in both features.
 *
 * ── Percentile method ──────────────────────────────────────────────────────
 * p50/p95 are computed with the nearest-rank method over latency_ms values
 * sorted ascending: rank = floor(p * (n - 1)), 0-indexed. Rather than
 * pulling every row for a group into JS and sorting there (unbounded for a
 * high-volume tool), each percentile is fetched directly from SQLite as
 * `ORDER BY latency_ms ASC LIMIT 1 OFFSET <rank>` — this returns exactly one
 * row per percentile no matter how many calls are in the group, so memory
 * use is O(1) per group rather than O(group size). mean/max are plain SQL
 * AVG()/MAX(), also O(1) to return (SQLite aggregates without materializing
 * the group into the result set).
 *
 * ── NULL latency handling ──────────────────────────────────────────────────
 * A call whose latency_ms was never recorded (NULL) must not corrupt the
 * mean (must NOT be treated as 0) and must not silently vanish either.
 * SQL's COUNT(latency_ms)/AVG(latency_ms)/MAX(latency_ms) already skip NULLs
 * per the standard, which handles the "don't corrupt the mean" half; this
 * detector additionally tracks how many rows in the group had a NULL
 * latency_ms (`callsMissingLatency`) as a separate metrics field so that
 * exclusion stays visible rather than silent. `callCount` (and the
 * confidence gate below) is the number of calls that actually have a
 * recorded latency — that is the true sample size backing meanMs/p50Ms/
 * p95Ms/maxMs, and confidence is about trusting *those* numbers.
 *
 * ── failure_rate ─────────────────────────────────────────────────────────
 * tool_events (see ../../db.ts's CREATE TABLE tool_events) has no
 * error/failure/status column of any kind — there is no signal in this
 * schema for "did this tool call fail". failureRate is therefore always
 * `null`, never fabricated, and its absence is called out in the finding's
 * evidence so a reader doesn't mistake the missing metric for "0% failures".
 */

import type Database from 'better-sqlite3';
import type { Confidence, Detector, DetectorContext, Finding } from '../types.js';
import { computeFindingId } from '../finding-id.js';
import {
  SLOW_TOOL_LATENCY_MS_THRESHOLD,
  SLOW_TOOL_MIN_CALLS,
} from '../config.js';

interface SlowToolGroupRow {
  tool_name: string;
  mcp_server: string | null;
  source: 'claude-code' | 'codex';
  project: string;
  call_count: number;
  mean_ms: number;
  max_ms: number;
  calls_missing_latency: number;
}

/** `ms` as "1.2s" once it crosses the 1s mark, otherwise "840ms". */
function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Nearest-rank percentile for a `(tool_name, mcp_server, source, project)`
 * group, fetched as a single bounded row via `ORDER BY ... LIMIT 1 OFFSET`
 * rather than sorting the whole group in JS. `n` is the group's call_count
 * (already known from the aggregate query), so this never needs a COUNT.
 */
function fetchPercentile(
  db: Database.Database,
  group: Pick<SlowToolGroupRow, 'tool_name' | 'mcp_server' | 'source' | 'project'>,
  sinceMs: number,
  untilMs: number,
  n: number,
  p: number,
): number {
  const rank = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
  const row = db
    .prepare(
      `SELECT latency_ms FROM tool_events
       WHERE tool_name = ? AND mcp_server IS ? AND source = ? AND project = ?
         AND ts >= ? AND ts < ? AND latency_ms IS NOT NULL
       ORDER BY latency_ms ASC
       LIMIT 1 OFFSET ?`,
    )
    .get(
      group.tool_name,
      group.mcp_server,
      group.source,
      group.project,
      sinceMs,
      untilMs,
      rank,
    ) as { latency_ms: number } | undefined;
  // n comes from COUNT(latency_ms) in the same window/group moments earlier,
  // so a row at `rank` (< n) must exist; the fallback only guards against a
  // pathological concurrent-mutation race and keeps this function total.
  return row?.latency_ms ?? Math.round(n > 0 ? rank : 0);
}

export const slowToolDetector: Detector = (ctx: DetectorContext): Finding[] => {
  if (ctx.limit <= 0) return [];

  const { db } = ctx;
  const conds: string[] = ['ts >= ?', 'ts < ?'];
  const params: unknown[] = [ctx.sinceMs, ctx.untilMs];
  if (ctx.source !== 'all') {
    conds.push('source = ?');
    params.push(ctx.source);
  }
  if (ctx.project !== null) {
    conds.push('project = ?');
    params.push(ctx.project);
  }
  params.push(SLOW_TOOL_MIN_CALLS, SLOW_TOOL_LATENCY_MS_THRESHOLD, ctx.limit);

  const groups = db
    .prepare(
      `SELECT tool_name, mcp_server, source, project,
              COUNT(latency_ms) AS call_count,
              AVG(latency_ms) AS mean_ms,
              MAX(latency_ms) AS max_ms,
              COUNT(*) - COUNT(latency_ms) AS calls_missing_latency
       FROM tool_events
       WHERE ${conds.join(' AND ')}
       GROUP BY tool_name, mcp_server, source, project
       HAVING COUNT(latency_ms) >= ? AND AVG(latency_ms) >= ?
       ORDER BY mean_ms DESC
       LIMIT ?`,
    )
    .all(...params) as SlowToolGroupRow[];

  const periodStart = new Date(ctx.sinceMs).toISOString();
  const periodEnd = new Date(ctx.untilMs).toISOString();
  const findings: Finding[] = [];

  groups.forEach((g, index) => {
    // HAVING already enforces call_count >= SLOW_TOOL_MIN_CALLS (5), so
    // "too few samples" groups never reach this loop — nothing to emit for
    // them at all, per spec.
    const confidence: Confidence = g.call_count >= 20 ? 'high' : 'medium';

    const p50Ms = fetchPercentile(
      db,
      g,
      ctx.sinceMs,
      ctx.untilMs,
      g.call_count,
      0.5,
    );
    const p95Ms = fetchPercentile(
      db,
      g,
      ctx.sinceMs,
      ctx.untilMs,
      g.call_count,
      0.95,
    );

    const meanMs = Math.round(g.mean_ms * 10) / 10;
    const label = g.mcp_server ? `[${g.mcp_server}] ${g.tool_name}` : g.tool_name;

    const evidence: string[] = [
      `Mean latency ${formatDuration(meanMs)} (${meanMs.toLocaleString()}ms) across ${g.call_count} call(s) with a recorded latency_ms, in the ${ctx.days}d window.`,
      `p50 (median) ${formatDuration(p50Ms)}, p95 ${formatDuration(p95Ms)}, max ${formatDuration(g.max_ms)}.`,
      'failure_rate is not available: tool_events has no error/failure/status column in this schema, so it is reported as null rather than fabricated.',
    ];
    if (g.calls_missing_latency > 0) {
      evidence.push(
        `${g.calls_missing_latency} additional call(s) to ${label} in this window had no recorded latency_ms and were excluded from the stats above (not counted, not treated as 0ms).`,
      );
    }

    const recommendations: string[] = [
      `Investigate whether ${label}'s output is actually used downstream; if not, drop the call or cache the result to avoid the ${formatDuration(meanMs)} penalty per call.`,
    ];
    if (g.mcp_server) {
      recommendations.push(
        `If the latency looks environmental (network, cold start), check the "${g.mcp_server}" MCP server's health rather than the calling code first.`,
      );
    }

    const id = computeFindingId({
      schemaVersion: '1.0',
      type: 'slow_tool',
      source: g.source,
      project: g.project,
      sessionId: null,
      toolName: g.tool_name,
      periodStart,
      periodEnd,
    });

    findings.push({
      id,
      // Local ordinal (groups are already ORDER BY mean_ms DESC from SQL) —
      // the engine reassigns the final cross-detector rank when it merges
      // all detectors' findings into the report.
      rank: index + 1,
      type: 'slow_tool',
      title: `${label} calls averaging ${formatDuration(meanMs)}`,
      description: `${label} averaged ${formatDuration(meanMs)} per call over ${g.call_count} call(s) in the last ${ctx.days}d (p50 ${formatDuration(p50Ms)}, p95 ${formatDuration(p95Ms)}, max ${formatDuration(g.max_ms)}).`,
      source: g.source,
      project: g.project,
      sessionId: null,
      toolName: g.tool_name,
      metrics: {
        toolName: g.tool_name,
        mcpServer: g.mcp_server,
        meanMs,
        p50Ms,
        p95Ms,
        maxMs: g.max_ms,
        callCount: g.call_count,
        failureRate: null,
      },
      estimatedCostUsd: null,
      costLabel: 'not_available',
      confidence,
      evidence,
      recommendations,
      costEventIds: [],
    });
  });

  return findings;
};

export default slowToolDetector;
