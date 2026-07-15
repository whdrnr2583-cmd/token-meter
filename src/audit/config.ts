/**
 * Centralized thresholds for the audit detectors (later phases). Kept here,
 * as plain named constants, so every detector reads the same bar and the
 * `audit` command never contradicts the existing Pro trim-suggestions
 * feature (../trim-suggestions.ts) — several values below are intentionally
 * identical to that file's thresholds rather than independently re-tuned.
 */

// expensive_session — a session is flagged when its share of total analyzed
// cost in the period is >= this fraction (15%). Share-based rather than a
// fixed top-N: a top-N cutoff would either flag trivial sessions in a quiet
// period or miss genuinely dominant sessions in a busy one; a cost-share
// threshold scales with the period automatically.
export const EXPENSIVE_SESSION_COST_SHARE_THRESHOLD = 0.15;

// oversized_tool_response — matches trim-suggestions.ts's LARGE_RESPONSE bar
// (avg response_tokens_est >= 5000) as the absolute floor, combined with a
// relative check so genuinely large-for-this-project responses are caught
// even when 5000 tokens isn't reached.
export const OVERSIZED_RESPONSE_ABS_TOKENS = 5000;
export const OVERSIZED_RESPONSE_PERCENTILE = 0.95;

// slow_tool — identical to trim-suggestions.ts's HIGH_LATENCY detector bar
// (avg latency_ms >= 3000 over >= 5 calls) so "slow" means the same thing
// in both features.
export const SLOW_TOOL_LATENCY_MS_THRESHOLD = 3000;
export const SLOW_TOOL_MIN_CALLS = 5;

// repeated_similar_tool_calls — two calls to the same tool count as
// "repeated" when they land within this window of each other and their
// response sizes are within this percentage tolerance of one another (a
// proxy for "probably fetched the same/similar thing twice").
export const REPEATED_CALL_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const REPEATED_CALL_SIZE_TOLERANCE_PCT = 0.10; // 10%

// cache_inefficiency — only worth flagging once a session/tool's input
// token volume is large enough that cache misses are actually costly;
// reuses the same 5000-token "large" bar as OVERSIZED_RESPONSE_ABS_TOKENS
// for consistency rather than inventing a separate magnitude.
export const CACHE_INEFFICIENCY_MIN_TOKENS = 5000;

// high_cost_model_signal — a session using a high-cost model (e.g. Opus)
// that both wraps up quickly (short wall-clock duration) and produces
// comparatively little output is a signal the model tier may be
// overkill for the task. Short = under 2 minutes; "little output" is
// judged against HIGH_COST_MODEL_MIN_OUTPUT_TOKENS below (flag only when
// output is at or above this floor, to avoid flagging trivial one-liners
// that aren't worth a model-tier recommendation either way).
export const HIGH_COST_MODEL_SHORT_SESSION_MS = 2 * 60 * 1000; // 2 minutes
export const HIGH_COST_MODEL_MIN_OUTPUT_TOKENS = 500;
