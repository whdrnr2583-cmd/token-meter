// Compares src/pricing.ts PRICES with the official pricing pages.
//   npm run check:pricing                       fetch both pages (network)
//   npm run check:pricing -- --anthropic a.md --openai o.md    offline, saved copies
//   npm run check:pricing -- --only anthropic|openai           verify one vendor only (partial; says so)
// Exit codes: 0 = no differences, 1 = differences found,
//             2 = parse/fetch failure (page format changed or unreachable) — never a silent pass.
// Not part of `npm test` (network) and not shipped in the npm tarball (not in package.json "files").
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRICES, cacheWrite1hRate } from '../src/pricing.ts';

export const ANTHROPIC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
export const OPENAI_URL = 'https://developers.openai.com/api/docs/pricing.md';

export class ParseError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ParseError';
  }
}

const EPS = 1e-9;
const MIN_ROWS = 3; // a table with fewer rows than this means the page changed shape

function money(cell, where) {
  const c = cell.replace(/<sup>.*?<\/sup>/g, '').trim();
  if (c === '-' || c === '—') return null;
  const m = /^\$\s*([\d,]*\.?\d+)\b/.exec(c);
  if (!m) throw new ParseError(`${where}: 가격 셀을 읽을 수 없음 "${cell.trim()}"`);
  return Number(m[1].replace(/,/g, ''));
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
}

// Returns {header, rows} of the first markdown table (within lines) whose header contains all `required`.
function findTable(lines, required, label) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|')) continue;
    const header = splitRow(lines[i]);
    if (!required.every((r) => header.includes(r))) continue;
    if (!/^\|?\s*:?-{3,}/.test(lines[i + 1].trim())) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(splitRow(lines[j]));
    return { header, rows };
  }
  throw new ParseError(`${label}: 필요한 열(${required.join(', ')})을 가진 표를 찾지 못함`);
}

export function parseAnthropic(md) {
  const label = 'Anthropic';
  const cols = ['Base input tokens', '5m cache writes', '1h cache writes', 'Cache hits and refreshes', 'Output tokens'];
  const { header, rows } = findTable(md.split('\n'), ['Model', ...cols], label);
  const idx = Object.fromEntries(cols.map((c) => [c, header.indexOf(c)]));
  const out = new Map();
  let parsed = 0;
  for (const r of rows) {
    const raw = r[header.indexOf('Model')] ?? '';
    const name = raw.replace(/<sup>.*?<\/sup>/g, '');
    const m = /^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)/.exec(name);
    if (!m) continue;
    const where = `${label} "${name.trim()}"`;
    const vals = {
      input: money(r[idx['Base input tokens']] ?? '', where),
      cacheWrite5m: money(r[idx['5m cache writes']] ?? '', where),
      cacheWrite1h: money(r[idx['1h cache writes']] ?? '', where),
      cacheRead: money(r[idx['Cache hits and refreshes']] ?? '', where),
      output: money(r[idx['Output tokens']] ?? '', where),
    };
    for (const [k, v] of Object.entries(vals)) if (v === null) throw new ParseError(`${where}: ${k} 값 없음`);
    const key = `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`;
    const over = /over\s+([\d,]+)\s+tokens/i.exec(name);
    const entry = out.get(key) ?? {};
    if (over) entry.long = { above: Number(over[1].replace(/,/g, '')), ...vals };
    else Object.assign(entry, vals);
    out.set(key, entry);
    parsed++;
  }
  if (parsed < MIN_ROWS) throw new ParseError(`${label}: 모델 행 ${parsed}개만 읽음(최소 ${MIN_ROWS})`);
  return out;
}

export function parseOpenAI(md) {
  const label = 'OpenAI';
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^###\s+Standard pricing data\s*$/.test(l));
  if (start < 0) throw new ParseError(`${label}: "Standard pricing data" 절을 찾지 못함`);
  let end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l));
  if (end < 0) end = lines.length;
  const cols = ['Short context input', 'Short context cached input', 'Short context output'];
  const { header, rows } = findTable(lines.slice(start + 1, end), ['Model', ...cols], label);
  const idx = Object.fromEntries(cols.map((c) => [c, header.indexOf(c)]));
  const out = new Map();
  for (const r of rows) {
    const name = (r[header.indexOf('Model')] ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
    if (!name) continue;
    const where = `${label} "${name}"`;
    const input = money(r[idx['Short context input']] ?? '', where);
    const output = money(r[idx['Short context output']] ?? '', where);
    if (input === null || output === null) throw new ParseError(`${where}: 입력/출력 값 없음`);
    out.set(name, { input, cacheRead: money(r[idx['Short context cached input']] ?? '', where), output });
  }
  if (out.size < MIN_ROWS) throw new ParseError(`${label}: 모델 행 ${out.size}개만 읽음(최소 ${MIN_ROWS})`);
  return out;
}

const differs = (a, b) => b === null || b === undefined || Math.abs(a - b) > EPS;

// Returns {diffs, compared, noCounterpart}. Throws ParseError when a vendor that has rows in
// `prices` matches none of the official rows (names changed => the check would be vacuous).
export function compare(prices, anthropic, openai) {
  const diffs = [];
  const compared = [];
  const noCounterpart = [];
  const check = (model, field, ours, official) => {
    if (differs(ours, official)) diffs.push({ model, field, ours, official: official ?? null });
  };
  for (const [model, p] of Object.entries(prices)) {
    if (model.startsWith('claude-')) {
      const a = anthropic.get(model);
      if (!a || a.input === undefined) { noCounterpart.push(model); continue; }
      compared.push(model);
      check(model, 'input', p.input, a.input);
      check(model, 'output', p.output, a.output);
      check(model, 'cacheRead', p.cacheRead, a.cacheRead);
      check(model, 'cacheWrite5m', p.cacheWrite5m, a.cacheWrite5m);
      check(model, 'cacheWrite1h', cacheWrite1hRate(p), a.cacheWrite1h);
      if (p.longPrompt && !a.long) {
        diffs.push({ model, field: 'longPrompt', ours: p.longPrompt.above, official: null });
      } else if (!p.longPrompt && a.long) {
        diffs.push({ model, field: 'longPrompt', ours: null, official: a.long.above });
      } else if (p.longPrompt && a.long) {
        check(model, 'longPrompt.above', p.longPrompt.above, a.long.above);
        for (const f of ['input', 'output', 'cacheRead', 'cacheWrite5m']) check(model, `longPrompt.${f}`, p.longPrompt[f], a.long[f]);
      }
    } else {
      const o = openai.get(model);
      if (!o) { noCounterpart.push(model); continue; }
      compared.push(model);
      check(model, 'input', p.input, o.input);
      check(model, 'output', p.output, o.output);
      // Official "-" (no cached-input price) only differs if we charge something for cache reads.
      if (o.cacheRead === null) { if (p.cacheRead !== 0) diffs.push({ model, field: 'cacheRead', ours: p.cacheRead, official: null }); }
      else check(model, 'cacheRead', p.cacheRead, o.cacheRead);
    }
  }
  for (const [vendor, test] of [['Anthropic', (m) => m.startsWith('claude-')], ['OpenAI', (m) => !m.startsWith('claude-')]]) {
    const ours = Object.keys(prices).filter(test);
    if (ours.length > 0 && !compared.some(test)) {
      throw new ParseError(`${vendor}: 요율표 모델 ${ours.length}개 중 공식 표와 이름이 맞는 행이 0개(표 형식·모델명 변경 의심)`);
    }
  }
  return { diffs, compared, noCounterpart };
}

async function load(file, url) {
  if (file) return readFileSync(file, 'utf8');
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ParseError(`가져오기 실패 ${url}: ${e instanceof Error ? e.message : e}`);
  }
  if (!res.ok) throw new ParseError(`가져오기 실패 ${url}: HTTP ${res.status}`);
  return res.text();
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  // --only anthropic|openai: verify one vendor when the other page is unreachable.
  // The skipped vendor is reported as NOT verified so a partial pass is never mistaken for a full one.
  const only = arg('--only');
  if (only !== undefined && only !== 'anthropic' && only !== 'openai') {
    throw new ParseError(`--only 값은 anthropic 또는 openai (받은 값: ${only})`);
  }
  const isClaude = (m) => m.startsWith('claude-');
  const prices = only === 'anthropic' ? Object.fromEntries(Object.entries(PRICES).filter(([m]) => isClaude(m)))
    : only === 'openai' ? Object.fromEntries(Object.entries(PRICES).filter(([m]) => !isClaude(m)))
    : PRICES;
  const anthropic = only === 'openai' ? new Map() : parseAnthropic(await load(arg('--anthropic'), ANTHROPIC_URL));
  const openai = only === 'anthropic' ? new Map() : parseOpenAI(await load(arg('--openai'), OPENAI_URL));
  if (only) console.log(`부분 검증: ${only === 'anthropic' ? 'Anthropic' : 'OpenAI'} 행만 대조함. ${only === 'anthropic' ? 'OpenAI' : 'Anthropic'} 행은 검증되지 않음.`);
  const { diffs, compared, noCounterpart } = compare(prices, anthropic, openai);
  console.log(`대조한 모델 ${compared.length}개, 공식 표에 대응 행 없음 ${noCounterpart.length}개`);
  if (noCounterpart.length) console.log(`  대응 행 없음(대조 제외): ${noCounterpart.join(', ')}`);
  if (diffs.length === 0) {
    console.log('차이 0');
    return 0;
  }
  const fmt = (v) => (v === null ? '(없음)' : String(v));
  console.log(`차이 ${diffs.length}건`);
  console.log(['모델', '항목', '요율표(src/pricing.ts)', '공식'].join('\t'));
  for (const d of diffs) console.log([d.model, d.field, fmt(d.ours), fmt(d.official)].join('\t'));
  return 1;
}

// realpath: a symlinked invocation path must still run main(), not exit 0 silently.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().then(
    (code) => { process.exitCode = code; },
    (e) => {
      if (e instanceof ParseError) console.error(`파싱 실패: ${e.message}`);
      else console.error(`파싱 실패(예상 밖 오류): ${e instanceof Error ? e.stack : e}`);
      process.exitCode = 2;
    },
  );
}
