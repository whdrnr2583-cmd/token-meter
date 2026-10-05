import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScheduledRateChanges, modelRates } from '../src/pricing.js';

// The claude-sonnet-5 increase from $2/$10 to $3/$15 that had been scheduled
// for 2026-09-01 was cancelled (official pricing page footnote, checked
// 2026-10-06), so no scheduled rate change is registered at present.
// checkScheduledRateChanges() is kept for the next announced in-place rate
// change; until one is registered it must return an empty list.

test('checkScheduledRateChanges: no scheduled change is registered, so it returns []', () => {
  assert.deepEqual(checkScheduledRateChanges(), []);
});

test('checkScheduledRateChanges: stays empty after the cancelled 2026-09-01 date, and claude-sonnet-5 stays at $2/$10', () => {
  assert.deepEqual(checkScheduledRateChanges(new Date('2026-09-01T00:00:00Z')), []);
  assert.deepEqual(checkScheduledRateChanges(new Date('2026-12-25T00:00:00Z')), []);
  assert.deepEqual(modelRates('claude-sonnet-5'), { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5 });
});
