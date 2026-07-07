import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJsonlFile } from '../src/parser.js';
import { estimateUsd } from '../src/pricing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'claude-code-subagent-growth.jsonl');

/**
 * 2026-07-08 regression: sub-agent (Task/Agent) JSONL files stream usage
 * incrementally across the split assistant events that share one
 * request_id — output_tokens grows with each later event (thinking=2,
 * text=2, tool_use=772 in real captured data) while model/input/cache stay
 * fixed. Billing the *first* occurrence (old behavior) undercounted
 * sub-agent output tokens by >98% on real logs (2,644 vs 226,708 output
 * tokens across one day of sub-agent files on the dogfood machine). The
 * fixture here reproduces that exact shape.
 */

test('parser bills the final (largest) usage for a request_id that streams growth across split entries', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture', 'agent-a0da2cc310f61c806');
  const grow = tokens.find((t) => t.request_id === 'req_grow');
  assert.ok(grow, 'req_grow token event should exist');
  assert.equal(grow?.output_tokens, 772, 'must bill the last (tool_use) entry, not the first (thinking, output=2)');
  assert.equal(grow?.input_tokens, 2);
  assert.equal(grow?.cache_read_tokens, 12023);
  assert.equal(grow?.cache_write_tokens, 59965);
});

test('parser emits exactly one row per request_id even when usage grows across duplicates', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture', 'agent-a0da2cc310f61c806');
  const growRows = tokens.filter((t) => t.request_id === 'req_grow');
  assert.equal(growRows.length, 1, 'still exactly one billed row per request_id (D-027 dedup intact)');
});

test('parser stamps agent_id on sub-agent rows and computes USD from the final usage', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture', 'agent-a0da2cc310f61c806');
  const grow = tokens.find((t) => t.request_id === 'req_grow');
  assert.equal(grow?.agent_id, 'agent-a0da2cc310f61c806');
  const expected = estimateUsd({
    model: 'claude-sonnet-5',
    input: 2,
    output: 772,
    cacheRead: 12023,
    cacheWrite: 59965,
  });
  assert.equal(grow?.usd_estimate, expected);
});

test('parser bills a non-duplicated request_id normally alongside a growing one', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture', 'agent-a0da2cc310f61c806');
  const single = tokens.find((t) => t.request_id === 'req_single');
  assert.ok(single);
  assert.equal(single?.output_tokens, 40);
  assert.equal(tokens.length, 2, 'exactly 2 distinct request_ids billed (req_grow, req_single)');
});
