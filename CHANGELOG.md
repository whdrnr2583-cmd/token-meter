# Changelog

All notable changes to Token Meter.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.26] — 2026-07-12

### Fixed
- **Dynamic-workflow sub-agent JSONL files were silently dropped from
  ingest.** Claude Code's dynamic workflows nest sub-agent transcripts one
  level deeper than the flat `<sessionId>/subagents/agent-<id>.jsonl`
  layout — `<sessionId>/subagents/workflows/<workflowId>/agent-<id>.jsonl`
  instead. The prior scan only read `.jsonl` files directly inside
  `subagents/` (1-depth), so every workflow sub-agent's usage was never
  ingested (measured on a real machine: 890 files, ~$820 uningested).
  `ingestClaudeCode()` now recurses into `subagents/` (mirrors
  `codex-ingest.ts`'s existing `walkJsonl` recursion + symlink-safety
  shape), picking up both the flat and nested layouts; `agent_id` is
  derived from the file's basename either way. Regression:
  `test/ingest-subagent.test.ts`.
- **Codex sessions living only on the Windows side of a WSL install were
  never ingested.** `codexSessionsDir()` only ever returned the WSL
  home-dir path (`~/.codex/sessions`); a Codex CLI that had only run on
  Windows left that path ENOENT while every real session sat under
  `/mnt/c/Users/<profile>/.codex/sessions`, so Codex usage silently
  ingested $0. New `codexSessionsDirs()` mirrors `claudeProjectsDirs()`'s
  existing WSL → Windows fallback and scans every discovered directory.
  `isWsl()`/`scanWindowsUserDirs()` moved out of `ingest.ts` into a new
  shared `src/platform.ts` so `codex-ingest.ts` can reuse them without a
  circular import; both are re-exported from `ingest.ts` for back-compat.
  Regression: `test/codex-ingest.test.ts`.
- **Codex usage was billed to the session's first-seen model even after a
  mid-session model switch.** `codex-parser.ts` derived `model` once from
  `session_meta`/`base_instructions` at the start of the file and used it
  for every `token_count` event in that session. Codex's `turn_context`
  entries carry the model actually serving each turn; a session that
  switched models mid-way (e.g. `gpt-5.3-codex-spark` → `gpt-5.4`) had
  every turn after the switch billed at the stale model's rate. The parser
  now tracks `currentModel` from the latest `turn_context.payload.model`
  seen and re-reads it before pricing/model on every `token_count` event;
  logs with no `turn_context` at all (older Codex versions) fall back to
  the session_meta-derived model as before. Added pricing rows for
  `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5` (confirmed 2026-07-12 via
  developers.openai.com/api/docs/pricing) and a placeholder rate for
  `gpt-5.3-codex-spark` (not yet published — flagged with a TODO), plus a
  `codex` substring fallback bucket so an unrecognized future
  `gpt-5.x-codex` variant prices under `gpt-5-codex` instead of the
  generic `gpt-5` rate. Regression: `test/codex-model-detection.test.ts`.

### Added
- **Sub-agent labels.** Claude Code writes a sibling `<agentId>.meta.json`
  (`{ agentType, description }`) next to each sub-agent's
  `<agentId>.jsonl`. Ingest now parses it opportunistically
  (malformed/missing meta.json never blocks token/tool ingest) into a new
  `agent_meta` table, keyed by `agent_id`. `subagentCosts()` LEFT JOINs it
  so the MCP `subagent_costs` tool's per-agent lines show the human label
  (e.g. `general-purpose`) instead of the raw hash, falling back to
  `agent_id` when no meta.json was found.
- **Codex tool-call events.** Codex JSONL logs `function_call`/
  `custom_tool_call` entries paired with a later `function_call_output`/
  `custom_tool_call_output` by `call_id` — previously ignored entirely
  (Codex sessions only ever produced `token_events`, never `tool_events`).
  `codex-parser.ts` now pairs them into `ToolEvent`s (response size,
  estimated tokens, latency from call → output), reusing `parser.ts`'s
  existing token-estimate heuristic; an unmatched pending call (session
  ended mid-call) is simply never flushed, not guessed.
  `CodexIngestSummary` gains a `tool_rows_inserted` count alongside
  `token_rows_inserted`. Regression: `test/codex-tool-events.test.ts`.
- **`tool_events.file_ext` column** — the lowercased file extension (no
  dot) extracted from a `tool_use` call's `file_path`/`path`/
  `notebook_path` argument at parse time. Only the extension is ever
  stored, never the full path or any other input field (command text etc.
  may be sensitive). Additive/nullable column + index.

### Changed
- **REPEATED_BINARY trim-suggestion now matches real file extensions
  instead of guessing from the tool name.** Previously reframed (0.1.x) as
  a "high-frequency read" heuristic because `tool_events` had no path/args
  column to detect binary extensions from. With `file_ext` now captured,
  the detector queries `tool_events.file_ext IN (png, jpg, ..., pdf,
  zip, ...)` directly and can fire on any tool name, not just ones with
  "read" in it. Calls with no captured `file_ext` (rows ingested before
  this column existed, or tool_use calls with no path-like argument) fall
  back to the pre-existing high-frequency-read heuristic, so no coverage
  is lost.

### Notes
- **A plain `ingest --force` after upgrading to this version will report a
  much larger `files_scanned` than before, for both Claude Code and
  Codex.** This is expected — the recursive `subagents/` scan and the
  multi-directory Codex scan (both under Fixed above) now discover files
  the previous ingest silently skipped. It is not a bug or a sign of
  duplicate/corrupted data; the added rows are the previously-missing
  usage.

## [0.1.25] — 2026-07-11

### Fixed
- **Sub-agent totals could be frozen at a partial value by the dashboard's
  30-second re-ingest.** `insertTokenEvents()` used `INSERT OR IGNORE`, so once
  a row for a `request_id` existed a later re-parse could never update it. When
  `token-meter serve` polled a sub-agent JSONL file mid-flush (only the
  `thinking`/`text` blocks on disk, `output_tokens`=2), it persisted that
  partial total; when the `tool_use` block later landed (e.g. `output_tokens`
  =772) the completed re-parse was silently skipped, re-introducing the ~98%
  under-count `fcc2cc0` fixed — this time *across* ingest runs rather than
  within one file. The insert now upserts on the `(source, request_id)` index,
  overwriting the stored row only when the re-parsed total is strictly larger
  (`ON CONFLICT ... DO UPDATE ... WHERE excluded.total > stored.total`), so a
  completed value wins on the next poll while a smaller/truncated read can never
  clobber it. Equal-total re-ingests stay a no-op (D-027 dedup + historical
  price snapshots preserved), and a plain `ingest --force` now repairs any rows
  a prior build had frozen. Regression: `test/db-reingest-growth.test.ts`.

### Changed
- **`scripts/quality-audit.cjs` no longer false-FAILs across a scheduled
  in-place rate change.** The pricing-reproducibility check hard-fails
  `ingested_at`-stamped rows whose stored `usd_estimate` no longer matches the
  `pricing.ts` on disk. For a model whose rate changes in place on a known date
  (claude-sonnet-5: intro $2/$10 → standard $3/$15 on 2026-09-01), a row stamped
  before that date was correctly priced at the time and would false-FAIL after
  9/1. Such pre-change stamped rows are now downgraded to a warning; mismatches
  on any other model, or on a row stamped on/after the change date, still
  hard-fail.

### Added
- **Regression test for `infra/site/calculator.html`'s pricing mirror**
  (`test/calculator-pricing-sync.test.ts`). The public calculator carries a
  third hand-copied price table; it now cross-checks every rate against
  `src/pricing.ts` and asserts the current-flagship rows are present — the same
  drift guard `quality-audit.cjs`'s mirror already has (the sonnet-5 row went
  missing once, in 57c11d5).
- **`/api/subagents` route test now exercises the real handler logic.**
  `daysFromQuery()` is exported from `src/server.ts` and called by the test, so
  `parseDays` range/NaN validation and the Free-tier history clamp are genuinely
  covered instead of re-implemented in a looser test-only handler.

## [0.1.24] — 2026-07-11

### Added
- **Sub-agent panel on the dashboard.** New `GET /api/subagents` endpoint
  (main vs. sub-agent 30-day USD/token split + top-5 priciest sub-agents),
  reusing the same `subagentCosts()` SQL that already powers the MCP
  `subagent_costs` tool. Dashboard gets a matching card
  (`#subagents-section` in `public/index.html`) with 3 number cards + a short
  top-5 table — no new chart. Free tier, same as the other stats endpoints.

### Changed
- **`token_events` gains an `ingested_at` column** (nullable TEXT, ISO
  timestamp), stamped once per `insertTokenEvents()` batch at insert time.
  Existing rows stay `NULL` forever — they are never backfilled. This
  distinguishes "when the event happened" (`ts`, from the source JSONL) from
  "when this DB learned about it" (`ingested_at`), and lets
  `scripts/quality-audit.cjs`'s pricing-reproducibility check (#3) hard-fail
  on rows we know were priced by the pricing.ts currently on disk, instead of
  only warning across rows that may carry a frozen historical price.

## [0.1.23] — 2026-07-10

### Fixed
- **Sub-agent (Task/Agent) JSONL usage was undercounted by ~98% on real
  logs.** Claude Code splits one API turn into several assistant JSONL
  entries that share a `request_id` (one for the `thinking` block, one for
  `text`, one for `tool_use`). In the interactive CLI's own session files
  every split entry already carries the identical *final* usage, so billing
  whichever one arrived first was safe. Sub-agent files under
  `<session>/subagents/agent-<id>.jsonl` instead stream usage
  *incrementally* per block — `output_tokens` grows with each later entry
  (e.g. 2 → 2 → 772 in captured data) while model/input/cache tokens stay
  fixed, and only the **last** entry for a `request_id` carries the
  completed total. The parser billed the first entry, undercounting
  sub-agent output tokens by ~98% (measured: 40,868 vs. 2,420,932 output
  tokens across 459 sub-agent files on the dogfood machine, a ~59x gap
  affecting 4,424 of the multi-entry request groups found). `src/parser.ts`
  now keeps one slot per `request_id` and overwrites it whenever a later
  sighting carries a larger total token count (ties keep the latest), so the
  completed total wins even if a sub-agent file's split entries are read out
  of append order or a trailing entry is partially written — main-session
  files are unaffected (their duplicates are already identical, so the tie
  rule bills the latest, matching prior behavior). Directly affects
  `subagent_costs` (MCP tool + CLI `stats`) accuracy.
- **CHANGELOG entry for the 2026-07-06 Sonnet 5 pricing fix** (commit
  `90ad0fa`, shipped without one): Sonnet 5 was falling through the
  `sonnet` substring fallback to `claude-sonnet-4-6` rates ($3/$15) — the
  post-2026-09-01 standard price — instead of its current introductory rate
  ($2/$10, through 2026-08-31), overstating Sonnet 5 cost ~50%. Added an
  explicit `claude-sonnet-5` pricing row and pointed the family fallback at
  it.

### Site
- **`/calculator` was missing a Sonnet 5 option entirely** — the model this
  project itself now runs on couldn't be selected. Added the
  `claude-sonnet-5` row (with an introductory-pricing-through-2026-08-31
  note) to the calculator's pricing table and model picker.

### Notes
- Existing `agent_id`-tagged rows already sitting in a user's local DB from
  *before* this fix are not retroactively corrected by a plain `ingest`
  (the DB's `(source, request_id)` unique index makes re-parses `INSERT OR
  IGNORE`, not upsert — matches the D-027 dedup design). A user who wants
  historical sub-agent totals corrected needs a delete-then-reingest of
  just their sub-agent-file rows, not just `ingest --force`; not shipped as
  an automated migration in this release — flag if this comes up.

## [0.1.22] — 2026-06-29

### Fixed
- **Corrected Claude Opus pricing — was overstating Opus cost ~3×.** The pricing
  table still carried the old Opus 4.0/4.1 rate of $15/$75 per million tokens for
  Opus 4.6/4.7, but Opus 4.6+ is **$5/$25**. USD-equivalent estimates for Opus
  models (and the cache-saving figures derived from them) were inflated ~3×; they
  are now correct. (OSS-maintain bug patch.)

### Added
- **Claude Opus 4.8 and Fable 5 pricing.** Opus 4.8 ($5/$25) and Fable 5
  ($10/$50) are now in the pricing table, with the model-family fallback updated
  so unknown `opus*` IDs resolve to current Opus pricing and `fable*` to Fable 5.

## [0.1.21] — 2026-06-28

### Security
- **Local proxy now binds to 127.0.0.1 only.** `token-meter proxy` (v0.1.20)
  started its HTTP server with no host argument, so Node bound it to 0.0.0.0
  (all interfaces) — exposing the proxy, and the local LLM behind it, to the
  LAN — even though the startup log claimed `http://127.0.0.1`. Now bound to
  loopback, matching the dashboard's local-first 127.0.0.1 invariant. No API
  change. (OSS-maintain bug/security patch — D-042.)

## [0.1.20] — 2026-06-28

### Added
- **Local LLM proxy (foundation).** `token-meter proxy [--port N] [--backend URL]
  [--label NAME]` runs a transparent reverse proxy in front of any
  OpenAI-compatible local server (Ollama :11434 default, LM Studio, llama.cpp,
  vLLM). It passes every request through byte-for-byte and *measures*
  `/v1/chat/completions` calls — TTFT, total duration, output tokens, and TPS —
  for both streaming (SSE) and non-streaming responses. This is the one
  performance dimension the cloud JSONL path can't see (millisecond TTFT/TPS),
  and the headline differentiator no competitor offers.
- **`token-meter local [days]` CLI view** + `localPerf()` query: per (source,
  model) average TPS / TTFT and call counts for proxy-captured local runs.
- New `ttft_ms` column on `token_events` (additive, nullable); local calls are
  stored with `source_kind='local'` and `usd_estimate=0` (no per-token API
  charge — GPU/electricity cost modelling is a later increment).

### Notes
- Metric capture is strictly best-effort: if parsing a response throws, the
  proxy still forwards it unchanged. Output tokens fall back to a ~3.5 char/token
  estimate (flagged) when the server omits a `usage` block.
- Scope: foundation only — OpenAI-compatible `/v1/chat/completions`
  instrumentation. GPU/VRAM tracking, behaviour-changing automation, and the
  benchmark lab remain on the Pro+ roadmap.

PMF gate note: 0 paid users — 2nd intentional override this session
(user decision 2026-06-28, D-041). Strongly re-frozen afterward.

## [0.1.19] — 2026-06-28 (shipped within 0.1.20 — never published standalone)

### Added
- **Sub-agent cost attribution.** A new `agent_id` column (added to
  `token_events` / `tool_events`) tags every row that came from a Task/Agent
  sub-agent JSONL file (`<project>/<sessionId>/subagents/agent-<id>.jsonl`).
  The tag is taken from the **file path**, not the JSONL body — sub-agent
  entries carry the *parent* `sessionId`, so without this the Haiku/Sonnet
  tokens a sub-agent burns are indistinguishable from main-session spend.
- **`subagent_costs` MCP tool** (+ matching prompt) and **`token-meter
  subagents [days]` CLI command**: split spend into main-session vs sub-agent
  work, rank the priciest sub-agents (model mix · tokens · cache read/write),
  and pair them with parent-side Task/Agent invocation latency — answering
  "are my sub-agents worth what they cost." LLM-free (hard-coded SQL).
- `subagentCosts()` query in stats.ts (split / share % / top-N / invocations).

### Changed
- Schema migration is additive and nullable — USD-conservation and dedup
  invariants are untouched (audit still passes). Run **`token-meter ingest
  --force` once** after upgrading to backfill `agent_id` onto historical
  sub-agent rows; the insert path backfills the tag onto an already-stored
  row only when its current value is NULL, so a main-session pass never
  clobbers a tag.

### Why
Extends the project's strongest differentiator ("MCP / per-tool analysis") to
the one cost dimension the schema previously could not answer at all. Dogfood
data motivated it directly: sub-agent (`Agent`) calls dominated latency
(91.6s avg) and a large share of tokens, but their *cost* was folded into the
parent session with no way to separate it.

PMF gate note: published with 0 paid users — 1 intentional override (user
decision 2026-06-28, D-040). New features frozen again post-publish until the
PMF gate advances.

## [0.1.18] — 2026-06-15

### Changed
- **De-monetization copy pass on the MCP surface.** Replaced the `Pro $5/mo`
  call-to-action in the tool footer and the `usage_summary` server hint with a
  neutral open-source pointer (`open source · npm install -g @whdrnr2583/token-meter`).
  No paywall, price, or subscribe link is emitted from any MCP tool response.

### Why
Apps-Directory / commerce-policy alignment: marketplace listings disallow digital-goods
promotion (price · Subscribe · payment URLs) inside tool output. This is a copy-only
change — no product feature was added, removed, or altered. Pricing remains documented
on the landing page and README, not in MCP responses.

## [0.1.17] — 2026-05-27

### Added
- **Cost forecast** (`usage_summary`): projects daily/weekly/monthly spend based on current-period
  pace so users can see "at this rate, this month will cost $X" before the bill arrives.
- **CSV / JSON export** (`token-meter export [--format csv|json] [--days N]`): dump the usage
  table to a file for use in spreadsheets, BI tools, or custom scripts.
- **Weekly digest** (`token-meter digest`): summarises the past 7 days — top models, top
  projects, cache efficiency, and waste signals — in a single terminal block. Designed for a
  Monday morning `npx @whdrnr2583/token-meter digest` habit.
- **Trim suggestions**: when the `session_tools` MCP tool (or CLI equivalent) detects
  outlier-large tool responses (>95th-percentile chars), it now appends a concrete
  "trim this tool" recommendation with the estimated token savings.

### Why
Pro-tier value consolidation. CSV/JSON export and forecast were the two most-requested
items from dogfood sessions; weekly digest and trim suggestions close the
"I know I'm spending but I don't know what to do about it" loop.

PMF gate note: published with 0 paid users — 1 intentional override (user decision 2026-05-27).
New features frozen again post-publish until PMF gate advances.

## [0.1.16] — 2026-05-20

### Added
- **Daily table with one row per (day, model)** in `usage_summary`. Primary
  view is a fixed-column table (Day · Model · Input · Output · Cache_rd ·
  USD) where each model used on a given day gets its own row — so 5/15
  opus-4-7 / haiku-4-5 / sonnet-4-6 split into three lines with their own
  token counts and cost, instead of collapsing into one combined row. ccusage
  inspired but stricter: a 99% Opus / 1% Haiku day no longer looks the same
  as a 50/50 day. The narrative "Where / Slowest / Heaviest" stays underneath
  as an advisory spotlight, no longer the top-of-output anchor.
- **`scope` parameter** on `usage_summary` — auto-detects current platform
  (`process.platform: linux → WSL/Linux`, `win32 → Windows`) and filters
  rows accordingly so a Claude Code session on WSL doesn't get mixed with
  Codex / Windows-Claude data. Values: `auto` (default) · `all` · `wsl` ·
  `linux` · `win` · `windows` · `codex` · `claude-code`. Overridable via
  `TOKEN_METER_SCOPE` env var. Banner shows the active scope; a hint surfaces
  how much spend is hidden ("$X.YY hidden — pass scope=\"all\" to include").
- New `dailyByModel()` query in stats.ts and a `ScopeFilter` type usable by
  callers (CLI, dashboard) that need the same source separation.
- Regression test `test/ingest-subagent.test.ts` and standalone verifier
  `scripts/verify-subagent-scan.mjs` for the sub-agent JSONL scan path.

### Discovery & trust footer (all tools)
- **3-line discovery footer** appended to every tool reply, all
  hard-coded plain text so the cost of telling users about sibling tools
  and project URLs is **zero inference tokens**:
  1. Trust: `ⓘ 100% local · 0 LLM calls — this output is hard-coded`
  2. Sibling pointer: tool-specific `🔧 Next: …` cross-promotion
  3. Links: `🔗 token-meter.dev · github.com/whdrnr2583-cmd/token-meter · Pro $5/mo (...)`
- **Server `instructions` field rewritten** with a structured list of all
  4 MCP tools + 3 CLI commands (`stats`, `serve`, `install-mcp`) + the
  project URLs. Surfaced at the MCP connect handshake so even a user who
  never calls a tool still sees the full surface.
- **Empty-state path** ("no usage data yet") now ends with the same
  discovery footer instead of trailing off, so the first-run user knows
  where to go next.

### Visual design polish
- **Day-group divider** — light `· · · ·` dots between days so multi-model
  rows from the same day group visually (kept lighter than the heavy `─`
  table boundary, per Tufte data-ink ratio).
- **`Calls` column** — per-(day, model) API call count. Knowing Haiku ran
  177 calls vs 4 calls is meaningful even when the dollar share is small.
- **`%day` column** — model's share of that day's spend. `<1%` is shown
  for non-zero but rounds-to-zero shares so "tiny but present" stays
  distinguishable from "literally zero".
- **Total row uses `═` heavy separator** with a blank line above so it
  reads as a footer, not just another data row. No ANSI color (MCP
  clients vary in support).
- **`scope` hidden hint moved to its own line** under the title. When the
  breakdown gets long (multi-source), folding it keeps the header
  scannable instead of running across.
- **Footer collapsed to a single line** — trust signal + Pro CTA combined
  to keep MCP-tool responses lean.

### Changed (readability fixes from review)
- **Slowest excludes user-blocking tools.** `AskUserQuestion` (and any
  human-input tool) used to dominate the "Slowest" line at e.g. 178s avg —
  pure reaction-time, not tool latency. They are now excluded from
  `Slowest`; a separate `User wait` line surfaces them so the info isn't
  lost, with a "time spent waiting on you, not the tool" disambiguator.
- **`scope` hidden hint breaks out by source.** Instead of a single
  "$86.36 hidden by scope" amount, the banner now shows
  `hidden: Windows $84.93 · Codex $1.43` so the reader knows *what* was
  excluded, not just *how much*. Complementary platform and Codex slices
  are queried once per call.
- **`Cache_R` column renamed to `Cache_rd`** to disambiguate from
  "% cache reuse" in the Summary line — same prefix, different concept.
- **`session_tools` adds a per-tool % share.** Each row now shows
  `(N.N%)` next to `resp=` — "Bash 49.7% · Read 47.5%" makes the
  dominant tool obvious instead of asking the reader to mentally divide.

### Fixed
- **Sub-agent JSONL files were silently dropped from ingest** — Claude Code
  writes each Task / Agent invocation to
  `<project>/<sessionId>/subagents/agent-<id>.jsonl` (two levels deep).
  v0.1.15 ingest only read `.jsonl` at the project root, so every Haiku /
  Sonnet / overridden-model row dispatched through a sub-agent was missed.
  Re-ingesting on a representative machine recovered ~3,900 Haiku + ~1,600
  Sonnet events that were invisible to the per-model breakdown. Plus
  historical `claude-opus-4-6`, `claude-opus-4-5`, `claude-sonnet-4-5`
  models that had no recorded events at all are now surfaced.

### Why
Tester feedback (3 paid Claude users, 2026-05-19) was consistent: "the
single $-line is interesting, but I don't know what to look at." The
ccusage convention (per-day rows · models surfaced as labels · totals at
the bottom) gives the answer at a glance instead of asking the reader to
parse one dense narrative line. Source isolation removes the "why do I
see Codex when I'm in Claude Code" confusion. The sub-agent fix landed
in the same patch because the model breakdown is the new headline view
— it would have been misleading without the missing Haiku / Sonnet data.

### Notes
- `src/*.ts` for files **other than** mcp.ts / stats.ts / ingest.ts /
  db.ts / pricing.ts remain at v0.1.8 line counts. v0.1.9 → v0.1.15 work
  was published from an external build location and the corresponding
  source was never committed here. v0.1.16 reconstructs only the files
  needed for this release; the other dist files are preserved verbatim
  from the v0.1.15 npm artifact. Tracked as TODO for v0.1.17+.

## [0.1.8] — 2026-05-15

### Changed
- **GitHub repository renamed** `whdrnr2583-cmd/tokenmeter` →
  `whdrnr2583-cmd/token-meter` for naming consistency with the npm
  package (`@whdrnr2583/token-meter`) and the domain
  (`token-meter.dev`). GitHub auto-redirects the old URL, so existing
  links keep working; all in-repo references and the embedded raw URLs
  used by the "ask your LLM to set it up" path have been updated to the
  new URL.
- README now includes a one-line lookup row near the top:
  npm · GitHub · site links in canonical form, so anyone copy-pasting
  from the npm page can find the repo without guessing.

### Why
A reader reported the GitHub URL guessed from the npm scope
(`whdrnr2583/token-meter`) returns 404 — the actual owner is
`whdrnr2583-cmd` and the repo was `tokenmeter` (no hyphen). Trust
hit at the discovery step. Fix is a one-time rename plus an explicit
lookup row; no behavior change. D-035.

---

## [0.1.7] — 2026-05-15

### Added
- **`/token-meter` slash command for Claude Code**. Run
  `npx -y @whdrnr2583/token-meter install-command claude-code` to install
  a short markdown file at `~/.claude/commands/token-meter.md`; after a
  Claude Code restart, typing `/token-meter` triggers a single summary
  view that calls the `usage_summary` MCP tool and appends a one-block
  hint about the other slash commands, the CLI, and the Pro tier.

  This is in addition to the existing MCP prompts. MCP clients always
  prefix prompts as `/mcp__token-meter__<name>` (spec-mandated); the new
  custom slash command is the way to get a short `/token-meter` entry
  point. Currently `install-command claude-code` is the only supported
  client — Cursor / Claude Desktop use different slash-command systems
  and are out of scope for this release.

  Idempotent (re-run is `already-present`). Backs up an existing managed
  file to `<path>.bak` before overwriting. Refuses to overwrite an
  unmanaged file (no `@whdrnr2583/token-meter` marker) and exits 1.

### Changed
- **`usage_summary` MCP tool now includes an MCP / tools breakdown**
  (top 5 by response tokens) so the new `/token-meter` slash command can
  show "today + MCP / tools" in a single call. Existing callers see one
  extra section appended to the same text response; the tool signature
  is unchanged.

### Why
Follow-up to v0.1.6 dogfood UX work (D-033). MCP-prefixed slash commands
work but are visually long; the new custom slash command is the short
`/token-meter` entry point that surfaces today's usage plus a small,
honest hint about the Pro tier. Still a dogfood UX bet (D-034), not a
direct payment trigger.

---

## [0.1.6] — 2026-05-15

### Added
- **MCP prompts (slash commands)** — the four read-only tools are now also
  exposed as prompts, so clients that surface MCP prompts (Claude Code,
  Cursor, Claude Desktop) show them as slash commands:
  - `/mcp__token-meter__usage_summary` (arg: `period` = `today` | `week` |
    `month`, default `today`)
  - `/mcp__token-meter__recent_sessions` (arg: `within_hours` = 1-720,
    default 24)
  - `/mcp__token-meter__session_tools` (arg: `session_id`, required)
  - `/mcp__token-meter__refresh_data` (no args)

  Each prompt returns a one-line user-role message that asks the agent to
  call the matching tool. Natural-language invocation ("show me my usage
  this week") still works exactly as before — the prompts are an additive
  shortcut for users who prefer typing `/`.

### Why
Dogfood UX shortcut, not a feature-value bet. The four tools were already
reachable by asking the agent in natural language; adding prompts is a ~50
LOC additive change that lets the author and other slash-command-leaning
users skip the typing. Marketing weight and pricing position are
unchanged.

---

## [0.1.5] — 2026-05-15

### Added
- **`token-meter install-mcp <client>`** — one-command MCP registration.
  Supported clients: `claude-code`, `cursor`, `claude-desktop`, `all`.
  Add `--dry-run` to preview without writing.
  - **Claude Code**: shells out to `claude mcp add ...` (auto-detected,
    skipped with a clear message if the `claude` CLI isn't on PATH).
  - **Cursor / Claude Desktop**: read/merge the platform-specific JSON
    config (`~/.cursor/mcp.json`, macOS `~/Library/Application Support/Claude/`,
    Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`). Preserves
    any existing `mcpServers` entries; writes a `<path>.bak` backup
    before overwriting an existing file.
  - Idempotent — re-running prints `already-present` instead of writing.
  - `install-mcp.ts` and 7 unit tests covering create / idempotent /
    preserve-others / update-stale / dry-run / invalid-JSON / empty-file.

### Changed
- **MCP setup docs rewritten for self-service**. `docs/mcp-server.md`
  now leads with the one-command installer and falls back to per-client
  copy-paste blocks (Claude Code, Cursor, Claude Desktop, ChatGPT,
  generic stdio) with verification and a troubleshooting section.
- **README "Connect to your AI tool"** points at `install-mcp all` first;
  also keeps the LLM-driven "ask the agent to set it up" prompt and the
  per-client manual table for users who prefer to do it themselves.
- **Landing page** (`token-meter.dev`) `#connect` section: one-command box
  on top, LLM-prompt box second, manual cards below.
- `token-meter setup <key>` now points users at `install-mcp` for the
  MCP-registration step (instead of printing raw commands inline).

### Why
First-time users on Cursor / Claude Desktop / ChatGPT had no concrete
path before — `install-mcp` collapses the four-step manual flow
(locate config → open with the right path per OS → merge JSON →
restart the app) into one command, and gives LLM-driven setup
something deterministic to call.

---

## [0.1.4] — 2026-05-15

### Added
- **`token-meter setup <key>`** — one-shot subcommand bundling
  `activate <key>` + appending `export TOKEN_METER_GATING=1` to the user's
  shell rc (`~/.zshrc` → `~/.bashrc` → `~/.profile`, first existing) +
  printing the MCP-registration commands for Claude Code / Cursor.
  Idempotent: detects existing `TOKEN_METER_GATING` line in the rc and
  skips appending. Windows skips the rc append and tells the user to
  run `setx TOKEN_METER_GATING 1` instead.
- `appendShellRc()` helper in `src/license.ts` (exported, reusable).

### Why
Setup used to be 4 manual commands (install, activate, edit shell rc,
register MCP). `setup` collapses the first three into one, and the
license email template (v0.1.3 worker change) now points at this
command for the LLM-assisted install path.

---

## [0.1.3] — 2026-05-15

### Added
- **License-tier gating scaffold** (`src/license.ts`). Three tiers: `free`,
  `pro`, `pro_plus`. Resolves entitlement from `TOKEN_METER_LICENSE` env or
  `~/.tokenmeter/license.json`. **Disabled by default during the beta** —
  set `TOKEN_METER_GATING=1` to test gating locally.
- Free vs Pro caps:
  - **History**: 7 days (Free) / 30 days (Pro) / unbounded (Pro+).
  - **Smart alert rules**: 1 (Free) / unlimited (Pro+).
  - **Alert action types**: `notify.desktop` (Free) / desktop + webhook +
    email (Pro+).
  - **Session drill-down API** (`/api/sessions*`): Pro+ only (HTTP 402 to
    Free callers).
- CLI emits a one-line warning when `stats <days>` is clamped by the
  active tier.
- **`token-meter activate <key>`** CLI command. Verifies the key against
  the worker API and writes `~/.tokenmeter/license.json` with permission
  `0600`.
- **Remote license verify** in `src/license.ts` (`verifyLicenseRemote`,
  `activateLicense`). Default API base `https://api.token-meter.dev`,
  override via `TOKEN_METER_API_BASE`.
- **7-day offline grace period**: after a successful `activate`, the
  local config keeps the Pro/Pro+ tier active for 7 days without
  re-verification. After that, the tier falls back to Free until the
  user runs `activate` again.
- **`infra/api` worker hardening**:
  - Polar webhook signature verify (HMAC-SHA256, ±5 min replay window
    via `webhook-id` / `webhook-timestamp` / `webhook-signature`
    headers). **Polar diverges from the Standard Webhooks reference**
    in two places (D-032): HMAC key is the **full secret as raw UTF-8
    bytes** (no base64 decode, `polar_whs_` prefix included); event id
    comes from the `webhook-id` HTTP header (not the body). Verified
    e2e on 2026-05-15.
  - License-issuance email shipped through **Resend** (`RESEND_API_KEY`
    + `RESEND_FROM` env). Email contains the key, the `activate`
    command, and the env-var fallback.
- **`docs/billing-setup.md`** — step-by-step runbook for the
  Polar / Cloudflare D1 / Resend / custom-domain wiring, including the
  end-to-end live-test checklist.

### Notes
- Gating is dormant in this release. With `TOKEN_METER_GATING` unset (the
  default), every caller resolves to Pro+ and existing behaviour is
  preserved. The flag flips to default-on once Polar checkout +
  webhook-driven license issuance lands (D-031 γ).

---

## [0.1.2] — 2026-05-14

### Fixed
- **`token-meter serve` subcommand was missing from the CLI**, even though the
  README and v0.1.0 changelog promised a dashboard at `http://localhost:8765`.
  The dashboard module existed (`src/server.ts`) but was only reachable via
  `npm run serve` from a checkout — npx / global-install users hit
  `Usage: ...` and exit 1. Now `token-meter serve` works end-to-end.

### Added
- `token-meter --version` / `-v` prints the installed version.
- `token-meter --help` / `-h` / `help` prints usage and exits 0
  (previously any unknown argument was treated as an error).

## [0.1.1] — 2026-05-13

### Added
- `mcpName: io.github.whdrnr2583-cmd/token-meter` in `package.json` so the
  package can be registered on the official MCP Registry
  (https://registry.modelcontextprotocol.io). No runtime behavior change.

## [0.1.0] — 2026-05-13

First public release.

### Added

**Core**
- Local-first CLI + dashboard for Claude Code and Codex token usage.
- JSONL parsers for `~/.claude/projects/**/*.jsonl` (Claude Code) and
  `~/.codex/sessions/**/*.jsonl` (Codex).
- SQLite storage at `~/.tokenpulse/usage.db` (legacy folder name carried
  through v0.1; renamed to `~/.tokenmeter/` with auto-migration in a future
  release) with WAL mode and incremental ingest (mtime + size).
- Dashboard at `http://localhost:8765` with day / model / project / source
  breakdowns, hourly distribution, and Chart.js visualizations.

**MCP server (`token-meter mcp`)**
- `usage_summary` — spend + token summary per period (today / week / month).
- `recent_sessions` — sessions with activity in the last N hours, with
  ready-to-paste `claude --resume` / `codex resume` commands. Useful when a
  terminal was closed by accident.
- `session_tools` — per-session breakdown of MCP / built-in tool calls,
  response sizes, and average latency.
- `refresh_data` — re-scan source JSONL files on demand.

**MCP / tool breakdown**
- Per-MCP-server and per-tool grouping (`mcp__<server>__<tool>` pattern).
- Latency, response size (chars + estimated tokens), and call count.

**Session drill-down**
- Top sessions by USD cost in the selected window.
- Per-message breakdown (input / output / cache read / cache write / USD).
- Per-session tool breakdown.

**Smart alerts (rules engine)**
- Threshold rules on daily / weekly / monthly USD, daily output tokens, or
  daily cache write tokens.
- Built-in actions: desktop notification, webhook POST, email (Pro, wired in
  M3), weekly digest (planned).
- Per-rule cooldown (24h default) and dry-run preview against historical data.
- Pending desktop notifications surfaced via the dashboard's browser
  `Notification` API.

**Pricing & cost estimates**
- USD-equivalent calculation for Anthropic (Opus 4.x / Sonnet 4.x / Haiku 4.x)
  and OpenAI (GPT-5 / GPT-5-Codex / GPT-5-mini / GPT-4o / GPT-4o-mini).
- Treated as **estimates**; not validated against vendor invoices. Disclaimer
  surfaced on the dashboard and README.

**Quality / safety**
- 14 unit tests (parser dedup, pricing reproducibility, XSS escape regression).
- 8-section data invariant audit script (`npm run audit`): USD conservation
  across views, dedup uniqueness, pricing reproducibility, temporal sanity,
  tool integrity, source-specific checks, rules engine, ingest state.
- CI matrix: typecheck (Ubuntu) + test (Ubuntu / macOS / Windows) + build +
  MCP smoke against built `dist/`.
- HTML escape (`esc()`) applied to all user-controlled string interpolations
  in the dashboard.

### Fixed
- **Critical**: deduplicate per-`request_id` token events. Claude Code splits
  a single API response into multiple JSONL entries (e.g. one `thinking`
  block + one `text` block) that all carry the same final `usage`. Before the
  fix, this triple-counted. Cost figures on the user's local data dropped
  ~60% to match the actual per-call billing.

### Security
- Dashboard server binds to `127.0.0.1` only.
- All SQL queries use parameter binding.
- Webhook actions: 5-second timeout per fire; no retry. **Webhook URL is
  user-supplied — see `docs/customization.md` for the SSRF caveat.**

### Notes
- Pro / Pro+ feature gating is currently inactive; all features are open
  during the free beta. License-gated tiers activate with the M3 paid launch.
- Pro+ (local LLM proxy, GPU tracking, behavior-changing automations) is on
  the M4+ conditional roadmap, not in this release.
