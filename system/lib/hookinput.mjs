// The input side of the agent hooks (commands/hook.mjs), light enough for memory.mjs to use before
// it loads the vault config: reads the hook's JSON from stdin, reads the "projects" settings
// straight from memory.json, and tells whether a failed tool call can have an error lookup at all
// (most cannot: other tools, interrupts, short errors, sessions outside a known project), so those
// runs end without further work.
// Only node:fs and node:path here.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_INPUT = 1024 * 1024;
const STDIN_WAIT_MS = 5000;
const LOOKUP_TOOLS = new Set(['Bash', 'PowerShell']);
export const MIN_ERROR_CHARS = 20;

/** The hook input: a JSON object from stdin ({} for no input, a TTY, garbage or a silent pipe). */
export function readHookInput({ stdin = process.stdin, waitMs = STDIN_WAIT_MS } = {}) {
  if (stdin.isTTY) return Promise.resolve({});
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeAllListeners('data');
      stdin.pause();
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {});
      } catch {
        resolve({});
      }
    };
    const stop = () => {
      finish();
      stdin.destroy();
    };
    const timer = setTimeout(stop, waitMs);
    stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_INPUT) {
        chunks.length = 0;
        stop();
        return;
      }
      chunks.push(c);
    });
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/** A session id safe as a file name ('' when none). */
export const safeId = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

/** Where the session start records what it saw: <vault>/.memory-kit/capture/sessions. */
export const sessionsDir = (root) => path.join(root, '.memory-kit', 'capture', 'sessions');

/** The record of a session ({ top, sector, store, head, dirty, day, t }), or null. */
export function readSessionFile(root, sid) {
  const id = safeId(sid);
  if (!id) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(sessionsDir(root), `${id}.json`), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** memory.json "projects" of a vault as written (an object), or null when it cannot be read. */
export function rawProjects(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'));
    const p = j?.projects;
    return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  } catch {
    return null;
  }
}

/** The error text of a failed Bash/PowerShell call without its "Exit code N" line. */
export function errorBody(error) {
  return String(typeof error === 'string' ? error : '').slice(0, 20000).replace(/^\s*Exit code -?\d+[^\n]*\n?/, '').trim();
}

/**
 * { tool, text } when a PostToolUseFailure input may deserve a lookup: a Bash or PowerShell
 * call, not interrupted, with at least MIN_ERROR_CHARS of error text besides "Exit code N".
 */
export function lookupCandidate(input) {
  if (!input || !LOOKUP_TOOLS.has(input.tool_name) || input.is_interrupt === true) return null;
  const text = errorBody(input.error);
  return text.length >= MIN_ERROR_CHARS ? { tool: input.tool_name, text } : null;
}
