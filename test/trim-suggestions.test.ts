import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { migrate, openDb } from '../src/db.js';
import { computeTrimSuggestions } from '../src/trim-suggestions.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'tm-trim-'));
  const path = join(dir, 'usage.db');
  const db = openDb(path);
  migrate(db);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

function seedToolEvents(
  db: ReturnType<typeof openDb>,
  opts: {
    tool_name: string;
    mcp_server?: string | null;
    count: number;
    response_tokens?: number;
    latency_ms?: number | null;
    file_ext?: string | null;
  },
): void {
  for (let i = 0; i < opts.count; i++) {
    const ts = Date.now() - i * 3_600_000;
    const sessionId = `sess-${opts.tool_name}-${i}`;
    // Need a matching token_event for the join in binary detector
    db.prepare(
      `INSERT OR IGNORE INTO token_events
        (ts, source, source_kind, model, project, session_id, request_id,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         usd_estimate)
       VALUES (?, 'claude-code', 'cloud', 'claude-sonnet-4-5',
               '/proj', ?, ?, 100, 50, 0, 0, 0.01)`,
    ).run(ts, sessionId, `req-tok-${opts.tool_name}-${i}`);
    db.prepare(
      `INSERT INTO tool_events
        (ts, source, project, session_id, tool_name, mcp_server,
         tool_use_id, response_chars, response_tokens_est, latency_ms, file_ext)
       VALUES (?, 'claude-code', '/proj', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ts,
      sessionId,
      opts.tool_name,
      opts.mcp_server ?? null,
      `use-${opts.tool_name}-${i}`,
      (opts.response_tokens ?? 100) * 4, // chars ≈ 4× tokens
      opts.response_tokens ?? 100,
      opts.latency_ms !== undefined ? opts.latency_ms : null,
      opts.file_ext ?? null,
    );
  }
}

test('computeTrimSuggestions returns empty array on empty DB', () => {
  const { db, cleanup } = freshDb();
  try {
    const suggestions = computeTrimSuggestions(db, 30);
    assert.equal(suggestions.length, 0);
  } finally {
    cleanup();
  }
});

test('large_response detector fires when avg tokens >= 5000 and calls >= 5', () => {
  const { db, cleanup } = freshDb();
  try {
    // 8 calls with avg 8000 tokens each
    seedToolEvents(db, {
      tool_name: 'notion.search_pages',
      mcp_server: 'notion',
      count: 8,
      response_tokens: 8000,
    });

    const suggestions = computeTrimSuggestions(db, 30);
    const large = suggestions.filter((s) => s.kind === 'large_response');
    assert.ok(large.length >= 1, 'should have at least 1 large_response suggestion');
    assert.equal(large[0].tool_name, 'notion.search_pages');
    assert.ok(large[0].savings_tokens_per_week > 0);
    assert.ok(large[0].action_text.length > 0);
  } finally {
    cleanup();
  }
});

test('large_response detector does NOT fire for low call count (< 5)', () => {
  const { db, cleanup } = freshDb();
  try {
    // Only 3 calls — below the threshold of 5
    seedToolEvents(db, {
      tool_name: 'rare_tool',
      count: 3,
      response_tokens: 9000,
    });

    const suggestions = computeTrimSuggestions(db, 30);
    const large = suggestions.filter(
      (s) => s.kind === 'large_response' && s.tool_name === 'rare_tool',
    );
    assert.equal(large.length, 0, 'should not fire for < 5 calls');
  } finally {
    cleanup();
  }
});

test('large_response detector does NOT fire for small responses', () => {
  const { db, cleanup } = freshDb();
  try {
    // 10 calls but only 200 tokens avg
    seedToolEvents(db, {
      tool_name: 'small_tool',
      count: 10,
      response_tokens: 200,
    });

    const suggestions = computeTrimSuggestions(db, 30);
    const large = suggestions.filter(
      (s) => s.kind === 'large_response' && s.tool_name === 'small_tool',
    );
    assert.equal(large.length, 0, 'should not fire for small responses');
  } finally {
    cleanup();
  }
});

test('high_latency detector fires when avg latency >= 3000ms and calls >= 5', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'slow_search',
      mcp_server: 'slow-mcp',
      count: 10,
      response_tokens: 500,
      latency_ms: 5000,
    });

    const suggestions = computeTrimSuggestions(db, 30);
    const latent = suggestions.filter((s) => s.kind === 'high_latency');
    assert.ok(latent.length >= 1, 'should have high_latency suggestion');
    assert.equal(latent[0].tool_name, 'slow_search');
    assert.ok(latent[0].evidence.includes('5,000ms') || latent[0].evidence.includes('5000ms'), 'evidence mentions latency');
  } finally {
    cleanup();
  }
});

test('high_latency detector does NOT fire for fast tools', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'fast_tool',
      count: 10,
      response_tokens: 500,
      latency_ms: 100,
    });

    const suggestions = computeTrimSuggestions(db, 30);
    const latent = suggestions.filter(
      (s) => s.kind === 'high_latency' && s.tool_name === 'fast_tool',
    );
    assert.equal(latent.length, 0, 'should not fire for fast tools');
  } finally {
    cleanup();
  }
});

test('results are capped at 5 suggestions', () => {
  const { db, cleanup } = freshDb();
  try {
    // Seed many large tools
    for (let i = 0; i < 12; i++) {
      seedToolEvents(db, {
        tool_name: `big_tool_${i}`,
        count: 8,
        response_tokens: 6000 + i * 100,
      });
    }
    const suggestions = computeTrimSuggestions(db, 30);
    assert.ok(suggestions.length <= 5, `expected <= 5 suggestions, got ${suggestions.length}`);
  } finally {
    cleanup();
  }
});

test('suggestions are sorted by savings_tokens_per_week descending', () => {
  const { db, cleanup } = freshDb();
  try {
    // Two tools: one bigger than the other
    seedToolEvents(db, { tool_name: 'small_big', count: 8, response_tokens: 6000 });
    seedToolEvents(db, { tool_name: 'very_big', count: 8, response_tokens: 12000 });
    const suggestions = computeTrimSuggestions(db, 30);
    // All large_response suggestions should be sorted descending
    const large = suggestions.filter((s) => s.kind === 'large_response');
    for (let i = 1; i < large.length; i++) {
      assert.ok(
        large[i - 1].savings_tokens_per_week >= large[i].savings_tokens_per_week,
        'not sorted descending',
      );
    }
  } finally {
    cleanup();
  }
});

// ── New tests covering the three bug-fixes ────────────────────────────────────

test('repeated_binary: many token_events per session do NOT inflate tool call count (JOIN fix)', () => {
  // Bug: old query JOINed token_events on session_id, so each tool_event row was
  // multiplied by the number of token_events in the same session. Verify that
  // adding many token_events for a session does NOT change the reported call count.
  const { db, cleanup } = freshDb();
  try {
    const ts = Date.now();
    const sessionId = 'sess-inflate-test';
    // Insert 15 token_events for the same session (this multiplied COUNT(*) 15x before fix).
    for (let i = 0; i < 15; i++) {
      db.prepare(
        `INSERT OR IGNORE INTO token_events
          (ts, source, source_kind, model, project, session_id, request_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_estimate)
         VALUES (?, 'claude-code', 'cloud', 'claude-sonnet-4-5', '/proj', ?, ?, 100, 50, 0, 0, 0.01)`,
      ).run(ts - i * 1000, sessionId, `req-inflate-${i}`);
    }
    // Insert exactly 12 read tool_events in that same session (threshold is 10).
    for (let i = 0; i < 12; i++) {
      db.prepare(
        `INSERT INTO tool_events
          (ts, source, project, session_id, tool_name, mcp_server,
           tool_use_id, response_chars, response_tokens_est, latency_ms)
         VALUES (?, 'claude-code', '/proj', ?, 'Read', NULL, ?, ?, ?, NULL)`,
      ).run(ts - i * 1000, sessionId, `use-inflate-${i}`, 400, 100);
    }
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary');
    // Must fire (12 calls >= threshold of 10) but evidence must reflect
    // exactly 12 calls, not the inflated 12*15=180 that the JOIN bug produced.
    assert.ok(bin.length >= 1, 'should fire for 12 read calls');
    // The evidence string contains the actual call count — must be 12, not inflated.
    assert.ok(
      bin[0].evidence.includes('12 times'),
      `evidence should say "12 times" but got: ${bin[0].evidence}`,
    );
  } finally {
    cleanup();
  }
});

test('repeated_binary: fires for high-frequency read tool (>= 10 calls in window)', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, { tool_name: 'Read', count: 12, response_tokens: 300 });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary');
    assert.ok(bin.length >= 1, 'should fire for 12 Read calls');
    assert.equal(bin[0].tool_name, 'Read');
    assert.ok(bin[0].action_text.includes('png,jpg,svg,pdf'), 'action_text mentions file extensions');
  } finally {
    cleanup();
  }
});

test('repeated_binary: does NOT fire for read tool called < 10 times', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, { tool_name: 'Read', count: 9, response_tokens: 300 });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary');
    assert.equal(bin.length, 0, 'should not fire for < 10 calls');
  } finally {
    cleanup();
  }
});

test('repeated_binary: does NOT fire for non-read tools regardless of call count', () => {
  const { db, cleanup } = freshDb();
  try {
    // A high-call non-read tool should not trigger repeated_binary
    seedToolEvents(db, { tool_name: 'Bash', count: 50, response_tokens: 200 });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary');
    assert.equal(bin.length, 0, 'Bash should not trigger repeated_binary');
  } finally {
    cleanup();
  }
});

// ── Backlog chain A, item 5: real file_ext-based REPEATED_BINARY ─────────────

test('repeated_binary: fires on tool_events.file_ext match for a non-read-named tool', () => {
  // A tool whose name gives no "read" hint (so the old heuristic would never
  // catch it) but whose captured file_ext is a binary/image extension.
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'cat_file',
      count: 10,
      response_tokens: 500,
      file_ext: 'png',
    });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary' && s.tool_name === 'cat_file');
    assert.ok(bin.length >= 1, 'should fire for 10 calls reading .png files');
    assert.ok(bin[0].evidence.includes('.png'), 'evidence mentions the matched extension');
    assert.ok(bin[0].action_text.includes('.png'), 'action_text mentions the matched extension');
  } finally {
    cleanup();
  }
});

test('repeated_binary: file_ext match does NOT fire below the call threshold', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'cat_file',
      count: 9,
      response_tokens: 500,
      file_ext: 'pdf',
    });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary' && s.tool_name === 'cat_file');
    assert.equal(bin.length, 0, 'should not fire for < 10 calls even with a binary file_ext');
  } finally {
    cleanup();
  }
});

test('repeated_binary: non-binary file_ext does NOT fire', () => {
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'cat_file',
      count: 20,
      response_tokens: 500,
      file_ext: 'ts',
    });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary' && s.tool_name === 'cat_file');
    assert.equal(bin.length, 0, 'a source-code extension should not trigger the binary detector');
  } finally {
    cleanup();
  }
});

test('repeated_binary: Read calls with a binary file_ext do not double-count against the fallback', () => {
  // A "Read"-named tool with a captured binary file_ext must be attributed to
  // the file_ext detector only — not also counted by the high-frequency-read
  // fallback (which is scoped to file_ext IS NULL).
  const { db, cleanup } = freshDb();
  try {
    seedToolEvents(db, {
      tool_name: 'Read',
      count: 12,
      response_tokens: 300,
      file_ext: 'jpg',
    });
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary' && s.tool_name === 'Read');
    assert.equal(bin.length, 1, 'exactly one repeated_binary suggestion for Read, not one per detector');
    assert.ok(bin[0].evidence.includes('.jpg'));
  } finally {
    cleanup();
  }
});

// ── H6: aggregate REPEATED_BINARY across extensions per (tool_name, mcp_server) ──

test('repeated_binary: multiple binary extensions on the same (tool_name, mcp_server) collapse into ONE suggestion, not one per extension', () => {
  // Before the fix, a tool reading both .png and .jpg files fired TWO
  // near-duplicate repeated_binary suggestions (grouped per file_ext),
  // eating into the final slice(0, 5) top-5 cutoff. Must collapse to one.
  const { db, cleanup } = freshDb();
  try {
    const ts = Date.now();
    for (const ext of ['png', 'jpg']) {
      for (let i = 0; i < 10; i++) {
        const sessionId = `sess-multi-ext-${ext}-${i}`;
        db.prepare(
          `INSERT OR IGNORE INTO token_events
            (ts, source, source_kind, model, project, session_id, request_id,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd_estimate)
           VALUES (?, 'claude-code', 'cloud', 'claude-sonnet-4-5', '/proj', ?, ?, 100, 50, 0, 0, 0.01)`,
        ).run(ts - i * 1000, sessionId, `req-multi-ext-${ext}-${i}`);
        db.prepare(
          `INSERT INTO tool_events
            (ts, source, project, session_id, tool_name, mcp_server,
             tool_use_id, response_chars, response_tokens_est, latency_ms, file_ext)
           VALUES (?, 'claude-code', '/proj', ?, 'cat_file', NULL, ?, 400, 100, NULL, ?)`,
        ).run(ts - i * 1000, sessionId, `use-multi-ext-${ext}-${i}`, ext);
      }
    }
    const suggestions = computeTrimSuggestions(db, 30);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary' && s.tool_name === 'cat_file');
    assert.equal(bin.length, 1, 'exactly one aggregated suggestion, not one per extension');
    assert.ok(bin[0].evidence.includes('.jpg') && bin[0].evidence.includes('.png'), 'evidence lists both matched extensions');
    assert.ok(bin[0].evidence.includes('20 times'), 'call count combines both extensions (10 + 10)');
    assert.ok(bin[0].action_text.includes('jpg') && bin[0].action_text.includes('png'), 'action_text mentions both extensions');
  } finally {
    cleanup();
  }
});

test('repeated_binary: time window is respected (old calls outside window ignored)', () => {
  // Verifies that the WHERE ts >= ? filter applies to ALL rows in the detector
  // (the old GLOB/OR precedence bug let some rows bypass the time filter).
  const { db, cleanup } = freshDb();
  try {
    const now = Date.now();
    const days = 7;
    const windowMs = days * 86_400_000;
    // Insert 12 tool_events that are OUTSIDE the 7-day window.
    for (let i = 0; i < 12; i++) {
      db.prepare(
        `INSERT INTO tool_events
          (ts, source, project, session_id, tool_name, mcp_server,
           tool_use_id, response_chars, response_tokens_est, latency_ms)
         VALUES (?, 'claude-code', '/proj', ?, 'Read', NULL, ?, 400, 100, NULL)`,
      ).run(
        now - windowMs - (i + 1) * 3_600_000, // all older than 7 days
        `sess-old-${i}`,
        `use-old-${i}`,
      );
    }
    // Also insert 2 tool_events that ARE inside the window (not enough to cross threshold).
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO tool_events
          (ts, source, project, session_id, tool_name, mcp_server,
           tool_use_id, response_chars, response_tokens_est, latency_ms)
         VALUES (?, 'claude-code', '/proj', ?, 'Read', NULL, ?, 400, 100, NULL)`,
      ).run(now - i * 3_600_000, `sess-new-${i}`, `use-new-${i}`);
    }
    const suggestions = computeTrimSuggestions(db, days);
    const bin = suggestions.filter((s) => s.kind === 'repeated_binary');
    assert.equal(bin.length, 0, 'should not fire when recent calls are below threshold');
  } finally {
    cleanup();
  }
});
