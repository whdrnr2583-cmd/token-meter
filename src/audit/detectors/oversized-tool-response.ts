/**
 * Detector D2 "oversized_tool_response".
 *
 * Flags tool/MCP-server pairs whose responses run large enough that trimming
 * them (narrower scope, a result limit, pagination, pre-filtering, or a
 * summarization pass) would meaningfully cut context/token spend.
 *
 * Reuse, not reimplementation: the actual mean/outlier aggregation over
 * `tool_events.response_tokens_est` (grouped by `(tool_name, mcp_server)`,
 * gated at >=5 calls and >=5000 avg tokens) already lives in
 * ../../trim-suggestions.ts's computeTrimSuggestions() — its first pattern,
 * LARGE_RESPONSE. This detector calls that function and projects its
 * `kind === 'large_response'` entries into Finding objects; it does not
 * re-derive the mean/threshold/savings-estimate logic. stats.ts's
 * wasteSignals().tool_outliers is a second, simpler existing precedent for
 * the same underlying signal (max > 5x avg and > 10k tokens, no savings
 * estimate) — also not used here, since trim-suggestions.ts's richer
 * mean/calls/max + savings_usd_per_week produces better-explained findings
 * for the same query cost.
 *
 * `computeTrimSuggestions()` originally returned only a human-readable
 * `evidence` string with the mean/calls/max numbers baked into prose, not as
 * separate fields — this detector needs the raw numbers for `metrics`, so
 * ../../trim-suggestions.ts's `TrimSuggestion` interface was extended with
 * `calls` / `avg_tokens` / `max_tokens` (mean + max only; the function has
 * never computed percentiles, so none are invented here — see D3's
 * slow-tool.ts for a detector that *does* compute p50/p95, over a different,
 * percentile-capable query). Those three fields were already computed
 * in-function and simply weren't returned before; nothing about the
 * detection logic itself changed.
 *
 * ── Scope limitation inherited from computeTrimSuggestions() ───────────────
 * Like D1 (expensive_session, see ../../sessions.ts's topSessions()) and D5
 * (cache_inefficiency, see ../../stats.ts's wasteSignals()), this detector
 * wraps a function that doesn't line up 1:1 with DetectorContext:
 *   - No source/project split. computeTrimSuggestions()'s LARGE_RESPONSE
 *     query has no `source`/`project` column in its SELECT or GROUP BY at
 *     all (unlike topSessions(), which at least returns per-row `.source`
 *     that D1 can filter in JS) — a `(tool_name, mcp_server)` aggregate can
 *     silently mix rows from claude-code and codex, or multiple projects.
 *     There is no way to honor ctx.source/ctx.project narrowing without
 *     re-querying tool_events ourselves, which would mean re-deriving the
 *     mean/threshold logic we're explicitly reusing to avoid duplicating.
 *     Findings' `source` therefore echoes `ctx.source` when the caller asked
 *     for one specific source (best-effort label, not a guarantee the
 *     underlying aggregate is actually confined to it) and defaults to
 *     'claude-code' when the caller asked for 'all' — the same "must pick a
 *     concrete value for a required field" situation D5 documents and
 *     resolves the same way. `project` echoes `ctx.project` (null when
 *     unscoped) for the same reason.
 *   - Window always trails "now". computeTrimSuggestions(db, days) computes
 *     its own `since = Date.now() - days * 86_400_000` internally with no
 *     upper bound, rather than accepting ctx.sinceMs/ctx.untilMs directly.
 *     We call it with ctx.days per the task spec; if ctx.untilMs is ever a
 *     fixed historical instant instead of "now", this detector's window
 *     (like the function it wraps) still trails from the real "now" — a
 *     known limitation inherited from the reused function, not reintroduced
 *     here.
 *
 * ── ../config.ts's OVERSIZED_RESPONSE_PERCENTILE is intentionally unused ───
 * ../config.ts pre-declares OVERSIZED_RESPONSE_ABS_TOKENS (5000 — this
 * detector inherits that bar implicitly, since it's baked into
 * computeTrimSuggestions()'s own HAVING clause) alongside
 * OVERSIZED_RESPONSE_PERCENTILE (0.95), apparently anticipating a *relative*
 * check on top of the absolute floor. That relative check does not exist in
 * computeTrimSuggestions() (no percentile computation of any kind — see the
 * "richer... nice-to-have" note above) and this detector does not add one:
 * doing so would mean computing a p95 ourselves, which is exactly the
 * "duplicate the mean/outlier logic" this file exists to avoid. Left as a
 * documented gap rather than silently ignored; a future revision could wire
 * OVERSIZED_RESPONSE_PERCENTILE through once trim-suggestions.ts (or a
 * successor query) actually computes a percentile to compare against.
 */

import { computeTrimSuggestions } from '../../trim-suggestions.js';
import { computeFindingId } from '../finding-id.js';
import type { Confidence, Detector, DetectorContext, Finding } from '../types.js';

// Sample size at/above which a large-response finding is 'high' confidence
// instead of 'medium' — mirrors slow-tool.ts's own >=20-calls bar for the
// same reason: below this, a couple of unusually large calls can swing the
// mean enough that the average isn't yet trustworthy.
const HIGH_CONFIDENCE_MIN_CALLS = 20;

/** "12k", "8.5k", "2.30M" — compact form for titles; no trailing ".0". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return Math.round(n).toLocaleString();
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Selects concrete trim actions based on the tool's name/shape rather than
 * always emitting the full menu. The six candidate actions (narrow scope,
 * lower result limit, pagination, pre-filter, summarize before return,
 * avoid duplicate context) map onto three rough tool shapes inferred from
 * the name — search/list-shaped, read/fetch/exec-shaped, and unrecognized —
 * since tool_events carries no argument schema to inspect directly (see
 * repeated-tool-calls.ts's header for the same by-design privacy
 * constraint).
 */
function buildRecommendations(toolName: string, mcpServer: string | null): string[] {
  const name = toolName.toLowerCase();
  const label = mcpServer ? `[${mcpServer}] ${toolName}` : toolName;
  const recs: string[] = [];

  const looksSearchOrList = /search|grep|find|query|list/.test(name);
  const looksReadOrExec = /read|get|fetch|cat|show|view|download|export|bash|exec|run|shell|command/.test(name);

  if (looksSearchOrList) {
    recs.push(`Narrow ${label}'s query/filter scope instead of searching or listing broadly.`);
    recs.push(`Lower the result limit if ${label} accepts one (e.g. \`limit\`/\`max_results\`/\`top_k\`).`);
    recs.push(`Paginate through ${label} results across multiple calls instead of requesting them all at once.`);
  }
  if (looksReadOrExec) {
    recs.push(
      `Pre-filter ${label}'s output to only the fields/lines actually needed (e.g. request specific fields, or pipe through \`grep\`/\`head\`) instead of returning the full payload.`,
    );
  }
  if (recs.length === 0) {
    // Tool name gives no shape hint (opaque/custom MCP tool name) — don't
    // guess at scope/limit/pagination arguments we can't confirm exist.
    recs.push(`Review why ${label} returns a large payload and whether the caller can request less of it.`);
  }
  // Always worth the reminder once a tool is confirmed to run large,
  // regardless of shape — doesn't presuppose any particular argument.
  recs.push(`Summarize or post-process ${label}'s response before it enters the model context, if the full payload isn't needed downstream.`);
  if (looksSearchOrList || looksReadOrExec) {
    recs.push(`Check whether repeated ${label} calls return duplicate or already-seen context that could be deduplicated or cached.`);
  }

  return recs;
}

/**
 * costEventIds convention: `'tool:' + tool_name + ':' + (mcp_server ?? '')`.
 *
 * This is a deliberately different shape from the `'session:' + source +
 * ':' + session_id` convention D1 (expensive_session) and D6
 * (high_cost_model_signal, planned) use — see expensive-session.ts's header.
 * That difference is NOT cosmetic; it reflects a genuinely different unit of
 * accounting:
 *   - A `session:...` key names one session_id's directly-observed
 *     SUM(usd_estimate) over its token_events rows — real money already
 *     spent, unambiguous, safe to union with other session-level findings'
 *     costEventIds without double-counting.
 *   - A `tool:...` key names an *aggregate* — every call to this
 *     (tool_name, mcp_server) pair across many sessions/projects/sources in
 *     the window — whose estimatedCostUsd (trim-suggestions.ts's
 *     savings_usd_per_week) is a heuristic *projection* of future savings if
 *     the suggestion is acted on, not a sum of money already spent. It also
 *     has no natural relationship to any one session_id's costEventIds: the
 *     same underlying token_events rows that make up a `tool:...` aggregate
 *     may already be included in a `session:...` finding's own cost, and a
 *     week-forward "savings" number was never part of that session's
 *     recorded spend to begin with.
 *
 * The engine (Integration phase) computing summary.costAssociatedUsd MUST
 * special-case the 'tool:' prefix: keep tool-level cost_associated totals in
 * their own bucket rather than unioning them into the same set as
 * `session:...` keys. Summing "money spent" and "money that might be saved"
 * under one number would misrepresent both.
 */
function costEventId(toolName: string, mcpServer: string | null): string {
  return `tool:${toolName}:${mcpServer ?? ''}`;
}

export const oversizedToolResponseDetector: Detector = (ctx: DetectorContext): Finding[] => {
  if (ctx.limit <= 0) return [];

  const suggestions = computeTrimSuggestions(ctx.db, ctx.days).filter(
    (s) => s.kind === 'large_response',
  );
  if (suggestions.length === 0) return [];

  // computeTrimSuggestions() has no source/project split (see header) —
  // best-effort label rather than a guaranteed-accurate scope. See header.
  const source: 'claude-code' | 'codex' = ctx.source === 'all' ? 'claude-code' : ctx.source;

  const periodStart = new Date(ctx.sinceMs).toISOString();
  const periodEnd = new Date(ctx.untilMs).toISOString();

  const findings: Finding[] = [];
  for (const s of suggestions) {
    // These fields are always populated for kind === 'large_response' (see
    // the LARGE_RESPONSE push site in trim-suggestions.ts); the `?? 0` /
    // `?? s.avg_tokens` fallbacks exist only to satisfy TypeScript's
    // optional `max_tokens` on the shared TrimSuggestion type, not because
    // this branch is expected to hit them.
    const callCount = s.calls;
    const meanTokens = s.avg_tokens;
    const maxTokens = s.max_tokens ?? s.avg_tokens;

    const confidence: Confidence = callCount >= HIGH_CONFIDENCE_MIN_CALLS ? 'high' : 'medium';
    const label = s.mcp_server ? `[${s.mcp_server}] ${s.tool_name}` : s.tool_name;

    findings.push({
      id: computeFindingId({
        schemaVersion: '1.0',
        type: 'oversized_tool_response',
        source,
        project: ctx.project,
        sessionId: null,
        toolName: s.tool_name,
        periodStart,
        periodEnd,
      }),
      // Placeholder — the engine assigns the final cross-detector rank when
      // it merges all detectors' findings into the report.
      rank: 0,
      type: 'oversized_tool_response',
      title: `${label} responses averaging ${formatTokens(meanTokens)} tokens`,
      description: s.evidence,
      source,
      project: ctx.project,
      sessionId: null,
      toolName: s.tool_name,
      metrics: {
        toolName: s.tool_name,
        mcpServer: s.mcp_server,
        callCount,
        meanTokens,
        maxTokens,
      },
      estimatedCostUsd: round6(s.savings_usd_per_week),
      // A projected/linked weekly savings estimate, not a directly-observed
      // spend — see costEventId()'s doc comment above for why this must
      // never be 'estimated_cost'.
      costLabel: 'cost_associated',
      confidence,
      evidence: [s.evidence, s.action_text],
      recommendations: buildRecommendations(s.tool_name, s.mcp_server),
      // Aggregated across many calls, not one cost event — see the doc
      // comment on costEventId() above for the accounting tradeoff this
      // convention implies for the engine's dedup logic.
      costEventIds: [costEventId(s.tool_name, s.mcp_server)],
    });

    if (findings.length >= ctx.limit) break;
  }

  return findings;
};

export default oversizedToolResponseDetector;
