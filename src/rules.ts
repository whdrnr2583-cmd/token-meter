import type Database from 'better-sqlite3';
import type {
  ActionConfig,
  ActionType,
  FiringPayload,
  Rule,
  RuleInput,
  RuleMetric,
  WebhookActionConfig,
  DesktopActionConfig,
} from './rules-types.js';

// ---------- CRUD ----------

export function listRules(db: Database.Database): Rule[] {
  return db.prepare(`SELECT * FROM rules ORDER BY id ASC`).all() as Rule[];
}

export function getRule(db: Database.Database, id: number): Rule | undefined {
  return db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as Rule | undefined;
}

export function createRule(db: Database.Database, input: RuleInput): Rule {
  const cfg = JSON.stringify(input.action_config);
  const cooldown = input.cooldown_ms ?? 24 * 60 * 60 * 1000;
  const result = db
    .prepare(
      `INSERT INTO rules (name, enabled, metric, op, threshold, action_type, action_config, cooldown_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.enabled ? 1 : 0,
      input.metric,
      input.op,
      input.threshold,
      input.action_type,
      cfg,
      cooldown,
      Date.now(),
    );
  const created = getRule(db, Number(result.lastInsertRowid));
  if (!created) {
    // Hit only if the DB is corrupt or another process deleted the row between
    // INSERT and SELECT. Surface a clear error instead of crashing on `!`.
    throw new Error(
      `rules.createRule: inserted row ${result.lastInsertRowid} could not be read back`,
    );
  }
  return created;
}

export function updateRule(
  db: Database.Database,
  id: number,
  patch: Partial<RuleInput>,
): Rule | undefined {
  const existing = getRule(db, id);
  if (!existing) return undefined;
  const next = {
    name: patch.name ?? existing.name,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled,
    metric: patch.metric ?? existing.metric,
    op: patch.op ?? existing.op,
    threshold: patch.threshold ?? existing.threshold,
    action_type: patch.action_type ?? existing.action_type,
    action_config: patch.action_config
      ? JSON.stringify(patch.action_config)
      : existing.action_config,
    cooldown_ms: patch.cooldown_ms ?? existing.cooldown_ms,
  };
  db.prepare(
    `UPDATE rules SET name=?, enabled=?, metric=?, op=?, threshold=?, action_type=?, action_config=?, cooldown_ms=? WHERE id=?`,
  ).run(
    next.name,
    next.enabled,
    next.metric,
    next.op,
    next.threshold,
    next.action_type,
    next.action_config,
    next.cooldown_ms,
    id,
  );
  return getRule(db, id);
}

export function deleteRule(db: Database.Database, id: number): boolean {
  const result = db.prepare(`DELETE FROM rules WHERE id = ?`).run(id);
  return result.changes > 0;
}

export function recentFirings(
  db: Database.Database,
  ruleId: number | null,
  limit = 50,
): { id: number; rule_id: number; fired_at: number; metric_value: number; action_result: string }[] {
  if (ruleId === null) {
    return db
      .prepare(`SELECT * FROM rule_firings ORDER BY fired_at DESC LIMIT ?`)
      .all(limit) as never;
  }
  return db
    .prepare(`SELECT * FROM rule_firings WHERE rule_id = ? ORDER BY fired_at DESC LIMIT ?`)
    .all(ruleId, limit) as never;
}

// ---------- Metric evaluation ----------

interface Window {
  label: string;
  start_ts: number;
  end_ts: number;
}

function currentWindow(metric: RuleMetric): Window {
  const now = new Date();
  const end_ts = now.getTime();
  if (metric === 'daily_usd' || metric === 'daily_output_tokens' || metric === 'daily_cache_write_tokens') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return {
      label: start.toISOString().slice(0, 10),
      start_ts: start.getTime(),
      end_ts,
    };
  }
  if (metric === 'weekly_usd') {
    const start = new Date(now);
    const day = start.getDay(); // 0=Sun
    const diff = (day + 6) % 7; // make Monday start
    start.setDate(start.getDate() - diff);
    start.setHours(0, 0, 0, 0);
    return { label: `week of ${start.toISOString().slice(0, 10)}`, start_ts: start.getTime(), end_ts };
  }
  // monthly_usd
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    label: start.toISOString().slice(0, 7),
    start_ts: start.getTime(),
    end_ts,
  };
}

function metricValue(db: Database.Database, metric: RuleMetric, win: Window): number {
  const sumExpr = (() => {
    switch (metric) {
      case 'daily_usd':
      case 'weekly_usd':
      case 'monthly_usd':
        return 'COALESCE(SUM(usd_estimate), 0)';
      case 'daily_output_tokens':
        return 'COALESCE(SUM(output_tokens), 0)';
      case 'daily_cache_write_tokens':
        return 'COALESCE(SUM(cache_write_tokens), 0)';
    }
  })();
  const row = db
    .prepare(`SELECT ${sumExpr} AS v FROM token_events WHERE ts >= ? AND ts < ?`)
    .get(win.start_ts, win.end_ts) as { v: number };
  return row.v;
}

function buildSummary(db: Database.Database, win: Window): FiringPayload['summary'] {
  const sources = db
    .prepare(
      `SELECT source, COALESCE(SUM(usd_estimate), 0) AS usd
       FROM token_events WHERE ts >= ? AND ts < ? GROUP BY source`,
    )
    .all(win.start_ts, win.end_ts) as { source: string; usd: number }[];
  const events = (db
    .prepare(`SELECT COUNT(*) AS c FROM token_events WHERE ts >= ? AND ts < ?`)
    .get(win.start_ts, win.end_ts) as { c: number }).c;
  const top = db
    .prepare(
      `SELECT model, COALESCE(SUM(usd_estimate), 0) AS usd
       FROM token_events WHERE ts >= ? AND ts < ?
       GROUP BY model ORDER BY usd DESC LIMIT 3`,
    )
    .all(win.start_ts, win.end_ts) as { model: string; usd: number }[];
  return {
    claude_code_usd: sources.find((r) => r.source === 'claude-code')?.usd ?? 0,
    codex_usd: sources.find((r) => r.source === 'codex')?.usd ?? 0,
    events,
    top_models: top,
  };
}

// ---------- Action executor ----------

function parseConfig<T extends ActionConfig>(rule: Rule): T {
  try {
    return JSON.parse(rule.action_config) as T;
  } catch {
    return {} as T;
  }
}

async function executeWebhook(rule: Rule, payload: FiringPayload): Promise<string> {
  const cfg = parseConfig<WebhookActionConfig>(rule);
  if (!cfg.url) return 'error:no_url';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'token-meter/0.1',
        'x-token-meter-event': 'rule.fired',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return `ok:${res.status}`;
  } catch (err) {
    return `error:${(err as Error).message?.slice(0, 80) ?? 'unknown'}`;
  } finally {
    clearTimeout(t);
  }
}

function enqueueDesktop(db: Database.Database, rule: Rule, payload: FiringPayload): string {
  const cfg = parseConfig<DesktopActionConfig>(rule);
  const title = cfg.title ?? rule.name;
  const body = `${payload.metric} = ${payload.metric_value.toFixed(2)} (threshold ${payload.threshold})`;
  db.prepare(
    `INSERT INTO pending_desktop_notifications (rule_id, fired_at, title, body) VALUES (?, ?, ?, ?)`,
  ).run(rule.id, payload.fired_at, title, body);
  return 'ok:enqueued';
}

async function executeEmail(_rule: Rule, _payload: FiringPayload): Promise<string> {
  // Not offered for new rules (server rejects it); kept so a rule stored by an
  // older version still evaluates without throwing.
  // M3: call Workers /v1/action/email with stored license_key.
  // Skeleton returns a stub so the evaluator can be tested without M3 infra.
  return 'skipped:email_not_wired_until_m3';
}

// ---------- Evaluator ----------

export interface EvalSummary {
  rules_checked: number;
  fired: number;
}

export async function evaluateRules(db: Database.Database, now = Date.now()): Promise<EvalSummary> {
  const rules = db
    .prepare(`SELECT * FROM rules WHERE enabled = 1`)
    .all() as Rule[];
  let fired = 0;
  for (const rule of rules) {
    const win = currentWindow(rule.metric);
    const value = metricValue(db, rule.metric, win);
    const cmp = rule.op === '>=' ? value >= rule.threshold : value > rule.threshold;
    if (!cmp) continue;
    if (rule.last_fired_at !== null && now - rule.last_fired_at < rule.cooldown_ms) continue;

    const payload: FiringPayload = {
      rule_id: rule.id,
      rule_name: rule.name,
      fired_at: now,
      metric: rule.metric,
      metric_value: value,
      threshold: rule.threshold,
      op: rule.op,
      window: win,
      summary: buildSummary(db, win),
    };

    let result: string;
    switch (rule.action_type as ActionType) {
      case 'notify.desktop':
        result = enqueueDesktop(db, rule, payload);
        break;
      case 'notify.webhook':
        result = await executeWebhook(rule, payload);
        break;
      case 'notify.email':
        result = await executeEmail(rule, payload);
        break;
      default:
        result = 'error:unknown_action';
    }

    db.prepare(
      `INSERT INTO rule_firings (rule_id, fired_at, metric_value, action_result) VALUES (?, ?, ?, ?)`,
    ).run(rule.id, now, value, result);
    db.prepare(`UPDATE rules SET last_fired_at = ? WHERE id = ?`).run(now, rule.id);
    fired++;
  }
  return { rules_checked: rules.length, fired };
}

// Dry-run: count how many days/weeks in the lookback window would have fired.
export function dryRun(
  db: Database.Database,
  input: Pick<RuleInput, 'metric' | 'op' | 'threshold'>,
  lookbackDays: number,
): { window_count: number; would_fire: number; max_value: number } {
  const now = new Date();
  const buckets: { start: number; end: number }[] = [];
  if (input.metric.startsWith('daily_') || input.metric === 'weekly_usd') {
    // Daily buckets for simplicity in dry-run (weekly approximated as 7-day rolling).
    for (let i = lookbackDays; i > 0; i--) {
      const end = new Date(now);
      end.setDate(end.getDate() - i + 1);
      end.setHours(0, 0, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - 1);
      buckets.push({ start: start.getTime(), end: end.getTime() });
    }
  } else {
    // monthly: just last N months
    for (let i = Math.ceil(lookbackDays / 30); i > 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start: start.getTime(), end: end.getTime() });
    }
  }
  let wouldFire = 0;
  let maxVal = 0;
  for (const b of buckets) {
    const v = metricValue(db, input.metric, { label: '', start_ts: b.start, end_ts: b.end });
    if (v > maxVal) maxVal = v;
    const cmp = input.op === '>=' ? v >= input.threshold : v > input.threshold;
    if (cmp) wouldFire++;
  }
  return { window_count: buckets.length, would_fire: wouldFire, max_value: maxVal };
}

// ---------- Desktop notification poll ----------

// Atomically mark-as-consumed and return notifications. Uses UPDATE … RETURNING
// so that two concurrent pollers (e.g. dashboard tab + MCP server) can't both
// claim the same row.
export function popPendingDesktopNotifications(
  db: Database.Database,
  limit = 10,
): { id: number; title: string; body: string; fired_at: number }[] {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const rows = db
    .prepare(
      `UPDATE pending_desktop_notifications
       SET consumed_at = ?
       WHERE id IN (
         SELECT id FROM pending_desktop_notifications
         WHERE consumed_at IS NULL
         ORDER BY fired_at ASC
         LIMIT ${safeLimit}
       )
       RETURNING id, title, body, fired_at`,
    )
    .all(Date.now()) as { id: number; title: string; body: string; fired_at: number }[];
  return rows;
}
