import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { ContentBlock, JsonlEntry, TokenEvent, ToolEvent } from './types.js';
import { estimateUsd } from './pricing.js';

const MCP_PREFIX_RE = /^mcp__([^_]+(?:_[^_]+)*?)__/;

function parseMcpServer(toolName: string): string | null {
  const match = MCP_PREFIX_RE.exec(toolName);
  if (!match) return null;
  return match[1] ?? null;
}

function estimateTokensFromText(s: string): number {
  // ~3.5 chars per token Anthropic heuristic; rough only.
  return Math.ceil(s.length / 3.5);
}

function flattenToolResult(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  let out = '';
  for (const block of content) {
    if (typeof block === 'string') {
      out += block;
    } else if (block.type === 'text' && block.text) {
      out += block.text;
    } else if (typeof block.content === 'string') {
      out += block.content;
    } else if (Array.isArray(block.content)) {
      out += flattenToolResult(block.content);
    }
  }
  return out;
}

export interface ParseResult {
  tokens: TokenEvent[];
  tools: ToolEvent[];
}

export function parseJsonlFile(
  filePath: string,
  projectName: string,
  agentId: string | null = null,
): ParseResult {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const sessionId = basename(filePath).replace(/\.jsonl$/, '');

  const tokens: TokenEvent[] = [];
  const tools: ToolEvent[] = [];

  // Dedup: Claude Code splits a single API response into multiple assistant
  // events (e.g. one for the `thinking` block, one for the `text` block, one
  // for `tool_use`) that all share the same request_id. In the interactive
  // CLI's own session files every split entry already carries the identical
  // *final* usage (backfilled), so which one gets billed doesn't matter.
  // Sub-agent (Task/Agent) JSONL files under <session>/subagents/ instead
  // stream usage incrementally per content block: model/input/cache tokens
  // stay fixed across the split but output_tokens grows with each later
  // entry, and only the LAST entry for a request_id carries the completed
  // total (verified against real subagent logs — billing the first entry
  // undercounts output tokens by >98% on sub-agent-heavy sessions). Keep one
  // slot per request_id and overwrite it on every sighting so the last
  // write wins for both files types; entries with no request_id (rare) bill
  // immediately since there is nothing to dedup against.
  const requestIdIndex = new Map<string, number>();

  // For latency: tool_use timestamp keyed by id.
  const toolUseTimestamps = new Map<string, { ts: number; name: string }>();

  for (const line of lines) {
    if (!line) continue;
    let entry: JsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    const session = entry.sessionId ?? sessionId;

    // Assistant messages → token events + collect tool_use timestamps.
    if (entry.type === 'assistant' && entry.message) {
      const m = entry.message;
      const requestId = entry.requestId ?? null;
      if (m.usage && m.model) {
        const input = m.usage.input_tokens ?? 0;
        const output = m.usage.output_tokens ?? 0;
        const cacheRead = m.usage.cache_read_input_tokens ?? 0;
        const cacheWrite = m.usage.cache_creation_input_tokens ?? 0;
        if (input + output + cacheRead + cacheWrite > 0) {
          const event: TokenEvent = {
            ts,
            source: 'claude-code',
            source_kind: 'cloud',
            model: m.model,
            project: projectName,
            session_id: session,
            request_id: requestId,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            total_duration_ms: null,
            tps: null,
            usd_estimate: estimateUsd({
              model: m.model,
              input,
              output,
              cacheRead,
              cacheWrite,
            }),
            agent_id: agentId,
          };
          if (requestId) {
            const existingIndex = requestIdIndex.get(requestId);
            if (existingIndex === undefined) {
              requestIdIndex.set(requestId, tokens.length);
              tokens.push(event);
            } else {
              tokens[existingIndex] = event;
            }
          } else {
            tokens.push(event);
          }
        }
      }
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolUseTimestamps.set(block.id, { ts, name: block.name });
          }
        }
      }
    }

    // User messages → tool_result blocks (paired with prior tool_use).
    if (entry.type === 'user' && entry.message && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const paired = toolUseTimestamps.get(block.tool_use_id);
        if (!paired) continue;
        const text = flattenToolResult(block.content);
        const responseChars = text.length;
        tools.push({
          ts: paired.ts,
          source: 'claude-code',
          project: projectName,
          session_id: session,
          tool_name: paired.name,
          mcp_server: parseMcpServer(paired.name),
          tool_use_id: block.tool_use_id,
          response_chars: responseChars,
          response_tokens_est: estimateTokensFromText(text),
          latency_ms: Math.max(0, ts - paired.ts),
          agent_id: agentId,
        });
        toolUseTimestamps.delete(block.tool_use_id);
      }
    }
  }

  return { tokens, tools };
}
