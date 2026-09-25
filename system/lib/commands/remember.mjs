// `remember "text"`: records one thing without ceremony. Inside the code repository of a known
// project it appends a dated line to the right note of the project's dev sector (gotcha, dead end,
// todo, command, convention, decision or fact); elsewhere it saves a capture into the inbox.
// Secrets are refused. Reads the text from stdin when none is given.

import { identify, sectorFor, appendLine, REMEMBER_TYPES } from '../projects.mjs';
import { scanText } from '../secrets.mjs';
import { parseCli, todayLocal } from '../util.mjs';

export const usage = 'remember "text" [--type gotcha|dead-end|todo|run|convention|decision|fact] [--project <sector>] [--title "…"] [--json]';

const DEFAULTS = {
  'remember.saved': 'saved to {rel}',
  'remember.inbox': 'saved to the inbox: {rel} (no project here; file it later)',
  'remember.secret': 'refused: the text contains a secret ({rule}); fix: remove it, keep secrets in a password manager',
  'remember.empty': 'nothing to remember: give the text in quotes or through stdin',
  'remember.type': 'unknown --type "{type}"; use one of: {types}',
};

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (a, n) => (n in vars ? String(vars[n]) : a));
}

async function stdinText() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function run(argv, cfg) {
  const opts = parseCli(argv, {
    type: { type: 'string', default: 'fact' }, project: { type: 'string' }, title: { type: 'string' }, json: { type: 'boolean' },
  }, usage);
  if (!opts) return 2;
  const { values, positionals } = opts;
  const text = (positionals.join(' ') || await stdinText()).replace(/\s+/g, ' ').trim();
  if (!text) {
    process.stderr.write(`memory: ${say(cfg, 'remember.empty')}\n`);
    return 2;
  }
  const role = REMEMBER_TYPES[values.type];
  if (!role) {
    process.stderr.write(`memory: ${say(cfg, 'remember.type', { type: values.type, types: Object.keys(REMEMBER_TYPES).join(', ') })}\n`);
    return 2;
  }
  const hit = scanText(text)[0];
  if (hit) {
    process.stderr.write(`memory: ${say(cfg, 'remember.secret', { rule: hit.rule })}\n`);
    return 1;
  }
  const sector = values.project || sectorFor(cfg, identify(process.cwd()));
  let result;
  if (sector) {
    const tag = cfg.lang === 'cs'
      ? { gotcha: 'past', 'dead-end': 'slepá ulička', todo: 'úkol', run: 'příkaz', convention: 'konvence', decision: 'rozhodnutí', fact: 'fakt' }[values.type]
      : values.type;
    const rel = appendLine(cfg, sector, role, `- [${tag}] ${todayLocal()}: ${text}`);
    result = { rel, sector, type: values.type };
    if (!values.json) process.stdout.write(`${say(cfg, 'remember.saved', { rel })}\n`);
  } else {
    const { openMemory } = await import('../../api.mjs');
    const mem = await openMemory(cfg.root);
    try {
      const r = await mem.inbox(text, { title: values.title, source: 'remember' });
      result = { rel: r.path, sector: null, type: values.type };
      if (!values.json) process.stdout.write(`${say(cfg, 'remember.inbox', { rel: r.path })}\n`);
    } finally {
      mem.close?.();
    }
  }
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
