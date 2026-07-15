# Token Meter — audit

`token-meter audit` is a point-in-time findings report: it runs six
detectors over your ingested `token_events` / `tool_events` history and
returns a ranked list of things worth a second look — expensive sessions,
oversized tool responses, slow tools, repeated calls, cache waste, and a
high-cost-model usage signal.

It reads from the same local SQLite database every other Token Meter command
uses (`~/.tokenpulse/usage.db`). Nothing is uploaded; run `token-meter
ingest` first if you haven't already.

```sh
npx -y @whdrnr2583/token-meter audit
```

## CLI flags

```
token-meter audit [--days N] [--source all|claude|codex] [--project <value>] [--limit N] [--json]
```

| Flag | Default | Notes |
|---|---|---|
| `--days N` | `7` | Trailing window, in days, ending now. Clamped to your history entitlement the same way `stats`/`subagents`/`local` are (Free: 7 days, Pro: 30 days) — a request for more prints a warning to stderr and runs with the clamped value. |
| `--source all\|claude\|codex` | `all` | Restricts detectors to one source. `claude`/`codex` map to the internal `claude-code`/`codex` source identifiers. |
| `--project <value>` | unset (all projects) | Exact-match filter on the `project` column. |
| `--limit N` | `5` in terminal mode, `20` in `--json` mode | Caps the number of findings returned, after cross-detector ranking. An explicit `--limit` always wins over either default. Must be a positive integer. |
| `--json` | off | Prints the full `AuditReport` as indented JSON instead of the terminal summary. See `docs/audit-schema.json` for the schema and `examples/audit-output.json` for a sample. |

Invalid flag values (non-numeric `--days`/`--limit`, an unrecognized
`--source`) print a usage message to stderr and exit 1. A run that completes
with zero findings is a successful run (exit 0) — an empty report is a valid,
even reassuring, outcome, not a failure.

## What "audit" means here

This is a **spotlight, not an accusation**. Every detector's language is
deliberately neutral ("accounted for X% of analyzed cost", "responses
averaging N tokens") rather than judgmental ("wasteful", "wrong"). The
report is meant to be reviewed by a human who knows the context a detector
doesn't have — task complexity, whether a slow tool call was actually on the
critical path, whether a short high-cost-model session was overkill or
exactly the right call for a hard one-shot task.

## JSON shape (`--json`)

Top-level `AuditReport`:

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `"1.0"` | Fixed string; bump only on a breaking shape change. |
| `generatedAt` | ISO 8601 string | When this report was generated. |
| `period` | `{ start, end, days }` | ISO 8601 window bounds + the (possibly clamped) day count. |
| `sources` | `AuditSourceSummary[]` | One entry per `claude-code`/`codex`, always both, regardless of `--source`. |
| `usage` | object | Raw token/cost totals for the window (see below) — independent of which detectors fired. |
| `summary` | object | Report-level rollup: finding count, deduped cost, overall confidence, overlap flag. |
| `findings` | `Finding[]` | The ranked, capped (`--limit`) list. |

`AuditSourceSummary`:

| Field | Type | Meaning |
|---|---|---|
| `name` | `"claude-code" \| "codex"` | |
| `status` | `"available" \| "partial" \| "unavailable" \| "error"` | See "Source status" below. |
| `coverage` | number, 0-1 | Fraction of the requested window's days that had at least one row for this source (+ project, if scoped). |
| `recordsAnalyzed` | number | `token_events` + `tool_events` rows for this source, inside the window/project scope. |
| `recordsSkipped` | number | Rows for this source that exist but fall outside the requested window/project (all-time minus in-window; never a guess). |
| `warnings` | `string[]` | Human-readable notes — e.g. "no data has ever been ingested" or a structural gap like D5's Codex limitation. |

**Source status**:
- `unavailable` — zero rows for this source, ever. Fix: `token-meter ingest`.
- `partial` — either (a) data exists for this source but none matches the
  requested window/project, or (b) a detector is structurally unable to use
  this source regardless of data volume (D5 vs. Codex — see below).
- `available` — data exists in-window, no known structural gap.
- `error` — reserved for a source-specific execution failure (not currently
  produced by any shipped detector).

`usage` (raw totals, independent of findings):

```
{
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  totalTokens, estimatedCostUsd   // null only when there are zero priced events
}
```

`summary`:

| Field | Type | Meaning |
|---|---|---|
| `findingCount` | number | `findings.length` after ranking + `--limit`. |
| `costAssociatedUsd` | number \| null | Sum of `findings[].estimatedCostUsd`, deduplicated across shared `costEventIds` (see "Overlap and dedup" below). `null` when no finding has a priced cost. |
| `overallConfidence` | `"high" \| "medium" \| "low"` | See "Confidence model" below. |
| `findingsMayOverlap` | boolean | `true` when two or more findings shared a `costEventIds` entry and the engine had to drop one side to avoid double-counting. `false` when nothing overlapped, including whenever `findings` is empty. |

`Finding`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Deterministic 16-char hex hash — same underlying finding produces the same id on a re-run (pure function of type/source/project/session/tool/period, no randomness or clock). |
| `rank` | number | 1-based, lower = more important, assigned by the engine's cross-detector ranking pass (cost-bearing findings first, sorted by cost descending; no-cost findings after, in detector order). |
| `type` | `FindingType` | One of the six detector types — see below. |
| `title` / `description` | string | Human-readable. |
| `source` | `"claude-code" \| "codex"` | |
| `project` | string \| null | `null` when the finding spans multiple projects or the underlying query has no project dimension. |
| `sessionId` | string \| null | `null` for findings not scoped to one session (e.g. D2, D5). |
| `toolName` | string \| null | `null` for findings not scoped to one tool (e.g. D1, D5, D6). |
| `metrics` | `Record<string, unknown>` | Detector-specific numeric/string evidence (e.g. `{ avgTokens, calls }`). Shape varies by `type` — see each detector's own file for its exact keys. |
| `estimatedCostUsd` | number \| null | See `costLabel` for how to read this. |
| `costLabel` | `CostLabel` | `"estimated_cost"` (a real USD estimate), `"cost_associated"` (cost data exists but is too indirect/shared to attribute cleanly — e.g. D2's projected savings, D6's session spend where what's uncertain is model choice, not the dollar amount), or `"not_available"` (no cost data — `estimatedCostUsd` is always `null` here). |
| `confidence` | `"high" \| "medium" \| "low"` | See "Confidence model" below. |
| `evidence` | `string[]` | The concrete numbers/facts backing the finding. |
| `recommendations` | `string[]` | Suggested next steps — never an auto-applied action. |
| `costEventIds` | `string[]` | Underlying cost-event keys this finding's cost was derived from — used by the engine's dedup pass. `session:<source>:<session_id>` for session-level cost (D1, D6); `tool:<tool_name>:<mcp_server>` for tool-aggregate projected savings (D2); empty for findings with no natural cost-event key (D3, D4, D5). |

## The six detectors

| Type | What it flags | What it honestly cannot do |
|---|---|---|
| `expensive_session` (D1) | A session whose cost is ≥15% of the period's total analyzed cost, or is ≥3x the next-priciest session (once its own share clears a 5% floor). Wraps `sessions.ts`'s `topSessions()`. | Doesn't judge whether the cost was justified — a legitimately hard task can be expensive. Confidence drops to `medium` below 3 underlying events (too few events for a mean to be trustworthy). |
| `oversized_tool_response` (D2) | A `(tool_name, mcp_server)` pair averaging ≥5,000 response tokens over ≥5 calls in the window. Wraps `trim-suggestions.ts`'s `computeTrimSuggestions()` (`LARGE_RESPONSE` pattern). | The underlying query has no `source`/`project` split, so `source`/`project` on the finding are best-effort labels (echoing the CLI's own `--source`/`--project`, defaulting to `claude-code` when unscoped), not a guarantee the aggregate itself is confined to that scope. `estimatedCostUsd` is a projected weekly savings estimate if the suggestion is acted on, not money already spent — hence `costLabel: 'cost_associated'`, never `'estimated_cost'`. |
| `slow_tool` (D3) | A `(tool_name, mcp_server, source, project)` group averaging ≥3,000ms latency over ≥5 calls, with mean/p50/p95/max exposed. | `metrics.failureRate` is always `null` — `tool_events` has no error/failure/status column in this schema, so it is reported as `null` rather than fabricated as `0%`. Calls with no recorded `latency_ms` are excluded from the stats (not treated as `0ms`) and counted separately. Never carries a cost (`costLabel: 'not_available'`) — latency has no direct dollar figure in this schema. |
| `repeated_similar_tool_calls` (D4) | Clusters of ≥3 calls to the same tool, in the same session, that land within a 5-minute window of each other **and** whose `response_chars` stay within 10% of the cluster's running average. | **Cannot detect true argument-level duplicates.** `tool_events` stores no call arguments by design — see `ToolEvent` in `src/types.ts`, a deliberate privacy invariant, not a gap to be filled later. Same tool + same session + similar timing + similar response size is an honest **proxy** for "probably did the same/similar thing repeatedly" — it is *not* proof of identical inputs (e.g. two `Read` calls on genuinely different files, or a legitimate retry loop, can both match). Confidence is capped at `medium` for exactly this reason, and every finding's evidence says so explicitly. Never carries a cost (`costLabel: 'not_available'`) — `tool_events` has no cost/request-id field to attribute one from. |
| `cache_inefficiency` (D5) | Days where prompt-cache writes outran cache reads by ≥5,000 tokens (noise floor). Wraps `stats.ts`'s `wasteSignals().cache_waste_days`; cost is attributed across models proportional to their cache-write share on the flagged days, priced via `pricing.ts`. | **Never fires for Codex.** Codex's `usage` payload never reports `cache_write_tokens` — `codex-parser.ts` hardcodes it to `0` for every Codex row — so a Codex event can never satisfy `cache_write > cache_read`. A `--source codex` audit returns zero D5 findings by design; the `codex` entry in `sources[].warnings` explains why. Day-level aggregation is also project-agnostic even when `--project` is set (documented gap — `stats.ts`'s scope filter has no project dimension yet), so this finding's own `project` field just echoes `ctx.project` rather than being independently verified. |
| `high_cost_model_signal` (D6) | Sessions on a high-cost-tier model (ranked by $/M output rate relative to the single priciest rate currently in `pricing.ts`, not a hardcoded model allowlist) that wrapped up in under 2 minutes **and** produced under 500 output tokens. | This is a **review prompt, not a downgrade recommendation** — some short exchanges genuinely need a top-tier model. Confidence is always `low`: the thresholds are objective, but "was the model choice actually unjustified" is a judgment call no threshold alone can prove. Also folds a secondary project cost-concentration signal (one project dominating recent spend, reusing D1's 15% share threshold at the project level) into the evidence of its top finding rather than emitting a separate finding type. |

## Confidence model

Each finding carries one of `high` / `medium` / `low`:

- **`high`** — enough underlying samples (session events, tool calls) that a
  single anomaly can't be driving the whole result, and the match itself is
  a direct measurement, not a heuristic proxy.
- **`medium`** — either the sample size is thin, or the match involves a
  documented approximation (D4's timing/size proxy is always `medium` at
  best, D5 is always `medium` — day-level aggregation with no per-event
  sample-size signal to promote it to `high`).
- **`low`** — the underlying numbers are objective, but the conclusion
  requires a judgment call the numbers alone can't settle (D6 is always
  `low` for exactly this reason).

`summary.overallConfidence` rolls per-finding confidence up into one value:
weight `high=3, medium=2, low=1`, average across all findings, round to the
nearest band — then bump the result down one band if a plain majority
(>50%) of findings are `low`, so a couple of confident findings can't paper
over a report that's mostly speculative signal. A report with **zero**
findings reports `overallConfidence: 'high'` — no findings means no
uncertain claims for a confidence score to hedge.

## Overlap and dedup

Findings are independent detector outputs and **can legitimately overlap**
— most commonly D1 (`expensive_session`) and D6 (`high_cost_model_signal`)
both citing the same session's real spend. Both key their `costEventIds` as
`session:<source>:<session_id>`; the engine sums `estimatedCostUsd` across
all findings cost-descending and, whenever a later finding's `costEventIds`
overlaps an entry already claimed, drops that finding's amount from the
running total and sets `summary.findingsMayOverlap: true`. D2's
`tool:<tool_name>:<mcp_server>` keys name a *projected* weekly savings
estimate rather than money already spent, and by construction can never
collide with a `session:...` key — projected savings are never summed into
the same total as real observed spend. In short: **`findings` may list
overlapping evidence, but `summary.costAssociatedUsd` is always
deduplicated** — don't re-sum `findings[].estimatedCostUsd` yourself if you
want the non-double-counted total; read `summary.costAssociatedUsd`
instead.

## See also

- [docs/audit-schema.json](audit-schema.json) — machine-readable JSON Schema
  for `--json` output.
- [examples/audit-output.json](../examples/audit-output.json) — a synthetic
  sample report.
- [docs/pro-features.md](pro-features.md) — history-window entitlement that
  `--days` is clamped against.
