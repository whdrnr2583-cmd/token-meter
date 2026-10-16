// Anthropic + OpenAI pricing (USD per million tokens) — updated 2026-10-16.
// Single source of truth. Heuristics only; no LLM call.
// Source: platform.claude.com models/pricing. Opus 4.5 through Opus 5 are $5/$25; Opus 5.5 is $4/$20 (Opus 4.0/4.1 were $15/$75).

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number; // ephemeral 5m (Anthropic-specific; OpenAI has no analog → 0)
  // ephemeral 1h cache write. Optional: when absent it is derived by
  // cacheWrite1hRate() as 2x input for rows that charge for cache writes
  // (every Anthropic row), 0 otherwise. Only set it for a row that deviates.
  cacheWrite1h?: number;
  // Optional long-prompt tier: a request whose prompt (input + cache read +
  // cache write tokens) exceeds `above` is billed entirely at these rates.
  // Judged per request (per message). The row's own numbers are the short tier.
  longPrompt?: { above: number; input: number; output: number; cacheRead: number; cacheWrite5m: number };
}

// Exported (in addition to modelRates()/estimateUsd() below) so callers that
// need to reason about the *shape* of the whole price table — e.g. the audit
// detectors' "is this a high-cost model" tier heuristic, which ranks models
// by their $/M output rate rather than hardcoding a model-name allowlist
// that would go stale the moment a new model ships — can read it directly
// instead of re-deriving/duplicating it.
export const PRICES: Record<string, ModelPrice> = {
  // Anthropic — cacheRead = 0.1x input, cacheWrite5m = 1.25x input.
  // Exceptions: cacheRead is 0.025x input for claude-fable-5-1, and 0.05x for claude-opus-5-5 and claude-sonnet-5-5.
  'claude-fable-5-1': { input: 10.0, output: 50.0, cacheRead: 0.25, cacheWrite5m: 12.5 },
  'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite5m: 12.5 },
  'claude-opus-5-5': { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite5m: 5.0 },
  'claude-opus-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite5m: 2.5 },
  // Sonnet 5 — $2/$10 is the standard price. The increase to $3/$15 that had been
  // scheduled for 2026-09-01 was cancelled (official pricing page footnote, checked 2026-10-06).
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.20, cacheWrite5m: 2.50 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  // Haiku 5.5 — checked 2026-10-16 at https://platform.claude.com/docs/en/about-claude/pricing.md.
  // Row rate is for prompts of 100k tokens or fewer; requests over 100k tokens (input + cache
  // read + cache write, judged per request) are billed at the longPrompt rates.
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125,
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625 },
  },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite5m: 1.25 },
  'claude-haiku-4': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite5m: 1.25 },
  // OpenAI (estimates — refine as official pricing updates)
  'gpt-5': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite5m: 0 },
  'gpt-5-codex': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite5m: 0 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite5m: 0 },
  'gpt-4o': { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite5m: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite5m: 0 },
  // Backlog chain B item 3 — confirmed 2026-07-12 via developers.openai.com/api/docs/pricing
  // (standard tier, cacheRead = 0.1x input matching the gpt-5 family pattern).
  'gpt-5.3-codex': { input: 1.75, output: 14.0, cacheRead: 0.175, cacheWrite5m: 0 },
  'gpt-5.4': { input: 2.5, output: 15.0, cacheRead: 0.25, cacheWrite5m: 0 },
  'gpt-5.5': { input: 5.0, output: 30.0, cacheRead: 0.5, cacheWrite5m: 0 },
  // gpt-5.3-codex-spark: not listed on the official OpenAI pricing page as of
  // 2026-07-12 (ChatGPT Pro research preview, no public API pricing yet) —
  // using the gpt-5 base rate as a placeholder rather than inventing a number.
  // TODO verify once OpenAI publishes API pricing for this model.
  'gpt-5.3-codex-spark': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite5m: 0 },
  // GPT-5.6 and GPT-6 families — Standard tier, short-context (<=272K input tokens) rates,
  // checked 2026-10-16 at https://developers.openai.com/api/docs/pricing.md. Prompts over
  // 272K tokens, Batch/Flex/Priority/Ultrafast tiers and cache-write fees are not modelled.
  // gpt-5.6-sol's $4/$20 is promotional pricing, listed as available at least through 2026-11-21.
  'gpt-6-astra': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite5m: 0 },
  'gpt-6.1-sol': { input: 2.0, output: 10.0, cacheRead: 0.1, cacheWrite5m: 0 },
  'gpt-6-sol': { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite5m: 0 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0 },
  'gpt-5.6-sol': { input: 4.0, output: 20.0, cacheRead: 0.4, cacheWrite5m: 0 },
  'gpt-5.6-terra': { input: 2.0, output: 12.0, cacheRead: 0.2, cacheWrite5m: 0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite5m: 0 },
};

// ---- Scheduled in-place rate changes --------------------------------------
// Some PRICES rows carry an introductory rate that changes to a known,
// different rate on a known future date (same model key, new numbers) — a
// human has to remember to bump the row manually; nothing else enforces it.
// checkScheduledRateChanges() is that enforcement: call it with the current
// date (test/scheduled-rate-changes.test.ts does; scripts/quality-audit.cjs's
// separate date-based 3b check was removed with the cancelled sonnet-5 entry)
// to get back a non-empty list once the date has passed and the
// row is still stale, so a missed manual bump fails loudly instead of
// silently under/over-pricing every affected turn indefinitely.
interface ScheduledRateChange {
  model: string;
  effectiveDate: string; // ISO yyyy-mm-dd — PRICES[model] must equal expectedRate on/after this date
  expectedRate: ModelPrice;
  note: string;
}

// None registered at present. The only prior entry (claude-sonnet-5, 2026-09-01)
// was removed because Anthropic cancelled that price increase.
const SCHEDULED_RATE_CHANGES: ScheduledRateChange[] = [];

/**
 * Warnings for every scheduled rate change whose effective date has passed
 * (relative to `now`) while PRICES still holds the pre-change rate. Empty
 * once the row has been bumped, or before the effective date.
 */
export function checkScheduledRateChanges(now: Date = new Date()): string[] {
  const todayIso = now.toISOString().slice(0, 10);
  const warnings: string[] = [];
  for (const change of SCHEDULED_RATE_CHANGES) {
    if (todayIso < change.effectiveDate) continue;
    const current = PRICES[change.model];
    if (!current) continue;
    const stale =
      current.input !== change.expectedRate.input ||
      current.output !== change.expectedRate.output ||
      current.cacheRead !== change.expectedRate.cacheRead ||
      current.cacheWrite5m !== change.expectedRate.cacheWrite5m;
    if (stale) {
      warnings.push(
        `PRICES['${change.model}'] is stale as of ${todayIso}: ${change.note} (effective ${change.effectiveDate}).`,
      );
    }
  }
  return warnings;
}

function resolveModel(model: string): ModelPrice {
  const normalized = model.replace(/\[.*\]/, '').trim().toLowerCase();
  if (PRICES[normalized]) return PRICES[normalized];
  // Claude Code JSONL logs often stamp the fully-dated model id (e.g.
  // claude-sonnet-4-5-20250929) rather than the bare alias in PRICES above.
  // Strip a trailing 8-digit date suffix and retry the exact-key lookup
  // before falling through to the coarser family substring fallback below —
  // without this, claude-sonnet-4-5-20250929 fell through to the cheaper
  // claude-sonnet-5 family fallback, underpricing every Sonnet 4.5 turn by
  // ~33% (observed: 87 real rows priced at $5.22 instead of $7.83).
  const dateStripped = normalized.replace(/-\d{8}$/, '');
  if (dateStripped !== normalized && PRICES[dateStripped]) return PRICES[dateStripped];
  // family fallbacks
  if (normalized.includes('fable')) return PRICES['claude-fable-5']!;
  if (normalized.includes('opus')) return PRICES['claude-opus-4-8']!;
  if (normalized.includes('haiku')) return PRICES['claude-haiku-4-5']!;
  if (normalized.includes('sonnet')) return PRICES['claude-sonnet-5']!;
  if (normalized.includes('gpt-5-codex')) return PRICES['gpt-5-codex']!;
  if (normalized.includes('gpt-5-mini')) return PRICES['gpt-5-mini']!;
  // Any other unrecognized Codex model name (e.g. a future gpt-5.x-codex
  // variant not yet added above) — bucket under gpt-5-codex rather than
  // falling through to the generic gpt-5 rate below, since Codex-line
  // pricing has historically diverged from plain gpt-5.
  if (normalized.includes('codex')) return PRICES['gpt-5-codex']!;
  if (normalized.includes('gpt-5')) return PRICES['gpt-5']!;
  if (normalized.includes('gpt-4o-mini')) return PRICES['gpt-4o-mini']!;
  if (normalized.includes('gpt-4o')) return PRICES['gpt-4o']!;
  // unknown — default to Sonnet pricing
  return PRICES['claude-sonnet-4-6']!;
}

/**
 * Per-million pricing for a model (input, output, cache read, cache write 5m).
 * Used by stats.ts/cacheStats to compute savings vs. raw-input cost.
 */
export function modelRates(model: string): ModelPrice {
  return resolveModel(model);
}

/**
 * $/M for 1-hour cache writes on a rate set (a model row or its longPrompt
 * tier): the explicit `cacheWrite1h` if the row carries one, else 2x input when
 * the row charges for cache writes at all (official table: 1h = 2x base input),
 * else 0 (OpenAI rows have no cache-write fee).
 */
export function cacheWrite1hRate(p: { input: number; cacheWrite5m: number; cacheWrite1h?: number }): number {
  if (p.cacheWrite1h !== undefined) return p.cacheWrite1h;
  return p.cacheWrite5m > 0 ? p.input * 2 : 0;
}

export function estimateUsd(opts: {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  /** Total cache-write tokens (5m + 1h). */
  cacheWrite: number;
  /** Portion of `cacheWrite` written to the 1-hour cache (billed at 2x input). Omitted = all 5m. */
  cacheWrite1h?: number;
}): number {
  const base = resolveModel(opts.model);
  const promptTokens = opts.input + opts.cacheRead + opts.cacheWrite;
  const p = base.longPrompt && promptTokens > base.longPrompt.above ? base.longPrompt : base;
  const write1h = Math.min(Math.max(opts.cacheWrite1h ?? 0, 0), opts.cacheWrite);
  const write5m = opts.cacheWrite - write1h;
  const cost =
    (opts.input * p.input +
      opts.output * p.output +
      opts.cacheRead * p.cacheRead +
      write5m * p.cacheWrite5m +
      write1h * cacheWrite1hRate(p)) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
