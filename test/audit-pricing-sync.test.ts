import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateUsd, PRICES } from '../src/pricing.js';

// scripts/quality-audit.cjs can't `import` src/pricing.ts (it's a plain .cjs
// script, run standalone against a live sqlite file, and pricing.ts is ESM
// TypeScript), so for its "pricing reproducibility" invariant it now reads
// the PRICES table straight out of src/pricing.ts's source text at runtime
// (see the extraction block in quality-audit.cjs) instead of hand-copying
// the literal. That hand-copy used to silently drift out of sync with
// src/pricing.ts (missing claude-opus-4-8 / claude-sonnet-5 / claude-fable-5
// rows, stale claude-opus-4-7 rate), which made the audit's own self-check
// produce false positives/negatives on live data — with the extraction there
// is only one PRICES table in the codebase, so that class of drift can no
// longer happen. What's still hand-maintained is the resolve() fallback
// chain (family substring matching, date-suffix stripping) — a behavioral
// mirror rather than data — so this test extracts *that* out of the .cjs
// source text, runs it against the real PRICES (imported directly from
// src/pricing.ts, not re-extracted — proves quality-audit.cjs's own
// extraction mechanism isn't what's under test here), and cross-checks
// against src/pricing.ts's own resolveModel()/estimateUsd() on a synthetic
// fixture set so any future drift in the fallback *logic* fails loudly here.

const here = path.dirname(fileURLToPath(import.meta.url));
const auditSrc = fs.readFileSync(path.join(here, '../scripts/quality-audit.cjs'), 'utf8');

function extractAuditResolve(): (model: string) => { input: number; output: number; cacheRead: number; cacheWrite5m: number } {
  const resolveMatch = auditSrc.match(/function resolve\(m\) \{[\s\S]*?\n\}/);
  assert.ok(resolveMatch, 'expected `function resolve(m) {...}` block in quality-audit.cjs');
  // Trusted local file. Evaluated against the real PRICES table (imported
  // from src/pricing.ts, the single source of truth) rather than a
  // hand-copied one.
  const factory = new Function('PRICES', `
    ${resolveMatch![0]}
    return resolve;
  `);
  return factory(PRICES);
}

const synthetic = [
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-5-5',
  'claude-haiku-4-5',
  'claude-haiku-4',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  // family-fallback probes — not literal PRICES keys, must resolve via resolve()'s substring match.
  'claude-opus-4-99-unreleased',
  'claude-sonnet-9-unreleased',
  'claude-fable-9-unreleased',
  'claude-haiku-9-unreleased',
  'gpt-6-unreleased',
  // date-suffix strip probes (2026-07-12) — dated ids must hit their exact
  // PRICES rate via the strip-and-retry path, not the family fallback.
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5-20251001',
  'claude-haiku-5-5-20261001',
  'claude-haiku-5-5[1m]',
  'claude-opus-5-5[1m]',
  // codex-line bucket probe — unrecognized codex variant must land on
  // gpt-5-codex, not generic gpt-5.
  'gpt-5.9-codex-unreleased',
];

test('quality-audit.cjs pricing mirror matches src/pricing.ts for every known + fallback model', () => {
  const resolve = extractAuditResolve();
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

test('quality-audit.cjs extracts PRICES from src/pricing.ts rather than hand-copying it', () => {
  // Regression guard: if quality-audit.cjs's extraction regex ever stops
  // matching src/pricing.ts's PRICES declaration (e.g. the declaration's
  // shape changes), the audit script throws loudly at startup rather than
  // silently falling back to a stale hand-copy — verify the regex it uses
  // still matches the live source.
  const pricesMatch = auditSrc.match(/export const PRICES: Record<string, ModelPrice> = (\{[\s\S]*?\n\});/);
  assert.ok(pricesMatch, 'quality-audit.cjs no longer extracts PRICES from src/pricing.ts as expected');
  assert.match(
    auditSrc,
    /readFileSync\(path\.join\(__dirname, '\.\.\/src\/pricing\.ts'\)/,
    'quality-audit.cjs should read PRICES out of src/pricing.ts, not hand-copy it',
  );
});

function extractAuditExpectUsd(): (row: {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}) => number {
  const resolveMatch = auditSrc.match(/function resolve\(m\) \{[\s\S]*?\n\}/);
  const expectMatch = auditSrc.match(/function expectUsd\(\{[\s\S]*?\n\}/);
  assert.ok(resolveMatch, 'expected `function resolve(m) {...}` block in quality-audit.cjs');
  assert.ok(expectMatch, 'expected `function expectUsd({...}) {...}` block in quality-audit.cjs');
  const factory = new Function('PRICES', `
    ${resolveMatch![0]}
    ${expectMatch![0]}
    return expectUsd;
  `);
  return factory(PRICES);
}

test('quality-audit.cjs expectUsd() prices 1-hour cache writes like estimateUsd()', () => {
  const expectUsd = extractAuditExpectUsd();
  const cases = [
    // all-1h: 2x input, not the 1.25x 5m rate
    { model: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 },
    // mixed 5m + 1h on a row with an unusual cacheRead ratio
    { model: 'claude-sonnet-5-5', input: 1000, output: 2000, cacheRead: 50000, cacheWrite: 30000, cacheWrite1h: 12000 },
    // OpenAI rows have no cache-write fee, so 1h writes cost 0 too
    { model: 'gpt-5', input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 3000, cacheWrite1h: 3000 },
  ];
  for (const c of cases) {
    assert.equal(expectUsd(c), estimateUsd(c), `1h cache-write drift for "${c.model}"`);
  }
});

test('quality-audit.cjs expectUsd() applies the Haiku 5.5 long-prompt tier like estimateUsd()', () => {
  const expectUsd = extractAuditExpectUsd();
  const cases = [
    // prompt 150k (> 100k): whole request billed at the longPrompt rates
    { model: 'claude-haiku-5-5', input: 150_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    // prompt counts input + cacheRead + cacheWrite
    { model: 'claude-haiku-5-5', input: 10_000, output: 1000, cacheRead: 80_000, cacheWrite: 20_000, cacheWrite1h: 5_000 },
    // exactly 100k is still the short tier
    { model: 'claude-haiku-5-5', input: 100_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
    // dated id resolves to the same row
    { model: 'claude-haiku-5-5-20261001', input: 150_000, output: 1000, cacheRead: 0, cacheWrite: 0 },
  ];
  for (const c of cases) {
    assert.equal(expectUsd(c), estimateUsd(c), `long-prompt drift for "${c.model}" (${JSON.stringify(c)})`);
  }
});
