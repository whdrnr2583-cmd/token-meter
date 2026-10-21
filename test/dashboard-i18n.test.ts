import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const PUBLIC = join(process.cwd(), 'public');
const read = (f: string) => readFileSync(join(PUBLIC, f), 'utf8');

function loadI18n(): { EN: Record<string, string>; t: (k: string, v?: Record<string, unknown>) => string; norm: (s: string) => string } {
  const sandbox: { module: { exports: Record<string, unknown> } } = { module: { exports: {} } };
  vm.runInNewContext(read('i18n.js'), sandbox);
  return sandbox.module.exports as never;
}

const HANGUL = /[가-힣]/;

// Every maximal run of text that contains Hangul and is not broken by a quote,
// backtick or angle bracket: covers HTML text nodes, attribute values, and JS
// string/template literals alike. Comments are stripped first.
function hangulRuns(src: string): string[] {
  const noComments = src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return noComments.match(/[^<>'"`\n]*[\uAC00-\uD7A3][^<>'"`\n]*/g) ?? [];
}

function htmlStrings(html: string): string[] {
  // Collapse whitespace first: a text node wrapped over several source lines is
  // one translation key (i18n.js normalises the same way).
  return hangulRuns(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/\s+/g, ' '));
}

function appStrings(js: string): string[] {
  return hangulRuns(js);
}

test('every Korean string in the dashboard has an English translation', () => {
  const { EN, norm } = loadI18n();
  const missing = new Set<string>();
  for (const raw of [...htmlStrings(read('index.html')), ...appStrings(read('app.js'))]) {
    const key = norm(raw);
    if (!key || !HANGUL.test(key)) continue;
    if (!(key in EN)) missing.add(key);
  }
  assert.deepEqual([...missing], []);
});

test('t() substitutes placeholders and falls back to the source text for unknown keys', () => {
  const { t } = loadI18n();
  // vm sandbox has no window/navigator -> default language is English
  assert.equal(t('{n}일 누적', { n: 30 }), '30-day total');
  assert.equal(t('없는 키 {x}', { x: 1 }), '없는 키 1');
});

test('dashboard HTML keeps accessibility basics: lang, skip link, labelled canvases/dialogs/tabs, live regions', () => {
  const html = read('index.html');
  assert.match(html, /<html lang="/);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /<canvas id="chart-daily"[^>]*role="img"[^>]*aria-label=/);
  assert.match(html, /<canvas id="chart-hourly"[^>]*role="img"[^>]*aria-label=/);
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="load-error" role="alert"/);
  assert.match(html, /id="empty-state" role="status"/);
  assert.match(html, /<dialog id="session-dialog"[^>]*aria-labelledby=/);
  assert.match(html, /<dialog id="rule-dialog"[^>]*aria-labelledby=/);
  assert.match(html, /name="viewport"/);
});

test('session rows are keyboard reachable (a real button inside the row) and the page does not prompt for notifications on load', () => {
  const js = read('app.js');
  assert.match(js, /class="link-btn"/);
  // requestPermission must only be reachable from submitRule, not from the poller
  const poller = js.slice(js.indexOf('async function pollDesktopNotifications'), js.indexOf("$('#rule-new')"));
  assert.doesNotMatch(poller, /requestPermission/);
});
