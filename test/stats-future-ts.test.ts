import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents, insertToolEvents } from '../src/db.js';
import { overview, daily, byModel, byProject, byMcp, subagentCosts, localPerf } from '../src/stats.js';
import type { TokenEvent, ToolEvent } from '../src/types.js';

// H3 hardening: every N-day-window query in stats.ts bounded `ts >= since`
// with no upper bound, so a row with a future/corrupt timestamp (bad clock,
// malformed JSONL) satisfied every window forever and never aged out of any
// view. forecast.ts already guards this way; this exercises the same fix
// across stats.ts's functions.

const FUTURE_TS = Date.parse('2099-01-01T00:00:00.000Z');
const NORMAL_TS = Date.now() - 60_000; // one minute ago — safely inside any window

function tokenEvent(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: NORMAL_TS,
    source: 'claude-code',
    source_kind: 'cloud',
    model: 'claude-opus-4-7',
    project: '/tmp/fake-project',
    session_id: 'sess-future-ts',
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

function toolEvent(over: Partial<ToolEvent>): ToolEvent {
  return {
    ts: NORMAL_TS,
    source: 'claude-code',
    project: '/tmp/fake-project',
    session_id: 'sess-future-ts',
    tool_name: 'notion_search',
    mcp_server: 'notion',
    tool_use_id: `tu-${Math.random()}`,
    response_chars: 100,
    response_tokens_est: 30,
    latency_ms: 500,
    agent_id: null,
    ...over,
  };
}

function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

test('overview excludes a 2099 future-timestamp row', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'normal-1', usd_estimate: 1 }),
    tokenEvent({ request_id: 'future-1', ts: FUTURE_TS, usd_estimate: 500 }),
  ]);
  const row = overview(db, 3650);
  assert.equal(row.total_usd, 1, 'future row must not inflate total_usd');
  assert.equal(row.events, 1, 'future row must not be counted');
});

test('daily excludes a 2099 future-timestamp row from every day bucket', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'normal-1', usd_estimate: 1 }),
    tokenEvent({ request_id: 'future-1', ts: FUTURE_TS, usd_estimate: 500 }),
  ]);
  const rows = daily(db, 3650);
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  assert.equal(totalUsd, 1, 'no day bucket should carry the future row\'s usd');
  assert.ok(!rows.some((r) => r.day === '2099-01-01'), 'no 2099 day bucket should appear');
});

test('byModel excludes a 2099 future-timestamp row', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'normal-1', model: 'claude-opus-4-7', usd_estimate: 1 }),
    tokenEvent({ request_id: 'future-1', model: 'claude-opus-4-7', ts: FUTURE_TS, usd_estimate: 500 }),
  ]);
  const rows = byModel(db, 3650);
  const row = rows.find((r) => r.model === 'claude-opus-4-7');
  assert.ok(row);
  assert.equal(row!.usd, 1, 'future row must not inflate the model roll-up');
});

test('byProject excludes a 2099 future-timestamp row', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'normal-1', project: '/proj-future-test', usd_estimate: 1 }),
    tokenEvent({ request_id: 'future-1', project: '/proj-future-test', ts: FUTURE_TS, usd_estimate: 500 }),
  ]);
  const rows = byProject(db, 3650, 20);
  const row = rows.find((r) => r.project === '/proj-future-test');
  assert.ok(row);
  assert.equal(row!.usd, 1, 'future row must not inflate the project roll-up');
});

test('byMcp excludes a 2099 future-timestamp tool_event', () => {
  const db = freshDb();
  insertToolEvents(db, [
    toolEvent({ tool_use_id: 'tu-normal', response_tokens_est: 30 }),
    toolEvent({ tool_use_id: 'tu-future', ts: FUTURE_TS, response_tokens_est: 9999 }),
  ]);
  const rows = byMcp(db, 3650, 30);
  const row = rows.find((r) => r.tool_name === 'notion_search');
  assert.ok(row);
  assert.equal(row!.calls, 1, 'future tool_event must not be counted');
  assert.equal(row!.total_response_tokens, 30, 'future tool_event must not inflate token totals');
});

test('subagentCosts excludes a 2099 future-timestamp sub-agent row from split and top', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'main-1', agent_id: null, usd_estimate: 1 }),
    tokenEvent({ request_id: 'agent-1', agent_id: 'agent-a', usd_estimate: 2 }),
    tokenEvent({ request_id: 'agent-future', agent_id: 'agent-a', ts: FUTURE_TS, usd_estimate: 999 }),
  ]);
  const sa = subagentCosts(db, 3650, 10);
  assert.equal(sa.split.main.usd, 1);
  assert.equal(sa.split.subagent.usd, 2, 'future sub-agent row must not inflate the subagent bucket');
  const top = sa.top.find((r) => r.agent_id === 'agent-a');
  assert.ok(top);
  assert.equal(top!.usd, 2);
});

test('localPerf excludes a 2099 future-timestamp local row', () => {
  const db = freshDb();
  insertTokenEvents(db, [
    tokenEvent({ request_id: 'local-1', source: 'ollama', source_kind: 'local', model: 'llama3', usd_estimate: 0 }),
    tokenEvent({
      request_id: 'local-future',
      source: 'ollama',
      source_kind: 'local',
      model: 'llama3',
      ts: FUTURE_TS,
      usd_estimate: 0,
    }),
  ]);
  const rows = localPerf(db, 3650);
  const row = rows.find((r) => r.source === 'ollama' && r.model === 'llama3');
  assert.ok(row);
  assert.equal(row!.calls, 1, 'future local row must not be counted');
});

test('a row with ts exactly "now" is still included (upper bound is inclusive)', () => {
  const db = freshDb();
  const justNow = Date.now();
  insertTokenEvents(db, [tokenEvent({ request_id: 'now-1', ts: justNow, usd_estimate: 3 })]);
  const row = overview(db, 3650);
  assert.equal(row.total_usd, 3);
  assert.equal(row.events, 1);
});
