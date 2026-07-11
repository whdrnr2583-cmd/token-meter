import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate, openDb } from './db.js';
import { ingestAll } from './ingest.js';
import { byHour, byMcp, byModel, byProject, daily, overview, subagentCosts } from './stats.js';
import { forecastMonthly, getMonthlyBudget, setMonthlyBudget } from './forecast.js';
import { exportCsv, exportJson } from './export.js';
import { gatherDigestFacts, renderDigestText, sendWeeklyDigest } from './digest.js';
import { computeTrimSuggestions } from './trim-suggestions.js';
import {
  createRule,
  deleteRule,
  dryRun,
  evaluateRules,
  getRule,
  listRules,
  popPendingDesktopNotifications,
  recentFirings,
  updateRule,
} from './rules.js';
import type {
  ActionType,
  RuleInput,
  RuleMetric,
  RuleOp,
} from './rules-types.js';
import {
  sessionMessages,
  sessionOverview,
  sessionToolSummary,
  sessionTools,
  topSessions,
} from './sessions.js';
import {
  clampDaysToEntitlement,
  FREE_ACTION_TYPES,
  FREE_RULE_CAP,
  getEntitlement,
  isProTier,
} from './license.js';

// Runtime enum guards (TS types alone don't protect against malicious JSON).
const VALID_METRICS = new Set<RuleMetric>([
  'daily_usd',
  'weekly_usd',
  'monthly_usd',
  'daily_output_tokens',
  'daily_cache_write_tokens',
]);
const VALID_OPS = new Set<RuleOp>(['>=', '>']);
const VALID_ACTIONS = new Set<ActionType>([
  'notify.desktop',
  'notify.webhook',
  'notify.email',
]);

interface ValidationError {
  ok: false;
  field: string;
}
function validateRuleFields(
  patch: Partial<RuleInput>,
  required: boolean,
): ValidationError | null {
  if (patch.metric !== undefined && !VALID_METRICS.has(patch.metric as RuleMetric)) {
    return { ok: false, field: 'metric' };
  }
  if (patch.op !== undefined && !VALID_OPS.has(patch.op as RuleOp)) {
    return { ok: false, field: 'op' };
  }
  if (patch.action_type !== undefined && !VALID_ACTIONS.has(patch.action_type as ActionType)) {
    return { ok: false, field: 'action_type' };
  }
  if (patch.threshold !== undefined) {
    const t = Number(patch.threshold);
    if (!Number.isFinite(t) || t < 0) return { ok: false, field: 'threshold' };
  }
  if (patch.cooldown_ms !== undefined) {
    const c = Number(patch.cooldown_ms);
    if (!Number.isFinite(c) || c < 0 || c > 30 * 24 * 60 * 60 * 1000) {
      return { ok: false, field: 'cooldown_ms' };
    }
  }
  if (required) {
    if (!patch.name || !patch.metric || !patch.op || patch.threshold === undefined ||
        !patch.action_type || !patch.action_config) {
      return { ok: false, field: 'missing_required' };
    }
  }
  return null;
}

export function parseDays(q: unknown): number {
  if (typeof q === 'string') {
    const n = Number.parseInt(q, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) return n;
  }
  return 30;
}

// Parse ?days= and clamp it to the caller's tier in one step. Module-level and
// exported so tests can exercise the exact validation + entitlement clamp the
// live routes use, instead of re-implementing a looser handler.
export function daysFromQuery(q: unknown): number {
  const requested = parseDays(q);
  const ent = getEntitlement();
  return clampDaysToEntitlement(requested, ent.tier);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');

export async function startDashboard(): Promise<void> {
  const PORT = Number.parseInt(process.env.PORT ?? '8765', 10);
  const db = openDb();
  migrate(db);
  // Initial ingest on boot.
  ingestAll(db);

  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/' });

  function paywall(feature: string): { error: string; feature: string; message: string } {
    return {
      error: 'pro_required',
      feature,
      message: `${feature} is a Pro feature. See https://token-meter.dev#pricing`,
    };
  }

  app.get('/api/overview', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, ...overview(db, days) };
  });

  app.get('/api/daily', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, rows: daily(db, days) };
  });

  app.get('/api/models', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, rows: byModel(db, days) };
  });

  app.get('/api/projects', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, rows: byProject(db, days, 20) };
  });

  app.get('/api/mcp', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, rows: byMcp(db, days, 30) };
  });

  app.get('/api/hourly', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, rows: byHour(db, days) };
  });

  app.post('/api/refresh', async () => {
    return ingestAll(db);
  });

  // ---------- Rules ----------

  app.get('/api/rules', async () => ({ rows: listRules(db) }));

  app.post('/api/rules', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<RuleInput>;
    const err = validateRuleFields(body, true);
    if (err) return reply.code(400).send({ error: 'invalid_field', field: err.field });

    // Free-tier gates: action_type and rule count.
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) {
      if (body.action_type && !FREE_ACTION_TYPES.has(body.action_type)) {
        return reply.code(402).send(paywall(`action_type:${body.action_type}`));
      }
      const existing = listRules(db).length;
      if (existing >= FREE_RULE_CAP) {
        return reply.code(402).send(paywall(`rule_count_over_${FREE_RULE_CAP}`));
      }
    }

    const rule = createRule(db, {
      name: String(body.name).slice(0, 80),
      enabled: body.enabled !== false,
      metric: body.metric!,
      op: body.op!,
      threshold: Number(body.threshold),
      action_type: body.action_type!,
      action_config: body.action_config!,
      cooldown_ms: body.cooldown_ms,
    });
    return rule;
  });

  app.patch('/api/rules/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    const body = (req.body ?? {}) as Partial<RuleInput>;
    const err = validateRuleFields(body, false);
    if (err) return reply.code(400).send({ error: 'invalid_field', field: err.field });

    // Free-tier guard: prevent upgrading an existing rule to a Pro action type.
    const ent = getEntitlement();
    if (!isProTier(ent.tier) && body.action_type && !FREE_ACTION_TYPES.has(body.action_type)) {
      return reply.code(402).send(paywall(`action_type:${body.action_type}`));
    }

    const rule = updateRule(db, id, body);
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    return rule;
  });

  app.delete('/api/rules/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    const ok = deleteRule(db, id);
    if (!ok) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get('/api/rules/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    const rule = getRule(db, id);
    if (!rule) return reply.code(404).send({ error: 'not_found' });
    return rule;
  });

  app.get('/api/rules/:id/firings', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: 'invalid_id' });
    return { rows: recentFirings(db, id, 50) };
  });

  app.post('/api/rules/dry-run', async (req, reply) => {
    const body = req.body as { metric?: RuleInput['metric']; op?: RuleInput['op']; threshold?: number; lookback_days?: number } | null;
    if (!body || !body.metric || !body.op || body.threshold === undefined) {
      return reply.code(400).send({ error: 'missing_fields' });
    }
    return dryRun(
      db,
      { metric: body.metric, op: body.op, threshold: Number(body.threshold) },
      Math.min(180, Math.max(7, body.lookback_days ?? 30)),
    );
  });

  app.get('/api/desktop-notifications', async () => ({
    rows: popPendingDesktopNotifications(db, 10),
  }));

  // ---------- Session drill-down (Pro feature, ungated in dev) ----------

  app.get('/api/sessions', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('session_drilldown'));
    const q = req.query as Record<string, unknown>;
    const days = daysFromQuery(q.days);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(q.limit ?? '20'), 10) || 20));
    const project = typeof q.project === 'string' && q.project.length > 0 ? q.project : null;
    return { days, rows: topSessions(db, days, limit, project) };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('session_drilldown'));
    const id = decodeURIComponent((req.params as { id: string }).id);
    const overview = sessionOverview(db, id);
    if (!overview) return reply.code(404).send({ error: 'not_found' });
    return overview;
  });

  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('session_drilldown'));
    const id = decodeURIComponent((req.params as { id: string }).id);
    const overview = sessionOverview(db, id);
    if (!overview) return reply.code(404).send({ error: 'not_found' });
    return { rows: sessionMessages(db, id) };
  });

  app.get('/api/sessions/:id/tools', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('session_drilldown'));
    const id = decodeURIComponent((req.params as { id: string }).id);
    return {
      items: sessionTools(db, id),
      summary: sessionToolSummary(db, id),
    };
  });

  app.get('/api/sources', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    const since = Date.now() - days * 86_400_000;
    const rows = db
      .prepare(
        `SELECT source,
                COALESCE(SUM(usd_estimate), 0) AS usd,
                COALESCE(SUM(input_tokens), 0) AS input,
                COALESCE(SUM(output_tokens), 0) AS output,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
                COUNT(*) AS events
         FROM token_events WHERE ts >= ?
         GROUP BY source ORDER BY usd DESC`,
      )
      .all(since);
    return { days, rows };
  });

  // Free tier — main vs sub-agent (Task/Agent) spend split, mirrors the MCP
  // subagent_costs tool. Top 5 keeps the dashboard card to a short list, not
  // a scrollable table (per design: numbers + a short list, no new chart).
  app.get('/api/subagents', async (req) => {
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    return { days, ...subagentCosts(db, days, 5) };
  });

  // ---------- Feature 1: Cost forecast + pacing (Pro) ----------

  app.get('/api/forecast', async (_req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('cost_forecast'));
    return forecastMonthly(db);
  });

  app.get('/api/settings/budget', async (_req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('cost_forecast'));
    return { monthly_budget_usd: getMonthlyBudget(db) };
  });

  app.post('/api/settings/budget', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('cost_forecast'));
    const body = req.body as { monthly_budget_usd?: unknown } | null;
    const raw = body?.monthly_budget_usd;
    if (raw === null || raw === undefined) {
      setMonthlyBudget(db, null);
      return { monthly_budget_usd: null };
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      return reply.code(400).send({ error: 'invalid_budget', field: 'monthly_budget_usd' });
    }
    setMonthlyBudget(db, n);
    return { monthly_budget_usd: n };
  });

  // ---------- Feature 2: Export (Pro) ----------

  app.get('/api/export', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('csv_json_export'));
    const q = req.query as Record<string, unknown>;
    const days = daysFromQuery(q.days);
    const format = typeof q.format === 'string' ? q.format.toLowerCase() : 'json';
    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="token-meter-${days}d.csv"`);
      return reply.send(exportCsv(db, days));
    }
    // Default: JSON
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="token-meter-${days}d.json"`);
    return reply.send(exportJson(db, days));
  });

  // ---------- Feature 3: Weekly digest facts (Pro) ----------

  app.get('/api/digest/facts', async (_req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('weekly_digest'));
    return gatherDigestFacts(db);
  });

  app.get('/api/digest/preview', async (_req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('weekly_digest'));
    const facts = gatherDigestFacts(db);
    const text = renderDigestText(facts);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(text);
  });

  app.post('/api/digest/send', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('weekly_digest'));
    const body = req.body as { to?: unknown; license_key?: unknown } | null;
    const to = typeof body?.to === 'string' ? body.to.trim() : '';
    const key = typeof body?.license_key === 'string' ? body.license_key.trim() : '';
    if (!to || !to.includes('@')) {
      return reply.code(400).send({ error: 'invalid_email', field: 'to' });
    }
    if (!key) {
      return reply.code(400).send({ error: 'missing_license_key', field: 'license_key' });
    }
    const result = await sendWeeklyDigest(db, to, key);
    return result;
  });

  // ---------- Feature 4: Auto-trim suggestions (Pro) ----------

  app.get('/api/trim-suggestions', async (req, reply) => {
    const ent = getEntitlement();
    if (!isProTier(ent.tier)) return reply.code(402).send(paywall('trim_suggestions'));
    const days = daysFromQuery((req.query as Record<string, unknown>).days);
    const suggestions = computeTrimSuggestions(db, days);
    return { days, count: suggestions.length, suggestions };
  });

  await app.listen({ host: '127.0.0.1', port: PORT });
  console.log(`Token Meter dashboard ready at http://127.0.0.1:${PORT}`);

  // Periodic incremental ingest + rule evaluation every 30 seconds.
  setInterval(() => {
    try {
      ingestAll(db);
    } catch (err) {
      console.error('ingest tick failed:', err);
    }
    evaluateRules(db).catch((err) => console.error('rule eval failed:', err));
  }, 30_000);
}

// Auto-run when invoked directly (e.g. `npm run serve` / `tsx src/server.ts`).
// When imported by another module (cli.ts), this stays dormant.
if (process.argv[1] === __filename) {
  startDashboard().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
