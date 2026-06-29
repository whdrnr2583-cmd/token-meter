import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJsonlFile } from '../src/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'claude-code-dedup.jsonl');

test('parser dedupes multiple JSONL entries with same request_id (D-027 regression)', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture');
  // 3 distinct request_ids: req_A, req_B, req_C. req_A appears 3 times in fixture.
  const requestIds = tokens.map((t) => t.request_id);
  assert.equal(tokens.length, 3, 'should emit exactly one row per distinct request_id');
  assert.deepEqual(new Set(requestIds), new Set(['req_A', 'req_B', 'req_C']));
});

test('parser keeps first occurrence of duplicated request_id', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture');
  const reqA = tokens.find((t) => t.request_id === 'req_A');
  // First req_A entry was at 10:00:01
  assert.equal(reqA?.ts, Date.parse('2026-05-13T10:00:01.000Z'));
});

test('parser computes per-row USD using stored pricing', () => {
  const { tokens } = parseJsonlFile(FIXTURE, 'fixture');
  const reqA = tokens.find((t) => t.request_id === 'req_A');
  // Opus 4.7 ($5/$25, cacheRead 0.5, cacheWrite5m 6.25): input=10 output=500 cacheRead=5000 cacheWrite=1000
  // (10*5 + 500*25 + 5000*0.5 + 1000*6.25) / 1e6 = 0.0213
  assert.equal(reqA?.usd_estimate, 0.0213);
});

test('parser identifies MCP tool calls and computes latency', () => {
  const { tools } = parseJsonlFile(FIXTURE, 'fixture');
  // tu-1 is built-in "Read", tu-2 is "mcp__notion__notion_search"
  const tNotion = tools.find((t) => t.tool_name === 'mcp__notion__notion_search');
  assert.ok(tNotion, 'mcp tool should be parsed');
  assert.equal(tNotion.mcp_server, 'notion');
  // tu-2 fired at 10:00:07, result at 10:00:11.500 → 4500ms
  assert.equal(tNotion.latency_ms, 4500);

  const tRead = tools.find((t) => t.tool_name === 'Read');
  assert.ok(tRead);
  assert.equal(tRead.mcp_server, null, 'built-in tool has no mcp_server');
});

test('tool response chars/tokens are measured', () => {
  const { tools } = parseJsonlFile(FIXTURE, 'fixture');
  const tNotion = tools.find((t) => t.tool_name === 'mcp__notion__notion_search');
  assert.ok(tNotion);
  // Response was "notion result data" (18 chars)
  assert.equal(tNotion.response_chars, 18);
  assert.ok(tNotion.response_tokens_est > 0);
});
