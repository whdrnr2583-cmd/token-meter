import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScheduledRateChanges } from '../src/pricing.js';

// src/pricing.ts:27-29 documents that claude-sonnet-5's introductory pricing
// ($2/$10) must be manually bumped to the standard $3/$15 rate on
// 2026-09-01 — a manual trigger that is easy to forget (Sonnet 4.5's
// date-suffix underpricing bug, also documented in pricing.ts, shows what a
// missed pricing update costs: ~33% undercounted cost on every affected
// turn). checkScheduledRateChanges() is the guardrail: it fires purely on
// wall-clock date vs. the PRICES table, independent of any DB content.

test('checkScheduledRateChanges: no warning before the effective date', () => {
  const warnings = checkScheduledRateChanges(new Date('2026-08-31T23:59:59Z'));
  assert.deepEqual(warnings, []);
});

test('checkScheduledRateChanges: warns once the effective date has passed and the row is still stale', () => {
  const warnings = checkScheduledRateChanges(new Date('2026-09-01T00:00:00Z'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /claude-sonnet-5/);
  assert.match(warnings[0]!, /2026-09-01/);
});

test('checkScheduledRateChanges: still warns well after the effective date (not a one-day-only check)', () => {
  const warnings = checkScheduledRateChanges(new Date('2026-12-25T00:00:00Z'));
  assert.equal(warnings.length, 1);
});

test('checkScheduledRateChanges: as of today, claude-sonnet-5 has not yet expired', () => {
  // Regression guard for the "today" default param — must not warn before
  // 2026-09-01 even without an explicit `now` passed in. This test itself
  // will start failing once wall-clock time actually crosses 2026-09-01,
  // which is the intended trigger to go bump src/pricing.ts.
  const warnings = checkScheduledRateChanges();
  assert.deepEqual(
    warnings,
    [],
    'claude-sonnet-5 introductory pricing has expired — bump PRICES[\'claude-sonnet-5\'] in src/pricing.ts to the standard $3/$15 rate',
  );
});
