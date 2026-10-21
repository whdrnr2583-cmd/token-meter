const $ = (sel) => document.querySelector(sel);
// i18n.js defines window.t; fall back to the Korean source text if it did not load.
const t_ = typeof window.t === 'function' ? window.t : (k, v) => (v ? k.replace(/\{(\w+)\}/g, (m, n) => (v[n] ?? m)) : k);

// Escape user-controlled strings before interpolating into innerHTML.
// JSONL data (model name, project path, tool name, MCP server name, rule name,
// session id) may contain HTML metacharacters if produced by a third-party MCP
// server or written into a directory with special characters. innerHTML without
// escape would execute scripts in the local dashboard origin.
const _ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => _ESCAPE[c]);

const fmtUsd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtUsdSmall = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
};
const fmtMs = (n) => {
  n = Number(n) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
};

const STATE = { days: 30, charts: {} };

async function api(path, init) {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function makeNotice(text) {
  const node = document.createElement('div');
  node.className = 'hint plan-notice';
  node.style.gridColumn = '1 / -1';
  node.textContent = text;
  return node;
}

function makeCard(label, value, sub, accent) {
  const node = document.createElement('div');
  node.className = 'card';
  node.innerHTML = `
    <div class="label">${label}</div>
    <div class="value ${accent ? 'accent' : ''}">${value}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
  `;
  return node;
}

// First-run / empty-data banner. When no logs have been ingested yet the
// charts and tables would all be blank with no explanation — show the user
// exactly what to do instead. Returns true when the dashboard has data.
async function renderEmptyState() {
  const box = $('#empty-state');
  let status;
  try {
    status = await api('/api/status');
  } catch {
    box.hidden = true;
    return true; // status check failed — fall through to the normal render
  }
  if (status.has_data) {
    box.hidden = true;
    return true;
  }
  const guide = esc(status.guidance || 'No Claude Code or Codex usage found yet.');
  box.innerHTML = `
    <h2>${t_('아직 사용 데이터가 없습니다')}</h2>
    <p>${guide.replace(/\n/g, '<br>')}</p>
    <p>${t_('Claude Code / Codex를 한 번 사용한 뒤 터미널에서 {cmd} 를 실행하거나 우측 상단 {btn} 을 누르세요.', {
      cmd: '<code>token-meter ingest</code>',
      btn: `<strong>${t_('↻ 새로고침')}</strong>`,
    })}</p>
  `;
  box.hidden = false;
  return false;
}

async function renderOverview() {
  const data = await api(`/api/overview?days=${STATE.days}`);
  const wrap = $('#overview-cards');
  wrap.innerHTML = '';
  // The server clamps the window to the plan's history limit; label what is
  // actually shown instead of the requested range.
  const shownDays = data.days ?? STATE.days;
  if (shownDays < STATE.days) {
    wrap.append(makeNotice(t_('현재 플랜은 최근 {shown}일까지만 표시합니다 (선택: {sel}일).', { shown: shownDays, sel: STATE.days })));
  }
  wrap.append(makeCard('비용 (USD, Anthropic API 기준)', fmtUsd(data.total_usd), t_('{n}일 누적', { n: shownDays }), true));
  wrap.append(makeCard('출력 토큰', fmtTok(data.total_output), t_('이벤트 {n}건', { n: data.events.toLocaleString() })));
  wrap.append(makeCard('캐시 읽기', fmtTok(data.total_cache_read), '비용 절감원'));
  wrap.append(makeCard('캐시 쓰기', fmtTok(data.total_cache_write), '5분·1시간 캐시'));
  wrap.append(makeCard('입력 토큰', fmtTok(data.total_input), '비-캐시'));
}

async function renderDailyChart() {
  const data = await api(`/api/daily?days=${STATE.days}`);
  const ctx = $('#chart-daily').getContext('2d');
  if (STATE.charts.daily) STATE.charts.daily.destroy();
  STATE.charts.daily = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.rows.map((r) => r.day.slice(5)),
      datasets: [
        {
          label: 'USD',
          data: data.rows.map((r) => r.usd),
          backgroundColor: '#58a6ff',
          borderRadius: 4,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { display: false } },
        y: { ticks: { color: '#8b949e', callback: (v) => `$${v}` }, grid: { color: '#2a313c' } },
      },
    },
  });
}

async function renderHourlyChart() {
  const data = await api(`/api/hourly?days=${STATE.days}`);
  const buckets = Array.from({ length: 24 }, (_, h) => {
    const row = data.rows.find((r) => r.hour === h);
    return row ? row.output_tokens : 0;
  });
  const ctx = $('#chart-hourly').getContext('2d');
  if (STATE.charts.hourly) STATE.charts.hourly.destroy();
  STATE.charts.hourly = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: buckets.map((_, h) => `${h}h`),
      datasets: [
        {
          label: 'output tokens',
          data: buckets,
          backgroundColor: '#3fb950',
          borderRadius: 3,
        },
      ],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', maxRotation: 0 }, grid: { display: false } },
        y: {
          ticks: { color: '#8b949e', callback: (v) => fmtTok(v) },
          grid: { color: '#2a313c' },
        },
      },
    },
  });
}

async function renderModels() {
  const data = await api(`/api/models?days=${STATE.days}`);
  const t = $('#table-models');
  t.innerHTML = `
    <thead><tr>
      <th>모델</th><th class="num">USD</th><th class="num">출력</th>
      <th class="num">캐시 읽기</th><th class="num">호출</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => `
        <tr>
          <td>${esc(r.model)}</td>
          <td class="num accent">${fmtUsd(r.usd)}</td>
          <td class="num">${fmtTok(r.output)}</td>
          <td class="num muted">${fmtTok(r.cache_read)}</td>
          <td class="num">${r.events.toLocaleString()}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

async function renderProjects() {
  const data = await api(`/api/projects?days=${STATE.days}`);
  const t = $('#table-projects');
  t.innerHTML = `
    <thead><tr>
      <th>프로젝트</th><th class="num">USD</th><th class="num">이벤트</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => {
        const short = r.project.length > 50 ? '…' + r.project.slice(-50) : r.project;
        return `
          <tr>
            <td title="${esc(r.project)}">${esc(short)}</td>
            <td class="num accent">${fmtUsd(r.usd)}</td>
            <td class="num">${r.events.toLocaleString()}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

async function renderSources() {
  const data = await api(`/api/sources?days=${STATE.days}`);
  const t = $('#table-sources');
  if (!data.rows.length) {
    t.innerHTML = '<tbody><tr><td class="muted">데이터 없음</td></tr></tbody>';
    return;
  }
  const SOURCE_LABEL = { 'claude-code': 'Claude Code', codex: 'Codex' };
  t.innerHTML = `
    <thead><tr>
      <th>소스</th><th class="num">USD</th><th class="num">입력</th>
      <th class="num">출력</th><th class="num">캐시 읽기</th><th class="num">이벤트</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => `
        <tr>
          <td>${esc(SOURCE_LABEL[r.source] ?? r.source)}</td>
          <td class="num accent">${fmtUsd(r.usd)}</td>
          <td class="num">${fmtTok(r.input)}</td>
          <td class="num">${fmtTok(r.output)}</td>
          <td class="num muted">${fmtTok(r.cache_read)}</td>
          <td class="num">${r.events.toLocaleString()}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

async function renderMcp() {
  const data = await api(`/api/mcp?days=${STATE.days}`);
  const t = $('#table-mcp');
  t.innerHTML = `
    <thead><tr>
      <th>MCP 서버</th><th>도구</th>
      <th class="num">호출</th><th class="num">응답 토큰 (추정)</th>
      <th class="num">평균 지연</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => `
        <tr>
          <td>${r.mcp_server ? esc(r.mcp_server) : '<span class="muted">- (built-in)</span>'}</td>
          <td>${esc(r.tool_name)}</td>
          <td class="num">${r.calls.toLocaleString()}</td>
          <td class="num">${fmtTok(r.total_response_tokens)}</td>
          <td class="num">${fmtMs(r.avg_latency_ms)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

async function renderSubagents() {
  const data = await api(`/api/subagents?days=${STATE.days}`);
  const wrap = $('#subagent-cards');
  wrap.innerHTML = '';
  const { main, subagent } = data.split;
  wrap.append(makeCard('메인 세션', fmtUsd(main.usd), t_('{n}건', { n: main.events.toLocaleString() })));
  wrap.append(makeCard('서브에이전트', fmtUsd(subagent.usd), t_('{n}건', { n: subagent.events.toLocaleString() }), true));
  wrap.append(makeCard('서브에이전트 비중', `${data.subagent_share_pct.toFixed(1)}%`, '전체 USD 대비'));

  const t = $('#table-subagents');
  if (!data.top.length) {
    t.innerHTML = '<tbody><tr><td class="muted">서브에이전트 사용 없음</td></tr></tbody>';
    return;
  }
  t.innerHTML = `
    <thead><tr>
      <th>agent_id</th><th>모델</th>
      <th class="num">USD</th><th class="num">출력</th><th class="num">호출</th>
    </tr></thead>
    <tbody>
      ${data.top.map((r) => `
        <tr>
          <td>${esc(r.agent_id)}</td>
          <td class="muted">${esc(r.models)}</td>
          <td class="num accent">${fmtUsd(r.usd)}</td>
          <td class="num">${fmtTok(r.output)}</td>
          <td class="num">${r.events.toLocaleString()}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

// The 5 audit signal types that get a summary card (per the audit spec —
// high_cost_model_signal findings still show up in the findings table below,
// just without a dedicated card).
const AUDIT_CARD_TYPES = [
  'expensive_session',
  'oversized_tool_response',
  'slow_tool',
  'repeated_similar_tool_calls',
  'cache_inefficiency',
];
const AUDIT_TYPE_LABEL = {
  expensive_session: '비싼 세션',
  oversized_tool_response: '응답 과다',
  slow_tool: '느린 도구',
  repeated_similar_tool_calls: '반복 호출',
  cache_inefficiency: '캐시 비효율',
  high_cost_model_signal: '고비용 모델',
};
// Icon + word pairing so confidence is never color-only.
const AUDIT_CONFIDENCE_LABEL = { high: '🟢 높음', medium: '🟡 보통', low: '🔴 낮음' };

// Truncates free-text prose (evidence/recommendation sentences) from the
// tail, keeping the more informative leading clause. Pairs with a `title`
// attribute holding the full text, same accessibility pattern as the
// project/session-id truncation below (prefix-preserving there because the
// meaningful part of a path is its tail; here the meaningful part is the
// start of the sentence).
function truncateTail(s, max) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

async function renderAudit() {
  const data = await api(`/api/audit?days=${STATE.days}`);
  const findings = data.findings;

  const cardsWrap = $('#audit-cards');
  cardsWrap.innerHTML = '';
  for (const type of AUDIT_CARD_TYPES) {
    const matches = findings.filter((f) => f.type === type);
    if (!matches.length) continue; // no fabricated zero-card for absent types
    const pricedTotal = matches
      .filter((f) => f.estimatedCostUsd !== null)
      .reduce((sum, f) => sum + f.estimatedCostUsd, 0);
    const hasPrice = matches.some((f) => f.estimatedCostUsd !== null);
    cardsWrap.append(
      makeCard(AUDIT_TYPE_LABEL[type], t_('{n}건 발견', { n: matches.length }), hasPrice ? t_('연관 비용 {usd}', { usd: fmtUsd(pricedTotal) }) : null),
    );
  }
  if (!cardsWrap.children.length) {
    cardsWrap.innerHTML = '<div class="hint">기간 내 발견된 시그널 없음</div>';
  }

  const t = $('#table-audit');
  if (!findings.length) {
    t.innerHTML = '<tbody><tr><td class="muted">비용·효율 시그널 없음</td></tr></tbody>';
    return;
  }
  t.innerHTML = `
    <thead><tr>
      <th>유형</th><th>측정값</th><th>프로젝트</th><th>세션/도구</th><th>신뢰도</th><th>권장 조치</th>
    </tr></thead>
    <tbody>
      ${findings.map((f) => {
        const project = f.project ?? '-';
        const projShort = project.length > 40 ? '…' + project.slice(-40) : project;
        const sessionOrTool = f.sessionId ?? f.toolName ?? '-';
        const sotShort = sessionOrTool.length > 30 ? '…' + sessionOrTool.slice(-30) : sessionOrTool;
        const metricText = f.evidence.join(' ') || f.title;
        const recText = f.recommendations[0] ?? '-';
        return `
          <tr>
            <td>${esc(AUDIT_TYPE_LABEL[f.type] ?? f.type)}</td>
            <td title="${esc(metricText)}">${esc(truncateTail(metricText, 140))}</td>
            <td title="${esc(project)}">${esc(projShort)}</td>
            <td title="${esc(sessionOrTool)}">${esc(sotShort)}</td>
            <td>${esc(AUDIT_CONFIDENCE_LABEL[f.confidence] ?? f.confidence)}</td>
            <td title="${esc(recText)}">${esc(truncateTail(recText, 100))}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

const METRIC_LABEL = {
  daily_usd: '일별 USD',
  weekly_usd: '주별 USD',
  monthly_usd: '월별 USD',
  daily_output_tokens: '일별 output 토큰',
  daily_cache_write_tokens: '일별 cache write 토큰',
};
const ACTION_LABEL = {
  'notify.desktop': '데스크탑',
  'notify.webhook': '웹훅',
  'notify.email': '이메일',
};

function fmtThreshold(metric, v) {
  if (metric.includes('usd')) return fmtUsd(v);
  if (metric.includes('tokens')) return fmtTok(v);
  return String(v);
}

async function renderRules() {
  const data = await api('/api/rules');
  const t = $('#table-rules');
  if (!data.rows.length) {
    t.innerHTML = '<tbody><tr><td class="muted" colspan="6">아직 룰이 없습니다. + 새 룰을 눌러 추가하세요.</td></tr></tbody>';
    return;
  }
  t.innerHTML = `
    <thead><tr>
      <th>상태</th><th>이름</th><th>조건</th><th>액션</th><th>최근 발화</th><th></th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => {
        const cfg = (() => { try { return JSON.parse(r.action_config); } catch { return {}; } })();
        const cfgPreview =
          r.action_type === 'notify.webhook' ? (cfg.url ?? '').replace(/^https?:\/\//, '') :
          r.action_type === 'notify.email'   ? (cfg.to ?? '') : '';
        const last = r.last_fired_at ? new Date(r.last_fired_at).toLocaleString() : '—';
        return `
          <tr data-id="${r.id}">
            <td class="${r.enabled ? 'badge-on' : 'badge-off'}">${r.enabled ? 'ON' : 'OFF'}</td>
            <td>${esc(r.name)}</td>
            <td class="muted">${esc(METRIC_LABEL[r.metric] ?? r.metric)} ${esc(r.op)} ${esc(fmtThreshold(r.metric, r.threshold))}</td>
            <td>${esc(ACTION_LABEL[r.action_type] ?? r.action_type)} ${cfgPreview ? `<span class="muted">${esc(cfgPreview.slice(0, 32))}</span>` : ''}</td>
            <td class="muted">${esc(last)}</td>
            <td class="row-actions">
              <button data-act="toggle">${r.enabled ? '끄기' : '켜기'}</button>
              <button data-act="edit">수정</button>
              <button data-act="delete" class="danger">삭제</button>
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

let CURRENT_EDIT_ID = null;

function openRuleDialog(rule) {
  CURRENT_EDIT_ID = rule?.id ?? null;
  $('#rule-form-title').textContent = t_(rule ? '룰 수정' : '새 룰');
  const f = $('#rule-form');
  f.reset();
  if (rule) {
    f.name.value = rule.name;
    f.enabled.checked = !!rule.enabled;
    f.metric.value = rule.metric;
    f.op.value = rule.op;
    f.threshold.value = rule.threshold;
    f.action_type.value = rule.action_type;
    f.cooldown_hours.value = Math.round(rule.cooldown_ms / 3_600_000);
    try {
      const cfg = JSON.parse(rule.action_config);
      if (rule.action_type === 'notify.webhook') f.webhook_url.value = cfg.url ?? '';
      if (rule.action_type === 'notify.email')   f.email_to.value   = cfg.to  ?? '';
    } catch {}
  }
  toggleActionFields();
  $('#rule-dry-run-result').textContent = '';
  $('#rule-dialog').showModal();
}

function toggleActionFields() {
  const v = $('#rule-form').action_type.value;
  $('#webhook-url-field').hidden = v !== 'notify.webhook';
  $('#email-to-field').hidden    = v !== 'notify.email';
}

async function submitRule(e) {
  e.preventDefault();
  const f = $('#rule-form');
  const action_type = f.action_type.value;
  const action_config =
    action_type === 'notify.webhook' ? { url: f.webhook_url.value } :
    action_type === 'notify.email'   ? { to:  f.email_to.value }    :
    { title: f.name.value };
  const body = {
    name: f.name.value,
    enabled: f.enabled.checked,
    metric: f.metric.value,
    op: f.op.value,
    threshold: Number(f.threshold.value),
    action_type,
    action_config,
    cooldown_ms: Math.max(0, Number(f.cooldown_hours.value) * 3_600_000),
  };
  const url = CURRENT_EDIT_ID ? `/api/rules/${CURRENT_EDIT_ID}` : '/api/rules';
  const method = CURRENT_EDIT_ID ? 'PATCH' : 'POST';
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    alert(t_('저장 실패: {status}', { status: res.status }));
    return;
  }
  $('#rule-dialog').close();
  if (action_type === 'notify.desktop' && 'Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
  await renderRules();
}

async function doDryRun() {
  const f = $('#rule-form');
  const body = {
    metric: f.metric.value,
    op: f.op.value,
    threshold: Number(f.threshold.value),
    lookback_days: 30,
  };
  const res = await fetch('/api/rules/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { $('#rule-dry-run-result').textContent = t_('드라이런 실패'); return; }
  const r = await res.json();
  $('#rule-dry-run-result').textContent = t_('최근 {days}일 중 {n}회 발화. 최대값 {max}.', { days: r.window_count, n: r.would_fire, max: fmtThreshold(body.metric, r.max_value) });
}

async function rulesRowAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = Number(tr.dataset.id);
  const act = btn.dataset.act;
  if (act === 'toggle') {
    const rule = await api(`/api/rules/${id}`);
    await fetch(`/api/rules/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !rule.enabled }),
    });
    await renderRules();
  } else if (act === 'edit') {
    const rule = await api(`/api/rules/${id}`);
    openRuleDialog(rule);
  } else if (act === 'delete') {
    if (!confirm(t_('이 룰을 삭제할까요?'))) return;
    await fetch(`/api/rules/${id}`, { method: 'DELETE' });
    await renderRules();
  }
}

async function pollDesktopNotifications() {
  if (!('Notification' in window)) return;
  // Permission is requested only after the user saves a desktop-notification
  // rule (see submitRule), never unprompted on page load.
  if (Notification.permission !== 'granted') return;
  try {
    const data = await api('/api/desktop-notifications');
    for (const n of data.rows) {
      new Notification(n.title, { body: n.body, tag: `tm-rule-${n.id}` });
    }
  } catch {}
}

$('#rule-new').addEventListener('click', () => openRuleDialog(null));
$('#rule-cancel').addEventListener('click', () => $('#rule-dialog').close());
$('#rule-form').addEventListener('submit', submitRule);
$('#rule-form').action_type.addEventListener('change', toggleActionFields);
$('#rule-dry-run').addEventListener('click', doDryRun);
$('#table-rules').addEventListener('click', rulesRowAction);

setInterval(() => pollDesktopNotifications().catch(() => {}), 15_000);
setInterval(() => renderRules().catch(() => {}), 60_000);

// ---------- Session drill-down ----------

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m - h * 60}m`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function shortId(id, head = 8) {
  if (!id) return '';
  return id.length > head + 4 ? `${id.slice(0, head)}…${id.slice(-4)}` : id;
}

function sessionLabel(r) {
  // Plain text (escaped by the caller via esc() when placed in an attribute).
  return [r.project, fmtUsd(r.total_usd), new Date(r.start_ts).toLocaleString()].join(' — ');
}

async function renderSessions() {
  const data = await api(`/api/sessions?days=${STATE.days}&limit=20`);
  const t = $('#table-sessions');
  if (!data.rows.length) {
    t.innerHTML = '<tbody><tr><td class="muted" colspan="6">데이터 없음</td></tr></tbody>';
    return;
  }
  t.innerHTML = `
    <thead><tr>
      <th>시작</th>
      <th>프로젝트</th>
      <th>소스</th>
      <th>모델</th>
      <th class="num">USD</th>
      <th class="num">출력</th>
      <th class="num">이벤트</th>
      <th class="num">소요 시간</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => {
        const project = r.project.length > 40 ? '…' + r.project.slice(-40) : r.project;
        const source = r.source === 'claude-code' ? 'Claude' : r.source === 'codex' ? 'Codex' : r.source;
        return `
          <tr data-session="${esc(r.session_id)}" title="${esc(r.session_id)}">
            <td class="muted"><button type="button" class="link-btn" aria-label="${esc(sessionLabel(r))}">${new Date(r.start_ts).toLocaleString()}</button></td>
            <td title="${esc(r.project)}">${esc(project)}</td>
            <td>${esc(source)}</td>
            <td class="muted">${esc(r.top_model)}</td>
            <td class="num accent">${fmtUsd(r.total_usd)}</td>
            <td class="num">${fmtTok(r.total_output)}</td>
            <td class="num">${r.events.toLocaleString()}</td>
            <td class="num muted">${fmtDuration(r.duration_ms)}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

async function openSessionDialog(sessionId) {
  const overview = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
  $('#session-dialog-title').textContent = t_('세션 — {usd} · {n}건', { usd: fmtUsd(overview.total_usd), n: overview.events });
  $('#session-dialog-meta').innerHTML = `
    <div><strong>session_id:</strong> ${esc(overview.session_id)}</div>
    <div><strong>project:</strong> ${esc(overview.project)}</div>
    <div><strong>${fmtTime(overview.start_ts)}</strong> → ${fmtTime(overview.end_ts)} (${fmtDuration(overview.duration_ms)})</div>
    <div>input ${fmtTok(overview.total_input)} · output ${fmtTok(overview.total_output)} · cache_read ${fmtTok(overview.total_cache_read)} · cache_write ${fmtTok(overview.total_cache_write)}</div>
  `;
  $('#session-dialog').showModal();
  switchTab('messages');
  // Load both tabs concurrently.
  loadSessionMessages(sessionId).catch(console.error);
  loadSessionTools(sessionId).catch(console.error);
}

async function loadSessionMessages(sessionId) {
  const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  const t = $('#table-session-messages');
  if (!data.rows.length) {
    t.innerHTML = '<tbody><tr><td class="muted">메시지 없음</td></tr></tbody>';
    return;
  }
  // Find max usd for visual emphasis
  const maxUsd = Math.max(...data.rows.map((r) => r.usd_estimate));
  t.innerHTML = `
    <thead><tr>
      <th>시간</th><th>모델</th>
      <th class="num">입력</th><th class="num">출력</th>
      <th class="num">캐시 read</th><th class="num">캐시 write</th>
      <th class="num">USD</th>
    </tr></thead>
    <tbody>
      ${data.rows.map((r) => {
        const hot = maxUsd > 0 && r.usd_estimate >= maxUsd * 0.5 ? 'accent' : '';
        return `
          <tr>
            <td class="muted">${new Date(r.ts).toLocaleString()}</td>
            <td class="muted">${esc(r.model)}</td>
            <td class="num">${fmtTok(r.input_tokens)}</td>
            <td class="num">${fmtTok(r.output_tokens)}</td>
            <td class="num muted">${fmtTok(r.cache_read_tokens)}</td>
            <td class="num muted">${fmtTok(r.cache_write_tokens)}</td>
            <td class="num ${hot}">${fmtUsdSmall(r.usd_estimate)}</td>
          </tr>
        `;
      }).join('')}
    </tbody>
  `;
}

async function loadSessionTools(sessionId) {
  const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}/tools`);
  const summary = $('#table-session-tool-summary');
  if (!data.summary.length) {
    summary.innerHTML = '<tbody><tr><td class="muted">도구 호출 없음</td></tr></tbody>';
  } else {
    summary.innerHTML = `
      <thead><tr>
        <th>MCP</th><th>도구</th>
        <th class="num">호출</th><th class="num">응답 토큰</th>
        <th class="num">평균 지연</th>
      </tr></thead>
      <tbody>
        ${data.summary.map((r) => `
          <tr>
            <td>${r.mcp_server ? esc(r.mcp_server) : '<span class="muted">-</span>'}</td>
            <td>${esc(r.tool_name)}</td>
            <td class="num">${r.calls.toLocaleString()}</td>
            <td class="num">${fmtTok(r.total_response_tokens)}</td>
            <td class="num">${fmtMs(r.avg_latency_ms)}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }
  const items = $('#table-session-tools');
  if (!data.items.length) {
    items.innerHTML = '<tbody><tr><td class="muted">없음</td></tr></tbody>';
  } else {
    items.innerHTML = `
      <thead><tr>
        <th>시간</th><th>MCP</th><th>도구</th>
        <th class="num">응답 토큰</th><th class="num">지연</th>
      </tr></thead>
      <tbody>
        ${data.items.map((r) => `
          <tr>
            <td class="muted">${new Date(r.ts).toLocaleTimeString()}</td>
            <td>${r.mcp_server ? esc(r.mcp_server) : '<span class="muted">-</span>'}</td>
            <td>${esc(r.tool_name)}</td>
            <td class="num">${fmtTok(r.response_tokens_est)}</td>
            <td class="num muted">${fmtMs(r.latency_ms ?? 0)}</td>
          </tr>
        `).join('')}
      </tbody>
    `;
  }
}

function switchTab(name) {
  document.querySelectorAll('.dialog-tabs .tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.tab-body').forEach((b) => {
    b.classList.toggle('active', b.id === `tab-${name}`);
  });
}

$('#table-sessions').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-session]');
  if (!tr) return;
  openSessionDialog(tr.dataset.session).catch((err) => {
    alert(t_('세션 로드 실패: {msg}', { msg: err.message }));
  });
});
$('#session-close').addEventListener('click', () => $('#session-dialog').close());
document.querySelectorAll('.dialog-tabs .tab').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  b.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = [...document.querySelectorAll('.dialog-tabs .tab')];
    const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    switchTab(next.dataset.tab);
    next.focus();
  });
});

const SECTION_RENDERERS = [
  ['overview', renderOverview],
  ['sources', renderSources],
  ['daily chart', renderDailyChart],
  ['hourly chart', renderHourlyChart],
  ['models', renderModels],
  ['projects', renderProjects],
  ['MCP', renderMcp],
  ['sub-agents', renderSubagents],
  ['audit', renderAudit],
  ['sessions', renderSessions],
  ['rules', renderRules],
];

function showLoadError(failed, serverDown) {
  const box = $('#load-error');
  if (!failed.length) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  const msg = serverDown
    ? t_('대시보드를 불러오지 못했습니다. token-meter serve 가 실행 중인지 확인하세요.')
    : t_('일부 데이터를 불러오지 못했습니다: {what}', { what: failed.map(([name]) => name).join(', ') });
  box.innerHTML = `<p>${esc(msg)} <button type="button" id="load-retry" class="btn-secondary">${t_('다시 시도')}</button></p>`;
  box.hidden = false;
  $('#load-retry').addEventListener('click', () => refreshAll().catch(console.error));
}

// Each section renders independently: one failing endpoint no longer blanks
// the whole page, and the user gets a visible message plus a retry button.
async function refreshAll() {
  await renderEmptyState();
  const results = await Promise.allSettled(SECTION_RENDERERS.map(([, fn]) => fn()));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(SECTION_RENDERERS[i][0], r.reason);
      failed.push([SECTION_RENDERERS[i][0], r.reason]);
    }
  });
  showLoadError(failed, failed.length === SECTION_RENDERERS.length);
  pollDesktopNotifications().catch(() => {});
}

$('#days').addEventListener('change', (e) => {
  STATE.days = Number.parseInt(e.target.value, 10);
  refreshAll().catch(console.error);
});

$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await refreshAll();
  } catch (err) {
    console.error(err);
    showLoadError([['refresh', err]], true);
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
});

$('#lang-toggle').addEventListener('click', () => {
  const next = window.TM_I18N && window.TM_I18N.lang() === 'en' ? 'ko' : 'en';
  try { localStorage.setItem('tm-lang', next); } catch {}
  const u = new URL(location.href);
  u.searchParams.set('lang', next);
  location.href = u.toString();
});

refreshAll().catch((err) => {
  console.error(err);
  showLoadError([['dashboard', err]], true);
});
