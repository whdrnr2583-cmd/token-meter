<p align="center">
  <img src="https://raw.githubusercontent.com/whdrnr2583-cmd/token-meter/main/assets/logo-transparent.png" alt="Token Meter" width="120" height="120" />
</p>

# Token Meter

> Track Claude Code, Codex & Cursor token usage and cost locally — no account, no cloud.
>
> One local dashboard for your **Claude Code** and **Codex** token usage.
> Free, MCP-aware, MIT-licensed core.
>
> npm: [`@whdrnr2583/token-meter`](https://www.npmjs.com/package/@whdrnr2583/token-meter) · GitHub: [`whdrnr2583-cmd/token-meter`](https://github.com/whdrnr2583-cmd/token-meter) · Site: [token-meter.dev](https://token-meter.dev)

Token Meter parses the JSONL files that Claude Code and Codex already write to
disk and turns them into a real dashboard: cost per project, per model, per MCP
tool, per hour. Your data never leaves your machine.

## When to use this

Use Token Meter if you:

- want to know how many tokens and dollars your Claude Code or Codex sessions are costing — broken down by project, model, and MCP tool
- are on a flat-fee plan (Claude Max, etc.) and want to see what the equivalent API cost would be
- want to find which MCP server or tool is eating the most tokens, or which hour of the day is most expensive
- want to resume a recent session and need the `claude --resume` / `codex resume` command handy
- want all of the above offline, with no account and nothing uploaded

Not a fit if you need billing-grade numbers validated against your Anthropic or OpenAI invoice — Token Meter computes estimates from local JSONL files only.

## MCP tools

When Token Meter is wired as an MCP server (`install-mcp all`), four tools become available to your AI assistant:

| Tool | What it returns |
|---|---|
| `usage_summary` | Daily table of token counts, USD-equivalent cost, and call counts — broken down by day and model |
| `recent_sessions` | Latest sessions with paste-ready `claude --resume` / `codex resume` commands |
| `session_tools` | Per-tool breakdown inside a session: call count, total tokens, average latency, response size |
| `refresh_data` | Re-scans your local JSONL logs for new activity, then returns a fresh summary |

All four are read-only. No data leaves your machine.

## Example prompts

Copy-paste any of these into Claude Code or Cursor after installing the MCP server:

```
Show me my token usage and cost for the last 7 days.
```
```
List my recent sessions so I can pick one to resume.
```
```
Show the tool breakdown for my most recent session — which tool used the most tokens?
```
```
Refresh token-meter data, then tell me which model cost the most this week.
```
```
Which hour of the day am I spending the most tokens on?
```

## Quick start

```sh
npx @whdrnr2583/token-meter ingest        # scan ~/.claude/projects + ~/.codex/sessions
npx @whdrnr2583/token-meter stats 30      # CLI summary for last 30 days
npx @whdrnr2583/token-meter serve         # http://localhost:8765 dashboard
npx @whdrnr2583/token-meter mcp           # run as an MCP server for Claude Code / Cursor
```

> The package is published under an npm scope (`@whdrnr2583/`) because the
> bare `token-meter` name collides with an existing similar name on npm. The
> CLI binary is still called `token-meter` after install.

### Connect Token Meter to your AI tool (MCP)

One command registers Token Meter with every supported client on your machine:

```sh
npx -y @whdrnr2583/token-meter install-mcp all
```

Handles Claude Code, Cursor, and Claude Desktop — idempotent, backs up existing
config, preserves other MCP servers. Single-client variants:
`install-mcp claude-code | cursor | claude-desktop`. Add `--dry-run` to preview.

> **Or have your LLM do it.** Open Claude Code / Cursor / Claude Desktop and ask:
> *"Read https://raw.githubusercontent.com/whdrnr2583-cmd/token-meter/main/docs/mcp-server.md
> and set up token-meter as my MCP server."*

Manual one-liners (if you'd rather not run our installer):

| Client | Command / config |
|---|---|
| **Claude Code** | `claude mcp add token-meter -- npx -y @whdrnr2583/token-meter mcp` then `claude mcp list` to verify |
| **Cursor** | Edit `~/.cursor/mcp.json` (Windows: `%USERPROFILE%\.cursor\mcp.json`) — see [docs/mcp-server.md](docs/mcp-server.md#cursor) |
| **Claude Desktop** | Edit `claude_desktop_config.json` — see [docs/mcp-server.md](docs/mcp-server.md#claude-desktop) |
| **ChatGPT** | Stdio-only for now; HTTP wrapper recipe in [docs/mcp-server.md](docs/mcp-server.md#chatgpt-custom-connector--apps) |
| **Other (Continue, Zed, custom)** | `npx -y @whdrnr2583/token-meter mcp` over stdio |

Then ask: *"Use token-meter to show my recent sessions"* or *"Use token-meter usage_summary for this week"*.

> **Claude Code shortcut:** run `npx -y @whdrnr2583/token-meter install-command claude-code` once to register the `/token-meter` slash command. After reopening your session, type `/token-meter` for a one-shot summary without natural language.

Full setup + verification + troubleshooting: **[docs/mcp-server.md](docs/mcp-server.md)**.

Storage: `~/.tokenpulse/usage.db` (SQLite). Remove the folder to start over.
The folder name will become `~/.tokenmeter/` in a future release with an
automatic migration; until then the v0.1 directory keeps its original name.

## What you see

- **USD-equivalent cost** per day, model, project. Useful if you're on a Max
  plan and want to know what the API would have cost.
- **MCP and tool breakdown**: which MCP server is eating tokens, how slow each
  tool is on average, response sizes per call.
- **Hourly distribution** of output tokens.
- **Claude Code + Codex side-by-side**, in one view.

### A note on the dollar figures

Costs are **estimates** computed locally from the token counts that Claude
Code and Codex already write to their JSONL files, multiplied by the model's
published per-million-token rate. They are **not** validated against your
actual Anthropic / OpenAI invoice and may diverge for several reasons:

- Vendors change pricing; the table in `src/pricing.ts` is a snapshot
- Subscription plans (Pro / Max) bill a flat fee — the on-screen $ is what
  the API would have cost, not what you pay
- Some token categories (server-side tool use, cache write variants) are
  approximated

Treat the numbers as **relative signal** for spotting waste, not as
billing-grade accounting. Token Meter ships a regression test that the
calculation is reproducible, and an audit script that checks invariants;
neither verifies the rates against vendor invoices.

## Why local-first

- Your JSONL contains source code, prompts, and tool results. Token Meter never
  uploads any of it. Heuristics, regex, and SQL aggregation only.
- No SDK to integrate, no proxy to configure for the free tier.
- The CLI and dashboard core are **MIT licensed**.

## Pricing

| Tier | Price | What you get |
|---|---|---|
| **Free** | $0 | Claude Code + Codex parsing, MCP/tool breakdown, hourly/model/project breakdown, 7-day history, 1 desktop alert |
| **Pro** | **$5/mo** | Everything in Free, reframed as a monthly spend review: 30-day history (this month vs last), per-session/per-message drill-down to the run that blew the budget, cache-efficiency dollars saved, waste signals (oversized tool responses + cache that didn't pay off), plus unlimited smart alerts (desktop + webhook) |
| Pro+ | _later_ | Local LLM proxy (Ollama / LM Studio / llama.cpp / vLLM), GPU/VRAM tracking, auto actions |

Pro is the difference between glancing at last week's number and reviewing where the month's spend leaked. Pro is live — [Subscribe at token-meter.dev](https://token-meter.dev#pricing).

Pro+ ships once Pro sign-ups + community demand confirm the segment.

## Roadmap

- **M1** ✅ Claude Code parsing, MCP/tool breakdown, hourly stats
- **M2** ✅ Codex integration
- **M3** Pro tier ($5), Polar.sh billing, license activation
- **M4+** Pro+ (local LLM proxy, GPU tracking), conditional on demand

## Privacy & security

- Tokens are counted from the JSONL files Claude Code and Codex already write.
  Token Meter does not touch network APIs of either vendor.
- No prompt or response bodies are stored by default — only metadata
  (timestamps, token counts, tool names, response lengths).
- The database lives under `~/.tokenpulse/`; delete it to wipe. (Renamed to
  `~/.tokenmeter/` in a future release with an automatic migration.)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and breaking changes.

## License

MIT for the CLI, dashboard, and parsers. Pro-tier features ship in a separate
package under a closed source license.
