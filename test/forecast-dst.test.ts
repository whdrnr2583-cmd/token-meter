// Runs in its own process (node --test isolates files), so setting TZ here is safe.
process.env.TZ = 'America/New_York';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb } from '../src/db.js';
import { forecastMonthly } from '../src/forecast.js';

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

test('day number is the calendar day even in the hour after a DST change (23h/25h days)', () => {
  // US fall-back 2026-11-01: that local day has 25 hours. At 23:30 on Nov 1 the
  // millisecond-based formula reported day 2.
  const fallBack = new Date(2026, 10, 1, 23, 30).getTime();
  assert.equal(forecastMonthly(db(), fallBack).days_elapsed, 1);
  // US spring-forward 2026-03-08 (23h day): 00:30 on Mar 9 reported day 8.
  const springForward = new Date(2026, 2, 9, 0, 30).getTime();
  assert.equal(forecastMonthly(db(), springForward).days_elapsed, 9);
});

test('days_in_month follows the calendar (Feb leap/non-leap) and early-month forecasts are flagged low confidence', () => {
  assert.equal(forecastMonthly(db(), new Date(2028, 1, 10, 12).getTime()).days_in_month, 29);
  assert.equal(forecastMonthly(db(), new Date(2027, 1, 10, 12).getTime()).days_in_month, 28);
  assert.equal(forecastMonthly(db(), new Date(2026, 4, 2, 12).getTime()).low_confidence, true);
  assert.equal(forecastMonthly(db(), new Date(2026, 4, 3, 12).getTime()).low_confidence, false);
});
