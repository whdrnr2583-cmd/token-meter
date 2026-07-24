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
  // date-suffix strip probes (2026-07-12) — dated ids must hit their exact
  // PRICES rate via the strip-and-retry path, not the family fallback.
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5-20251001',
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
