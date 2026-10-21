import { closeSync, openSync, readSync } from 'node:fs';

const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export interface LineItem {
  /** The line text without its '\n' (a trailing '\r' is kept; JSON.parse ignores it). */
  line: string;
  /** Absolute byte offset just past this line (past the '\n' when terminated). */
  end: number;
  /** False only for a final line with no trailing '\n' (possibly still being written). */
  terminated: boolean;
}

/**
 * Synchronously yields the lines of a UTF-8 file starting at byte `startOffset`,
 * with exact byte offsets, without loading the file into one string. Claude Code
 * / Codex logs can reach hundreds of MB; `readFileSync(path, 'utf-8')` throws
 * ERR_STRING_TOO_LONG past V8's string limit (~512 MB). Works on raw bytes, so
 * multi-byte characters straddling a chunk boundary are safe and offsets are
 * byte-exact (needed to resume parsing later). `chunkBytes` is a test seam.
 */
export function* readLineItems(
  filePath: string,
  startOffset = 0,
  chunkBytes = DEFAULT_CHUNK_BYTES,
): Generator<LineItem> {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pos = startOffset; // where the next read starts
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = startOffset; // file offset of carry[0]
    for (;;) {
      const n = readSync(fd, buf, 0, chunkBytes, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      for (;;) {
        const i = data.indexOf(10, from);
        if (i === -1) break;
        yield { line: data.toString('utf8', from, i), end: carryStart + i + 1, terminated: true };
        from = i + 1;
      }
      // Copy: `buf` is reused by the next read.
      carry = Buffer.from(data.subarray(from));
      carryStart += from;
    }
    if (carry.length > 0) {
      yield { line: carry.toString('utf8'), end: carryStart + carry.length, terminated: false };
    }
  } finally {
    closeSync(fd);
  }
}

/** Lines only (see readLineItems). */
export function* readLines(filePath: string, chunkBytes = DEFAULT_CHUNK_BYTES): Generator<string> {
  for (const item of readLineItems(filePath, 0, chunkBytes)) yield item.line;
}
