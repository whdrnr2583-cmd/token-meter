import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd, PRICES } from '../src/pricing.js';

test('Opus 4.7 typical message', () => {
  const v = estimateUsd({ model: 'claude-opus-4-7', input: 10, output: 500, cacheRead: 5000, cacheWrite: 1000 });
  // Opus 4.6+ pricing: $5/$25 input/output, cacheRead 0.5, cacheWrite5m 6.25.
  // (10*5 + 500*25 + 5000*0.5 + 1000*6.25) / 1e6
  // = (50 + 12500 + 2500 + 6250) / 1e6 = 21300 / 1e6 = 0.0213
  assert.equal(v, 0.0213);
});

test('Sonnet 4.6 cache-heavy', () => {
  const v = estimateUsd({ model: 'claude-sonnet-4-6', input: 0, output: 1000, cacheRead: 100000, cacheWrite: 0 });
  // (0 + 1000*15 + 100000*0.3 + 0) / 1e6 = (15000 + 30000) / 1e6 = 0.045
  assert.equal(v, 0.045);
});

test('GPT-5 reasoning-heavy turn', () => {
  // OpenAI bills reasoning as output; parser already folds reasoning into output.
  const v = estimateUsd({ model: 'gpt-5', input: 1000, output: 3000, cacheRead: 20000, cacheWrite: 0 });
  // (1000*1.25 + 3000*10 + 20000*0.125 + 0) / 1e6 = (1250 + 30000 + 2500) / 1e6 = 0.03375
  assert.equal(v, 0.03375);
});

test('unknown model falls back to Sonnet pricing', () => {
  const v1 = estimateUsd({ model: 'something-unknown', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const v2 = estimateUsd({ model: 'claude-sonnet-4-6', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(v1, v2);
});

test('opus family fallback recognizes new opus version names', () => {
  const v1 = estimateUsd({ model: 'claude-opus-4-99', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const v2 = estimateUsd({ model: 'claude-opus-4-7', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(v1, v2);
});

test('zero usage produces zero cost', () => {
  assert.equal(estimateUsd({ model: 'claude-opus-4-7', input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), 0);
});

test('GPT-5-Codex matches GPT-5 pricing', () => {
  const a = estimateUsd({ model: 'gpt-5-codex', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const b = estimateUsd({ model: 'gpt-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(a, b);
});

test('a bracketed context-window suffix (e.g. claude-opus-4-8[1m]) prices the same as the bare model', () => {
  // Long-context model IDs appear in real Claude Code logs with a bracketed
  // suffix like `[1m]`. resolveModel() strips it; if that strip regressed the
  // ID would fall through to the default Sonnet rate and misprice Opus turns.
  const bracketed = estimateUsd({ model: 'claude-opus-4-8[1m]', input: 10, output: 500, cacheRead: 5000, cacheWrite: 1000 });
  const bare = estimateUsd({ model: 'claude-opus-4-8', input: 10, output: 500, cacheRead: 5000, cacheWrite: 1000 });
  assert.equal(bracketed, bare);
  // Sanity: Opus 4.8 is $5/$25, not the Sonnet default — proves the strip
  // actually resolved to the Opus row rather than the fallback.
  assert.equal(bracketed, 0.0213);
});

test('a dated Sonnet 4.5 model ID (claude-sonnet-4-5-20250929) prices at the Sonnet 4.5 rate, not the cheaper Sonnet 5 family fallback', () => {
  // Real Claude Code logs stamp the fully-dated model id, not the bare
  // alias. Before the date-suffix strip, this fell through to the
  // claude-sonnet-5 family fallback ($2/$10) instead of the actual
  // claude-sonnet-4-5 rate ($3/$15) — a 33.3% undercount.
  const dated = estimateUsd({ model: 'claude-sonnet-4-5-20250929', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const exact = estimateUsd({ model: 'claude-sonnet-4-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const cheaperFallback = estimateUsd({ model: 'claude-sonnet-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(dated, exact);
  assert.notEqual(dated, cheaperFallback, 'must not silently price at the cheaper Sonnet 5 rate');
});

test('a dated Opus model ID retries the exact key before the (differently-priced) Opus family fallback', () => {
  // claude-opus-4-1 ($15/$75) differs from the family fallback's target
  // claude-opus-4-8 ($5/$25) — a case where the family fallback would be
  // silently wrong, not just approximately right.
  const dated = estimateUsd({ model: 'claude-opus-4-1-20250101', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const exact = estimateUsd({ model: 'claude-opus-4-1', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const familyFallback = estimateUsd({ model: 'claude-opus-4-1-unreleased', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(dated, exact);
  assert.notEqual(dated, familyFallback, 'must resolve via the exact dated key, not the opus-4-8 family fallback');
});

test('a non-8-digit numeric suffix is left alone (no over-eager date stripping)', () => {
  // 7 digits — must not match the -\d{8}$ pattern, so this still falls
  // through to the ordinary sonnet family fallback like any other unknown
  // sonnet variant (regression guard on the strip regex being exactly {8}).
  const v = estimateUsd({ model: 'claude-sonnet-4-5-2025092', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const sonnet5Fallback = estimateUsd({ model: 'claude-sonnet-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(v, sonnet5Fallback);
});

test('an unsuffixed exact match is unaffected by the date-strip addition (no regression)', () => {
  const v1 = estimateUsd({ model: 'claude-sonnet-4-6', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const v2 = estimateUsd({ model: 'claude-sonnet-4-6', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(v1, v2);
});

test('a model ID matching no known family substring still gets non-zero cost (never silently $0)', () => {
  // e.g. a brand-new model line released after this pricing table was last
  // updated — must fall through to the final Sonnet-pricing default rather
  // than throw or price at $0, so new-model rows never look "free" or crash
  // ingest.
  const v = estimateUsd({ model: 'claude-nova-9-experimental', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  const sonnet5 = estimateUsd({ model: 'claude-sonnet-4-6', input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 });
  assert.ok(v > 0, 'unrecognized model must not price at $0');
  assert.equal(v, sonnet5, 'unrecognized model falls back to the default Sonnet rate');
});

test('current Anthropic models (opus-5-5, opus-5, sonnet-5-5, fable-5-1) price at their own rows, not the family fallback', () => {
  const usage = { input: 1000, output: 1000, cacheRead: 100000, cacheWrite: 1000 };
  // The opus-5 and sonnet-5-5 rows equal their family-fallback rates, so the value
  // assertions below alone would still pass if those rows were deleted.
  for (const key of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
    assert.ok(key in PRICES, `PRICES must carry its own row for ${key}`);
  }
  // opus-5-5 ($4/$20, cacheRead 0.2, cacheWrite5m 5.0):
  // (1000*4 + 1000*20 + 100000*0.2 + 1000*5.0) / 1e6 = (4000 + 20000 + 20000 + 5000) / 1e6 = 0.049
  assert.equal(estimateUsd({ model: 'claude-opus-5-5', ...usage }), 0.049);
  // opus-5 ($5/$25, cacheRead 0.5, cacheWrite5m 6.25):
  // (1000*5 + 1000*25 + 100000*0.5 + 1000*6.25) / 1e6 = (5000 + 25000 + 50000 + 6250) / 1e6 = 0.08625
  assert.equal(estimateUsd({ model: 'claude-opus-5', ...usage }), 0.08625);
  // sonnet-5-5 ($2/$10, cacheRead 0.1 = 0.05x input, cacheWrite5m 2.5):
  // (1000*2 + 1000*10 + 100000*0.1 + 1000*2.5) / 1e6 = (2000 + 10000 + 10000 + 2500) / 1e6 = 0.0245
  assert.equal(estimateUsd({ model: 'claude-sonnet-5-5', ...usage }), 0.0245);
  // fable-5-1 ($10/$50, cacheRead 0.25, cacheWrite5m 12.5):
  // (1000*10 + 1000*50 + 100000*0.25 + 1000*12.5) / 1e6 = (10000 + 50000 + 25000 + 12500) / 1e6 = 0.0975
  assert.equal(estimateUsd({ model: 'claude-fable-5-1', ...usage }), 0.0975);
});

test('claude-haiku-5-5 prices at its own row ($0.10/$0.50), not the Haiku 4.5 family fallback', () => {
  // cacheRead 90000 keeps the prompt (92,000) in the <=100k tier; the >100k tier is tested separately below.
  const usage = { input: 1000, output: 1000, cacheRead: 90000, cacheWrite: 1000 };
  assert.ok('claude-haiku-5-5' in PRICES, 'PRICES must carry its own row for claude-haiku-5-5');
  // haiku-5-5 ($0.10/$0.50, cacheRead 0.01, cacheWrite5m 0.125):
  // (1000*0.1 + 1000*0.5 + 90000*0.01 + 1000*0.125) / 1e6 = (100 + 500 + 900 + 125) / 1e6 = 0.001625
  const expected = 0.001625;
  assert.equal(estimateUsd({ model: 'claude-haiku-5-5', ...usage }), expected);
  // dated id and bracketed context-window suffix resolve to the same row
  assert.equal(estimateUsd({ model: 'claude-haiku-5-5-20261001', ...usage }), expected);
  assert.equal(estimateUsd({ model: 'claude-haiku-5-5[1m]', ...usage }), expected);
  // the old family fallback (haiku-4-5, $1/$5) would be an order of magnitude higher
  assert.ok(estimateUsd({ model: 'claude-haiku-4-5', ...usage }) > expected * 5);
});

test('GPT-5.6 and GPT-6 families price at their own Standard short-context rows, not the gpt-5 / Sonnet fallbacks', () => {
  const usage = { input: 1000, output: 1000, cacheRead: 100000, cacheWrite: 1000 };
  // [model, expected] — (1000*in + 1000*out + 100000*cacheRead + 1000*0) / 1e6; OpenAI rows carry no cache-write fee.
  const cases: Array<[string, number]> = [
    ['gpt-6-astra', 0.16], //   ($10/$50, cached 1.0)   (10000 + 50000 + 100000) / 1e6
    ['gpt-6.1-sol', 0.022], //  ($2/$10, cached 0.1)    (2000 + 10000 + 10000) / 1e6
    ['gpt-6-sol', 0.032], //    ($2/$10, cached 0.2)    (2000 + 10000 + 20000) / 1e6
    ['gpt-6-luna', 0.0016], //  ($0.10/$0.50, cached 0.01) (100 + 500 + 1000) / 1e6
    ['gpt-5.6-sol', 0.064], //  ($4/$20, cached 0.4)    (4000 + 20000 + 40000) / 1e6
    ['gpt-5.6-terra', 0.034], //($2/$12, cached 0.2)    (2000 + 12000 + 20000) / 1e6
    ['gpt-5.6-luna', 0.0034], //($0.20/$1.20, cached 0.02) (200 + 1200 + 2000) / 1e6
  ];
  for (const [model, expected] of cases) {
    assert.ok(model in PRICES, `PRICES must carry its own row for ${model}`);
    assert.equal(PRICES[model]!.cacheWrite5m, 0, `${model} has no 5m cache-write fee in this table`);
    assert.equal(estimateUsd({ model, ...usage }), expected, model);
  }
});

test('a bracketed context-window suffix prices claude-opus-5-5[1m] the same as claude-opus-5-5', () => {
  const usage = { input: 1000, output: 1000, cacheRead: 100000, cacheWrite: 1000 };
  assert.equal(
    estimateUsd({ model: 'claude-opus-5-5[1m]', ...usage }),
    estimateUsd({ model: 'claude-opus-5-5', ...usage }),
  );
});

// Haiku 5.5 bills a request at the higher long-prompt rate when its prompt
// (input + cache read + cache write) exceeds 100,000 tokens. Judged per request.
test('Haiku 5.5 long-prompt tier boundary: 99,999 / 100,000 stay short, 100,001 goes long', () => {
  const at = (input: number) => estimateUsd({ model: 'claude-haiku-5-5', input, output: 1000, cacheRead: 0, cacheWrite: 0 });
  // short: input*0.10 + 1000*0.50 ; long: input*0.50 + 1000*2.50
  assert.equal(at(99_999), Math.round(((99_999 * 0.1 + 1000 * 0.5) / 1e6) * 1e6) / 1e6);
  assert.equal(at(100_000), 0.0105); // (100000*0.1 + 500)/1e6
  assert.equal(at(100_001), 0.052501); // (100001*0.5 + 2500)/1e6 = 52500.5/1e6 rounded to 6dp
});

test('Haiku 5.5 long-prompt tier sums input + cache read + cache write', () => {
  // 60k + 30k + 10k = 100k exactly -> short rates
  const atLimit = estimateUsd({ model: 'claude-haiku-5-5', input: 60_000, output: 1000, cacheRead: 30_000, cacheWrite: 10_000 });
  // (60000*0.1 + 1000*0.5 + 30000*0.01 + 10000*0.125)/1e6 = (6000+500+300+1250)/1e6
  assert.equal(atLimit, 0.00805);
  // 60k + 30k + 10k + 1 -> long rates for every component
  const over = estimateUsd({ model: 'claude-haiku-5-5', input: 60_000, output: 1000, cacheRead: 30_000, cacheWrite: 10_001 });
  // (60000*0.5 + 1000*2.5 + 30000*0.05 + 10001*0.625)/1e6 = (30000+2500+1500+6250.625)/1e6
  assert.equal(over, 0.040251);
  // cache read alone pushes a tiny-input request over the line
  const cacheOnly = estimateUsd({ model: 'claude-haiku-5-5', input: 10, output: 0, cacheRead: 100_001, cacheWrite: 0 });
  // (10*0.5 + 100001*0.05)/1e6 = 5005.05/1e6
  assert.equal(cacheOnly, 0.005005);
});

test('dated Haiku 5.5 id uses the long-prompt tier; other models ignore prompt size', () => {
  const dated = estimateUsd({ model: 'claude-haiku-5-5-20261001', input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(dated, 0.1); // 200000*0.5/1e6
  // Sonnet 5.5 has no long tier: cost is linear in tokens
  const small = estimateUsd({ model: 'claude-sonnet-5-5', input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 });
  const big = estimateUsd({ model: 'claude-sonnet-5-5', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(big, small * 1000);
});
