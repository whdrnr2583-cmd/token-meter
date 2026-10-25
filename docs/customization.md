# Customization Guide — Token Meter Actions

Token Meter ships two built-in alert actions (a third, `notify.email`, is not available yet: the API rejects new email rules, and rules saved earlier by an older version stay listed as inactive and can be toggled or deleted):

- `notify.desktop` — browser notifications when the dashboard is open
- `notify.webhook` — POST to a URL you control

This guide shows how to wire `notify.webhook` into the tools you already use,
and how to build custom automations on top of it. Anything more elaborate than
the built-in actions is **your code, your responsibility** — Token Meter just
emits the event.

---

## 1. Webhook payload spec

Every fired rule POSTs the following JSON to the URL you configure:

```json
{
  "rule_id": 7,
  "rule_name": "Daily over $50",
  "fired_at": 1778640000000,
  "metric": "daily_usd",
  "metric_value": 53.18,
  "threshold": 50,
  "op": ">=",
  "window": {
    "label": "2026-05-13",
    "start_ts": 1778544000000,
    "end_ts": 1778640000000
  },
  "summary": {
    "claude_code_usd": 51.20,
    "codex_usd": 1.98,
    "events": 245,
    "top_models": [
      { "model": "claude-opus-4-7", "usd": 50.10 },
      { "model": "gpt-5", "usd": 1.98 }
    ]
  }
}
```

Headers:
- `content-type: application/json`
- `user-agent: token-meter/0.x`
- `x-token-meter-event: rule.fired`

Timeouts: 5 seconds. Failures are logged in `rule_firings.action_result` but
do **not** retry automatically. If your receiver is critical, add your own
queue (e.g. n8n with retry).

---

## 2. Recipes

### 2.1 Slack (incoming webhook)

Slack's incoming webhooks accept a different JSON shape than ours, so use a
tiny relay or build a Slack-native webhook URL.

**Simplest**: forward Token Meter's payload to a Slack-formatting proxy on
Cloudflare Workers / a serverless function.

```javascript
// Cloudflare Workers / Vercel function (your own deploy)
export default {
  async fetch(req) {
    const event = await req.json();
    const slackUrl = 'https://hooks.slack.com/services/XXX/YYY/ZZZ';
    await fetch(slackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: `:warning: *${event.rule_name}* fired — ${event.metric} = $${event.metric_value.toFixed(2)} (threshold $${event.threshold})`,
      }),
    });
    return new Response('ok');
  },
};
```

Then point Token Meter's webhook URL to your relay.

### 2.2 Discord (incoming webhook)

Discord accepts `{ "content": "..." }`. Use a relay similar to the Slack one
above, or use Discord's `webhook?wait=true` and a tool like Pipedream.

### 2.3 n8n

1. Create an n8n workflow with a **Webhook** trigger node.
2. Copy the trigger URL into Token Meter's webhook URL field.
3. Branch on `$json.metric` to send to Slack, email, push, etc.

n8n already has 400+ integrations — let it handle the fan-out.

### 2.4 Zapier / Pipedream

Same pattern: create a Webhook trigger, paste the URL into Token Meter,
configure downstream actions in Zapier/Pipedream. No custom code needed.

### 2.5 Run a local script

If you want a desktop script (clear cache, send notification, etc.) on each
fire, run a tiny HTTP receiver:

```javascript
// receiver.js — run with: node receiver.js
import { createServer } from 'node:http';
import { exec } from 'node:child_process';

createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const event = JSON.parse(body);
    console.log('Rule fired:', event.rule_name, event.metric_value);
    // Example: open a system notification on macOS
    exec(`osascript -e 'display notification "${event.rule_name}: $${event.metric_value.toFixed(2)}"'`);
    res.writeHead(200).end('ok');
  });
}).listen(9876);
```

Set Token Meter's webhook URL to `http://localhost:9876`.

### 2.6 Mobile push (Pushover, ntfy.sh)

[ntfy.sh](https://ntfy.sh) is the simplest mobile push that accepts a raw
webhook with no relay. Use a topic URL like `https://ntfy.sh/your-topic` and
subscribe on your phone.

Wrap the payload with a small relay for nicer formatting if needed.

---

## 2.7 ⚠ Webhook URL — security note

You set the webhook URL. Token Meter forwards the rule payload to whatever
URL you provide. **There is no allowlist.** Treat this like `curl` from
your own machine:

- The webhook fires from your local Token Meter process. It can reach
  anything your machine can reach, including **internal hosts and services
  on `localhost` / `127.0.0.1` / `10.x` / `192.168.x`**.
- Do **not** paste a webhook URL you do not control. A malicious URL can:
  - exfiltrate the rule payload (metric values, project paths, top model
    names) to a third party
  - probe your internal network (SSRF) — e.g. point at `http://localhost:6379`
    to confirm Redis is running
  - trigger actions on services that accept unauthenticated POSTs
- If you run other local services (databases, trading bots, internal APIs),
  pick webhook URLs that explicitly require auth tokens in the URL or
  payload, or relay through a public endpoint you control (Slack, n8n,
  Pipedream).
- Token Meter does **not** retry failed webhooks. Each rule fires once per
  cooldown window.

The 5-second timeout limits damage from slow targets but does not prevent
data exfiltration of the small payload.

---

## 3. Building your own "auto action" (advanced)

Token Meter intentionally does **not** ship automation that modifies your AI
workflow (auto-trim MCP, auto-stop sessions, model switching). That class of
feature ships in Pro+ (later) after careful design.

If you want to roll your own:

1. Receive the webhook in your script.
2. Use Claude Code's hooks system or write your own session orchestrator.
3. Take responsibility for the failure modes (a wrong "trim" can break your
   agent loop).

Token Meter gives you the signal. The action is yours.

---

## 4. Anatomy of a safe automation

If you're writing something that actually changes behavior (not just notify),
follow these rules:

- **Dry-run first**. Log what would have happened for at least a week before
  enabling real actions.
- **Idempotent**. The webhook may fire more than once if you misconfigure
  cooldowns. Your script must handle duplicate events.
- **Reversible**. Anything that mutates files / kills processes must have an
  obvious undo.
- **Logged**. Append every action to a local log file with timestamp and
  reason.
- **Rate-limited**. Even with our cooldown, your downstream should cap itself.

---

## 5. Built-in vs custom — what to expect

| Need | Built-in | Custom |
|---|---|---|
| "Notify me at $50/day" | ✅ desktop / email / webhook |  |
| "Send to my Slack channel" | webhook + 5-line relay | or use n8n directly |
| "Send to my phone" | webhook → ntfy.sh / Pushover |  |
| "Run a script when over budget" |  | ✅ local receiver |
| "Auto-trim Notion MCP responses" |  | Pro+ (later) or your own hook |
| "Switch to Sonnet when daily > $20" |  | Pro+ (later) or your own proxy |

If you build something useful, open an issue and share the recipe — we'll add
the best ones to this doc.
