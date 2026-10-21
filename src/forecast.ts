/**
 * Cost forecast + pacing alerts (Pro feature).
 *
 * Spec: docs/pro-features.md §4 "Cost forecast + pacing alerts"
 *
 * - forecastMonthly(): linear extrapolation from elapsed calendar days.
 *   Returns pace, projected EOM spend, budget %, days remaining.
 *   Carries "(estimate)" semantics — no seasonality, no weekend dips.
 *
 * - getMonthlyBudget() / setMonthlyBudget(): persist to user_settings table
 *   (single-row key/value store, migrated in db.ts migrateProBatch()).
 */

import type Database from 'better-sqlite3';

export interface ForecastResult {
  /** Calendar days elapsed in the current month (1-based, including today) */
  days_elapsed: number;
  /** Total calendar days in the current month */
  days_in_month: number;
  /** Calendar days remaining after today */
  days_remaining: number;
  /** Actual spend so far this calendar month (USD) */
  actual_usd: number;
  /** Linear extrapolation: spend / elapsed_days × days_in_month (estimate) */
  projected_eom_usd: number;
  /** Daily burn rate (spend / elapsed_days) */
  pace_usd_per_day: number;
  /** Actual spend as % of budget (null if no budget set) */
  budget_pct_today: number | null;
  /** Projected EOM as % of budget (null if no budget set) */
  budget_pct_projected: number | null;
  /** Configured monthly budget or null if unset */
  monthly_budget_usd: number | null;
  /** Previous calendar month total (for WoW-style delta context) */
  prev_month_usd: number;
  /**
   * True while fewer than 3 calendar days of the month have elapsed: a linear
   * projection from one or two days is dominated by noise (one heavy day
   * becomes a 30x month), so consumers should show it as indicative only and
   * must not raise pacing alerts from it.
   */
  low_confidence: boolean;
}

export const FORECAST_MIN_DAYS_FOR_CONFIDENCE = 3;

/**
 * Compute a linear forecast for the current calendar month.
 *
 * @param db     Open SQLite database handle.
 * @param asOf   Timestamp to treat as "now" (default: Date.now()). Injected
 *               in tests to make assertions deterministic.
 */
export function forecastMonthly(
  db: Database.Database,
  asOf: number = Date.now(),
): ForecastResult {
  const now = new Date(asOf);
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based

  // Calendar boundaries for the current month.
  const monthStart = new Date(year, month, 1).getTime();
  const monthEnd = new Date(year, month + 1, 1).getTime();
  // Calendar arithmetic, not millisecond arithmetic: a DST change makes one
  // local day 23 or 25 hours long, so dividing by 86_400_000 misreports the day
  // number during the first/last hour around the change.
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Days elapsed: calendar day-of-month, i.e. complete days plus today.
  const daysElapsed = Math.max(1, now.getDate());
  const daysRemaining = daysInMonth - daysElapsed;

  // Actual spend this month.
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(usd_estimate), 0) AS usd
       FROM token_events
       WHERE ts >= ? AND ts < ?`,
    )
    .get(monthStart, Math.min(asOf + 1, monthEnd)) as { usd: number };
  const actualUsd = row.usd;

  // Previous calendar month actual.
  const prevStart = new Date(year, month - 1, 1).getTime();
  const prevEnd = monthStart;
  const prevRow = db
    .prepare(
      `SELECT COALESCE(SUM(usd_estimate), 0) AS usd
       FROM token_events
       WHERE ts >= ? AND ts < ?`,
    )
    .get(prevStart, prevEnd) as { usd: number };

  // Linear extrapolation.
  const pacePerDay = daysElapsed > 0 ? actualUsd / daysElapsed : 0;
  const projectedEom = pacePerDay * daysInMonth;

  // Budget from settings (may be null).
  const budget = getMonthlyBudget(db);

  return {
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    days_remaining: Math.max(0, daysRemaining),
    actual_usd: actualUsd,
    projected_eom_usd: projectedEom,
    pace_usd_per_day: pacePerDay,
    budget_pct_today: budget !== null && budget > 0 ? actualUsd / budget : null,
    budget_pct_projected:
      budget !== null && budget > 0 ? projectedEom / budget : null,
    monthly_budget_usd: budget,
    prev_month_usd: prevRow.usd,
    low_confidence: daysElapsed < FORECAST_MIN_DAYS_FOR_CONFIDENCE,
  };
}

// ---------- user_settings helpers ----------

export function getMonthlyBudget(db: Database.Database): number | null {
  try {
    const row = db
      .prepare(
        `SELECT value FROM user_settings WHERE key = 'monthly_budget_usd'`,
      )
      .get() as { value: string } | undefined;
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    // Table may not exist yet (pre-migration); return null gracefully.
    return null;
  }
}

export function setMonthlyBudget(
  db: Database.Database,
  usd: number | null,
): void {
  if (usd === null) {
    db.prepare(`DELETE FROM user_settings WHERE key = 'monthly_budget_usd'`).run();
    return;
  }
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new RangeError(`monthly_budget_usd must be a positive finite number, got ${usd}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO user_settings (key, value, updated_at)
     VALUES ('monthly_budget_usd', ?, ?)`,
  ).run(String(usd), Date.now());
}
