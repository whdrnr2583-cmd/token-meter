import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb, insertTokenEvents } from '../src/db.js';
import { runAudit } from '../src/audit/engine.js';
import { formatTerminal } from '../src/audit/reporters/terminal.js';
import { CACHE_INEFFICIENCY_MIN_TOKENS } from '../src/audit/config.js';
import { modelRates, estimateUsd } from '../src/pricing.js';
import type { TokenEvent } from '../src/types.js';

const NOW = Date.now() - 2 * 3_600_000;

function ev(over: Partial<TokenEvent>): TokenEvent {
  return {
    ts: NOW, source: 'claude-code', source_kind: 'cloud', model: 'claude-sonnet-4-6', project: '/p',
    session_id: 's1', request_id: `r-${Math.random()}`, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, total_duration_ms: null, tps: null, usd_estimate: 0, agent_id: null,
    ...over,
  };
}

function db() {
  const d = openDb(':memory:');
  migrate(d);
  return d;
}

test('cache_inefficiency savings = write premium only (write rate - input rate), not the whole write cost', () => {
  const d = db();
  const wasted = CACHE_INEFFICIENCY_MIN_TOKENS + 500_000;
  insertTokenEvents(d, [ev({ cache_write_tokens: wasted, cache_read_tokens: 0, input_tokens: 10, output_tokens: 10 })]);
  // cache_read must be > 0 for wasteSignals to flag the day
  insertTokenEvents(d, [ev({ cache_read_tokens: 1, input_tokens: 1 })]);
  const report = runAudit(d, { days: 7, source: 'claude-code', limit: 10 });
  const f = report.findings.find((x) => x.type === 'cache_inefficiency');
  assert.ok(f, 'expected a cache_inefficiency finding');
  const r = modelRates('claude-sonnet-4-6');
  const expected = ((wasted - 1) * (r.cacheWrite5m - r.input)) / 1_000_000;
  assert.ok(f.potentialSavingsUsd !== null && f.potentialSavingsUsd !== undefined);
  assert.ok(Math.abs(f.potentialSavingsUsd! - expected) < 0.01, `${f.potentialSavingsUsd} vs ${expected}`);
  assert.ok(f.estimatedCostUsd! > f.potentialSavingsUsd!, 'saving must be smaller than the write cost');
  assert.match(f.savingsBasis ?? '', /premium/i);
  assert.equal(report.summary.potentialSavingsUsd, f.potentialSavingsUsd);
});

test('high_cost_model_signal savings = observed cost minus the same tokens on the lower reference tier', () => {
  const d = db();
  const e = ev({
    model: 'claude-opus-4-8', session_id: 'short-opus', input_tokens: 20_000, output_tokens: 200,
    cache_read_tokens: 100_000, cache_write_tokens: 0,
  });
  e.usd_estimate = estimateUsd({ model: e.model, input: e.input_tokens, output: e.output_tokens, cacheRead: e.cache_read_tokens, cacheWrite: 0 });
  insertTokenEvents(d, [e]);
  const report = runAudit(d, { days: 7, source: 'claude-code', limit: 10 });
  const f = report.findings.find((x) => x.type === 'high_cost_model_signal');
  assert.ok(f, 'expected a high_cost_model_signal finding');
  const ref = estimateUsd({ model: 'claude-sonnet-5-5', input: 20_000, output: 200, cacheRead: 100_000, cacheWrite: 0 });
  const expected = e.usd_estimate - ref;
  assert.ok(expected > 0);
  assert.ok(Math.abs(f.potentialSavingsUsd! - expected) < 1e-4, `${f.potentialSavingsUsd} vs ${expected}`);
  assert.equal(f.confidence, 'low');
  assert.match(f.savingsBasis ?? '', /claude-sonnet-5-5/);
});

test('findings without an honest formula report null savings, and the terminal view shows savings only where present', () => {
  const d = db();
  const e = ev({ model: 'claude-opus-4-8', session_id: 'short-opus', input_tokens: 20_000, output_tokens: 200, usd_estimate: 5 });
  insertTokenEvents(d, [e]);
  const report = runAudit(d, { days: 7, source: 'claude-code', limit: 10 });
  for (const f of report.findings) {
    if (f.type === 'expensive_session' || f.type === 'slow_tool' || f.type === 'repeated_similar_tool_calls') {
      assert.equal(f.potentialSavingsUsd, null);
    }
  }
  const text = formatTerminal(report);
  if (report.summary.potentialSavingsUsd != null) assert.match(text, /Potential savings: ~\$/);
});

test('an empty report still carries potentialSavingsUsd: null in the JSON contract', () => {
  const report = runAudit(db(), { days: 7, limit: 5 });
  assert.equal(report.summary.potentialSavingsUsd, null);
});
