#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { migrate, openDb } from './db.js';
import { ingestAll } from './ingest.js';
import { byMcp, byModel, byProject, daily, localPerf, overview, subagentCosts } from './stats.js';
import { clampDaysToEntitlement, getEntitlement, isProTier } from './license.js';
import type { AuditReport } from './audit/types.js';

const USAGE = `Usage:
  token-meter ingest [--force]              Scan JSONL → SQLite
  token-meter stats [days=30]               Print summary
  token-meter subagents [days=30]           Main vs sub-agent (Task/Agent) cost split
  token-meter local [days=30]               Local LLM perf (TTFT / TPS) captured by the proxy
  token-meter audit [--days N] [--source all|claude|codex] [--project <value>] [--limit N] [--json]
                                            Cost/latency findings report (expensive sessions, oversized
                                            tool responses, slow tools, repeated calls, cache waste,
                                            high-cost-model signal)
  token-meter proxy [--port N] [--backend URL] [--label NAME]
                                            Proxy a local OpenAI-compatible LLM and measure it
  token-meter export <csv|json> [days=30] [--out <path>]
                                            Export data (Pro)
  token-meter serve                         Run the dashboard at http://localhost:8765
  token-meter mcp                           Run as an MCP server (stdio) for Claude Code / Cursor
  token-meter install-mcp <client>          Register the MCP server (one of:
                                            claude-code | cursor | claude-desktop | all)
  token-meter install-command <client>      Install the /token-meter slash command
                                            (currently: claude-code only)
  token-meter activate <key>                Activate a Pro / Pro+ license
  token-meter setup <key>                   activate + add gating export to ~/.zshrc / ~/.bashrc

Flags:
  -v, --version                             Print version
  -h, --help                                Print this message
  --dry-run                                 (install-mcp / install-command) preview changes`;

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function printOverview(db: ReturnType<typeof openDb>, days: number): void {
  const o = overview(db, days);
  console.log(`\n=== Last ${days} days ===`);
  console.log(`Events:        ${o.events}`);
  console.log(`Input tokens:  ${fmtTokens(o.total_input)}`);
  console.log(`Output tokens: ${fmtTokens(o.total_output)}`);
  console.log(`Cache read:    ${fmtTokens(o.total_cache_read)}`);
  console.log(`Cache write:   ${fmtTokens(o.total_cache_write)}`);
  console.log(`Estimated USD: ${fmtUsd(o.total_usd)}`);
}

function printDaily(db: ReturnType<typeof openDb>, days: number): void {
  const rows = daily(db, days);
  console.log(`\n=== Daily (${days}d) ===`);
  console.log('day         usd        input    output   cache_r  events');
  for (const r of rows) {
    console.log(
      `${r.day}  ${fmtUsd(r.usd).padStart(9)}  ` +
        `${fmtTokens(r.input).padStart(7)}  ${fmtTokens(r.output).padStart(7)}  ` +
        `${fmtTokens(r.cache_read).padStart(7)}  ${String(r.events).padStart(5)}`,
    );
  }
}

function printByModel(db: ReturnType<typeof openDb>, days: number): void {
  const rows = byModel(db, days);
  console.log(`\n=== By model (${days}d) ===`);
  for (const r of rows) {
    console.log(
      `${r.model.padEnd(28)} ${fmtUsd(r.usd).padStart(9)}  ` +
        `out=${fmtTokens(r.output).padStart(7)}  events=${r.events}`,
    );
  }
}

function printByProject(db: ReturnType<typeof openDb>, days: number): void {
  const rows = byProject(db, days);
  console.log(`\n=== By project (${days}d, top ${rows.length}) ===`);
  for (const r of rows) {
    const name = r.project.length > 45 ? '…' + r.project.slice(-44) : r.project;
    console.log(
      `${name.padEnd(46)} ${fmtUsd(r.usd).padStart(9)}  events=${r.events}`,
    );
  }
}

function printByMcp(db: ReturnType<typeof openDb>, days: number): void {
  const rows = byMcp(db, days);
  console.log(`\n=== MCP & tools (${days}d, top ${rows.length}) ===`);
  console.log('mcp           tool                                  calls  resp_tok  avg_latency');
  for (const r of rows) {
    const mcp = (r.mcp_server ?? '-').padEnd(13);
    const tool = r.tool_name.length > 36 ? r.tool_name.slice(0, 36) : r.tool_name;
    console.log(
      `${mcp} ${tool.padEnd(38)} ${String(r.calls).padStart(5)}  ` +
        `${fmtTokens(r.total_response_tokens).padStart(8)}  ` +
        `${Math.round(r.avg_latency_ms)}ms`,
    );
  }
}

function printSubagents(db: ReturnType<typeof openDb>, days: number): void {
  const sa = subagentCosts(db, days, 15);
  const { main, subagent } = sa.split;
  console.log(`\n=== Sub-agent costs (${days}d) ===`);
  console.log(
    `Main:       ${fmtUsd(main.usd).padStart(11)}  events=${main.events}`,
  );
  console.log(
    `Sub-agents: ${fmtUsd(subagent.usd).padStart(11)}  events=${subagent.events}  ` +
      `(${sa.subagent_share_pct.toFixed(1)}% of spend)`,
  );
  if (subagent.events === 0) {
    console.log(
      'No sub-agent rows tagged. Run `token-meter ingest --force` once to backfill ' +
        'rows ingested before v0.1.19.',
    );
  } else {
    console.log('\nPriciest sub-agents:');
    for (const a of sa.top) {
      const models = (a.models ?? '')
        .split(',')
        .map((m) => m.replace(/^claude-/, '').replace(/-\d{8}$/, ''))
        .join(',');
      console.log(
        `  ${a.agent_id.padEnd(22)} ${fmtUsd(a.usd).padStart(11)}  ` +
          `events=${String(a.events).padStart(4)}  out=${fmtTokens(a.output).padStart(7)}  ${models}`,
      );
    }
  }
  if (sa.invocations.length > 0) {
    console.log('\nInvocation latency (parent-side Task/Agent calls):');
    for (const inv of sa.invocations) {
      console.log(
        `  ${inv.tool_name.padEnd(6)} calls=${String(inv.calls).padStart(4)}  ` +
          `avg=${(inv.avg_latency_ms / 1000).toFixed(1)}s  max=${(inv.max_latency_ms / 1000).toFixed(1)}s`,
      );
    }
  }
}

function printLocalPerf(db: ReturnType<typeof openDb>, days: number): void {
  const rows = localPerf(db, days);
  console.log(`\n=== Local LLM perf (${days}d) ===`);
  if (rows.length === 0) {
    console.log(
      'No local calls captured yet. Run `token-meter proxy` in front of your ' +
        'local LLM (Ollama/LM Studio/llama.cpp/vLLM) and point your client at it.',
    );
    return;
  }
  console.log('source        model                    calls   avg_tps   avg_ttft   out');
  for (const r of rows) {
    const tps = r.avg_tps != null ? r.avg_tps.toFixed(1) : '—';
    const ttft = r.avg_ttft_ms != null ? `${Math.round(r.avg_ttft_ms)}ms` : '—';
    console.log(
      `${(r.source ?? '-').padEnd(13)} ${r.model.slice(0, 24).padEnd(24)} ` +
        `${String(r.calls).padStart(5)}  ${tps.padStart(7)}  ${ttft.padStart(8)}  ` +
        `${fmtTokens(r.output).padStart(6)}`,
    );
  }
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === '--version' || cmd === '-v') {
    console.log(getVersion());
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(USAGE);
    return;
  }

  if (cmd === 'serve') {
    const { startDashboard } = await import('./server.js');
    await startDashboard();
    // startDashboard keeps the process alive via app.listen + setInterval.
    return;
  }

  if (cmd === 'proxy') {
    const flagVal = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i !== -1 ? rest[i + 1] : undefined;
    };
    const portRaw = flagVal('--port');
    const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
    const { startProxy } = await import('./proxy.js');
    await startProxy({
      port: port !== undefined && Number.isFinite(port) ? port : undefined,
      backend: flagVal('--backend'),
      label: flagVal('--label'),
    });
    // startProxy keeps the process alive via server.listen.
    return;
  }

  if (cmd === 'activate') {
    const key = rest[0]?.trim() ?? '';
    if (!key) {
      console.error('Usage: token-meter activate <license_key>');
      process.exit(1);
    }
    const { activateLicense } = await import('./license.js');
    const result = await activateLicense(key);
    if (result.ok) {
      console.log(result.message);
    } else {
      console.error(result.message);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'install-mcp') {
    const arg = rest.find((s) => !s.startsWith('--'))?.trim() ?? '';
    const dryRun = rest.includes('--dry-run');
    const validClients = new Set([
      'claude-code',
      'cursor',
      'claude-desktop',
      'all',
    ]);
    if (!validClients.has(arg)) {
      console.error(
        'Usage: token-meter install-mcp <claude-code|cursor|claude-desktop|all> [--dry-run]',
      );
      process.exit(1);
    }
    const { installMcp } = await import('./install-mcp.js');
    const results = installMcp(
      arg as 'claude-code' | 'cursor' | 'claude-desktop' | 'all',
      { dryRun },
    );
    let failed = false;
    for (const r of results) {
      const icon =
        r.action === 'added' || r.action === 'updated'
          ? '✓'
          : r.action === 'already-present'
            ? '='
            : r.action === 'skipped'
              ? '–'
              : '✗';
      console.log(`${icon} [${r.client}] ${r.message}`);
      if (!r.ok) failed = true;
    }
    if (failed) process.exit(1);
    return;
  }

  if (cmd === 'install-command') {
    const arg = rest.find((s) => !s.startsWith('--'))?.trim() ?? '';
    const dryRun = rest.includes('--dry-run');
    if (arg !== 'claude-code') {
      console.error('Usage: token-meter install-command claude-code [--dry-run]');
      process.exit(1);
    }
    const { installCommand } = await import('./install-command.js');
    const results = installCommand(arg, { dryRun });
    let failed = false;
    for (const r of results) {
      const icon =
        r.action === 'added' || r.action === 'updated'
          ? '✓'
          : r.action === 'already-present'
            ? '='
            : r.action === 'skipped'
              ? '–'
              : '✗';
      console.log(`${icon} [${r.client}] ${r.message}`);
      if (!r.ok) failed = true;
    }
    if (failed) process.exit(1);
    return;
  }

  if (cmd === 'setup') {
    const key = rest.find((s) => s.startsWith('tm_')) ?? rest[0]?.trim() ?? '';
    if (!key) {
      console.error('Usage: token-meter setup <license_key>');
      process.exit(1);
    }
    const { activateLicense, appendShellRc } = await import('./license.js');
    const act = await activateLicense(key);
    if (!act.ok) {
      console.error(act.message);
      process.exit(1);
    }
    console.log(act.message);

    const rc = appendShellRc();
    if (rc.modified) {
      console.log(
        `Added \`export TOKEN_METER_GATING=1\` to ${rc.path}. ` +
          `Restart your shell or run \`source ${rc.path}\` to apply.`,
      );
    } else if (rc.alreadyPresent) {
      console.log(`Gating env already present in ${rc.path} — nothing to add.`);
    } else {
      console.log(`Skipped shell rc edit: ${rc.reason ?? 'unknown reason'}`);
    }

    console.log('');
    console.log('Optional — register Token Meter as an MCP server:');
    console.log('  Auto:  token-meter install-mcp all   (claude-code + cursor + claude-desktop)');
    console.log('  Or:    token-meter install-mcp <claude-code|cursor|claude-desktop>');
    console.log('  Docs:  https://github.com/whdrnr2583-cmd/token-meter/blob/main/docs/mcp-server.md');
    console.log('');
    console.log('Verify: TOKEN_METER_GATING=1 token-meter stats 30  (no "Free tier" warning = success)');
    return;
  }

  const db = openDb();
  migrate(db);

  if (cmd === 'ingest') {
    const force = rest.includes('--force');
    const result = ingestAll(db, { force });
    console.log(
      `Claude Code: scanned ${result.claude_code.files_scanned}, processed ${result.claude_code.files_processed}, ` +
        `+${result.claude_code.token_rows_inserted} tokens, +${result.claude_code.tool_rows_inserted} tools ` +
        `in ${result.claude_code.duration_ms}ms`,
    );
    console.log(
      `Codex:       scanned ${result.codex.files_scanned}, processed ${result.codex.files_processed}, ` +
        `+${result.codex.token_rows_inserted} tokens in ${result.codex.duration_ms}ms`,
    );
    return;
  }

  if (cmd === 'mcp') {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
    // startMcpServer keeps the process alive over stdio.
    return;
  }

  if (cmd === 'export') {
    const fmt = rest.find((s) => s === 'csv' || s === 'json') ?? 'json';
    const daysArg = rest.find((s) => /^\d+$/.test(s));
    const requested = daysArg ? Number.parseInt(daysArg, 10) : 30;
    const outIdx = rest.indexOf('--out');
    const outPath = outIdx !== -1 ? rest[outIdx + 1] : undefined;

    const ent = getEntitlement();
    if (!isProTier(ent.tier)) {
      console.error(
        '[Free tier] export is a Pro feature. See https://token-meter.dev#pricing',
      );
      process.exit(1);
    }

    const days = clampDaysToEntitlement(requested, ent.tier);
    const { exportCsv, exportJson } = await import('./export.js');
    const content = fmt === 'csv' ? exportCsv(db, days) : exportJson(db, days);

    if (outPath) {
      writeFileSync(outPath, content, 'utf8');
      console.log(`Exported ${days}-day ${fmt.toUpperCase()} to ${outPath}`);
    } else {
      process.stdout.write(content + '\n');
    }
    return;
  }

  if (cmd === 'subagents') {
    const daysArg = rest.find((s) => /^\d+$/.test(s));
    const requested = daysArg ? Number.parseInt(daysArg, 10) : 30;
    const ent = getEntitlement();
    const days = clampDaysToEntitlement(requested, ent.tier);
    if (days < requested) {
      const tierLabel = ent.tier === 'free' ? 'Free' : 'Pro';
      console.error(
        `[${tierLabel} tier] history clamped to ${days} days (requested ${requested}). ` +
          `See https://token-meter.dev#pricing`,
      );
    }
    printSubagents(db, days);
    return;
  }

  if (cmd === 'local') {
    const daysArg = rest.find((s) => /^\d+$/.test(s));
    const requested = daysArg ? Number.parseInt(daysArg, 10) : 30;
    const ent = getEntitlement();
    const days = clampDaysToEntitlement(requested, ent.tier);
    printLocalPerf(db, days);
    return;
  }

  if (cmd === 'audit') {
    const AUDIT_USAGE =
      'Usage: token-meter audit [--days N] [--source all|claude|codex] [--project <value>] [--limit N] [--json]';
    const flagVal = (name: string): string | undefined => {
      const i = rest.indexOf(name);
      return i !== -1 ? rest[i + 1] : undefined;
    };
    const jsonMode = rest.includes('--json');

    const daysRaw = flagVal('--days');
    const requestedDays = daysRaw !== undefined ? Number.parseInt(daysRaw, 10) : 7;
    if (!Number.isFinite(requestedDays) || requestedDays <= 0) {
      console.error(`Invalid --days value: ${daysRaw}\n${AUDIT_USAGE}`);
      process.exit(1);
    }
    const ent = getEntitlement();
    const days = clampDaysToEntitlement(requestedDays, ent.tier);
    if (days < requestedDays) {
      const tierLabel = ent.tier === 'free' ? 'Free' : 'Pro';
      console.error(
        `[${tierLabel} tier] history clamped to ${days} days (requested ${requestedDays}). ` +
          `See https://token-meter.dev#pricing`,
      );
    }

    // CLI-facing values (all|claude|codex) map to the internal source
    // identifiers ('claude' -> 'claude-code') DetectorContext/AuditReport use.
    const sourceArg = flagVal('--source') ?? 'all';
    const sourceMap: Record<string, 'all' | 'claude-code' | 'codex'> = {
      all: 'all',
      claude: 'claude-code',
      codex: 'codex',
    };
    const source = sourceMap[sourceArg];
    if (!source) {
      console.error(`Invalid --source value: ${sourceArg} (expected all|claude|codex)\n${AUDIT_USAGE}`);
      process.exit(1);
    }

    const project = flagVal('--project') ?? null;

    // --limit caps how many findings the TERMINAL view prints. --json has no
    // separate flag of its own — per the audit spec, JSON output "should
    // still be able to show more if useful" than the terse terminal default,
    // so an explicit --limit always wins, but an unset --limit defaults
    // higher in --json mode (more useful for scripted/dashboard consumers)
    // than in the terminal's terse default.
    const limitRaw = flagVal('--limit');
    let limit: number;
    if (limitRaw !== undefined) {
      limit = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(limit) || limit <= 0) {
        console.error(`Invalid --limit value: ${limitRaw}\n${AUDIT_USAGE}`);
        process.exit(1);
      }
    } else {
      limit = jsonMode ? 20 : 5;
    }

    const { runAudit } = await import('./audit/engine.js');
    let report: AuditReport;
    try {
      report = runAudit(db, { days, source, project, limit });
    } catch (err) {
      console.error(`audit failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (jsonMode) {
      const { formatJson } = await import('./audit/reporters/json.js');
      console.log(formatJson(report));
    } else {
      const { formatTerminal } = await import('./audit/reporters/terminal.js');
      console.log(formatTerminal(report));
    }
    // A report with zero findings on a fully valid (if quiet) dataset is a
    // successful run, not a failure — exit 0 either way; only the try/catch
    // above (an actual execution failure) exits non-zero.
    return;
  }

  if (cmd === 'stats' || cmd === undefined) {
    const daysArg = rest.find((s) => /^\d+$/.test(s));
    const requested = daysArg ? Number.parseInt(daysArg, 10) : 30;
    const ent = getEntitlement();
    const days = clampDaysToEntitlement(requested, ent.tier);
    if (days < requested) {
      const tierLabel = ent.tier === 'free' ? 'Free' : 'Pro';
      const nextTip =
        ent.tier === 'free'
          ? 'Pro shows 30 days, Pro+ shows everything.'
          : 'Pro+ shows everything.';
      console.error(
        `[${tierLabel} tier] history clamped to ${days} days (requested ${requested}). ` +
          `${nextTip} See https://token-meter.dev#pricing`,
      );
    }
    printOverview(db, days);
    printDaily(db, days);
    printByModel(db, days);
    printByProject(db, days);
    printByMcp(db, days);
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
