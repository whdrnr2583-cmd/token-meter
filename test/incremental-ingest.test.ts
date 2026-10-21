import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type Database from 'better-sqlite3';

import { migrate, openDb } from '../src/db.js';
import { ingestAll } from '../src/ingest.js';

// ---------- helpers ----------

function withHome<T>(home: string, fn: () => T): T {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, F: process.env.TOKEN_METER_FULL_REPARSE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.TOKEN_METER_FULL_REPARSE;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries({ HOME: prev.HOME, USERPROFILE: prev.USERPROFILE, TOKEN_METER_FULL_REPARSE: prev.F })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString();

function claudeAssistant(sec: number, requestId: string, usage: Record<string, unknown>, content: unknown[] = [], model = 'claude-sonnet-4-5') {
  return JSON.stringify({ type: 'assistant', timestamp: iso(sec), requestId, sessionId: 'sess-a', message: { model, usage, content } });
}
function claudeResult(sec: number, id: string, text: string) {
  return JSON.stringify({ type: 'user', timestamp: iso(sec), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
}

function claudeMainLines(): string[] {
  return [
    // R1 streams in 3 entries with growing output; tool_use T1 in the first
    claudeAssistant(0, 'R1', { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000 }, [{ type: 'tool_use', id: 'T1', name: 'mcp__srv__query', input: { file_path: '/a/b.PNG' } }]),
    claudeAssistant(1, 'R1', { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 1000 }),
    claudeAssistant(2, 'R1', { input_tokens: 100, output_tokens: 90, cache_read_input_tokens: 1000 }),
    claudeResult(5, 'T1', '한글 응답 😀 '.repeat(300)),
    // R2: cache writes split 5m/1h, tool_use T2 never answered
    claudeAssistant(10, 'R2', { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5000, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 2000 } }, [{ type: 'tool_use', id: 'T2', name: 'Read', input: {} }]),
    // R3 identical duplicate pair (tie): later one must win in every split
    claudeAssistant(20, 'R3', { input_tokens: 7, output_tokens: 7 }, [{ type: 'tool_use', id: 'T3', name: 'Bash', input: {} }]),
    claudeAssistant(21, 'R3', { input_tokens: 7, output_tokens: 7 }),
    claudeResult(25, 'T3', 'ok'),
    // different model, later day, result arrives long after its tool_use
    claudeAssistant(86400 + 5, 'R4', { input_tokens: 1, output_tokens: 2 }, [{ type: 'tool_use', id: 'T4', name: 'Grep', input: {} }], 'claude-opus-4-8'),
    claudeAssistant(86400 + 6, 'R5', { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 9 }, [], 'claude-opus-4-8'),
    claudeResult(86400 + 60, 'T4', 'x'.repeat(5000)),
    JSON.stringify({ type: 'summary', note: 'ignored line' }),
    'not json at all',
    claudeAssistant(2 * 86400, 'R6', { input_tokens: 50, output_tokens: 60 }),
  ];
}

function claudeSubagentLines(): string[] {
  return [
    claudeAssistant(100, 'SA1', { input_tokens: 5, output_tokens: 1 }, [{ type: 'tool_use', id: 'ST1', name: 'Read', input: {} }], 'claude-haiku-4-5'),
    claudeAssistant(101, 'SA1', { input_tokens: 5, output_tokens: 300 }, [], 'claude-haiku-4-5'),
    claudeResult(103, 'ST1', 'sub result'),
    claudeAssistant(110, 'SA2', { input_tokens: 9, output_tokens: 9 }, [], 'claude-haiku-4-5'),
  ];
}

function cx(sec: number, type: string, payload: unknown) {
  return JSON.stringify({ timestamp: iso(sec), type, payload });
}
const tcount = (sec: number, last: Record<string, number>, total?: Record<string, number>) =>
  cx(sec, 'event_msg', { type: 'token_count', info: { last_token_usage: last, ...(total ? { total_token_usage: total } : {}) } });

function codexLines(): string[] {
  const l1 = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 150 };
  const l2 = { input_tokens: 220, cached_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 250 };
  return [
    cx(0, 'session_meta', { id: 'codex-session-0123456789abcdef', cwd: '/work/x', base_instructions: { text: 'You are based on GPT-5' } }),
    cx(1, 'turn_context', { model: 'gpt-5.4' }),
    cx(2, 'response_item', { type: 'function_call', call_id: 'c1', name: 'shell' }),
    tcount(3, l1, l1),
    cx(4, 'response_item', { type: 'function_call_output', call_id: 'c1', output: '결과 '.repeat(100) }),
    tcount(5, l1, l1), // stale repeat of the cumulative total
    cx(6, 'response_item', { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch' }),
    cx(7, 'turn_context', { model: 'gpt-5.5' }),
    tcount(8, l2, { input_tokens: 320, cached_input_tokens: 140, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 400 }),
    cx(9, 'response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: { a: 1, b: [1, 2, 3] } }),
    cx(10, 'response_item', { type: 'function_call', call_id: 'c3', name: 'never_answered' }),
    tcount(11, { input_tokens: 5, output_tokens: 6, total_tokens: 11 }),
  ];
}

interface Layout { home: string; claudeMain: string; claudeSub: string; subMeta: string; codex: string }

function layout(home: string): Layout {
  const proj = join(home, '.claude', 'projects', '-work-my-proj');
  const subDir = join(proj, 'sess-a', 'subagents');
  const codexDir = join(home, '.codex', 'sessions', '2026', '10', '01');
  mkdirSync(subDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  return {
    home,
    claudeMain: join(proj, 'sess-a.jsonl'),
    claudeSub: join(subDir, 'agent-abc123.jsonl'),
    subMeta: join(subDir, 'agent-abc123.meta.json'),
    codex: join(codexDir, 'rollout-2026-10-01T10-00-00-codex.jsonl'),
  };
}

const FILES = () => ({
  main: claudeMainLines().join('\n') + '\n',
  sub: claudeSubagentLines().join('\n') + '\n',
  codex: codexLines().join('\n') + '\n',
});

function dump(db: Database.Database): unknown {
  const tok = db.prepare(
    `SELECT ts, source, source_kind, model, project, session_id, request_id, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, usd_estimate, agent_id, tps, ttft_ms
     FROM token_events ORDER BY source, request_id`,
  ).all();
  const tools = db.prepare(
    `SELECT ts, source, project, session_id, tool_name, mcp_server, tool_use_id, response_chars,
            response_tokens_est, latency_ms, agent_id, file_ext FROM tool_events ORDER BY tool_use_id`,
  ).all();
  const meta = db.prepare(`SELECT * FROM agent_meta ORDER BY agent_id`).all();
  // The aggregates every dashboard view is built from.
  const agg = db.prepare(
    `SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') d, model, COUNT(*) n, SUM(usd_estimate) usd,
            SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_tokens) cr, SUM(cache_write_tokens) cw
     FROM token_events GROUP BY d, model ORDER BY d, model`,
  ).all();
  return { tok, tools, meta, agg };
}

/** Ground truth: write the finished files, ingest once. */
function fullResult(): unknown {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-full-'));
  try {
    const L = layout(home);
    const f = FILES();
    writeFileSync(L.claudeMain, f.main);
    writeFileSync(L.claudeSub, f.sub);
    writeFileSync(L.subMeta, JSON.stringify({ agentType: 'Explore', description: 'looks around' }));
    writeFileSync(L.codex, f.codex);
    return withHome(home, () => {
      const db = openDb(':memory:');
      migrate(db);
      ingestAll(db);
      return dump(db);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Grow the same files through the given byte cut fractions, ingesting after each step. */
function stagedResult(cutsFor: (len: number) => number[], opts: { env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-stage-'));
  try {
    const L = layout(home);
    const f = FILES();
    const bufs = { main: Buffer.from(f.main), sub: Buffer.from(f.sub), codex: Buffer.from(f.codex) };
    const cuts = {
      main: cutsFor(bufs.main.length), sub: cutsFor(bufs.sub.length), codex: cutsFor(bufs.codex.length),
    };
    const steps = Math.max(cuts.main.length, cuts.sub.length, cuts.codex.length);
    return withHome(home, () => {
      for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
      const db = openDb(':memory:');
      migrate(db);
      writeFileSync(L.subMeta, JSON.stringify({ agentType: 'Explore', description: 'looks around' }));
      let incremental = 0;
      for (let s = 0; s <= steps; s++) {
        const at = (name: 'main' | 'sub' | 'codex') => (s < cuts[name].length ? cuts[name][s]! : bufs[name].length);
        writeFileSync(L.claudeMain, bufs.main.subarray(0, at('main')));
        writeFileSync(L.claudeSub, bufs.sub.subarray(0, at('sub')));
        writeFileSync(L.codex, bufs.codex.subarray(0, at('codex')));
        const r = ingestAll(db);
        incremental += r.claude_code.files_incremental + r.codex.files_incremental;
      }
      delete process.env.TOKEN_METER_FULL_REPARSE;
      return { result: dump(db), incremental };
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// mulberry32, so every run exercises the same splits
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- differential tests ----------

const TRUTH = fullResult();

test('ground truth is non-trivial (guards the differential tests against vacuous passes)', () => {
  const t = TRUTH as { tok: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>>; meta: unknown[] };
  assert.ok(t.tok.length === 11, `tokens ${t.tok.length}`);
  assert.ok(t.tok.some((r) => r.agent_id === 'agent-abc123'));
  assert.ok(t.tok.some((r) => r.source === 'codex'));
  assert.ok(t.tok.some((r) => (r.cache_write_1h_tokens as number) === 2000));
  assert.ok(t.tools.some((r) => r.tool_use_id === 'T4' && r.latency_ms === 55000), 'late tool_result paired');
  assert.ok(t.tools.some((r) => r.tool_use_id === 'c2' && r.source === 'codex'));
  assert.ok(!t.tools.some((r) => r.tool_use_id === 'T2' || r.tool_use_id === 'c3'), 'unanswered calls produce no event');
  assert.equal(t.meta.length, 1);
});

test('differential: ONE split at every newline boundary => identical to a single full parse (rows, ts, usd, aggregates)', () => {
  const lens = new Set<number>();
  const f = FILES();
  // every line boundary of the largest fixture, applied proportionally to all three files
  const boundaries: number[] = [];
  let pos = 0;
  for (const line of f.main.split('\n')) { pos += Buffer.byteLength(line) + 1; boundaries.push(pos); }
  let incremental = 0;
  for (const b of boundaries.slice(0, -1)) {
    lens.add(b);
    const r = stagedResult((len) => [Math.min(b, len)]);
    assert.deepEqual(r.result, TRUTH, `split at byte ${b}`);
    incremental += r.incremental;
  }
  assert.ok(incremental > 0, 'the incremental path must actually have been exercised');
});

test('differential: splits in the MIDDLE of lines and of multi-byte characters (unterminated tails)', () => {
  const rand = rng(42);
  let incremental = 0;
  for (let i = 0; i < 60; i++) {
    const r = stagedResult((len) => [Math.floor(rand() * len)]);
    assert.deepEqual(r.result, TRUTH, `iteration ${i}`);
    incremental += r.incremental;
  }
  assert.ok(incremental > 0);
});

test('differential: 2-6 growth steps with random cut points, cuts differing per file', () => {
  const rand = rng(7);
  let incremental = 0;
  for (let i = 0; i < 80; i++) {
    const n = 2 + Math.floor(rand() * 5);
    const fractions = Array.from({ length: n }, () => rand()).sort();
    const jitter = rand;
    const r = stagedResult((len) => fractions.map((p) => Math.floor(Math.min(0.999, p * (0.85 + jitter() * 0.3)) * len)).sort((a, b) => a - b));
    assert.deepEqual(r.result, TRUTH, `iteration ${i}: ${fractions.join(',')}`);
    incremental += r.incremental;
  }
  assert.ok(incremental > 100, `expected many incremental parses, got ${incremental}`);
});

test('the full-reparse escape hatch (TOKEN_METER_FULL_REPARSE=1) never resumes and gives the same result', () => {
  const r = stagedResult((len) => [Math.floor(len * 0.4), Math.floor(len * 0.7)], { env: { TOKEN_METER_FULL_REPARSE: '1' } });
  assert.equal(r.incremental, 0);
  assert.deepEqual(r.result, TRUTH);
});

test('a file without a trailing newline still ends up identical (final line billed once, not lost)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-nonl-'));
  try {
    const L = layout(home);
    const body = claudeMainLines().join('\n'); // no trailing \n
    withHome(home, () => {
      const db = openDb(':memory:'); migrate(db);
      writeFileSync(L.claudeMain, body.slice(0, body.length >> 1));
      ingestAll(db);
      writeFileSync(L.claudeMain, body);
      ingestAll(db);
      const staged = dump(db);
      const db2 = openDb(':memory:'); migrate(db2);
      ingestAll(db2, { force: true });
      assert.deepEqual(staged, dump(db2));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------- safety fallbacks ----------

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-fb-'));
  const L = layout(home);
  const lines = claudeMainLines();
  writeFileSync(L.claudeMain, lines.slice(0, 6).join('\n') + '\n');
  const db = openDb(':memory:'); migrate(db);
  return { home, L, db, lines };
}

test('fallback: a file edited in its first bytes (same prefix length, then grown) is re-parsed in full', () => {
  const { home, L, db, lines } = setup();
  try {
    withHome(home, () => {
      ingestAll(db);
      // rewrite request ids in the head AND grow: append-only assumption is violated
      const edited = lines.slice(0, 6).join('\n').replace('"R1"', '"RX"') + '\n' + lines.slice(6).join('\n') + '\n';
      writeFileSync(L.claudeMain, edited);
      const r = ingestAll(db);
      assert.equal(r.claude_code.files_incremental, 0);
      const ids = (db.prepare(`SELECT request_id FROM token_events WHERE session_id='sess-a'`).all() as Array<{ request_id: string }>).map((x) => x.request_id);
      assert.ok(ids.includes('RX'));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('fallback: shrunk file, replaced file (new inode), state from an older version => full parse', () => {
  const { home, L, db, lines } = setup();
  try {
    withHome(home, () => {
      ingestAll(db);
      // shrink
      truncateSync(L.claudeMain, 200);
      assert.equal(ingestAll(db).claude_code.files_incremental, 0);
      // replaced by a different file that is longer than the recorded one
      writeFileSync(L.claudeMain, lines.slice(0, 6).join('\n') + '\n');
      ingestAll(db);
      const tmp = L.claudeMain + '.new';
      writeFileSync(tmp, lines.join('\n') + '\n');
      renameSync(tmp, L.claudeMain);
      assert.equal(ingestAll(db).claude_code.files_incremental, 0, 'new inode');
      // simulate a row written by the previous version: no state
      db.prepare(`UPDATE ingest_state SET state_json = NULL, head_hash = NULL, tail_hash = NULL`).run();
      appendFileSync(L.claudeMain, claudeAssistant(999999, 'RZ', { input_tokens: 1, output_tokens: 1 }) + '\n');
      assert.equal(ingestAll(db).claude_code.files_incremental, 0, 'legacy row');
      // and the very next growth is incremental again
      appendFileSync(L.claudeMain, claudeAssistant(999999 + 5, 'RY', { input_tokens: 2, output_tokens: 2 }) + '\n');
      assert.equal(ingestAll(db).claude_code.files_incremental, 1);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('fallback: pure append resumes, and unchanged files are skipped without parsing', () => {
  const { home, L, db, lines } = setup();
  try {
    withHome(home, () => {
      assert.equal(ingestAll(db).claude_code.files_processed, 1);
      assert.equal(ingestAll(db).claude_code.files_processed, 0);
      appendFileSync(L.claudeMain, lines.slice(6, 8).join('\n') + '\n');
      const r = ingestAll(db);
      assert.equal(r.claude_code.files_incremental, 1);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('migration: an existing database gains the new ingest_state columns without losing rows', () => {
  const db = openDb(':memory:');
  db.exec(`CREATE TABLE ingest_state (file TEXT PRIMARY KEY, mtime_ms INTEGER NOT NULL, size INTEGER NOT NULL,
           last_offset INTEGER NOT NULL DEFAULT 0, processed_at INTEGER NOT NULL);
           INSERT INTO ingest_state VALUES ('/old/file.jsonl', 1, 2, 2, 3);`);
  migrate(db);
  migrate(db); // idempotent
  const row = db.prepare(`SELECT * FROM ingest_state`).get() as Record<string, unknown>;
  assert.equal(row.file, '/old/file.jsonl');
  assert.equal(row.state_json, null);
  for (const c of ['head_hash', 'tail_hash', 'ino']) assert.ok(c in row);
});

// ---------- tests added after mutation checking ----------

import { readLineItems } from '../src/jsonl-lines.js';
import { ingestClaudeCode } from '../src/ingest.js';
import { parseJsonlFile } from '../src/parser.js';
import { parseCodexSession } from '../src/codex-parser.js';

test('readLineItems: end offsets are byte-exact (multi-byte text, any chunk size) and the unterminated tail is flagged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-inc-off-'));
  try {
    const f = join(dir, 'x.jsonl');
    const text = ['{"a":"한글🙂"}', '', '{"b":1}', 'tail-no-newline'];
    writeFileSync(f, text.join('\n'));
    const total = Buffer.byteLength(text.join('\n'));
    for (const chunk of [1, 3, 7, 4096]) {
      const items = [...readLineItems(f, 0, chunk)];
      assert.deepEqual(items.map((i) => i.line), text);
      assert.deepEqual(items.map((i) => i.terminated), [true, true, true, false]);
      let expect = 0;
      for (const [i, line] of text.entries()) {
        expect += Buffer.byteLength(line) + (i < 3 ? 1 : 0);
        assert.equal(items[i]!.end, expect, `chunk ${chunk} line ${i}`);
      }
      assert.equal(items[3]!.end, total);
    }
    // resuming at a line start yields the same remaining lines with absolute offsets
    const second = Buffer.byteLength(text[0]!) + 1;
    const rest = [...readLineItems(f, second, 5)];
    assert.deepEqual(rest.map((i) => i.line), text.slice(1));
    assert.equal(rest[rest.length - 1]!.end, total);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an append is parsed from the saved offset: only the new bytes are read', () => {
  const { home, L, db, lines } = setup();
  try {
    withHome(home, () => {
      ingestClaudeCode(db);
      const prior = db.prepare(`SELECT last_offset, size FROM ingest_state`).get() as { last_offset: number; size: number };
      assert.equal(prior.last_offset, prior.size);
      appendFileSync(L.claudeMain, lines.slice(6, 8).join('\n') + '\n');
      const seen: Array<{ start: number | undefined; tokens: number }> = [];
      ingestClaudeCode(db, {
        parse: (p, proj, agent, opts) => {
          const r = parseJsonlFile(p, proj, agent, opts);
          seen.push({ start: opts?.startOffset, tokens: r.tokens.length });
          return r;
        },
      });
      assert.deepEqual(seen, [{ start: prior.size, tokens: 1 }]); // the R3 pair (one request) only, not the 5 earlier requests
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a complete last line WITHOUT a newline is not consumed: a tool_result there still pairs after the newline arrives (Claude)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-tail-'));
  try {
    const L = layout(home);
    const use = claudeAssistant(0, 'Q1', { input_tokens: 1, output_tokens: 1 }, [{ type: 'tool_use', id: 'TQ', name: 'Read', input: {} }]);
    const res = claudeResult(3, 'TQ', 'hello');
    withHome(home, () => {
      const db = openDb(':memory:'); migrate(db);
      writeFileSync(L.claudeMain, use + '\n' + res); // result line complete but unterminated
      ingestAll(db);
      appendFileSync(L.claudeMain, '\n');
      ingestAll(db);
      const staged = dump(db);
      const db2 = openDb(':memory:'); migrate(db2);
      ingestAll(db2, { force: true });
      assert.deepEqual(staged, dump(db2));
      assert.equal((staged as { tools: unknown[] }).tools.length, 1);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('same for Codex: pending call + unterminated complete output line + stale-total state', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-inc-tailcx-'));
  try {
    const L = layout(home);
    const lines = codexLines();
    const head = lines.slice(0, 3).join('\n') + '\n'; // meta, turn_context, function_call c1
    const out = lines[4]!; // function_call_output c1 (complete JSON)
    withHome(home, () => {
      const db = openDb(':memory:'); migrate(db);
      writeFileSync(L.codex, head + out);
      ingestAll(db);
      appendFileSync(L.codex, '\n' + lines[3] + '\n' + lines.slice(5).join('\n') + '\n');
      ingestAll(db);
      const db2 = openDb(':memory:'); migrate(db2);
      writeFileSync(L.codex, head + out + '\n' + lines[3] + '\n' + lines.slice(5).join('\n') + '\n');
      ingestAll(db2, { force: true });
      assert.deepEqual(dump(db), dump(db2));
      assert.ok((dump(db) as { tools: Array<{ tool_use_id: string }> }).tools.some((t) => t.tool_use_id === 'c1'));
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('parse state is exposed for both parsers and resumes to the same result as one pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-inc-unit-'));
  try {
    const f = join(dir, 'rollout.jsonl');
    const lines = codexLines();
    writeFileSync(f, lines.slice(0, 5).join('\n') + '\n');
    const a = parseCodexSession(f);
    assert.ok(a.state && a.state.sessionId.startsWith('codex-session'));
    writeFileSync(f, lines.join('\n') + '\n');
    const b = parseCodexSession(f, { startOffset: a.endOffset, state: a.state });
    const whole = parseCodexSession(f);
    assert.deepEqual([...a.tokens, ...b.tokens], whole.tokens);
    assert.deepEqual([...a.tools, ...b.tools], whole.tools);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
