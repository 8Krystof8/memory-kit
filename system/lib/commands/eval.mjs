// `eval`: runs the golden questions through search and reports hit@3
// (docs/architecture.md, sections 10.5 and 15.1). Exit 1 when hit@3 is below the minimum.

import { EvalError, runEval } from '../eval.mjs';
import { SearchEngineError } from '../search.mjs';
import { parseCli, usageError } from '../util.mjs';

export const usage = 'eval [--file path] [--min 0.9] [--engine fts5|scan] [--json]';

// English defaults; packs may translate the same keys (section 4.10).
const DEFAULTS = {
  'eval.summary': 'hit@3 {hit3} ({hits}/{total})',
  'eval.category': '{category} {hits}/{n}',
  'eval.miss': 'miss {id} "{q}" expected {expect} got {got}',
  'eval.none': 'no questions',
  'eval.below': 'eval: hit@3 {hit3} is below the minimum {min}',
};

function say(cfg, key, vars) {
  const text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}

const names = (list) => (list.length ? list.join(', ') : '–');

/** The human report: the summary line, then one line per miss. */
export function formatEval(res, cfg) {
  const parts = [say(cfg, 'eval.summary', { hit3: res.hit3.toFixed(2), hits: res.hits, total: res.total })];
  for (const [category, c] of Object.entries(res.byCategory)) {
    parts.push(say(cfg, 'eval.category', { category, hits: c.hits, n: c.n }));
  }
  if (res.absent.n) parts.push(say(cfg, 'eval.category', { category: 'absent', hits: res.absent.ok, n: res.absent.n }));
  const lines = [parts.join(' · ')];
  for (const m of res.misses) {
    lines.push(say(cfg, 'eval.miss', { id: m.id, q: m.q, expect: names(m.expect), got: names(m.got) }));
  }
  return lines.join('\n');
}

function parseMin(value, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  return /^\s*(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)\s*$/.test(String(value)) && n >= 0 && n <= 1 ? n : null;
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, {
    file: { type: 'string' },
    min: { type: 'string' },
    engine: { type: 'string' },
    json: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length) {
    usageError(`unexpected argument "${positionals[0]}"`, usage);
    return 2;
  }
  const min = parseMin(values.min, cfg.eval?.min ?? 0.9);
  if (min === null) {
    usageError(`--min must be a number from 0 to 1, got "${values.min}"`, usage);
    return 2;
  }
  if (values.engine !== undefined && !['auto', 'fts5', 'scan'].includes(values.engine)) {
    usageError(`--engine must be fts5 or scan, got "${values.engine}"`, usage);
    return 2;
  }

  let res;
  try {
    res = await runEval(cfg, values.file, { engine: values.engine ?? 'auto' });
  } catch (err) {
    if (err instanceof EvalError || err instanceof SearchEngineError) {
      usageError(err.message, usage);
      return 2;
    }
    throw err;
  }

  const empty = res.total === 0 && res.absent.n === 0;
  const pass = empty || res.hit3 >= min;
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ...res, min, pass }, null, 2)}\n`);
  } else if (empty) {
    process.stdout.write(`${say(cfg, 'eval.none', {})}\n`);
  } else {
    process.stdout.write(`${formatEval(res, cfg)}\n`);
  }
  if (!pass) process.stderr.write(`${say(cfg, 'eval.below', { hit3: res.hit3.toFixed(2), min: min.toFixed(2) })}\n`);
  return pass ? 0 : 1;
}
