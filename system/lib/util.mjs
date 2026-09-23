// Small shared helpers: canonical tables, dates, text measures, file and git access.
// Nothing here reads the clock except todayLocal(), which only new/sector/init/sync may call.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

export const ATOMIC_TYPES = ['decision', 'fact', 'insight'];

// Table 4.4 order: indexes and templates use it.
export const CANON_TYPES = [
  'decision', 'rule', 'procedure', 'fact', 'insight', 'project', 'proposal', 'analysis',
  'text', 'list', 'person', 'organization', 'journal', 'sector', 'hub',
];

export const CANON_STATUSES = ['active', 'waiting', 'done', 'replaced', 'rejected'];
export const CANON_STATES = ['on', 'sleep', 'off'];
export const CANON_PRIVACY = ['github', 'local'];
export const CANON_TIERS = ['hot', 'warm', 'cold', 'archive'];

// Table 4.3 order. The first seven are also the write order of section 5.4.
export const CANON_KEYS = [
  'type', 'status', 'description', 'updated', 'created', 'aliases', 'keywords',
  'replaces', 'replaced_by', 'valid_until', 'review_on', 'pin', 'source', 'questions',
  'state', 'privacy', 'when_here', 'not_here', 'links', 'hot_max', 'cleanup',
  'sectors', 'used', 'changed', 'search_missed',
];

export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SECTOR_ID_MAX = 24;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------------------------
// Dates (YYYY-MM-DD strings, UTC arithmetic only)

export function isDate(s) {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function dateMs(s) {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`not a date: ${s}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Whole days from a to b (b - a); negative when b is earlier. */
export function daysBetween(a, b) {
  return Math.round((dateMs(b) - dateMs(a)) / DAY_MS);
}

export function addDays(date, n) {
  return new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** CLOCK. The local calendar day. Only for new, sector, init, sync and the search log. */
export function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'MM-DD' of a valid date, else the en dash. */
export function monthDay(date) {
  return isDate(date) ? date.slice(5) : '–';
}

// ---------------------------------------------------------------------------------------------
// Text measures

export function chars(s) {
  let n = 0;
  for (const _ of String(s)) n++;
  return n;
}

export function bytes(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

/** Lines of a text, ignoring one trailing newline. */
export function lineCount(s) {
  const t = String(s);
  if (t === '') return 0;
  return (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n').length;
}

/** Cuts to at most maxChars code points; a cut text ends with '…' (counted in maxChars). */
export function truncate(s, maxChars) {
  const text = String(s ?? '');
  const cps = [...text];
  if (cps.length <= maxChars) return text;
  if (maxChars <= 1) return '…'.slice(0, Math.max(0, maxChars));
  return cps.slice(0, maxChars - 1).join('').trimEnd() + '…';
}

/** Replaces {name} with vars.name; unknown names stay as they are. */
export function interpolate(template, vars = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (all, name) =>
    Object.hasOwn(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : all);
}

/** Plain code-unit comparison (never localeCompare). */
export function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uniq(items) {
  return [...new Set(items)];
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

/** 'Fixed rate' from 'fixed-rate'. */
export function humanize(name) {
  const s = String(name).replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------------------------
// Markdown code fences (CommonMark 4.5, leniently indented so fences inside list items count)

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})[ \t]*$/;

/**
 * A line-by-line fence tracker. step(line) returns {fence, inside, info}: `fence` is true for an
 * opening or closing fence line, `inside` for fence lines and the lines between them, `info` is the
 * info string of the open block ('' when none). A block closes only on the same character with at
 * least the opening length and nothing else on the line, so ``` inside a ~~~ block stays text.
 */
export function fenceTracker() {
  let open = null;
  return (line) => {
    const s = String(line);
    if (open) {
      const m = FENCE_CLOSE.exec(s);
      const info = open.info;
      if (m && m[1][0] === open.ch && m[1].length >= open.len) {
        open = null;
        return { fence: true, inside: true, info };
      }
      return { fence: false, inside: true, info };
    }
    const m = FENCE_OPEN.exec(s);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      open = { ch: m[1][0], len: m[1].length, info: m[2].trim().split(/\s+/)[0].toLowerCase() };
      return { fence: true, inside: true, info: open.info };
    }
    return { fence: false, inside: false, info: '' };
  };
}

/** Fenced blocks whose content is a query or view definition, not note text. */
export const VIEW_FENCES = new Set(['base', 'dataview', 'dataviewjs', 'query']);

/** ATX heading of level min..max: {level, text} or null. A closing '#' run needs a space before it. */
export function parseHeading(line, max = 6) {
  const m = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(String(line));
  if (!m || m[1].length > max) return null;
  const text = m[2].trim();
  return text && !/^#+$/.test(text) ? { level: m[1].length, text } : null;
}

// ---------------------------------------------------------------------------------------------
// Files

/** Reads UTF-8 text and normalizes it to LF without a BOM; reports what it removed. */
export function readText(abs) {
  return normalizeText(fs.readFileSync(abs, 'utf8'));
}

export function normalizeText(raw) {
  let text = String(raw);
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = text.includes('\r\n');
  if (crlf) text = text.replace(/\r\n/g, '\n');
  return { text, crlf, bom };
}

export function readTextIfExists(abs) {
  try {
    return readText(abs).text;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/** Writes text (NFC, LF, one trailing newline expected from the caller) only when bytes differ. */
export function writeIfChanged(abs, text) {
  const next = Buffer.from(String(text), 'utf8');
  try {
    const prev = fs.readFileSync(abs);
    if (prev.equals(next)) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, next);
  return true;
}

/** Makes a text ready to write: NFC, LF, exactly one trailing newline. */
export function finalText(text) {
  const t = String(text).normalize('NFC').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return t + '\n';
}

export function isDir(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/** Expands '~/' and resolves a path against base. */
export function resolvePath(base, p) {
  const s = String(p);
  if (s === '~' || s.startsWith('~/')) return path.join(process.env.HOME || '', s.slice(1));
  return path.resolve(base, s);
}

// ---------------------------------------------------------------------------------------------
// Git

/** Runs git in root. Throws on failure unless allowFail; never uses a shell. */
export function git(root, args, { allowFail = false, input } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    const res = {
      ok: false,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
      code: typeof err.status === 'number' ? err.status : 1,
    };
    if (allowFail) return res;
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`;
    throw new Error(`git ${args.join(' ')}: ${detail}`);
  }
}

/** True when root is the top level of a git work tree (not merely inside a parent repo). */
export function isGitRepo(root) {
  const res = git(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (!res.ok) return false;
  try {
    return fs.realpathSync(res.stdout.trim()) === fs.realpathSync(root);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// CLI helpers shared by the commands

/**
 * node:util parseArgs with strict flags. Returns {values, positionals} or null after printing
 * the problem and the usage line to stderr (the caller then returns exit code 2).
 */
export function parseCli(argv, options, usage) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: true });
  } catch (err) {
    usageError(err.message, usage);
    return null;
  }
}

export function usageError(problem, usage) {
  process.stderr.write(`memory: ${problem}\nusage: node system/memory.mjs ${usage}\n`);
}

/** Validates an optional --today value; prints a usage error and returns false when invalid. */
export function checkToday(value, usage) {
  if (value === undefined || isDate(value)) return true;
  usageError(`--today must be a real date YYYY-MM-DD, got "${value}"`, usage);
  return false;
}

/** 'a, b,c' -> ['a', 'b', 'c'] */
export function splitList(value) {
  if (value === undefined || value === null) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}
