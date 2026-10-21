import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import Fastify from 'fastify';
import { checkLocalRequest, registerLocalOnlyGuard } from '../src/server.js';

test('checkLocalRequest: loopback hosts pass, rebinding hostnames and missing Host fail', () => {
  for (const host of ['localhost:8765', '127.0.0.1:8765', '[::1]:8765', 'LOCALHOST', 'localhost']) {
    assert.deepEqual(checkLocalRequest({ host }), { ok: true }, host);
  }
  for (const host of ['evil.example:8765', 'localhost.evil.example', '127.0.0.1.evil.example:8765', '10.0.0.5:8765', '']) {
    assert.equal(checkLocalRequest({ host }).ok, false, host);
  }
  assert.equal(checkLocalRequest({}).ok, false);
});

test('checkLocalRequest: a cross-origin Origin is rejected even with a loopback Host; same-origin and absent Origin pass', () => {
  assert.equal(checkLocalRequest({ host: 'localhost:8765', origin: 'https://evil.example' }).ok, false);
  assert.equal(checkLocalRequest({ host: 'localhost:8765', origin: 'http://localhost:9999' }).ok, false);
  assert.equal(checkLocalRequest({ host: 'localhost:8765', origin: 'null' }).ok, false);
  assert.equal(checkLocalRequest({ host: 'localhost:8765', origin: 'http://localhost:8765' }).ok, true);
  assert.equal(checkLocalRequest({ host: 'localhost:8765' }).ok, true);
});

test('registerLocalOnlyGuard: blocks a DNS-rebinding read and a cross-site write before the route runs', async () => {
  const app = Fastify();
  registerLocalOnlyGuard(app);
  let hits = 0;
  app.get('/api/x', async () => ({ secret: ++hits }));
  app.post('/api/rules', async () => ({ created: ++hits }));

  const rebind = await app.inject({ method: 'GET', url: '/api/x', headers: { host: 'evil.example:8765' } });
  assert.equal(rebind.statusCode, 403);
  const csrf = await app.inject({
    method: 'POST',
    url: '/api/rules',
    headers: { host: 'localhost:8765', origin: 'https://evil.example', 'content-type': 'application/json' },
    payload: '{}',
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal(hits, 0, 'handlers must not run for rejected requests');

  const ok = await app.inject({ method: 'GET', url: '/api/x', headers: { host: 'localhost:8765' } });
  assert.equal(ok.statusCode, 200);
  await app.close();
});

import { registerStatusRoute } from '../src/server.js';
import { migrate, openDb, insertTokenEvents } from '../src/db.js';

test('GET /api/status exists: empty DB => has_data false + guidance; with data => has_data true', async () => {
  const db = openDb(':memory:');
  migrate(db);
  const app = Fastify();
  registerStatusRoute(app, db);
  const empty = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(empty.has_data, false);
  assert.match(empty.guidance, /No Claude Code or Codex/);
  insertTokenEvents(db, [{
    ts: Date.now(), source: 'claude-code', source_kind: 'cloud', model: 'claude-sonnet-4-5', project: 'p', session_id: 's',
    request_id: 'r', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
    total_duration_ms: null, tps: null, usd_estimate: 0.1, agent_id: null,
  }]);
  const full = (await app.inject({ method: 'GET', url: '/api/status' })).json();
  assert.equal(full.has_data, true);
  assert.equal(full.guidance, '');
  await app.close();
});

import { readFileSync } from 'node:fs';

test('every /api/ path the dashboard calls is a registered server route (a missing one silently broke the first-run banner)', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const app = readFileSync('public/app.js', 'utf8');
  const used = new Set([...app.matchAll(/['"`]\/api\/([a-z-]+)/g)].map((m) => m[1]!));
  assert.ok(used.size >= 10);
  for (const name of used) assert.ok(server.includes(`'/api/${name}`), `no server route for /api/${name}`);
  assert.match(server, /registerStatusRoute\(app, db\);/);
});
