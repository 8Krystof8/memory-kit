// Shared test helpers. Tests never touch the real kit root: they copy it into a temporary folder
// and run the CLI there with --root. Set MEMORY_KEEP_TMP=1 to keep the folders for debugging.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Git must not repack or prune in the background while a test copies a repository: a detached
// `git gc --auto` or `git maintenance` removed .git/objects folders under a copy in CI. Every git
// the tests start (directly or through the CLI) inherits these settings.
{
  const n = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const settings = [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false']];
  settings.forEach(([key, value], i) => {
    process.env[`GIT_CONFIG_KEY_${n + i}`] = key;
    process.env[`GIT_CONFIG_VALUE_${n + i}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(n + settings.length);
}
export const FIXTURES_DIR = path.join(KIT_ROOT, 'system', 'tests', 'fixtures');

/** The fixed as-of date of every fixture test. Fixture dates are chosen relative to it. */
export const TODAY = '2026-09-20';

/** Names of the fixture vaults per language (literal on purpose: they are the expectation). */
export const LANGS = {
  en: {
    lang: 'en',
    sectors: 'sectors', inbox: 'inbox', journal: 'journal', archive: 'archive',
    attachments: 'attachments', decisions: 'decisions',
    home: 'home.md', state: 'state.md', waiting: 'waiting.md',
    core: 'core', work: 'work', school: 'school', hobbies: 'hobbies', health: 'health',
    profile: 'sectors/core/profile.md', exportSuffix: '-export',
    types: { decision: 'decision' }, keys: { description: 'description' },
  },
  cs: {
    lang: 'cs',
    sectors: 'sektory', inbox: 'inbox', journal: 'denik', archive: 'archiv',
    attachments: 'prilohy', decisions: 'rozhodnuti',
    home: 'domu.md', state: 'stav.md', waiting: 'ceka.md',
    core: 'jadro', work: 'prace', school: 'skola', hobbies: 'konicky', health: 'zdravi',
    profile: 'sektory/jadro/profil.md', exportSuffix: '-export',
    types: { decision: 'rozhodnuti' }, keys: { description: 'popis' },
  },
};

// Never copied into a test vault.
const SKIP_NAMES = new Set(['.git', 'node_modules', '.cache', '.trash']);

// ---------------------------------------------------------------------------------------------
// Temporary folders

const created = [];

/**
 * A fresh temporary folder, as its canonical path (links resolved; on Windows also 8.3 names
 * such as RUNNER~1, which git reports in full); removed by removeTmpDirs() unless
 * MEMORY_KEEP_TMP is set.
 */
export function tmpDir(label = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `memory-kit-${label}-`));
  created.push(dir);
  return fs.realpathSync.native(dir);
}

/** Pass to node:test `after()` in every file that creates temporary folders. */
export function removeTmpDirs() {
  if (process.env.MEMORY_KEEP_TMP) {
    if (created.length) process.stderr.write(`kept temporary folders:\n${created.join('\n')}\n`);
    return;
  }
  // Retries: on Windows a git process or the virus scanner can still hold a file for a moment.
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// ---------------------------------------------------------------------------------------------
// Copies

/** Copies the kit (without .git) into dest and returns dest. */
export function copyKit(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(KIT_ROOT)) {
    if (SKIP_NAMES.has(entry)) continue;
    fs.cpSync(path.join(KIT_ROOT, entry), path.join(dest, entry), {
      recursive: true,
      filter: (src) => !SKIP_NAMES.has(path.basename(src)),
    });
  }
  return dest;
}

/** Copies every file of src into dest, overwriting files with the same path. */
export function overlay(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/** Copies a whole folder to a new place (a second machine, in effect). */
export function cloneDir(src, dest) {
  copyTree(src, dest);
  return dest;
}

// A plain recursive copy: fs.cpSync of Node 24 aborts the whole process when a folder vanishes
// while it copies (a C++ exception), which a test must survive as an ordinary error at worst.
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

// ---------------------------------------------------------------------------------------------
// Vaults

/** The memory.json a fixture vault uses: combined mode with the local root next to it. */
export function fixtureConfig(lang) {
  return {
    version: 1,
    initialized: true,
    lang,
    mode: 'combined',
    roots: [
      { id: 'main', path: '.', privacy: 'github' },
      { id: 'private', path: '../private', privacy: 'local' },
    ],
    profile: LANGS[lang].profile,
    agents: ['claude-code', 'codex', 'gemini-cli', 'cursor', 'chatgpt', 'claude-app'],
    budgets: {},
    search: { log: false, n: 5 },
    eval: { golden: 'system/tests/golden.json', min: 0.9 },
    cleanup: { provider: 'none' },
  };
}

/**
 * A fixture vault without running init: <tmp>/vault holds the kit code, the kit's rules files and
 * the fixture notes; <tmp>/private holds the local root. Returns {base, root, priv, names}.
 */
export function fixtureVault(lang) {
  const base = tmpDir(`fx-${lang}`);
  const root = path.join(base, 'vault');
  const priv = path.join(base, 'private');
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(KIT_ROOT, 'system'), path.join(root, 'system'), {
    recursive: true,
    filter: (src) => !SKIP_NAMES.has(path.basename(src)),
  });
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const src = path.join(KIT_ROOT, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, file));
  }
  overlay(path.join(FIXTURES_DIR, lang, 'vault'), root);
  overlay(path.join(FIXTURES_DIR, lang, 'private'), priv);
  writeJson(root, 'memory.json', fixtureConfig(lang));
  return { base, root, priv, names: LANGS[lang] };
}

/**
 * The smallest root loadConfig accepts: memory.json, the language packs and system/VERSION.
 * `config` is merged over fixtureConfig(lang) without its local root.
 */
export function bareRoot(lang = 'en', config = {}) {
  // Nested, so that relative local roots like ../private stay inside the temporary folder.
  const root = path.join(tmpDir(`bare-${lang}`), 'vault');
  fs.cpSync(path.join(KIT_ROOT, 'system', 'lang'), path.join(root, 'system', 'lang'), { recursive: true });
  fs.copyFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), path.join(root, 'system', 'VERSION'));
  const base = fixtureConfig(lang);
  base.roots = base.roots.slice(0, 1);
  writeJson(root, 'memory.json', { ...base, ...config });
  return root;
}

/** Loads config and vault of a root in-process (for unit tests of the library modules). */
export async function loadFixture(root, { roots = 'all' } = {}) {
  const { loadConfig } = await import('../lib/config.mjs');
  const { loadVault } = await import('../lib/vault.mjs');
  const cfg = loadConfig(root);
  return { cfg, vault: loadVault(cfg, { roots }) };
}

// ---------------------------------------------------------------------------------------------
// Running the CLI

// Variables that would change what a command does; tests set them explicitly when needed.
const SCRUBBED_ENV = ['MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITPOD_WORKSPACE_ID'];

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  return { ...env, ...extra };
}

function runNode(script, args, { env, cwd, input } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: childEnv(env),
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, signal: res.signal };
}

/** Runs `node <root>/system/memory.mjs <args> --root <root>`: {code, stdout, stderr}. */
export function runCli(root, args, { env, cwd } = {}) {
  return runNode(path.join(root, 'system', 'memory.mjs'), [...args, '--root', root], { env, cwd: cwd ?? root });
}

/** Runs `node <root>/system/init.mjs <args> --root <root>` with cwd = root. */
export function runInit(root, args, { env, cwd } = {}) {
  return runNode(path.join(root, 'system', 'init.mjs'), [...args, '--root', root], { env, cwd: cwd ?? root });
}

/** `check --json` parsed: {code, mode, errors, warnings, notes, codes: Set, raw}. */
export function checkJson(root, args = [], opts) {
  const res = runCli(root, ['check', ...args, '--json'], opts);
  let parsed;
  try {
    const text = res.stdout.slice(res.stdout.indexOf('{'));
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`check --json printed no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}\n${err.message}`);
  }
  const all = [...(parsed.errors ?? []), ...(parsed.warnings ?? [])];
  return { code: res.code, ...parsed, codes: new Set(all.map((f) => f.code)), raw: res };
}

/** One line per finding, for assertion messages. */
export function describeFindings(result) {
  const list = [...(result.errors ?? []).map((f) => ['ERROR', f]), ...(result.warnings ?? []).map((f) => ['WARN', f])];
  return list.map(([s, f]) => `${s} ${f.code} ${f.rel}:${f.line} ${f.msg}`).join('\n') || '(no findings)';
}

// ---------------------------------------------------------------------------------------------
// Files

export function sha256File(abs) {
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** {rel: sha256} of every generated file: _ai/*, .ignore and the home page. */
export function hashGenerated(root) {
  const out = {};
  const ai = path.join(root, '_ai');
  const names = fs.existsSync(ai) ? fs.readdirSync(ai).filter((n) => fs.statSync(path.join(ai, n)).isFile()) : [];
  for (const name of names.sort()) out[`_ai/${name}`] = sha256File(path.join(ai, name));
  for (const rel of ['.ignore', 'home.md', 'domu.md']) {
    if (fs.existsSync(path.join(root, rel))) out[rel] = sha256File(path.join(root, rel));
  }
  return out;
}

export function readFile(root, rel) {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

export function writeFile(root, rel, text) {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}

export function writeJson(root, rel, value) {
  return writeFile(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

export function exists(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split('/')));
}

// ---------------------------------------------------------------------------------------------
// Secrets. Built at runtime from pieces, so no file of the kit ever contains one (section 12.2).

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function pseudoRandom(length, alphabet, seed) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[(seed + i * 7) % alphabet.length];
  return out;
}

/** Fake credentials in the shapes of section 12.1: {aws, github, all}. Deterministic. */
export function plantSecret() {
  const aws = 'AK' + 'IA' + pseudoRandom(16, ALNUM.slice(0, 26) + ALNUM.slice(52), 3);
  const github = 'gh' + 'p_' + pseudoRandom(36, ALNUM, 11);
  return { aws, github, all: [aws, github] };
}
