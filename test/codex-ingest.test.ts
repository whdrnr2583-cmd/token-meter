import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { migrate, openDb } from '../src/db.js';
import { ingestCodex, codexSessionsDir, codexSessionsDirs } from '../src/codex-ingest.js';
import { isWsl } from '../src/platform.js';

/**
 * Backlog chain B, item 2 regression: on a WSL machine whose Codex CLI only
 * ever ran on the Windows side, `~/.codex/sessions` (the WSL home path) is
 * ENOENT while every real session sits under
 * `/mnt/c/Users/<profile>/.codex/sessions` — ingestCodex() previously only
 * ever scanned the single hardcoded WSL-home base and silently ingested $0
 * (observed on this dev machine: 53 real sessions, 100% under the Windows
 * path). codexSessionsDirs() adds the Windows-side fallback, mirroring
 * claudeProjectsDirs() in ingest.ts.
 */

test('codexSessionsDirs() always has the WSL-home path first, with no duplicate directories', () => {
  const dirs = codexSessionsDirs();
  assert.ok(dirs.length >= 1);
  assert.equal(dirs[0], codexSessionsDir());
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicate directories');
});

test('codexSessionsDirs() picks up the real Windows-side .codex/sessions dir(s) when running under WSL', () => {
  if (!isWsl()) {
    // Off WSL, scanWindowsUserDirs() is a no-op by contract — nothing more to check.
    assert.equal(codexSessionsDirs().length, 1);
    return;
  }
  const dirs = codexSessionsDirs();
  const winPattern = /^\/mnt\/c\/Users\/[^/]+\/\.codex\/sessions$/;
  const winDirs = dirs.filter((d) => winPattern.test(d));
  // Read-only check — every returned Windows-side path must actually exist
  // on disk (never written to by this test).
  for (const d of winDirs) assert.ok(existsSync(d), `${d} was returned but does not exist`);
});

test('ingestCodex() loops over every codexSessionsDirs() base and still ingests a fixture placed at the WSL-home path', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'tm-codex-ingest-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    const sessionsDir = join(fakeHome, '.codex', 'sessions', '2026', '07', '12');
    mkdirSync(sessionsDir, { recursive: true });

    const MODEL = 'test-fixture-codex-multibase-1';
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-12T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'sess-multibase-fixture', cwd: 'C:\\fake' },
      }),
      JSON.stringify({
        timestamp: '2026-07-12T00:00:01.000Z',
        type: 'turn_context',
        payload: { turn_id: 't1', model: MODEL },
      }),
      JSON.stringify({
        timestamp: '2026-07-12T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
          },
        },
      }),
    ];
    writeFileSync(join(sessionsDir, 'rollout-multibase-fixture.jsonl'), lines.join('\n') + '\n');

    const db = openDb(':memory:');
    migrate(db);
    const summary = ingestCodex(db);

    assert.ok(summary.files_scanned >= 1, 'expected at least the fixture file to be scanned');
    const row = db.prepare(`SELECT COUNT(*) AS c FROM token_events WHERE model = ?`).get(MODEL) as { c: number };
    assert.equal(
      row.c,
      1,
      'fixture row from the WSL-home base must be ingested even though ingestCodex now loops over multiple bases',
    );
  } finally {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
