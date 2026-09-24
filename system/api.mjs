// memory-kit JS API (api_version 1): the stable surface for other programs, the MCP server
// included. Library code only: nothing here writes to stdout or changes git settings. Only three
// calls write: inbox() (one new file), check({generate: true}) (the generated files, like
// check --generate) and search({log: true}) (one search log line). inbox() and search({log})
// date what they write with the local date unless `today` is given; nothing else reads the clock.
//
//   import { openMemory } from './system/api.mjs';
//   const memory = await openMemory('/path/to/vault');
//   const res = await memory.search('pricing decision', { n: 5 });
//   memory.close();
//
// memory.json and the language packs are read once by openMemory; every call reads the notes
// afresh, so a long-lived Memory sees new and edited notes. Errors are MemoryError {code, message}.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from './lib/check.mjs';
import { normalizeNotes } from './lib/commands/check.mjs';
import { ConfigError, loadConfig } from './lib/config.mjs';
import { serialize } from './lib/frontmatter.mjs';
import { resolveAsOfInfo, writeGenerated } from './lib/generate.mjs';
import { SearchEngineError, buildIndex, query } from './lib/search.mjs';
import { scanText } from './lib/secrets.mjs';
import { START_SURFACES, renderStartView } from './lib/startview.mjs';
import { fold } from './lib/text.mjs';
import {
  CANON_STATUSES, CANON_TYPES, addDays, chars, cmp, finalText, insidePath, interpolate, isDate,
  readText, realpathLoose, resolveExact, splitList, toPosix, todayLocal, uniq, windowsNameProblem,
} from './lib/util.mjs';
import { inLocalSectorFolder, loadVault, localFolderNotes, withoutNotes } from './lib/vault.mjs';

export const API_VERSION = 1;

/** The most characters memory.inbox() accepts in one capture. */
export const INBOX_MAX_CHARS = 20000;

const TITLE_MAX_CHARS = 200;
const SOURCE_MAX_CHARS = 500;
const PATH_MAX_CHARS = 1024;
const SEARCH_MAX_N = 500;
const INACTIVE = new Set(['replaced', 'rejected']);
const ENGINES = ['auto', 'fts5', 'scan'];
// Assembled from pieces like secrets.mjs, so this file never carries the marker itself.
const ALLOW_SECRET = 'memory-kit:' + 'allow-secret';

// English defaults of every message; packs may translate the same keys (section 4.10).
const DEFAULTS = {
  'api.closed': 'this memory is closed; open it again with openMemory()',
  'api.not_text': '{name} must be a text',
  'api.not_boolean': '{name} must be true or false',
  'api.not_list': '{name} must be a list of sector ids',
  'api.bad_integer': '{name} must be a whole number from {min} to {max}, got {value}',
  'api.bad_date': 'today must be a real date YYYY-MM-DD, got "{value}"',
  'api.bad_engine': 'engine must be auto, fts5 or scan, got "{value}"',
  'api.query_empty': 'the query is empty; give one or more words',
  'api.unknown_type': 'unknown type "{value}"; use one of: {list}',
  'api.unknown_status': 'unknown status "{value}"; use one of: {list}, or any',
  'api.unknown_sector': 'unknown sector "{value}"; sectors: {list}',
  'api.path_empty': 'the path is empty; give a path relative to the vault, such as {example}',
  'api.path_form': 'use a path relative to the vault with forward slashes, such as {example}: no absolute path, drive letter, backslash, "." or ".." part, and no character Windows forbids',
  'api.path_md': 'only markdown notes (.md) can be read',
  'api.path_hidden': '{rel} is not readable: kit code, hidden folders and git data stay closed',
  'api.not_found': 'no readable note at {rel}; find paths with search or recent',
  'api.offset_past_end': 'offset {offset} is past the end of {rel} ({total} lines)',
  'api.column_past_end': 'column {column} is past the end of line {offset} of {rel} ({n} characters)',
  'api.bad_surface': 'surface must be cli or mcp, got "{value}"',
  'api.text_empty': 'the text is empty',
  'api.too_long': '{name} has {n} characters; the limit is {max}',
  'api.secret': 'refused: the text looks like it holds a secret ({rules}); leave keys, tokens and passwords out of the memory',
  'api.write_failed': 'could not write {rel}: {detail}',
  'api.inbox_outside': 'refused: the inbox folder {dir} leads outside the vault',
};

/** An API failure: `code` is stable ('CONFIG', 'INVALID_ARGUMENT', 'INVALID_PATH', 'NOT_FOUND', 'SECRET', 'TOO_LARGE', 'ENGINE', 'WRITE_FAILED', 'CLOSED'). */
export class MemoryError extends Error {
  constructor(code, message, { key = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MemoryError';
    this.code = code;
    this.key = key;
  }
}

function say(cfg, key, vars = {}) {
  let text = null;
  try {
    text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : null;
  } catch {
    text = null;
  }
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(DEFAULTS[key] ?? key, vars);
}

function fail(cfg, code, key, vars) {
  return new MemoryError(code, say(cfg, key, vars), { key });
}

// ---------------------------------------------------------------------------------------------
// Option checks: undefined and null mean "not given"

function intOption(cfg, name, value, def, min, max) {
  if (value === undefined || value === null) return def;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw fail(cfg, 'INVALID_ARGUMENT', 'api.bad_integer', { name, min, max, value: JSON.stringify(value) ?? String(value) });
  }
  return value;
}

function boolOption(cfg, name, value, def) {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'boolean') throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_boolean', { name });
  return value;
}

function textOption(cfg, name, value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_text', { name });
  return value;
}

function todayOption(cfg, value) {
  if (value === undefined || value === null) return undefined;
  if (!isDate(value)) throw fail(cfg, 'INVALID_ARGUMENT', 'api.bad_date', { value: String(value) });
  return value;
}

/** Sector ids from an array or an 'a,b' text ([] when not given). */
function sectorsOption(cfg, value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return splitList(value);
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_list', { name: 'sectors' });
  }
  return value.map((v) => v.trim()).filter(Boolean);
}

/**
 * Sector ids a search may name: those of the main root, plus those that only local roots hold when
 * `local` (without it their names never leave the API, not even in an error message).
 */
function knownSectors(vault, local) {
  const known = new Set(vault.sectors.map((s) => s.id));
  for (const n of vault.notes) if (n.sector && (local || n.root === 'main')) known.add(n.sector);
  return [...known].sort(cmp);
}

// ---------------------------------------------------------------------------------------------
// Text cleaning for writes

// C0 controls except tab and newline, DEL, C1 controls, bidi overrides and isolates, BOM. Built from
// code points so the source stays plain ASCII.
const cp = (code) => String.fromCodePoint(code);
const CONTROL = new RegExp(`[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}]`, 'g');
const LINE_SEPARATORS = new RegExp(`[${cp(0x2028)}${cp(0x2029)}]`, 'g');

/** LF line ends, no control characters, NFC, no blank lines at the edges. */
function cleanBlock(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(LINE_SEPARATORS, '\n')
    .replace(CONTROL, '')
    .normalize('NFC')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');
}

/** One line: whitespace runs (newlines included) become one space. */
function cleanLine(text) {
  return cleanBlock(text).replace(/\s+/g, ' ').trim();
}

/** 'loyalty-card-idea' from the first words of a text (ascii, max 6 words and 48 chars). */
function slugOf(text) {
  const words = fold(text).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const word of words.slice(0, 6)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 48) break;
    slug = next;
  }
  if (!slug && words.length) slug = words[0].slice(0, 48);
  return slug || 'capture';
}

// ---------------------------------------------------------------------------------------------
// Paths for read()

/** The message key of what is wrong with a requested path, or null when its form is fine. */
function pathProblem(rel) {
  if (rel === '') return 'api.path_empty';
  if (chars(rel) > PATH_MAX_CHARS || /[\u0000-\u001f\u007f\\]/.test(rel) || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
    return 'api.path_form';
  }
  const segs = rel.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..' || windowsNameProblem(s) !== null)) return 'api.path_form';
  if (segs.some((s) => s.startsWith('.')) || segs[0].toLowerCase() === 'system' || segs.some((s) => s.toLowerCase() === 'node_modules')) {
    return 'api.path_hidden';
  }
  if (!rel.endsWith('.md')) return 'api.path_md';
  return null;
}

/** The local roots a read may look in: [{root, prefix}], prefix = the root's path from the vault + '/'. */
function localRoots(cfg) {
  return cfg.roots
    .filter((r) => r.id !== 'main' && r.exists && !r.foreign)
    .map((r) => ({ root: r, prefix: `${toPosix(path.relative(cfg.root, r.path)).normalize('NFC')}/` }));
}

/** The file of rel under rootPath when it exists with this exact spelling and stays readable. */
function locate(cfg, rootPath, rel, isMain) {
  const disk = resolveExact(rootPath, rel);
  if (disk === null) return null;
  let real;
  let realRoot;
  try {
    real = fs.realpathSync.native(path.join(rootPath, ...disk.split('/')));
    realRoot = fs.realpathSync.native(rootPath);
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  // A link may point anywhere: judge the file where it really is.
  if (!insidePath(realRoot, real)) return null;
  const realRel = toPosix(path.relative(realRoot, real)).normalize('NFC');
  if (pathProblem(realRel) !== null) return null;
  if (isMain) {
    for (const r of cfg.roots) {
      if (r.id !== 'main' && r.exists && insidePath(realpathLoose(r.path), real)) return null;
    }
    if (inLocalSectorFolder(cfg, realRel)) return null;
  }
  return real;
}

// ---------------------------------------------------------------------------------------------

/** One opened vault. Get it from openMemory(); every method is async except close(), t() and localValue(). */
class Memory {
  #cfg;
  #closed = false;

  constructor(cfg) {
    this.#cfg = cfg;
    /** { root, kitVersion, dataVersion, apiVersion, lang, mode, initialized } */
    this.info = Object.freeze({
      root: cfg.root,
      kitVersion: cfg.kitVersion,
      dataVersion: Number.isInteger(cfg.raw?.version) ? cfg.raw.version : cfg.version,
      apiVersion: API_VERSION,
      lang: cfg.lang,
      mode: cfg.mode,
      initialized: cfg.initialized === true,
    });
  }

  #live() {
    if (this.#closed) throw fail(this.#cfg, 'CLOSED', 'api.closed');
    return this.#cfg;
  }

  /** A message or label of the vault's language pack (English default; the key when unknown). */
  t(key, vars) {
    return this.#cfg.t(key, vars);
  }

  /**
   * The vault language's word for a canonical value of `kind` (type, status, state or privacy),
   * as the notes and the CLI write it: 'rozhodnuti' for the type 'decision' in a Czech vault. Any
   * other value (null, unknown) comes back as it is.
   */
  localValue(kind, value) {
    if (typeof value !== 'string' || value === '') return value;
    try {
      const word = this.#cfg.local(kind, value);
      return typeof word === 'string' && word !== '' ? word : value;
    } catch {
      return value;
    }
  }

  /**
   * The session start view: {text, stale, initialized, failed}. Pure: no git setting is touched.
   * `failed` means the view could not be built and `text` is the fallback (search protocol, rules).
   * `surface` 'mcp' gives the search rules of the memory_* tools instead of the shell commands of
   * AGENTS.md (for apps without a shell); that view is always rendered in memory.
   */
  async start({ sectors, today, surface } = {}) {
    const cfg = this.#live();
    const list = sectorsOption(cfg, sectors);
    const day = todayOption(cfg, today);
    const who = textOption(cfg, 'surface', surface) ?? 'cli';
    if (!START_SURFACES.includes(who)) throw fail(cfg, 'INVALID_ARGUMENT', 'api.bad_surface', { value: who });
    return renderStartView(cfg, { sectors: list, today: day, surface: who });
  }

  /**
   * Ranked full-text search; the QueryResult of `search --json`. Notes of local sectors are only
   * counted (localHits) unless `local`. Private content left in a local sector's main-root folder
   * (LOCAL_IN_GIT) is a local note too, but it is never listed, not even with `local`: read()
   * never opens it. `sectors` narrows the default scope like MEMORY_SECTORS (unknown ids ignored;
   * not with `sector` or `all`). With `log` and memory.json search.log on, the query is appended to
   * the search log like the CLI does.
   */
  async search(q, { sector, sectors, type, status, n = 8, all = false, local = false, engine, log = false, today } = {}) {
    const cfg = this.#live();
    if (typeof q !== 'string') throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_text', { name: 'query' });
    const words = q.trim();
    if (!words) throw fail(cfg, 'INVALID_ARGUMENT', 'api.query_empty');
    const opts = {
      all: boolOption(cfg, 'all', all, false),
      local: boolOption(cfg, 'local', local, false),
      n: intOption(cfg, 'n', n, 8, 1, SEARCH_MAX_N),
    };
    const typeText = textOption(cfg, 'type', type);
    if (typeText !== undefined) {
      opts.type = cfg.canon('type', typeText);
      if (!opts.type) throw fail(cfg, 'INVALID_ARGUMENT', 'api.unknown_type', { value: typeText, list: CANON_TYPES.join(', ') });
    }
    const statusText = textOption(cfg, 'status', status);
    if (statusText !== undefined) {
      opts.status = statusText.trim() === 'any' ? 'any' : cfg.canon('status', statusText);
      if (!opts.status) throw fail(cfg, 'INVALID_ARGUMENT', 'api.unknown_status', { value: statusText, list: CANON_STATUSES.join(', ') });
    }
    const engineText = textOption(cfg, 'engine', engine);
    if (engineText !== undefined && !ENGINES.includes(engineText)) {
      throw fail(cfg, 'INVALID_ARGUMENT', 'api.bad_engine', { value: engineText });
    }
    const sectorText = textOption(cfg, 'sector', sector)?.trim();
    const narrow = sectorsOption(cfg, sectors);
    const doLog = boolOption(cfg, 'log', log, false);
    const day = todayOption(cfg, today);

    const loaded = loadVault(cfg, { roots: 'all' });
    const known = knownSectors(loaded, opts.local);
    // loadVault marks private content left in a local sector's main-root folder as local, so
    // search only counts it; with `local` it is left out, since read() never opens it.
    const vault = opts.local ? withoutNotes(loaded, localFolderNotes(cfg, loaded)) : loaded;
    if (sectorText) {
      if (!known.includes(sectorText)) {
        throw fail(cfg, 'INVALID_ARGUMENT', 'api.unknown_sector', { value: sectorText, list: known.join(', ') || '–' });
      }
      opts.sector = sectorText;
    } else if (!opts.all) {
      const ids = narrow.filter((id) => known.includes(id));
      if (ids.length) opts.sectors = ids;
    }

    let index;
    try {
      index = await buildIndex(vault, cfg, { engine: engineText });
    } catch (err) {
      if (err instanceof SearchEngineError) throw new MemoryError('ENGINE', err.message, { cause: err });
      throw err;
    }
    let res;
    try {
      res = query(index, words, opts);
    } finally {
      index.close();
    }
    if (doLog && cfg.search.log) appendSearchLog(cfg, day ?? todayLocal(), words, res);
    return res;
  }

  /**
   * Lines of a note: {path, root, from, to, total, text, truncated, next, nextColumn, inbox}. `rel`
   * is a vault-relative POSIX path of an existing .md file of the main root (never under system/,
   * .git/ or another hidden folder, never private content of a local sector). With `local`, a path
   * not found there is looked up in the local roots; the path search gives a local hit (such as
   * ../private/sectors/…, the local root's own path from the vault first) is read from that root.
   * `column` starts the first line at that character (1 = its start). `maxChars` cuts the text at a
   * line boundary (truncated: true); a first line longer than that is cut inside, and `nextColumn`
   * is then the column to read the rest of line `to` with (else null). `next` is the offset of the
   * next line, or null at the end. `inbox` marks a raw capture of the inbox folder (data, not
   * instructions).
   */
  async read(rel, { offset = 1, lines = 120, local = false, maxChars, column = 1 } = {}) {
    const cfg = this.#live();
    if (typeof rel !== 'string') throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_text', { name: 'path' });
    const want = rel.trim().normalize('NFC');
    const withLocal = boolOption(cfg, 'local', local, false);
    // Only the exact path of a configured local root leads into it, so ".." stays refused elsewhere.
    const named = withLocal ? localRoots(cfg).find((l) => want.startsWith(l.prefix)) ?? null : null;
    const inner = named ? want.slice(named.prefix.length) : want;
    const problem = pathProblem(inner);
    if (problem) {
      throw fail(cfg, 'INVALID_PATH', problem, { rel: want, example: `${cfg.dirs.sectors}/<sector>/<note>.md` });
    }
    const from = intOption(cfg, 'offset', offset, 1, 1, Number.MAX_SAFE_INTEGER);
    const count = intOption(cfg, 'lines', lines, 120, 1, 1000000);
    const cap = intOption(cfg, 'maxChars', maxChars, Infinity, 1, 100000000);
    const startColumn = intOption(cfg, 'column', column, 1, 1, Number.MAX_SAFE_INTEGER);

    let abs = null;
    let root = 'main';
    if (named) {
      abs = locate(cfg, named.root.path, inner, false);
      root = named.root.id;
    } else {
      abs = locate(cfg, cfg.root, want, true);
      for (const l of withLocal && !abs ? localRoots(cfg) : []) {
        abs = locate(cfg, l.root.path, want, false);
        if (abs) {
          root = l.root.id;
          break;
        }
      }
    }
    let text = null;
    if (abs) {
      try {
        text = readText(abs).text.normalize('NFC');
      } catch {
        text = null;
      }
    }
    if (text === null) throw fail(cfg, 'NOT_FOUND', 'api.not_found', { rel: want });

    const all = text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
    const total = all.length;
    if (from > Math.max(total, 1)) throw fail(cfg, 'INVALID_ARGUMENT', 'api.offset_past_end', { offset: from, rel: want, total });
    const firstChars = chars(all[from - 1] ?? '');
    if (startColumn > firstChars + 1) {
      throw fail(cfg, 'INVALID_ARGUMENT', 'api.column_past_end', { column: startColumn, offset: from, rel: want, n: firstChars });
    }
    let to = Math.min(total, from + count - 1);
    let out = all.slice(from - 1, to);
    if (startColumn > 1) out[0] = [...out[0]].slice(startColumn - 1).join('');
    let truncated = false;
    let nextColumn = null;
    let used = 0;
    let keep = 0;
    for (; keep < out.length; keep++) {
      const size = chars(out[keep]) + (keep ? 1 : 0);
      if (used + size > cap) break;
      used += size;
    }
    if (keep < out.length) {
      truncated = true;
      if (keep === 0) {
        // A first line longer than the cap is cut inside; its rest starts at nextColumn.
        out = [[...out[0]].slice(0, cap).join('')];
        nextColumn = startColumn + cap;
      } else {
        out = out.slice(0, keep);
      }
      to = from + out.length - 1;
    }
    const inbox = inner.toLowerCase().startsWith(`${cfg.dirs.inbox.toLowerCase()}/`);
    return {
      path: want, root, from, to, total, text: out.join('\n'), truncated, next: to < total ? to + 1 : null, nextColumn, inbox,
    };
  }

  /**
   * Notes of the main root changed within `days` before the vault's as-of date (the same date
   * start and check use, never the clock), newest first: [{path, type, status, updated,
   * description, sector}]. Journal entries and notes of github sectors that are not off;
   * inbox, archive, hubs, manifests, export files and replaced or rejected notes are left out.
   */
  async recent({ days = 7, sector, limit = 20, today } = {}) {
    const cfg = this.#live();
    const span = intOption(cfg, 'days', days, 7, 0, 3650);
    const max = intOption(cfg, 'limit', limit, 20, 1, 500);
    const sectorText = textOption(cfg, 'sector', sector)?.trim();
    const day = todayOption(cfg, today);
    const vault = loadVault(cfg);
    if (sectorText && !vault.sectors.some((s) => s.id === sectorText)) {
      throw fail(cfg, 'INVALID_ARGUMENT', 'api.unknown_sector', { value: sectorText, list: vault.sectors.map((s) => s.id).join(', ') || '–' });
    }
    const { asOf } = resolveAsOfInfo(cfg, vault, day);
    const since = addDays(asOf, -span);
    const github = new Set(vault.sectors.filter((s) => s.state !== 'off' && s.privacy === 'github').map((s) => s.id));
    const place = (n) => (sectorText
      ? n.area === 'sector' && n.sector === sectorText && github.has(n.sector)
      : n.area === 'journal' || (n.area === 'sector' && github.has(n.sector)));
    return vault.notes
      .filter((n) => n.root === 'main' && !n.archived && !n.isManifest && !n.isExport && place(n)
        && !INACTIVE.has(n.data.status) && isDate(n.data.updated) && n.data.updated >= since)
      .sort((a, b) => cmp(b.data.updated, a.data.updated) || cmp(a.rel, b.rel))
      .slice(0, max)
      .map((n) => ({
        path: n.rel,
        type: n.data.type ?? null,
        status: n.data.status ?? null,
        updated: n.data.updated,
        description: n.data.description ?? null,
        sector: n.sector ?? null,
      }));
  }

  /**
   * Saves a raw capture as a NEW file in the inbox folder: {path}. The name is the date plus a slug
   * of the title (or the first words); an existing file is never overwritten (-2, -3… instead).
   * Control characters are removed; text with a secret, or longer than INBOX_MAX_CHARS, is refused.
   */
  async inbox(text, { title, source, today } = {}) {
    const cfg = this.#live();
    if (typeof text !== 'string') throw fail(cfg, 'INVALID_ARGUMENT', 'api.not_text', { name: 'text' });
    const body = cleanBlock(text);
    if (!body) throw fail(cfg, 'INVALID_ARGUMENT', 'api.text_empty');
    const n = chars(body);
    if (n > INBOX_MAX_CHARS) throw fail(cfg, 'TOO_LARGE', 'api.too_long', { name: 'text', n, max: INBOX_MAX_CHARS });
    const head = cleanLine(textOption(cfg, 'title', title) ?? '');
    if (chars(head) > TITLE_MAX_CHARS) throw fail(cfg, 'TOO_LARGE', 'api.too_long', { name: 'title', n: chars(head), max: TITLE_MAX_CHARS });
    const from = cleanLine(textOption(cfg, 'source', source) ?? '');
    if (chars(from) > SOURCE_MAX_CHARS) throw fail(cfg, 'TOO_LARGE', 'api.too_long', { name: 'source', n: chars(from), max: SOURCE_MAX_CHARS });
    const day = todayOption(cfg, today) ?? todayLocal();

    const fm = { [cfg.keys.created]: day };
    if (from) fm[cfg.keys.source] = from;
    const content = finalText(`${serialize(fm, { order: cfg.keyOrder })}${head ? `# ${head}\n\n` : ''}${body}`);
    // The allow marker may not hide anything here: the text comes from outside.
    const found = scanText(content.split(ALLOW_SECRET).join(''));
    if (found.length) throw fail(cfg, 'SECRET', 'api.secret', { rules: uniq(found.map((f) => f.rule)).join(', ') });

    const dir = cfg.dirs.inbox;
    const dirAbs = path.join(cfg.root, ...dir.split('/'));
    try {
      fs.mkdirSync(dirAbs, { recursive: true });
    } catch (err) {
      throw fail(cfg, 'WRITE_FAILED', 'api.write_failed', { rel: `${dir}/`, detail: err.message });
    }
    if (!insidePath(realpathLoose(cfg.root), realpathLoose(dirAbs))) {
      throw fail(cfg, 'WRITE_FAILED', 'api.inbox_outside', { dir: `${dir}/` });
    }
    const slug = slugOf(head || body);
    for (let i = 1; i <= 1000; i++) {
      const name = `${day}-${slug}${i > 1 ? `-${i}` : ''}.md`;
      try {
        fs.writeFileSync(path.join(dirAbs, name), content, { flag: 'wx' });
        return { path: `${dir}/${name}` };
      } catch (err) {
        if (err?.code === 'EEXIST') continue;
        throw fail(cfg, 'WRITE_FAILED', 'api.write_failed', { rel: `${dir}/${name}`, detail: err.message });
      }
    }
    throw fail(cfg, 'WRITE_FAILED', 'api.write_failed', { rel: `${dir}/${day}-${slug}.md`, detail: 'EEXIST' });
  }

  /**
   * Runs the checks: the object of `check --json` ({mode, errors, warnings, notes}, plus
   * `generated` and `normalized` with generate). `generate` first normalizes notes (LF, NFC, no
   * BOM) and rewrites the generated files, exactly like check --generate.
   */
  async check({ strict = true, generate = false, today } = {}) {
    const cfg = this.#live();
    const mode = boolOption(cfg, 'strict', strict, true) ? 'strict' : 'lenient';
    const regenerate = boolOption(cfg, 'generate', generate, false);
    const day = todayOption(cfg, today);
    let vault = loadVault(cfg, { roots: 'all' });
    let generated = null;
    let normalized = [];
    if (regenerate) {
      normalized = normalizeNotes(vault);
      if (normalized.length) vault = loadVault(cfg, { roots: 'all' });
      try {
        const res = await writeGenerated(cfg, vault, { today: day });
        generated = { written: res.written.length, removed: res.removed.length };
      } catch (err) {
        // runChecks reports it as GEN_BUDGET or GEN_FAILED.
        generated = { error: err?.message ?? String(err) };
      }
    }
    const result = await runChecks(cfg, vault, { strict: mode === 'strict', today: day });
    const out = { mode, errors: result.errors, warnings: result.warnings, notes: result.notes };
    if (generated) out.generated = generated;
    if (normalized.length) out.normalized = normalized;
    return out;
  }

  /** Ends the use of this Memory; later calls throw MemoryError CLOSED. Nothing stays open. */
  close() {
    this.#closed = true;
  }
}

/** Appends one line to the search log; local notes are never named (the log is committed). */
function appendSearchLog(cfg, date, words, res) {
  const rel = cfg.files?.searchLog ?? 'system/usage/search.log';
  const file = path.isAbsolute(rel) ? rel : path.join(cfg.root, ...rel.split('/'));
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  const top = res.results.filter((r) => !r.local).slice(0, 3).map((r) => r.rel).join(',');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${date}\t${clean(words)}\t${res.total}\t${top}\n`);
  } catch {
    /* the log is a convenience; a search never fails because of it */
  }
}

/**
 * Opens a vault: loads memory.json and the language packs (lang overrides memory.json "lang").
 * Throws MemoryError CONFIG when they cannot be loaded. The vault is not read yet.
 */
export async function openMemory(root, { lang } = {}) {
  if (!(typeof root === 'string' && root.trim() !== '') && !(root instanceof URL)) {
    throw new MemoryError('INVALID_ARGUMENT', 'root must be the path of a vault');
  }
  if (lang !== undefined && lang !== null && typeof lang !== 'string') {
    throw new MemoryError('INVALID_ARGUMENT', 'lang must be a language code such as en or cs');
  }
  const abs = path.resolve(root instanceof URL ? fileURLToPath(root) : root);
  let cfg;
  try {
    cfg = loadConfig(abs, lang ? { lang } : {});
  } catch (err) {
    if (err instanceof ConfigError) throw new MemoryError('CONFIG', err.message, { cause: err });
    throw err;
  }
  return new Memory(cfg);
}
