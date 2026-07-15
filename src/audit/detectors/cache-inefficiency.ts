/**
 * Detector D5 — cache_inefficiency.
 *
 * Flags days where prompt-cache *writes* outran cache *reads* — tokens spent
 * establishing a cache breakpoint that was never (or barely) read back, i.e.
 * the write never paid for itself. Built entirely on top of stats.ts's
 * wasteSignals()/cacheStats() rather than re-deriving the day-bucketing SQL:
 * wasteSignals() already computes `cache_waste_days` (days where
 * SUM(cache_write_tokens) > SUM(cache_read_tokens) > 0) with the correct
 * ts-window + scope handling, so this file only adds the noise floor, cost
 * attribution, and Finding shaping on top of that.
 *
 * Source reliability: Claude Code JSONL logs populate both
 * cache_read_tokens and cache_write_tokens. Codex's `usage` payload only
 * ever exposes `cached_input_tokens` (mapped to cache_read_tokens);
 * codex-parser.ts hardcodes cache_write_tokens: 0 for every Codex row (see
 * its usage-mapping block), so a Codex event can never satisfy
 * cache_write > cache_read and this signal is structurally unavailable for
 * that source. Per the audit spec's capability-status rule, a request
 * scoped to source: 'codex' must not synthesize a finding from data that
 * doesn't exist for it — it returns an empty findings array instead.
 */

import type { Confidence, CostLabel, Detector, DetectorContext, Finding } from '../types.js';
import { CACHE_INEFFICIENCY_MIN_TOKENS } from '../config.js';
import { wasteSignals } from '../../stats.js';
import { estimateUsd } from '../../pricing.js';
import { computeFindingId } from '../finding-id.js';

interface ModelCacheRow {
  model: string;
  cache_write: number;
  cache_read: number;
}

const CONFIDENCE: Confidence = 'medium';

export const cacheInefficiencyDetector: Detector = (ctx: DetectorContext): Finding[] => {
  if (ctx.limit <= 0) return [];

  // Codex never populates cache_write_tokens — nothing to detect. Emit the
  // capability status by returning no findings rather than fabricating one.
  if (ctx.source === 'codex') return [];

  // Only Claude Code's cache accounting is reliable, whether the caller
  // asked for 'claude-code' specifically or 'all' sources. Note: ScopeFilter
  // (stats.ts) has no project dimension yet, so ctx.project is intentionally
  // not applied here — day-level cache-waste detection stays project-
  // agnostic. Filtering only the secondary model-distribution query below by
  // project while the primary day-flagging ignores it would produce
  // inconsistent per-project attribution, which is worse than not filtering
  // at all. Wire ctx.project through once stats.ts's scope supports it.
  const scope = { source: 'claude-code' as const };

  const wasteDays = wasteSignals(ctx.db, ctx.days, scope).cache_waste_days;
  const flagged = wasteDays
    .map((d) => ({
      day: d.day,
      cacheReadTokens: d.cache_read,
      cacheWriteTokens: d.cache_write,
      wastedWriteTokens: d.cache_write - d.cache_read,
    }))
    .filter((d) => d.wastedWriteTokens >= CACHE_INEFFICIENCY_MIN_TOKENS);

  if (flagged.length === 0) return [];

  const totalWastedWriteTokens = flagged.reduce((sum, d) => sum + d.wastedWriteTokens, 0);

  // Best-effort model attribution for the flagged days only — one cheap
  // GROUP BY query (ts is indexed) rather than a per-day round trip.
  const dayPlaceholders = flagged.map(() => '?').join(',');
  const modelRows = ctx.db
    .prepare(
      `SELECT
        model,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
        COALESCE(SUM(cache_read_tokens), 0)  AS cache_read
       FROM token_events
       WHERE source = 'claude-code'
         AND ts >= ? AND ts <= ?
         AND strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') IN (${dayPlaceholders})
       GROUP BY model
       ORDER BY cache_write DESC`,
    )
    .all(ctx.sinceMs, ctx.untilMs, ...flagged.map((d) => d.day)) as ModelCacheRow[];

  const totalCacheWrite = modelRows.reduce((sum, r) => sum + r.cache_write, 0);

  let estimatedCostUsd: number | null = null;
  let costLabel: CostLabel = 'not_available';
  let modelDistribution: Array<{ model: string; cacheWriteTokens: number; cacheReadTokens: number }> | undefined;

  if (modelRows.length > 0 && totalCacheWrite > 0) {
    modelDistribution = modelRows.map((r) => ({
      model: r.model,
      cacheWriteTokens: r.cache_write,
      cacheReadTokens: r.cache_read,
    }));
    // Attribute the wasted-write total across models proportionally to each
    // model's share of cache writes on the flagged days, then price each
    // share's cache-write cost via pricing.ts. Cheap and defensible without
    // pretending to know exactly which model "owns" which wasted token.
    let cost = 0;
    for (const r of modelRows) {
      const share = r.cache_write / totalCacheWrite;
      const attributedWastedTokens = totalWastedWriteTokens * share;
      cost += estimateUsd({
        model: r.model,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: attributedWastedTokens,
      });
    }
    estimatedCostUsd = Math.round(cost * 1_000_000) / 1_000_000;
    costLabel = 'estimated_cost';
  }

  const dayCount = flagged.length;
  const title = `${dayCount} day${dayCount === 1 ? '' : 's'} with cache writes exceeding cache reads`;
  const description =
    `Over the last ${ctx.days}-day window, ${dayCount} day${dayCount === 1 ? '' : 's'} wrote more ` +
    `prompt-cache tokens than were ever read back — about ${totalWastedWriteTokens.toLocaleString()} ` +
    `cache-write tokens that were never reused (days below the ${CACHE_INEFFICIENCY_MIN_TOKENS.toLocaleString()}` +
    `-token noise floor are excluded).`;

  const evidence = flagged.map(
    (d) =>
      `${d.day}: wrote ${d.cacheWriteTokens.toLocaleString()} cache tokens, read back only ` +
      `${d.cacheReadTokens.toLocaleString()} (${d.wastedWriteTokens.toLocaleString()} wasted)`,
  );

  const recommendations = [
    'Check whether the system prompt / tool schema changed between turns on these days — cache breakpoints only pay off when the prefix ahead of them stays stable.',
    'Look for short-lived sessions that re-establish the same context repeatedly instead of continuing one long session that could reuse the cache.',
  ];

  const periodStart = new Date(ctx.sinceMs).toISOString();
  const periodEnd = new Date(ctx.untilMs).toISOString();

  const finding: Finding = {
    id: computeFindingId({
      schemaVersion: '1.0',
      type: 'cache_inefficiency',
      source: 'claude-code',
      project: ctx.project,
      sessionId: null,
      toolName: null,
      periodStart,
      periodEnd,
    }),
    // Placeholder — the engine re-ranks findings across all detectors once
    // it merges them into the final AuditReport.
    rank: 0,
    type: 'cache_inefficiency',
    title,
    description,
    source: 'claude-code',
    project: ctx.project,
    sessionId: null,
    toolName: null,
    metrics: {
      days: flagged,
      totalWastedWriteTokens,
      ...(modelDistribution ? { modelDistribution } : {}),
    },
    estimatedCostUsd,
    costLabel,
    confidence: CONFIDENCE,
    evidence,
    recommendations,
    // Day-level aggregation has no natural (source, request_id) or
    // (source, session_id) key the way session/tool-scoped detectors do;
    // left empty rather than guessing. Revisit if the engine needs this
    // finding's cost deduped against another finding's costEventIds.
    costEventIds: [],
  };

  return [finding].slice(0, ctx.limit);
};

export default cacheInefficiencyDetector;
