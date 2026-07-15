/**
 * Deterministic Finding.id generation. Findings are recomputed fresh on
 * every audit run rather than persisted — callers (CLI diffing two runs,
 * a dashboard re-rendering) rely on the same underlying finding producing
 * the same id every time, so this must be pure: no randomness, no clock,
 * no I/O, no dependence on iteration order.
 */

import { createHash } from 'node:crypto';

export interface FindingIdFields {
  schemaVersion: string;
  type: string;
  source: string;
  project: string | null;
  sessionId: string | null;
  toolName: string | null;
  periodStart: string;
  periodEnd: string;
  /**
   * Optional extra disambiguator for detectors whose findings aren't
   * uniquely identified by the fields above — e.g. a finding aggregated
   * across many sessions/tools (sessionId/toolName both null) but keyed by
   * something else, like a model name. Omit it entirely (don't pass the
   * key) for single-session/single-tool findings; existing callers that
   * never set it are unaffected, since computeFindingId() only hashes keys
   * actually present on the object it's given.
   */
  discriminator?: string;
}

/**
 * Hash a sorted-key `key=value` join of `fields` to a 16-char hex id
 * (sha256, truncated). Sorting keys before joining is what makes this
 * independent of the caller's property-declaration order.
 */
export function computeFindingId(fields: FindingIdFields): string {
  const normalized = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${JSON.stringify(fields[key as keyof FindingIdFields])}`)
    .join('|');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}
