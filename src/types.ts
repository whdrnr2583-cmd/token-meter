// Claude Code JSONL message shapes (subset we care about).

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  service_tier?: string;
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking' | string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  content?: string | ContentBlock[];
}

export interface ClaudeMessage {
  model?: string;
  id?: string;
  role?: 'user' | 'assistant';
  content?: string | ContentBlock[];
  usage?: ClaudeUsage;
  stop_reason?: string;
}

export interface JsonlEntry {
  type: 'user' | 'assistant' | 'system' | 'attachment' | 'queue-operation' | 'last-prompt' | string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  entrypoint?: string;
  message?: ClaudeMessage;
  requestId?: string;
}

export interface TokenEvent {
  ts: number; // unix ms
  source: 'claude-code' | 'codex';
  source_kind: 'cloud';
  model: string;
  project: string;
  session_id: string;
  request_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_duration_ms: number | null;
  tps: number | null;
  usd_estimate: number;
  // Sub-agent attribution. `null` = main-session event; `agent-<id>` = the
  // Task/Agent sub-agent whose JSONL file (<project>/<sessionId>/subagents/
  // agent-<id>.jsonl) this row came from. Stamped at ingest from the file
  // path, not the JSONL body — sub-agent entries carry the *parent* sessionId,
  // so without this the inner Haiku/Sonnet cost is indistinguishable.
  agent_id?: string | null;
}

export interface ToolEvent {
  ts: number;
  source: 'claude-code' | 'codex';
  project: string;
  session_id: string;
  tool_name: string; // e.g. "Read", "mcp__notion__notion_search"
  mcp_server: string | null; // "notion" if mcp__notion__..., else null
  tool_use_id: string;
  response_chars: number;
  response_tokens_est: number;
  latency_ms: number | null;
  agent_id?: string | null; // see TokenEvent.agent_id
}
