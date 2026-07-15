/**
 * The audit feature's entry point — runs all 6 detectors (D1-D6) over a
 * window of token_events/tool_events, merges their Finding[]s into one
 * ranked, deduped AuditReport.
 *
 * This file owns three things none of the detectors are responsible for on
 * their own (each detector only knows its own slice of the picture):
 *   1. Building the shared DetectorContext (window bounds, source/project
 *      scope, per-detector fetch limit) from CLI-facing options.
 *   2. Cross-detector cost dedup (Ω8 "no double counting") — see
 *      computeCostAssociated() below.
 *   3. Per-source (claude-code/codex) data-availability reporting — see
 *      buildSourceSummary() below — independent of which detectors actually
 *      ran, so the report can explain e.g. "codex has data but cache_
 *      inefficiency can't use it" even when ctx.source narrowed the run to
 *      claude-code only.
 *
 * ── Cost dedup (Ω8) ──────────────────────────────────────────────────────
 * Two detectors legitimately derive their cost from the *same* underlying
 * session spend: D1 (expensive_session) and D6 (high_cost_model_signal) both
 * key their costEventIds as `session:<source>:<session_id>` (see both
 * detectors' headers) because both sum real `usd_estimate` rows for a
 * session_id. If both fire on an overlapping session, summing their
 * estimatedCostUsd values naively would count that session's spend twice in
 * summary.costAssociatedUsd. D2 (oversized_tool_response) uses a
 * structurally different `tool:<name>:<mcp_server>` key naming a *projected*
 * weekly savings estimate rather than money already spent (see that file's
 * header) — because that key string can never equal a `session:...` key,
 * D2's projected-savings numbers are never unioned into the same running
 * total as real observed session spend; no separate bucket is needed to
 * enforce that, it falls out of the two naming schemes never colliding.
 *
 * computeCostAssociated() resolves an overlap by keeping the LARGER of the
 * two findings' estimatedCostUsd and dropping the smaller: a shared
 * costEventIds entry means both findings are (at least partially) pricing
 * the same spend, and — since Finding doesn't expose a per-costEventId
 * dollar breakdown, only a finding-level total — the larger total is the
 * more complete accounting available without re-querying the DB ourselves.
 * Findings are processed cost-descending so the "keep the larger" rule falls
 * out of "first write wins" without a second pass.
 *
 * ── overallConfidence for an empty report ───────────────────────────────
 * confidence.ts's rollUpConfidence([]) returns 'low' (its documented
 * behavior for an empty array falls through BANDS[-1] ?? 'low'). This file
 * overrides that specific case to 'high' instead: an audit with zero
 * findings isn't making any uncertain claims for the user to weigh, so
 * there's nothing for a confidence score to hedge — 'low' would misread as
 * "we looked but aren't sure", when the honest state is "we looked and found
 * nothing worth flagging".
 */

import type Database from 'better-sqlite3';
import { overview, scopeClause } from '../stats.js';
import type { ScopeFilter } from '../stats.js';
import { rollUpConfidence } from './confidence.js';
import type {
  AuditReport,
  AuditSourceSummary,
  Detector,
  DetectorContext,
  Finding,
  SourceStatus,
} from './types.js';

import expensiveSessionDetector from './detectors/expensive-session.js';
import oversizedToolResponseDetector from './detectors/oversized-tool-response.js';
import slowToolDetector from './detectors/slow-tool.js';
import repeatedSimilarToolCalls from './detectors/repeated-tool-calls.js';
import cacheInefficiencyDetector from './detectors/cache-inefficiency.js';
import highCostModelSignalDetector from './detectors/high-cost-model-signal.js';

// Declaration order doubles as the tie-break order when the ranking pass
// (rankFindings below) hits two findings with equal sort keys — earlier
// detectors here (cost-bearing session/response signals) sort ahead of the
// no-cost-data ones (D3/D4) on ties, which matches this list's own ordering.
const DETECTORS: Detector[] = [
  expensiveSessionDetector,
  oversizedToolResponseDetector,
  slowToolDetector,
  repeatedSimilarToolCalls,
  cacheInefficiencyDetector,
  highCostModelSignalDetector,
];

export interface RunAuditOptions {
  days?: number;
  source?: 'all' | 'claude-code' | 'codex';
  project?: string | null;
  limit?: number;
}

const DEFAULT_DAYS = 7;
const DEFAULT_SOURCE: RunAuditOptions['source'] = 'all';
const DEFAULT_LIMIT = 5;

// Individual detectors are asked for up to this many of their own findings
// (DetectorContext.limit) before the engine's cross-detector rank+cap
// (rankFindings below) narrows to the caller's real `limit` — never fewer
// than this floor, even when the caller's own limit is small (e.g.
// `--limit 1`). Without a floor, `--limit 1` would ask every detector for
// only 1 finding each, so D1's 2nd-most-expensive session (say) could never
// even be seen or compared against another detector's sole finding before
// the final cap picks a winner — silently degrading ranking quality for any
// small --limit. This is a candidate-pool size, not the number returned to
// the caller; rankFindings() still enforces the real `limit` at the end.
const DETECTOR_POOL_FLOOR = 10;

const AUDIT_SOURCES: Array<'claude-code' | 'codex'> = ['claude-code', 'codex'];

interface SourceCounts {
  windowRecords: number;
  allTimeRecords: number;
}

/**
 * token_events + tool_events row counts for one source, both within the
 * audited window and all-time (unbounded by `ts`). The all-time count is
 * what distinguishes "never ingested" (unavailable) from "ingested, just
 * not in this window" (partial) — see buildSourceSummary() below.
 */
function sourceCounts(
  db: Database.Database,
  source: 'claude-code' | 'codex',
  sinceMs: number,
  untilMs: number,
  project: string | null,
): SourceCounts {
  const projClause = project !== null ? ' AND project = ?' : '';
  const projArgs = project !== null ? [project] : [];

  const windowTok = db
    .prepare(`SELECT COUNT(*) AS c FROM token_events WHERE source = ? AND ts >= ? AND ts < ?${projClause}`)
    .get(source, sinceMs, untilMs, ...projArgs) as { c: number };
  const windowTool = db
    .prepare(`SELECT COUNT(*) AS c FROM tool_events WHERE source = ? AND ts >= ? AND ts < ?${projClause}`)
    .get(source, sinceMs, untilMs, ...projArgs) as { c: number };
  // "Whole table" per the audit spec — deliberately no ts/project filter, so
  // this answers "has anything from this source ever been ingested" rather
  // than "ingested inside the current scope".
  const allTok = db.prepare(`SELECT COUNT(*) AS c FROM token_events WHERE source = ?`).get(source) as {
    c: number;
  };
  const allTool = db.prepare(`SELECT COUNT(*) AS c FROM tool_events WHERE source = ?`).get(source) as {
    c: number;
  };

  return {
    windowRecords: windowTok.c + windowTool.c,
    allTimeRecords: allTok.c + allTool.c,
  };
}

/**
 * Fraction (0-1) of the requested window's days that had at least one
 * token_events or tool_events row for this source (+ project, if scoped).
 */
function coverageFraction(
  db: Database.Database,
  source: 'claude-code' | 'codex',
  sinceMs: number,
  untilMs: number,
  days: number,
  project: string | null,
): number {
  if (days <= 0) return 0;
  const projClause = project !== null ? ' AND project = ?' : '';
  const projArgs = project !== null ? [project] : [];
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT day) AS days_with_data FROM (
         SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day
         FROM token_events WHERE source = ? AND ts >= ? AND ts < ?${projClause}
         UNION ALL
         SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day
         FROM tool_events WHERE source = ? AND ts >= ? AND ts < ?${projClause}
       )`,
    )
    .get(source, sinceMs, untilMs, ...projArgs, source, sinceMs, untilMs, ...projArgs) as {
    days_with_data: number;
  };
  return Math.min(1, row.days_with_data / days);
}

/**
 * Per-source status per the audit spec:
 *   - 'unavailable' — literally zero rows for this source, ever (not just in
 *     this window). The only fix is running `token-meter ingest`.
 *   - 'partial'     — one of two cases: (a) the source has data somewhere,
 *     just not matching the requested window/project, or (b) a detector is
 *     structurally unable to use this source regardless of how much data it
 *     has (cache_inefficiency/D5 never fires for codex — see that file's
 *     header: Codex's usage payload never populates cache_write_tokens).
 *   - 'available'   — data exists in-window and no known structural gap.
 */
function sourceStatusAndWarnings(
  source: 'claude-code' | 'codex',
  counts: SourceCounts,
): { status: SourceStatus; warnings: string[] } {
  if (counts.allTimeRecords === 0) {
    return {
      status: 'unavailable',
      warnings: [
        `No ${source} data has ever been ingested. Run \`token-meter ingest\` after using ` +
          `${source === 'claude-code' ? 'Claude Code' : 'Codex'} to populate this source.`,
      ],
    };
  }
  if (counts.windowRecords === 0) {
    return {
      status: 'partial',
      // Deliberately doesn't say "outside the window" specifically: when
      // ctx.project narrows the query, this branch is equally reachable by
      // "this project has no rows for this source at all" as by "this
      // source's rows just don't fall in this window" — allTimeRecords (see
      // sourceCounts()) is intentionally unscoped by project, so it can't
      // tell the two apart either.
      warnings: [`${source} has data ingested, but none matches the requested window/project.`],
    };
  }
  if (source === 'codex') {
    return {
      status: 'partial',
      warnings: [
        'cache_inefficiency (D5) does not run for Codex: Codex\'s usage payload never reports ' +
          'cache_write_tokens, so cache-waste-day detection is structurally unavailable for this source ' +
          '(see src/audit/detectors/cache-inefficiency.ts).',
      ],
    };
  }
  return { status: 'available', warnings: [] };
}

function buildSourceSummary(
  db: Database.Database,
  source: 'claude-code' | 'codex',
  sinceMs: number,
  untilMs: number,
  days: number,
  project: string | null,
): AuditSourceSummary {
  const counts = sourceCounts(db, source, sinceMs, untilMs, project);
  const { status, warnings } = sourceStatusAndWarnings(source, counts);
  return {
    name: source,
    status,
    coverage: coverageFraction(db, source, sinceMs, untilMs, days, project),
    recordsAnalyzed: counts.windowRecords,
    // Rows that exist for this source but fall outside the requested window
    // — a real, computed number (all-time minus in-window), not a guess.
    recordsSkipped: Math.max(0, counts.allTimeRecords - counts.windowRecords),
    warnings,
  };
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

/**
 * Reuses stats.ts's overview()/scopeClause() rather than re-deriving the
 * SUM query. overview() has no `project` dimension (ScopeFilter doesn't
 * carry one — see stats.ts), so a project-scoped audit falls back to
 * scopeClause()'s source clause plus a locally-appended `project = ?`
 * condition, the same pattern D1/D5's detectors already use for their own
 * project-scoped queries rather than reinventing scope filtering.
 */
function computeUsage(
  db: Database.Database,
  days: number,
  sinceMs: number,
  untilMs: number,
  source: 'all' | 'claude-code' | 'codex',
  project: string | null,
): UsageTotals {
  const scope: ScopeFilter = source === 'all' ? 'all' : { source };

  if (project === null) {
    const o = overview(db, days, scope);
    const totalTokens = o.total_input + o.total_output + o.total_cache_read + o.total_cache_write;
    return {
      inputTokens: o.total_input,
      outputTokens: o.total_output,
      cacheReadTokens: o.total_cache_read,
      cacheWriteTokens: o.total_cache_write,
      totalTokens,
      estimatedCostUsd: o.events > 0 ? o.total_usd : null,
    };
  }

  const sc = scopeClause(scope);
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)       AS total_input,
         COALESCE(SUM(output_tokens), 0)      AS total_output,
         COALESCE(SUM(cache_read_tokens), 0)  AS total_cache_read,
         COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write,
         COALESCE(SUM(usd_estimate), 0)       AS total_usd,
         COUNT(*)                             AS events
       FROM token_events
       WHERE ts >= ? AND ts < ? AND project = ?${sc.clause}`,
    )
    .get(sinceMs, untilMs, project, ...sc.params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_write: number;
    total_usd: number;
    events: number;
  };
  const totalTokens = row.total_input + row.total_output + row.total_cache_read + row.total_cache_write;
  return {
    inputTokens: row.total_input,
    outputTokens: row.total_output,
    cacheReadTokens: row.total_cache_read,
    cacheWriteTokens: row.total_cache_write,
    totalTokens,
    estimatedCostUsd: row.events > 0 ? row.total_usd : null,
  };
}

/**
 * Cross-detector rank + cap. Cost-bearing findings (estimatedCostUsd !==
 * null) sort first, by cost descending — cost is the clearest single
 * "how much does this matter" signal available across detector types.
 * No-cost findings (D3 slow_tool, D4 repeated_similar_tool_calls) are
 * grouped after them, in their original (per-detector) order, since there's
 * no shared magnitude to rank them by. `rank` is (re)assigned 1-based here;
 * every detector's own `rank` field is a placeholder the engine overwrites
 * (see each detector's header comment).
 */
function rankFindings(findings: Finding[], limit: number): Finding[] {
  const withCost = findings.filter((f) => f.estimatedCostUsd !== null);
  const withoutCost = findings.filter((f) => f.estimatedCostUsd === null);
  withCost.sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0));

  const ordered = [...withCost, ...withoutCost].slice(0, Math.max(0, limit));
  return ordered.map((f, i) => ({ ...f, rank: i + 1 }));
}

/**
 * Sums estimatedCostUsd across `findings` without double-counting spend two
 * findings both cite via a shared costEventIds entry — see this file's
 * header for the full Ω8 rationale. Findings with no costEventIds (D5's
 * day-level aggregation has no natural session/tool key — see that file's
 * header) have nothing to compare against and are always counted in full.
 */
function computeCostAssociated(findings: Finding[]): { total: number | null; overlapDetected: boolean } {
  const claimed = new Set<string>();
  let total = 0;
  let sawPriced = false;
  let overlapDetected = false;

  const priced = findings
    .filter((f) => f.estimatedCostUsd !== null && f.costLabel !== 'not_available')
    .sort((a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0));

  for (const f of priced) {
    sawPriced = true;
    const usd = f.estimatedCostUsd ?? 0;

    if (f.costEventIds.length === 0) {
      total += usd;
      continue;
    }

    const overlaps = f.costEventIds.some((k) => claimed.has(k));
    for (const k of f.costEventIds) claimed.add(k);

    if (overlaps) {
      // A larger-or-equal finding (processed earlier, since we sorted cost
      // descending) already claimed at least one of this finding's keys —
      // its spend is already in `total`; adding this one too would
      // double-count the shared session(s)/tool aggregate.
      overlapDetected = true;
      continue;
    }

    total += usd;
  }

  return {
    total: sawPriced ? Math.round(total * 1_000_000) / 1_000_000 : null,
    overlapDetected,
  };
}

export function runAudit(db: Database.Database, opts: RunAuditOptions = {}): AuditReport {
  const days = opts.days ?? DEFAULT_DAYS;
  const source = opts.source ?? DEFAULT_SOURCE ?? 'all';
  const project = opts.project ?? null;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // Both bounds anchored to one Date.now() call so every detector/usage
  // query in this run agrees on "now" to the millisecond. Detectors that
  // reuse a function with its own internal Date.now() (topSessions(),
  // computeTrimSuggestions(), wasteSignals()/overview() via `days`) can
  // still drift by however long this function call takes to run — a
  // sub-millisecond gap in practice, and the same class of drift D1's
  // header already documents and accepts for the same reason.
  const untilMs = Date.now();
  const sinceMs = untilMs - Math.max(0, days) * 86_400_000;

  const ctx: DetectorContext = {
    db,
    sinceMs,
    untilMs,
    days,
    source,
    project,
    limit: Math.max(limit, DETECTOR_POOL_FLOOR),
  };

  const allFindings: Finding[] = [];
  const detectorErrors: string[] = [];
  for (const detector of DETECTORS) {
    try {
      allFindings.push(...detector(ctx));
    } catch (err) {
      // One detector's bug/edge-case must not take down the whole report —
      // record it as a warning and keep going with whatever the other
      // detectors returned (per the audit spec's "partial state, don't
      // abort the whole report" rule).
      const message = err instanceof Error ? err.message : String(err);
      detectorErrors.push(`${detector.name || 'detector'} failed: ${message}`);
    }
  }

  const rankedFindings = rankFindings(allFindings, limit);
  const { total: costAssociatedUsd, overlapDetected } = computeCostAssociated(rankedFindings);

  // An empty report makes no uncertain claims — see this file's header for
  // why that's 'high' rather than rollUpConfidence([])'s own 'low' default.
  const overallConfidence =
    rankedFindings.length === 0 ? 'high' : rollUpConfidence(rankedFindings.map((f) => f.confidence));

  const sources = AUDIT_SOURCES.map((s) => buildSourceSummary(db, s, sinceMs, untilMs, days, project));
  if (detectorErrors.length > 0) {
    // A detector failure isn't attributable to one specific source (several
    // detectors span both), so surface it on every in-scope source's
    // warnings rather than guessing which one it belongs to.
    for (const s of sources) {
      if (source === 'all' || source === s.name) s.warnings.push(...detectorErrors);
    }
  }

  const usage = computeUsage(db, days, sinceMs, untilMs, source, project);

  return {
    schemaVersion: '1.0',
    generatedAt: new Date().toISOString(),
    period: {
      start: new Date(sinceMs).toISOString(),
      end: new Date(untilMs).toISOString(),
      days,
    },
    sources,
    usage,
    summary: {
      findingCount: rankedFindings.length,
      costAssociatedUsd,
      overallConfidence,
      findingsMayOverlap: overlapDetected,
    },
    findings: rankedFindings,
  };
}

export default runAudit;
