import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb } from '../src/db.js';
import { ingestClaudeCode } from '../src/ingest.js';

/**
 * v0.1.16 regression: Claude Code writes sub-agent (Task / Agent tool) JSONL
 * files at `<projectRoot>/<sessionId>/subagents/agent-<id>.jsonl`, two levels
 * below the project directory. v0.1.15 ingest only read `.jsonl` at the
 * project root, so every Haiku / Sonnet call dispatched through a sub-agent
 * was silently dropped. This test stages that exact 2-level layout in a
 * throwaway directory and asserts the new scan picks it up.
 */
test('ingestClaudeCode picks up sub-agent JSONL files at <project>/<sessionId>/subagents/', () => {
  // Stage a fake Claude projects tree under HOME so claudeProjectsDir() finds
  // it. Node's `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows,
  // so we override BOTH and restore them in `finally`.
  const fakeHome = mkdtempSync(join(tmpdir(), 'tm-subagent-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const projectsRoot = join(fakeHome, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-tmp-fake-project');
    const sessionDir = join(projectDir, 'session-abc');
    const subagentDir = join(sessionDir, 'subagents');
    mkdirSync(subagentDir, { recursive: true });

    // Use distinctive model names so the assertion still works when the
    // ingest also scans the real ~/.claude/projects (WSL also picks up
    // /mnt/c/Users/*/.claude — intentional, not mocked away).
    const ROOT_MODEL = 'test-fixture-root-v0_1_16';
    const SUBAGENT_MODEL = 'test-fixture-subagent-v0_1_16';

    const rootLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-20T01:00:00.000Z',
      message: {
        id: 'msg_root_fixture',
        model: ROOT_MODEL,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(projectDir, 'root-session.jsonl'), rootLine + '\n');

    const subagentLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-20T01:05:00.000Z',
      message: {
        id: 'msg_subagent_fixture',
        model: SUBAGENT_MODEL,
        usage: { input_tokens: 5, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(subagentDir, 'agent-haiku.jsonl'), subagentLine + '\n');

    assert.equal(homedir(), fakeHome);

    const db = openDb(':memory:');
    migrate(db);
    const summary = ingestClaudeCode(db);

    assert.ok(summary.files_scanned >= 2, 'expected at least 2 files scanned (root + subagent)');

    const fixtureRows = db
      .prepare(`SELECT model, COUNT(*) AS c FROM token_events WHERE model LIKE 'test-fixture-%' GROUP BY model`)
      .all() as Array<{ model: string; c: number }>;
    const byModel = Object.fromEntries(fixtureRows.map((r) => [r.model, r.c]));
    assert.ok((byModel[ROOT_MODEL] ?? 0) >= 1, 'expected root fixture row present');
    assert.ok(
      (byModel[SUBAGENT_MODEL] ?? 0) >= 1,
      'expected subagent fixture row present (regression: <project>/<sessionId>/subagents/ scan)',
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

/**
 * Backlog chain A, item 1: Claude Code's dynamic workflows nest sub-agent
 * JSONL one level deeper than the flat layout above —
 * `<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl`. The
 * previous scan only read `.jsonl` directly inside `subagents/` (1-depth),
 * silently dropping every workflow sub-agent (observed: 890 files, ~$820
 * uningested on a real machine). This test stages that exact nested layout
 * and asserts the recursive scan picks it up, while a sibling flat
 * `subagents/agent-<id>.jsonl` file in the same session is still picked up
 * too (no regression on the 1-depth case).
 */
test('ingestClaudeCode recurses into <project>/<sessionId>/subagents/workflows/<wf>/ (nested sub-agents)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tm-subagent-workflow-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const projectsRoot = join(fakeHome, '.claude', 'projects');
    const projectDir = join(projectsRoot, '-tmp-fake-workflow-project');
    const sessionDir = join(projectDir, 'session-wf');
    const subagentDir = join(sessionDir, 'subagents');
    const workflowDir = join(subagentDir, 'workflows', 'wf_abc123');
    mkdirSync(workflowDir, { recursive: true });

    const FLAT_MODEL = 'test-fixture-flat-chainA-1';
    const NESTED_MODEL = 'test-fixture-nested-chainA-1';

    const flatLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T01:00:00.000Z',
      message: {
        id: 'msg_flat_fixture',
        model: FLAT_MODEL,
        usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(subagentDir, 'agent-flat.jsonl'), flatLine + '\n');

    const nestedLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T01:05:00.000Z',
      message: {
        id: 'msg_nested_fixture',
        model: NESTED_MODEL,
        usage: { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    writeFileSync(join(workflowDir, 'agent-nested.jsonl'), nestedLine + '\n');
    // journal.jsonl sits alongside nested agent files but is not an agent
    // transcript (no `assistant`/`user` entries) — must not error the scan.
    writeFileSync(join(workflowDir, 'journal.jsonl'), JSON.stringify({ type: 'started' }) + '\n');

    assert.equal(homedir(), fakeHome);

    const db = openDb(':memory:');
    migrate(db);
    const summary = ingestClaudeCode(db);

    assert.ok(summary.files_scanned >= 3, 'expected at least 3 files scanned (flat + nested + journal)');

    const fixtureRows = db
      .prepare(`SELECT model, COUNT(*) AS c FROM token_events WHERE model LIKE 'test-fixture-%-chainA-1' GROUP BY model`)
      .all() as Array<{ model: string; c: number }>;
    const byModel = Object.fromEntries(fixtureRows.map((r) => [r.model, r.c]));
    assert.ok((byModel[FLAT_MODEL] ?? 0) >= 1, 'expected flat sub-agent fixture row present (no 1-depth regression)');
    assert.ok(
      (byModel[NESTED_MODEL] ?? 0) >= 1,
      'expected nested workflows/<wf>/ sub-agent fixture row present (regression: recursive subagents/ scan)',
    );

    const nestedAgentRow = db
      .prepare(`SELECT agent_id FROM token_events WHERE model = ?`)
      .get(NESTED_MODEL) as { agent_id: string | null };
    assert.equal(nestedAgentRow.agent_id, 'agent-nested', 'nested agent_id derived from file basename');
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
