// Token Meter data quality audit.
// Checks invariants that must hold across all views. Any FAIL is a real bug.
const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const db = new Database(path.join(os.homedir(), '.tokenpulse', 'usage.db'));
db.pragma('foreign_keys = ON');

const issues = [];
const pass = (name) => console.log(`  ✅ ${name}`);
const fail = (name, detail) => {
  console.log(`  ❌ ${name}: ${detail}`);
  issues.push(`${name}: ${detail}`);
};
const warn = (name, detail) => console.log(`  ⚠  ${name}: ${detail}`);

const approxEqual = (a, b, eps = 0.005) => Math.abs(a - b) <= eps;
const usd = (n) => `$${n.toFixed(4)}`;

console.log('\n=== 1. USD conservation across views ===');
const total = db.prepare('SELECT COALESCE(SUM(usd_estimate),0) v FROM token_events').get().v;
const sumDaily = db.prepare(`
  SELECT COALESCE(SUM(usd),0) v FROM (
    SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch', 'localtime') d, SUM(usd_estimate) usd
    FROM token_events GROUP BY d
  )
`).get().v;
const sumModel = db.prepare(`
  SELECT COALESCE(SUM(usd),0) v FROM (
    SELECT model, SUM(usd_estimate) usd FROM token_events GROUP BY model
  )
`).get().v;
const sumProject = db.prepare(`
  SELECT COALESCE(SUM(usd),0) v FROM (
    SELECT project, SUM(usd_estimate) usd FROM token_events GROUP BY project
  )
`).get().v;
const sumSource = db.prepare(`
  SELECT COALESCE(SUM(usd),0) v FROM (
    SELECT source, SUM(usd_estimate) usd FROM token_events GROUP BY source
  )
`).get().v;
const sumSession = db.prepare(`
  SELECT COALESCE(SUM(usd),0) v FROM (
    SELECT session_id, SUM(usd_estimate) usd FROM token_events GROUP BY session_id
  )
`).get().v;

console.log(`  total      : ${usd(total)}`);
console.log(`  daily roll : ${usd(sumDaily)}`);
console.log(`  model roll : ${usd(sumModel)}`);
console.log(`  project    : ${usd(sumProject)}`);
console.log(`  source     : ${usd(sumSource)}`);
console.log(`  session    : ${usd(sumSession)}`);
[
  ['daily roll-up matches total', sumDaily, total],
  ['model roll-up matches total', sumModel, total],
  ['project roll-up matches total', sumProject, total],
  ['source roll-up matches total', sumSource, total],
  ['session roll-up matches total', sumSession, total],
].forEach(([name, a, b]) => approxEqual(a, b) ? pass(name) : fail(name, `${usd(a)} vs ${usd(b)} (diff ${usd(Math.abs(a - b))})`));

console.log('\n=== 2. Dedup invariant: (source, request_id) unique ===');
const dupRequests = db.prepare(`
  SELECT source, request_id, COUNT(*) c
  FROM token_events WHERE request_id IS NOT NULL
  GROUP BY source, request_id HAVING c > 1
`).all();
dupRequests.length === 0 ? pass('no duplicate (source, request_id)') : fail('duplicates', `${dupRequests.length} groups, e.g. ${JSON.stringify(dupRequests.slice(0,3))}`);

const nullReq = db.prepare(`SELECT COUNT(*) c FROM token_events WHERE request_id IS NULL`).get().c;
nullReq === 0 ? pass('no NULL request_ids (all sources have keys)') : warn('null request_ids present', `${nullReq} rows fall back to (session_id, ts, model)`);

console.log('\n=== 3. Pricing reproducibility ===');
// Re-import pricing.ts via dynamic require isn't trivial in cjs; reproduce inline.
// Keep this table in sync with src/pricing.ts — test/audit-pricing-sync.test.ts
// extracts this literal and cross-checks it against src/pricing.ts on every run.
const PRICES = {
  'claude-fable-5': { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite5m: 12.5 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-7': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-6': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-5': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite5m: 6.25 },
  'claude-opus-4-1': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-opus-4':   { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheRead: 0.20, cacheWrite5m: 2.50 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-sonnet-4':   { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-haiku-4-5':  { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite5m: 1.25 },
  'claude-haiku-4':    { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite5m: 1.25 },
  'gpt-5': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite5m: 0 },
  'gpt-5-codex': { input: 1.25, output: 10.0, cacheRead: 0.125, cacheWrite5m: 0 },
  'gpt-5-mini': { input: 0.25, output: 2.0, cacheRead: 0.025, cacheWrite5m: 0 },
  'gpt-4o': { input: 2.5, output: 10.0, cacheRead: 1.25, cacheWrite5m: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite5m: 0 },
};
function resolve(m) {
  const n = m.replace(/\[.*\]/, '').trim().toLowerCase();
  if (PRICES[n]) return PRICES[n];
  if (n.includes('fable')) return PRICES['claude-fable-5'];
  if (n.includes('opus')) return PRICES['claude-opus-4-8'];
  if (n.includes('haiku')) return PRICES['claude-haiku-4-5'];
  if (n.includes('sonnet')) return PRICES['claude-sonnet-5'];
  if (n.includes('gpt-5-codex')) return PRICES['gpt-5-codex'];
  if (n.includes('gpt-5-mini')) return PRICES['gpt-5-mini'];
  if (n.includes('gpt-5')) return PRICES['gpt-5'];
  if (n.includes('gpt-4o-mini')) return PRICES['gpt-4o-mini'];
  if (n.includes('gpt-4o')) return PRICES['gpt-4o'];
  return PRICES['claude-sonnet-4-6'];
}
function expectUsd({ model, input, output, cacheRead, cacheWrite }) {
  const p = resolve(model);
  const c = (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite5m) / 1_000_000;
  return Math.round(c * 1_000_000) / 1_000_000;
}
// Random sample across all history. Note: neither `ts` (event occurrence
// time) nor `id` (insertion order) reliably identifies "which pricing.ts
// was live when this row was priced" on a long-lived DB — force-reingest
// backfills old session files in scan order, not calendar order, so a
// recent-by-id row can carry a price frozen months ago and vice versa
// (verified empirically: id is non-monotonic in ts on this DB). Historical
// usd_estimate is intentionally never retroactively repriced after a
// pricing.ts rate change (usage history is preserved as-is), so *some*
// mismatches are expected on any DB that has lived through a price change —
// this is a visibility check, not a hard gate (see warn() below).
const sample = db.prepare(`SELECT * FROM token_events ORDER BY RANDOM() LIMIT 200`).all();
let mism = 0;
for (const r of sample) {
  const exp = expectUsd({ model: r.model, input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_write_tokens });
  if (!approxEqual(exp, r.usd_estimate, 0.0001)) { mism++; if (mism <= 3) console.log(`    mism ${r.model}: stored=${r.usd_estimate}, recomp=${exp}`); }
}
mism === 0
  ? pass(`pricing recomputable (${sample.length} samples)`)
  : warn('pricing mismatch (may be expected historical price snapshots, not necessarily a bug)', `${mism}/${sample.length} rows`);

console.log('\n=== 4. Temporal sanity ===');
const future = db.prepare(`SELECT COUNT(*) c FROM token_events WHERE ts > ?`).get(Date.now() + 60_000).c;
future === 0 ? pass('no future timestamps') : fail('future ts', `${future} rows`);
const ancient = db.prepare(`SELECT COUNT(*) c FROM token_events WHERE ts < 1704067200000`).get().c; // 2024-01-01
ancient === 0 ? pass('no pre-2024 timestamps') : warn('pre-2024 ts', `${ancient} rows`);
const negDur = db.prepare(`
  SELECT COUNT(*) c FROM (
    SELECT session_id, MIN(ts) s, MAX(ts) e FROM token_events GROUP BY session_id
  ) WHERE e < s
`).get().c;
negDur === 0 ? pass('no negative session durations') : fail('negative duration', `${negDur} sessions`);

console.log('\n=== 5. Tool event integrity ===');
const negLat = db.prepare(`SELECT COUNT(*) c FROM tool_events WHERE latency_ms < 0`).get().c;
negLat === 0 ? pass('no negative tool latencies') : fail('negative latency', `${negLat} rows`);
const dupTool = db.prepare(`
  SELECT tool_use_id, COUNT(*) c FROM tool_events GROUP BY tool_use_id HAVING c > 1
`).all();
dupTool.length === 0 ? pass('no duplicate tool_use_ids') : fail('duplicate tool_use_ids', `${dupTool.length}`);
const badMcp = db.prepare(`
  SELECT COUNT(*) c FROM tool_events
  WHERE (tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND mcp_server IS NULL)
     OR (tool_name NOT LIKE 'mcp\\_\\_%' ESCAPE '\\' AND mcp_server IS NOT NULL)
`).get().c;
badMcp === 0 ? pass('mcp_server flag matches tool_name prefix') : fail('mcp prefix mismatch', `${badMcp} rows`);

console.log('\n=== 6. Source-specific checks ===');
const ccZeroUsage = db.prepare(`
  SELECT COUNT(*) c FROM token_events
  WHERE source='claude-code' AND input_tokens=0 AND output_tokens=0 AND cache_read_tokens=0 AND cache_write_tokens=0
`).get().c;
ccZeroUsage === 0 ? pass('no all-zero Claude Code events') : warn('zero-usage Claude rows', `${ccZeroUsage} rows`);

const codexCount = db.prepare(`SELECT COUNT(*) c FROM token_events WHERE source='codex'`).get().c;
const codexDistinct = db.prepare(`SELECT COUNT(DISTINCT request_id) c FROM token_events WHERE source='codex'`).get().c;
codexCount === codexDistinct ? pass(`Codex synth ids unique (${codexCount} rows)`) : fail('Codex synth collision', `${codexCount} rows, ${codexDistinct} distinct`);

const codexBadModel = db.prepare(`SELECT COUNT(*) c FROM token_events WHERE source='codex' AND model NOT LIKE 'gpt%'`).get().c;
codexBadModel === 0 ? pass('Codex models all gpt-prefixed') : warn('Codex non-gpt models', `${codexBadModel} rows`);

console.log('\n=== 7. Rules engine integrity ===');
const rulesNoConfig = db.prepare(`SELECT COUNT(*) c FROM rules WHERE action_config IS NULL OR action_config=''`).get().c;
rulesNoConfig === 0 ? pass('all rules have action_config') : fail('rules missing config', `${rulesNoConfig}`);
const firingsOrphan = db.prepare(`SELECT COUNT(*) c FROM rule_firings WHERE rule_id NOT IN (SELECT id FROM rules)`).get().c;
firingsOrphan === 0 ? pass('no orphan rule firings') : fail('orphan firings', `${firingsOrphan}`);

console.log('\n=== 8. Ingest state consistency ===');
const ingestRows = db.prepare(`SELECT COUNT(*) c FROM ingest_state`).get().c;
const fs = require('fs');
let missing = 0;
for (const r of db.prepare('SELECT file FROM ingest_state').all()) {
  if (!fs.existsSync(r.file)) missing++;
}
console.log(`  ingest_state rows: ${ingestRows}`);
missing === 0 ? pass('all ingested files still exist') : warn('missing source files', `${missing} entries point to deleted files`);

console.log('\n=== Summary ===');
if (issues.length === 0) console.log('  ✅ ALL INVARIANTS HOLD\n');
else {
  console.log(`  ❌ ${issues.length} issue(s):`);
  for (const i of issues) console.log(`    - ${i}`);
  process.exit(1);
}
