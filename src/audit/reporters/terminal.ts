/**
 * Renders an AuditReport as the plain-text block the `token-meter audit`
 * CLI command prints by default (i.e. when --json is not passed).
 *
 * fmtUsd()/fmtTokens() duplicate the tiny formatting helpers already local
 * to ../../cli.ts rather than importing them: cli.ts doesn't export them,
 * and pulling in the whole CLI module just for two one-line formatters would
 * couple this reporter to cli.ts's argv-parsing/process.exit side effects.
 * Keep the two copies in sync if the display format ever changes.
 */

import type { AuditReport, AuditSourceSummary } from '../types.js';

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}

function describeSourceStatus(s: AuditSourceSummary): string {
  const pct = Math.round(s.coverage * 100);
  switch (s.status) {
    case 'available':
      return `available (${s.recordsAnalyzed} record${s.recordsAnalyzed === 1 ? '' : 's'} analyzed, ${pct}% of window covered)`;
    case 'partial':
      return `partial (${s.recordsAnalyzed} record${s.recordsAnalyzed === 1 ? '' : 's'} analyzed, ${pct}% of window covered — see warnings)`;
    case 'unavailable':
      return 'unavailable — no data ingested yet';
    case 'error':
      return 'error — see warnings';
  }
}

/**
 * Empty-findings body: per the audit spec, an empty report must explain
 * which sources were searched, list what's supported, and point at the
 * concrete next command — never just "Findings: 0" and stop.
 */
function emptyStateBlock(report: AuditReport): string[] {
  const lines: string[] = [];
  lines.push('No findings in this window.');
  lines.push('');
  lines.push(
    `Searched sources: ${report.sources.map((s) => s.name).join(', ')} ` +
      `(supported: claude-code, codex) over the last ${report.period.days} day(s).`,
  );

  const neverIngested = report.sources.filter((s) => s.status === 'unavailable');
  if (neverIngested.length > 0) {
    lines.push('');
    lines.push(`No data has been ingested yet for: ${neverIngested.map((s) => s.name).join(', ')}.`);
    lines.push('Run `token-meter ingest` to scan your Claude Code / Codex logs, then re-run this audit.');
  } else if (report.usage.totalTokens === 0) {
    lines.push('');
    lines.push('Data has been ingested, but none of it falls inside this window. Try a larger --days value.');
  } else {
    lines.push('');
    lines.push("Usage was found in this window, but nothing crossed this audit's thresholds — that's a good sign, not an error.");
  }

  return lines;
}

export function formatTerminal(report: AuditReport): string {
  const lines: string[] = [];

  lines.push(`TOKEN METER AUDIT — LAST ${report.period.days} DAYS`);
  lines.push('');

  lines.push('Sources');
  for (const s of report.sources) {
    lines.push(`${s.name}: ${describeSourceStatus(s)}`);
  }
  lines.push('');

  lines.push('Confirmed usage');
  const cacheTotal = report.usage.cacheReadTokens + report.usage.cacheWriteTokens;
  lines.push(
    `Tokens: ${fmtTokens(report.usage.totalTokens)} total ` +
      `(in ${fmtTokens(report.usage.inputTokens)}, out ${fmtTokens(report.usage.outputTokens)}, ` +
      `cache ${fmtTokens(cacheTotal)})`,
  );
  lines.push(
    `Estimated cost: ${report.usage.estimatedCostUsd !== null ? fmtUsd(report.usage.estimatedCostUsd) : 'Unavailable'}`,
  );
  lines.push('');

  lines.push('Efficiency signals');
  lines.push(`Findings: ${report.summary.findingCount}`);
  const costLine =
    report.summary.costAssociatedUsd !== null ? fmtUsd(report.summary.costAssociatedUsd) : 'Unavailable';
  lines.push(
    `Cost associated: ${costLine}` +
      (report.summary.findingsMayOverlap
        ? ' (some findings reference overlapping spend; de-duplicated)'
        : ''),
  );
  lines.push(`Confidence: ${report.summary.overallConfidence}`);
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(...emptyStateBlock(report));
  } else {
    for (const f of report.findings) {
      lines.push(`${f.rank}. ${f.title}`);
      lines.push(`Source: ${f.source}`);
      lines.push(`Project: ${f.project ?? '-'}`);
      lines.push(`Session: ${f.sessionId ?? '-'}`);
      lines.push(`Tool: ${f.toolName ?? '-'}`);
      lines.push(`Evidence: ${f.evidence.join(' ')}`);
      lines.push(`Confidence: ${f.confidence}`);
      lines.push(`Suggested action: ${f.recommendations[0] ?? '-'}`);
      lines.push('');
    }
    // Trailing blank line already pushed by the loop above — drop it so
    // warnings (if any) don't get a double gap.
    if (lines[lines.length - 1] === '') lines.pop();
  }

  const warnings = report.sources.flatMap((s) => s.warnings.map((w) => `[${s.name}] ${w}`));
  if (warnings.length > 0) {
    lines.push('');
    lines.push('Warnings');
    for (const w of warnings) lines.push(`- ${w}`);
  }

  return lines.join('\n');
}

export default formatTerminal;
