# Pro features — Token Meter

> **Status (2026-05-18)**: Pro gating is **live** — with no license every
> caller resolves to Free; an activated Pro license unlocks the Pro column.
> The table below is the source of truth for what ships **today**:
> ✅ = built and gated, 🛠 = planned (not yet shipped). The detailed specs
> further down may describe planned work — trust the table.

## Free vs Pro — one-line difference

| | Free ($0) | Pro ($5/month) |
|---|---|---|
| Sources (Claude Code + Codex) | ✅ | ✅ |
| Local SQLite, 100% offline | ✅ | ✅ |
| MCP / tool · project / model / hour breakdown | ✅ | ✅ |
| USD conversion (estimate) · average TPS | ✅ | ✅ |
| History window | 7 days | **30 days** ✅ |
| Desktop notification rule | 1 rule | **unlimited** ✅ |
| Webhook alert action | ❌ | ✅ |
| Session / message drill-down | ❌ | ✅ |
| Cache efficiency (hit ratio + savings) | ❌ | ✅ |
| Waste signals (tool outliers + unused cache) | ❌ | ✅ |
| Cost forecast + pacing alerts | ❌ | 🛠 planned |
| CSV / JSON export | ❌ | 🛠 planned |
| Weekly digest / recommendation email | ❌ | 🛠 planned |
| Auto-trim rule suggestions | ❌ | 🛠 planned |

✅ = built and gated today · 🛠 = planned, not yet shipped. Custom pricing
matrix and anonymous benchmark were evaluated and **dropped** (see
CHANGELOG 0.1.10) — neither fit the target user; their spec sections below
are kept only for the rationale.

Pricing rationale: see [05-decisions.md D-020](../05-decisions.md) (Pro $5 single tier with 81% gross margin under Gemini-automated support). Pro+ ($24) and Team are separate documents.

---

## Pro feature specs

### 1. 30-day history window

**Status**: ✅ implemented (storage layer keeps everything). Gating flips when
the license check runs.

- Free is artificially capped to the last 7 days of `token_events` and
  `tool_events` rows in dashboard / CLI / MCP queries.
- Pro returns 30 days. Older rows remain on disk but are filtered out of API
  responses.
- Pro+ (deferred) removes the cap entirely.

Why this gate: ccusage offers unlimited history for free. Free 7 days alone
loses on that single axis but wins on the other 5 (multi-vendor, MCP
breakdown, GUI, alerts, hourly variation). Pro upgrades the one axis we lose
on, which is a clean trigger.

**Surface**: dashboard period selector + `token-meter stats <days>` clamps to
the entitlement.

**Files**: gating happens at the query layer in `src/stats.ts`, `src/sessions.ts`,
and `src/server.ts` route handlers — no schema change.

---

### 2. Smart alerts — unlimited rules + webhook + email + weekly digest

**Status**: ✅ rules engine and all three actions are implemented
(`src/rules.ts`). What changes with Pro:

| Action | Free | Pro |
|---|---|---|
| `notify.desktop` (browser Notification API) | 1 rule | unlimited |
| `notify.webhook` (local fetch POST, 5s timeout, no retry) | ❌ | unlimited |
| `notify.email` | not available yet (new rules rejected with 400) | not available yet |
| `digest.weekly` (Sunday roll-up of the past 7 days) | ❌ | 1 (fixed) |

Rule fields, validation, cooldown, dry-run preview, firing log — all
unchanged from v0.1.x. The Pro license unlocks rule count + the non-desktop
action types.

**Pro+ scope (not in this document)**: behavior-changing actions
(`mcp.trim`, `model.switch`, etc.). Pro $5 only ships alerts that surface
information; no automation that mutates the user's setup.

**Surface**: dashboard Rules tab + `POST /api/rules`. Quota check rejects
rule creates that exceed the entitlement (HTTP 402 with a clear message
pointing to the upgrade page).

**Webhook security caveat**: still applies (see `docs/customization.md` §SSRF).
User-supplied URL, 5s timeout, no retry.

---

### 3. Session / message drill-down

**Status**: ✅ implemented (`src/sessions.ts`, `/api/sessions*`). Currently
exposed to everyone in dev. Pro gates it behind the license check.

What you get:
- **Top sessions table** by USD cost in the selected window, filterable by
  project.
- **Per-session overview**: total USD, model, project, timespan, message
  count, token sums.
- **Per-message breakdown**: input / output / cache-read / cache-write /
  USD for each assistant message in the session. Lets you answer "which
  message exactly was expensive?".
- **Per-session tool breakdown**: which MCP / built-in tools that session
  used, call counts, response sizes, average latency.

Why this is Pro: the basic "Daily spend totalled $X" stat lives in Free.
"Which 5-minute window inside that day cost half of it" is the next
question you ask once Free has hooked you, and that requires session
indexing + a longer history — exactly what Pro adds.

**Surface**: dashboard sessions tab (drill-in from any day/project row) +
`GET /api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/messages`,
`/api/sessions/:id/tools`.

---

### 4. Cost forecast + pacing alerts

**Status**: ❌ not implemented. Spec only.

Two views:
1. **Projection card** on the dashboard: "Current pace → end-of-month
   $X (±Y%)". Linear extrapolation from the elapsed days of the calendar
   month. Compare against the previous month and the user-configured
   monthly budget if set.
2. **Pacing rule**: a built-in rule template "50% of monthly budget reached
   before day N" with `metric: monthly_usd`, op `>=`, threshold computed
   from the user's budget setting. Fires through the existing rules engine
   so it inherits cooldown / dry-run / firing log.

Why Pro: the projection turns Token Meter into a pre-incident tool ("you'll
overshoot by Friday at this rate"). Free is post-incident ("you spent $X
last week").

**Implementation sketch** (~3-4h):
- Add `monthly_budget_usd` to a new `user_settings` table or a config row.
- Add `forecastMonthly(db, asOfDate)` in `src/stats.ts` returning
  `{ pace_usd_per_day, projected_eom_usd, budget_pct_today,
  budget_pct_projected, days_remaining }`.
- Dashboard renders a small card; CLI `stats` prints the line.
- Pacing rule = preconfigured rule the user can enable with one click.

**Estimation honesty**: linear extrapolation only. No seasonality, no
"weekend dips". The card carries an "(estimate)" label.

---

### 5. CSV / JSON export

**Status**: ❌ not implemented. Spec only.

Two surfaces:
- **UI**: download button on the dashboard period selector → `export.csv` /
  `export.json` for the current window.
- **CLI**: `token-meter export csv [days] [--out path]` /
  `token-meter export json [days] [--out path]`.

Columns (CSV) / fields (JSON) match `token_events` minus internal fields,
plus a `usd_cents` integer column (because Excel mangles floats).

What it's for:
- Accounting / expense reports.
- Feeding into external BI (Metabase, Grafana, a Google Sheet).
- Cross-checking against vendor invoices once they post.

Why Pro: low-frequency, high-value. Casual users don't need it; paid users
on accounting flows need it monthly. Single-feature trigger.

**Implementation sketch** (~2h):
- `src/export.ts` with `exportCsv(db, days)` / `exportJson(db, days)` —
  pure functions returning a buffer/string.
- Dashboard route `GET /api/export?format=csv&days=30` (Pro-gated).
- CLI subcommand wires the same functions to stdout / file.

Pro window: caps at 30 days (matches history limit). Pro+ removes the cap.

---

### 6. Custom pricing matrix

**Status**: ❌ not implemented. Spec only.

Lets a user override per-model pricing — typical use case is a company
with an Anthropic / OpenAI volume contract where the published per-token
rates don't apply.

UI: a settings page with editable rows: `model`, `input_per_mtok`,
`output_per_mtok`, `cache_read_per_mtok`, `cache_write_per_mtok`,
`effective_from`. Overrides win over the built-in pricing table for events
on or after `effective_from`.

CLI: `token-meter pricing import <file.json>` / `pricing reset`.

Storage: new `pricing_overrides` table, scoped to local DB (never synced).

Re-cost rule: when a user adds / edits an override, run a backfill that
recomputes `usd_estimate` for matching rows in `token_events`. Show a "this
will recompute N rows" confirmation.

Why Pro: the built-in price table is good enough for the 90% case. The 10%
with custom contracts are paying customers by definition — this is what
they're buying.

**Implementation sketch** (~3-4h):
- Schema: `pricing_overrides(model TEXT, input_per_mtok REAL, ...,
  effective_from INTEGER, created_at INTEGER, PRIMARY KEY (model,
  effective_from))`.
- `src/pricing.ts` consults overrides first, falls back to built-in.
- Backfill via a single `UPDATE token_events SET usd_estimate = ...` with
  recomputed values for affected rows.
- Dashboard settings tab + CLI commands.

---

### 7. Weekly recommendation report

**Status**: ❌ not implemented. Spec only. **One LLM call per user per
week, budget-capped at $0.20/user/month** (D-020 internal-token cap).

Sunday rollup of the past 7 days, sent via the existing weekly digest action
(spec §2). The body is generated by:
1. Heuristic pass (no LLM) gathers facts: top 3 sessions by USD, top 3
   models by USD, MCP breakdown, day-of-week distribution, cache hit ratio,
   week-over-week delta.
2. Single LLM call with the facts table → "you spent the most on X session,
   here's what was unusual" + 2-3 concrete suggestions (e.g. "switch to
   Sonnet for the file-listing pattern you used 30 times").

The LLM is asked for **actionable text only** (no quotes, no chain-of-thought,
no apologies). Strict token budget per call so a Pro user's month stays
under $0.20 even at 4 reports.

Why Pro: the heuristic facts alone (already shown on the dashboard) don't
trigger spend reduction — most users need someone to point at the change.
This is the cheapest version of "someone reviewing your bill".

**Implementation sketch** (~4-5h):
- `src/report.ts` — facts gatherer (pure heuristic).
- `infra/api/` worker route `/v1/report/weekly` accepts the facts table,
  calls the LLM, returns the text. Worker holds the API key; the local DB
  never sees it.
- Weekly digest action calls the route, formats the email.

---

### 8. Anonymous usage benchmark (opt-in)

**Status**: ❌ not implemented. Spec only. Opt-in by default-off setting.

When enabled, Token Meter ships **aggregated daily stats** (USD, token sums
by category, model mix, MCP top-10) — no project names, no session IDs, no
JSONL content. The dashboard then shows a "you vs the cohort" card: "your
median session cost is in the 60th percentile" / "your cache hit ratio is
below the median".

Why Pro + opt-in: D-008 [[D-008]] established opt-in only with explicit
consent. The aggregate stats are a real value-add (people want to know
whether their bill is high or normal) but require enough opt-in volume to
be meaningful, so it's gated to Pro to align who pays with who provides
the data.

Privacy guarantees:
- Aggregation happens **on the user's machine** before sending. Server never
  sees per-event rows.
- IP not logged on the receiving end.
- Opt-out wipes the user's contribution from the cohort within 24h.

Defer until: 100 Pro users active. Until then the toggle is hidden behind
a `?beta` query flag.

**Implementation sketch** (~6-8h, mostly the worker + the privacy doc).

---

### 9. Auto-trim rule suggestions (Pro $5 — suggestions only)

**Status**: ❌ not implemented. Spec only. **Suggestions, not auto-execute.**

Pro $5 surfaces text suggestions like:
- "Your `notion.search_pages` calls return ~5kB per call (1,200 calls/week).
  Configuring `fields` to drop `body_html` would save ~3kB/call ≈ $X/week."
- "Tool `Read` on `**/*.png` triggered 47 times this week. Consider an
  exclude pattern."

The user copies the suggestion, applies it manually in their MCP config /
Claude Code settings. Token Meter does **not** modify any external config.

Pro+ extends this with automated action (`mcp.trim` etc.) — that's deferred.

Why Pro $5 only does suggestions: trust cost of behavior-changing actions
is high (D-007 [[D-007]]). $5 unit economics can't absorb support for
"Token Meter broke my MCP server" claims. Pro+ ($24) crosses that line
once we have trust evidence.

**Implementation sketch** (~3-4h):
- Pattern detectors over `tool_events` (large responses, repeated calls,
  high-latency tools).
- Each detector emits a `{ tool, mcp, evidence, savings_estimate, action_text }`
  payload.
- Dashboard renders a Recommendations card.
- Weekly report includes the top 3.

---

## Free → Pro upgrade triggers (UX copy)

These show up in the Free dashboard at the right friction points:

- **History wall (day 8)**: "You've been using Token Meter for 7 days. Pro
  keeps the full 30-day history. → Upgrade".
- **Rule cap (2nd rule create)**: "Free includes 1 desktop rule. Add
  webhook / email / unlimited rules with Pro. → Upgrade".
- **Drill-down click**: "Session drill-down is a Pro feature. → Try Pro
  for 14 days".
- **Export click**: "Export to CSV / JSON is a Pro feature. → Upgrade".

No upgrade prompt on tabs the user hasn't tried yet. No interstitials. No
email nag.

---

## What's intentionally **not** in Pro $5

- **Local LLM proxy** (Ollama / LM Studio / llama.cpp / vLLM) — Pro+ (D-014).
- **GPU / VRAM tracking** — Pro+ (D-014).
- **TTFT / ITL millisecond accuracy** — Pro+ (proxy mode only, D-015).
- **Behavior-changing automations** (auto-trim execute, model auto-switch,
  cloud↔local routing) — Pro+ (D-007).
- **Multi-machine sync** — Pro+.
- **PDF auto-reports** — Pro+.
- **Team features** (shared DB, policies, per-seat dashboards) — Team
  (deferred, TBD-1).

---

## Implementation rollout order (when paid wiring lands)

1. **History gating (1)** + **rule gating (2)** + **drill-down gating (3)** —
   already-implemented features, just add the entitlement check (~30min).
2. **CSV / JSON export (5)** — small standalone feature, +2h.
3. **Cost forecast + pacing alerts (4)** — +3-4h.
4. **Custom pricing matrix (6)** — +3-4h.
5. **Auto-trim suggestions (9)** — +3-4h.
6. **Weekly recommendation report (7)** — +4-5h (needs the worker route).
7. **Anonymous benchmark (8)** — deferred until 100 active Pro users.

Total Pro $5 shipping budget excluding (7) and (8): **~12-15h** beyond the
license-gating + Polar wiring work itself.

---

## See also

- [05-decisions.md](../05-decisions.md) — D-020 / D-024 / D-026 / D-031.
- [STRATEGY.md](../STRATEGY.md) — pricing table, competitive comparison.
- [docs/customization.md](customization.md) — webhook payload spec, SSRF
  caveats (applies to free + Pro alike).
- [docs/mcp-server.md](mcp-server.md) — MCP tools (all Free, unchanged).
