// Offline tests for scripts/check-pricing.mjs (parser + comparison). The script's
// network fetch is not exercised here; `npm run check:pricing` does that by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod: any = await import('../scripts/check-pricing.mjs');

const ANTHROPIC = `
## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Opus 4.1 ([retired](https://x.example/a)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Mythos 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |

Next section.
`;

const OPENAI = `
### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5 | $1.25 | $0.125 | - | $10.00 | - | - | - | - |
| gpt-4.1 | $2.00 | $0.50 | - | $8.00 | - | - | - | - |

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5 | $0.625 | $0.0625 | - | $5.00 | - | - | - | - |
`;

const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75 },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125,
    longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625 },
  },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25 }, // not in the sample page
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0 },
};

function run(prices: any, anthropicMd = ANTHROPIC, openaiMd = OPENAI) {
  return mod.compare(prices, mod.parseAnthropic(anthropicMd), mod.parseOpenAI(openaiMd));
}

test('check-pricing: identical tables yield zero diffs and list uncovered models', () => {
  const r = run(PRICES);
  assert.deepEqual(r.diffs, []);
  assert.ok(r.compared.includes('claude-haiku-5-5'));
  assert.ok(r.compared.includes('gpt-5.5'));
  assert.deepEqual(r.noCounterpart, ['claude-opus-4-8']);
});

test('check-pricing: each differing field is reported with table and official value', () => {
  const prices: any = JSON.parse(JSON.stringify(PRICES));
  prices['claude-opus-5-5'].cacheRead = 0.5;
  prices['claude-haiku-5-5'].longPrompt.output = 5;
  prices['gpt-5'].output = 12;
  const r = run(prices);
  const key = (d: any) => `${d.model}:${d.field}:${d.ours}:${d.official}`;
  assert.deepEqual(r.diffs.map(key).sort(), [
    'claude-haiku-5-5:longPrompt.output:5:2.5',
    'claude-opus-5-5:cacheRead:0.5:0.2',
    'gpt-5:output:12:10',
  ]);
});

test('check-pricing: 1h cache write is derived as 2x input and compared', () => {
  const prices: any = JSON.parse(JSON.stringify(PRICES));
  prices['claude-sonnet-4-6'].cacheWrite1h = 5;
  const r = run(prices);
  assert.deepEqual(r.diffs.map((d: any) => `${d.model}:${d.field}`), ['claude-sonnet-4-6:cacheWrite1h']);
});

test('check-pricing: OpenAI numbers come from the Standard table, not Batch', () => {
  const o = mod.parseOpenAI(OPENAI);
  assert.equal(o.get('gpt-5').input, 1.25);
  assert.equal(o.get('gpt-5.5').output, 30);
  assert.equal(o.get('gpt-4.1').cacheRead, 0.5);
});

test('check-pricing: a missing official cached-input price counts as a diff when ours is non-zero', () => {
  const md = OPENAI.replace('| gpt-5 | $1.25 | $0.125 |', '| gpt-5 | $1.25 | - |');
  const r = run(PRICES, ANTHROPIC, md);
  assert.deepEqual(r.diffs.map((d: any) => `${d.model}:${d.field}:${d.official}`), ['gpt-5:cacheRead:null']);
});

test('check-pricing: changed page format throws ParseError (never a silent pass)', () => {
  assert.throws(() => mod.parseAnthropic('# nothing here'), (e: any) => e instanceof mod.ParseError);
  assert.throws(() => mod.parseAnthropic(ANTHROPIC.replace('Base input tokens', 'Input')), (e: any) => e instanceof mod.ParseError);
  assert.throws(() => mod.parseAnthropic(ANTHROPIC.replace('$4 / MTok', 'free')), (e: any) => e instanceof mod.ParseError);
  assert.throws(() => mod.parseOpenAI('# nothing here'), (e: any) => e instanceof mod.ParseError);
  assert.throws(() => mod.parseOpenAI(OPENAI.replace('Short context output', 'Output')), (e: any) => e instanceof mod.ParseError);
  assert.throws(() => mod.parseOpenAI(OPENAI.replace('### Standard pricing data', '### Standard')), (e: any) => e instanceof mod.ParseError);
});

test('check-pricing: zero overlap with our table throws ParseError', () => {
  assert.throws(() => run({ 'unknown-model': PRICES['gpt-5'] }), (e: any) => e instanceof mod.ParseError);
});
