import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const CLI = join(process.cwd(), 'src', 'cli.ts');

function run(home: string, args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv };
  delete env.TOKENPULSE_DB;
  Object.assign(env, extraEnv);
  const r = spawnSync(process.execPath, ['--import', 'tsx/esm', CLI, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function seedClaudeLog(home: string): void {
  const dir = join(home, '.claude', 'projects', '-tmp-demo');
  mkdirSync(dir, { recursive: true });
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  writeFileSync(
    join(dir, 's1.jsonl'),
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      requestId: 'req_first_run',
      message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 1000, output_tokens: 500 }, content: [] },
    }) + '\n',
  );
}

test('first-run: `audit --json` on a fresh machine ingests logs itself (no prior `ingest` needed) and keeps stdout pure JSON', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-cli-'));
  try {
    seedClaudeLog(home);
    const r = run(home, ['audit', '--json']);
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    assert.equal(report.usage.totalTokens, 1500);
    assert.equal(report.sources.find((s: { name: string }) => s.name === 'claude-code').status, 'available');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('first-run: `stats` with no logs anywhere explains what to do (stderr) instead of silent zeros', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-cli-'));
  try {
    const r = run(home, ['stats', '7']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /No Claude Code or Codex logs found/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('unknown command names the command and exits non-zero', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-cli-'));
  try {
    const r = run(home, ['bogus']);
    assert.equal(r.code, 1);
    assert.match(r.err, /Unknown command: bogus/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unusable database path gives a one-line actionable error, not a stack trace', () => {
  const home = mkdtempSync(join(tmpdir(), 'tm-cli-'));
  try {
    // A *file* where the DB's parent directory should be.
    const blocker = join(home, 'blocker');
    writeFileSync(blocker, 'x');
    const r = run(home, ['stats'], { TOKENPULSE_DB: join(blocker, 'usage.db') });
    assert.equal(r.code, 1);
    assert.match(r.err, /^token-meter: /m);
    assert.doesNotMatch(r.err, /\n\s+at /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
