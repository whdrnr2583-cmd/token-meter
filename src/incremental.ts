import { closeSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { IngestResume, IngestStateRow } from './db.js';

/**
 * Decides whether a changed session file can be parsed from where the previous
 * scan stopped, and builds the integrity fingerprint stored for the next scan.
 *
 * Resuming is only safe when the bytes already consumed are provably unchanged
 * (append-only growth). Anything else — shrink, same-size rewrite, replaced
 * file, edited head/tail, state from an older version, state too large — takes
 * the full re-parse path, which is always correct (writes are idempotent).
 *
 * Set TOKEN_METER_FULL_REPARSE=1 to force the full path everywhere.
 */

const FINGERPRINT_BYTES = 4096;
/** Carried state above this size is dropped (=> that file is fully re-parsed next time). */
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export function fullReparseForced(): boolean {
  const v = process.env.TOKEN_METER_FULL_REPARSE;
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

function sha1Range(fd: number, start: number, len: number): string | null {
  if (len <= 0) return createHash('sha1').update('').digest('hex');
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got);
    if (n === 0) return null; // file shorter than expected
    got += n;
  }
  return createHash('sha1').update(buf).digest('hex');
}

export function fingerprint(filePath: string, offset: number): { headHash: string; tailHash: string } | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = sha1Range(fd, 0, Math.min(FINGERPRINT_BYTES, offset));
    const tailLen = Math.min(FINGERPRINT_BYTES, offset);
    const tail = sha1Range(fd, offset - tailLen, tailLen);
    return head && tail ? { headHash: head, tailHash: tail } : null;
  } finally {
    closeSync(fd);
  }
}

export function buildResume(
  filePath: string,
  offset: number,
  state: unknown | null,
  ino: number | bigint,
): IngestResume | undefined {
  if (state === null || offset <= 0) return undefined;
  const stateJson = JSON.stringify(state);
  if (stateJson.length > MAX_STATE_BYTES) return undefined;
  const fp = fingerprint(filePath, offset);
  if (!fp) return undefined;
  return { offset, stateJson, headHash: fp.headHash, tailHash: fp.tailHash, ino: String(ino) };
}

export interface ResumePlan {
  startOffset: number;
  state: unknown;
}

/** null => parse the whole file. */
export function planResume(
  filePath: string,
  prior: IngestStateRow | undefined,
  st: { size: number; ino: number | bigint },
  force: boolean,
): ResumePlan | null {
  if (force || fullReparseForced() || !prior) return null;
  if (!prior.state_json || !prior.head_hash || !prior.tail_hash) return null;
  if (prior.last_offset <= 0 || prior.last_offset > prior.size) return null;
  if (st.size <= prior.size) return null; // shrank, or rewritten at the same size
  if (prior.ino && Number(st.ino) !== 0 && String(st.ino) !== prior.ino) return null;
  const fp = fingerprint(filePath, prior.last_offset);
  if (!fp || fp.headHash !== prior.head_hash || fp.tailHash !== prior.tail_hash) return null;
  let state: unknown;
  try {
    state = JSON.parse(prior.state_json);
  } catch {
    return null;
  }
  return { startOffset: prior.last_offset, state };
}
