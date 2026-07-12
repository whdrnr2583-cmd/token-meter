import { readFileSync } from 'node:fs';
import type { TokenEvent, ToolEvent } from './types.js';
import { estimateUsd } from './pricing.js';
import { estimateTokensFromText } from './parser.js';

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
    output?: string;
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

export interface ParseCodexResult {
  tokens: TokenEvent[];
  tools: ToolEvent[];
}

export function parseCodexSession(filePath: string): ParseCodexResult {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let sessionId = '';
  let cwd = 'unknown';
  let model = 'gpt-5';
  const tokens: TokenEvent[] = [];
  const tools: ToolEvent[] = [];

  // First pass: read session_meta (always early in file).
  for (const line of lines.slice(0, 5)) {
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

  if (!sessionId) return { tokens, tools };

  // Second pass: token_count events (billing) + function_call/custom_tool_call
  // ↔ *_output pairing (tool events). `currentModel` tracks the model
  // actually serving the current turn via `turn_context` entries — the
  // per-turn source of truth, correctly attributing mid-session model
  // switches (e.g. gpt-5.3-codex-spark → gpt-5.4). Logs with no
  // turn_context at all (older Codex versions) never update it, so every
  // token_count event bills under the session_meta-derived `model` fallback
  // from the first pass above.
  let currentModel = model;
  // call_id -> the function_call/custom_tool_call entry awaiting its
  // *_output pair. An unmatched pending call (session ended mid-call) is
  // simply never flushed to `tools` — no partial/guessed event.
  const pendingToolCalls = new Map<string, { ts: number; name: string }>();

  for (const line of lines) {
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
          const text = typeof p.output === 'string' ? p.output : '';
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
    const input = u.input_tokens ?? 0;
    const cacheRead = u.cached_input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const reasoning = u.reasoning_output_tokens ?? 0;
    // Codex reports input_tokens including cached. Subtract to get fresh input.
    const freshInput = Math.max(0, input - cacheRead);
    // Reasoning tokens billed as output by OpenAI.
    const totalOutput = output + reasoning;
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

  return { tokens, tools };
}
