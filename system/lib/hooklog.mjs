// The log of the agent hooks (commands/hook.mjs): one JSON line per hook run and per background
// step (autosync), in <vault>/.memory-kit/logs/hooks.jsonl. It never leaves this computer
// (.memory-kit/ is ignored by git). `doctor` and `project status` read it, and the session start
// shows the last failed sync, so a hook that fails quietly is still seen. Writing never throws:
// a hook must not fail a session because its log cannot be written.

import fs from 'node:fs';
import path from 'node:path';

export const LOG_REL = '.memory-kit/logs/hooks.jsonl';
const MAX_BYTES = 256 * 1024; // then hooks.jsonl becomes hooks.1.jsonl (one old file kept)
const MAX_TEXT = 500;

const logFile = (root) => path.join(root, ...LOG_REL.split('/'));
const clip = (s) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
};

/**
 * Appends one entry: { agent, event, ok, ms?, step?, repo?, error?, fix? }. `t` (ISO time) is
 * added. `error` and `fix` are one-line texts, clipped. Returns true when the line was written.
 */
export function logHook(root, entry, { now = new Date() } = {}) {
  try {
    const file = logFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    } catch { /* no log yet, or another process rotated it */ }
    const line = { t: now.toISOString(), ...entry };
    for (const k of ['error', 'fix', 'detail']) if (line[k] !== undefined) line[k] = clip(line[k]);
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The entries, oldest first (the rotated file first), at most `limit` newest ones. Never throws. */
export function readHookLog(root, { limit = 500 } = {}) {
  const out = [];
  const file = logFile(root);
  for (const f of [file.replace(/\.jsonl$/, '.1.jsonl'), file]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && typeof j.t === 'string') out.push(j);
      } catch { /* a torn line from two writers at once */ }
    }
  }
  return out.slice(-limit);
}

/**
 * A summary for doctor and the start brief: the last run of each event ({event: entry}), the
 * failures since `since` (ISO time, default 7 days ago), and the last sync result (ok or not).
 */
export function hookSummary(root, { now = new Date(), days = 7 } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const entries = readHookLog(root);
  const lastRun = {};
  const failures = [];
  let lastSync = null;
  for (const e of entries) {
    if (typeof e.event === 'string') lastRun[e.event] = e;
    if (e.ok === false && e.t >= since) failures.push(e);
    if (e.event === 'autosync' && e.step === 'done') lastSync = e;
    else if (e.event === 'autosync' && e.ok === false) lastSync = e;
  }
  return { lastRun, failures, lastSync, entries: entries.length };
}
