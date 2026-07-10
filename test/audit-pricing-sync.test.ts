import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateUsd } from '../src/pricing.js';

// scripts/quality-audit.cjs can't `import` src/pricing.ts (it's a plain .cjs
// script, run standalone against a live sqlite file), so it keeps its own
// hand-copied mirror of the price table for its "pricing reproducibility"
// invariant. That mirror silently drifted out of sync with src/pricing.ts
// once (missing claude-opus-4-8 / claude-sonnet-5 / claude-fable-5 rows,
// stale claude-opus-4-7 rate), which made the audit's own self-check produce
// false positives/negatives on live data. This test extracts the *actual*
// PRICES literal + resolve() fallback logic straight out of the .cjs source
// text and cross-checks it against src/pricing.ts on a synthetic fixture set
// so any future drift fails loudly here instead of silently in the audit.

const here = path.dirname(fileURLToPath(import.meta.url));
const auditSrc = fs.readFileSync(path.join(here, '../scripts/quality-audit.cjs'), 'utf8');

function extractAuditPricing(): { resolve: (model: string) => { input: number; output: number; cacheRead: number; cacheWrite5m: number } } {
  const pricesMatch = auditSrc.match(/const PRICES = (\{[\s\S]*?\n\});/);
  const resolveMatch = auditSrc.match(/function resolve\(m\) \{[\s\S]*?\n\}/);
  assert.ok(pricesMatch, 'expected `const PRICES = {...};` block in quality-audit.cjs');
  assert.ok(resolveMatch, 'expected `function resolve(m) {...}` block in quality-audit.cjs');
  // Trusted local file, values-only object literal + fallback chain — safe to materialize.
  const factory = new Function(`
    const PRICES = ${pricesMatch![1]};
    ${resolveMatch![0]}
    return { PRICES, resolve };
  `);
  return factory();
}

const synthetic = [
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-haiku-4',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
  // family-fallback probes — not literal PRICES keys, must resolve via resolve()'s substring match.
  'claude-opus-4-99-unreleased',
  'claude-sonnet-9-unreleased',
  'claude-fable-9-unreleased',
  'claude-haiku-9-unreleased',
  'gpt-6-unreleased',
];

test('quality-audit.cjs pricing mirror matches src/pricing.ts for every known + fallback model', () => {
  const { resolve } = extractAuditPricing();
  const fixture = { input: 1000, output: 2000, cacheRead: 50000, cacheWrite: 3000 };
  for (const model of synthetic) {
    const auditRate = resolve(model);
    const auditUsd = Math.round(
      ((fixture.input * auditRate.input +
        fixture.output * auditRate.output +
        fixture.cacheRead * auditRate.cacheRead +
        fixture.cacheWrite * auditRate.cacheWrite5m) /
        1_000_000) *
        1_000_000,
    ) / 1_000_000;
    const sourceUsd = estimateUsd({ model, ...fixture });
    assert.equal(auditUsd, sourceUsd, `pricing mirror drift for "${model}": audit=${auditUsd} vs src/pricing.ts=${sourceUsd}`);
  }
});
