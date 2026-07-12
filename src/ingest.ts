import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  insertTokenEvents,
  insertToolEvents,
  recordIngest,
  getIngestState,
  countTokenEvents,
  upsertAgentMeta,
} from './db.js';
import { parseJsonlFile } from './parser.js';
import { ingestCodex, codexSessionsDirs } from './codex-ingest.js';
import { isWsl, scanWindowsUserDirs } from './platform.js';

// Re-exported for back-compat — isWsl()/scanWindowsUserDirs() moved to
// platform.ts so codex-ingest.ts can import them too without a circular
// import (ingest.ts already imports from codex-ingest.js).
export { isWsl, scanWindowsUserDirs };

export interface IngestSummary {
  files_scanned: number;
  files_processed: number;
  token_rows_inserted: number;
  tool_rows_inserted: number;
  duration_ms: number;
}

export interface CodexIngestSummary {
  files_scanned: number;
  files_processed: number;
  token_rows_inserted: number;
  tool_rows_inserted: number;
  duration_ms: number;
}

export interface CombinedIngestSummary {
  claude_code: IngestSummary;
  codex: CodexIngestSummary;
}

export interface FirstRunResult {
  wasEmpty: boolean;
  ingested: boolean;
  rowsAfter: number;
  guidance: string;
}

/**
 * Primary Claude projects directory (always the home-dir one). Kept for
 * backward compatibility and for callers that just need a single path.
 */
export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * All Claude projects directories to scan. On WSL this includes any
 * Windows-side /mnt/c/Users/<profile>/.claude/projects in addition to the
 * WSL home-dir path, so sessions from a Windows Claude Code install are not
 * silently skipped.
 */
export function claudeProjectsDirs(): string[] {
  const dirs = [claudeProjectsDir()];
  for (const d of scanWindowsUserDirs('.claude/projects')) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

// Decode Claude Code's project-directory name back to a path. Lossy fallback
// only — the parser prefers the JSONL `cwd` field. Windows dirs look like
// "C--Users-whdrn-Desktop"; POSIX dirs like "-mnt-c-Users-whdrn-claudeCode".
function prettyProjectName(dirName: string): string {
  if (/^[A-Za-z]--/.test(dirName)) {
    return dirName
      .replace(/^([A-Za-z])--/, '$1:\\')
      .replace(/-/g, '\\')
      .replace(/\\{2,}/g, '\\');
  }
  return dirName.replace(/-/g, '/');
}

// Non-transcript .jsonl files that Claude Code's dynamic workflows write
// alongside real agent-<id>.jsonl transcripts under subagents/ — control/
// bookkeeping files, not sub-agent usage logs. Listed by exact basename only:
// a broad "agent-*" allowlist filter was considered and rejected, since a
// past sub-agent file layout (see the flat vs. nested history above) didn't
// always follow that naming and a strict allowlist would silently drop real
// transcripts again.
const SUBAGENT_NOISE_BASENAMES = new Set(['journal.jsonl']);

// Recursively collect .jsonl files under a <sessionId>/subagents/ directory.
// Mirrors codex-ingest.ts's walkJsonl (same recursion + symlink-safety shape)
// so nested sub-agent files are found the same way Codex's are. Claude Code
// nests some sub-agents one level deeper than the flat
// <sessionId>/subagents/agent-<id>.jsonl layout — dynamic workflows write
// <sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl instead. A
// 1-depth-only scan silently drops every one of those. Symlinked entries are
// skipped: dirent.isDirectory()/isFile() already read false for a symlink,
// but the explicit check keeps the intent visible.
function walkSubagentJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; /* unreadable subdir — skip silently */
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSubagentJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl') && !SUBAGENT_NOISE_BASENAMES.has(e.name)) out.push(p);
  }
}

// Sibling `<agentId>.meta.json` next to a sub-agent's `<agentId>.jsonl` file
// carries `{ agentType, description }` — Claude Code's own label for what the
// sub-agent was. Parsed opportunistically alongside ingest and upserted into
// agent_meta; malformed/missing meta.json never blocks the token/tool ingest.
function ingestAgentMeta(db: Database.Database, filePath: string, agentId: string): void {
  const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
  if (!existsSync(metaPath)) return;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as {
      agentType?: string;
      description?: string;
    };
    upsertAgentMeta(db, agentId, meta.agentType ?? null, meta.description ?? null);
  } catch {
    /* malformed meta.json — skip silently, doesn't block ingest */
  }
}

export function ingestClaudeCode(
  db: Database.Database,
  options: { force?: boolean } = {},
): IngestSummary {
  const start = Date.now();
  const baseDirs = claudeProjectsDirs();
  const summary: IngestSummary = {
    files_scanned: 0,
    files_processed: 0,
    token_rows_inserted: 0,
    tool_rows_inserted: 0,
    duration_ms: 0,
  };
  for (const baseDir of baseDirs) {
    if (!existsSync(baseDir)) continue;
    const projectDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const dirName of projectDirs) {
      const projectPath = join(baseDir, dirName);
      const prettyName = prettyProjectName(dirName);
      // Collect .jsonl files at the project root AND under any
      // <sessionId>/subagents/ directory. Claude Code writes each sub-agent
      // (Task / Agent tool call) into its own file at
      //   <project>/<sessionId>/subagents/agent-<id>.jsonl
      // Those carry the Haiku / Sonnet rows when a parent session spawns a
      // sub-agent with an overridden model. Skipping the dir left those rows
      // invisible — the per-day model breakdown then under-counted Haiku.
      // Each entry pairs a file with its sub-agent id: null for project-root
      // session files, `agent-<id>` for files under <sessionId>/subagents/.
      // The id is taken from the file path, not the JSONL body, because
      // sub-agent entries carry the parent sessionId — the path is the only
      // place the sub-agent identity survives.
      let files: Array<{ path: string; agentId: string | null }>;
      try {
        const entries = readdirSync(projectPath, { withFileTypes: true });
        files = entries
          .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
          .map((e) => ({ path: join(projectPath, e.name), agentId: null }));
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const subDir = join(projectPath, e.name, 'subagents');
          if (!existsSync(subDir)) continue;
          const subFiles: string[] = [];
          walkSubagentJsonl(subDir, subFiles);
          for (const sf of subFiles) {
            files.push({
              path: sf,
              agentId: basename(sf).replace(/\.jsonl$/, ''),
            });
          }
        }
      } catch {
        continue;
      }
      for (const { path: filePath, agentId } of files) {
        summary.files_scanned++;
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(filePath);
        } catch {
          continue;
        }
        const prior = getIngestState(db, filePath);
        const unchanged =
          !options.force &&
          prior !== undefined &&
          prior.mtime_ms === Math.floor(st.mtimeMs) &&
          prior.size === st.size;
        if (unchanged) continue;
        const { tokens, tools } = parseJsonlFile(filePath, prettyName, agentId);
        const ti = insertTokenEvents(db, tokens);
        const tl = insertToolEvents(db, tools);
        if (agentId) ingestAgentMeta(db, filePath, agentId);
        recordIngest(db, filePath, Math.floor(st.mtimeMs), st.size);
        summary.files_processed++;
        summary.token_rows_inserted += ti;
        summary.tool_rows_inserted += tl;
      }
    }
  }
  summary.duration_ms = Date.now() - start;
  return summary;
}

export function ingestAll(
  db: Database.Database,
  options: { force?: boolean } = {},
): CombinedIngestSummary {
  return {
    claude_code: ingestClaudeCode(db, options),
    codex: ingestCodex(db, options),
  };
}

function anyLogDirExists(): boolean {
  for (const d of claudeProjectsDirs()) {
    if (existsSync(d)) return true;
  }
  // codexSessionsDirs() already covers the WSL → Windows fallback (chain B
  // item 2), so no separate scanWindowsUserDirs() call is needed here.
  for (const d of codexSessionsDirs()) {
    if (existsSync(d)) return true;
  }
  return false;
}

/**
 * First-run guard shared by every entry point (CLI `stats`, dashboard,
 * MCP server). When the DB has never been populated, runs one ingest so the
 * user is not greeted by a wall of zeros. If still empty afterwards (no logs
 * on disk, or logs with no usage), returns plain-text `guidance` telling the
 * user exactly what to do next — never a silent empty screen.
 *
 * Idempotent and cheap once the DB has data.
 */
export function ensureFirstRunData(
  db: Database.Database,
  options: { ingest?: (db: Database.Database) => unknown } = {},
): FirstRunResult {
  const before = countTokenEvents(db);
  if (before > 0) {
    return { wasEmpty: false, ingested: false, rowsAfter: before, guidance: '' };
  }
  const ingest = options.ingest ?? ((d: Database.Database) => ingestAll(d));
  let ingested = false;
  try {
    ingest(db);
    ingested = true;
  } catch {
    /* non-fatal — fall through to the guidance below */
  }
  const after = countTokenEvents(db);
  if (after > 0) {
    return { wasEmpty: true, ingested, rowsAfter: after, guidance: '' };
  }
  const guidance = anyLogDirExists()
    ? [
        'No Claude Code or Codex usage found yet.',
        'Token Meter reads ~/.claude/projects and ~/.codex/sessions — the log',
        'directories exist but hold no usage to report. Use Claude Code or Codex',
        'for a session, then run `token-meter ingest` (or just rerun this).',
      ].join('\n')
    : [
        'No Claude Code or Codex logs found on this machine.',
        'Token Meter reads local JSONL logs from ~/.claude/projects and',
        '~/.codex/sessions. Neither directory exists yet — use Claude Code or',
        'Codex at least once, then run `token-meter ingest`.',
        'On WSL it also scans /mnt/c/Users/*/.claude — if your AI tool runs on',
        'the Windows side, that path is covered automatically.',
      ].join('\n');
  return { wasEmpty: true, ingested, rowsAfter: 0, guidance };
}
