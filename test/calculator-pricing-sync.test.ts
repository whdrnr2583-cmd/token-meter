import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateUsd } from '../src/pricing.js';

// infra/site/calculator.html carries a THIRD hand-copied mirror of the price
// table (after src/pricing.ts and scripts/quality-audit.cjs), embedded in a
// `var PRICES = {...}` / `var ORDER = [...]` block for the public calculator
// page. It has already drifted twice: on 2026-07-08 the whole claude-sonnet-5
// row was missing (commit 57c11d5), so the project's own flagship model could
// not be selected. quality-audit.cjs's mirror got a sync test then; this file
// gives the calculator the same guard. It extracts the literal straight out of
// the HTML and cross-checks every rate against src/pricing.ts on a synthetic
// fixture, and asserts the current-flagship rows are present, so any future
// stale-rate or missing-row drift fails loudly here.

const here = path.dirname(fileURLToPath(import.meta.url));
const calcHtml = fs.readFileSync(path.join(here, '../infra/site/calculator.html'), 'utf8');

function extractCalculatorPricing(): {
  prices: Record<string, { in: number; out: number; cr: number; cw: number; label: string; est?: boolean }>;
  order: string[];
} {
  const pricesMatch = calcHtml.match(/var PRICES = (\{[\s\S]*?\n\s*\});/);
  const orderMatch = calcHtml.match(/var ORDER = (\[[\s\S]*?\]);/);
  assert.ok(pricesMatch, 'expected `var PRICES = {...};` block in calculator.html');
  assert.ok(orderMatch, 'expected `var ORDER = [...];` block in calculator.html');
  // Trusted local file, values-only object/array literals — safe to materialize.
  const factory = new Function(`
    var PRICES = ${pricesMatch![1]};
    var ORDER = ${orderMatch![1]};
    return { prices: PRICES, order: ORDER };
  `);
  return factory();
}

const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

test('calculator.html pricing mirror matches src/pricing.ts for every model it lists', () => {
  const { prices } = extractCalculatorPricing();
  const fixture = { input: 1000, output: 2000, cacheRead: 50000, cacheWrite: 3000 };
  const keys = Object.keys(prices);
  assert.ok(keys.length > 0, 'calculator PRICES table is non-empty');
  for (const model of keys) {
    const p = prices[model]!;
    const calcUsd = round6(
      (fixture.input * p.in + fixture.output * p.out + fixture.cacheRead * p.cr + fixture.cacheWrite * p.cw) /
        1_000_000,
    );
    const sourceUsd = estimateUsd({ model, ...fixture });
    assert.equal(
      calcUsd,
      sourceUsd,
      `calculator.html rate drift for "${model}": calculator=${calcUsd} vs src/pricing.ts=${sourceUsd}`,
    );
  }
});

test('calculator.html PRICES and ORDER stay in sync with each other', () => {
  const { prices, order } = extractCalculatorPricing();
  assert.deepEqual(
    [...order].sort(),
    [...Object.keys(prices)].sort(),
    'every ORDER entry must have a PRICES row and vice versa',
  );
});

test('calculator.html exposes the current flagship Claude models (regression: 57c11d5 dropped sonnet-5)', () => {
  const { prices, order } = extractCalculatorPricing();
  // The models Token Meter itself currently bills as live flagships. If any is
  // dropped from the calculator (as claude-sonnet-5 once was), fail here.
  const MUST_EXPOSE = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
  for (const model of MUST_EXPOSE) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(prices, model),
      `calculator.html must expose current model "${model}" in PRICES`,
    );
    assert.ok(order.includes(model), `calculator.html ORDER must list "${model}"`);
  }
});
