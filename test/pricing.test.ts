import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsd } from '../src/pricing.js';

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
