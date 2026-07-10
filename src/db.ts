import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { TokenEvent, ToolEvent } from './types.js';

const DEFAULT_DB_PATH = join(homedir(), '.tokenpulse', 'usage.db');

export function getDbPath(): string {
  return process.env.TOKENPULSE_DB ?? DEFAULT_DB_PATH;
}

export function openDb(path = getDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      request_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms INTEGER,
      tps REAL,
      ttft_ms INTEGER,
      usd_estimate REAL NOT NULL DEFAULT 0,
      agent_id TEXT,
      ingested_at TEXT
    );

    -- One API call = one billing event. request_id is globally unique per source.
    -- A single response can appear in multiple JSONL entries (thinking + text split)
    -- and the same request_id can leak into resumed/branched sessions; we count once.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_events_request
      ON token_events(source, request_id)
      WHERE request_id IS NOT NULL;

    -- Fallback for legacy rows without request_id.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_token_events_fallback
      ON token_events(session_id, ts, model)
      WHERE request_id IS NULL;

    CREATE INDEX IF NOT EXISTS idx_token_events_ts ON token_events(ts);
    CREATE INDEX IF NOT EXISTS idx_token_events_project ON token_events(project);
    CREATE INDEX IF NOT EXISTS idx_token_events_model ON token_events(model);
    CREATE INDEX IF NOT EXISTS idx_token_events_session ON token_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      project TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      mcp_server TEXT,
      tool_use_id TEXT NOT NULL,
      response_chars INTEGER NOT NULL DEFAULT 0,
      response_tokens_est INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      agent_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_events_unique
      ON tool_events(tool_use_id);

    CREATE INDEX IF NOT EXISTS idx_tool_events_ts ON tool_events(ts);
    CREATE INDEX IF NOT EXISTS idx_tool_events_name ON tool_events(tool_name);
    CREATE INDEX IF NOT EXISTS idx_tool_events_mcp ON tool_events(mcp_server);
    CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events(session_id, ts);

    CREATE TABLE IF NOT EXISTS ingest_state (
      file TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      last_offset INTEGER NOT NULL DEFAULT 0,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      metric TEXT NOT NULL,
      op TEXT NOT NULL,
      threshold REAL NOT NULL,
      action_type TEXT NOT NULL,
      action_config TEXT NOT NULL,
      cooldown_ms INTEGER NOT NULL DEFAULT 86400000,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_firings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      metric_value REAL NOT NULL,
      action_result TEXT,
      FOREIGN KEY (rule_id) REFERENCES rules(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_rule_firings_rule ON rule_firings(rule_id, fired_at DESC);

    CREATE TABLE IF NOT EXISTS pending_desktop_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      fired_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      consumed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pending_notif_unconsumed
      ON pending_desktop_notifications(consumed_at, fired_at);
  `);

  // Pro-batch migrations (feat/pro-batch): user_settings table for budget etc.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Sub-agent attribution (v0.1.19). `CREATE TABLE IF NOT EXISTS` above already
  // carries agent_id on a fresh DB; this ALTER backfills the column onto a DB
  // created by an earlier version. Additive + nullable — no data is rewritten,
  // so USD/dedup invariants are untouched. Re-run `ingest --force` to populate
  // the column on historical sub-agent rows.
  if (!columnExists(db, 'token_events', 'agent_id')) {
    db.exec(`ALTER TABLE token_events ADD COLUMN agent_id TEXT`);
  }
  if (!columnExists(db, 'tool_events', 'agent_id')) {
    db.exec(`ALTER TABLE tool_events ADD COLUMN agent_id TEXT`);
  }
  // Local LLM proxy (v0.1.20): per-call time-to-first-token. Additive/nullable.
  if (!columnExists(db, 'token_events', 'ttft_ms')) {
    db.exec(`ALTER TABLE token_events ADD COLUMN ttft_ms INTEGER`);
  }
  // Ingest timestamp (v0.1.24): when this row was written to the local DB, as
  // opposed to `ts` (when the event happened per the source JSONL). Nullable —
  // rows written before this column existed stay NULL forever, they are never
  // backfilled. Lets the pricing-reproducibility audit (quality-audit.cjs #3)
  // hard-check rows we know were priced by the pricing.ts shipped alongside
  // this column, instead of only warning across the whole table.
  if (!columnExists(db, 'token_events', 'ingested_at')) {
    db.exec(`ALTER TABLE token_events ADD COLUMN ingested_at TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_events_agent ON token_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_tool_events_agent ON tool_events(agent_id);
  `);
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function insertTokenEvents(db: Database.Database, rows: TokenEvent[]): number {
  if (rows.length === 0) return 0;
  // Stamped once per batch, not per row — "when this ingest run wrote it",
  // not per-event precision. Only applied to rows actually inserted below;
  // pre-existing rows a backfill touches keep their original ingested_at.
  const ingestedAt = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO token_events
      (ts, source, source_kind, model, project, session_id, request_id,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       total_duration_ms, tps, ttft_ms, usd_estimate, agent_id, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Backfill agent_id onto a row that already existed (INSERT OR IGNORE skipped
  // it). Lets a re-ingest (`ingest --force`) tag historical sub-agent rows
  // that were stored before the agent_id column existed. Only fills when the
  // stored value is NULL, so a later main-session pass never clobbers a tag.
  const backfill = db.prepare(
    `UPDATE token_events SET agent_id = ? WHERE source = ? AND request_id = ? AND agent_id IS NULL`,
  );
  const tx = db.transaction((batch: TokenEvent[]) => {
    let inserted = 0;
    for (const r of batch) {
      const result = stmt.run(
        r.ts,
        r.source,
        r.source_kind,
        r.model,
        r.project,
        r.session_id,
        r.request_id,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_tokens,
        r.total_duration_ms,
        r.tps,
        r.ttft_ms ?? null,
        r.usd_estimate,
        r.agent_id ?? null,
        ingestedAt,
      );
      if (result.changes > 0) inserted++;
      else if (r.agent_id != null && r.request_id != null) {
        backfill.run(r.agent_id, r.source, r.request_id);
      }
    }
    return inserted;
  });
  return tx(rows);
}

export function insertToolEvents(db: Database.Database, rows: ToolEvent[]): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tool_events
      (ts, source, project, session_id, tool_name, mcp_server,
       tool_use_id, response_chars, response_tokens_est, latency_ms, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const backfill = db.prepare(
    `UPDATE tool_events SET agent_id = ? WHERE tool_use_id = ? AND agent_id IS NULL`,
  );
  const tx = db.transaction((batch: ToolEvent[]) => {
    let inserted = 0;
    for (const r of batch) {
      const result = stmt.run(
        r.ts,
        r.source,
        r.project,
        r.session_id,
        r.tool_name,
        r.mcp_server,
        r.tool_use_id,
        r.response_chars,
        r.response_tokens_est,
        r.latency_ms,
        r.agent_id ?? null,
      );
      if (result.changes > 0) inserted++;
      else if (r.agent_id != null) backfill.run(r.agent_id, r.tool_use_id);
    }
    return inserted;
  });
  return tx(rows);
}

export function recordIngest(
  db: Database.Database,
  file: string,
  mtimeMs: number,
  size: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ingest_state (file, mtime_ms, size, last_offset, processed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(file, mtimeMs, size, size, Date.now());
}

export function getIngestState(
  db: Database.Database,
  file: string,
): { mtime_ms: number; size: number } | undefined {
  return db
    .prepare(`SELECT mtime_ms, size FROM ingest_state WHERE file = ?`)
    .get(file) as { mtime_ms: number; size: number } | undefined;
}

/**
 * Total number of token events in the DB. Used by mcp.ts to detect the
 * first-run / empty-DB case so we don't report "$0.00 spent" as if it were
 * a real reporting window when the user has not yet generated any logs.
 */
export function countTokenEvents(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM token_events`).get() as { n: number };
  return row.n;
}
