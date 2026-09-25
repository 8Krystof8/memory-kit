// `remember "text"`: records one thing without ceremony. With --project, or inside the code
// repository of a known project, it appends a dated line to the right note of the project's dev
// sector (gotcha, dead end, todo, command, convention, decision or fact), in the local root for a
// local-store project. Inside a repository that is not a project it says how to add it and, while
// projects.store is local, keeps the capture in the inbox of the local root: the text may be about
// a client, and nothing about a client may reach git by itself. Elsewhere (the vault, or no
// repository at all) the capture goes into the inbox. Secrets are refused. Reads the text from
// stdin when none is given.

import fs from 'node:fs';
import path from 'node:path';
import {
  ProjectError, identifyIn, insideVault, findProject, appendLine, noteAbs, projectSettings, ensureLocalRoot, shownPath, vaultCommand,
  REMEMBER_TYPES,
} from '../projects.mjs';
import { serialize } from '../frontmatter.mjs';
import { scanText } from '../secrets.mjs';
import { fold } from '../text.mjs';
import { finalText, parseCli, todayLocal } from '../util.mjs';

export const usage = 'remember "text" [--type gotcha|dead-end|todo|run|convention|decision|fact] [--project <sector>] [--title "…"] [--json]';

const DEFAULTS = {
  'remember.saved': 'saved to {rel}',
  'remember.inbox': 'saved to the inbox: {rel} (no project here; file it later)',
  'remember.secret': 'refused: the text contains a secret ({rule}); fix: remove it, keep secrets in a password manager',
  'remember.empty': 'nothing to remember: give the text in quotes or through stdin',
  'remember.type': 'unknown --type "{type}"; use one of: {types}',
  'remember.inbox_repo': 'saved to the inbox: {rel}. This repository is not a project yet; to keep notes for it, run: {cmd} project add',
  'remember.local_inbox': 'saved to the local inbox, which stays on this computer: {rel}. This repository is not a project yet; to keep notes for it, run: {cmd} project add',
  'remember.no_local': 'not saved: this repository is not a project, and its text may not go into the vault repository, but the local root cannot be used ({path}); add the project with: {cmd} project add --store git, or fix memory.json "roots"',
  'remember.no_project': 'sector "{id}" has no project notes; see the projects with: {cmd} project list',
};

const TITLE_MAX = 200;
// Control characters (a capture is plain text); tabs and line ends are already folded to spaces.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

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

/** 'sso-callback-breaks' from the first words of a text (ascii, at most 6 words and 48 characters). */
function slugOf(text) {
  let slug = '';
  for (const word of fold(text).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 6)) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 48) break;
    slug = next;
  }
  return slug || 'capture';
}

/**
 * Saves a capture as a new file in the inbox of the local root (made when missing), in the form
 * of the vault's own inbox; returns its path for messages (../<local root>/inbox/…).
 */
async function localCapture(cfg, text, { title, day }) {
  const { root } = await ensureLocalRoot(cfg);
  const dir = path.join(root.path, ...cfg.dirs.inbox.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const head = String(title ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  text = text.replace(CONTROL, '');
  const content = finalText(`${serialize({ [cfg.keys.created]: day, [cfg.keys.source]: 'remember' }, { order: cfg.keyOrder })}${head ? `# ${head}\n\n` : ''}${text}`);
  const slug = slugOf(head || text);
  for (let i = 1; ; i++) {
    const abs = path.join(dir, `${day}-${slug}${i > 1 ? `-${i}` : ''}.md`);
    try {
      fs.writeFileSync(abs, content, { flag: 'wx' });
      return shownPath(cfg, abs);
    } catch (err) {
      if (err?.code !== 'EEXIST' || i >= 1000) throw err;
    }
  }
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
  const hit = scanText(`${text}\n${values.title ?? ''}`)[0];
  if (hit) {
    process.stderr.write(`memory: ${say(cfg, 'remember.secret', { rule: hit.rule })}\n`);
    return 1;
  }
  const cmd = vaultCommand(cfg);
  const cwd = process.cwd();
  const ident = (values.project || insideVault(cfg, cwd)) ? null : identifyIn(cfg, cwd);
  const repo = ident && !insideVault(cfg, ident.top) ? ident : null;
  const sector = values.project || findProject(cfg, repo)?.id || null;
  if (sector && !fs.existsSync(noteAbs(cfg, sector, role))) {
    process.stderr.write(`memory: ${say(cfg, 'remember.no_project', { id: sector, cmd })}\n`);
    return 1;
  }
  let result;
  if (sector) {
    const tag = cfg.lang === 'cs'
      ? { gotcha: 'past', 'dead-end': 'slepá ulička', todo: 'úkol', run: 'příkaz', convention: 'konvence', decision: 'rozhodnutí', fact: 'fakt' }[values.type]
      : values.type;
    const rel = appendLine(cfg, sector, role, `- [${tag}] ${todayLocal()}: ${text}`);
    result = { rel, sector, type: values.type };
    if (!values.json) process.stdout.write(`${say(cfg, 'remember.saved', { rel })}\n`);
  } else if (repo && projectSettings(cfg).store === 'local') {
    let rel;
    try {
      rel = await localCapture(cfg, text, { title: values.title, day: todayLocal() });
    } catch (err) {
      if (!(err instanceof ProjectError)) throw err;
      process.stderr.write(`memory: ${say(cfg, 'remember.no_local', { path: err.detail || '?', cmd })}\n`);
      return 1;
    }
    result = { rel, sector: null, type: values.type, project: false, local: true };
    if (!values.json) process.stdout.write(`${say(cfg, 'remember.local_inbox', { rel, cmd })}\n`);
  } else {
    const { openMemory } = await import('../../api.mjs');
    const mem = await openMemory(cfg.root);
    try {
      const r = await mem.inbox(text, { title: values.title, source: 'remember' });
      result = { rel: r.path, sector: null, type: values.type, ...(repo ? { project: false, local: false } : {}) };
      if (!values.json) process.stdout.write(`${say(cfg, repo ? 'remember.inbox_repo' : 'remember.inbox', { rel: r.path, cmd })}\n`);
    } finally {
      mem.close?.();
    }
  }
  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
