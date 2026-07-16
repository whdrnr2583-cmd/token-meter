# Billing setup (Polar + CF Workers + Resend)

> Step-by-step for **activating paid tiers** on Token Meter. Most steps live
> in vendor GUIs (Polar dashboard, Cloudflare console, Resend dashboard),
> not in the codebase. Run them in order. Each step lists exactly which CLI
> command or which dashboard click happens.

This wires together what's already in the repo:
- [infra/api](../infra/api) — Hono on CF Workers + D1.
- [src/license.ts](../src/license.ts) — CLI-side verify + `activate` command.
- [docs/pro-features.md](pro-features.md) — what Pro $5 unlocks.

---

## 0. Prerequisites

- Domain `token-meter.dev` already on Cloudflare with `https://` working
  (this is done; see D-029).
- npm package `@whdrnr2583/token-meter@0.1.2+` published (done).
- A separate browser tab open in each of Polar / Cloudflare / Resend
  dashboards.

---

## 1. Polar — create the product(s)

1. Sign in at <https://polar.sh>. Use **the same email** that will receive
   webhook events.
2. **Settings → Organization** — set name to `Token Meter` and slug to
   `token-meter` (or similar).
3. **Products → New** — Pro:
   - Name: `Token Meter Pro` — this exact substring is what the webhook
     handler reads to set `plan = 'pro'`. **Do not include "Plus"**.
   - Description: `30-day history, smart alerts, session drill-down, export, custom pricing matrix.`
   - Price: **$5 / month, recurring**.
   - Save. Copy the **product link** (format `https://buy.polar.sh/<id>`).
4. **(Optional, deferred)** Products → New — Pro+:
   - Name: `Token Meter Pro+` — substring "Plus" triggers `plan = 'pro_plus'`.
   - Price: **$24 / month, recurring**.
   - Copy the product link if you create it; otherwise leave the landing
     page placeholder as-is.
5. **Settings → Webhooks → Add endpoint**:
   - URL: `https://api.token-meter.dev/v1/polar/webhook`
   - Format: **Standard Webhooks** (Polar default).
   - Events: enable `subscription.created`, `subscription.active`,
     `subscription.canceled`, `subscription.revoked`.
   - Save. Copy the **webhook signing secret** (Polar prefix is
     `polar_whs_<base64>`; some Polar UI variants emit the generic
     `whsec_<base64>`. The worker handles both.).

---

## 2. Resend — verify the sending domain

1. Sign in at <https://resend.com>. Free plan = 3,000 emails / month, plenty.
2. **Domains → Add Domain** → `token-meter.dev`.
3. Resend shows 3-4 DNS records (SPF / DKIM / DMARC / return-path). Copy
   each.
4. In **Cloudflare → token-meter.dev → DNS**, add each record as Resend
   specifies. Type `TXT` for SPF/DKIM/DMARC, `MX` if asked. Set proxy to
   **DNS-only (gray cloud)** for all.
5. Back in Resend, wait for the domain to flip to **Verified** (usually
   under 15 minutes).
6. **API Keys → Create** — name `token-meter-prod`, permission `Sending
   access` only. Copy the key.

**Cross-check before sending:** the existing `hello@token-meter.dev` →
Gmail routing (CF Email Routing) is **inbound only**. Sending uses Resend
with the verified domain. The two don't conflict.

---

## 3. Cloudflare — provision D1 and Workers

All commands run from the **token-meter** repo on a machine with
`wrangler` installed (`npm i -g wrangler` if needed).

```sh
cd infra/api

# 3.1 Create D1
wrangler d1 create token-meter
```

This prints a `database_id`. Open `infra/api/wrangler.toml` and replace
`REPLACE_WITH_D1_ID` with that value.

```sh
# 3.2 Apply schema (remote)
npm run db:migrate:remote
```

```sh
# 3.3 Set secrets (interactive — paste when prompted)
wrangler secret put POLAR_WEBHOOK_SECRET    # whsec_... from step 1.5
wrangler secret put RESEND_API_KEY          # re_... from step 2.6
```

```sh
# 3.4 Deploy
wrangler deploy
```

Wrangler prints the deployed URL (e.g. `https://token-meter-api.<acct>.workers.dev`).

```sh
# 3.5 Smoke test the deploy
curl -sf https://token-meter-api.<acct>.workers.dev/v1/health
# → {"ok":true,"ts":...}
```

---

## 4. Cloudflare — bind the custom domain

In the **Cloudflare dashboard → Workers & Pages → token-meter-api →
Triggers → Custom Domains → Add**:

- Domain: `api.token-meter.dev`

Cloudflare provisions the TLS cert and DNS record (CNAME) automatically.
Wait ~2 minutes, then:

```sh
curl -sf https://api.token-meter.dev/v1/health
# → {"ok":true,"ts":...}
```

Update `src/license.ts` callers will hit `https://api.token-meter.dev`
automatically (it's the default in `getApiBase`).

---

## 5. Point Polar webhook at the deployed URL

In Polar → Settings → Webhooks → your endpoint, confirm the URL is
`https://api.token-meter.dev/v1/polar/webhook`. Polar will fire test
events; check the `webhook_events` table in D1:

```sh
wrangler d1 execute token-meter --remote \
  --command "SELECT id, type, received_at, processed_at FROM webhook_events ORDER BY received_at DESC LIMIT 5;"
```

A test event should appear within seconds.

---

## 6. Update the landing page checkout button

Edit `infra/site/index.html`. Find the placeholder hint inside the Pro
`<article>`:

```html
<p class="hint" data-checkout-pro>...</p>
<!-- When Polar product is created, replace ... -->
```

Replace with:

```html
<a class="cta-btn" href="https://buy.polar.sh/REPLACE_PRO_PRODUCT_ID" target="_blank" rel="noreferrer">Subscribe — $5/mo</a>
```

…using the product link copied in step 1.3. Then deploy the site:

```sh
cd ..   # back to repo root
npx wrangler pages deploy infra/site --project-name tokenmeter-site --branch main
```

(Same manual deploy pattern as before — Connect to Git stays off per
D-029.)

---

## 7. End-to-end live test

1. Open `https://token-meter.dev` in an incognito window.
2. Click the Pro `Subscribe` button. Complete checkout with **a real
   card** (use your own — refund yourself after via Polar dashboard).
3. Within ~10 seconds, the Polar webhook hits the worker, a row appears
   in `licenses`, and Resend ships the key email to the address you
   checked out with.
4. Open the inbox. The email contains a `tm_live_<hex>` key and the
   `token-meter activate <key>` command.
5. On a clean dev machine (or set `TOKEN_METER_API_BASE=` to your worker
   URL):
   ```sh
   node dist/cli.js activate tm_live_<hex>
   # → "Activated Pro on this machine."
   node dist/cli.js stats 30
   # → no "[Free tier] clamped" warning; full 30 days shown.
   ```
6. Refund yourself in Polar → Subscriptions → cancel → confirm. The
   webhook fires `subscription.canceled`, the worker sets
   `status='canceled'`, and the next verify call sees `valid: false`.
7. Within the 7-day offline grace window the local CLI keeps working,
   then falls back to Free. **This is intentional** — gives users time
   to reactivate without a sudden cut-off on a flaky network day.

---

## 8. Default-on gating — done (v0.1.28, pending publish)

`isGatingEnabled()` in `src/license.ts` now defaults to on: no license →
Free. `TOKEN_METER_GATING=0` (or `false`) is the dev/dogfood escape hatch
that forces Pro+. Per D-038.

Breaking for anyone running v0.1.x without a license, but shipped as
`0.1.28` rather than the `0.2.0` this doc originally called for. Not yet
on npm — publish is a manual OTP step and npm is still on 0.1.25, so
0.1.26/0.1.27/0.1.28 all land in the same push.

---

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Polar webhook → 401 invalid_signature | (a) Wrong `POLAR_WEBHOOK_SECRET` value on worker, or (b) verify implementation diverges from Polar's actual HMAC convention | (a) `wrangler secret put POLAR_WEBHOOK_SECRET` with the value from Polar dashboard, then `wrangler deploy`. (b) See D-032 — Polar uses **full secret raw UTF-8 bytes** as HMAC key (not base64-decoded post-prefix). The `standardwebhooks` npm package does NOT match Polar; use the manual implementation in `infra/api/src/index.ts`. |
| Polar webhook → 200 sig OK but 400 missing_fields | Event id read from body, but Polar puts it in the `webhook-id` header | Read `eventId = c.req.header('webhook-id')`, not `evt.id`. Fixed in D-032. |
| Webhook fires but no row in `licenses` | Product name doesn't include "Plus" or "Team" and isn't `Pro` — handler defaults to `pro` regardless | Read `webhook_events.payload` in D1, confirm product structure |
| `activate` returns network error | Domain not bound yet, or `TOKEN_METER_API_BASE` pointing at wrong URL | `curl https://api.token-meter.dev/v1/health` first |
| Email never arrives | Resend domain not verified, or `RESEND_API_KEY` missing | Check Resend dashboard "Emails" log; if 403, redo step 2 |
| `activate` succeeds but `stats` still says Free | Long-running process (dashboard / MCP server) was started before activate and cached the entitlement | Restart the process so it re-reads `~/.tokenmeter/license.json` |

---

## Rollback

If anything in steps 5-8 misbehaves in production:

1. Pause Polar webhooks (Polar dashboard → Webhooks → Disable). New
   subscriptions still complete; we just stop issuing licenses until
   re-enabled.
2. Replace the landing's Subscribe button with the original waitlist
   hint, redeploy `infra/site`.
3. Refund any orphaned subscriptions from the Polar dashboard.

No data is lost — `webhook_events` keeps the raw payloads for manual
replay later.

---

## Related decisions

- [D-001 Polar.sh as payment infra](../05-decisions.md#d-001) — MoR
  rationale, 4% + $0.40 cost model.
- [D-005 Local-first + Pro sync opt-in](../05-decisions.md#d-005)
- [D-023 koreanpulse Lightsail separation](../05-decisions.md#d-023) —
  Token Meter must never share servers with the trading stack.
- [D-029 v0.1.0 publish realities](../05-decisions.md#d-029) — domain,
  CF Pages, manual deploy.
- [D-031 outbound channel rule + PMF gate bypass](../05-decisions.md#d-031)
  — paid tiers green-lit despite zero ICP interviews / kakao posts.
