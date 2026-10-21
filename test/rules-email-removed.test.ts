import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDb } from '../src/db.js';
import { createRule, evaluateRules, listRules } from '../src/rules.js';
import { validateRuleFields } from '../src/server.js';
import { readFileSync } from 'node:fs';

test('API validation rejects notify.email for new/updated rules but allows other patches', () => {
  assert.deepEqual(validateRuleFields({ action_type: 'notify.email' as never }, false), { ok: false, field: 'action_type' });
  assert.equal(validateRuleFields({ action_type: 'notify.webhook' }, false), null);
  assert.equal(validateRuleFields({ enabled: false } as never, false), null);
});

test('a rule saved earlier with notify.email still lists and evaluates without throwing', async () => {
  const db = openDb(':memory:');
  migrate(db);
  createRule(db, {
    name: 'old email rule', enabled: true, metric: 'daily_usd', op: '>=', threshold: 0,
    action_type: 'notify.email', action_config: { to: 'a@b.c' }, cooldown_ms: 0,
  } as never);
  assert.equal(listRules(db).length, 1);
  await assert.doesNotReject(() => evaluateRules(db));
});

test('the dashboard no longer offers an email action', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.doesNotMatch(html, /value="notify\.email"/);
  assert.doesNotMatch(html, /email_to/);
});
