// The activity log: what the agents did with the memory on this computer, one JSON line per use,
// in <vault>/.memory-kit/logs/activity.jsonl. It never leaves this computer (.memory-kit/ is
// ignored by git) and answers the question "does the memory work at all?": `activity` summarizes
// it. It holds no query text and no note content: notes of local roots are only counted, never
// named. Written by start, search, remember, new, the agent hooks and the MCP server; off while
// memory.json feedback.log is false or the vault is not set up yet (the kit repository itself),
// and never by a run that must leave no trace (MEMORY_KIT_PROBE=1: doctor --probe, and the
// commands upgrade runs to verify a vault). Writing never throws: a use of
// the memory must not fail because its log cannot be written.

import fs from 'node:fs';
import path from 'node:path';
import { WORK_DIR, ensureWorkDirIgnored } from './util.mjs';

export const ACTIVITY_REL = '.memory-kit/logs/activity.jsonl';
/** What an entry records: a session start, a search, a note read, a list of recent notes, a write, an error lookup. */
export const ACTIVITY_OPS = Object.freeze(['start', 'search', 'read', 'recent', 'save', 'lookup']);
/** How the memory was reached: the CLI, an agent hook (connect --projects) or the MCP server. */
export const ACTIVITY_VIA = Object.freeze(['cli', 'hook', 'mcp']);

const MAX_BYTES = 512 * 1024; // then activity.jsonl becomes activity.1.jsonl (one old file kept)
const MAX_NOTES = 3;
const MAX_REL = 300;
const MAX_AGENT = 60;
const DAY_MS = 86400000;
// Control and bidi characters never reach the log: an MCP client names itself.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const HAS_UNSAFE = new RegExp(UNSAFE.source);

const logFile = (root) => path.join(root, ...ACTIVITY_REL.split('/'));
const oneLine = (s, max) => String(s ?? '').replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const count = (n) => (Number.isInteger(n) && n >= 0 ? n : undefined);

/** A vault-relative POSIX path that may be named in the log, else null. */
function safeRel(rel) {
  if (typeof rel !== 'string') return null;
  const text = rel.trim();
  if (!text || text.length > MAX_REL || text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.includes('\\')) return null;
  if (HAS_UNSAFE.test(text)) return null;
  return text.split('/').some((part) => part === '' || part === '.' || part === '..') ? null : text;
}

/**
 * The agent a CLI command runs for, from the marks agents leave in the environment of the
 * commands they run: CLAUDECODE (Claude Code), GEMINI_CLI (Gemini CLI), CODEX_SANDBOX (Codex).
 * null when none is there (a person in a terminal, or an agent that leaves no mark).
 */
export function agentFromEnv(env = process.env) {
  if (env.CLAUDECODE === '1') return 'claude-code';
  if (env.GEMINI_CLI === '1') return 'gemini-cli';
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return 'codex';
  return null;
}

/**
 * True when the log records: the vault is set up (memory.json "initialized": true) and does not
 * turn the log off ("feedback": {"log": false}). Takes a cfg or a vault root.
 */
export function activityOn(cfgOrRoot) {
  if (cfgOrRoot && typeof cfgOrRoot === 'object') return cfgOrRoot.initialized === true && cfgOrRoot.feedback?.log !== false;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cfgOrRoot, 'memory.json'), 'utf8').replace(/^\uFEFF/, ''));
    return raw?.initialized === true && raw?.feedback?.log !== false;
  } catch {
    return false;
  }
}

/**
 * The entry as it is written: { t, via, op, agent?, n?, local?, notes?, project? }, or null when
 * `via` or `op` is unknown. `notes` keeps at most 3 vault-relative paths of main-root notes (the
 * caller leaves local ones out and counts them in `local`); `agent` is one clipped line.
 */
export function activityEntry(entry, now = new Date()) {
  if (!entry || !ACTIVITY_VIA.includes(entry.via) || !ACTIVITY_OPS.includes(entry.op)) return null;
  const out = { t: now.toISOString(), via: entry.via, op: entry.op };
  const agent = oneLine(entry.agent, MAX_AGENT);
  if (agent) out.agent = agent;
  const n = count(entry.n);
  if (n !== undefined) out.n = n;
  const local = count(entry.local);
  if (local) out.local = local;
  const notes = (Array.isArray(entry.notes) ? entry.notes : []).map(safeRel).filter(Boolean).slice(0, MAX_NOTES);
  if (notes.length) out.notes = notes;
  if (typeof entry.project === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.project)) out.project = entry.project;
  return out;
}

/**
 * Appends one entry (see activityEntry) unless the log is off or the run is a probe. The first
 * entry of a vault makes .memory-kit/, which git must ignore first (a vault made by 0.1.0 has no
 * .gitignore line for it). Returns true when a line was written. Never throws.
 */
export function logActivity(cfgOrRoot, entry, { now = new Date(), env = process.env } = {}) {
  try {
    const root = typeof cfgOrRoot === 'string' ? cfgOrRoot : cfgOrRoot?.root;
    if (!root || env?.MEMORY_KIT_PROBE === '1' || !activityOn(cfgOrRoot)) return false;
    const line = activityEntry(entry, now);
    if (!line) return false;
    if (!fs.existsSync(path.join(root, WORK_DIR))) {
      try {
        ensureWorkDirIgnored(root);
      } catch {
        /* doctor (git.repo) warns while git does not ignore it */
      }
    }
    const file = logFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    } catch { /* no log yet, or another process rotated it */ }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The entries, oldest first (the rotated file first), at most `limit` newest ones. Never throws. */
export function readActivity(root, { limit = 20000 } = {}) {
  const out = [];
  const file = logFile(root);
  for (const f of [file.replace(/\.jsonl$/, '.1.jsonl'), file]) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j && typeof j === 'object' && typeof j.t === 'string' && Number.isFinite(Date.parse(j.t))
          && ACTIVITY_OPS.includes(j.op) && ACTIVITY_VIA.includes(j.via)) out.push(j);
      } catch { /* a torn line from two writers at once */ }
    }
  }
  return out.slice(-limit);
}

/** 'YYYY-MM-DD' of a time in this computer's time zone. */
export function localDay(time) {
  const d = new Date(time);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const zeroOps = () => Object.fromEntries(ACTIVITY_OPS.map((op) => [op, 0]));
const byCount = (a, b) => b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The summary `activity` prints: { days, entries, last, today, period, who, notes, latest }.
 * `today` and `period` count entries per op (today = this computer's calendar day of `now`);
 * `who` counts the entries of each agent and way in the period; `notes` names the notes used most
 * in the period (read, first search hit, or saved); `latest` holds the newest entries of the
 * period, newest first. `last` is the newest entry of all that is not in the future (a clock that
 * was wrong), or the newest entry when every one is.
 */
export function summarizeActivity(entries, { now = new Date(), days = 7, latest = 8, top = 5 } = {}) {
  const since = now.getTime() - days * DAY_MS;
  const today = localDay(now);
  const out = { days, entries: entries.length, last: entries.length ? entries[entries.length - 1] : null, today: zeroOps(), period: zeroOps(), who: [], notes: [], latest: [] };
  let lastSeen = null;
  const who = new Map();
  const used = new Map();
  const inPeriod = [];
  for (const e of entries) {
    const ms = Date.parse(e.t);
    if (ms > now.getTime() + 60000) continue; // a clock that was wrong: never counted as recent
    lastSeen = e;
    if (localDay(ms) === today) out.today[e.op] += 1;
    if (ms < since) continue;
    inPeriod.push(e);
    out.period[e.op] += 1;
    const key = `${e.agent ?? ''}\t${e.via}`;
    const w = who.get(key) ?? { key, agent: e.agent ?? null, via: e.via, n: 0 };
    w.n += 1;
    who.set(key, w);
    const named = e.op === 'read' || e.op === 'save' ? (e.notes ?? []) : e.op === 'search' ? (e.notes ?? []).slice(0, 1) : [];
    for (const rel of named) {
      const u = used.get(rel) ?? { key: rel, rel, n: 0 };
      u.n += 1;
      used.set(rel, u);
    }
  }
  out.who = [...who.values()].sort(byCount).map(({ agent, via, n }) => ({ agent, via, n }));
  out.notes = [...used.values()].sort(byCount).slice(0, top).map(({ rel, n }) => ({ rel, n }));
  out.latest = inPeriod.slice(-latest).reverse();
  if (lastSeen) out.last = lastSeen;
  return out;
}
