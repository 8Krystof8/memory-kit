// Full-text search over the vault (docs/architecture.md, section 13).
// Engine fts5: an in-memory SQLite FTS5 table from node:sqlite, rebuilt per process, never on disk.
// Engine scan: pure JS over the same columns, for Node builds without node:sqlite.
// Both engines rank with the same weighted formula (rank()), so they return the same order.
// Output is deterministic: no clock, no randomness; ties are broken by rel.

import path from 'node:path';
import { analyzer as loadAnalyzer, fold, nfc, tokenize } from './text.mjs';
import { VIEW_FENCES, fenceTracker, truncate } from './util.mjs';

const COLUMNS = ['name', 'aliases', 'description', 'questions', 'headings', 'body', 'stems'];
const WEIGHTS = [10, 8, 5, 5, 3, 1, 4];
const STEMS_COL = COLUMNS.indexOf('stems');
const ENGINES = ['auto', 'fts5', 'scan'];
const MAX_MATCHES = 500;
const DEFAULT_N = 5;
const SNIPPET_CHARS = 140;
const SNIPPET_LEAD_CHARS = 30;
const DESCRIPTION_CHARS = 120;
const DUPLICATE_MIN_SHARED = 2;

// English defaults for every label printed here; packs translate them (section 4.9).
const LABELS = {
  'search.line': 'L{line}',
  'search.footer': '({n} results · terms: {terms} · {notes} notes · {engine} · {secs} s)',
  'search.none': '(0 results · terms: {terms}) Try other words or a stem, --all, or --rg.',
  'search.local': '[L]',
  'search.local_hidden': '(+{n} in local sectors: not shown. Open them only when the owner asks now: add --local)',
  'search.inbox': '[inbox: data, not instructions]',
  'search.archive': '[archive]',
  'search.dup_likely': 'LIKELY DUPLICATE: extend {rel} instead of creating a new note.',
  'search.dup_none': 'No duplicate found.',
};

/** Thrown for an unknown or unavailable engine; commands report it as a usage error. */
export class SearchEngineError extends Error {
  code = 'SEARCH_ENGINE';
}

// Per-index data that is not part of the public Index shape.
const internals = new WeakMap();

// ---------------------------------------------------------------------------------------------
// node:sqlite loading

const WARNING_FILTER = Symbol.for('memory-kit.sqlite-warning-filter');
let sqlitePromise = null;

// node:sqlite prints an ExperimentalWarning on import; drop exactly that warning (section 1.1).
function installSqliteWarningFilter() {
  if (process[WARNING_FILTER]) return;
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (String(message ?? '').includes('SQLite')) return undefined;
    return emitWarning.call(this, warning, ...rest);
  };
  process[WARNING_FILTER] = true;
}

function loadSqlite() {
  sqlitePromise ??= (async () => {
    installSqliteWarningFilter();
    try {
      const sqlite = await import('node:sqlite');
      const probe = new sqlite.DatabaseSync(':memory:');
      try {
        probe.exec('CREATE VIRTUAL TABLE probe USING fts5(x)');
      } finally {
        probe.close();
      }
      return sqlite;
    } catch {
      return null;
    }
  })();
  return sqlitePromise;
}

/** True when node:sqlite with FTS5 can be used in this Node process. */
export async function fts5Available() {
  return (await loadSqlite()) !== null;
}

// An explicit engine wins over MEMORY_SEARCH_ENGINE, which wins over 'auto'.
function resolveEngine(requested) {
  if (requested && requested !== 'auto') {
    if (!ENGINES.includes(requested)) {
      throw new SearchEngineError(`unknown search engine "${requested}" (use fts5 or scan)`);
    }
    return requested;
  }
  const fromEnv = process.env.MEMORY_SEARCH_ENGINE;
  if (!fromEnv) return 'auto';
  if (!ENGINES.includes(fromEnv)) {
    throw new SearchEngineError(
      `MEMORY_SEARCH_ENGINE="${fromEnv}" is not a search engine (use fts5 or scan)`,
    );
  }
  return fromEnv;
}

// ---------------------------------------------------------------------------------------------
// Index

/**
 * Builds a search index over every note of the vault (filters apply at query time).
 * @param {object} vault from loadVault (any roots option; local notes carry local: true)
 * @param {object} cfg from loadConfig
 * @param {{engine?: 'auto'|'fts5'|'scan'}} [options]
 */
export async function buildIndex(vault, cfg, { engine = 'auto' } = {}) {
  const config = cfg ?? vault?.cfg;
  const choice = resolveEngine(engine);
  const analyzer = await loadAnalyzer(config);
  const notes = [...(vault?.notes ?? [])];
  const rows = notes.map((note) => noteColumns(note, analyzer));

  let sqlite = null;
  if (choice !== 'scan') {
    sqlite = await loadSqlite();
    if (!sqlite && choice === 'fts5') {
      throw new SearchEngineError(
        'search engine fts5 is not available: node:sqlite with FTS5 did not load ' +
          '(needs Node >= 22.13); use --engine scan',
      );
    }
  }
  const impl = sqlite ? ftsEngine(sqlite, rows) : scanEngine(rows);

  const index = {
    engine: sqlite ? 'fts5' : 'scan',
    notes,
    size: notes.length,
    analyzer,
    cfg: config,
    close() {
      impl.close();
    },
  };
  internals.set(index, {
    impl,
    states: sectorStates(vault),
    stems: rows.map((cols) => new Set(cols[STEMS_COL].split(' ').filter(Boolean))),
    nameTokens: notes.map((note) => new Set(tokenize(fold(note.name ?? '')))),
  });
  return index;
}

function sectorStates(vault) {
  const states = new Map();
  const sectors = vault?.sectorById instanceof Map ? vault.sectorById.values() : vault?.sectors;
  for (const sector of sectors ?? []) states.set(sector.id, sector.state);
  return states;
}

// The seven indexed columns of one note, all folded (section 13.2).
function noteColumns(note, analyzer) {
  const data = note.data ?? {};
  const name = String(note.name ?? '').replace(/-/g, ' ');
  const title = str(note.title);
  const description = str(data.description);
  const names = [title, ...list(data.aliases), ...list(data.keywords)];
  const headings = (note.headings ?? []).map((h) => str(h?.text));
  const metadata = [name, ...names, description, ...headings].join('\n');
  return [
    fold(name),
    fold(names.join('\n')),
    fold(description),
    fold(list(data.questions).join('\n')),
    fold(headings.join('\n')),
    fold(withoutViewBlocks(note.body ?? note.text ?? '')),
    analyzer.stems(metadata).join(' '),
  ];
}

// Query and view definitions (```base, ```dataview) are not note text: they neither match nor
// become snippets. Other code blocks stay searchable (commands in procedures).
function withoutViewBlocks(text) {
  const step = fenceTracker();
  return String(text).split('\n').map((line) => {
    const f = step(line);
    return f.inside && VIEW_FENCES.has(f.info) ? '' : line;
  }).join('\n');
}

function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

function list(value) {
  if (Array.isArray(value)) return value.map(str);
  return value === null || value === undefined || value === '' ? [] : [str(value)];
}

// ---------------------------------------------------------------------------------------------
// Engines. Both answer one question per query term: how often does it occur in each column of
// each note? Text columns match when a word starts with the term's prefix, the stems column when
// a stem starts with the term's stem (13.3). Ranking is shared (rank() below), so both engines
// order results the same way.

// Engine fts5: SQLite tokenizes and indexes the columns; the fts5vocab 'instance' table returns
// every occurrence of the terms in a prefix range.
function ftsEngine(sqlite, rows) {
  const db = new sqlite.DatabaseSync(':memory:');
  let open = true;
  const placeholders = COLUMNS.map(() => '?').join(', ');
  try {
    db.exec(
      `CREATE VIRTUAL TABLE notes USING fts5(${COLUMNS.join(', ')}, ` +
        "tokenize = 'unicode61 remove_diacritics 2')",
    );
    db.exec('CREATE VIRTUAL TABLE notes_terms USING fts5vocab(notes, instance)');
    const insert = db.prepare(
      `INSERT INTO notes(rowid, ${COLUMNS.join(', ')}) VALUES (?, ${placeholders})`,
    );
    db.exec('BEGIN');
    rows.forEach((cols, pos) => insert.run(pos, ...cols));
    db.exec('COMMIT');
  } catch (err) {
    db.close();
    throw err;
  }
  const lookup = (op) =>
    db.prepare(
      'SELECT doc, col, COUNT(*) AS tf FROM notes_terms ' +
        `WHERE term >= ? AND term < ? AND col ${op} 'stems' GROUP BY doc, col`,
    );
  const textLookup = lookup('<>');
  const stemsLookup = lookup('=');

  function collect(statement, prefix, tf) {
    // SQLite's unicode61 folds the final sigma, which toLowerCase() keeps.
    const key = prefix.replace(/ς/g, 'σ');
    for (const row of statement.all(key, `${key}\u{10FFFF}`)) {
      addFrequency(tf, Number(row.doc), COLUMNS.indexOf(row.col), Number(row.tf));
    }
  }

  return {
    frequencies(term) {
      const tf = new Map();
      if ([...term.prefix].length >= 2) collect(textLookup, term.prefix, tf);
      if ([...term.stem].length >= 2) collect(stemsLookup, term.stem, tf);
      return tf;
    },
    close() {
      if (open) db.close();
      open = false;
    },
  };
}

// Engine scan (13.6): pure JS, a sorted vocabulary of folded tokens with postings.
function scanEngine(rows) {
  const postings = new Map(); // token -> flat [pos, col, count, pos, col, count, ...]
  rows.forEach((cols, pos) => {
    cols.forEach((text, col) => {
      const counts = new Map();
      for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const [token, count] of counts) {
        let list = postings.get(token);
        if (!list) postings.set(token, (list = []));
        list.push(pos, col, count);
      }
    });
  });
  const vocabulary = [...postings.keys()].sort(compareStrings);

  // Calls visit(pos, col, count) for every token that starts with prefix.
  function eachPosting(prefix, visit) {
    for (let i = lowerBound(vocabulary, prefix); i < vocabulary.length; i++) {
      const token = vocabulary[i];
      if (!token.startsWith(prefix)) break;
      const list = postings.get(token);
      for (let k = 0; k < list.length; k += 3) visit(list[k], list[k + 1], list[k + 2]);
    }
  }

  return {
    frequencies(term) {
      const tf = new Map();
      if ([...term.prefix].length >= 2) {
        eachPosting(term.prefix, (pos, col, n) => {
          if (col !== STEMS_COL) addFrequency(tf, pos, col, n);
        });
      }
      if ([...term.stem].length >= 2) {
        eachPosting(term.stem, (pos, col, n) => {
          if (col === STEMS_COL) addFrequency(tf, pos, col, n);
        });
      }
      return tf;
    },
    close() {},
  };
}

function addFrequency(tf, pos, col, count) {
  if (col < 0) return;
  let cols = tf.get(pos);
  if (!cols) tf.set(pos, (cols = new Array(COLUMNS.length).fill(0)));
  cols[col] += count;
}

// Score = coverage² × sum over terms and matching columns of weight * (1 + ln(1 + tf)) *
// ln(1 + N / df), where df counts the notes the term matches and coverage is the share of the
// query's terms the note contains. Without the coverage factor a short prefix that one note has in
// its name outranks the note that holds every word of the question. No length normalization: a
// note whose name, aliases or description carry the words outranks short notes that merely mention
// them. Ties go by rel.
function rank(impl, terms, notes) {
  const scores = new Map();
  const covered = new Map();
  for (const term of terms) {
    const tf = impl.frequencies(term);
    if (tf.size === 0) continue;
    const idf = Math.log(1 + notes.length / tf.size);
    for (const [pos, cols] of tf) {
      let score = 0;
      cols.forEach((count, col) => {
        if (count > 0) score += WEIGHTS[col] * (1 + Math.log(1 + count)) * idf;
      });
      scores.set(pos, (scores.get(pos) ?? 0) + score);
      covered.set(pos, (covered.get(pos) ?? 0) + 1);
    }
  }
  const total = Math.max(1, terms.length);
  const byRel = (a, b) => compareStrings(notes[a.pos].rel, notes[b.pos].rel) || a.pos - b.pos;
  return [...scores]
    .map(([pos, score]) => ({ pos, score: score * (covered.get(pos) / total) ** 2 }))
    .sort((a, b) => b.score - a.score || byRel(a, b));
}

function lowerBound(sorted, key) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function compareStrings(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Query

/**
 * Searches the index. Scope and filters (13.1) apply after matching; the first `n` are returned.
 * @param {object} index from buildIndex
 * @param {string} q the query words
 * @param {{sector?: string, sectors?: string[], type?: string, status?: string, n?: number,
 *          all?: boolean, local?: boolean}} [opts] canonical type/status; status 'any' disables the
 *          status filter; `sectors` narrows the default scope like several `sector`s
 *          (MEMORY_SECTORS); notes of local sectors are only counted (localHits) unless `local`
 */
export function query(index, q, opts = {}) {
  return runQuery(index, q, opts ?? {}, null).result;
}

function runQuery(index, q, opts, extraFilter) {
  const own = internalsOf(index);
  const terms = uniqueTerms(index.analyzer.queryTerms(String(q ?? '')));
  const inScope = scopeFilter(own.states, opts);
  const inQuery = index.notes.map((note) => inScope(note) && (!extraFilter || extraFilter(note)));
  // Local notes stay out of the results unless asked for: an agent may not read them on its own.
  const eligible = index.notes.map((note, pos) => inQuery[pos] && (opts.local || !note.local));
  const ranked = rank(own.impl, terms, index.notes);
  const localHits = opts.local ? 0 : ranked.filter((m) => inQuery[m.pos] && index.notes[m.pos].local).length;
  const matches = ranked.filter((m) => eligible[m.pos]).slice(0, MAX_MATCHES);
  const n = resultCount(opts.n, index.cfg);
  const result = {
    query: String(q ?? ''),
    terms: [...new Set(terms.map((t) => `${t.prefix}*`))],
    total: matches.length,
    results: matches.slice(0, n).map((m) => toResult(index.notes[m.pos], m.score, terms, index.cfg)),
    engine: index.engine,
    notes: eligible.filter(Boolean).length,
    localHits,
  };
  return { result, matches: matches.slice(0, n), terms };
}

// "práci práce" gives the same term twice; count it once.
function uniqueTerms(terms) {
  const seen = new Set();
  return terms.filter((t) => {
    const key = `${t.stem}\u0000${t.prefix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function internalsOf(index) {
  const own = internals.get(index);
  if (!own) throw new TypeError('search: not an index from buildIndex()');
  return own;
}

function resultCount(n, cfg) {
  const value = Number(n ?? cfg?.search?.n ?? DEFAULT_N);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, MAX_MATCHES) : DEFAULT_N;
}

// Section 13.1. Sector notes follow their sector's state; a sector without a manifest counts as on.
function scopeFilter(states, opts) {
  const sectors = new Set([opts.sector, ...(opts.sectors ?? [])].filter(Boolean));
  const stateOf = (id) => states.get(id) ?? 'on';
  return (note) => {
    const data = note.data ?? {};
    if (opts.type && data.type !== opts.type) return false;
    if (!opts.status) {
      if (data.status === 'replaced') return false;
    } else if (opts.status !== 'any' && data.status !== opts.status) {
      return false;
    }
    if (sectors.size > 0) {
      if (!sectors.has(note.sector)) return false;
      if (opts.all) return true;
      if (note.area === 'inbox') return false;
      return !note.archived || stateOf(note.sector) === 'off';
    }
    if (opts.all) return true;
    if (note.archived || note.area === 'inbox' || note.area === 'archive') return false;
    if (note.area === 'journal' || note.area === 'root') return true;
    return note.area === 'sector' && stateOf(note.sector) === 'on';
  };
}

function toResult(note, score, terms, cfg) {
  const data = note.data ?? {};
  const { snippet, line } = snippetFor(note, terms);
  return {
    rel: note.rel,
    // Where the file really is, relative to the vault root (a local note lives in the local root).
    path: note.local && cfg?.root && note.path ? relPath(cfg.root, note.path) : note.rel,
    root: note.root ?? 'main',
    local: Boolean(note.local),
    name: note.name,
    sector: note.sector ?? null,
    type: data.type ?? null,
    status: data.status ?? null,
    updated: data.updated === null || data.updated === undefined ? null : String(data.updated),
    description: str(data.description),
    snippet,
    line,
    score: round4(score),
    inbox: note.area === 'inbox',
    archived: Boolean(note.archived),
  };
}

function relPath(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function round4(x) {
  const r = Math.round(x * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

// ---------------------------------------------------------------------------------------------
// Snippet (section 13.4)

const WORD = /[\p{L}\p{N}]+/gu;

// The first line with the most distinct terms. The H1 title is skipped (it repeats the file name)
// and a heading loses a tie to a text line, which says more.
function snippetFor(note, terms) {
  const lines = String(note.body ?? '').split('\n');
  const first = note.fm?.bodyStartLine ?? 1;
  let best = null;
  const step = fenceTracker();
  lines.forEach((raw, i) => {
    const f = step(raw);
    if (f.fence || (f.inside && VIEW_FENCES.has(f.info))) return;
    const text = nfc(raw).trim();
    if (/^#\s/.test(text)) return;
    const hit = lineHits(text, terms);
    if (hit.count === 0) return;
    const heading = text.startsWith('#');
    if (!best || hit.count > best.count || (hit.count === best.count && best.heading && !heading)) {
      best = { ...hit, heading, text, line: first + i };
    }
  });
  if (best) return { snippet: cut(best.text, best.at), line: best.line };
  return leadSnippet(note, lines, first);
}

// Distinct terms whose prefix (or stem) starts a word of the line, and the first hit offset.
function lineHits(text, terms) {
  const found = new Set();
  let at = -1;
  for (const m of text.matchAll(WORD)) {
    const word = fold(m[0]);
    terms.forEach((term, k) => {
      if (word.startsWith(term.prefix) || (term.stem.length >= 2 && word.startsWith(term.stem))) {
        found.add(k);
        if (at < 0) at = m.index;
      }
    });
  }
  return { count: found.size, at };
}

// Cuts a line to SNIPPET_CHARS code points around a hit, marking cuts with '…'.
function cut(text, at = 0) {
  const cps = [...text];
  if (cps.length <= SNIPPET_CHARS) return text;
  const hit = [...text.slice(0, Math.max(0, at))].length;
  let start = Math.max(0, hit - SNIPPET_LEAD_CHARS);
  const end = Math.min(cps.length, start + SNIPPET_CHARS);
  start = Math.max(0, end - SNIPPET_CHARS);
  const head = start > 0;
  const tail = end < cps.length;
  const inner = cps.slice(start + (head ? 1 : 0), end - (tail ? 1 : 0)).join('');
  return `${head ? '…' : ''}${inner}${tail ? '…' : ''}`;
}

function leadSnippet(note, lines, first) {
  const lead = str(note.lead?.[0]).trim();
  if (!lead) return { snippet: '', line: 0 };
  const i = lines.findIndex((raw) => raw.replace(/^\s*>\s?/, '').trim() === lead);
  return { snippet: cut(nfc(lead)), line: i >= 0 ? first + i : 0 };
}

// ---------------------------------------------------------------------------------------------
// rg regex and duplicates

/** The accent-safe regex for `rg -i` (section 13.5); '' when the query has no usable words. */
export async function rgRegex(q, cfg) {
  return (await loadAnalyzer(cfg)).rgRegex(String(q ?? ''));
}

/**
 * Looks for notes that a new note would duplicate (section 13.7). Inbox items are never
 * candidates: filing them into notes is the expected workflow.
 * @param {object} index from buildIndex
 * @param {{title?: string, description?: string, type?: string}} note canonical type
 * @param {{n?: number, local?: boolean}} [options] local: also compare with notes of local sectors
 */
export function duplicates(index, note = {}, { n = 5, local = false } = {}) {
  const { title = '', description = '', type = null } = note;
  const own = internalsOf(index);
  const q = [str(title), str(description)].filter(Boolean).join(' ');
  const { result, matches, terms } = runQuery(
    index,
    q,
    { all: true, status: 'any', n, local },
    (note) => note.area !== 'inbox',
  );
  const candidates = matches.map((m, i) => {
    const shared = terms
      .map((t) => t.stem)
      .filter((stem, k, all) => all.indexOf(stem) === k)
      .filter((stem) => own.stems[m.pos].has(stem) || own.nameTokens[m.pos].has(stem));
    const r = result.results[i];
    return { rel: r.rel, name: r.name, type: r.type, score: r.score, shared };
  });
  const best = candidates.find((c) => !type || c.type === type) ?? null;
  const duplicate = best !== null && best.shared.length >= DUPLICATE_MIN_SHARED;
  return {
    candidates,
    verdict: duplicate ? 'duplicate' : 'none',
    best: duplicate ? best.rel : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Human output (section 10.2)

/** One line per result (+ an optional snippet line), then the footer. No trailing newline. */
export function formatResults(res, cfg, { secs } = {}) {
  const lines = [];
  res.results.forEach((r, i) => {
    const markers = [
      r.local && label(cfg, 'search.local'),
      r.inbox && label(cfg, 'search.inbox'),
      r.archived && label(cfg, 'search.archive'),
    ].filter(Boolean);
    const fields = [
      [...markers, r.path ?? r.rel].join(' '),
      localValue(cfg, 'type', r.type),
      localValue(cfg, 'status', r.status),
      r.updated || '–',
      oneLine(r.description) ? truncate(oneLine(r.description), DESCRIPTION_CHARS) : '–',
    ];
    lines.push(`${i + 1} ${fields.join(' · ')}`);
    if (r.snippet) {
      lines.push(`  ${label(cfg, 'search.line', { line: r.line })}: ${oneLine(r.snippet)}`);
    }
  });
  const terms = res.terms.join(' ');
  if (res.localHits > 0) lines.push(label(cfg, 'search.local_hidden', { n: res.localHits }));
  lines.push(
    res.results.length === 0
      ? label(cfg, 'search.none', { terms })
      : label(cfg, 'search.footer', {
          n: res.total,
          terms,
          notes: res.notes,
          engine: res.engine,
          secs: typeof secs === 'number' && Number.isFinite(secs) ? secs.toFixed(2) : '–',
        }),
  );
  return lines.join('\n');
}

/** Up to 5 candidate lines, then the verdict line. No trailing newline. */
export function formatDuplicates(res, cfg) {
  const lines = res.candidates.slice(0, 5).map((c) => {
    const shared = `shared: ${c.shared.join(', ') || '–'}`;
    return [c.rel, localValue(cfg, 'type', c.type), shared, c.score.toFixed(2)].join(' · ');
  });
  lines.push(
    res.verdict === 'duplicate'
      ? label(cfg, 'search.dup_likely', { rel: res.best })
      : label(cfg, 'search.dup_none'),
  );
  return lines.join('\n');
}

function oneLine(s) {
  return str(s).replace(/\s+/g, ' ').trim();
}

// Localized type or status for display; unknown values are shown as they are.
function localValue(cfg, kind, value) {
  if (!value) return '–';
  try {
    const local = typeof cfg?.local === 'function' ? cfg.local(kind, value) : null;
    return local ? String(local) : String(value);
  } catch {
    return String(value);
  }
}

function label(cfg, key, vars = {}) {
  let text = null;
  try {
    text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : null;
  } catch {
    text = null;
  }
  if (typeof text !== 'string' || text === '' || text === key) {
    text = interpolate(LABELS[key] ?? key, vars);
  }
  return text;
}

function interpolate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}
