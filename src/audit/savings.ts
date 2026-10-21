/**
 * "What would I save?" — turns findings into a dollar figure with the
 * assumption stated next to it.
 *
 * `estimatedCostUsd` answers "how much money is involved"; it is NOT a saving
 * (a $40 session is not a $40 saving). `potentialSavingsUsd` is the part that
 * could plausibly be avoided, computed per finding type with a stated basis.
 * Every figure is an estimate and carries the finding's own confidence; types
 * without a defensible formula (slow tools, repeated calls, expensive sessions)
 * stay null rather than inventing a number.
 *
 *  - cache_inefficiency: cache tokens written but never read back would have
 *    been billed as plain input instead. The avoidable part is only the write
 *    premium (cache-write rate minus input rate), not the whole write cost.
 *  - high_cost_model_signal: re-price the same tokens of the flagged short
 *    sessions on a lower tier (same vendor). Assumes equal token counts and
 *    that the cheaper model would have been good enough — hence 'low'.
 *  - oversized_tool_response: the trim-suggestions projection (weekly), which
 *    assumes a fixed reducible share of response tokens priced as input.
 */

import type Database from 'better-sqlite3';
import { estimateUsd, modelRates } from '../pricing.js';
import type { Finding } from './types.js';

// Lower-tier reference model per vendor for the high-cost-model re-pricing.
// Keys of PRICES (see ../pricing.ts); chosen as the vendor's mainstream tier.
const REFERENCE_MODEL = { claude: 'claude-sonnet-5-5', openai: 'gpt-5.4' } as const;

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function referenceFor(model: string): string {
  return model.toLowerCase().includes('gpt') ? REFERENCE_MODEL.openai : REFERENCE_MODEL.claude;
}

function cacheInefficiencySavings(f: Finding): { usd: number; basis: string } | null {
  const dist = f.metrics.modelDistribution as
    | Array<{ model: string; cacheWriteTokens: number }>
    | undefined;
  const wasted = f.metrics.totalWastedWriteTokens;
  if (!dist || typeof wasted !== 'number' || wasted <= 0) return null;
  const totalWrite = dist.reduce((s, d) => s + d.cacheWriteTokens, 0);
  if (totalWrite <= 0) return null;
  let usd = 0;
  for (const d of dist) {
    const r = modelRates(d.model);
    const premiumPerMTok = Math.max(0, r.cacheWrite5m - r.input);
    usd += ((wasted * d.cacheWriteTokens) / totalWrite) * premiumPerMTok / 1_000_000;
  }
  return {
    usd: round6(usd),
    basis:
      'Cache-write premium (write rate minus plain input rate) on write tokens that were never read back; ' +
      'the tokens themselves would have been billed as input anyway.',
  };
}

function highCostModelSavings(
  db: Database.Database,
  f: Finding,
  sinceMs: number,
  untilMs: number,
): { usd: number; basis: string } | null {
  const model = f.metrics.model;
  if (typeof model !== 'string') return null;
  const sessionIds = f.costEventIds.map((k) => k.split(':').slice(2).join(':')).filter(Boolean);
  if (sessionIds.length === 0) return null;
  const ref = referenceFor(model);
  const rows = db
    .prepare(
      `SELECT model,
              COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
              COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw,
              COALESCE(SUM(usd_estimate),0) AS usd
       FROM token_events
       WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) AND ts >= ? AND ts < ? AND model = ?
       GROUP BY model`,
    )
    .all(...sessionIds, sinceMs, untilMs, model) as Array<{
    model: string; i: number; o: number; cr: number; cw: number; usd: number;
  }>;
  let saved = 0;
  for (const r of rows) {
    const repriced = estimateUsd({ model: ref, input: r.i, output: r.o, cacheRead: r.cr, cacheWrite: r.cw });
    saved += Math.max(0, r.usd - repriced);
  }
  return {
    usd: round6(saved),
    basis:
      `Same tokens re-priced on ${ref} instead of ${model}. Assumes identical token counts and that the ` +
      'lower tier would have been good enough for these sessions.',
  };
}

export function attachSavings(
  db: Database.Database,
  findings: Finding[],
  sinceMs: number,
  untilMs: number,
): void {
  for (const f of findings) {
    let s: { usd: number; basis: string } | null = null;
    try {
      if (f.type === 'cache_inefficiency') s = cacheInefficiencySavings(f);
      else if (f.type === 'high_cost_model_signal') s = highCostModelSavings(db, f, sinceMs, untilMs);
      else if (f.type === 'oversized_tool_response' && f.estimatedCostUsd !== null) {
        s = {
          usd: f.estimatedCostUsd,
          basis:
            'Projected per-week saving from trimming this tool\'s responses: assumes a fixed reducible share of ' +
            'response tokens (20-50% by pattern), priced at input rates.',
        };
      }
    } catch {
      s = null; // savings are advisory; never fail the report over them
    }
    f.potentialSavingsUsd = s ? s.usd : null;
    f.savingsBasis = s ? s.basis : null;
  }
}

/** Sum of per-finding savings; null when no finding has one. */
export function totalSavings(findings: Finding[]): number | null {
  const vals = findings.map((f) => f.potentialSavingsUsd).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  return round6(vals.reduce((a, b) => a + b, 0));
}
