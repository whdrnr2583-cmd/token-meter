/**
 * D4 — repeated_similar_tool_calls
 *
 * IMPORTANT SCHEMA CONSTRAINT: tool_events stores no call arguments (see
 * ToolEvent in ../../types.ts — only tool_name, mcp_server, response_chars,
 * response_tokens_est, latency_ms, file_ext, tool_use_id, ts, session_id are
 * captured; this is deliberate, by-design privacy, not an oversight). That
 * means TRUE argument-level dedup ("these two Read calls hit the exact same
 * file") is NOT possible with this schema, and this detector must not
 * pretend otherwise.
 *
 * What this detector actually does is an honest APPROXIMATION: it groups
 * tool_events by (session_id, source, tool_name, mcp_server) and, within
 * each group, clusters calls that land within a rolling
 * REPEATED_CALL_TIME_WINDOW_MS window of each other AND whose response_chars
 * stay within REPEATED_CALL_SIZE_TOLERANCE_PCT of the cluster's running
 * average. Same tool + same session + similar timing + similar response
 * size is a reasonable proxy for "probably did the same/similar thing
 * repeatedly" — it is NOT proof of identical arguments. Every finding's
 * evidence array says so explicitly (expose_similarity_basis).
 *
 * This detector is LOCAL_ONLY: pure SQL + JS heuristics, no embeddings, no
 * external calls of any kind.
 *
 * Confidence is capped at 'medium' (never 'high') because the match is
 * fuzzy/shape-based, per the audit spec's "confidence<=medium for
 * fuzzy_only_match" rule.
 *
 * Cost attribution: tool_events carries no cost/USD field of its own, and
 * (unlike token_events) there's no request_id to join against a priced
 * model call. Rather than invent an attribution convention that might
 * double-count against another detector's convention, this detector always
 * reports estimatedCostUsd=null / costLabel='not_available' — under-claim
 * over double-count.
 */

import type { Detector, Finding } from '../types.js';
import { computeFindingId } from '../finding-id.js';
import {
  REPEATED_CALL_TIME_WINDOW_MS,
  REPEATED_CALL_SIZE_TOLERANCE_PCT,
} from '../config.js';

// Fewer than 3 similar calls is too easily a coincidence (e.g. a legitimate
// retry-once pattern) to call out as a finding.
const MIN_CALLS_TO_FIRE = 3;

interface ToolEventRow {
  ts: number;
  source: 'claude-code' | 'codex';
  project: string;
  session_id: string;
  tool_name: string;
  mcp_server: string | null;
  response_chars: number;
}

interface RepeatedCluster {
  events: ToolEventRow[];
}

// JSON-encode the tuple so the key can't collide across groups the way a
// plain string-concat join could if a session id/tool name/mcp server
// value happened to contain whatever separator was chosen.
function groupKey(row: ToolEventRow): string {
  return JSON.stringify([row.session_id, row.source, row.tool_name, row.mcp_server]);
}

/**
 * Greedy single-pass clustering over one (session, source, tool, mcp_server)
 * bucket, already ts-ascending. A new event joins the currently-open cluster
 * when both hold:
 *   - it falls within REPEATED_CALL_TIME_WINDOW_MS of the cluster's FIRST
 *     event (anchoring on the first event, not the previous one, guarantees
 *     the whole cluster's span never exceeds the window — what lets us
 *     honestly describe it to the user as "N calls within a K-minute
 *     window" rather than a longer chain of adjacent-but-drifting gaps).
 *   - its response_chars is within REPEATED_CALL_SIZE_TOLERANCE_PCT of the
 *     cluster's running average response_chars so far (guards against slow
 *     drift where each call is "close enough" to the last but the cluster
 *     as a whole spans wildly different sizes).
 * Otherwise the open cluster is closed off and a new one starts at that
 * event. This is a deterministic heuristic, not an optimal clustering —
 * appropriate for a proxy signal, not a claim of exhaustive grouping.
 */
function clusterBucket(events: ToolEventRow[]): RepeatedCluster[] {
  const clusters: RepeatedCluster[] = [];
  let current: ToolEventRow[] = [];
  let currentSum = 0;

  for (const ev of events) {
    if (current.length === 0) {
      current = [ev];
      currentSum = ev.response_chars;
      continue;
    }

    const anchorTs = current[0]!.ts;
    const avgChars = currentSum / current.length;
    const withinTime = ev.ts - anchorTs <= REPEATED_CALL_TIME_WINDOW_MS;
    const withinSize =
      avgChars === 0
        ? ev.response_chars === 0
        : Math.abs(ev.response_chars - avgChars) <= avgChars * REPEATED_CALL_SIZE_TOLERANCE_PCT;

    if (withinTime && withinSize) {
      current.push(ev);
      currentSum += ev.response_chars;
    } else {
      clusters.push({ events: current });
      current = [ev];
      currentSum = ev.response_chars;
    }
  }
  if (current.length > 0) clusters.push({ events: current });
  return clusters;
}

function formatDurationParts(ms: number): { value: number; unit: 'minute' | 'second' } {
  if (ms < 60_000) return { value: Math.max(1, Math.round(ms / 1000)), unit: 'second' };
  return { value: Math.max(1, Math.round(ms / 60_000)), unit: 'minute' };
}

/** Noun form for an observed instance, e.g. "2 minutes", "45 seconds". */
function formatDuration(ms: number): string {
  const { value, unit } = formatDurationParts(ms);
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

/** Adjective form for the configured threshold, e.g. "5-minute". */
function formatWindowLabel(ms: number): string {
  const { value, unit } = formatDurationParts(ms);
  return `${value}-${unit}`;
}

export const repeatedSimilarToolCalls: Detector = (ctx) => {
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

  const rows = ctx.db
    .prepare(
      `SELECT ts, source, project, session_id, tool_name, mcp_server, response_chars
       FROM tool_events
       WHERE ${conds.join(' AND ')}
       ORDER BY session_id, source, tool_name, mcp_server, ts ASC`,
    )
    .all(...params) as ToolEventRow[];

  // Bucket by (session_id, source, tool_name, mcp_server). Rows already
  // arrive ts-ascending within each bucket thanks to the ORDER BY above.
  const buckets = new Map<string, ToolEventRow[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const windowLabel = formatWindowLabel(REPEATED_CALL_TIME_WINDOW_MS);
  const pctLabel = `${Math.round(REPEATED_CALL_SIZE_TOLERANCE_PCT * 100)}%`;
  const periodStart = new Date(ctx.sinceMs).toISOString();
  const periodEnd = new Date(ctx.untilMs).toISOString();

  const findings: Finding[] = [];

  for (const bucketEvents of buckets.values()) {
    for (const cluster of clusterBucket(bucketEvents)) {
      if (cluster.events.length < MIN_CALLS_TO_FIRE) continue;

      const first = cluster.events[0]!;
      const last = cluster.events[cluster.events.length - 1]!;
      const callCount = cluster.events.length;
      const spanMs = last.ts - first.ts;
      const avgResponseChars = Math.round(
        cluster.events.reduce((sum, e) => sum + e.response_chars, 0) / callCount,
      );
      const mcpLabel = first.mcp_server ? ` (${first.mcp_server})` : '';

      findings.push({
        id: computeFindingId({
          schemaVersion: '1.0',
          type: 'repeated_similar_tool_calls',
          source: first.source,
          project: first.project,
          sessionId: first.session_id,
          toolName: first.tool_name,
          periodStart,
          periodEnd,
        }),
        // Placeholder — the engine assigns the final cross-detector rank
        // when it merges all detectors' findings into the report.
        rank: 0,
        type: 'repeated_similar_tool_calls',
        title: `${callCount} similar ${first.tool_name} calls within ${formatDuration(spanMs)} in one session`,
        description: `${first.tool_name}${mcpLabel} was called ${callCount} times in session ${first.session_id} with similarly-sized responses (avg ~${avgResponseChars.toLocaleString()} chars) within a ${windowLabel} window.`,
        source: first.source,
        project: first.project,
        sessionId: first.session_id,
        toolName: first.tool_name,
        metrics: {
          toolName: first.tool_name,
          mcpServer: first.mcp_server,
          sessionId: first.session_id,
          callCount,
          windowMs: REPEATED_CALL_TIME_WINDOW_MS,
          avgResponseChars,
        },
        estimatedCostUsd: null,
        costLabel: 'not_available',
        confidence: 'medium',
        evidence: [
          `Matched by same tool (${first.tool_name}) + same session + response size within ${pctLabel} of each other + occurred within a ${windowLabel} window. Call arguments are not stored (privacy-by-design) so this is a proxy signal, not confirmed duplicate calls.`,
          `${callCount} calls in session ${first.session_id} spanned ${formatDuration(spanMs)} (window threshold: ${windowLabel}), averaging ~${avgResponseChars.toLocaleString()} response chars per call.`,
        ],
        recommendations: [
          `Review whether these ${callCount} ${first.tool_name}${mcpLabel} calls in session ${first.session_id} are intentional (e.g. polling/pagination/retry) or avoidable repeats — deduplicating avoidable repeats saves both latency and tokens.`,
        ],
        costEventIds: [],
      });
    }
  }

  // Most-repeated clusters are the more actionable signal; rank locally by
  // callCount desc before the engine's own cross-detector ranking, and cap
  // to what the caller asked this detector to return.
  return findings
    .sort((a, b) => (b.metrics.callCount as number) - (a.metrics.callCount as number))
    .slice(0, ctx.limit);
};

export default repeatedSimilarToolCalls;
