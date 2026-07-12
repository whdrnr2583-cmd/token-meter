import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getIngestState, insertTokenEvents, insertToolEvents, recordIngest } from './db.js';
import { parseCodexSession } from './codex-parser.js';
import { scanWindowsUserDirs } from './platform.js';

export interface CodexIngestSummary {
  files_scanned: number;
  files_processed: number;
  token_rows_inserted: number;
  tool_rows_inserted: number;
  duration_ms: number;
}

export function codexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

/**
 * All Codex sessions directories to scan. On WSL this includes any
 * Windows-side /mnt/c/Users/<profile>/.codex/sessions in addition to the
 * WSL home-dir path — mirrors claudeProjectsDirs() in ingest.ts. Real-world
 * gap this fixes: a WSL install whose Codex CLI only ever ran on the Windows
 * side has an ENOENT ~/.codex/sessions while every real session sits under
 * /mnt/c/Users/<profile>/.codex/sessions, so scanning only the single
 * home-dir base silently ingested $0.
 */
export function codexSessionsDirs(): string[] {
  const dirs = [codexSessionsDir()];
  for (const d of scanWindowsUserDirs('.codex/sessions')) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs;
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

export function ingestCodex(
  db: Database.Database,
  options: { force?: boolean } = {},
): CodexIngestSummary {
  const start = Date.now();
  const summary: CodexIngestSummary = {
    files_scanned: 0,
    files_processed: 0,
    token_rows_inserted: 0,
    tool_rows_inserted: 0,
    duration_ms: 0,
  };

  for (const base of codexSessionsDirs()) {
    if (!existsSync(base)) continue;

    const files: string[] = [];
    walkJsonl(base, files);

    for (const filePath of files) {
      summary.files_scanned++;
      let st;
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

      const { tokens, tools } = parseCodexSession(filePath);
      const ti = insertTokenEvents(db, tokens);
      const tl = insertToolEvents(db, tools);
      recordIngest(db, filePath, Math.floor(st.mtimeMs), st.size);

      summary.files_processed++;
      summary.token_rows_inserted += ti;
      summary.tool_rows_inserted += tl;
    }
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}
