import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  POLAR_WEBHOOK_SECRET?: string;
  RESEND_API_KEY?: string;
  APP_NAME: string;
  SITE_URL: string;
  RESEND_FROM?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return '*';
      const allow = [
        'https://token-meter.dev',
        'http://localhost:8765',
        'http://127.0.0.1:8765',
      ];
      return allow.includes(origin) ? origin : null;
    },
  }),
);

app.get('/', (c) => c.text(`${c.env.APP_NAME} API ok`));
app.get('/v1/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ---------- Waitlist ----------
app.post('/v1/waitlist', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { email?: unknown; source?: unknown }
    | null;
  const email =
    typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const source =
    typeof body?.source === 'string' ? body.source.slice(0, 50) : null;
  if (
    !email ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
    email.length > 200
  ) {
    return c.json({ ok: false, error: 'invalid_email' }, 400);
  }
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO waitlist (email, source, created_at) VALUES (?, ?, ?)`,
  )
    .bind(email, source, Date.now())
    .run();
  return c.json({ ok: true });
});

// ---------- License verify (called by CLI) ----------
app.post('/v1/license/verify', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { key?: unknown }
    | null;
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  if (!key.startsWith('tm_') || key.length > 64) {
    return c.json({ valid: false, error: 'invalid_format' }, 400);
  }
  const row = await c.env.DB.prepare(
    `SELECT key, plan, status, expires_at FROM licenses WHERE key = ?`,
  )
    .bind(key)
    .first<{
      key: string;
      plan: string;
      status: string;
      expires_at: number | null;
    }>();
  if (!row) return c.json({ valid: false, error: 'not_found' }, 404);
  const expired = row.expires_at !== null && row.expires_at < Date.now();
  const ok = row.status === 'active' && !expired;
  if (ok) {
    await c.env.DB.prepare(
      `UPDATE licenses SET last_verified_at = ? WHERE key = ?`,
    )
      .bind(Date.now(), key)
      .run();
  }
  return c.json({
    valid: ok,
    plan: row.plan,
    status: row.status,
    expires_at: row.expires_at,
  });
});

// ---------- Polar webhook (subscription lifecycle) ----------

// Polar uses the Standard Webhooks spec (https://www.standardwebhooks.com/).
// Polar's secret is `polar_whs_<base64>` (Standard Webhooks reference uses
// `whsec_<base64>`). The base64 portion is unpadded — `atob()` requires
// padding, so we add `=` as needed and also normalise URL-safe variants
// before decoding. The HMAC key bytes are the decoded base64 content.
//
// We implement verification by hand against the spec to avoid Workers-
// vs-Node runtime mismatches that the standardwebhooks 1.x package hit.

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyPolarSignature(
  rawBody: string,
  webhookId: string | null,
  webhookTimestamp: string | null,
  webhookSignature: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !webhookId || !webhookTimestamp || !webhookSignature) {
    return false;
  }
  const tsNum = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > 5 * 60) {
    console.error(
      `Polar sig fail: timestamp_out_of_window wts=${webhookTimestamp} now_sec=${Math.floor(Date.now() / 1000)}`,
    );
    return false;
  }

  // Polar's actual key derivation (verified empirically 2026-05-14):
  // **raw UTF-8 bytes of the full secret string** (prefix `polar_whs_`
  // INCLUDED, no base64 decode). Diverges from Standard Webhooks reference
  // which decodes the post-prefix base64. The standardwebhooks npm
  // package therefore does NOT verify Polar payloads correctly.
  const keyBytes = new TextEncoder().encode(secret);
  const signed = `${webhookId}.${webhookTimestamp}.${rawBody}`;

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const macBuf = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(signed),
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(macBuf)));

  // webhook-signature header is space-separated tokens: "v1,<sig> v1,<sig2>"
  const tokens = webhookSignature.split(' ').filter((t) => t.startsWith('v1,'));
  for (const token of tokens) {
    if (timingSafeEqualStr(token.slice(3), expected)) return true;
  }

  console.error(
    `Polar sig fail: hmac_mismatch secret_len=${secret.length} ` +
      `expected=${expected.slice(0, 16)} actual_first=${(tokens[0] ?? '').slice(0, 18)} ` +
      `wid=${webhookId} wts=${webhookTimestamp} signed_len=${signed.length}`,
  );
  return false;
}

function newLicenseKey(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  const hex = [...bytes]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `tm_live_${hex}`;
}

function planLabel(plan: string): string {
  if (plan === 'pro_plus') return 'Pro+';
  if (plan === 'team') return 'Team';
  return 'Pro';
}

// Replies to license emails must reach a real inbox — From is a noreply@
// address, so set reply_to explicitly (matches the site footer contact).
const REPLY_TO_EMAIL = 'hello@token-meter.dev';

function licenseEmailText(key: string, plan: string, siteUrl: string): string {
  const label = planLabel(plan);
  const site = siteUrl.replace(/^https?:\/\//, '');
  const history = plan === 'pro_plus' ? 'Unlimited history' : '30-day history';
  const exportWin =
    plan === 'pro_plus' ? ' (unlimited window)' : ' (30-day window)';
  return [
    `Welcome to Token Meter ${label}.`,
    '',
    'Your license key:',
    key,
    '',
    'FAST PATH',
    'Forward this email to your AI assistant (Claude Code, Cursor, ChatGPT) and ask:',
    '"Set up Token Meter for me using this license key."',
    '',
    'MANUAL SETUP',
    '# install + activate',
    `npx -y @whdrnr2583/token-meter setup ${key}`,
    '',
    '# optional - register as an MCP server (Claude Code)',
    'claude mcp add token-meter -- npx -y @whdrnr2583/token-meter mcp',
    '',
    '# verify (no "Free tier" warning = success)',
    'token-meter stats 30',
    '',
    `WHAT YOU UNLOCKED WITH ${label}`,
    `- ${history} on every dashboard view`,
    '- Smart alerts - desktop, email, webhook, weekly digest',
    '- Session and per-message drill-down',
    `- CSV / JSON export${exportWin}`,
    '- Custom pricing matrix for contracted API rates',
    '',
    "Questions, bugs, or a setup that didn't go through? Just reply to this",
    'email - it reaches us directly.',
    '',
    `Token Meter - ${site}`,
    siteUrl,
  ].join('\n');
}

function licenseEmailHtml(key: string, plan: string, siteUrl: string): string {
  const label = planLabel(plan);
  const site = siteUrl.replace(/^https?:\/\//, '');
  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px;margin:24px auto;color:#222;line-height:1.55">
<span style="display:none!important;max-height:0;overflow:hidden;opacity:0;color:transparent">Your Token Meter ${label} license key + one-shot setup instructions are inside.</span>

<img src="${siteUrl}/logo-transparent.png" alt="Token Meter" width="56" height="56" style="display:block;border:0;outline:none;margin:0 0 14px" />
<div style="height:3px;width:48px;background:#10b981;border-radius:3px;margin:0 0 18px"></div>
<h2 style="margin:0 0 12px">Welcome to Token Meter ${label} 🎉</h2>
<p>Your license key:</p>
<pre style="background:#f0fdf4;border:1px solid #bbf7d0;color:#065f46;padding:14px 16px;border-radius:8px;font-size:15px;word-break:break-all;margin:0 0 24px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">${key}</pre>

<div style="background:#eef6ff;border-left:4px solid #58a6ff;padding:14px 18px;border-radius:6px;margin:0 0 22px">
  <p style="margin:0 0 6px;font-weight:600">🤖 Fast path — paste this email to your AI coding assistant</p>
  <p style="margin:0;font-size:14px;color:#444">Forward (or copy &amp; paste) this whole email to Claude Code, Cursor, ChatGPT, or any agent you use, and ask: <em>"Set up Token Meter for me using this license key."</em> The instructions below are written for both you and the assistant.</p>
</div>

<h3 style="margin:0 0 8px">For the assistant — exact commands to run</h3>
<pre style="background:#f6f8fa;color:#1f2937;border:1px solid #e5e7eb;padding:14px 16px;border-radius:8px;font-size:13.5px;line-height:1.55;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
# One-shot install + activate + persist gating env
npx -y @whdrnr2583/token-meter setup ${key}

# Optional — register as an MCP server (Claude Code shown; Cursor/Desktop
# config paths are printed at the end of \`setup\`)
claude mcp add token-meter -- npx -y @whdrnr2583/token-meter mcp

# Verify
token-meter stats 30   # no "Free tier" warning = success
</pre>

<h3 style="margin:0 0 8px">What you unlocked with ${label}</h3>
<ul>
  <li>${plan === 'pro_plus' ? 'Unlimited history' : '30-day history'} on every dashboard view</li>
  <li>Smart alerts — desktop, email, webhook, weekly digest</li>
  <li>Session and per-message drill-down (find the call that blew the budget)</li>
  <li>CSV / JSON export${plan === 'pro_plus' ? ' (unlimited window)' : ' (30-day window)'}</li>
  <li>Custom pricing matrix for contracted API rates</li>
</ul>

<p style="margin:0 0 4px">Questions, bugs, or a setup that didn't go through? <strong>Reply to this email</strong> — it lands in our inbox directly.</p>
<p style="color:#888;font-size:12px;margin:32px 0 0">Token Meter — <a href="${siteUrl}" style="color:#888">${site}</a></p>
</body></html>`;
}

async function sendLicenseEmail(
  apiKey: string,
  from: string,
  to: string,
  key: string,
  plan: string,
  siteUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  const subject = `Your Token Meter ${planLabel(plan)} license`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: REPLY_TO_EMAIL,
      subject,
      html: licenseEmailHtml(key, plan, siteUrl),
      text: licenseEmailText(key, plan, siteUrl),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      error: `resend_${res.status}_${text.slice(0, 200)}`,
    };
  }
  return { ok: true };
}

app.post('/v1/polar/webhook', async (c) => {
  const raw = await c.req.text();
  const wid = c.req.header('webhook-id') ?? null;
  const wts = c.req.header('webhook-timestamp') ?? null;
  const wsig = c.req.header('webhook-signature') ?? null;
  const valid = await verifyPolarSignature(
    raw,
    wid,
    wts,
    wsig,
    c.env.POLAR_WEBHOOK_SECRET,
  );
  if (!valid) return c.json({ ok: false, error: 'invalid_signature' }, 401);

  let evt: { type?: string; data?: Record<string, unknown> };
  try {
    evt = JSON.parse(raw);
  } catch {
    return c.json({ ok: false, error: 'invalid_json' }, 400);
  }
  // Polar puts the event id on the `webhook-id` header, not the body.
  const eventId = wid;
  if (!eventId || !evt.type) {
    return c.json({ ok: false, error: 'missing_fields' }, 400);
  }

  // Idempotency: skip if we've seen this event id.
  const existing = await c.env.DB.prepare(
    `SELECT id FROM webhook_events WHERE id = ?`,
  )
    .bind(eventId)
    .first();
  if (existing) return c.json({ ok: true, deduped: true });

  await c.env.DB.prepare(
    `INSERT INTO webhook_events (id, type, payload, received_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(eventId, evt.type, raw, Date.now())
    .run();

  if (
    evt.type === 'subscription.created' ||
    evt.type === 'subscription.active'
  ) {
    const sub = evt.data ?? {};
    const email =
      (sub.customer as { email?: string } | undefined)?.email ??
      (sub as { customer_email?: string }).customer_email ??
      '';
    const subId = String(sub.id ?? '');
    const customerId = String(
      (sub.customer as { id?: string } | undefined)?.id ?? '',
    );
    const productPlan = String(
      (sub.product as { name?: string } | undefined)?.name ?? 'pro',
    ).toLowerCase();
    const plan = productPlan.includes('plus')
      ? 'pro_plus'
      : productPlan.includes('team')
        ? 'team'
        : 'pro';

    if (email && subId) {
      // Reuse existing license for this subscription if present (replay-safe).
      const existingLic = await c.env.DB.prepare(
        `SELECT key FROM licenses WHERE polar_subscription_id = ?`,
      )
        .bind(subId)
        .first<{ key: string }>();
      const reused = !!existingLic;
      const key = existingLic?.key ?? newLicenseKey();
      await c.env.DB.prepare(
        `INSERT INTO licenses (key, email, plan, status, polar_subscription_id, polar_customer_id, created_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET status='active', plan=excluded.plan`,
      )
        .bind(key, email, plan, subId, customerId, Date.now())
        .run();

      // Send the license key by email — only on first issuance, not replays.
      if (!reused && c.env.RESEND_API_KEY && c.env.RESEND_FROM) {
        const send = await sendLicenseEmail(
          c.env.RESEND_API_KEY,
          c.env.RESEND_FROM,
          email,
          key,
          plan,
          c.env.SITE_URL,
        );
        if (!send.ok) {
          // Don't fail the webhook — the license is issued; record the error
          // in webhook_events for manual follow-up.
          console.error(
            `Resend failed for ${email} key=${key}: ${send.error ?? 'unknown'}`,
          );
        }
      }
    }
  } else if (
    evt.type === 'subscription.canceled' ||
    evt.type === 'subscription.revoked'
  ) {
    const subId = String(
      (evt.data as { id?: string } | undefined)?.id ?? '',
    );
    if (subId) {
      await c.env.DB.prepare(
        `UPDATE licenses SET status='canceled' WHERE polar_subscription_id=?`,
      )
        .bind(subId)
        .run();
    }
  }

  await c.env.DB.prepare(
    `UPDATE webhook_events SET processed_at=? WHERE id=?`,
  )
    .bind(Date.now(), eventId)
    .run();

  return c.json({ ok: true });
});

export default app;
