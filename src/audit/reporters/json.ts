/**
 * Renders an AuditReport as indented JSON for `token-meter audit --json`.
 *
 * This function only ever returns a string — it does not write to stdout or
 * stderr itself. Keeping stdout free of anything but this exact string is
 * what lets --json output be piped into `jq`/scripts without extra parsing;
 * the CLI layer (../../cli.ts) owns the stdout/stderr split (warnings and
 * diagnostics go to console.error there, never here).
 */

import type { AuditReport } from '../types.js';

export function formatJson(report: AuditReport): string {
  return JSON.stringify(report, null, 2);
}

export default formatJson;
