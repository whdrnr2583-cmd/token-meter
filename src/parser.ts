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
  // events (e.g. one for the `thinking` block, one for the `text` block) that
  // all carry the same request_id and the same final usage. Bill once per
  // request_id within a file (global dedup happens at DB unique index too).
  const seenRequestIds = new Set<string>();

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
      const alreadyBilled = requestId !== null && seenRequestIds.has(requestId);
      if (m.usage && m.model && !alreadyBilled) {
        const input = m.usage.input_tokens ?? 0;
        const output = m.usage.output_tokens ?? 0;
        const cacheRead = m.usage.cache_read_input_tokens ?? 0;
        const cacheWrite = m.usage.cache_creation_input_tokens ?? 0;
        if (input + output + cacheRead + cacheWrite > 0) {
          if (requestId) seenRequestIds.add(requestId);
          tokens.push({
            ts,
            source: 'claude-code',
            source_kind: 'cloud',
            model: m.model,
            project: projectName,
            session_id: session,
            request_id: entry.requestId ?? null,
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
          });
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
