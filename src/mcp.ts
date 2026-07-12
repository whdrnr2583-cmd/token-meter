import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { countTokenEvents, migrate, openDb } from './db.js';
import { ingestAll, ensureFirstRunData } from './ingest.js';
import {
  byMcp,
  byModel,
  byProject,
  dailyByModel,
  overview,
  subagentCosts,
  type DailyByModelRow,
  type ScopeFilter,
} from './stats.js';
import { recentSessions, sessionToolSummary } from './sessions.js';

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function ageStr(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${minutes - h * 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h - d * 24}h ago`;
}

/**
 * The package's version, read from package.json — keeps the MCP server's
 * advertised version in sync with the real release instead of hardcoding.
 */
function serverVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Window length in days for a usage period. `today` is the current *local
 * calendar day* (local midnight → now), returned as a fractional day count so
 * the day-window helper in stats.ts resolves to local midnight — this matches
 * the per-day rows in the CLI breakdown. `week` / `month` stay rolling 7 / 30.
 */
export function periodWindowDays(p: 'today' | 'week' | 'month'): number {
  if (p !== 'today') return p === 'week' ? 7 : 30;
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return (Date.now() - midnight) / 86_400_000;
}

export type ScopeInput =
  | 'auto'
  | 'all'
  | 'wsl'
  | 'linux'
  | 'win'
  | 'windows'
  | 'codex'
  | 'claude-code'
  | 'claude'
  | undefined;

/**
 * Resolve the scope filter for the current invocation. Default 'auto' detects
 * via process.platform: linux→WSL/Linux project paths, win32→Windows drive
 * paths. Codex/Claude-Code separation is opt-in via TOKEN_METER_SCOPE.
 *
 * Returns `{ scope, label }` where `scope` is passed to stats.ts queries and
 * `label` is a one-line banner shown in the output so the user knows what
 * subset they're looking at.
 */
export function resolveScope(input?: ScopeInput): { scope: ScopeFilter; label: string } {
  const raw = (input ?? (process.env.TOKEN_METER_SCOPE as ScopeInput) ?? 'auto')
    .toString()
    .toLowerCase();
  if (raw === 'all') return { scope: 'all', label: 'all sources' };
  if (raw === 'wsl' || raw === 'linux')
    return { scope: { platform: 'linux' }, label: 'WSL / Linux' };
  if (raw === 'win' || raw === 'windows')
    return { scope: { platform: 'win' }, label: 'Windows' };
  if (raw === 'codex') return { scope: { source: 'codex' }, label: 'Codex' };
  if (raw === 'claude-code' || raw === 'claude')
    return { scope: { source: 'claude-code' }, label: 'Claude Code (all platforms)' };
  // 'auto' or unknown → infer from current process.platform.
  if (process.platform === 'linux')
    return { scope: { platform: 'linux' }, label: 'auto: WSL / Linux' };
  if (process.platform === 'win32')
    return { scope: { platform: 'win' }, label: 'auto: Windows' };
  return { scope: 'all', label: 'auto: all (unknown platform)' };
}

function padR(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}
function padL(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s;
}

/**
 * Static discovery / trust footer reused across every tool reply. All
 * hard-coded plain text — no LLM call, no per-request rendering work — so
 * the cost of telling users about sibling tools and the site / GitHub URL
 * is exactly zero tokens of inference.
 */
const FOOTER_LINKS = '🔗 token-meter.dev · github.com/whdrnr2583-cmd/token-meter';
const FOOTER_TRUST =
  'ⓘ 100% local · 0 LLM calls — this output is hard-coded, your tokens are not spent computing it.';
const OSS_POINTER = 'open source · npm install -g @whdrnr2583/token-meter';

/** Build a 3-line discovery + trust footer. Split intentionally so each line
 *  fits a typical ~80-char terminal without wrapping. `siblingHint`
 *  cross-promotes the next tool to try. */
function discoveryFooter(siblingHint: string): string[] {
  return [FOOTER_TRUST, siblingHint, `${FOOTER_LINKS} · ${OSS_POINTER}`];
}

/**
 * Tools whose latency is dominated by a human keystroke, not by the model or
 * the tool runtime. Including them in "Slowest" gave a false signal (e.g.
 * `AskUserQuestion 178s avg` always wins). They are still surfaced in the
 * output under a separate user-blocking line so the information isn't hidden.
 */
const USER_BLOCKING_TOOLS = new Set(['AskUserQuestion']);

/**
 * ccusage-style table with **one row per (day, model)** so Haiku, Opus, and
 * Sonnet on the same day are accounted independently — combining them into a
 * single per-day row hides the cost split (e.g. 99% Opus / 1% Haiku looks the
 * same as a 50/50 split). Day cell repeats on continuation rows so the table
 * grep/diff cleanly.
 */
export function renderDailyTable(rows: DailyByModelRow[]): string[] {
  if (rows.length === 0) return ['(no events in this window)'];
  const colDay = 10;
  const colModel = 18;
  const colCalls = 6;
  const colNum = 8;
  const colUsd = 9;
  const colPct = 5;
  const totalWidth =
    colDay + 1 + colModel + 1 + colCalls + 1 + colNum + 1 + colNum + 1 + colNum + 1 + colUsd + 1 + colPct;
  const sepLight = '─'.repeat(totalWidth);
  const sepHeavy = '═'.repeat(totalWidth);
  // Subordinate divider between day groups. ` · ` half-density keeps it
  // visually lighter than the boundary ─ lines (Tufte data-ink ratio).
  const dayDivider = '· '.repeat(Math.floor(totalWidth / 2));
  const headerRow = [
    padR('Day', colDay),
    padR('Model', colModel),
    padL('Calls', colCalls),
    padL('Input', colNum),
    padL('Output', colNum),
    padL('Cache_rd', colNum),
    padL('USD', colUsd),
    padL('%day', colPct),
  ].join(' ');
  const out: string[] = [sepLight, headerRow, sepLight];
  let totalUsd = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCr = 0;
  let totalCalls = 0;
  const allModels = new Set<string>();
  let firstDay = true;
  for (const r of rows) {
    if (!firstDay) out.push(dayDivider);
    firstDay = false;
    const dayUsd = r.usd || 1; // guard against divide-by-zero
    for (const m of r.models) {
      allModels.add(m.model);
      const modelLabel = m.model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      // Show `<1%` for non-zero but rounds-to-zero shares (e.g. Haiku at
      // 0.28% of a $425 Opus-heavy day) so users can tell "tiny but present"
      // apart from "literally zero".
      const sharePct = (m.usd / dayUsd) * 100;
      const dayShare = m.usd > 0 && sharePct < 0.5 ? '<1%' : `${Math.round(sharePct)}%`;
      out.push(
        [
          padR(r.day, colDay),
          padR(modelLabel, colModel),
          padL(m.events.toLocaleString('en-US'), colCalls),
          padL(fmtTok(m.input), colNum),
          padL(fmtTok(m.output), colNum),
          padL(fmtTok(m.cache_read), colNum),
          padL(`$${m.usd.toFixed(2)}`, colUsd),
          padL(dayShare, colPct),
        ].join(' '),
      );
      totalUsd += m.usd;
      totalIn += m.input;
      totalOut += m.output;
      totalCr += m.cache_read;
      totalCalls += m.events;
    }
  }
  // Heavy separator + blank line make the Total row visually distinct from the
  // data rows above without ANSI codes (MCP clients vary in color support).
  out.push('');
  out.push(sepHeavy);
  out.push(
    [
      padR('Total', colDay),
      padR(
        `${allModels.size} model${allModels.size === 1 ? '' : 's'} · ${rows.length} day${rows.length === 1 ? '' : 's'}`,
        colModel,
      ),
      padL(totalCalls.toLocaleString('en-US'), colCalls),
      padL(fmtTok(totalIn), colNum),
      padL(fmtTok(totalOut), colNum),
      padL(fmtTok(totalCr), colNum),
      padL(`$${totalUsd.toFixed(2)}`, colUsd),
      padL('100%', colPct),
    ].join(' '),
  );
  out.push(sepHeavy);
  return out;
}

export async function startMcpServer(): Promise<void> {
  const db = openDb();
  migrate(db);
  let firstRunGuidance = '';
  try {
    ingestAll(db);
    firstRunGuidance = ensureFirstRunData(db).guidance;
  } catch {
    /* non-fatal */
  }
  const server = new McpServer(
    { name: 'token-meter', version: serverVersion() },
    {
      // Surfaced at the MCP connect handshake. All tool outputs are also
      // hard-coded text — no LLM call is made by this server to compute them
      // — so introducing the surface this way costs no inference tokens at
      // call time. Mentioning it in the connect instructions means even a
      // user who never calls a tool gets the discovery info.
      instructions:
        'Token Meter shows where your Claude Code + Codex tokens and money ' +
        'go — parsed from local JSONL logs, 100% offline. 0 LLM calls used ' +
        'to compute any output (everything is hard-coded SQL + plain text).\n\n' +
        'Tools:\n' +
        '  • usage_summary  — daily table by (day × model) with $/tokens/calls, scoped to current platform (WSL/Windows/Codex auto-detect)\n' +
        '  • recent_sessions — sessions with paste-ready `claude --resume` / `codex resume` commands\n' +
        '  • session_tools  — per-session tool breakdown to find slow / heavy / unexpected tools\n' +
        '  • subagent_costs — main vs sub-agent (Task/Agent) spend split, priciest sub-agents, invocation latency\n' +
        '  • refresh_data   — re-scan local logs for new activity\n\n' +
        'Other surfaces (same package):\n' +
        '  • `npx @whdrnr2583/token-meter stats [days]`     — terminal stats\n' +
        '  • `npx @whdrnr2583/token-meter serve`            — local dashboard at http://localhost:8765\n' +
        '  • `npx @whdrnr2583/token-meter install-mcp <client>` — wire MCP into another tool\n\n' +
        'Links: token-meter.dev · github.com/whdrnr2583-cmd/token-meter\n' +
        'Open source — install the CLI with: npm install -g @whdrnr2583/token-meter',
    },
  );

  server.registerTool(
    'usage_summary',
    {
      title: 'usage summary (Token Meter)',
      description:
        'What you spent, where it went, and what was slow — Claude Code + Codex. API-equivalent estimate, local data only. Table by day × models (ccusage-style) + advisory narrative. scope defaults to "auto" (filter to current platform); pass "all" to see everything. insights=true adds heuristic tips.',
      inputSchema: {
        period: z.enum(['today', 'week', 'month']).default('today'),
        scope: z
          .enum([
            'auto',
            'all',
            'wsl',
            'linux',
            'win',
            'windows',
            'codex',
            'claude-code',
          ])
          .default('auto')
          .describe(
            'which source to include — "auto" filters by current process.platform (recommended); "all" disables the filter',
          ),
        insights: z.boolean().default(false),
      },
      annotations: {
        title: 'usage summary (Token Meter)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ period, scope, insights }) => {
      if (countTokenEvents(db) === 0) {
        const guide =
          firstRunGuidance ||
          'No Claude Code or Codex usage found yet. Use Claude Code or Codex, ' +
            'then run `token-meter ingest` (or the refresh_data tool).';
        return {
          content: [
            {
              type: 'text',
              text: [
                `Token Meter has no usage data yet.`,
                guide,
                '',
                ...discoveryFooter('🔧 After first usage: refresh_data → usage_summary'),
              ].join('\n'),
            },
          ],
        };
      }
      const { scope: scopeFilter, label: scopeLabel } = resolveScope(scope as ScopeInput);
      const days = periodWindowDays(period);
      const o = overview(db, days, scopeFilter);
      const oAll = overview(db, days);
      const models = byModel(db, days, scopeFilter);
      const projects = byProject(db, days, 1, scopeFilter);
      const tools = byMcp(db, days, 100, scopeFilter);
      const dailies = dailyByModel(db, days, scopeFilter);
      const periodLabel = period === 'today' ? 'today' : period === 'week' ? 'last 7d' : 'last 30d';
      const totalTok =
        o.total_input + o.total_output + o.total_cache_read + o.total_cache_write;
      const cacheShare = totalTok > 0 ? Math.round((o.total_cache_read / totalTok) * 100) : 0;
      const topModel = models[0];
      const modelStr = topModel
        ? `${topModel.model} ${Math.round((topModel.usd / (o.total_usd || 1)) * 100)}%`
        : '—';
      const topProject = projects[0]
        ? (projects[0].project.split(/[\\/]/).filter(Boolean).pop() ?? projects[0].project)
        : '—';
      const callableTools = tools.filter((t) => !USER_BLOCKING_TOOLS.has(t.tool_name));
      const slow = [...callableTools]
        .filter((t) => t.calls >= 3)
        .sort((a, b) => b.avg_latency_ms - a.avg_latency_ms)[0];
      // Track user-blocking tools separately so the user still sees them but
      // they don't dominate the "Slowest" headline with human-reaction-time.
      const userBlocking = tools
        .filter((t) => USER_BLOCKING_TOOLS.has(t.tool_name) && t.calls >= 3)
        .sort((a, b) => b.avg_latency_ms - a.avg_latency_ms)[0];
      const heavy = tools.slice(0, 3);
      // Break down the "hidden by scope" amount across the other scopes so the
      // reader knows *what* was excluded (Windows vs Codex), not just *how
      // much*. Only computed when a scope filter is active and there's
      // something to hide; queries are cheap and run once per call.
      let scopeNote = '';
      if (scopeFilter !== 'all' && oAll.events > o.events) {
        const breakdownParts: string[] = [];
        const seen = scopeFilter as { source?: string; platform?: string };
        // Complementary platform — only show if current scope is platform-based.
        if (seen.platform === 'linux') {
          const w = overview(db, days, { platform: 'win' });
          if (w.total_usd > 0) breakdownParts.push(`Windows ${fmtUsd(w.total_usd)}`);
        } else if (seen.platform === 'win') {
          const l = overview(db, days, { platform: 'linux' });
          if (l.total_usd > 0) breakdownParts.push(`WSL/Linux ${fmtUsd(l.total_usd)}`);
        }
        // Codex slice (always interesting if non-empty and not the current scope).
        if (seen.source !== 'codex') {
          const c = overview(db, days, { source: 'codex' });
          if (c.total_usd > 0) breakdownParts.push(`Codex ${fmtUsd(c.total_usd)}`);
        }
        const tailHint = breakdownParts.length
          ? `hidden: ${breakdownParts.join(' · ')}`
          : `${fmtUsd(oAll.total_usd - o.total_usd)} hidden`;
        scopeNote = ` · ${tailHint} (use scope="all" to include)`;
      }
      const lines: string[] = [
        `Token Meter · ${periodLabel} · scope: ${scopeLabel}`,
      ];
      // scope hint goes on its own line — when it gets long (multi-source
      // breakdown), folding it under the title keeps the header scannable.
      if (scopeNote) lines.push(scopeNote.replace(/^\s·\s/, ''));
      lines.push('');
      lines.push(...renderDailyTable(dailies));
      lines.push('');
      lines.push(
        `Summary: ${fmtUsd(o.total_usd)} · ${fmtTok(totalTok)} tokens (${cacheShare}% cache reuse) · ${o.events.toLocaleString()} API calls`,
      );
      lines.push('');
      lines.push('— Spotlight (advisory) —');
      lines.push(`Where    : ${modelStr} · project ${topProject}`);
      lines.push(
        slow
          ? `Slowest  : ${slow.mcp_server ? slow.mcp_server + '/' : ''}${slow.tool_name} ${(slow.avg_latency_ms / 1000).toFixed(1)}s avg (${slow.calls}x)`
          : 'Slowest  : — (no tool calls in window)',
      );
      if (userBlocking) {
        lines.push(
          `User wait: ${userBlocking.tool_name} ${(userBlocking.avg_latency_ms / 1000).toFixed(1)}s avg (${userBlocking.calls}x) — waiting on you, not the tool`,
        );
      }
      if (heavy.length > 0) {
        lines.push(
          `Heaviest : ${heavy.map((t) => `${t.tool_name} ${fmtTok(t.total_response_tokens)}`).join(' · ')} (response tokens, est.)`,
        );
      }
      if (insights) {
        const tips: string[] = [];
        if (period === 'today') {
          const wk = overview(db, 7, scopeFilter);
          const dailyAvg = wk.total_usd / 7;
          if (dailyAvg > 0) {
            const r = o.total_usd / dailyAvg;
            tips.push(
              `today ${fmtUsd(o.total_usd)} vs 7-day daily avg ${fmtUsd(dailyAvg)} — ${r >= 1.3 ? 'a heavy day' : r <= 0.7 ? 'a light day' : 'about typical'}`,
            );
          }
        }
        if (slow && slow.avg_latency_ms > 10_000) {
          tips.push(
            `${slow.tool_name} averages ${Math.round(slow.avg_latency_ms / 1000)}s — your latency sink; scope or batch these calls`,
          );
        }
        if (cacheShare >= 80) {
          tips.push(
            `cache reuse is ${cacheShare}% of tokens — heavy context replay; on a flat-fee plan this is not billed per token`,
          );
        }
        if (tips.length > 0) {
          lines.push('');
          lines.push('Insights:');
          for (const t of tips) lines.push(`• ${t}`);
        }
      }
      lines.push('');
      lines.push(
        ...discoveryFooter(
          '🔧 Other tools: recent_sessions · session_tools <id> · refresh_data · serve (local dashboard)',
        ),
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'recent_sessions',
    {
      title: 'recent sessions (Token Meter)',
      description:
        'List recently-active Claude Code / Codex sessions with ready-to-paste resume commands.',
      inputSchema: {
        within_hours: z.number().int().min(1).max(720).default(24),
        limit: z.number().int().min(1).max(50).default(5),
      },
      annotations: {
        title: 'recent sessions (Token Meter)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ within_hours, limit }) => {
      const rows = recentSessions(db, within_hours, limit);
      if (rows.length === 0) {
        if (countTokenEvents(db) === 0) {
          const guide =
            firstRunGuidance ||
            'No Claude Code or Codex usage found yet. Use Claude Code or Codex, ' +
              'then run `token-meter ingest` (or the refresh_data tool).';
          return {
            content: [
              { type: 'text', text: `Token Meter has no usage data yet.\n${guide}` },
            ],
          };
        }
        return {
          content: [
            { type: 'text', text: `No sessions with activity in the last ${within_hours}h.` },
          ],
        };
      }
      const lines: string[] = [
        `Recent sessions (last ${within_hours}h) — newest first:`,
        ...rows.map((r) => {
          const tool = r.source === 'claude-code' ? 'claude --resume' : 'codex resume';
          const shortId = r.session_id.slice(0, 8);
          return [
            `• ${ageStr(r.age_minutes)} | ${r.source} | ${fmtUsd(r.total_usd)} | ${r.events} ev`,
            `  session: ${shortId}… (full id for session_tools: ${r.session_id})`,
            `  resume: cd "${r.project}" && ${tool} ${r.session_id}`,
          ].join('\n');
        }),
        '',
        ...discoveryFooter(
          '🔧 Next: session_tools <id> to debug a slow session · usage_summary for time-window view',
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'session_tools',
    {
      title: 'session tools (Token Meter)',
      description:
        'Per-session MCP / built-in tool breakdown: call counts, response sizes, average latency. Debug a slow/expensive session.',
      inputSchema: {
        session_id: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: {
        title: 'session tools (Token Meter)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, limit }) => {
      const summary = sessionToolSummary(db, session_id);
      if (summary.length === 0) {
        return {
          content: [{ type: 'text', text: `No tool calls recorded for session ${session_id}.` }],
        };
      }
      const shown = summary.slice(0, limit);
      // Total response tokens across all tools in this session — used to
      // surface each tool's share, since "which tool dominated" is the usual
      // debug question. Computed from the full summary, not just the shown
      // slice, so the percentages add up correctly when limit truncates.
      const totalResp = summary.reduce((acc, s) => acc + s.total_response_tokens, 0);
      const pct = (n: number): string =>
        totalResp > 0 ? `${((n / totalResp) * 100).toFixed(1)}%` : '—';
      const lines: string[] = [
        `Tools used in session ${session_id} (by response tokens; pct = share of session resp tokens):`,
        ...shown.map((s) => {
          const mcp = s.mcp_server ? `mcp:${s.mcp_server}` : 'built-in';
          return `  ${s.tool_name} (${mcp}) calls=${s.calls} resp=${fmtTok(s.total_response_tokens)} (${pct(s.total_response_tokens)}) avg=${Math.round(s.avg_latency_ms)}ms`;
        }),
        ...(summary.length > shown.length
          ? [`  …+${summary.length - shown.length} more (raise limit to see all)`]
          : []),
        '',
        ...discoveryFooter(
          '🔧 Next: usage_summary for time-window view · recent_sessions to find other sessions',
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'subagent_costs',
    {
      title: 'sub-agent costs (Token Meter)',
      description:
        'Split spend into main-session vs sub-agent (Task/Agent) work, list the priciest sub-agents (model mix · tokens · cache), and pair them with parent-side invocation latency. Answers "are my sub-agents worth what they cost". Run `refresh_data` (or `ingest --force` once) so older rows get the sub-agent tag.',
      inputSchema: {
        period: z.enum(['today', 'week', 'month']).default('week'),
        scope: z
          .enum(['auto', 'all', 'wsl', 'linux', 'win', 'windows', 'codex', 'claude-code'])
          .default('auto')
          .describe(
            'which source to include — "auto" filters by current process.platform; "all" disables the filter',
          ),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: {
        title: 'sub-agent costs (Token Meter)',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ period, scope, limit }) => {
      if (countTokenEvents(db) === 0) {
        return {
          content: [
            {
              type: 'text',
              text: [
                'Token Meter has no usage data yet.',
                firstRunGuidance || 'Use Claude Code, then run `token-meter ingest`.',
                '',
                ...discoveryFooter('🔧 After first usage: refresh_data → subagent_costs'),
              ].join('\n'),
            },
          ],
        };
      }
      const { scope: scopeFilter, label: scopeLabel } = resolveScope(scope as ScopeInput);
      const days = periodWindowDays(period);
      const sa = subagentCosts(db, days, limit, scopeFilter);
      const periodLabel = period === 'today' ? 'today' : period === 'week' ? 'last 7d' : 'last 30d';
      const shortModel = (m: string): string =>
        m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
      const { main, subagent } = sa.split;
      const lines: string[] = [
        `Token Meter · sub-agent costs · ${periodLabel} · scope: ${scopeLabel}`,
        '',
      ];
      if (subagent.events === 0) {
        lines.push('No sub-agent (Task/Agent) token rows tagged in this window.');
        lines.push(
          'If you have used sub-agents, run `token-meter ingest --force` once to backfill',
        );
        lines.push('the sub-agent tag onto rows ingested before v0.1.19, then retry.');
      } else {
        lines.push(
          `Split    : main ${fmtUsd(main.usd)} (${main.events.toLocaleString()} calls) · ` +
            `sub-agents ${fmtUsd(subagent.usd)} (${subagent.events.toLocaleString()} calls)`,
        );
        lines.push(
          `Share    : sub-agents are ${sa.subagent_share_pct.toFixed(1)}% of spend · ` +
            `${fmtTok(subagent.cache_read)} cache read · ${fmtTok(subagent.cache_write)} cache write`,
        );
        lines.push('');
        lines.push('Priciest sub-agents:');
        for (const a of sa.top) {
          const models = (a.models || '')
            .split(',')
            .map(shortModel)
            .join(',');
          // agent_type comes from the sub-agent's meta.json (e.g. "general-purpose");
          // falls back to the raw agent_id hash when no meta.json was found.
          const label = a.agent_type ?? a.agent_id;
          lines.push(
            `  ${label}  ${fmtUsd(a.usd)} · ${a.events}x · ${models} · ` +
              `out ${fmtTok(a.output)} · cache_rd ${fmtTok(a.cache_read)}`,
          );
        }
      }
      if (sa.invocations.length > 0) {
        lines.push('');
        lines.push('Invocation latency (parent-side Task/Agent calls):');
        for (const inv of sa.invocations) {
          lines.push(
            `  ${inv.tool_name}  ${inv.calls}x · avg ${(inv.avg_latency_ms / 1000).toFixed(1)}s · ` +
              `max ${(inv.max_latency_ms / 1000).toFixed(1)}s`,
          );
        }
      }
      lines.push('');
      lines.push(
        ...discoveryFooter(
          '🔧 Next: session_tools <id> to drill into one session · usage_summary for the day × model table',
        ),
      );
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'refresh_data',
    {
      title: 'refresh data (Token Meter)',
      description:
        'Re-scan local Claude Code / Codex JSONL for new activity. Run before other tools for up-to-the-minute numbers.',
      inputSchema: {},
      annotations: {
        title: 'refresh data (Token Meter)',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const r = ingestAll(db);
      const lines = [
        `Refreshed. Claude Code: +${r.claude_code.token_rows_inserted} token rows; Codex: +${r.codex.token_rows_inserted} token rows.`,
        '',
        ...discoveryFooter(
          '🔧 Next: usage_summary to see the fresh data · recent_sessions for a session to resume',
        ),
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // Slash-command entry points that pair 1:1 with the tools above. Clients
  // (Claude Code / Cursor / Claude Desktop) surface these as
  // `/mcp__token-meter__<name>` so users can invoke without typing natural language.
  server.registerPrompt(
    'usage_summary',
    {
      title: 'usage summary (Token Meter)',
      description: 'Summarize Claude Code + Codex usage for today / week / month.',
      argsSchema: {
        period: z.string().optional().describe('today | week | month (default: today)'),
      },
    },
    ({ period }) => {
      const p = period === 'week' || period === 'month' ? period : 'today';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Call the token-meter usage_summary tool with period="${p}" and present the result. Note the cost is an API-equivalent estimate, not vendor invoice.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'recent_sessions',
    {
      title: 'recent sessions (Token Meter)',
      description:
        'List recent Claude Code / Codex sessions with ready-to-paste resume commands.',
      argsSchema: {
        within_hours: z.string().optional().describe('hours to look back, 1-720 (default: 24)'),
      },
    },
    ({ within_hours }) => {
      const parsed = within_hours ? parseInt(within_hours, 10) : 24;
      const hours = Number.isFinite(parsed) && parsed >= 1 && parsed <= 720 ? parsed : 24;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Call the token-meter recent_sessions tool with within_hours=${hours}. Show me which sessions I could resume; surface the cd + resume command verbatim for each.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'session_tools',
    {
      title: 'session tools (Token Meter)',
      description: 'Show MCP / built-in tool breakdown for a specific session_id.',
      argsSchema: {
        session_id: z.string().describe('the session_id to inspect'),
        limit: z.string().optional().describe('max tools to list, 1-100 (default: 20)'),
      },
    },
    ({ session_id, limit }) => {
      const parsed = limit ? parseInt(limit, 10) : 20;
      const n = Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 20;
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Call the token-meter session_tools tool with session_id="${session_id}" and limit=${n}. Highlight which tools dominated by call count, response size, or average latency.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'subagent_costs',
    {
      title: 'sub-agent costs (Token Meter)',
      description: 'Show main vs sub-agent spend split and the priciest sub-agents.',
      argsSchema: {
        period: z.string().optional().describe('today | week | month (default: week)'),
      },
    },
    ({ period }) => {
      const p = period === 'today' || period === 'month' ? period : 'week';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Call the token-meter subagent_costs tool with period="${p}". Tell me what share of spend my sub-agents (Task/Agent) account for, which sub-agents cost the most, and whether their invocation latency justifies the token cost.`,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'refresh_data',
    {
      title: 'refresh data (Token Meter)',
      description: 'Re-scan local JSONL files to pick up new Claude Code / Codex activity.',
    },
    () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Call the token-meter refresh_data tool and tell me how many new token rows were ingested for each source.',
          },
        },
      ],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
