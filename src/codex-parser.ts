import type { TokenEvent, ToolEvent } from './types.js';
import { estimateUsd } from './pricing.js';
import { estimateTokensFromText } from './parser.js';
import { readLineItems, readLines } from './jsonl-lines.js';

interface CodexLastTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexEntry {
  timestamp?: string;
  type?: string;
  payload?: {
    id?: string;
    cwd?: string;
    // turn_context's own model field — the per-turn source of truth for
    // which model actually served that turn (see currentModel below).
    model?: string;
    model_provider?: string;
    base_instructions?: { text?: string };
    type?: string;
    // function_call / custom_tool_call / *_output fields (all under
    // type: 'response_item', nested payload.type distinguishes them).
    call_id?: string;
    name?: string;
    // Usually a string, but Codex sometimes emits a structured (object/array)
    // payload for a tool's output — see the JSON.stringify fallback below.
    output?: string | Record<string, unknown> | unknown[];
    info?: {
      last_token_usage?: CodexLastTokenUsage;
      total_token_usage?: CodexLastTokenUsage;
    } | null;
  };
}

// Extract model from base_instructions like "based on GPT-5" or "GPT-5-Codex"
function extractModel(instructionText: string): string {
  const m = /based on\s+([A-Za-z0-9\-]+)/i.exec(instructionText);
  if (m && m[1]) return m[1].toLowerCase().replace(/[.,;:!?]+$/, '');
  if (/gpt-5-codex/i.test(instructionText)) return 'gpt-5-codex';
  if (/gpt-5-mini/i.test(instructionText)) return 'gpt-5-mini';
  if (/gpt-5/i.test(instructionText)) return 'gpt-5';
  if (/gpt-4o-mini/i.test(instructionText)) return 'gpt-4o-mini';
  if (/gpt-4o/i.test(instructionText)) return 'gpt-4o';
  return 'gpt-5';
}

/** Everything needed to continue parsing a Codex session file from a byte offset. */
export interface CodexParseState {
  v: 1;
  sessionId: string;
  cwd: string;
  model: string;
  currentModel: string;
  prevTotalKey: string;
  pending: Array<[string, { ts: number; name: string }]>;
}

export interface ParseCodexResult {
  tokens: TokenEvent[];
  tools: ToolEvent[];
  /** Byte offset just past the last newline-terminated line consumed. */
  endOffset: number;
  /** null when the file has no session_meta (nothing to resume; always re-parsed in full). */
  state: CodexParseState | null;
}

export interface ParseCodexOptions {
  startOffset?: number;
  state?: CodexParseState | null;
}

export function parseCodexSession(filePath: string, opts: ParseCodexOptions = {}): ParseCodexResult {
  let sessionId = opts.state?.sessionId ?? '';
  let cwd = opts.state?.cwd ?? 'unknown';
  let model = opts.state?.model ?? 'gpt-5';
  const tokens: TokenEvent[] = [];
  const tools: ToolEvent[] = [];
  const resuming = !!opts.state;

  // First pass: read session_meta (always early in file). Skipped when resuming:
  // the previous run already found it and carried it in `state`.
  let headLines = 0;
  for (const line of resuming ? [] : readLines(filePath)) {
    if (++headLines > 5) break;
    if (!line) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'session_meta' && entry.payload) {
      sessionId = entry.payload.id ?? '';
      cwd = entry.payload.cwd ?? cwd;
      if (entry.payload.base_instructions?.text) {
        model = extractModel(entry.payload.base_instructions.text);
      }
      break;
    }
  }

  if (!sessionId) return { tokens, tools, endOffset: opts.startOffset ?? 0, state: null };

  // Second pass: token_count events (billing) + function_call/custom_tool_call
  // ↔ *_output pairing (tool events). `currentModel` tracks the model
  // actually serving the current turn via `turn_context` entries — the
  // per-turn source of truth, correctly attributing mid-session model
  // switches (e.g. gpt-5.3-codex-spark → gpt-5.4). Logs with no
  // turn_context at all (older Codex versions) never update it, so every
  // token_count event bills under the session_meta-derived `model` fallback
  // from the first pass above.
  let currentModel = opts.state?.currentModel ?? model;
  // call_id -> the function_call/custom_tool_call entry awaiting its
  // *_output pair. An unmatched pending call (session ended mid-call) is
  // simply never flushed to `tools` — no partial/guessed event.
  const pendingToolCalls = new Map<string, { ts: number; name: string }>(opts.state?.pending ?? []);

  // Cumulative totals of the previous token_count event, to skip repeats.
  let prevTotalKey = opts.state?.prevTotalKey ?? '';

  const snapshot = (): CodexParseState => ({
    v: 1, sessionId, cwd, model, currentModel, prevTotalKey, pending: [...pendingToolCalls.entries()],
  });
  let endOffset = opts.startOffset ?? 0;
  let stateAtEnd: CodexParseState | null = null;

  for (const item of readLineItems(filePath, opts.startOffset ?? 0)) {
    const line = item.line;
    // Unterminated final line: parsed for output, but not consumed (see parser.ts).
    if (!item.terminated && stateAtEnd === null) stateAtEnd = snapshot();
    if (item.terminated) endOffset = item.end;
    if (!line) continue;
    let entry: CodexEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'turn_context') {
      currentModel = entry.payload?.model ?? currentModel;
      continue;
    }

    if (entry.type === 'response_item' && entry.payload) {
      const p = entry.payload;
      const entryTs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if ((p.type === 'function_call' || p.type === 'custom_tool_call') && p.call_id && p.name) {
        if (!Number.isNaN(entryTs)) pendingToolCalls.set(p.call_id, { ts: entryTs, name: p.name });
        continue;
      }
      if ((p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && p.call_id) {
        const pending = pendingToolCalls.get(p.call_id);
        if (pending) {
          // Codex usually emits a plain string here, but sometimes a
          // structured (object/array) payload instead — stringify it so the
          // response size (chars + estimated tokens) reflects its actual
          // content instead of silently downgrading to '' (0 length, 0
          // tokens — an undercount, not just an approximation).
          const text =
            typeof p.output === 'string'
              ? p.output
              : p.output != null
                ? JSON.stringify(p.output)
                : '';
          tools.push({
            ts: pending.ts,
            source: 'codex',
            project: cwd,
            session_id: sessionId,
            tool_name: pending.name,
            mcp_server: null,
            tool_use_id: p.call_id,
            response_chars: text.length,
            response_tokens_est: estimateTokensFromText(text),
            latency_ms: Number.isNaN(entryTs) ? null : Math.max(0, entryTs - pending.ts),
          });
          pendingToolCalls.delete(p.call_id);
        }
        continue;
      }
      continue;
    }

    if (entry.type !== 'event_msg') continue;
    if (entry.payload?.type !== 'token_count') continue;
    const info = entry.payload.info;
    if (!info || !info.last_token_usage) continue;
    const u = info.last_token_usage;
    // Codex can re-emit a token_count event whose cumulative total did not move
    // (no new API call happened). Its last_token_usage is then a stale copy of
    // the previous turn, and billing it again double-counts that turn. Only
    // skip when the cumulative total is present, non-trivial and identical.
    const tt = info.total_token_usage;
    if (tt && (tt.total_tokens ?? tt.input_tokens ?? 0) > 0) {
      const key = `${tt.input_tokens ?? 0}|${tt.cached_input_tokens ?? 0}|${tt.output_tokens ?? 0}|${tt.reasoning_output_tokens ?? 0}|${tt.total_tokens ?? 0}`;
      if (key === prevTotalKey) continue;
      prevTotalKey = key;
    }
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cached_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const reasoning = u.reasoning_output_tokens ?? 0;
    // Codex reports input_tokens including cached. Subtract to get fresh input.
    const freshInput = Math.max(0, input - cacheRead);
    // Reasoning tokens are billed as output by OpenAI. In the OpenAI usage
    // object reasoning tokens are a SUBSET of output_tokens, so adding them
    // again double-counts. The log carries its own evidence: `total_tokens`.
    // When it equals input + output (without reasoning) reasoning is already
    // inside output; when it equals input + output + reasoning, it is not.
    // With no total_tokens to decide, keep the historical additive behaviour.
    const reportedTotal = u.total_tokens;
    const reasoningIncluded =
      reasoning > 0 && reportedTotal !== undefined && reportedTotal === input + output;
    const totalOutput = reasoningIncluded ? output : output + reasoning;
    if (freshInput + totalOutput + cacheRead === 0) continue;

    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Date.now();
    if (Number.isNaN(ts)) continue;

    // Synthesize a stable request_id so the (session_id, ts, request_id, model)
    // unique index can dedupe re-ingested rows.
    const synthRequestId = `codex-${sessionId.slice(-12)}-${ts}-${totalOutput}`;
    tokens.push({
      ts,
      source: 'codex',
      source_kind: 'cloud',
      model: currentModel,
      project: cwd,
      session_id: sessionId,
      request_id: synthRequestId,
      input_tokens: freshInput,
      output_tokens: totalOutput,
      cache_read_tokens: cacheRead,
      cache_write_tokens: 0,
      total_duration_ms: null,
      tps: null,
      usd_estimate: estimateUsd({
        model: currentModel,
        input: freshInput,
        output: totalOutput,
        cacheRead,
        cacheWrite: 0,
      }),
    });
  }

  return { tokens, tools, endOffset, state: stateAtEnd ?? snapshot() };
}
