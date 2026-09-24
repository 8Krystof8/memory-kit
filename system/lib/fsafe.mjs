// Safe file operations shared by the kit: atomic replace and retries for the sharing
// violations Windows reports while an editor, antivirus or sync client holds a file
// (EPERM, EBUSY, EACCES). Nothing here reads the clock for content; temp names only.

import fs from 'node:fs';
import path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs fn, retrying on transient file-system errors with exponential backoff
 * (defaults: 10 tries, 50 ms doubling up to 1 s). Other errors are thrown at once.
 */
export function retrySync(fn, { tries = 10, delay = 50, maxDelay = 1000, codes = RETRY_CODES } = {}) {
  for (let i = 0; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= tries - 1 || !codes.has(err?.code)) throw err;
      sleepSync(Math.min(maxDelay, delay * 2 ** i));
    }
  }
}

function tempName(abs) {
  const rand = Math.random().toString(36).slice(2, 10);
  return path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${rand}`);
}

/**
 * Replaces abs with data atomically: writes a temp file in the same directory, flushes
 * it, then renames it over the target (with retries). Creates parent directories.
 * mode (for example 0o755) is applied to the result on POSIX.
 */
export function writeAtomic(abs, data, { mode } = {}) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = tempName(abs);
  const fd = fs.openSync(tmp, 'wx', mode ?? 0o666);
  try {
    try {
      fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    retrySync(() => fs.renameSync(tmp, abs));
  } catch (err) {
    // A failed write (disk full, I/O error) or rename never leaves the temp file behind.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may already be gone */
    }
    throw err;
  }
  if (mode !== undefined && process.platform !== 'win32') {
    try {
      fs.chmodSync(abs, mode);
    } catch {
      /* best effort */
    }
  }
}

/** Copies src over dest atomically (see writeAtomic). */
export function copyAtomic(src, dest, opts) {
  writeAtomic(dest, fs.readFileSync(src), opts);
}

/** fs.renameSync with retries on transient errors. */
export function renameRetry(from, to) {
  retrySync(() => fs.renameSync(from, to));
}

/** fs.unlinkSync with retries; a missing file is not an error. */
export function unlinkRetry(abs) {
  try {
    retrySync(() => fs.unlinkSync(abs));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

/** Recursive removal with the retries Node offers for EBUSY, EPERM and ENOTEMPTY. */
export function removeTree(abs) {
  fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
