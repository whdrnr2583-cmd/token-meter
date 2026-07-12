import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents, insertToolEvents } from '../src/db.js';
import { ingestClaudeCode } from '../src/ingest.js';
import { parseJsonlFile } from '../src/parser.js';
import { subagentCosts } from '../src/stats.js';
import type { TokenEvent, ToolEvent } from '../src/types.js';

const BASE_TS = Date.parse('2026-06-28T04:00:00.000Z');

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

function toolEvent(over: Partial<ToolEvent>): ToolEvent {
  return {
    ts: BASE_TS,
    source: 'claude-code',
    project: '/tmp/fake-project',
    session_id: 'sess-1',
    tool_name: 'Task',
    mcp_server: null,
    tool_use_id: `tu-${Math.random()}`,
    response_chars: 1000,
    response_tokens_est: 285,
    latency_ms: 90_000,
    agent_id: null,
    ...over,
  };
}

test('parseJsonlFile stamps agent_id when given, null by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-parser-agent-'));
  try {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-28T04:00:00.000Z',
      requestId: 'req-abc',
      message: {
        id: 'msg1',
        model: 'claude-haiku-4-5',
        usage: { input_tokens: 5, output_tokens: 8 },
      },
    });
    const f = join(dir, 'agent-haiku-1.jsonl');
    writeFileSync(f, line + '\n');

    const tagged = parseJsonlFile(f, '/tmp/p', 'agent-haiku-1');
    assert.equal(tagged.tokens.length, 1);
    assert.equal(tagged.tokens[0]!.agent_id, 'agent-haiku-1');

    const untagged = parseJsonlFile(f, '/tmp/p');
    assert.equal(untagged.tokens[0]!.agent_id, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagentCosts splits main vs sub-agent, ranks top, lists invocations', () => {
  const db = openDb(':memory:');
  migrate(db);

  insertTokenEvents(db, [
    // main session: $2 over 2 calls
    tokenEvent({ request_id: 'm1', usd_estimate: 1, output_tokens: 40 }),
    tokenEvent({ request_id: 'm2', usd_estimate: 1, output_tokens: 60 }),
    // agent-a: $3 over 2 calls (haiku + sonnet), some cache
    tokenEvent({
      request_id: 'a1',
      agent_id: 'agent-a',
      model: 'claude-haiku-4-5',
      usd_estimate: 1,
      output_tokens: 100,
      cache_read_tokens: 5000,
    }),
    tokenEvent({
      request_id: 'a2',
      agent_id: 'agent-a',
      model: 'claude-sonnet-4-6',
      usd_estimate: 2,
      output_tokens: 200,
    }),
    // agent-b: $0.5 over 1 call
    tokenEvent({
      request_id: 'b1',
      agent_id: 'agent-b',
      model: 'claude-haiku-4-5',
      usd_estimate: 0.5,
      output_tokens: 30,
    }),
  ]);
  insertToolEvents(db, [
    toolEvent({ tool_use_id: 'task1', tool_name: 'Task', latency_ms: 80_000 }),
    toolEvent({ tool_use_id: 'task2', tool_name: 'Task', latency_ms: 100_000 }),
  ]);

  const sa = subagentCosts(db, 3650, 10);

  assert.equal(sa.split.main.usd, 2, 'main USD');
  assert.equal(sa.split.main.events, 2, 'main events');
  assert.equal(sa.split.subagent.usd, 3.5, 'sub-agent USD');
  assert.equal(sa.split.subagent.events, 3, 'sub-agent events');
  // 3.5 / (2 + 3.5) = 63.6%
  assert.ok(Math.abs(sa.subagent_share_pct - 63.636) < 0.1, 'share pct');

  assert.equal(sa.top.length, 2, 'two sub-agents');
  assert.equal(sa.top[0]!.agent_id, 'agent-a', 'priciest first');
  assert.equal(sa.top[0]!.usd, 3);
  assert.equal(sa.top[0]!.cache_read, 5000);
  assert.ok(
    sa.top[0]!.models.includes('claude-haiku-4-5') &&
      sa.top[0]!.models.includes('claude-sonnet-4-6'),
    'model mix concatenated',
  );
  assert.equal(sa.top[1]!.agent_id, 'agent-b');

  assert.equal(sa.invocations.length, 1, 'one tool_name group (Task)');
  assert.equal(sa.invocations[0]!.tool_name, 'Task');
  assert.equal(sa.invocations[0]!.calls, 2);
  assert.equal(sa.invocations[0]!.max_latency_ms, 100_000);
});

test('insertTokenEvents backfills agent_id onto a pre-existing untagged row', () => {
  const db = openDb(':memory:');
  migrate(db);

  // Simulate a row ingested before v0.1.19 (no agent_id).
  insertTokenEvents(db, [tokenEvent({ request_id: 'dup', agent_id: null })]);
  let row = db
    .prepare(`SELECT agent_id FROM token_events WHERE request_id = 'dup'`)
    .get() as { agent_id: string | null };
  assert.equal(row.agent_id, null, 'starts untagged');

  // Re-ingest the same request_id from a sub-agent file (agent_id set). The
  // INSERT OR IGNORE is skipped (duplicate request_id) but the agent_id is
  // backfilled — no new row is created.
  const inserted = insertTokenEvents(db, [
    tokenEvent({ request_id: 'dup', agent_id: 'agent-late' }),
  ]);
  assert.equal(inserted, 0, 'no new row inserted (dedup held)');

  row = db
    .prepare(`SELECT agent_id FROM token_events WHERE request_id = 'dup'`)
    .get() as { agent_id: string | null };
  assert.equal(row.agent_id, 'agent-late', 'agent_id backfilled');

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM token_events WHERE request_id = 'dup'`)
    .get() as { n: number };
  assert.equal(count.n, 1, 'still exactly one row');
});

/**
 * Backlog chain A, item 4: sub-agent label metadata. Claude Code writes a
 * sibling `<agentId>.meta.json` (`{ agentType, description }`) next to each
 * sub-agent's `<agentId>.jsonl`. Ingest should parse it into agent_meta and
 * subagentCosts()'s `top` rows should carry the label via LEFT JOIN — with a
 * clean NULL fallback for a sub-agent whose meta.json is missing.
 */
test('subagentCosts top rows expose agent_type from meta.json, NULL fallback when absent', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tm-subagent-meta-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const projectsRoot = join(fakeHome, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-tmp-fake-meta-project');
    const sessionDir = join(projectDir, 'session-meta');
    const subagentDir = join(sessionDir, 'subagents');
    mkdirSync(subagentDir, { recursive: true });

    const LABELED_MODEL = 'test-fixture-meta-labeled-chainA-4';
    const UNLABELED_MODEL = 'test-fixture-meta-unlabeled-chainA-4';

    // Sub-agent WITH a sibling meta.json.
    const labeledLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T02:00:00.000Z',
      requestId: 'req-meta-labeled',
      message: {
        id: 'msg_labeled',
        model: LABELED_MODEL,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(subagentDir, 'agent-labeled.jsonl'), labeledLine + '\n');
    writeFileSync(
      join(subagentDir, 'agent-labeled.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'test fixture agent' }),
    );

    // Sub-agent WITHOUT a meta.json — must fall back to NULL, not error.
    const unlabeledLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T02:05:00.000Z',
      requestId: 'req-meta-unlabeled',
      message: {
        id: 'msg_unlabeled',
        model: UNLABELED_MODEL,
        usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(subagentDir, 'agent-unlabeled.jsonl'), unlabeledLine + '\n');

    assert.equal(homedir(), fakeHome);

    const db = openDb(':memory:');
    migrate(db);
    ingestClaudeCode(db);

    const metaRow = db
      .prepare(`SELECT agent_type, description FROM agent_meta WHERE agent_id = 'agent-labeled'`)
      .get() as { agent_type: string; description: string } | undefined;
    assert.ok(metaRow, 'agent_meta row written for labeled sub-agent');
    assert.equal(metaRow!.agent_type, 'general-purpose');
    assert.equal(metaRow!.description, 'test fixture agent');

    const noMetaRow = db
      .prepare(`SELECT agent_id FROM agent_meta WHERE agent_id = 'agent-unlabeled'`)
      .get();
    assert.equal(noMetaRow, undefined, 'no agent_meta row for sub-agent with no meta.json');

    const sa = subagentCosts(db, 3650, 50);
    const labeled = sa.top.find((r) => r.agent_id === 'agent-labeled');
    const unlabeled = sa.top.find((r) => r.agent_id === 'agent-unlabeled');
    assert.ok(labeled, 'labeled sub-agent present in top');
    assert.ok(unlabeled, 'unlabeled sub-agent present in top');
    assert.equal(labeled!.agent_type, 'general-purpose', 'agent_type joined from agent_meta');
    assert.equal(unlabeled!.agent_type, null, 'agent_type NULL fallback when meta.json absent');
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
