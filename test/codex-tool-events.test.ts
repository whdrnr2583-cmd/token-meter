import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseCodexSession } from '../src/codex-parser.js';
import { estimateTokensFromText } from '../src/parser.js';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Backlog chain B, item 6: Codex JSONL logs carry tool calls as
 * `response_item` entries — `function_call`/`custom_tool_call` paired with a
 * later `function_call_output`/`custom_tool_call_output` sharing the same
 * `call_id` — but parseCodexSession() only ever emitted token_count events,
 * so tool_events (and everything downstream: trim-suggestions, per-tool
 * cost) was Claude-Code-only. This test asserts the pairing pass emits a
 * ToolEvent from each matched call/output pair.
 */
test('parseCodexSession pairs a function_call with its function_call_output into a ToolEvent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-tool-test-'));
  try {
    const filePath = join(dir, 'rollout-function-call.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-tool-fc', cwd: 'C:\\fake\\project' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'call_abc123',
        arguments: '{"command":"ls"}',
      },
    });
    content += line({
      timestamp: '2026-07-12T00:00:05.500Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_abc123',
        output: 'file1.txt\nfile2.txt',
      },
    });
    writeFileSync(filePath, content);

    const { tools } = parseCodexSession(filePath);
    assert.equal(tools.length, 1);
    const t = tools[0]!;
    assert.equal(t.source, 'codex');
    assert.equal(t.project, 'C:\\fake\\project');
    assert.equal(t.session_id, '019e-test-tool-fc');
    assert.equal(t.tool_name, 'shell_command');
    assert.equal(t.tool_use_id, 'call_abc123');
    assert.equal(t.mcp_server, null, 'codex tool pairing never sets mcp_server — out of scope for this detector');
    assert.equal(t.response_chars, 'file1.txt\nfile2.txt'.length);
    assert.equal(t.response_tokens_est, estimateTokensFromText('file1.txt\nfile2.txt'));
    // call at 00:01, output at 00:05.500 → 4500ms
    assert.equal(t.latency_ms, 4500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexSession pairs a custom_tool_call with its custom_tool_call_output into a ToolEvent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-tool-custom-test-'));
  try {
    const filePath = join(dir, 'rollout-custom-tool-call.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-tool-custom', cwd: 'C:\\fake\\project' },
    });
    content += line({
      timestamp: '2026-07-12T00:04:02.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call_patch1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: foo.txt\n+hi\n*** End Patch',
      },
    });
    content += line({
      timestamp: '2026-07-12T00:04:03.700Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_patch1',
        output: 'Success. Updated the following files:\nA foo.txt\n',
      },
    });
    writeFileSync(filePath, content);

    const { tools } = parseCodexSession(filePath);
    assert.equal(tools.length, 1);
    const t = tools[0]!;
    assert.equal(t.tool_name, 'apply_patch');
    assert.equal(t.tool_use_id, 'call_patch1');
    assert.equal(t.latency_ms, 1700);
    assert.ok(t.response_tokens_est > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexSession does not emit a ToolEvent for a function_call with no matching output (call never completed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-tool-unmatched-test-'));
  try {
    const filePath = join(dir, 'rollout-unmatched.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-tool-unmatched', cwd: 'C:\\fake' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', call_id: 'call_orphan', arguments: '{}' },
    });
    writeFileSync(filePath, content);

    const { tools } = parseCodexSession(filePath);
    assert.equal(tools.length, 0, 'no output entry — no ToolEvent should be synthesized');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * H5 hardening: Codex sometimes emits a structured (object/array) `output`
 * instead of a plain string. The old code coerced anything non-string to ''
 * (`typeof p.output === 'string' ? p.output : ''`), silently zeroing out
 * response_chars/response_tokens_est for that call. Must JSON.stringify the
 * structured payload instead so the size reflects its actual content.
 */
test('parseCodexSession stringifies a structured (object) tool output instead of downgrading it to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-tool-object-output-'));
  try {
    const filePath = join(dir, 'rollout-object-output.jsonl');
    const structuredOutput = { status: 'ok', files: ['a.txt', 'b.txt'], count: 2 };
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-tool-object', cwd: 'C:\\fake\\project' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'list_files', call_id: 'call_obj1', arguments: '{}' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_obj1', output: structuredOutput },
    });
    writeFileSync(filePath, content);

    const { tools } = parseCodexSession(filePath);
    assert.equal(tools.length, 1);
    const t = tools[0]!;
    const expectedText = JSON.stringify(structuredOutput);
    assert.equal(t.response_chars, expectedText.length, 'response_chars must reflect the stringified payload, not 0');
    assert.equal(t.response_tokens_est, estimateTokensFromText(expectedText));
    assert.ok(t.response_chars > 0, 'a structured output must never downgrade to a 0-length empty string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexSession pairs multiple distinct call_ids independently in one session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-tool-multi-test-'));
  try {
    const filePath = join(dir, 'rollout-multi.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-tool-multi', cwd: 'C:\\fake' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell_command', call_id: 'call_1', arguments: '{}' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:02.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call_2', input: '' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:03.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'out1' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:04.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call_2', output: 'out2' },
    });
    writeFileSync(filePath, content);

    const { tools } = parseCodexSession(filePath);
    assert.equal(tools.length, 2);
    const byId = Object.fromEntries(tools.map((t) => [t.tool_use_id, t]));
    assert.equal(byId['call_1']!.tool_name, 'shell_command');
    assert.equal(byId['call_2']!.tool_name, 'apply_patch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
