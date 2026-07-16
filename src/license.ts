// License entitlement resolution.
//
// Status (v0.1.10): gating is **enabled by default**. With no license, callers
// of getEntitlement() resolve to Free. TOKEN_METER_GATING=0 (or false) is the
// developer / dogfood escape hatch that forces gating off → Pro+.
//
// The Polar checkout + webhook → license issuance path (γ in 05-decisions
// D-031) went live 2026-05-15, which is what allowed the beta's dormant
// disabled-by-default to flip.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Tier = 'free' | 'pro' | 'pro_plus';

export interface Entitlement {
  tier: Tier;
  /** Epoch ms when the license expires. null for free / lifetime. */
  valid_until_ms: number | null;
  source:
    | 'gating_disabled'
    | 'free_default'
    | 'env'
    | 'config_file'
    | 'expired_fallback';
  message: string | null;
}

const GATING_ENV = 'TOKEN_METER_GATING';
const LICENSE_ENV = 'TOKEN_METER_LICENSE';
function getConfigPath(): string {
  return join(homedir(), '.tokenmeter', 'license.json');
}

const API_BASE_DEFAULT = 'https://api.token-meter.dev';
function getApiBase(): string {
  return process.env.TOKEN_METER_API_BASE ?? API_BASE_DEFAULT;
}

/** Offline grace period: 7 days since the last successful remote verify. */
export const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

export const HISTORY_CAP: Record<Tier, number | null> = {
  free: 7,
  pro: 30,
  pro_plus: null,
};

export const FREE_RULE_CAP = 1;
export const FREE_ACTION_TYPES = new Set<string>(['notify.desktop']);

function isGatingEnabled(): boolean {
  // Trimmed: cmd.exe `set X=0 ` keeps the trailing space in the value.
  const v = process.env[GATING_ENV]?.trim().toLowerCase();
  return !(v === '0' || v === 'false');
}

function parseTier(input: string): Tier | null {
  const t = input.trim().toLowerCase();
  if (t === 'free') return 'free';
  if (t === 'pro') return 'pro';
  if (t === 'pro+' || t === 'pro_plus' || t === 'pro-plus') return 'pro_plus';
  return null;
}

export function getEntitlement(): Entitlement {
  if (!isGatingEnabled()) {
    return {
      tier: 'pro_plus',
      valid_until_ms: null,
      source: 'gating_disabled',
      message: null,
    };
  }

  const envKey = process.env[LICENSE_ENV];
  if (envKey) {
    const tier = parseTier(envKey);
    if (tier) {
      return { tier, valid_until_ms: null, source: 'env', message: null };
    }
  }

  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      tier?: string;
      valid_until_ms?: number;
      license_key?: string;
      last_verified_ms?: number;
    };
    const tier = parseTier(parsed.tier ?? '');
    if (tier) {
      const exp = parsed.valid_until_ms ?? null;
      if (exp !== null && exp < Date.now()) {
        return {
          tier: 'free',
          valid_until_ms: exp,
          source: 'expired_fallback',
          message: `License expired at ${new Date(exp).toISOString()}. Falling back to Free.`,
        };
      }
      // Offline grace period: if the license was activated against the
      // remote API and hasn't been re-verified in over GRACE_PERIOD_MS, fall
      // back to Free until the next successful verify.
      if (
        parsed.license_key &&
        typeof parsed.last_verified_ms === 'number' &&
        Date.now() - parsed.last_verified_ms > GRACE_PERIOD_MS
      ) {
        return {
          tier: 'free',
          valid_until_ms: exp,
          source: 'expired_fallback',
          message: `License not verified in over ${Math.floor(GRACE_PERIOD_MS / 86_400_000)} days. Run \`token-meter activate <key>\` to refresh.`,
        };
      }
      return {
        tier,
        valid_until_ms: exp,
        source: 'config_file',
        message: null,
      };
    }
  } catch {
    // Missing / invalid file — fall through to Free default.
  }

  return {
    tier: 'free',
    valid_until_ms: null,
    source: 'free_default',
    message: null,
  };
}

export function clampDaysToEntitlement(days: number, tier: Tier): number {
  const cap = HISTORY_CAP[tier];
  if (cap === null) return days;
  return Math.min(days, cap);
}

export function isProTier(tier: Tier): boolean {
  return tier === 'pro' || tier === 'pro_plus';
}

export function isProPlusTier(tier: Tier): boolean {
  return tier === 'pro_plus';
}

// ---------- Remote verify + activate (talks to infra/api worker) ----------

export interface RemoteVerifyResult {
  valid: boolean;
  plan?: 'pro' | 'pro_plus' | 'team';
  status?: string;
  expires_at?: number | null;
  error?: string;
}

export async function verifyLicenseRemote(
  key: string,
): Promise<RemoteVerifyResult> {
  try {
    const res = await fetch(`${getApiBase()}/v1/license/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        valid: false,
        error: `status_${res.status}_${text.slice(0, 80)}`,
      };
    }
    return (await res.json()) as RemoteVerifyResult;
  } catch (err) {
    return {
      valid: false,
      error: `network_${(err as Error).message ?? 'unknown'}`,
    };
  }
}

export async function activateLicense(
  key: string,
): Promise<{ ok: boolean; message: string }> {
  const trimmed = key.trim();
  if (!trimmed.startsWith('tm_')) {
    return {
      ok: false,
      message: `Invalid license key format. Expected tm_<...> received "${trimmed.slice(0, 16)}".`,
    };
  }
  const result = await verifyLicenseRemote(trimmed);
  if (!result.valid) {
    return {
      ok: false,
      message: `License verification failed: ${result.error ?? 'unknown'}`,
    };
  }
  const tier: Tier =
    result.plan === 'pro_plus' || result.plan === 'team' ? 'pro_plus' : 'pro';
  const path = getConfigPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          tier,
          license_key: trimmed,
          valid_until_ms: result.expires_at ?? null,
          last_verified_ms: Date.now(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write ${path}: ${(err as Error).message}`,
    };
  }
  const label = tier === 'pro_plus' ? 'Pro+' : 'Pro';
  return {
    ok: true,
    message: `Activated ${label} on this machine. Run \`token-meter --version\` to confirm, or restart your dashboard / MCP server to pick up the change.`,
  };
}

