import type Database from 'better-sqlite3';
import { modelRates } from './pricing.js';

export interface OverviewRow {
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  total_usd: number;
  events: number;
  first_ts: number | null;
  last_ts: number | null;
}

export interface DailyRow {
  day: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  events: number;
}

export interface DailyByModelEntry {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  events: number;
}

export interface DailyByModelRow {
  day: string;
  models: DailyByModelEntry[];
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  events: number;
}

export interface ModelRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  usd: number;
  events: number;
}

export interface ProjectRow {
  project: string;
  usd: number;
  events: number;
  total_tokens: number;
}

export interface McpRow {
  mcp_server: string | null;
  tool_name: string;
  calls: number;
  total_response_tokens: number;
  avg_latency_ms: number;
}

export interface HourlyRow {
  hour: number;
  events: number;
  usd: number;
  output_tokens: number;
}

export interface CacheStatsRow {
  total_input: number;
  total_cache_read: number;
  total_cache_write: number;
  hit_ratio: number;
  savings_usd: number;
  write_cost_usd: number;
  net_usd: number;
}

export interface ToolOutlierRow {
  tool_name: string;
  mcp_server: string | null;
  calls: number;
  avg_tokens: number;
  max_tokens: number;
}

export interface CacheWasteDayRow {
  day: string;
  cache_read: number;
  cache_write: number;
}

export interface WasteSignals {
  tool_outliers: ToolOutlierRow[];
  cache_waste_days: CacheWasteDayRow[];
}

/**
 * Narrow which token_events / tool_events rows a query considers. `source`
 * picks Claude Code vs Codex; `platform` discriminates WSL/Linux project
 * paths ('/…') from Windows drive paths ('C:\…'). Both fields are optional —
 * leaving them unset (or passing `'all'`) keeps the original behavior so the
 * filter is backward-compatible.
 */
export type ScopeFilter = 'all' | { source?: 'claude-code' | 'codex'; platform?: 'linux' | 'win' };

interface CompiledScope {
  clause: string;
  params: unknown[];
}

export function scopeClause(scope?: ScopeFilter): CompiledScope {
  if (!scope || scope === 'all') return { clause: '', params: [] };
  const conds: string[] = [];
  const params: unknown[] = [];
  if (scope.source) {
    conds.push('source = ?');
    params.push(scope.source);
  }
  if (scope.platform === 'linux') {
    // POSIX/WSL paths start at '/'.
    conds.push("project LIKE '/%'");
  } else if (scope.platform === 'win') {
    // Windows drive paths like 'C:\…' — GLOB '[A-Za-z]:*' matches that without
    // pulling in the noisy LIKE escaping rules.
    conds.push("project GLOB '[A-Za-z]:*'");
  }
  return { clause: conds.length ? ' AND ' + conds.join(' AND ') : '', params };
}

function dayWindow(days: number): number {
  return Date.now() - days * 86_400_000;
}

// Upper bound paired with dayWindow()'s `since` on every N-day-window query
// below. Without it, a row with a future/corrupt timestamp (bad clock, bad
// JSONL) satisfies `ts >= since` in every window forever and never ages out
// of any view. forecast.ts already bounds its own query this way (`ts <
// Math.min(asOf + 1, monthEnd)`); this mirrors that pattern for stats.ts.
function nowBound(): number {
  return Date.now();
}

export function overview(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): OverviewRow {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        COALESCE(SUM(input_tokens), 0)        AS total_input,
        COALESCE(SUM(output_tokens), 0)       AS total_output,
        COALESCE(SUM(cache_read_tokens), 0)   AS total_cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS total_cache_write,
        COALESCE(SUM(usd_estimate), 0)        AS total_usd,
        COUNT(*)                              AS events,
        MIN(ts)                               AS first_ts,
        MAX(ts)                               AS last_ts
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}`,
    )
    .get(since, until, ...sc.params) as OverviewRow;
}

export function daily(db: Database.Database, days: number, scope?: ScopeFilter): DailyRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(output_tokens), 0)       AS output,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write,
        COALESCE(SUM(usd_estimate), 0)        AS usd,
        COUNT(*)                              AS events
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(since, until, ...sc.params) as DailyRow[];
}

/**
 * Daily breakdown with per-day model labels. The CLI/MCP table view renders
 * one row per `day`, with the `models` array listed in the Models column
 * (ccusage-style). Sums on each row are across all models active that day.
 */
export function dailyByModel(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): DailyByModelRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  const rows = db
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
        model,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(output_tokens), 0)       AS output,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write,
        COALESCE(SUM(usd_estimate), 0)        AS usd,
        COUNT(*)                              AS events
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY day, model
       ORDER BY day ASC, usd DESC`,
    )
    .all(since, until, ...sc.params) as Array<{
      day: string;
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      usd: number;
      events: number;
    }>;
  const byDay = new Map<string, DailyByModelRow>();
  for (const r of rows) {
    let d = byDay.get(r.day);
    if (!d) {
      d = {
        day: r.day,
        models: [],
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        usd: 0,
        events: 0,
      };
      byDay.set(r.day, d);
    }
    d.models.push({
      model: r.model,
      input: r.input,
      output: r.output,
      cache_read: r.cache_read,
      cache_write: r.cache_write,
      usd: r.usd,
      events: r.events,
    });
    d.input += r.input;
    d.output += r.output;
    d.cache_read += r.cache_read;
    d.cache_write += r.cache_write;
    d.usd += r.usd;
    d.events += r.events;
  }
  return Array.from(byDay.values());
}

export function byModel(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): ModelRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        model,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(output_tokens), 0)       AS output,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write,
        COALESCE(SUM(usd_estimate), 0)        AS usd,
        COUNT(*)                              AS events
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY model
       ORDER BY usd DESC`,
    )
    .all(since, until, ...sc.params) as ModelRow[];
}

export function byProject(
  db: Database.Database,
  days: number,
  limit = 20,
  scope?: ScopeFilter,
): ProjectRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        project,
        COALESCE(SUM(usd_estimate), 0)                                 AS usd,
        COUNT(*)                                                       AS events,
        COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY project
       ORDER BY usd DESC
       LIMIT ?`,
    )
    .all(since, until, ...sc.params, limit) as ProjectRow[];
}

export function byMcp(
  db: Database.Database,
  days: number,
  limit = 30,
  scope?: ScopeFilter,
): McpRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        mcp_server,
        tool_name,
        COUNT(*)                                AS calls,
        COALESCE(SUM(response_tokens_est), 0)   AS total_response_tokens,
        COALESCE(AVG(latency_ms), 0)            AS avg_latency_ms
       FROM tool_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY mcp_server, tool_name
       ORDER BY total_response_tokens DESC
       LIMIT ?`,
    )
    .all(since, until, ...sc.params, limit) as McpRow[];
}

export function byHour(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): HourlyRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        CAST(strftime('%H', ts/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
        COUNT(*)                          AS events,
        COALESCE(SUM(usd_estimate), 0)    AS usd,
        COALESCE(SUM(output_tokens), 0)   AS output_tokens
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY hour
       ORDER BY hour ASC`,
    )
    .all(since, until, ...sc.params) as HourlyRow[];
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Cache efficiency over the window. LLM-free — pure aggregation + the pricing
 * table. Grouped by model so per-model rates apply.
 */
export function cacheStats(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): CacheStatsRow {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  const rows = db
    .prepare(
      `SELECT
        model,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY model`,
    )
    .all(since, until, ...sc.params) as Array<{
      model: string;
      input: number;
      cache_read: number;
      cache_write: number;
    }>;
  let total_input = 0;
  let total_cache_read = 0;
  let total_cache_write = 0;
  let savings_usd = 0;
  let write_cost_usd = 0;
  for (const r of rows) {
    const p = modelRates(r.model);
    total_input += r.input;
    total_cache_read += r.cache_read;
    total_cache_write += r.cache_write;
    savings_usd += (r.cache_read * (p.input - p.cacheRead)) / 1_000_000;
    write_cost_usd += (r.cache_write * p.cacheWrite5m) / 1_000_000;
  }
  const readSide = total_input + total_cache_read;
  return {
    total_input,
    total_cache_read,
    total_cache_write,
    hit_ratio: readSide > 0 ? total_cache_read / readSide : 0,
    savings_usd: round6(savings_usd),
    write_cost_usd: round6(write_cost_usd),
    net_usd: round6(savings_usd - write_cost_usd),
  };
}

/**
 * Heuristic waste signals — things worth a look, not verdicts. LLM-free.
 *  - tool_outliers: tools (≥3 calls) whose largest response dwarfs their
 *    average (max > 5× avg and > 10k tokens) — oversized context dumps.
 *  - cache_waste_days: days that wrote more cache than they read back —
 *    cache that did not pay off.
 */
export function wasteSignals(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): WasteSignals {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  const toolRows = db
    .prepare(
      `SELECT
        tool_name,
        mcp_server,
        COUNT(*)                                               AS calls,
        CAST(COALESCE(AVG(response_tokens_est), 0) AS INTEGER)  AS avg_tokens,
        COALESCE(MAX(response_tokens_est), 0)                   AS max_tokens
       FROM tool_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY mcp_server, tool_name
       HAVING COUNT(*) >= 3`,
    )
    .all(since, until, ...sc.params) as ToolOutlierRow[];
  const tool_outliers = toolRows
    .filter((r) => r.max_tokens > 10_000 && r.max_tokens > 5 * r.avg_tokens)
    .sort((a, b) => b.max_tokens - a.max_tokens)
    .slice(0, 8);
  const cache_waste_days = db
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') AS day,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY day
       HAVING SUM(cache_write_tokens) > SUM(cache_read_tokens)
          AND SUM(cache_write_tokens) > 0
       ORDER BY day ASC`,
    )
    .all(since, until, ...sc.params) as CacheWasteDayRow[];
  return { tool_outliers, cache_waste_days };
}

export interface SubagentBucket {
  bucket: 'main' | 'subagent';
  usd: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  events: number;
}

export interface SubagentRow {
  agent_id: string;
  // Human label from the sub-agent's sibling meta.json (agentType), e.g.
  // "general-purpose" or "workflow-subagent". null when no meta.json was
  // found at ingest — callers fall back to displaying agent_id.
  agent_type: string | null;
  models: string; // comma-separated distinct models, e.g. "haiku-4-5,sonnet-4-6"
  usd: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  events: number;
  first_ts: number | null;
  last_ts: number | null;
}

export interface SubagentInvocationRow {
  tool_name: string; // 'Task' | 'Agent'
  calls: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  total_response_tokens: number;
}

export interface SubagentCosts {
  split: { main: SubagentBucket; subagent: SubagentBucket };
  subagent_share_pct: number; // sub-agent USD as a % of total USD in the window
  top: SubagentRow[];
  invocations: SubagentInvocationRow[];
}

/**
 * Sub-agent cost attribution. Splits token spend into main-session vs
 * sub-agent (Task/Agent) work, lists the priciest sub-agents, and pairs them
 * with the parent-side invocation latency from tool_events. LLM-free — pure
 * aggregation over the agent_id column stamped at ingest.
 *
 * Requires `ingest --force` once after upgrading so historical sub-agent rows
 * get their agent_id backfilled; rows ingested before v0.1.19 read as 'main'
 * until then.
 */
export function subagentCosts(
  db: Database.Database,
  days: number,
  limit = 10,
  scope?: ScopeFilter,
): SubagentCosts {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  const bucketRows = db
    .prepare(
      `SELECT
        CASE WHEN agent_id IS NULL THEN 'main' ELSE 'subagent' END AS bucket,
        COALESCE(SUM(usd_estimate), 0)        AS usd,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(output_tokens), 0)       AS output,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write,
        COUNT(*)                              AS events
       FROM token_events
       WHERE ts >= ? AND ts <= ?${sc.clause}
       GROUP BY bucket`,
    )
    .all(since, until, ...sc.params) as Array<SubagentBucket>;
  const empty = (bucket: 'main' | 'subagent'): SubagentBucket => ({
    bucket,
    usd: 0,
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    events: 0,
  });
  const split = {
    main: bucketRows.find((r) => r.bucket === 'main') ?? empty('main'),
    subagent: bucketRows.find((r) => r.bucket === 'subagent') ?? empty('subagent'),
  };
  const totalUsd = split.main.usd + split.subagent.usd;
  const subagent_share_pct = totalUsd > 0 ? (split.subagent.usd / totalUsd) * 100 : 0;

  const top = db
    .prepare(
      `SELECT
        token_events.agent_id                 AS agent_id,
        agent_meta.agent_type                 AS agent_type,
        GROUP_CONCAT(DISTINCT model)          AS models,
        COALESCE(SUM(usd_estimate), 0)        AS usd,
        COALESCE(SUM(input_tokens), 0)        AS input,
        COALESCE(SUM(output_tokens), 0)       AS output,
        COALESCE(SUM(cache_read_tokens), 0)   AS cache_read,
        COALESCE(SUM(cache_write_tokens), 0)  AS cache_write,
        COUNT(*)                              AS events,
        MIN(ts)                               AS first_ts,
        MAX(ts)                               AS last_ts
       FROM token_events
       LEFT JOIN agent_meta ON agent_meta.agent_id = token_events.agent_id
       WHERE ts >= ? AND ts <= ? AND token_events.agent_id IS NOT NULL${sc.clause}
       GROUP BY token_events.agent_id
       ORDER BY usd DESC
       LIMIT ?`,
    )
    .all(since, until, ...sc.params, limit) as SubagentRow[];

  // Parent-side invocation cost: the Task/Agent tool calls that *spawned* the
  // sub-agents. Latency here is wall-clock the sub-agent took; the token cost
  // above is what it burned. Together they answer "are my sub-agents worth it".
  const invocations = db
    .prepare(
      `SELECT
        tool_name,
        COUNT(*)                                AS calls,
        COALESCE(AVG(latency_ms), 0)            AS avg_latency_ms,
        COALESCE(MAX(latency_ms), 0)            AS max_latency_ms,
        COALESCE(SUM(response_tokens_est), 0)   AS total_response_tokens
       FROM tool_events
       WHERE ts >= ? AND ts <= ? AND tool_name IN ('Task', 'Agent')${sc.clause}
       GROUP BY tool_name
       ORDER BY calls DESC`,
    )
    .all(since, until, ...sc.params) as SubagentInvocationRow[];

  return { split, subagent_share_pct, top, invocations };
}

export interface LocalPerfRow {
  source: string;
  model: string;
  calls: number;
  avg_tps: number | null;
  avg_ttft_ms: number | null;
  output: number;
  input: number;
}

/**
 * Performance of locally-run models captured by the proxy (source_kind =
 * 'local'). Cloud rows have no TTFT/TPS, so this view is local-only. LLM-free.
 */
export function localPerf(
  db: Database.Database,
  days: number,
  scope?: ScopeFilter,
): LocalPerfRow[] {
  const since = dayWindow(days);
  const until = nowBound();
  const sc = scopeClause(scope);
  return db
    .prepare(
      `SELECT
        source,
        model,
        COUNT(*)                       AS calls,
        AVG(tps)                       AS avg_tps,
        AVG(ttft_ms)                   AS avg_ttft_ms,
        COALESCE(SUM(output_tokens), 0) AS output,
        COALESCE(SUM(input_tokens), 0)  AS input
       FROM token_events
       WHERE ts >= ? AND ts <= ? AND source_kind = 'local'${sc.clause}
       GROUP BY source, model
       ORDER BY calls DESC`,
    )
    .all(since, until, ...sc.params) as LocalPerfRow[];
}
