// Regression tests for defects found in the independent review of the
// token-meter-polish branch. Each test was written first and seen failing
// against the unfixed code.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { insertTokenEvents, insertToolEvents, migrate, openDb } from '../src/db.js';
import { ingestAll } from '../src/ingest.js';
import { computeTrimSuggestions } from '../src/trim-suggestions.js';
import { runAudit } from '../src/audit/engine.js';
import { estimateUsd, modelRates } from '../src/pricing.js';
import type { TokenEvent, ToolEvent } from '../src/types.js';

function withHome<T>(home: string, fn: () => T): T {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------- 1. Codex: upgrading must not duplicate rows whose output changed ----------

test('codex: re-parsing a file ingested by the previous version does not add a second row per turn (reasoning fix keeps request ids stable)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-rv-codex-'));
  try {
    const dir = join(home, '.codex', 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'rollout-a.jsonl');
    const ts = Date.parse('2026-10-01T10:00:05.000Z');
    const sessionId = 'codex-session-0123456789abcdef';
    const lines = [
      JSON.stringify({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: '/w' } }),
      JSON.stringify({ timestamp: '2026-10-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } }),
      // reasoning (20) is already inside output (50): total 150 = 100 + 50
      JSON.stringify({
        timestamp: new Date(ts).toISOString(), type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 150 } } },
      }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');
    const db = openDb(':memory:');
    migrate(db);
    // The row exactly as v0.1.29 stored it: output = output + reasoning, and
    // the synthetic request id built from that output.
    insertTokenEvents(db, [{
      ts, source: 'codex', source_kind: 'cloud', model: 'gpt-5.4', project: '/w', session_id: sessionId,
      request_id: `codex-${sessionId.slice(-12)}-${ts}-70`, input_tokens: 100, output_tokens: 70,
      cache_read_tokens: 0, cache_write_tokens: 0, total_duration_ms: null, tps: null,
      usd_estimate: estimateUsd({ model: 'gpt-5.4', input: 100, output: 70, cacheRead: 0, cacheWrite: 0 }),
    }]);
    withHome(home, () => {
      // the file grows (session still active) => full re-parse of a legacy row
      appendFileSync(file, JSON.stringify({ timestamp: '2026-10-01T10:00:09.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } }) + '\n');
      ingestAll(db, { force: true });
    });
    const rows = db.prepare(`SELECT request_id, output_tokens FROM token_events WHERE source='codex' AND ts = ?`).all(ts);
    assert.equal(rows.length, 1, `expected one row for the turn, got ${JSON.stringify(rows)}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- 2. Trim/oversized savings priced at input rates ----------

function tok(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: Date.now() - 3_600_000, source: 'claude-code', source_kind: 'cloud', model: 'claude-sonnet-4-5', project: '/p',
    session_id: 's1', request_id: `r-${Math.random()}`, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_duration_ms: null, tps: null, usd_estimate: 0, agent_id: null,
    ...over,
  };
}

function seedCacheHeavyUsage(db: ReturnType<typeof openDb>): void {
  // Typical agent traffic: almost every prompt token is a cache read.
  const rows: TokenEvent[] = [];
  for (let i = 0; i < 20; i++) {
    const t = tok({ input_tokens: 500, output_tokens: 400, cache_read_tokens: 80_000, cache_write_tokens: 3_000 });
    t.usd_estimate = estimateUsd({ model: t.model, input: 500, output: 400, cacheRead: 80_000, cacheWrite: 3_000 });
    rows.push(t);
  }
  insertTokenEvents(db, rows);
  const tools: ToolEvent[] = [];
  for (let i = 0; i < 30; i++) {
    tools.push({
      ts: Date.now() - 3_600_000 - i * 1000, source: 'claude-code', project: '/p', session_id: 's1',
      tool_name: 'mcp__big__dump', mcp_server: 'big', tool_use_id: `u${i}`, response_chars: 80_000,
      response_tokens_est: 20_000, latency_ms: 100, agent_id: null, file_ext: null,
    } as ToolEvent);
  }
  insertToolEvents(db, tools);
}

test('trim suggestions price saved response tokens at the input rate (cache-heavy usage must not inflate it)', () => {
  const db = openDb(':memory:');
  migrate(db);
  seedCacheHeavyUsage(db);
  const s = computeTrimSuggestions(db, 7).find((x) => x.kind === 'large_response');
  assert.ok(s, 'expected a large_response suggestion');
  const perToken = s.savings_usd_per_week / s.savings_tokens_per_week;
  const inputRate = modelRates('claude-sonnet-4-5').input / 1_000_000;
  assert.ok(Math.abs(perToken - inputRate) / inputRate < 0.01, `priced at ${perToken * 1e6}/MTok, input rate ${inputRate * 1e6}/MTok`);
});

test('audit: potential savings of an oversized tool are scaled to the audit window, not a fixed week', () => {
  const db = openDb(':memory:');
  migrate(db);
  seedCacheHeavyUsage(db);
  const week = runAudit(db, { days: 7, source: 'claude-code', limit: 20 }).findings.find((f) => f.type === 'oversized_tool_response');
  const month = runAudit(db, { days: 28, source: 'claude-code', limit: 20 }).findings.find((f) => f.type === 'oversized_tool_response');
  assert.ok(week?.potentialSavingsUsd && month?.potentialSavingsUsd);
  // same calls, 4x the window => the per-week rate is 1/4, the window total is the same
  assert.ok(Math.abs(month.potentialSavingsUsd - week.potentialSavingsUsd) < 1e-6, `${month.potentialSavingsUsd} vs ${week.potentialSavingsUsd}`);
  assert.match(month.savingsBasis ?? '', /28-day/);
});

// ---------- 3. high-cost re-pricing keeps the 1-hour cache-write split ----------

test('high_cost_model_signal savings re-price 1h cache writes at the 1h rate (not as 5m writes)', () => {
  const db = openDb(':memory:');
  migrate(db);
  const e = tok({
    model: 'claude-opus-4-8', session_id: 'short-opus', input_tokens: 2_000, output_tokens: 200,
    cache_read_tokens: 10_000, cache_write_tokens: 400_000, cache_write_1h_tokens: 400_000,
  } as Partial<TokenEvent>);
  e.usd_estimate = estimateUsd({ model: e.model, input: 2_000, output: 200, cacheRead: 10_000, cacheWrite: 400_000, cacheWrite1h: 400_000 });
  insertTokenEvents(db, [e]);
  const f = runAudit(db, { days: 7, source: 'claude-code', limit: 20 }).findings.find((x) => x.type === 'high_cost_model_signal');
  assert.ok(f, 'expected a high_cost_model_signal finding');
  const ref = estimateUsd({ model: 'claude-sonnet-5-5', input: 2_000, output: 200, cacheRead: 10_000, cacheWrite: 400_000, cacheWrite1h: 400_000 });
  assert.ok(Math.abs(f.potentialSavingsUsd! - (e.usd_estimate - ref)) < 1e-4, `${f.potentialSavingsUsd} vs ${e.usd_estimate - ref}`);
});
