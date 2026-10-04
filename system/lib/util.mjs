// Small shared helpers: canonical tables, dates, text measures, file and git access, and the
// portability rules (home folder, Windows names, letter case, NFC, reparse points).
// Nothing here reads the clock except todayLocal(), which only new/sector/init/sync may call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { renameRetry, writeAtomic } from './fsafe.mjs';

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

/**
 * Replaces a file atomically (fsafe.writeAtomic) and keeps the permission bits of the file it
 * replaces, so a rewrite never changes a mode git records. Creates parent folders. On Windows a
 * mode only carries the read-only flag, which must not be copied onto the temporary file.
 */
export function replaceFile(abs, data) {
  let mode;
  if (process.platform !== 'win32') {
    try {
      mode = fs.statSync(abs).mode & 0o777;
    } catch {
      /* a new file gets the default mode */
    }
  }
  writeAtomic(abs, data, mode === undefined ? {} : { mode });
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
  replaceFile(abs, next);
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

// ---------------------------------------------------------------------------------------------
// Paths across operating systems

/** The path module of a platform: path.win32 for 'win32', path.posix for any other. */
export function pathFor(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The user's home folder as Node reports it: HOME on macOS and Linux, USERPROFILE (then the
 * profile folder) on Windows, where cmd, PowerShell and most apps do not set HOME at all.
 */
export function homeDir() {
  return os.homedir();
}

const TILDE = /^~(?:[\\/]|$)/;

/**
 * '~', '~/rest' or '~\rest' as an absolute path under home; null for any other path.
 * The one expansion used by memory.json readers (resolvePath) and by init, which writes '~/…'.
 */
export function expandHome(p, { home, pathMod = path } = {}) {
  const s = String(p);
  if (!TILDE.test(s)) return null;
  return pathMod.resolve(home ?? homeDir(), s.slice(2));
}

/** Expands a leading '~' (expandHome) or resolves p against base with path.resolve. */
export function resolvePath(base, p, { home, pathMod = path } = {}) {
  return expandHome(p, { home, pathMod }) ?? pathMod.resolve(base, String(p));
}

/**
 * True when p is absolute only on another operating system, so it cannot name a folder here:
 * a drive letter ('D:/x', 'D:x'), a UNC path or a leading backslash on macOS and Linux; a
 * leading single slash or backslash ('/home/x', '\x') on Windows, where it would silently mean
 * the root of the current drive.
 */
export function isForeignAbsolute(p, platform = process.platform) {
  const s = String(p);
  if (platform === 'win32') return /^[\\/](?![\\/])/.test(s);
  return /^[A-Za-z]:/.test(s) || s.startsWith('\\');
}

/** A path compared the way the platform's file system compares names (letter case, NFC). */
function foldPath(p, platform) {
  if (platform === 'darwin') return p.normalize('NFC').toLowerCase();
  if (platform === 'win32') return p.toLowerCase();
  return p;
}

/**
 * True when target is base itself or lies under it. Letter case is ignored on Windows and macOS
 * (their usual file systems ignore it), and on macOS NFC and NFD spellings are equal too.
 */
export function insidePath(base, target, { platform = process.platform, pathMod = pathFor(platform) } = {}) {
  const rel = pathMod.relative(foldPath(String(base), platform), foldPath(String(target), platform));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${pathMod.sep}`) && !pathMod.isAbsolute(rel));
}

/**
 * The real path of p when it exists; otherwise the real path of its nearest existing ancestor
 * plus the rest. Symlinks, junctions, subst drives and 8.3 names then compare equal.
 */
export function realpathLoose(p) {
  let cur = path.resolve(String(p));
  const rest = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(String(p));
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// Device names Windows reserves in every folder, with or without an extension (NUL.txt is NUL).
// Git for Windows refuses to check them out (core.protectNTFS), so they must never be committed.
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;
// Characters Windows forbids in names; a backslash is a separator there.
const WINDOWS_BAD_CHARS = /[<>:"|?*\\\u0000-\u001f]/;

/** True for con, prn, aux, nul, com1-9, lpt1-9, conin$ and conout$, any case, any extension. */
export function isReservedName(segment) {
  const stem = String(segment).split('.')[0].replace(/ +$/, '');
  return RESERVED_NAMES.test(stem);
}

/**
 * Why a file or folder name cannot exist on Windows: 'reserved' (a device name), 'char' (a
 * forbidden character) or 'end' (a trailing dot or space, which Windows drops); null when fine.
 */
export function windowsNameProblem(segment) {
  const s = String(segment);
  if (isReservedName(s)) return 'reserved';
  if (WINDOWS_BAD_CHARS.test(s)) return 'char';
  if (/[. ]$/.test(s)) return 'end';
  return null;
}

// Files the operating system drops into folders by itself (thumbnails, folder settings).
const OS_JUNK = new Set(['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', '.ds_store', 'icon\r']);

/** True for desktop.ini, Thumbs.db, ehthumbs.db, .DS_Store and the macOS 'Icon\r' file. */
export function isOsJunk(name) {
  return OS_JUNK.has(String(name).toLowerCase());
}

/**
 * 'dir', 'file', 'link' or 'other' for a directory entry. Windows marks every reparse point
 * (junctions, but also deduplicated or cloud files) as a link in readdir, so a link is confirmed
 * with lstat, which reports only real symlinks and junctions, before it is skipped.
 */
export function direntKind(dirAbs, dirent, { lstat = fs.lstatSync } = {}) {
  if (dirent.isSymbolicLink()) {
    try {
      const st = lstat(path.join(dirAbs, dirent.name));
      if (st.isSymbolicLink()) return 'link';
      return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    } catch {
      return 'other';
    }
  }
  return dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other';
}

/** Names in a folder ([] when unreadable), cached per folder when a Map is given. */
function dirNames(abs, cache) {
  if (cache?.has(abs)) return cache.get(abs);
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    names = [];
  }
  cache?.set(abs, names);
  return names;
}

function findPath(root, rel, same, cache) {
  let disk = '';
  for (const seg of String(rel).split('/')) {
    if (!seg) return null;
    const names = dirNames(disk ? path.join(root, ...disk.split('/')) : root, cache);
    const hit = names.includes(seg) ? seg : names.find((n) => same(n, seg));
    if (hit === undefined) return null;
    disk = disk ? `${disk}/${hit}` : hit;
  }
  return disk || null;
}

const nfc = (s) => s.normalize('NFC');

/**
 * The on-disk spelling of rel under root when every segment exists with exactly that name, else
 * null. NFC and NFD spellings match (macOS writes NFD names); letter case must match, so on
 * Windows and macOS a file named State.md never passes for state.md, as on Linux and in git.
 */
export function resolveExact(root, rel, cache) {
  return findPath(root, rel, (a, b) => nfc(a) === nfc(b), cache);
}

/** True when rel exists under root with exactly this letter case (see resolveExact). */
export function existsExact(root, rel, cache) {
  return resolveExact(root, rel, cache) !== null;
}

/** Like resolveExact, but letter case is ignored: finds State.md for state.md on any system. */
export function resolveCaseless(root, rel, cache) {
  return findPath(root, rel, (a, b) => nfc(a).toLowerCase() === nfc(b).toLowerCase(), cache);
}

// ---------------------------------------------------------------------------------------------
// Git

/**
 * Runs git in root. Throws on failure unless allowFail; never uses a shell and never opens a
 * console window on Windows. env holds variables merged over process.env.
 */
export function git(root, args, { allowFail = false, input, env } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input,
      env: env ? { ...process.env, ...env } : undefined,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
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

/**
 * Where root stands in git: 'top' (the top level of a work tree), 'nested' (inside one), 'none'
 * (no repository) or 'error' (root has a .git entry but git fails: git missing, safe.directory).
 * Asks git for the way up (--show-cdup, empty at the top) instead of comparing paths, which
 * differ in letter case, 8.3 names or subst drives on Windows and through symlinks on macOS.
 */
export function gitRepoState(root) {
  const res = git(root, ['rev-parse', '--is-inside-work-tree', '--show-cdup'], { allowFail: true });
  if (res.ok) {
    // 'true' then the way up ('' at the top); a .git folder or a bare repository prints 'false'.
    const [inside, cdup = ''] = res.stdout.split(/\r?\n/);
    if (inside.trim() !== 'true') return { state: 'none', detail: '' };
    return { state: cdup.trim() === '' ? 'top' : 'nested', detail: '' };
  }
  let dotGit = false;
  try {
    fs.lstatSync(path.join(root, '.git'));
    dotGit = true;
  } catch {
    /* no .git entry */
  }
  return { state: dotGit ? 'error' : 'none', detail: res.stderr.trim() };
}

/** True when root is the top level of a git work tree (not merely inside a parent repo). */
export function isGitRepo(root) {
  return gitRepoState(root).state === 'top';
}

/**
 * The kit's per-computer folder in a vault: logs, session records (with the paths of code
 * repositories), upgrade and connect backups (copies of agent settings). It never belongs in git.
 */
export const WORK_DIR = '.memory-kit';

/**
 * Whether git keeps WORK_DIR out of the vault's repository: null outside a work tree (or when git
 * fails), else { ignored, tracked: [paths under it that git tracks already] }.
 */
export function workDirGit(root) {
  const probe = git(root, ['check-ignore', '-q', '--no-index', `${WORK_DIR}/probe`], { allowFail: true });
  if (!probe.ok && probe.code !== 1) return null;
  const tracked = git(root, ['ls-files', '-z', '--', WORK_DIR], { allowFail: true });
  return { ignored: probe.ok, tracked: tracked.ok ? tracked.stdout.split('\0').filter(Boolean) : [] };
}

/**
 * Keeps WORK_DIR out of git: when git does not ignore it yet (a vault made by 0.1.0 has no
 * .gitignore line for it, and .git/info/exclude of one clone does not travel), the line is
 * appended to this clone's .git/info/exclude; the owner's .gitignore is never changed. True when
 * the line was written. Throws only when the exclude file cannot be written.
 */
export function ensureWorkDirIgnored(root) {
  const state = workDirGit(root);
  if (!state || state.ignored) return false;
  const where = git(root, ['rev-parse', '--git-path', 'info/exclude'], { allowFail: true });
  if (!where.ok || !where.stdout.trim()) return false;
  const abs = path.resolve(root, where.stdout.trim());
  let last = null;
  try {
    const buf = fs.readFileSync(abs);
    last = buf.length ? buf[buf.length - 1] : null;
  } catch {
    /* no exclude file yet */
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Appended, so the lines already there keep their bytes.
  fs.appendFileSync(abs, `${last !== null && last !== 0x0a ? '\n' : ''}${WORK_DIR}/\n`);
  return true;
}

/** True when abs names a file system entry (a dangling link counts). */
function entryExists(abs) {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stages a move done outside git: the old paths and the tracked files that arrived at their new
 * place, in one git add, so the index gets the whole move or nothing (never the deletions
 * alone). A tracked file already deleted before the move stays a staged deletion; git add
 * would refuse the whole list if it named that file at its new place. Literal pathspecs: a
 * file name may contain * or [. -f: git mv keeps a tracked file tracked even where an ignore
 * rule matches its new place.
 */
function stageMove(root, fromRel, toRel, tracked) {
  const moved = tracked
    .map((rel) => (rel === fromRel ? toRel : `${toRel}${rel.slice(fromRel.length)}`))
    .filter((rel) => entryExists(path.join(root, ...rel.split('/'))));
  const specs = [fromRel, ...moved];
  return git(root, ['--literal-pathspecs', 'add', '-A', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    allowFail: true, input: `${specs.join('\0')}\0`,
  }).ok;
}

/**
 * Moves fromRel to toRel inside root (POSIX rels). With useGit the move goes through git mv, so
 * git sees a rename; when git mv fails (a file held open on Windows, a tracked file already
 * deleted, git missing) the folder is renamed with retries and the files git tracked are staged
 * at their new place. Returns 'git', 'rename', or 'unstaged' when the folder moved but git could
 * not stage it (another git program holds the index): the index is then untouched and
 * `git add -A` stages the move. The caller checks that toRel does not exist yet.
 */
export function movePath(root, fromRel, toRel, { useGit = false } = {}) {
  const from = path.join(root, ...fromRel.split('/'));
  const to = path.join(root, ...toRel.split('/'));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let tracked = [];
  if (useGit) {
    if (git(root, ['mv', '--', fromRel, toRel], { allowFail: true }).ok) return 'git';
    const listed = git(root, ['ls-files', '-z', '--', fromRel], { allowFail: true });
    tracked = listed.ok ? listed.stdout.split('\0').filter(Boolean) : [];
  }
  renameRetry(from, to);
  if (tracked.length && !stageMove(root, fromRel, toRel, tracked)) return 'unstaged';
  return 'rename';
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
