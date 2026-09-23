// Golden-question evaluation of search (docs/architecture.md, sections 7.11 and 15.1).
// Every question runs through the real search with all: true, status: 'any', n = 3; a question is
// a hit when one of its expected file NAMES is among the top 3 results. Questions of category
// 'absent' (the answer is not in memory) are scored separately and never count toward hit@3.
// Deterministic: no clock, no randomness; output order follows the golden file.

import fs from 'node:fs';
import path from 'node:path';
import { loadVault } from './vault.mjs';
import { buildIndex, query } from './search.mjs';

export const CATEGORIES = ['extraction', 'multi-session', 'temporal', 'knowledge-update', 'absent'];
export const TOP_N = 3;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A golden file that cannot be read or does not follow the format. */
export class EvalError extends Error {
  code = 'EVAL';
}

// ---------------------------------------------------------------------------------------------
// Golden file

/** Absolute path of a golden file given absolute or relative to the vault root. */
export function resolveGoldenPath(cfg, goldenPath) {
  const p = goldenPath ?? cfg.eval?.golden ?? cfg.files?.golden ?? 'system/tests/golden.json';
  return path.isAbsolute(p) ? p : path.resolve(cfg.root, p);
}

/** Reads and validates a golden file. Throws EvalError with the file and the offending entry. */
export function readGolden(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new EvalError(`golden file not found: ${file}${err.code === 'ENOENT' ? '' : ` (${err.code})`}`);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new EvalError(`golden file ${file} is not valid JSON: ${err.message}`);
  }
  return validateGolden(data, file);
}

/** Checks the golden format and returns the normalized questions. */
export function validateGolden(data, file = 'golden file') {
  const fail = (msg) => {
    throw new EvalError(`${file}: ${msg}`);
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('top level must be an object');
  if (data.version !== 1) fail(`"version" must be 1, got ${JSON.stringify(data.version)}`);
  if (!Array.isArray(data.questions)) fail('"questions" must be an array');

  const seen = new Set();
  return data.questions.map((raw, i) => {
    const where = `question ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where} must be an object`);
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!ID_RE.test(id)) fail(`${where} needs an "id" (letters, digits, '-', '_', '.')`);
    if (seen.has(id)) fail(`${where}: duplicate id "${id}"`);
    seen.add(id);
    const label = `question "${id}"`;
    if (typeof raw.q !== 'string' || raw.q.trim() === '') fail(`${label} needs a non-empty "q"`);
    if (!CATEGORIES.includes(raw.category)) {
      fail(`${label}: "category" must be one of ${CATEGORIES.join(', ')}, got ${JSON.stringify(raw.category)}`);
    }
    if (!Array.isArray(raw.expect) || raw.expect.some((e) => typeof e !== 'string' || e.trim() === '')) {
      fail(`${label}: "expect" must be an array of file names`);
    }
    const expect = raw.expect.map(noteName);
    if (raw.category === 'absent' && expect.length) fail(`${label}: category absent needs "expect": []`);
    if (raw.category !== 'absent' && !expect.length) fail(`${label}: "expect" needs at least one file name`);
    const sector = raw.sector ?? null;
    if (sector !== null && (typeof sector !== 'string' || sector.trim() === '')) {
      fail(`${label}: "sector" must be a sector id or null`);
    }
    return { id, q: raw.q.trim(), expect, category: raw.category, sector: sector && sector.trim() };
  });
}

// "sectors/work/pricing.md" or "Pricing.md" -> "pricing": golden files name notes, not paths.
function noteName(s) {
  const base = String(s).trim().split('/').pop();
  return (base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base).toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Scoring

function round4(x) {
  const r = Math.round(x * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function runQuestion(index, question) {
  const opts = { all: true, status: 'any', n: TOP_N, local: true }; // the owner's own benchmark
  if (question.sector) opts.sector = question.sector;
  const res = query(index, question.q, opts);
  const got = res.results.slice(0, TOP_N).map((r) => String(r.name));
  const top = res.results.length ? res.results[0].score : null;
  const hit = question.expect.some((name) => got.some((g) => g.toLowerCase() === name));
  return { got, top, hit };
}

/**
 * Scores already-answered questions. Exported for tests: the absent rule needs the other
 * categories' top scores, so scoring is a separate pure step.
 * answered: [{id, q, expect, category, got, top, hit}]
 */
export function score(answered) {
  const scored = answered.filter((a) => a.category !== 'absent');
  const absent = answered.filter((a) => a.category === 'absent');

  const byCategory = {};
  for (const cat of CATEGORIES.slice(0, -1)) {
    const list = scored.filter((a) => a.category === cat);
    if (!list.length) continue;
    const hits = list.filter((a) => a.hit).length;
    byCategory[cat] = { n: list.length, hits, hit3: round4(hits / list.length) };
  }

  // An absent question is answered well when search finds nothing, or nothing that ranks like a
  // real answer: its top score is below the median top score of the answerable questions. With
  // no answerable questions there is no yardstick, so only "no results" counts.
  const threshold = median(scored.map((a) => a.top ?? 0));
  const absentOk = (a) => a.top === null || (threshold !== null && a.top < threshold);

  const details = answered.map((a) => ({
    id: a.id,
    category: a.category,
    ok: a.category === 'absent' ? absentOk(a) : a.hit,
    top: a.top,
    got: a.got,
  }));
  const misses = answered
    .filter((a, i) => !details[i].ok)
    .map((a) => ({ id: a.id, q: a.q, expect: a.expect, got: a.got }));

  const hits = scored.filter((a) => a.hit).length;
  const total = scored.length;
  return {
    hit3: total ? round4(hits / total) : 1,
    total,
    hits,
    byCategory,
    misses,
    absent: { n: absent.length, ok: absent.filter(absentOk).length },
    threshold: threshold === null ? null : round4(threshold),
    details,
  };
}

// ---------------------------------------------------------------------------------------------
// API

/**
 * Runs the golden questions of `goldenPath` (absolute, or relative to the vault root) against a
 * fresh index of the whole vault: archive, inbox and existing local roots included.
 * @returns {Promise<{hit3, total, hits, byCategory, misses, absent, engine, notes, threshold, details}>}
 */
export async function runEval(cfg, goldenPath, { engine = 'auto' } = {}) {
  const questions = readGolden(resolveGoldenPath(cfg, goldenPath));
  if (!questions.length) {
    return { ...score([]), engine: null, notes: 0 };
  }
  const vault = loadVault(cfg, { roots: 'all' });
  const index = await buildIndex(vault, cfg, { engine });
  try {
    const answered = questions.map((q) => ({ ...q, ...runQuestion(index, q) }));
    return { ...score(answered), engine: index.engine, notes: index.size };
  } finally {
    index.close();
  }
}
