/**
 * Types for the "audit" feature — a point-in-time report that surfaces the
 * most cost/latency-relevant findings across Claude Code + Codex history
 * (expensive sessions, oversized tool responses, slow tools, repeated calls,
 * cache inefficiency, high-cost-model usage).
 *
 * Unlike the rest of src/ (snake_case rows mirroring SQLite columns, e.g.
 * ToolEvent/TokenEvent in ../types.ts), everything here is camelCase: this
 * is a NEW external JSON contract — the audit report is meant to be read by
 * humans, dashboards, and CLI --json consumers directly, not to mirror a DB
 * table. Do not mix snake_case in.
 *
 * Detectors read directly from the DB (see DetectorContext) and return
 * Finding[]; the engine (a later phase) merges, ranks, and wraps them into
 * an AuditReport. Nothing in this file talks to SQLite itself.
 */

import type Database from 'better-sqlite3';

/** How confident we are that a finding is real and actionable, not noise. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * How a finding's estimatedCostUsd should be presented to the user:
 *  - 'estimated_cost'  — a genuine (if heuristic) USD estimate is available.
 *  - 'cost_associated' — cost data exists but is too indirect/shared to
 *    attribute a clean number (e.g. split across concurrent sessions).
 *  - 'not_available'   — no cost data could be computed for this finding
 *    (estimatedCostUsd is null whenever costLabel is this).
 */
export type CostLabel = 'estimated_cost' | 'cost_associated' | 'not_available';

/** Per-source data availability for the period being audited. */
export type SourceStatus = 'available' | 'partial' | 'unavailable' | 'error';

export type FindingType =
  | 'expensive_session'
  | 'oversized_tool_response'
  | 'slow_tool'
  | 'repeated_similar_tool_calls'
  | 'cache_inefficiency'
  | 'high_cost_model_signal';

export interface AuditSourceSummary {
  /** Real internal source identifier — matches stats.ts's ScopeFilter values. */
  name: 'claude-code' | 'codex';
  status: SourceStatus;
  /** Fraction (0-1) of the requested period this source had usable data for. */
  coverage: number;
  recordsAnalyzed: number;
  recordsSkipped: number;
  warnings: string[];
}

export interface Finding {
  id: string;
  /** 1-based rank within the final report (lower = more important). */
  rank: number;
  type: FindingType;
  title: string;
  description: string;
  source: 'claude-code' | 'codex';
  project: string | null;
  sessionId: string | null;
  toolName: string | null;
  /** Detector-specific numeric/string evidence (e.g. { avgTokens, calls }). */
  metrics: Record<string, unknown>;
  estimatedCostUsd: number | null;
  costLabel: CostLabel;
  confidence: Confidence;
  evidence: string[];
  recommendations: string[];
  /**
   * Underlying (source, request_id) or (source, session_id) cost-event keys
   * that estimatedCostUsd was derived from. The engine unions these across
   * findings to compute summary.costAssociatedUsd without double-counting
   * the same underlying spend across multiple findings.
   */
  costEventIds: string[];
}

export interface AuditReport {
  schemaVersion: '1.0';
  /** ISO 8601 timestamp of when this report was generated. */
  generatedAt: string;
  period: { start: string; end: string; days: number };
  sources: AuditSourceSummary[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    estimatedCostUsd: number | null;
  };
  summary: {
    findingCount: number;
    /** Sum of estimatedCostUsd across findings, deduped via costEventIds. */
    costAssociatedUsd: number | null;
    overallConfidence: Confidence;
    /**
     * True when two or more findings shared at least one costEventIds entry
     * and the engine's dedup pass (see ../engine.ts) had to drop one side to
     * keep costAssociatedUsd from double-counting the same underlying spend
     * (e.g. expensive_session + high_cost_model_signal both citing the same
     * session). False when no findings overlapped, including whenever
     * findings is empty.
     */
    findingsMayOverlap: boolean;
  };
  findings: Finding[];
}

export interface DetectorContext {
  db: Database.Database;
  /** Window start, unix ms (inclusive). */
  sinceMs: number;
  /** Window end, unix ms (exclusive). */
  untilMs: number;
  days: number;
  source: 'all' | 'claude-code' | 'codex';
  project: string | null;
  /** Max findings this detector should return (engine also caps the total). */
  limit: number;
}

export type Detector = (ctx: DetectorContext) => Finding[];
