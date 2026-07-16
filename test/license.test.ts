import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampDaysToEntitlement,
  FREE_ACTION_TYPES,
  FREE_RULE_CAP,
  getEntitlement,
  HISTORY_CAP,
  isProPlusTier,
  isProTier,
} from '../src/license.js';

function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void,
): void {
  const before: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) {
    before[k] = process.env[k];
    const v = overrides[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(before)) {
      const v = before[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('gating enabled by default, no license → free', () => {
  withEnv(
    {
      TOKEN_METER_GATING: undefined,
      TOKEN_METER_LICENSE: undefined,
      HOME: '/tmp/tokenmeter-test-no-license',
      USERPROFILE: 'C:/tokenmeter-test-no-license',
    },
    () => {
      const e = getEntitlement();
      assert.equal(e.tier, 'free');
      assert.equal(e.source, 'free_default');
    },
  );
});

test('TOKEN_METER_GATING=0 escape hatch → pro_plus', () => {
  withEnv({ TOKEN_METER_GATING: '0', TOKEN_METER_LICENSE: undefined }, () => {
    const e = getEntitlement();
    assert.equal(e.tier, 'pro_plus');
    assert.equal(e.source, 'gating_disabled');
    assert.equal(e.message, null);
  });
});

test('TOKEN_METER_GATING=false escape hatch → pro_plus', () => {
  withEnv({ TOKEN_METER_GATING: 'false' }, () => {
    assert.equal(getEntitlement().tier, 'pro_plus');
  });
});

test('escape hatch tolerates cmd.exe trailing space (`set X=0 `)', () => {
  withEnv({ TOKEN_METER_GATING: '0 ' }, () => {
    assert.equal(getEntitlement().tier, 'pro_plus');
  });
});

test('TOKEN_METER_GATING=1 keeps gating on', () => {
  withEnv(
    {
      TOKEN_METER_GATING: '1',
      TOKEN_METER_LICENSE: undefined,
      HOME: '/tmp/tokenmeter-test-no-license',
      USERPROFILE: 'C:/tokenmeter-test-no-license',
    },
    () => {
      assert.equal(getEntitlement().tier, 'free');
    },
  );
});

test('gating enabled, no license env or file → free default', () => {
  // Force the config file lookup to miss by pointing HOME at a tmp dir
  // that has no .tokenmeter/license.json.
  withEnv(
    {
      TOKEN_METER_GATING: '1',
      TOKEN_METER_LICENSE: undefined,
      HOME: '/tmp/tokenmeter-test-no-license',
      USERPROFILE: 'C:/tokenmeter-test-no-license',
    },
    () => {
      const e = getEntitlement();
      assert.equal(e.tier, 'free');
      assert.equal(e.source, 'free_default');
    },
  );
});

test('gating enabled + env TOKEN_METER_LICENSE=pro', () => {
  withEnv({ TOKEN_METER_GATING: '1', TOKEN_METER_LICENSE: 'pro' }, () => {
    const e = getEntitlement();
    assert.equal(e.tier, 'pro');
    assert.equal(e.source, 'env');
  });
});

test('gating enabled + env TOKEN_METER_LICENSE=pro+ → pro_plus', () => {
  withEnv({ TOKEN_METER_GATING: '1', TOKEN_METER_LICENSE: 'pro+' }, () => {
    const e = getEntitlement();
    assert.equal(e.tier, 'pro_plus');
    assert.equal(e.source, 'env');
  });
});

test('clampDaysToEntitlement respects tier caps', () => {
  assert.equal(clampDaysToEntitlement(30, 'free'), 7);
  assert.equal(clampDaysToEntitlement(5, 'free'), 5);
  assert.equal(clampDaysToEntitlement(60, 'pro'), 30);
  assert.equal(clampDaysToEntitlement(15, 'pro'), 15);
  assert.equal(clampDaysToEntitlement(365, 'pro_plus'), 365);
});

test('HISTORY_CAP exposed for downstream callers', () => {
  assert.equal(HISTORY_CAP.free, 7);
  assert.equal(HISTORY_CAP.pro, 30);
  assert.equal(HISTORY_CAP.pro_plus, null);
});

test('isProTier / isProPlusTier helpers', () => {
  assert.equal(isProTier('free'), false);
  assert.equal(isProTier('pro'), true);
  assert.equal(isProTier('pro_plus'), true);
  assert.equal(isProPlusTier('free'), false);
  assert.equal(isProPlusTier('pro'), false);
  assert.equal(isProPlusTier('pro_plus'), true);
});

test('FREE_RULE_CAP and FREE_ACTION_TYPES expose Free quotas', () => {
  assert.equal(FREE_RULE_CAP, 1);
  assert.ok(FREE_ACTION_TYPES.has('notify.desktop'));
  assert.equal(FREE_ACTION_TYPES.has('notify.webhook'), false);
  assert.equal(FREE_ACTION_TYPES.has('notify.email'), false);
});
