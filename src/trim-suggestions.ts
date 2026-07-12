/**
 * Auto-trim rule suggestions (Pro feature — suggestions only, no auto-execute).
 *
 * Spec: docs/pro-features.md §9 "Auto-trim rule suggestions"
 *
 * Three pattern detectors over tool_events:
 *   1. LARGE_RESPONSE  — tool calls whose average response is large (≥5k tokens)
 *      with ≥5 calls in the window. "Consider filtering returned fields."
 *   2. REPEATED_BINARY — tool calls on binary/image file patterns (png/jpg/svg/pdf)
 *      that are called frequently, matched via tool_events.file_ext. Falls back to
 *      the high-frequency-read heuristic for calls with no captured file_ext.
 *      "Consider an exclude pattern."
 *   3. HIGH_LATENCY    — tools with high average latency (≥3000ms) and ≥5 calls.
 *      "High latency tool — investigate if output is actually used downstream."
 *
 * Each detector emits a TrimSuggestion payload. Suggestions are ranked by
 * estimated weekly savings; the top 5 are returned.
 *
 * Pro+ extension (not in this file): auto-execute via `mcp.trim` action.
 */

import type Database from 'better-sqlite3';
import { modelRates } from './pricing.js';

export type SuggestionKind =
  | 'large_response'
  | 'repeated_binary'
  | 'high_latency';

export interface TrimSuggestion {
  kind: SuggestionKind;
  tool_name: string;
  mcp_server: string | null;
  /** Human-readable explanation of the pattern. */
  evidence: string;
  /** Estimated tokens saved per week if the suggestion is applied. */
  savings_tokens_per_week: number;
  /** Estimated USD saved per week (heuristic, assumes current model mix avg). */
  savings_usd_per_week: number;
  /** One-liner the user can copy and act on. */
  action_text: string;
}

// Minimum call count to flag a read tool as high-frequency. Used both by the
// binary-extension detector below and by its high-frequency-read fallback
// (for calls where tool_events.file_ext is NULL — older rows ingested before
// file_ext existed, or tool_use calls with no path-like argument to extract
// an extension from).
const HIGH_FREQ_READ_THRESHOLD = 10;

// Binary/asset extensions (lowercased, no dot) that the REPEATED_BINARY
// detector flags when read frequently — matched against tool_events.file_ext,
// captured at parse time from the tool_use call's file_path/path/
// notebook_path argument (see parser.ts).
const BINARY_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'bmp', 'webp',
  'pdf', 'zip', 'tar', 'gz', '7z', 'rar',
  'mp3', 'wav', 'mp4', 'mov',
  'woff', 'woff2', 'ttf', 'eot',
];

function avgTokenCostPerEvent(db: Database.Database, days: number): number {
  // Rough average: total usd / events, back-scaled to per-token.
  // Used only for savings_usd estimate — not billing-precise.
  const since = Date.now() - days * 86_400_000;
  const row = db
    .prepare(
      `SELECT COALESCE(AVG(usd_estimate), 0) AS avg_usd,
              COALESCE(AVG(output_tokens + input_tokens), 1) AS avg_toks
       FROM token_events WHERE ts >= ?`,
    )
    .get(since) as { avg_usd: number; avg_toks: number };
  return row.avg_usd / Math.max(1, row.avg_toks);
}

/**
 * Run all three detectors over the given window and return ranked suggestions.
 *
 * @param db    Open SQLite handle.
 * @param days  Look-back window in days (capped to Pro entitlement by caller).
 */
export function computeTrimSuggestions(
  db: Database.Database,
  days: number,
): TrimSuggestion[] {
  const since = Date.now() - days * 86_400_000;
  const usdPerToken = avgTokenCostPerEvent(db, days);
  const suggestions: TrimSuggestion[] = [];

  // ── 1. LARGE_RESPONSE ────────────────────────────────────────────────────
  const largeRows = db
    .prepare(
      `SELECT tool_name, mcp_server,
              COUNT(*) AS calls,
              CAST(AVG(response_tokens_est) AS INTEGER) AS avg_tokens,
              MAX(response_tokens_est) AS max_tokens
       FROM tool_events
       WHERE ts >= ?
       GROUP BY tool_name, mcp_server
       HAVING COUNT(*) >= 5 AND AVG(response_tokens_est) >= 5000
       ORDER BY avg_tokens DESC
       LIMIT 10`,
    )
    .all(since) as {
    tool_name: string;
    mcp_server: string | null;
    calls: number;
    avg_tokens: number;
    max_tokens: number;
  }[];

  for (const r of largeRows) {
    const callsPerWeek = (r.calls / days) * 7;
    const savingsTok = Math.round(callsPerWeek * r.avg_tokens * 0.4); // assume 40% reducible
    const label = r.mcp_server
      ? `[${r.mcp_server}] ${r.tool_name}`
      : r.tool_name;
    suggestions.push({
      kind: 'large_response',
      tool_name: r.tool_name,
      mcp_server: r.mcp_server,
      evidence: `${label} returns ~${r.avg_tokens.toLocaleString()} tokens/call on average (${r.calls} calls in ${days}d window; max ${r.max_tokens.toLocaleString()}).`,
      savings_tokens_per_week: savingsTok,
      savings_usd_per_week: savingsTok * usdPerToken,
      action_text: `Configure \`fields\` or \`limit\` on ${label} to reduce response size (est. ${savingsTok.toLocaleString()} tokens/week saved).`,
    });
  }

  // ── 2a. REPEATED_BINARY — real extension match ───────────────────────────
  // tool_events.file_ext (captured at parse time from the tool_use call's
  // file_path/path/notebook_path argument) lets us match actual binary/asset
  // extensions instead of guessing from the tool name. Grouped by
  // (tool_name, mcp_server) only — NOT per file_ext — and the matched
  // extensions concatenated: a tool that reads several binary extensions
  // (e.g. both .png and .jpg) previously surfaced as one near-duplicate
  // suggestion PER extension, crowding the final slice(0, 5) with variants
  // of the same finding instead of leaving room for other distinct ones.
  const extPlaceholders = BINARY_EXTENSIONS.map(() => '?').join(', ');
  const binaryExtRows = db
    .prepare(
      `SELECT tool_name, mcp_server,
              GROUP_CONCAT(DISTINCT file_ext) AS extensions,
              COUNT(*) AS calls,
              CAST(AVG(response_tokens_est) AS INTEGER) AS avg_tokens
       FROM tool_events
       WHERE ts >= ? AND file_ext IN (${extPlaceholders})
       GROUP BY tool_name, mcp_server
       HAVING COUNT(*) >= ?`,
    )
    .all(since, ...BINARY_EXTENSIONS, HIGH_FREQ_READ_THRESHOLD) as {
    tool_name: string;
    mcp_server: string | null;
    extensions: string;
    calls: number;
    avg_tokens: number;
  }[];

  for (const r of binaryExtRows) {
    const extList = r.extensions.split(',').sort();
    const combinedNote = extList.length > 1 ? ' combined' : '';
    const extLabel = extList.map((e) => `.${e}`).join(', ');
    const globPattern = extList.length === 1 ? `**/*.${extList[0]}` : `**/*.{${extList.join(',')}}`;
    const callsPerWeek = (r.calls / days) * 7;
    const savingsTok = Math.round(callsPerWeek * r.avg_tokens * 0.5);
    const label = r.mcp_server ? `[${r.mcp_server}] ${r.tool_name}` : r.tool_name;
    suggestions.push({
      kind: 'repeated_binary',
      tool_name: r.tool_name,
      mcp_server: r.mcp_server,
      evidence: `${label} read ${extLabel} files ${r.calls} times${combinedNote} in ${days}d (avg ${r.avg_tokens.toLocaleString()} tokens/call). Binary/asset files rarely need to be read as text — consider an exclude pattern.`,
      savings_tokens_per_week: savingsTok,
      savings_usd_per_week: savingsTok * usdPerToken,
      action_text: `Add an exclude glob pattern like \`${globPattern}\` to ${label} in your Claude Code settings to avoid reading ${extLabel} files.`,
    });
  }

  // ── 2b. REPEATED_BINARY fallback — HIGH_FREQ_READ ────────────────────────
  // Calls with no captured file_ext (older rows ingested before that column
  // existed, or tool_use calls with no path-like argument) fall back to the
  // pre-existing heuristic: flag read-named tools called very often, since
  // they might still be reading large/binary assets we can't confirm.
  const highFreqReadRows = db
    .prepare(
      `SELECT tool_name, mcp_server,
              COUNT(*) AS calls,
              CAST(AVG(response_tokens_est) AS INTEGER) AS avg_tokens
       FROM tool_events
       WHERE ts >= ?
         AND file_ext IS NULL
         AND (tool_name = 'Read' OR tool_name = 'read_file'
              OR tool_name LIKE '%read%')
       GROUP BY tool_name, mcp_server
       HAVING COUNT(*) >= ?`,
    )
    .all(since, HIGH_FREQ_READ_THRESHOLD) as {
    tool_name: string;
    mcp_server: string | null;
    calls: number;
    avg_tokens: number;
  }[];

  for (const r of highFreqReadRows) {
    const callsPerWeek = (r.calls / days) * 7;
    const savingsTok = Math.round(callsPerWeek * r.avg_tokens * 0.5);
    suggestions.push({
      kind: 'repeated_binary',
      tool_name: r.tool_name,
      mcp_server: r.mcp_server,
      evidence: `${r.tool_name} called ${r.calls} times in ${days}d (avg ${r.avg_tokens.toLocaleString()} tokens/call). High-frequency reads may include large or binary files — consider an exclude pattern.`,
      savings_tokens_per_week: savingsTok,
      savings_usd_per_week: savingsTok * usdPerToken,
      action_text: `Add an exclude glob pattern like \`**/*.{png,jpg,svg,pdf}\` to ${r.tool_name} in your Claude Code settings to avoid reading binary or large asset files.`,
    });
  }

  // ── 3. HIGH_LATENCY ──────────────────────────────────────────────────────
  const latencyRows = db
    .prepare(
      `SELECT tool_name, mcp_server,
              COUNT(*) AS calls,
              CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms,
              CAST(AVG(response_tokens_est) AS INTEGER) AS avg_tokens
       FROM tool_events
       WHERE ts >= ? AND latency_ms IS NOT NULL
       GROUP BY tool_name, mcp_server
       HAVING COUNT(*) >= 5 AND AVG(latency_ms) >= 3000
       ORDER BY avg_latency_ms DESC
       LIMIT 5`,
    )
    .all(since) as {
    tool_name: string;
    mcp_server: string | null;
    calls: number;
    avg_latency_ms: number;
    avg_tokens: number;
  }[];

  for (const r of latencyRows) {
    const callsPerWeek = (r.calls / days) * 7;
    // Latency itself doesn't save tokens directly, but removing unused slow
    // calls saves context. Estimate 20% token reduction if calls are pruned.
    const savingsTok = Math.round(callsPerWeek * r.avg_tokens * 0.2);
    const label = r.mcp_server
      ? `[${r.mcp_server}] ${r.tool_name}`
      : r.tool_name;
    suggestions.push({
      kind: 'high_latency',
      tool_name: r.tool_name,
      mcp_server: r.mcp_server,
      evidence: `${label} averages ${r.avg_latency_ms.toLocaleString()}ms per call (${r.calls} calls in ${days}d). High latency increases session wall-clock time and may block faster alternatives.`,
      savings_tokens_per_week: savingsTok,
      savings_usd_per_week: savingsTok * usdPerToken,
      action_text: `Investigate whether ${label} output is used downstream; if not, remove the call or cache the result to avoid the ${r.avg_latency_ms.toLocaleString()}ms penalty per call.`,
    });
  }

  // Rank by savings_tokens_per_week descending, top 5.
  return suggestions
    .sort((a, b) => b.savings_tokens_per_week - a.savings_tokens_per_week)
    .slice(0, 5);
}
