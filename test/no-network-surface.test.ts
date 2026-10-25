import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

/**
 * README "Privacy & security" lists every network call the code can make. This
 * test keeps that list honest: a network primitive in src/ outside the files
 * below fails the build until the README table (and this allowlist) is updated.
 */
const ALLOWED: Record<string, string> = {
  'license.ts': '`activate` / `setup` only',
  'rules.ts': 'user-configured notify.webhook action',
  'proxy.ts': 'user-run local LLM proxy (127.0.0.1 -> backend the user chose)',
  'mcp.ts': 'stdio transport only (no sockets)', // never matches; listed for clarity
};

const NETWORK =
  /\bfetch\s*\(|from\s+['"]node:(https?|net|tls|dgram|http2)['"]|require\(\s*['"](node:)?(https?|net|tls|dgram|http2)['"]|\bundici\b|XMLHttpRequest|WebSocket\b|sendBeacon/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('network primitives appear only in the allowlisted source files', () => {
  const root = join(process.cwd(), 'src');
  const offenders: string[] = [];
  for (const file of walk(root)) {
    const rel = relative(root, file);
    if (rel in ALLOWED) continue;
    const code = stripComments(readFileSync(file, 'utf8'));
    if (NETWORK.test(code)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `network use outside the documented allowlist: ${offenders.join(', ')}`);
});

test('the dashboard page loads no third-party scripts, styles, fonts or images', () => {
  const html = readFileSync(join(process.cwd(), 'public', 'index.html'), 'utf8');
  const external = [...html.matchAll(/\b(?:src|href)\s*=\s*["'](https?:)?\/\/[^"']+["']/g)]
    // plain <a href> links the user clicks are fine; subresources are not
    .filter((m) => !/<a\s[^>]*$/.test(html.slice(Math.max(0, (m.index ?? 0) - 200), m.index)));
  assert.deepEqual(external.map((m) => m[0]), []);
});
