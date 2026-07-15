/**
 * Detector D1 "expensive_session".
 *
 * Flags sessions whose cost accounts for a disproportionate share of the
 * total analyzed cost in the audited period. This is a spotlight for review
 * — NOT an accusation. Never describe a flagged session as "waste" or as a
 * problem; the language used throughout this file (title/description) is
 * strictly "accounted for X% of analyzed estimated cost".
 *
 * Reuse, not reimplementation: the actual per-session aggregation (GROUP BY
 * session_id, SUM(usd_estimate), top model, etc.) lives in ../../sessions.ts
 * (topSessions()). This detector calls that instead of duplicating its SQL.
 * topSessions()'s signature doesn't line up 1:1 with DetectorContext in two
 * ways, both handled locally rather than by touching sessions.ts:
 *
 *   1. No `source` filter — topSessions() has no concept of
 *      claude-code vs codex. We over-fetch a larger candidate pool than we
 *      need and filter by ctx.source in JS (SessionRow already carries
 *      `source` per row), instead of forking the query.
 *   2. Window is always "trailing N days ending now" — topSessions() computes
 *      its own `Date.now() - days * 86_400_000` internally and has no
 *      `until` bound. We call it with ctx.days (assuming the engine builds
 *      ctx.sinceMs the same way, i.e. `Date.now() - days * 86_400_000`) and
 *      use ctx.sinceMs directly for this file's own period-total query so
 *      both numbers are computed from the same instant. If a future engine
 *      ever passes a fixed historical `untilMs` that isn't "now", this
 *      detector's window (like topSessions() itself) will still trail from
 *      "now" — a known limitation inherited from the function we're reusing,
 *      not reintroduced here.
 *
 * costEventIds convention: `'session:' + source + ':' + session_id`. This
 * detector's cost is a straight SUM(usd_estimate) over one session_id's
 * token_events rows, so that's the whole cost-event key. Detector D6
 * ("high_cost_model_signal") also derives its cost from individual sessions
 * and MUST reuse this exact string shape — it's how the audit engine
 * recognizes that two findings cite overlapping underlying spend and avoids
 * double-counting it in summary.costAssociatedUsd.
 */

import { topSessions } from '../../sessions.js';
import { EXPENSIVE_SESSION_COST_SHARE_THRESHOLD } from '../config.js';
import { computeFindingId } from '../finding-id.js';
import type { Confidence, Detector, DetectorContext, Finding } from '../types.js';

// Sessions with at least this many underlying token_events are "directly
// measured with enough underlying events" per the confidence contract below;
// fewer than this and a single anomalous event could be the whole story, so
// we report 'medium' instead of 'high'.
const MIN_EVENTS_FOR_HIGH_CONFIDENCE = 3;

// A session also qualifies even under the cost-share threshold when it's a
// clear outlier vs. the next-priciest session in the pool: at least this
// many times the runner-up's cost. Judgment call, documented here rather
// than in config.ts because it's a secondary/fallback rule, not the primary
// bar: a busy, high-volume period can produce a session that's obviously the
// stand-out of the bunch without ever reaching 15% of a (large) period
// total. The share-based threshold alone would silently miss that case.
const OUTLIER_MULTIPLE_OF_RUNNER_UP = 3;

// The outlier rule only applies once the top session's own share clears this
// floor, so two near-zero-cost sessions (e.g. $0.001 vs $0.0003) in an
// otherwise idle period don't get flagged purely because their ratio is
// large — there has to be real money behind the "3x the runner-up" signal.
const OUTLIER_MIN_SHARE = 0.05;

// How many sessions to pull from topSessions() before filtering by
// ctx.source. topSessions() already orders by total_usd DESC and applies its
// own LIMIT before we get the rows, so when ctx.source narrows the field we
// need a wider pool up front or a genuinely-top session for that source
// could be sitting just past the cutoff. Cheap to over-fetch; this is a
// point-in-time report, not a hot path.
function candidatePoolSize(limit: number): number {
  return Math.max(limit * 10, 100);
}

function periodStats(ctx: DetectorContext): { totalUsd: number; sessionCount: number } {
  const filters: string[] = ['ts >= ?'];
  const args: (number | string)[] = [ctx.sinceMs];
  if (ctx.project) {
    filters.push('project = ?');
    args.push(ctx.project);
  }
  if (ctx.source !== 'all') {
    filters.push('source = ?');
    args.push(ctx.source);
  }
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(usd_estimate), 0) AS total_usd,
              COUNT(DISTINCT session_id) AS session_count
       FROM token_events
       WHERE ${filters.join(' AND ')}`,
    )
    .get(...args) as { total_usd: number; session_count: number };
  return { totalUsd: row.total_usd, sessionCount: row.session_count };
}

export const expensiveSessionDetector: Detector = (ctx: DetectorContext): Finding[] => {
  const { totalUsd: periodTotalUsd, sessionCount } = periodStats(ctx);
  if (periodTotalUsd <= 0 || sessionCount === 0) return [];

  const pool = topSessions(ctx.db, ctx.days, candidatePoolSize(ctx.limit), ctx.project);
  const candidates =
    ctx.source === 'all' ? pool : pool.filter((s) => s.source === ctx.source);
  if (candidates.length === 0) return [];

  const topShare = candidates[0]!.total_usd / periodTotalUsd;
  const runnerUpUsd = candidates[1]?.total_usd ?? 0;
  const topIsOutlier =
    topShare >= OUTLIER_MIN_SHARE &&
    (runnerUpUsd === 0 || candidates[0]!.total_usd >= runnerUpUsd * OUTLIER_MULTIPLE_OF_RUNNER_UP);

  const periodLabel = `$${periodTotalUsd.toFixed(2)} across ${sessionCount} session${sessionCount === 1 ? '' : 's'} in the ${ctx.days}-day window`;

  const findings: Finding[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const session = candidates[i]!;
    const share = session.total_usd / periodTotalUsd;
    const qualifies =
      share >= EXPENSIVE_SESSION_COST_SHARE_THRESHOLD || (i === 0 && topIsOutlier);
    if (!qualifies) continue;

    const costSharePct = Math.round(share * 1000) / 10; // one decimal place
    const pctLabel = Math.round(share * 100);
    const confidence: Confidence =
      session.events >= MIN_EVENTS_FOR_HIGH_CONFIDENCE ? 'high' : 'medium';
    const periodStart = new Date(ctx.sinceMs).toISOString();
    const periodEnd = new Date(ctx.untilMs).toISOString();

    const evidence = [
      `$${session.total_usd.toFixed(2)} across ${session.events} event${session.events === 1 ? '' : 's'} over ${Math.round(session.duration_ms / 60_000)} min (top model: ${session.top_model || 'unknown'}).`,
      `That's ${costSharePct}% of ${periodLabel}.`,
    ];
    if (i === 0 && topIsOutlier && share < EXPENSIVE_SESSION_COST_SHARE_THRESHOLD) {
      evidence.push(
        `Also stands out on its own: at least ${OUTLIER_MULTIPLE_OF_RUNNER_UP}x the cost of the next most expensive session in the window.`,
      );
    }

    findings.push({
      id: computeFindingId({
        schemaVersion: '1.0',
        type: 'expensive_session',
        source: session.source,
        project: session.project,
        sessionId: session.session_id,
        toolName: null,
        periodStart,
        periodEnd,
      }),
      rank: findings.length + 1,
      type: 'expensive_session',
      title: `Session accounted for ${pctLabel}% of analyzed cost`,
      description: `This session accounted for ${pctLabel}% of analyzed estimated cost — $${session.total_usd.toFixed(2)} of ${periodLabel}. Flagged for visibility, not as a problem.`,
      source: session.source as 'claude-code' | 'codex',
      project: session.project,
      sessionId: session.session_id,
      toolName: null,
      metrics: {
        totalUsd: session.total_usd,
        costSharePct,
        events: session.events,
        durationMs: session.duration_ms,
        topModel: session.top_model,
        project: session.project,
      },
      estimatedCostUsd: session.total_usd,
      costLabel: 'estimated_cost',
      confidence,
      evidence,
      recommendations: [
        "Review this session's transcript to see what drove the cost (model choice, tool calls, context size).",
        'Compare it against similar sessions to see whether this cost is typical for this kind of task.',
      ],
      costEventIds: [`session:${session.source}:${session.session_id}`],
    });

    if (findings.length >= ctx.limit) break;
  }

  return findings;
};

export default expensiveSessionDetector;
