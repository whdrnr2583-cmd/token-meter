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
