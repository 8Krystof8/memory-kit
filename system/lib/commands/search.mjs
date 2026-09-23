// `memory search`: ranked search, the accent-safe rg regex and the duplicate check
// (docs/architecture.md, sections 10.2 and 13).

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { loadVault } from '../vault.mjs';
import {
  buildIndex,
  duplicates,
  formatDuplicates,
  formatResults,
  query,
  rgRegex,
  SearchEngineError,
} from '../search.mjs';
import { isDate, todayLocal } from '../util.mjs';

export const usage =
  'search <query…> [--sector s] [--type t] [--status s|any] [--n 5] [--all] [--local] [--json] ' +
  '[--engine fts5|scan] | search --rg <query…> | ' +
  'search --duplicates "<title>" ["<description>"] [--type t]';

const OPTIONS = {
  sector: { type: 'string' },
  type: { type: 'string' },
  status: { type: 'string' },
  n: { type: 'string' },
  all: { type: 'boolean' },
  local: { type: 'boolean' },
  json: { type: 'boolean' },
  engine: { type: 'string' },
  rg: { type: 'boolean' },
  duplicates: { type: 'boolean' },
  today: { type: 'string' },
  root: { type: 'string' }, // handled by memory.mjs; accepted here in case it is passed through
  help: { type: 'boolean', short: 'h' },
};
const MAX_N = 500;

/** @returns {Promise<number>} exit code */
export async function run(argv, cfg) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
  } catch (err) {
    return usageError(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    print(usage);
    return 0;
  }
  if (values.rg && values.duplicates) return usageError('--rg and --duplicates cannot be combined');
  const words = positionals.join(' ').trim();
  if (!words) return usageError('missing query');

  const opts = searchOptions(values, cfg);
  if (typeof opts === 'string') return usageError(opts);

  try {
    if (values.rg) return await printRegex(words, cfg);
    if (values.duplicates) return await printDuplicates(positionals, opts, values, cfg);
    return await printSearch(words, opts, values, cfg);
  } catch (err) {
    if (err instanceof SearchEngineError) return usageError(err.message);
    throw err;
  }
}

// Validates flag values; returns the query options or an error message.
function searchOptions(values, cfg) {
  const opts = { all: Boolean(values.all), local: Boolean(values.local) };
  if (values.sector !== undefined) opts.sector = values.sector.trim();
  if (values.type !== undefined) {
    opts.type = canonical(cfg, 'type', values.type);
    if (!opts.type) return `unknown type "${values.type}"`;
  }
  if (values.status !== undefined) {
    opts.status = values.status === 'any' ? 'any' : canonical(cfg, 'status', values.status);
    if (!opts.status) return `unknown status "${values.status}" (or use any)`;
  }
  if (values.n !== undefined) {
    const n = /^\d+$/.test(values.n) ? Number(values.n) : NaN;
    if (!(n >= 1 && n <= MAX_N)) return `--n must be a whole number from 1 to ${MAX_N}`;
    opts.n = n;
  }
  if (values.engine !== undefined && !['auto', 'fts5', 'scan'].includes(values.engine)) {
    return `--engine must be fts5 or scan`;
  }
  if (values.today !== undefined && !isDate(values.today)) {
    return `--today must be a real date YYYY-MM-DD, got "${values.today}"`;
  }
  return opts;
}

// Accepts a localized or canonical value; null when unknown.
function canonical(cfg, kind, value) {
  if (typeof cfg?.canon !== 'function') return value;
  return cfg.canon(kind, value) ?? null;
}

async function printRegex(words, cfg) {
  const regex = await rgRegex(words, cfg);
  if (!regex) return usageError('the query has no searchable words (2 or more letters)');
  print(regex);
  return 0;
}

async function printSearch(words, opts, values, cfg) {
  const started = performance.now();
  const vault = loadVault(cfg, { roots: 'all' });
  const scope = narrowScope(vault, opts);
  if (typeof scope === 'string') return usageError(scope);

  const index = await buildIndex(vault, cfg, { engine: values.engine });
  let res;
  try {
    res = query(index, words, scope);
  } finally {
    index.close();
  }
  const secs = (performance.now() - started) / 1000;

  if (cfg?.search?.log) logSearch(cfg, values.today ?? todayLocal(), words, res);
  print(values.json ? JSON.stringify(res, null, 2) : formatResults(res, cfg, { secs }));
  return 0;
}

async function printDuplicates(positionals, opts, values, cfg) {
  const [title, ...rest] = positionals;
  const vault = loadVault(cfg, { roots: 'all' });
  const index = await buildIndex(vault, cfg, { engine: values.engine });
  let res;
  try {
    res = duplicates(index, { title, description: rest.join(' '), type: opts.type ?? null }, { local: opts.local });
  } finally {
    index.close();
  }
  print(values.json ? JSON.stringify(res, null, 2) : formatDuplicates(res, cfg));
  return 0;
}

// --sector must name a known sector. Without --sector and --all, MEMORY_SECTORS narrows the
// default scope (section 6.4); unknown ids in it are ignored.
function narrowScope(vault, opts) {
  const known = new Set();
  for (const sector of vault.sectors ?? []) known.add(sector.id);
  for (const note of vault.notes ?? []) if (note.sector) known.add(note.sector);

  if (opts.sector) {
    return known.has(opts.sector) ? opts : `unknown sector "${opts.sector}"`;
  }
  if (opts.all) return opts;
  const fromEnv = String(process.env.MEMORY_SECTORS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => known.has(id));
  return fromEnv.length > 0 ? { ...opts, sectors: fromEnv } : opts;
}

// Appends one line to the optional search log. Local notes are never named: the log is committed.
function logSearch(cfg, date, words, res) {
  const rel = cfg.files?.searchLog ?? 'system/usage/search.log';
  const file = isAbsolute(rel) ? rel : join(cfg.root, rel);
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  const top = res.results
    .filter((r) => !r.local)
    .slice(0, 3)
    .map((r) => r.rel)
    .join(',');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${date}\t${clean(words)}\t${res.total}\t${top}\n`);
  } catch (err) {
    process.stderr.write(`memory: search log not written: ${err.message}\n`);
  }
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

function usageError(message) {
  process.stderr.write(`memory: search: ${message}\nusage: node system/memory.mjs ${usage}\n`);
  return 2;
}
