import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getIngestState, insertTokenEvents, insertToolEvents, recordIngest } from './db.js';
import { parseCodexSession } from './codex-parser.js';
import type { CodexParseState } from './codex-parser.js';
import { buildResume, planResume } from './incremental.js';
import { scanWindowsUserDirs } from './platform.js';

export interface CodexIngestSummary {
  files_scanned: number;
  files_processed: number;
  files_failed: number;
  files_incremental: number;
  errors: string[];
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
  options: { force?: boolean; parse?: typeof parseCodexSession } = {},
): CodexIngestSummary {
  const parse = options.parse ?? parseCodexSession;
  const start = Date.now();
  const summary: CodexIngestSummary = {
    files_scanned: 0,
    files_processed: 0,
    files_failed: 0,
    files_incremental: 0,
    errors: [],
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
      const plan = planResume(filePath, prior, st, !!options.force);

      try {
        const parsed = plan
          ? parse(filePath, { startOffset: plan.startOffset, state: plan.state as CodexParseState })
          : parse(filePath);
        const { tokens, tools } = parsed;
        const ti = insertTokenEvents(db, tokens);
        const tl = insertToolEvents(db, tools);
        recordIngest(
          db, filePath, Math.floor(st.mtimeMs), st.size,
          parsed.state ? buildResume(filePath, parsed.endOffset, parsed.state, st.ino) : undefined,
        );
        if (plan) summary.files_incremental++;
        summary.files_processed++;
        summary.token_rows_inserted += ti;
        summary.tool_rows_inserted += tl;
      } catch (err) {
        summary.files_failed++;
        if (summary.errors.length < 5) {
          summary.errors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}
