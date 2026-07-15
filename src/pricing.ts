// Anthropic + OpenAI pricing (USD per million tokens) — updated 2026-06-29.
// Single source of truth. Heuristics only; no LLM call.
// Source: platform.claude.com models/pricing. Opus 4.6+ is $5/$25 (was $15/$75 on Opus 4.0/4.1).

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number; // ephemeral 5m (Anthropic-specific; OpenAI has no analog → 0)
}

// Exported (in addition to modelRates()/estimateUsd() below) so callers that
// need to reason about the *shape* of the whole price table — e.g. the audit
// detectors' "is this a high-cost model" tier heuristic, which ranks models
// by their $/M output rate rather than hardcoding a model-name allowlist
// that would go stale the moment a new model ships — can read it directly
// instead of re-deriving/duplicating it.
export const PRICES: Record<string, ModelPrice> = {
  // Anthropic — cacheRead = 0.1x input, cacheWrite5m = 1.25x input.
  'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite5m: 12.5 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-opus-4': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  // Sonnet 5 — introductory pricing through 2026-08-31; becomes $3/$15
  // (same as claude-sonnet-4-6 below) on 2026-09-01. Bump this row manually then.
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.20, cacheWrite5m: 2.50 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
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
};

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

export function estimateUsd(opts: {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  const p = resolveModel(opts.model);
  const cost =
    (opts.input * p.input +
      opts.output * p.output +
      opts.cacheRead * p.cacheRead +
      opts.cacheWrite * p.cacheWrite5m) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
