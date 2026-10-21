import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/**
 * Synchronously yields the lines of a UTF-8 text file without loading the whole
 * file into one string. Claude Code / Codex session logs can reach hundreds of
 * MB; `readFileSync(path, 'utf-8')` throws ERR_STRING_TOO_LONG past V8's string
 * limit (~512 MB) and doubles peak memory well before that. Lines are split on
 * '\n' only (a trailing '\r' is left for JSON.parse to ignore as whitespace),
 * multi-byte characters straddling a chunk boundary are decoded correctly, and
 * the final line is yielded even without a trailing newline.
 *
 * `chunkBytes` is a test seam; production callers use the default.
 */
export function* readLines(filePath: string, chunkBytes = DEFAULT_CHUNK_BYTES): Generator<string> {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const text = carry + decoder.write(buf.subarray(0, n));
      const parts = text.split('\n');
      carry = parts.pop() ?? '';
      for (const p of parts) yield p;
    }
    carry += decoder.end();
    if (carry) yield carry;
  } finally {
    closeSync(fd);
  }
}
