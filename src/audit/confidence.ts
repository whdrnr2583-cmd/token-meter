/**
 * Rolls a report's per-finding Confidence values up into one overall
 * Confidence for AuditReport.summary.overallConfidence.
 *
 * Rule: weight high=3, medium=2, low=1, average the weights, and round to
 * the nearest band — EXCEPT the result is bumped down one band whenever a
 * plain majority (>50%) of the findings are 'low' confidence. A weighted
 * average alone lets a couple of high-confidence findings paper over a
 * report that's mostly speculative signal; the low-majority override
 * exists because overallConfidence is meant to tell the user how much to
 * trust the report as a whole, not just its strongest finding.
 */

import type { Confidence } from './types.js';

const WEIGHT: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const BANDS: Confidence[] = ['low', 'medium', 'high'];

export function rollUpConfidence(confidences: Confidence[]): Confidence {
  if (confidences.length === 0) return 'low';

  const avgWeight =
    confidences.reduce((sum, c) => sum + WEIGHT[c], 0) / confidences.length;
  const bandIndex = Math.round(avgWeight) - 1; // 1..3 -> 0..2
  const band = BANDS[bandIndex] ?? 'low';

  const lowShare =
    confidences.filter((c) => c === 'low').length / confidences.length;
  if (lowShare > 0.5) {
    return BANDS[Math.max(0, BANDS.indexOf(band) - 1)]!;
  }

  return band;
}
