import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import { daysFromQuery } from '../src/server.js';
import { subagentCosts } from '../src/stats.js';
import type { TokenEvent } from '../src/types.js';

const BASE_TS = Date.parse('2026-07-11T04:00:00.000Z');

function tokenEvent(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: BASE_TS,
    source: 'claude-code',
    source_kind: 'cloud',
    model: 'claude-opus-4-7',
    project: '/tmp/fake-project',
    session_id: 'sess-1',
    request_id: `req-${Math.random()}`,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_duration_ms: null,
    tps: null,
    usd_estimate: 1,
    agent_id: null,
    ...over,
  };
}

// ---------- Feature 2: ingested_at column ----------

test('migrate() adds a nullable ingested_at column to token_events', () => {
  const db = openDb(':memory:');
  migrate(db);
  const cols = db.prepare(`PRAGMA table_info(token_events)`).all() as Array<{ name: string; notnull: number }>;
  const col = cols.find((c) => c.name === 'ingested_at');
  assert.ok(col, 'ingested_at column exists');
  assert.equal(col!.notnull, 0, 'ingested_at is nullable');
});

test('migrate() is additive on a pre-existing DB that predates ingested_at', () => {
  // Simulate a v0.1.23 DB: build the token_events table by hand, without the
  // ingested_at column, then run migrate() and confirm it backfills the
  // column (as NULL) without touching existing rows or throwing.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE token_events (
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
      usd_estimate REAL NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    `INSERT INTO token_events (ts, source, source_kind, model, project, session_id, request_id, usd_estimate)
     VALUES (?, 'claude-code', 'cloud', 'claude-opus-4-7', '/tmp/p', 'sess-legacy', 'req-legacy', 1)`,
  ).run(BASE_TS);

  migrate(db);

  const row = db
    .prepare(`SELECT ingested_at FROM token_events WHERE request_id = 'req-legacy'`)
    .get() as { ingested_at: string | null };
  assert.equal(row.ingested_at, null, 'pre-existing row stays NULL, never backfilled');
});

test('insertTokenEvents stamps ingested_at with an ISO timestamp on newly inserted rows', () => {
  const db = openDb(':memory:');
  migrate(db);
  const before = Date.now();
  insertTokenEvents(db, [tokenEvent({ request_id: 'new-1' })]);
  const after = Date.now();

  const row = db
    .prepare(`SELECT ingested_at FROM token_events WHERE request_id = 'new-1'`)
    .get() as { ingested_at: string | null };
  assert.ok(row.ingested_at, 'ingested_at is stamped');
  const stampedMs = Date.parse(row.ingested_at!);
  assert.ok(Number.isFinite(stampedMs), 'ingested_at parses as a valid ISO date');
  assert.ok(stampedMs >= before - 1000 && stampedMs <= after + 1000, 'ingested_at is close to insert time');
});

test('insertTokenEvents backfill of agent_id does not touch ingested_at of the existing row', () => {
  const db = openDb(':memory:');
  migrate(db);
  insertTokenEvents(db, [tokenEvent({ request_id: 'dup-ia', agent_id: null })]);
  const first = db
    .prepare(`SELECT ingested_at FROM token_events WHERE request_id = 'dup-ia'`)
    .get() as { ingested_at: string };

  insertTokenEvents(db, [tokenEvent({ request_id: 'dup-ia', agent_id: 'agent-late' })]);
  const second = db
    .prepare(`SELECT ingested_at, agent_id FROM token_events WHERE request_id = 'dup-ia'`)
    .get() as { ingested_at: string; agent_id: string };

  assert.equal(second.agent_id, 'agent-late', 'agent_id backfilled');
  assert.equal(second.ingested_at, first.ingested_at, 'ingested_at unchanged by backfill');
});

// ---------- Feature 1: /api/subagents dashboard route ----------
//
// Mirrors the exact `app.get('/api/subagents', ...)` handler wired in
// src/server.ts against a fresh Fastify instance + an in-memory DB, using
// `app.inject()` (no port binding, no setInterval — startDashboard() is not
// exercised here). Crucially it calls the *same* exported `daysFromQuery()`
// the live route calls, so parseDays' range/NaN validation and the
// entitlement history clamp are genuinely exercised — a regression in either
// now fails here instead of slipping past a looser re-implemented handler.

function buildSubagentsTestApp(db: Database.Database) {
  const app = Fastify({ logger: false });
  app.get('/api/subagents', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, ...subagentCosts(db, days, 5) };
  });
  return app;
}

test('GET /api/subagents returns the main/sub-agent split and top-5 list', async () => {
  const db = openDb(':memory:');
  migrate(db);
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'm1', usd_estimate: 1 }),
    tokenEvent({ request_id: 'a1', agent_id: 'agent-a', usd_estimate: 4, model: 'claude-haiku-4-5' }),
    tokenEvent({ request_id: 'a2', agent_id: 'agent-b', usd_estimate: 2, model: 'claude-sonnet-4-6' }),
  ]);

  const app = buildSubagentsTestApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/subagents?days=30' });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.days, 30);
  assert.equal(body.split.main.usd, 1);
  assert.equal(body.split.subagent.usd, 6);
  assert.ok(Math.abs(body.subagent_share_pct - (6 / 7) * 100) < 0.01);
  assert.equal(body.top.length, 2);
  assert.equal(body.top[0].agent_id, 'agent-a', 'priciest sub-agent first');
  assert.ok(Array.isArray(body.invocations));

  await app.close();
});

test('GET /api/subagents on an empty DB returns zeroed split, no top rows', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const app = buildSubagentsTestApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/subagents?days=7' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.split.main.usd, 0);
  assert.equal(body.split.subagent.usd, 0);
  assert.equal(body.top.length, 0);
  await app.close();
});

// The route runs ?days= through daysFromQuery → parseDays, which rejects
// non-numeric / out-of-range values and falls back to 30. Because the handler
// now shares that exact function, these bad inputs are validated for real.
test('GET /api/subagents coerces invalid ?days values to the 30-day default', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const app = buildSubagentsTestApp(db);
  for (const bad of ['abc', '-5', '0', '999']) {
    const res = await app.inject({ method: 'GET', url: `/api/subagents?days=${bad}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().days, 30, `?days=${bad} should fall back to 30`);
  }
  await app.close();
});

// With gating enabled and no license, the caller is Free (7-day history cap),
// so daysFromQuery clamps a 30-day request down to 7. This exercises the
// clampDaysToEntitlement path the live route depends on.
test('GET /api/subagents clamps ?days to the Free-tier history cap when gating is on', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const prevGating = process.env.TOKEN_METER_GATING;
  const prevLicense = process.env.TOKEN_METER_LICENSE;
  process.env.TOKEN_METER_GATING = '1';
  delete process.env.TOKEN_METER_LICENSE;
  try {
    const app = buildSubagentsTestApp(db);
    const res = await app.inject({ method: 'GET', url: '/api/subagents?days=30' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().days, 7, 'Free tier caps history at 7 days');
    await app.close();
  } finally {
    if (prevGating !== undefined) process.env.TOKEN_METER_GATING = prevGating;
    else delete process.env.TOKEN_METER_GATING;
    if (prevLicense !== undefined) process.env.TOKEN_METER_LICENSE = prevLicense;
    else delete process.env.TOKEN_METER_LICENSE;
  }
});
