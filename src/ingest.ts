import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import {
  insertTokenEvents,
  insertToolEvents,
  recordIngest,
  getIngestState,
  countTokenEvents,
} from './db.js';
import { parseJsonlFile } from './parser.js';
import { ingestCodex, codexSessionsDir } from './codex-ingest.js';

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
 * Returns true when the current process is running inside WSL (Windows
 * Subsystem for Linux). Checks /proc/version for the "microsoft" or "WSL"
 * string which is present in all WSL 1 and WSL 2 kernels.
 */
export function isWsl(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

/**
 * Tool-data directories on the Windows side, for use when running under WSL.
 * Scans every /mnt/c/Users/<profile>/<relPath> and returns the ones that
 * exist. It looks for the data directly rather than guessing the Windows
 * username — USERPROFILE is often unset under WSL, and the first
 * /mnt/c/Users entry can be a sandbox/system account (e.g.
 * "CodexSandboxOffline"), not the real user. Returns [] when off WSL.
 */
export function scanWindowsUserDirs(relPath: string): string[] {
  if (!isWsl()) return [];
  const usersRoot = '/mnt/c/Users';
  const out: string[] = [];
  try {
    for (const e of readdirSync(usersRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const candidate = `${usersRoot}/${e.name}/${relPath}`;
      if (existsSync(candidate)) out.push(candidate);
    }
  } catch {
    /* /mnt/c/Users absent — not a typical WSL-on-Windows setup */
  }
  return out;
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
          try {
            for (const sf of readdirSync(subDir)) {
              if (sf.endsWith('.jsonl')) {
                files.push({
                  path: join(subDir, sf),
                  agentId: sf.replace(/\.jsonl$/, ''),
                });
              }
            }
          } catch {
            /* unreadable subdir — skip silently */
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
  // codex-ingest only exports the home-dir path (singular) in v0.1.8 src;
  // also check WSL → Windows fallbacks here to keep the answer correct on WSL.
  if (existsSync(codexSessionsDir())) return true;
  for (const d of scanWindowsUserDirs('.codex/sessions')) {
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
