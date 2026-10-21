// Dashboard localisation. The Korean strings in index.html / app.js are the
// source keys (so Korean users see exactly what they always did); this file maps
// them to English, which is the default for every browser whose language is not
// Korean. Choose explicitly with ?lang=en|ko — the choice is remembered.
//
// - t(key, vars)    : translate a (possibly {placeholder}) key at call time.
// - applyI18n(root) : translate static text nodes + placeholder/title/aria-label.
// A MutationObserver re-applies it to anything app.js renders later, so table
// templates do not need to be wrapped one by one.
(function () {
  'use strict';

  var EN = {
    // header / chrome
    '기간': 'Period',
    '7일': '7 days', '14일': '14 days', '30일': '30 days', '60일': '60 days', '90일': '90 days',
    '↻ 새로고침': '↻ Refresh',
    '💡 USD 수치는': '💡 USD figures are estimates computed as',
    '로컬 토큰 카운트 × 공시 단가': 'local token counts × published list prices',
    '로 계산한 추정치입니다. 실제 청구액(Anthropic·OpenAI 인보이스)과 다를 수 있으며, 단가 변동·서브스크립션 정액·캐시 변형은 반영하지 않습니다.':
      '. They can differ from your actual Anthropic / OpenAI invoice and do not reflect price changes, flat-rate subscriptions or cache variants.',
    '낭비 위치 신호로 사용하고, 회계 자료로는 쓰지 마세요.': 'Use them to spot where tokens go, not as accounting records.',
    // sections
    '소스별 (Claude Code · Codex)': 'By source (Claude Code · Codex)',
    '일별 비용 (USD)': 'Daily cost (USD)',
    '시간대별 출력 토큰': 'Output tokens by hour',
    '모델별': 'By model',
    '프로젝트별': 'By project',
    'MCP · 도구별 분석': 'MCP & tool breakdown',
    '🟢 호출 횟수·지연은 직접 측정. 🟡 응답 토큰·청구 기여도(USD)는 추정.':
      '🟢 Call counts and latency are measured. 🟡 Response tokens and cost contribution (USD) are estimated.',
    '서브에이전트 (Task/Agent)': 'Sub-agents (Task/Agent)',
    '메인 세션 vs 서브에이전트(Task/Agent) 지출 분리 · 가장 비싼 서브에이전트 Top 5':
      'Main session vs sub-agent (Task/Agent) spend · 5 most expensive sub-agents',
    '비용·효율 시그널 Top (Audit)': 'Top cost & efficiency signals (Audit)',
    '비싼 세션·과다 응답·느린 도구·반복 호출·캐시 낭비 신호를 감사 엔진으로 스캔한 결과':
      'Expensive sessions, oversized responses, slow tools, repeated calls and cache waste, found by the local audit engine',
    '비싼 세션 Top (드릴다운)': 'Most expensive sessions (drill-down)',
    '행 클릭 → 세션 내부 메시지·도구별 분해': 'Select a row → per-message and per-tool breakdown',
    '세션 상세': 'Session details',
    '닫기': 'Close',
    '메시지': 'Messages',
    '도구 호출': 'Tool calls',
    '요약 (도구별)': 'Summary (by tool)',
    '호출 순서': 'Call order',
    '알림 룰 (Actions)': 'Alert rules',
    '+ 새 룰': '+ New rule',
    '임계값 초과 시 데스크탑 알림 / 웹훅 발송 (이메일은 아직 발송되지 않음). 24시간 쿨다운 기본. Slack·Discord·n8n 등 추가 채널은 웹훅 +':
      'Desktop notification or webhook when a threshold is exceeded (email is not sent yet). 24-hour cooldown by default. For Slack, Discord, n8n and other channels use a webhook —',
    '커스터마이즈 가이드': 'customization guide',
    '참조.': 'for details.',
    // rule dialog
    '새 룰': 'New rule',
    '룰 수정': 'Edit rule',
    '이름': 'Name',
    '활성화': 'Enabled',
    '메트릭': 'Metric',
    '일별 USD': 'Daily USD',
    '주별 USD': 'Weekly USD',
    '월별 USD': 'Monthly USD',
    '일별 output 토큰': 'Daily output tokens',
    '일별 cache write 토큰': 'Daily cache-write tokens',
    '비교': 'Operator',
    '임계값': 'Threshold',
    '액션': 'Action',
    '데스크탑 알림 (Free·Pro)': 'Desktop notification (Free · Pro)',
    '웹훅 POST (Pro)': 'Webhook POST (Pro)',
    '이메일 (Pro, 준비 중 — 아직 발송되지 않음)': 'Email (Pro, coming soon — not sent yet)',
    '웹훅 URL': 'Webhook URL',
    '⚠ 본인이 신뢰하는 URL만 입력하세요. 내부 호스트(localhost·private IP)를 가리키면 SSRF 위험.':
      '⚠ Only enter URLs you trust. Pointing at internal hosts (localhost, private IPs) risks SSRF.',
    '이메일': 'Email',
    '쿨다운 (시간)': 'Cooldown (hours)',
    '드라이런 (30일 미리보기)': 'Dry run (30-day preview)',
    '취소': 'Cancel',
    '저장': 'Save',
    '예: Daily over $50': 'e.g. Daily over $50',
    // cards & tables
    '비용 (USD, Anthropic API 기준)': 'Cost (USD, Anthropic API list price)',
    '출력 토큰': 'Output tokens',
    '응답 토큰': 'Response tokens',
    '캐시 읽기': 'Cache read',
    '비용 절감원': 'Saves cost',
    '캐시 쓰기': 'Cache write',
    '5분·1시간 캐시': '5-min + 1-hour caches',
    '입력 토큰': 'Input tokens',
    '비-캐시': 'Uncached',
    '모델': 'Model',
    '출력': 'Output',
    '호출': 'Calls',
    '프로젝트': 'Project',
    '이벤트': 'Events',
    '데이터 없음': 'No data',
    '소스': 'Source',
    '입력': 'Input',
    'MCP 서버': 'MCP server',
    '도구': 'Tool',
    '응답 토큰 (추정)': 'Response tokens (est.)',
    '평균 지연': 'Avg latency',
    '메인 세션': 'Main session',
    '서브에이전트': 'Sub-agents',
    '서브에이전트 비중': 'Sub-agent share',
    '전체 USD 대비': 'of total USD',
    '서브에이전트 사용 없음': 'No sub-agent usage',
    '비싼 세션': 'Expensive session',
    '응답 과다': 'Oversized response',
    '느린 도구': 'Slow tool',
    '반복 호출': 'Repeated calls',
    '캐시 비효율': 'Cache inefficiency',
    '고비용 모델': 'High-cost model',
    '🟢 높음': '🟢 High',
    '🟡 보통': '🟡 Medium',
    '🔴 낮음': '🔴 Low',
    '기간 내 발견된 시그널 없음': 'No signals found in this period',
    '비용·효율 시그널 없음': 'No cost or efficiency signals',
    '유형': 'Type',
    '측정값': 'Evidence',
    '세션/도구': 'Session / tool',
    '신뢰도': 'Confidence',
    '권장 조치': 'Suggested action',
    '상태': 'Status',
    '조건': 'Condition',
    '최근 발화': 'Last fired',
    '끄기': 'Disable',
    '켜기': 'Enable',
    '수정': 'Edit',
    '삭제': 'Delete',
    '데스크탑': 'Desktop',
    '웹훅': 'Webhook',
    '아직 룰이 없습니다. + 새 룰을 눌러 추가하세요.': 'No rules yet. Choose + New rule to add one.',
    '시작': 'Started',
    '소요 시간': 'Duration',
    '시간': 'Time',
    '캐시 read': 'Cache read',
    '캐시 write': 'Cache write',
    '메시지 없음': 'No messages',
    '도구 호출 없음': 'No tool calls',
    '없음': 'None',
    '지연': 'Latency',
    // empty / error states
    '아직 사용 데이터가 없습니다': 'No usage data yet',
    'Claude Code / Codex를 한 번 사용한 뒤 터미널에서 {cmd} 를 실행하거나 우측 상단 {btn} 을 누르세요.':
      'Use Claude Code or Codex once, then run {cmd} in a terminal or choose {btn} at the top right.',
    '일부 데이터를 불러오지 못했습니다: {what}': 'Some data could not be loaded: {what}',
    '다시 시도': 'Retry',
    '대시보드를 불러오지 못했습니다. token-meter serve 가 실행 중인지 확인하세요.':
      'Could not load the dashboard. Check that token-meter serve is still running.',
    '차트': 'chart',
    // interpolated
    '{n}일 누적': '{n}-day total',
    '이벤트 {n}건': '{n} events',
    '{n}건': '{n} events',
    '{n}건 발견': '{n} found',
    '현재 플랜은 최근 {shown}일까지만 표시합니다 (선택: {sel}일).': 'Your plan shows the last {shown} days only (selected: {sel}).',
    '연관 비용 {usd}': 'Associated cost {usd}',
    '최근 {days}일 중 {n}회 발화. 최대값 {max}.': 'Would have fired {n} time(s) in the last {days} days. Peak value {max}.',
    '세션 — {usd} · {n}건': 'Session — {usd} · {n} events',
    '저장 실패: {status}': 'Save failed: {status}',
    '이 룰을 삭제할까요?': 'Delete this rule?',
    '세션 로드 실패: {msg}': 'Failed to load session: {msg}',
    '드라이런 실패': 'Dry run failed',
    '일별 비용 차트': 'Daily cost chart',
    '시간대별 출력 토큰 차트': 'Output tokens by hour chart',
    '언어': 'Language',
  };

  var lang = 'en';
  try {
    var q = new URLSearchParams(location.search).get('lang');
    var saved = null;
    try { saved = localStorage.getItem('tm-lang'); } catch (e) { /* storage blocked */ }
    var pick = q || saved || (navigator.language || 'en');
    lang = /^ko/i.test(pick) ? 'ko' : 'en';
    if (q === 'ko' || q === 'en') {
      try { localStorage.setItem('tm-lang', q); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* non-browser */ }

  function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

  function t(key, vars) {
    var out = lang === 'en' && Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : key;
    if (vars) {
      out = out.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); });
    }
    return out;
  }

  function translateText(node) {
    var raw = node.nodeValue;
    if (!raw || !/\S/.test(raw)) return;
    var key = norm(raw);
    if (!Object.prototype.hasOwnProperty.call(EN, key)) return;
    var lead = /^\s*/.exec(raw)[0];
    var trail = /\s*$/.exec(raw)[0];
    node.nodeValue = lead + EN[key] + trail;
  }

  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function translateAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (v && Object.prototype.hasOwnProperty.call(EN, norm(v))) el.setAttribute(ATTRS[i], EN[norm(v)]);
    }
  }

  function applyI18n(root) {
    if (lang !== 'en' || typeof document === 'undefined') return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var n = walker.currentNode;
    while (n) {
      if (n.nodeType === 3) translateText(n);
      else translateAttrs(n);
      n = walker.nextNode();
    }
  }

  var api = { t: t, EN: EN, lang: function () { return lang; }, applyI18n: applyI18n, norm: norm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined') return;
  window.TM_I18N = api;
  window.t = t;

  document.documentElement.lang = lang;
  applyI18n(document.documentElement);
  if (lang === 'en' && typeof MutationObserver !== 'undefined') {
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var a = m.addedNodes[j];
          if (a.nodeType === 3) translateText(a);
          else if (a.nodeType === 1) { translateAttrs(a); applyI18n(a); }
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
