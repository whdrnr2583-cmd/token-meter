/**
 * Detector D6 "high_cost_model_signal".
 *
 * This is a REVIEW PROMPT, not a downgrade recommendation. It flags sessions
 * that (a) used a high-cost-tier model, (b) wrapped up in under
 * HIGH_COST_MODEL_SHORT_SESSION_MS wall-clock time, and (c) produced under
 * HIGH_COST_MODEL_MIN_OUTPUT_TOKENS of output — a pattern worth a second
 * look, never an accusation that the model choice was wrong. Some short
 * exchanges genuinely need a top-tier model's extra capability; this finding
 * only surfaces the pattern so a human can judge which case it is.
 *
 * ── "High-cost" is derived from ../../pricing.ts's PRICES, not model names ──
 * Anthropic/OpenAI ship new model ids constantly; a hardcoded allowlist
 * ("opus", "fable", ...) goes stale the moment a new one launches. Instead
 * this file ranks models by their $/M *output* rate (the dominant cost
 * driver on most sessions) and treats a model as high-cost once its rate is
 * within HIGH_COST_TIER_RATIO of the single highest output rate currently in
 * PRICES. At today's rates (see ../../pricing.ts) that's opus (25-75 $/M) +
 * fable (50 $/M) + the priciest gpt-5.x variants — cleanly separated from
 * sonnet/haiku/gpt-4o (0.6-15 $/M) — without ever naming a model. If pricing
 * changes, the threshold recomputes automatically on next run.
 *
 * ── Not a reuse of ../../sessions.ts's topSessions() ────────────────────────
 * D1 (expensive-session.ts) reuses topSessions() because its own filter
 * criterion (cost share) IS topSessions()'s own sort/limit criterion (cost),
 * so over-fetching its ORDER BY total_usd DESC LIMIT pool is safe. D6's
 * filter criteria (short duration + low output) are NOT correlated with
 * total_usd — a short, low-output session on an expensive model can easily
 * have low absolute cost and rank far outside any $-based LIMIT window.
 * Reusing topSessions() here would silently produce false negatives on any
 * dataset with more than a handful of pricier sessions elsewhere in the
 * window. So this file does the "light adaptation" the task spec allows:
 * its own GROUP BY session_id query, scoped to ctx.sinceMs/ctx.untilMs
 * (topSessions() has no upper bound and always trails "now" — see D1's
 * header for that documented limitation) with the duration/output filter
 * pushed into SQL's HAVING clause, then a second query — same shape as
 * topSessions()'s own "dominant model per session" lookup, but bounded to
 * the same ts window rather than all-time — to find each qualifying
 * session's highest-cost model.
 *
 * ── costEventIds convention ─────────────────────────────────────────────────
 * `'session:' + source + ':' + session_id` — identical to D1's convention
 * (see expensive-session.ts's header), by explicit design: this detector's
 * cost is a straight SUM(usd_estimate) over real session_id rows, the same
 * unit of accounting D1 uses. D1 and D6 legitimately can (and often will)
 * point at the *same* session — that's expected, not a bug. The engine's
 * Integration-phase dedup unions costEventIds across findings before summing
 * summary.costAssociatedUsd, so an overlapping D1+D6 pair on one session
 * never double-counts.
 *
 * ── Confidence is capped at 'low' ────────────────────────────────────────────
 * The duration/output-token/high-cost-model thresholds this detector applies
 * are all objective (computed straight off token_events), but "was this
 * session's model choice actually unjustified" is inherently a judgment
 * call, not something those thresholds alone can prove — a 90-second Opus
 * session that produced 200 output tokens might have been exactly the right
 * call (a hard one-shot judgment task) or genuine overkill (a task Haiku
 * would have nailed). Per the audit spec's CONFIDENCE_MAX rule
 * (confidence capped at 'low' unless a finding is objective_threshold_only),
 * this can never report anything above 'low'.
 *
 * ── Project cost concentration (secondary signal) ───────────────────────────
 * The task also asks for a project-level cost-concentration check (one
 * project dominating recent spend) using ../../stats.ts's byProject().
 * FindingType (../types.ts) is a closed union with no dedicated type for
 * "project concentration", and extending that shared union is a bigger,
 * cross-detector decision this file shouldn't make unilaterally — so rather
 * than inventing a new Finding type, this signal is folded into the
 * evidence[] of this detector's highest-cost finding (see
 * projectConcentrationNote() below), exactly as the task spec allows.
 */

import { modelRates, PRICES } from '../../pricing.js';
import { byProject, overview } from '../../stats.js';
import { computeFindingId } from '../finding-id.js';
import {
  EXPENSIVE_SESSION_COST_SHARE_THRESHOLD,
  HIGH_COST_MODEL_MIN_OUTPUT_TOKENS,
  HIGH_COST_MODEL_SHORT_SESSION_MS,
} from '../config.js';
import type { Confidence, Detector, DetectorContext, Finding } from '../types.js';

// A model qualifies as "high-cost" once its $/M output rate is within this
// factor of the single priciest rate in PRICES. Judgment call, kept local to
// this file (not ../config.ts) because it's about *ranking models*, an
// orthogonal axis to the session-shape constants config.ts already owns.
// At today's rates: max output rate is claude-opus-4-1's $75/M, so the bar
// lands at $25/M — inclusive of the whole opus family (all $25-75/M) and
// claude-fable-5 ($50/M), exclusive of sonnet/gpt-5.4 ($10-15/M) and below.
const HIGH_COST_TIER_RATIO = 3;

const HIGH_COST_OUTPUT_RATE_THRESHOLD =
  Math.max(...Object.values(PRICES).map((p) => p.output)) / HIGH_COST_TIER_RATIO;

function isHighCostModel(model: string): boolean {
  return modelRates(model).output >= HIGH_COST_OUTPUT_RATE_THRESHOLD;
}

// Mirrors src/mcp.ts's local `shortModel` label convention (strip the
// "claude-" prefix + a trailing 8-digit dated suffix) purely for display in
// this finding's title/description, so model names read the same way here
// as they already do in the MCP tools. metrics.model below stays the raw,
// unshortened string — machine-readable fields should match token_events.
function shortModelLabel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

const CONFIDENCE: Confidence = 'low';

interface CandidateSession {
  session_id: string;
  project: string;
  source: string;
  duration_ms: number;
  total_usd: number;
  total_output: number;
  top_model: string;
}

/**
 * Sessions in the audited window that are short + low-output, regardless of
 * model — the high-cost-model filter is applied afterward once each
 * session's dominant model is known. Duration/output filtering happens in
 * SQL's HAVING clause so only genuinely-short-and-quiet sessions ever reach
 * the (more expensive) per-model lookup below.
 */
function findShortLowOutputSessions(
  ctx: DetectorContext,
): Array<Omit<CandidateSession, 'top_model'>> {
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
  params.push(HIGH_COST_MODEL_SHORT_SESSION_MS, HIGH_COST_MODEL_MIN_OUTPUT_TOKENS);

  return ctx.db
    .prepare(
      `SELECT
         session_id,
         project,
         source,
         (MAX(ts) - MIN(ts))             AS duration_ms,
         COALESCE(SUM(usd_estimate), 0)  AS total_usd,
         COALESCE(SUM(output_tokens), 0) AS total_output
       FROM token_events
       WHERE ${conds.join(' AND ')}
       GROUP BY session_id
       HAVING (MAX(ts) - MIN(ts)) < ? AND COALESCE(SUM(output_tokens), 0) < ?`,
    )
    .all(...params) as Array<Omit<CandidateSession, 'top_model'>>;
}

/**
 * Dominant (highest-cost) model per session_id — same definition
 * topSessions() (../../sessions.ts) uses, but bounded to ctx.sinceMs/
 * ctx.untilMs rather than topSessions()'s all-time lookup, so a model used
 * outside the audited window can't leak in and change which model "wins"
 * for a session that's only partially inside the window.
 */
function topModelBySession(
  ctx: DetectorContext,
  sessionIds: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (sessionIds.length === 0) return result;

  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = ctx.db
    .prepare(
      `SELECT session_id, model, COALESCE(SUM(usd_estimate), 0) AS usd
       FROM token_events
       WHERE session_id IN (${placeholders}) AND ts >= ? AND ts < ?
       GROUP BY session_id, model
       ORDER BY usd DESC`,
    )
    .all(...sessionIds, ctx.sinceMs, ctx.untilMs) as Array<{
    session_id: string;
    model: string;
    usd: number;
  }>;

  for (const row of rows) {
    if (!result.has(row.session_id)) result.set(row.session_id, row.model);
  }
  return result;
}

function findCandidateSessions(ctx: DetectorContext): CandidateSession[] {
  const shortLowOutput = findShortLowOutputSessions(ctx);
  if (shortLowOutput.length === 0) return [];

  const topModels = topModelBySession(
    ctx,
    shortLowOutput.map((s) => s.session_id),
  );

  return shortLowOutput
    .map((s) => ({ ...s, top_model: topModels.get(s.session_id) ?? '' }))
    .filter((s) => isHighCostModel(s.top_model));
}

interface ModelGroup {
  model: string;
  source: string;
  totalUsd: number;
  sessions: CandidateSession[];
}

function groupByModel(sessions: CandidateSession[]): ModelGroup[] {
  const byModel = new Map<string, ModelGroup>();
  for (const s of sessions) {
    let group = byModel.get(s.top_model);
    if (!group) {
      group = { model: s.top_model, source: s.source, totalUsd: 0, sessions: [] };
      byModel.set(s.top_model, group);
    }
    group.sessions.push(s);
    group.totalUsd += s.total_usd;
  }
  return Array.from(byModel.values()).sort((a, b) => b.totalUsd - a.totalUsd);
}

/** `null` when a group's sessions span more than one project. */
function commonProjectOrNull(sessions: CandidateSession[]): string | null {
  const first = sessions[0]!.project;
  return sessions.every((s) => s.project === first) ? first : null;
}

/**
 * Secondary signal: does one project account for a disproportionate share of
 * recent spend? Reuses EXPENSIVE_SESSION_COST_SHARE_THRESHOLD (../config.ts)
 * rather than inventing a new project-specific bar — it's the same "one
 * thing dominates X% of total analyzed cost" pattern D1 already applies at
 * the session level, just applied here at the project level. byProject() and
 * overview() (../../stats.ts) both derive their window from ctx.days via the
 * same internal Date.now()-anchored logic, so the two numbers stay
 * consistent with each other even though neither accepts ctx.sinceMs/
 * ctx.untilMs directly (the same trailing-window limitation D1's header
 * documents for topSessions()).
 */
function projectConcentrationNote(ctx: DetectorContext): string | null {
  // Already scoped to one project — "which project dominates?" has no
  // answer when there's only one in view.
  if (ctx.project !== null) return null;

  const scope = ctx.source === 'all' ? undefined : { source: ctx.source };
  const [topProject] = byProject(ctx.db, ctx.days, 1, scope);
  if (!topProject || topProject.usd <= 0) return null;

  const totalUsd = overview(ctx.db, ctx.days, scope).total_usd;
  if (totalUsd <= 0) return null;

  const share = topProject.usd / totalUsd;
  if (share < EXPENSIVE_SESSION_COST_SHARE_THRESHOLD) return null;

  const pct = Math.round(share * 100);
  return (
    `Separately: project "${topProject.project}" alone accounts for ${pct}% of total analyzed spend ` +
    `in the ${ctx.days}-day window ($${topProject.usd.toFixed(2)} of $${totalUsd.toFixed(2)}) — a cost` +
    '-concentration signal worth noting alongside the model-tier pattern above.'
  );
}

export const highCostModelSignalDetector: Detector = (ctx: DetectorContext): Finding[] => {
  if (ctx.limit <= 0) return [];

  const candidates = findCandidateSessions(ctx);
  if (candidates.length === 0) return [];

  const groups = groupByModel(candidates).slice(0, ctx.limit);
  if (groups.length === 0) return [];

  const periodStart = new Date(ctx.sinceMs).toISOString();
  const periodEnd = new Date(ctx.untilMs).toISOString();
  const shortMinutes = Math.round(HIGH_COST_MODEL_SHORT_SESSION_MS / 60_000);

  const findings: Finding[] = groups.map((group, index): Finding => {
    // Costliest sessions first — most useful order for a human skimming evidence.
    const sessions = [...group.sessions].sort((a, b) => b.total_usd - a.total_usd);
    const sessionCount = sessions.length;
    const avgDurationMs = Math.round(
      sessions.reduce((sum, s) => sum + s.duration_ms, 0) / sessionCount,
    );
    const avgOutputTokens = Math.round(
      sessions.reduce((sum, s) => sum + s.total_output, 0) / sessionCount,
    );
    const project = commonProjectOrNull(sessions);
    const shortLabel = shortModelLabel(group.model);
    const rate = modelRates(group.model);
    const plural = sessionCount === 1 ? '' : 's';

    const title = `${sessionCount} short ${shortLabel} session${plural} with minimal output`;
    const description =
      `${sessionCount} session${plural} using ${shortLabel} in the last ${ctx.days}d wrapped up in under ` +
      `${shortMinutes} minute${shortMinutes === 1 ? '' : 's'} while producing well under ` +
      `${HIGH_COST_MODEL_MIN_OUTPUT_TOKENS.toLocaleString()} output tokens (avg ${avgOutputTokens.toLocaleString()} ` +
      `tokens, avg ${Math.round(avgDurationMs / 1000)}s). Some short exchanges genuinely need ${shortLabel}'s ` +
      `extra capability; others don't. This finding surfaces the pattern — it does not judge which case this is.`;

    const evidence: string[] = [
      `${shortLabel} is billed at $${rate.output}/M output tokens — at or above this audit's high-cost bar of ` +
        `$${HIGH_COST_OUTPUT_RATE_THRESHOLD.toFixed(2)}/M, derived from the current pricing table rather than a ` +
        'hardcoded model name.',
      ...sessions.map(
        (s) =>
          `${s.session_id} (${s.project}): ${Math.round(s.duration_ms / 1000)}s wall-clock, ` +
          `${s.total_output.toLocaleString()} output tokens, $${s.total_usd.toFixed(4)}.`,
      ),
    ];

    const recommendations: string[] = [
      'Review whether every short session required this model.',
      "If a lower-cost model tier would likely handle tasks like these just as well, prefer it going forward — " +
        'but verify case by case; a short, low-output session alone is not proof the model choice was wrong.',
    ];

    return {
      id: computeFindingId({
        schemaVersion: '1.0',
        type: 'high_cost_model_signal',
        source: group.source,
        project,
        sessionId: null,
        toolName: null,
        periodStart,
        periodEnd,
        // Disambiguator: this finding is keyed by model, not by a single
        // session/tool, so two groups (e.g. opus + fable both qualifying in
        // the same run) would otherwise hash to the same id.
        discriminator: group.model,
      }),
      // Local ordinal — the engine reassigns the final cross-detector rank
      // when it merges all detectors' findings into the report.
      rank: index + 1,
      type: 'high_cost_model_signal',
      title,
      description,
      source: group.source as 'claude-code' | 'codex',
      project,
      sessionId: null,
      toolName: null,
      metrics: {
        model: group.model,
        sessionCount,
        avgDurationMs,
        avgOutputTokens,
      },
      // A real observed cost (SUM of these sessions' usd_estimate), so this
      // is 'cost_associated', not 'estimated_cost' — the money was actually
      // spent; what's uncertain is whether the model tier was necessary.
      estimatedCostUsd: Math.round(group.totalUsd * 1_000_000) / 1_000_000,
      costLabel: 'cost_associated',
      confidence: CONFIDENCE,
      evidence,
      recommendations,
      costEventIds: sessions.map((s) => `session:${s.source}:${s.session_id}`),
    };
  });

  // Fold the project-concentration secondary signal into the top finding's
  // evidence rather than emitting a separate Finding — see this file's
  // header for why.
  const note = projectConcentrationNote(ctx);
  if (note && findings.length > 0) findings[0]!.evidence.push(note);

  return findings;
};

export default highCostModelSignalDetector;
