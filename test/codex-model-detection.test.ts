import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseCodexSession } from '../src/codex-parser.js';

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Backlog chain B, item 3: model attribution for Codex logs used to be a
 * whole-session guess from `session_meta.payload.base_instructions.text`
 * (extractModel()) — a single value applied to every token_count event in
 * the file, so a session that switches models mid-run (e.g. hits a rate
 * limit and falls back from gpt-5.3-codex-spark to gpt-5.4) had every turn
 * misattributed to whichever model the session *started* with. Real DB
 * check: 2,916 codex rows were all stamped model='gpt-5' despite
 * turn_context entries showing spark/5.4/5.3-codex/5.5 in use.
 * `turn_context.payload.model` is per-turn ground truth; this test stages a
 * session with a model switch mid-way and asserts each token_count event
 * bills under the model actually in effect for that turn.
 */
test('parseCodexSession attributes each token_count event to the model from the most recent turn_context, not a session-wide guess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-model-test-'));
  try {
    const filePath = join(dir, 'rollout-model-switch.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-model-switch', cwd: 'C:\\fake\\project' },
    });
    // Turn 1: spark.
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 't1', model: 'gpt-5.3-codex-spark' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 0,
          },
        },
      },
    });
    // Turn 2: switches to 5.4 mid-session.
    content += line({
      timestamp: '2026-07-12T00:00:03.000Z',
      type: 'turn_context',
      payload: { turn_id: 't2', model: 'gpt-5.4' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 200,
            cached_input_tokens: 0,
            output_tokens: 40,
            reasoning_output_tokens: 0,
          },
        },
      },
    });
    writeFileSync(filePath, content);

    const { tokens } = parseCodexSession(filePath);
    assert.equal(tokens.length, 2, 'expected one token row per token_count event');
    assert.equal(
      tokens[0]!.model,
      'gpt-5.3-codex-spark',
      'first turn billed under the spark model announced by its turn_context',
    );
    assert.equal(
      tokens[1]!.model,
      'gpt-5.4',
      'second turn billed under the switched-to model, not frozen at the first turn_context value',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexSession falls back to the base_instructions-derived model when the log has no turn_context at all (legacy logs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-model-legacy-test-'));
  try {
    const filePath = join(dir, 'rollout-legacy.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: '019e-test-legacy',
        cwd: 'C:\\fake\\legacy',
        base_instructions: { text: 'You are Codex, based on GPT-5-Codex.' },
      },
    });
    content += line({
      timestamp: '2026-07-12T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 50,
            cached_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        },
      },
    });
    writeFileSync(filePath, content);

    const { tokens } = parseCodexSession(filePath);
    assert.equal(tokens.length, 1);
    assert.equal(
      tokens[0]!.model,
      'gpt-5-codex',
      'no turn_context present — falls back to the base_instructions extractModel() guess',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexSession keeps the last-seen model across a turn_context with no model field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-codex-model-noop-test-'));
  try {
    const filePath = join(dir, 'rollout-noop-turn.jsonl');
    let content = '';
    content += line({
      timestamp: '2026-07-12T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: '019e-test-noop-turn', cwd: 'C:\\fake' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:01.000Z',
      type: 'turn_context',
      payload: { turn_id: 't1', model: 'gpt-5.5' },
    });
    // A turn_context with no `model` field must not clobber currentModel to
    // undefined/null — the `?? currentModel` fallback keeps the prior value.
    content += line({
      timestamp: '2026-07-12T00:00:02.000Z',
      type: 'turn_context',
      payload: { turn_id: 't2' },
    });
    content += line({
      timestamp: '2026-07-12T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 0,
            output_tokens: 5,
            reasoning_output_tokens: 0,
          },
        },
      },
    });
    writeFileSync(filePath, content);

    const { tokens } = parseCodexSession(filePath);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0]!.model, 'gpt-5.5');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
