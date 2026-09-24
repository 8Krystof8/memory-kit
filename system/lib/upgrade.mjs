// Upgrading a vault to a newer kit: the plan (no writes), the backup, applying, verification with
// automatic rollback, and --rollback. What may be replaced follows the ownership table in kit.mjs;
// "unmodified" means the vault file's hash is one a kit release shipped: the new kit's
// kit-history.json, plus the vault's own kit.json and history (a development build it runs).
// Library code: nothing is printed; commands/upgrade.mjs turns the results into messages.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyAtomic, removeTree, unlinkRetry, writeAtomic } from './fsafe.mjs';
import { touchLock, upgradeRunning } from './lockcheck.mjs';
import {
  ESSENTIAL_FILES, HISTORY_FILE, KIT_FILE, VERSION_FILE, absOf, cleanRel, compareVersions, groupOf,
  hashFile, hashText, knownHashes, loadHistory, loadManifest, optionalGroups, parseVersion, readVersion,
} from './kit.mjs';
import { dataVersionOf, loadMigrations, migrationChain, runMigrations } from './migrations.mjs';

export const WORK_DIR = '.memory-kit';
export const LOCK_FILE = '.memory-kit/upgrade.lock';
export const BACKUPS_DIR = '.memory-kit/backups';
export const KEEP_BACKUPS = 5;
export const AGENTS_FILE = 'AGENTS.md';
export const MEMORY_FILE = 'memory.json';
/** How the line starts that the start command prints when it cannot build the view (its fallback). */
export const START_FAILED = 'memory: start failed:';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_START = '<!-- kit:start';
const KIT_END = '<!-- kit:end -->';
// The block check --generate maintains in .gitignore (system/lib/generate.mjs); the rest is the owner's.
const GITIGNORE_START = '# memory-kit:local-sectors start (maintained by the kit; edit the sectors, not this block)';
const GITIGNORE_END = '# memory-kit:local-sectors end';
const BACKUP_ID_RE = /^\d{8}-\d{6}-[0-9A-Za-z._-]+-to-[0-9A-Za-z._-]+$/;
const WRITE_ACTIONS = new Set(['add', 'replace', 'force']);
const LAST_FILES = [HISTORY_FILE, VERSION_FILE, KIT_FILE];
const WALK_SKIP = new Set(['.git', WORK_DIR, 'node_modules']);
const CHILD_TIMEOUT_MS = 300000;
/** The upgrader's own modules; a copy in each backup undoes the upgrade without the vault's code. */
const TOOL_FILES = ['upgrade.mjs', 'kit.mjs', 'fsafe.mjs', 'migrations.mjs', 'lockcheck.mjs'];

/** A refusal or failure with a code for messages and its variables. */
export class UpgradeError extends Error {
  constructor(code, vars = {}, message = code) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The proposed-files folder of a target version. */
export function proposedDir(to) {
  return `${WORK_DIR}/upgrade/${safeName(to)}/proposed`;
}

function safeName(s) {
  return String(s).replace(/[^0-9A-Za-z._-]/g, '_');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** The bytes of a file, or null when it is missing. */
function readBytes(abs) {
  try {
    return fs.readFileSync(abs);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err?.code)) return null;
    throw err;
  }
}

/** sha256 of the raw bytes of a file, or null when missing. Backups restore bytes, not text. */
export function rawHash(abs) {
  const buf = readBytes(abs);
  return buf === null ? null : sha256(buf);
}

/** True when abs lies inside dir (or is dir itself); plain path arithmetic. */
function insideDir(dir, abs) {
  const rel = path.relative(dir, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function readJson(abs) {
  try {
    const value = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

function isDirectory(abs) {
  try {
    return fs.statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/** True when both paths name the same existing folder. */
export function samePath(a, b) {
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---------------------------------------------------------------------------------------------
// The vault's own settings (read without config.mjs, which may be broken or too old)

/** memory.json as upgrade needs it: { raw, error, lang, golden, dataVersion, source }. */
export function readVaultConfig(root) {
  let raw = null;
  let error = null;
  try {
    const value = JSON.parse(fs.readFileSync(absOf(root, MEMORY_FILE), 'utf8').replace(/^﻿/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value;
    else error = 'the top level is not a JSON object';
  } catch (err) {
    error = err?.code === 'ENOENT' ? 'the file is missing' : err?.message ?? String(err);
  }
  const lang = typeof raw?.lang === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(raw.lang.trim()) ? raw.lang.trim() : 'en';
  const g = raw?.eval?.golden;
  const golden = typeof g === 'string' && g.trim() ? cleanRel(g.trim()) : 'system/tests/golden.json';
  const s = raw?.kit?.source;
  return {
    raw,
    error,
    lang,
    golden,
    dataVersion: raw ? dataVersionOf(raw) : null,
    source: typeof s === 'string' && s.trim() ? s.trim() : null,
  };
}

// ---------------------------------------------------------------------------------------------
// AGENTS.md kit section

function linesWithEnds(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Replaces the lines from the one containing '<!-- kit:start' through the one containing
 * '<!-- kit:end -->' with block; everything before and after stays byte for byte.
 * → { state: 'replaced'|'unchanged'|'missing'|'duplicate'|'broken', text } (text null unless usable).
 */
export function replaceKitBlock(text, block) {
  const lines = linesWithEnds(String(text));
  const starts = [];
  const ends = [];
  lines.forEach((line, i) => {
    if (line.includes(KIT_START)) starts.push(i);
    if (line.includes(KIT_END)) ends.push(i);
  });
  if (!starts.length || !ends.length) return { state: 'missing', text: null };
  if (starts.length > 1 || ends.length > 1) return { state: 'duplicate', text: null };
  const [s, e] = [starts[0], ends[0]];
  if (e < s) return { state: 'broken', text: null };
  let next = String(block).replace(/\r\n/g, '\n');
  if (!next.endsWith('\n')) next += '\n';
  if (lines[s].endsWith('\r\n')) next = next.replace(/\n/g, '\r\n');
  const before = s === 0 && text.charCodeAt(0) === 0xfeff ? '﻿' : lines.slice(0, s).join('');
  const out = before + next + lines.slice(e + 1).join('');
  return { state: out === text ? 'unchanged' : 'replaced', text: out };
}

/**
 * replaceKitBlock on the bytes of a file → { state, bytes } (bytes null unless usable). UTF-8 goes
 * through replaceKitBlock as text. Other bytes (text in an older editor's code page) are spliced
 * as they are: the markers are ASCII, so everything around the section stays byte for byte. A
 * UTF-16 file (its BOM first) is left alone: state 'encoding'.
 */
export function replaceKitBlockBytes(buf, block) {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return { state: 'encoding', bytes: null };
  if (isUtf8(buf)) {
    const res = replaceKitBlock(buf.toString('utf8'), block);
    return { state: res.state, bytes: res.text === null ? null : Buffer.from(res.text, 'utf8') };
  }
  // latin1 maps every byte to one character and back, so nothing outside the section changes.
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const res = replaceKitBlock(buf.subarray(bom).toString('latin1'), Buffer.from(String(block), 'utf8').toString('latin1'));
  return { state: res.state, bytes: res.text === null ? null : Buffer.concat([buf.subarray(0, bom), Buffer.from(res.text, 'latin1')]) };
}

/** The kit section template of a language in a kit checkout (en fallback): { rel, text } or null. */
export function agentsTemplate(kitRoot, lang) {
  for (const code of [lang, 'en']) {
    const rel = `system/templates/${code}/kit/agents-system.md`;
    try {
      return { rel, text: fs.readFileSync(absOf(kitRoot, rel), 'utf8') };
    } catch {
      /* try the next language */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// git (read-only here; ensureExcluded writes .git/info/exclude)

function runGit(cwd, args, { env } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: CHILD_TIMEOUT_MS,
    env: env ?? process.env,
  });
  return { ok: !res.error && res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr || res.error?.message || '' };
}

/**
 * The git repository the vault belongs to → { prefix } (the vault's folder inside it), or null.
 * A vault in an untracked folder of another repository (a dotfiles repository in the home
 * folder) is not under git: that repository does not hold it.
 */
function vaultRepo(root) {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return null;
  const prefix = runGit(root, ['rev-parse', '--show-prefix']).stdout.trim();
  if (prefix) {
    const tracked = runGit(root, ['ls-files', '-z', '--', '.']);
    if (!tracked.ok || tracked.stdout === '') return null;
  }
  return { prefix };
}

/** { repo: false } outside git; else { repo: true, dirty: Set of vault-relative POSIX paths }. */
export function gitState(root) {
  const repo = vaultRepo(root);
  if (!repo) return { repo: false, dirty: new Set() };
  const { prefix } = repo;
  const status = runGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  const dirty = new Set();
  if (!status.ok) return { repo: true, dirty, error: status.stderr.trim() };
  const tokens = status.stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const paths = [entry.slice(3)];
    if (/[RC]/.test(xy)) paths.push(tokens[++i] ?? '');
    for (const p of paths) {
      if (!p || !p.startsWith(prefix)) continue;
      dirty.add(p.slice(prefix.length).replace(/\/$/, ''));
    }
  }
  return { repo: true, dirty };
}

/** Adds '.memory-kit/' to the repository's .git/info/exclude (never to .gitignore). */
export function ensureExcluded(root) {
  if (!vaultRepo(root)) return false;
  const res = runGit(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!res.ok || !res.stdout.trim()) return false;
  const abs = path.resolve(root, res.stdout.trim());
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    /* no exclude file yet */
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => ['.memory-kit', '.memory-kit/', '/.memory-kit', '/.memory-kit/'].includes(l))) return false;
  writeAtomic(abs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${WORK_DIR}/\n`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Sources

/** True for anything git clones by URL (https, ssh, git, file, or user@host:path). */
export function isGitUrl(s) {
  const t = String(s ?? '');
  return /^(?:https?|ssh|git|file):\/\//i.test(t) || /^[\w.-]+@[\w.-]+:/.test(t);
}

/**
 * git clone --depth 1 into a new temporary folder: { dir, base, cleanup } (base is the temporary
 * folder cleanup removes; cleanup may throw). Throws UpgradeError 'clone_failed' with git's message.
 */
export function cloneKit(url, { ref } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-kit-upgrade-'));
  const dir = path.join(base, 'kit');
  const args = ['clone', '--depth', '1', '--quiet'];
  if (ref) args.push('--branch', ref);
  args.push('--', url, dir);
  const res = runGit(base, args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (!res.ok) {
    try {
      removeTree(base);
    } catch {
      /* a leftover temporary folder must not hide git's message */
    }
    // git's first error line names the cause; its last one may only be advice ("…and the repository exists.").
    const lines = res.stderr.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    const detail = lines.find((l) => /^(?:fatal|error):/i.test(l)) ?? lines.pop() ?? 'git clone failed';
    throw new UpgradeError('clone_failed', { url, ref: ref ?? '', detail }, `git clone ${url}: ${detail}`);
  }
  return { dir, base, cleanup: () => removeTree(base) };
}

/**
 * A kit checkout as an upgrade source: its manifest, history and the problems that make it
 * unusable ({ code, ...vars }): no manifest, an inconsistent version, damaged files.
 */
export function inspectSource(sourceRoot) {
  const manifest = loadManifest(sourceRoot);
  const version = readVersion(sourceRoot);
  const problems = [];
  if (!manifest) {
    problems.push({ code: 'source_no_manifest', source: sourceRoot });
    return { root: sourceRoot, manifest, history: {}, version, problems, damaged: [] };
  }
  const bad = [];
  if (!parseVersion(manifest.version)) bad.push('version');
  if (!Number.isInteger(manifest.data_version) || manifest.data_version < 1) bad.push('data_version');
  if (!parseVersion(manifest.node)) bad.push('node');
  if (!parseVersion(manifest.upgrade_from)) bad.push('upgrade_from');
  if (bad.length) problems.push({ code: 'source_manifest', source: sourceRoot, fields: bad.join(', ') });
  else if (manifest.version !== version) problems.push({ code: 'source_version', version: version ?? '–', manifest: manifest.version });
  const damaged = [];
  for (const [rel, entry] of Object.entries(manifest.files).sort(([a], [b]) => byCodeUnit(a, b))) {
    if (hashFile(absOf(sourceRoot, rel)) !== entry?.sha256) damaged.push(rel);
  }
  if (damaged.length) problems.push({ code: 'source_damaged', n: damaged.length, files: damaged.slice(0, 5).join(', ') });
  return { root: sourceRoot, manifest, history: loadHistory(sourceRoot), version, problems, damaged };
}

// ---------------------------------------------------------------------------------------------
// The plan

/** The recovery tool of a backup (vault-relative POSIX path): node <it> undoes that upgrade. */
export function recoveryTool(id) {
  return `${BACKUPS_DIR}/${id}/tool/rollback.mjs`;
}

/**
 * The lock of an upgrade that runs or did not finish: { rel, backup, from, to, started, pid, host,
 * valid, running, recover } or null. running: its process is still at work (never undo it then);
 * recover: the recovery tool of its backup when that exists.
 */
export function lockState(root) {
  const abs = absOf(root, LOCK_FILE);
  let text;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(abs, 'utf8');
    mtimeMs = fs.statSync(abs).mtimeMs;
  } catch {
    return null;
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const pick = (key) => (data && typeof data[key] !== 'undefined' ? data[key] : null);
  const lock = {
    rel: LOCK_FILE,
    backup: pick('backup'),
    from: pick('from'),
    to: pick('to'),
    started: pick('started'),
    pid: pick('pid'),
    host: pick('host'),
    valid: Boolean(data && typeof data === 'object'),
    running: false,
    recover: null,
  };
  lock.running = lock.valid && upgradeRunning(lock, mtimeMs);
  if (typeof lock.backup === 'string' && BACKUP_ID_RE.test(lock.backup) && isFile(absOf(root, recoveryTool(lock.backup)))) {
    lock.recover = recoveryTool(lock.backup);
  }
  return lock;
}

function countActions(files) {
  const counts = { add: 0, replace: 0, unchanged: 0, force: 0, blocked: 0, propose: 0, skip: 0, remove: 0, keep: 0 };
  for (const f of files) counts[f.action] += 1;
  return counts;
}

/** Every vault path an apply of plan writes or removes, plus the files always backed up. */
export function plannedPaths(plan) {
  const set = new Set([AGENTS_FILE, MEMORY_FILE, ...LAST_FILES]);
  for (const f of plan.files) if (WRITE_ACTIONS.has(f.action) || f.action === 'remove') set.add(f.rel);
  return [...set].sort(byCodeUnit);
}

function fileActions({ vaultRoot, source, force, golden, vaultManifest, vaultHistory, from }) {
  const optional = optionalGroups(vaultRoot);
  const newFiles = source.manifest.files;
  const known = (rel) => {
    const set = knownHashes(source.history, rel);
    for (const h of knownHashes(vaultHistory, rel)) set.add(h);
    const installed = vaultManifest?.files?.[rel]?.sha256;
    if (typeof installed === 'string') set.add(installed);
    if (typeof newFiles[rel]?.sha256 === 'string') set.add(newFiles[rel].sha256);
    return set;
  };
  const files = [];
  for (const rel of Object.keys(newFiles).sort(byCodeUnit)) {
    const entry = newFiles[rel];
    const group = entry.group ?? groupOf(rel);
    if (rel === golden || groupOf(rel, { golden }) === null) {
      files.push({ rel, group, action: 'skip', reason: 'golden' });
      continue;
    }
    if ((group === 'tests' && !optional.tests) || (group === 'docs' && !optional.docs)) {
      files.push({ rel, group, action: 'skip', reason: 'optional' });
      continue;
    }
    const current = hashFile(absOf(vaultRoot, rel));
    if (current === null) {
      if (group === 'config' && !ESSENTIAL_FILES.includes(rel)) files.push({ rel, group, action: 'skip', reason: 'missing' });
      else files.push({ rel, group, action: 'add' });
    } else if (current === entry.sha256) {
      files.push({ rel, group, action: 'unchanged' });
    } else if (known(rel).has(current)) {
      files.push({ rel, group, action: 'replace' });
    } else if (group === 'config' || group === 'docs') {
      files.push({ rel, group, action: 'propose', reason: 'modified' });
    } else {
      files.push({ rel, group, action: force ? 'force' : 'blocked', reason: 'modified' });
    }
  }
  // Files the installed version shipped that the new one no longer has.
  const installed = new Set([...Object.keys(source.history[from] ?? {}), ...Object.keys(vaultManifest?.files ?? {})]);
  for (const rel of [...installed].sort(byCodeUnit)) {
    if (Object.hasOwn(newFiles, rel) || rel === KIT_FILE || rel === HISTORY_FILE || rel === golden) continue;
    const group = groupOf(rel, { golden });
    if (group === null) continue;
    const current = hashFile(absOf(vaultRoot, rel));
    if (current === null) continue;
    if (known(rel).has(current)) files.push({ rel, group, action: 'remove' });
    else files.push({ rel, group, action: 'keep', reason: 'modified' });
  }
  return files;
}

/**
 * Plans an upgrade of vault from the kit checkout source. Reads only. The result says what
 * happens to every kit file ({ rel, group, action, reason? } with action add, replace,
 * unchanged, force, blocked, propose, skip, remove or keep), to the AGENTS.md kit section and to
 * the data (migrations), and why it cannot run: refusals (hard) and blockers (--force overrides).
 * `migrations` replaces the source's system/migrations list (for tests).
 */
export async function planUpgrade({ vault, source, force = false, nodeVersion = process.versions.node, migrations } = {}) {
  const vaultRoot = path.resolve(vault);
  const sourceRoot = path.resolve(source);
  const conf = readVaultConfig(vaultRoot);
  const src = inspectSource(sourceRoot);
  const installedRaw = readVersion(vaultRoot);
  const plan = {
    vault: vaultRoot,
    source: sourceRoot,
    from: installedRaw ?? '0.0.0',
    to: src.manifest?.version ?? src.version ?? null,
    lang: conf.lang,
    golden: conf.golden,
    force: Boolean(force),
    upToDate: false,
    ok: false,
    refusals: [],
    blockers: [],
    forced: [],
    files: [],
    counts: countActions([]),
    agents: { action: 'skip', state: 'unknown' },
    migrations: [],
    dataVersion: { from: conf.dataVersion, to: src.manifest?.data_version ?? null },
    proposedDir: null,
    git: { repo: false, dirty: [] },
    lock: lockState(vaultRoot),
  };
  const refuse = (code, vars = {}) => plan.refusals.push({ code, ...vars });
  const block = (code, vars = {}) => (force ? plan.forced : plan.blockers).push({ code, ...vars });

  if (samePath(vaultRoot, sourceRoot)) {
    refuse('same_dir', { path: vaultRoot });
    return finishPlan(plan);
  }
  for (const p of src.problems) refuse(p.code, Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'code')));
  if (conf.error) refuse('config', { error: conf.error });
  if (!parseVersion(plan.from)) refuse('vault_version', { version: plan.from });
  if (plan.refusals.length) return finishPlan(plan);

  const man = src.manifest;
  plan.proposedDir = proposedDir(plan.to);
  const order = compareVersions(plan.to, plan.from);
  if (order === 0) plan.upToDate = true;
  if (order < 0 && !force) refuse('downgrade', { from: plan.from, to: plan.to });
  if (compareVersions(plan.from, man.upgrade_from) < 0) refuse('too_old', { from: plan.from, min: man.upgrade_from });
  if (compareVersions(nodeVersion, man.node) < 0) refuse('node', { need: man.node, have: nodeVersion });

  // Data: memory.json "version" against the kit's data_version.
  if (conf.dataVersion === null) {
    refuse('data_invalid', {});
  } else if (conf.dataVersion > man.data_version) {
    refuse('data_newer', { vault: conf.dataVersion, kit: man.data_version });
  } else if (conf.dataVersion < man.data_version) {
    let list;
    try {
      list = migrations ?? await loadMigrations(sourceRoot);
    } catch (err) {
      refuse('migrations_invalid', { error: err?.message ?? String(err) });
    }
    if (list) {
      const chain = migrationChain(list, conf.dataVersion, man.data_version);
      if (!chain) refuse('no_migration', { from: conf.dataVersion, to: man.data_version });
      else plan.migrations = chain.map((m) => ({ id: m.id, from: m.from, to: m.to, title: m.title }));
    }
  }

  plan.files = fileActions({
    vaultRoot,
    source: src,
    force,
    golden: conf.golden,
    vaultManifest: loadManifest(vaultRoot),
    vaultHistory: loadHistory(vaultRoot),
    from: plan.from,
  });
  for (const f of plan.files) if (f.reason === 'modified' && (f.action === 'blocked' || f.action === 'force')) block('modified', { rel: f.rel });

  // AGENTS.md: the kit section of the vault's language from the new kit.
  const template = agentsTemplate(sourceRoot, conf.lang);
  const agentsBytes = readBytes(absOf(vaultRoot, AGENTS_FILE));
  if (agentsBytes === null) {
    plan.agents = { action: 'skip', state: 'no_file' };
  } else if (!template) {
    plan.agents = { action: 'skip', state: 'no_template' };
  } else {
    const res = replaceKitBlockBytes(agentsBytes, template.text);
    const action = res.state === 'replaced' ? 'replace' : res.state === 'unchanged' ? 'unchanged' : 'skip';
    plan.agents = { action, state: res.state, template: template.rel };
  }

  // Preconditions: an upgrade still at work (never overridden), a lock left behind,
  // uncommitted changes in anything this plan touches.
  const lockVars = plan.lock && { backup: plan.lock.backup ?? '–', from: plan.lock.from ?? '–', to: plan.lock.to ?? '–' };
  if (plan.lock?.running) refuse('running', { ...lockVars, pid: plan.lock.pid });
  else if (plan.lock) block('locked', lockVars);
  const git = gitState(vaultRoot);
  const touched = plannedPaths(plan);
  const dirty = git.repo ? touched.filter((rel) => git.dirty.has(rel)) : [];
  plan.git = { repo: git.repo, dirty };
  for (const rel of dirty) block('dirty', { rel });
  return finishPlan(plan);
}

function finishPlan(plan) {
  plan.counts = countActions(plan.files);
  plan.ok = plan.refusals.length === 0 && plan.blockers.length === 0;
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Backups

/** YYYYMMDD-HHMMSS in UTC: ids keep their order across time zones and the DST fall-back hour. */
function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
    + `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function writeBackupJson(dir, data) {
  writeAtomic(path.join(dir, 'backup.json'), `${JSON.stringify(data, null, 2)}\n`);
}

function fileMode(abs) {
  try {
    return fs.statSync(abs).mode & 0o777;
  } catch {
    return undefined;
  }
}

const parentOf = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * The owner's part of a file the checks may rewrite, as a hash (buf null: no file): the text of a
 * note (hashText ignores CRLF, a BOM and NFC, all that check --generate changes in a note) or the
 * lines of .gitignore outside the block the kit maintains. An equal hash means nothing the owner
 * wrote is lost when the file gets its saved bytes back.
 */
function ownerHash(kind, buf) {
  if (kind === 'note') return buf === null ? null : hashText(buf);
  const lines = (buf === null ? '' : buf.toString('utf8')).replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(GITIGNORE_START);
  const end = start >= 0 ? lines.indexOf(GITIGNORE_END, start) : -1;
  if (start >= 0 && end >= 0) lines.splice(start, end - start + 1);
  return hashText(lines.filter((line) => line.trim() !== '').join('\n'));
}

/** Where a backup keeps the notes of a local root: inside that root, so they never leave it. */
function localBackupDir(rootPath, id) {
  return path.join(rootPath, WORK_DIR, 'backups', id);
}

/**
 * Removes a backup: its folder and the copies it keeps inside local roots (and their emptied
 * .memory-kit folders there).
 */
function removeBackup(backupDir) {
  const data = readJson(path.join(backupDir, 'backup.json'));
  for (const r of Array.isArray(data?.roots) ? data.roots : []) {
    if (typeof r?.path !== 'string' || !path.isAbsolute(r.path)) continue;
    const local = localBackupDir(r.path, path.basename(backupDir));
    removeTree(local);
    if (rmdirIfEmpty(path.dirname(local))) rmdirIfEmpty(path.dirname(path.dirname(local)));
  }
  removeTree(backupDir);
}

/**
 * A new backup folder .memory-kit/backups/<YYYYMMDD-HHMMSS>-<from>-to-<to>/ (UTC) with backup.json
 * ({ id, from, to, created, state, pid, files, dirs, roots, local }) and the saved bytes under
 * files/<rel>. A file entry is { rel, existed, sha256, mode, next?, kind?, text?, after? }: next
 * is the raw hash the upgrade writes (null: it removes the file), known before it writes; kind
 * 'generated' marks a file check --generate rebuilds, 'note' and 'gitignore' one it may rewrite
 * without changing the owner's part (text, see ownerHash); after is the raw hash when the upgrade
 * finished. Notes of local roots (roots: [{ id, path }], local: [{ root, rel, sha256, text, ... }])
 * are saved inside their own root (localBackupDir), never in the vault. record(rel) saves a file
 * once, before anything changes it.
 */
export function createBackup(root, { from, to, now = new Date() }) {
  const base = `${stamp(now)}-${safeName(from)}-to-${safeName(to)}`;
  let id = base;
  for (let i = 2; fs.existsSync(absOf(root, `${BACKUPS_DIR}/${id}`)); i++) id = `${base}-${i}`;
  const dir = absOf(root, `${BACKUPS_DIR}/${id}`);
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  const data = {
    id, kit: 'memory-kit', from, to, created: now.toISOString(), state: 'started', pid: process.pid,
    files: [], dirs: [], roots: [], local: [],
  };
  const entries = new Map();
  const locals = new Map();
  const dirs = new Set();

  const noteDir = (rel) => {
    if (dirs.has(rel)) return;
    dirs.add(rel);
    data.dirs.push(rel);
  };
  const setKind = (entry, kind) => {
    if (!kind || entry.kind) return;
    entry.kind = kind;
    if (kind === 'generated') return;
    const saved = entry.existed ? fs.readFileSync(path.join(dir, 'files', ...entry.rel.split('/'))) : null;
    entry.text = ownerHash(kind, saved);
  };
  const add = (item) => {
    const { rel, kind, next } = typeof item === 'string' ? { rel: item } : item;
    const r = cleanRel(rel);
    let entry = entries.get(r);
    if (!entry) {
      const abs = absOf(root, r);
      const buf = isFile(abs) ? fs.readFileSync(abs) : null;
      if (buf !== null) {
        writeAtomic(path.join(dir, 'files', ...r.split('/')), buf);
        entry = { rel: r, existed: true, sha256: sha256(buf), mode: fileMode(abs) };
      } else {
        for (let parent = parentOf(r); parent && !fs.existsSync(absOf(root, parent)); parent = parentOf(parent)) noteDir(parent);
        entry = { rel: r, existed: false, sha256: null };
      }
      entries.set(r, entry);
      data.files.push(entry);
    }
    setKind(entry, kind);
    if (next !== undefined) entry.next = next;
  };
  const backup = {
    id,
    dir,
    data,
    /** Saves the current state of rel (once) and persists backup.json. */
    record(rel) {
      add(rel);
      writeBackupJson(dir, data);
    },
    /** record for many: rel strings or { rel, kind?, next? }. */
    recordMany(items) {
      for (const item of items) add(item);
      writeBackupJson(dir, data);
    },
    /**
     * Files that did not exist before and were created afterwards ({ rel, kind?, next? }); a
     * rollback removes them. knownDirs: the folders that existed before.
     */
    recordCreated(items, knownDirs) {
      for (const item of items) {
        const { rel, kind, next } = typeof item === 'string' ? { rel: item } : item;
        const r = cleanRel(rel);
        if (entries.has(r)) continue;
        const entry = { rel: r, existed: false, sha256: null };
        entries.set(r, entry);
        data.files.push(entry);
        setKind(entry, kind);
        if (next !== undefined) entry.next = next;
        for (let parent = parentOf(r); parent && !knownDirs.has(parent); parent = parentOf(parent)) noteDir(parent);
      }
      writeBackupJson(dir, data);
    },
    /** After the upgrade wrote, moved or removed rel: its bytes now are the upgrade's own. */
    wrote(rel) {
      const entry = entries.get(cleanRel(rel));
      if (!entry) return;
      entry.next = rawHash(absOf(root, entry.rel));
      writeBackupJson(dir, data);
    },
    /**
     * Notes of local roots that the checks may normalize ([{ root: id, base: abs path, rel }]),
     * saved inside their root. One that cannot be saved there (a read-only folder) is left out.
     */
    recordLocal(items) {
      for (const { root: rootId, base, rel } of items) {
        const key = `${rootId}\0${rel}`;
        if (locals.has(key)) continue;
        const abs = path.join(base, ...rel.split('/'));
        const buf = readBytes(abs);
        if (buf === null) continue;
        try {
          writeAtomic(path.join(localBackupDir(base, id), 'files', ...rel.split('/')), buf);
        } catch {
          continue;
        }
        if (!data.roots.some((r) => r.id === rootId)) data.roots.push({ id: rootId, path: base });
        const entry = { root: rootId, rel, existed: true, sha256: sha256(buf), mode: fileMode(abs), kind: 'note', text: ownerHash('note', buf) };
        locals.set(key, entry);
        data.local.push(entry);
      }
      writeBackupJson(dir, data);
    },
    /** Marks the upgrade done and remembers what every recorded file looks like now. */
    finish() {
      for (const f of data.files) f.after = rawHash(absOf(root, f.rel));
      for (const f of data.local) {
        const r = data.roots.find((x) => x.id === f.root);
        f.after = r ? rawHash(path.join(r.path, ...f.rel.split('/'))) : null;
      }
      data.state = 'applied';
      data.finished = new Date().toISOString();
      writeBackupJson(dir, data);
    },
    has: (rel) => entries.has(cleanRel(rel)),
    hasLocal: (rootId, rel) => locals.has(`${rootId}\0${rel}`),
  };
  return backup;
}

/**
 * Upgrade backups, newest first by their creation time (backup.json created), the id breaking
 * ties: [{ id, dir, from, to, created, state, files }].
 */
export function listBackups(root) {
  let names = [];
  try {
    names = fs.readdirSync(absOf(root, BACKUPS_DIR));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!BACKUP_ID_RE.test(name)) continue;
    const dir = absOf(root, `${BACKUPS_DIR}/${name}`);
    const data = readJson(path.join(dir, 'backup.json'));
    if (!data || !Array.isArray(data.files)) continue;
    out.push({ id: name, dir, from: data.from ?? null, to: data.to ?? null, created: data.created ?? null, state: data.state ?? null, files: data.files.length });
  }
  const time = (b) => {
    const t = Date.parse(b.created ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  return out.sort((a, b) => time(b) - time(a) || byCodeUnit(b.id, a.id));
}

/** Removes all but the `keep` newest upgrade backups (never the one a lock names). */
export function pruneBackups(root, keep = KEEP_BACKUPS) {
  const lock = lockState(root);
  const removed = [];
  for (const b of listBackups(root).slice(keep)) {
    if (lock?.backup === b.id) continue;
    removeBackup(b.dir);
    removed.push(b.id);
  }
  return removed;
}

/** Removes a folder when it is empty; true when it is gone. */
function rmdirIfEmpty(abs) {
  try {
    if (fs.readdirSync(abs).length) return false;
    fs.rmdirSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Removes rel and its parents while they are empty (never the vault root). */
function removeEmptyDirs(root, rel) {
  for (let dir = rel; dir; dir = parentOf(dir)) {
    if (!rmdirIfEmpty(absOf(root, dir))) return;
  }
}

/**
 * How a recorded file stands against its backup (buf: its bytes now, or null):
 * 'same'     nothing to do: it holds its saved bytes, or the upgrade left it as it was (a later
 *            change is then the owner's and stays);
 * 'restore'  it holds what the upgrade left, or differs from its saved bytes only where the
 *            checks rewrite (a generated file, a note's line ends, the kit's .gitignore block);
 * 'conflict' it changed after the upgrade, also after an interrupted one: restoring it would lose
 *            that change, so it takes force and its bytes are saved first.
 * A file that did not exist before counts as the upgrade's only when the upgrade wrote it or the
 * checks create it; any other is never removed without a copy.
 */
function entryState(f, buf) {
  const current = buf === null ? null : sha256(buf);
  const target = f.existed ? f.sha256 : null;
  if (current === target) return 'same';
  const finished = Object.hasOwn(f, 'after');
  if (finished && f.after === target) return 'same';
  // Stopped before it finished: a file the upgrade planned to leave as it was is the owner's too.
  if (!finished && f.existed && f.next === f.sha256 && !f.kind) return 'same';
  if (f.kind === 'generated') return 'restore';
  const ours = f.existed || f.next !== undefined || Boolean(f.kind);
  const produced = finished && ours ? f.after : f.next;
  if (produced !== undefined && current === produced) return 'restore';
  if ((f.kind === 'note' || f.kind === 'gitignore') && typeof f.text === 'string' && ownerHash(f.kind, buf) === f.text) return 'restore';
  return 'conflict';
}

/**
 * The temporary files (.<name>.tmp-<pid>-<random>, see fsafe.writeAtomic) that a killed or failed
 * write of the upgrade's own process left next to a file it records; removes them → their rels.
 */
function removeTempFiles(root, data) {
  if (!Number.isInteger(data.pid)) return [];
  const byDir = new Map();
  for (const f of data.files) {
    const dir = parentOf(f.rel);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(dir ? f.rel.slice(dir.length + 1) : f.rel);
  }
  const removed = [];
  for (const [dir, names] of [...byDir].sort(([a], [b]) => byCodeUnit(a, b))) {
    let list;
    try {
      list = fs.readdirSync(dir ? absOf(root, dir) : root).sort(byCodeUnit);
    } catch {
      continue;
    }
    for (const name of list) {
      const m = /^\.(.+)\.tmp-(\d+)-[a-z0-9]+$/.exec(name);
      if (!m || Number(m[2]) !== data.pid || !names.has(m[1])) continue;
      const rel = dir ? `${dir}/${name}` : name;
      unlinkRetry(absOf(root, rel));
      removed.push(rel);
    }
  }
  return removed;
}

/**
 * Restores a backup: files that existed get their saved bytes back, files that did not exist are
 * removed, and so are the folders the upgrade created (when empty) and the temporary files its
 * killed writes left. A file changed after the upgrade (entryState) is a conflict: nothing is
 * restored unless force, and then its bytes are saved first under conflicts/<rel>. A note of a
 * local root only gets its line ends, BOM or NFC form back: when its text changed meanwhile, or
 * its root or saved copy is not there now, it stays as it is (skipped).
 * → { restored, removed, same, conflicts, skipped, temp, applied }; local notes are named
 * '<root id>:<rel>'.
 */
export function restoreBackup(root, backupDir, { force = false, dryRun = false } = {}) {
  const data = readJson(path.join(backupDir, 'backup.json'));
  const invalid = () => new UpgradeError('backup_invalid', { dir: backupDir }, `the backup in ${backupDir} cannot be read`);
  if (!data || !Array.isArray(data.files)) throw invalid();
  const inside = (rel) => typeof rel === 'string' && rel !== '' && cleanRel(rel) === rel && !/^(?:[A-Za-z]:|\/)/.test(rel)
    && !rel.split('/').includes('..');
  const items = [];
  for (const f of data.files) {
    if (!inside(f?.rel)) throw invalid();
    const parts = f.rel.split('/');
    items.push({ f, name: f.rel, abs: absOf(root, f.rel), saved: path.join(backupDir, 'files', ...parts), keep: path.join(backupDir, 'conflicts', ...parts) });
  }
  if (items.some((it) => it.f.existed && !isFile(it.saved))) throw invalid();
  const skipped = [];
  const roots = Array.isArray(data.roots) ? data.roots : [];
  for (const f of Array.isArray(data.local) ? data.local : []) {
    const base = roots.find((r) => r?.id === f?.root)?.path;
    if (typeof base !== 'string' || !path.isAbsolute(base) || !inside(f.rel) || f.existed !== true || f.kind !== 'note') throw invalid();
    const parts = f.rel.split('/');
    const item = { f, name: `${f.root}:${f.rel}`, abs: path.join(base, ...parts), saved: path.join(localBackupDir(base, path.basename(backupDir)), 'files', ...parts), local: true };
    if (isFile(item.saved)) items.push(item);
    else skipped.push(item.name);
  }

  const todo = [];
  const conflicts = [];
  let same = 0;
  for (const it of items) {
    const state = entryState(it.f, readBytes(it.abs));
    if (state === 'same') {
      same++;
    } else if (it.local && state === 'conflict') {
      skipped.push(it.name); // the owner's text changed: theirs stays
    } else {
      if (state === 'conflict') conflicts.push(it.name);
      todo.push({ ...it, conflict: state === 'conflict' });
    }
  }
  const result = {
    restored: todo.filter((it) => it.f.existed).map((it) => it.name),
    removed: todo.filter((it) => !it.f.existed).map((it) => it.name),
    same,
    conflicts,
    skipped,
    temp: [],
    applied: false,
  };
  if (dryRun || (conflicts.length && !force)) return result;
  for (const it of todo) {
    if (it.conflict && isFile(it.abs)) copyAtomic(it.abs, it.keep);
    if (it.f.existed) {
      copyAtomic(it.saved, it.abs, it.f.mode !== undefined ? { mode: it.f.mode } : undefined);
      if (rawHash(it.abs) !== it.f.sha256) throw new UpgradeError('restore_failed', { rel: it.name }, `restoring ${it.name} failed`);
    } else {
      unlinkRetry(it.abs);
    }
  }
  result.temp = removeTempFiles(root, data);
  // Only folders the upgrade created go, deepest first, and only when empty.
  const createdDirs = Array.isArray(data.dirs) ? [...data.dirs].sort((a, b) => b.split('/').length - a.split('/').length || byCodeUnit(a, b)) : [];
  for (const rel of createdDirs) if (inside(rel)) rmdirIfEmpty(absOf(root, rel));
  result.applied = true;
  return result;
}

/** Marks a backup as restored (a later plain --rollback then has nothing to do). */
function markRestored(backupDir) {
  const data = readJson(path.join(backupDir, 'backup.json'));
  if (!data) return;
  data.state = 'restored';
  data.restored = new Date().toISOString();
  writeBackupJson(backupDir, data);
}

/**
 * `upgrade --rollback [id]`: restores the named backup, else the one an interrupted upgrade's
 * lock names, else the newest. Refused while an upgrade is still at work (its lock's process
 * lives). → { id, from, to, state, restored, removed, same, conflicts, temp, applied, already,
 * lockRemoved, savedIn } (savedIn: the backup folder that keeps the conflicting files, if any).
 */
export function rollbackUpgrade(root, { id, force = false, dryRun = false } = {}) {
  const lock = lockState(root);
  if (lock?.running) {
    throw new UpgradeError('rollback_running', { pid: lock.pid, from: lock.from ?? '–', to: lock.to ?? '–' },
      `an upgrade ${lock.from ?? '–'} → ${lock.to ?? '–'} is running right now (process ${lock.pid}); wait for it to finish`);
  }
  const backups = listBackups(root);
  const ids = backups.map((b) => b.id).join(', ') || '–';
  const nothing = (b, extra) => ({
    id: b?.id ?? null, from: b?.from ?? null, to: b?.to ?? null, state: b?.state ?? null,
    restored: [], removed: [], same: 0, conflicts: [], skipped: [], temp: [], applied: false, already: false, lockRemoved: false,
    savedIn: null, ...extra,
  });
  let chosen;
  if (id) {
    chosen = backups.find((b) => b.id === id);
    if (!chosen) throw new UpgradeError('rollback_not_found', { id, ids }, `backup "${id}" not found; available: ${ids}`);
  } else if (lock) {
    chosen = lock.backup ? backups.find((b) => b.id === lock.backup) : undefined;
    if (!chosen) {
      // A lock whose backup is gone: there is nothing to restore, --force clears it.
      if (!force) {
        throw new UpgradeError('rollback_orphan_lock', { id: lock.backup ?? '–' },
          `an interrupted upgrade left its lock, but its backup ${lock.backup ?? '–'} is gone; --force removes the lock`);
      }
      if (!dryRun) unlinkRetry(absOf(root, LOCK_FILE));
      return nothing(null, { lockRemoved: !dryRun });
    }
  } else {
    chosen = backups[0];
    if (!chosen) throw new UpgradeError('rollback_none', {}, 'there is no upgrade backup to restore');
    if (chosen.state === 'restored') return nothing(chosen, { already: true });
  }
  // Finished or interrupted, a file changed after the upgrade is never overwritten unasked.
  const res = restoreBackup(root, chosen.dir, { force, dryRun });
  let lockRemoved = false;
  if (res.applied) {
    markRestored(chosen.dir);
    if (lock && (lock.backup === chosen.id || !lock.backup)) {
      unlinkRetry(absOf(root, LOCK_FILE));
      lockRemoved = true;
    }
  }
  const savedIn = res.applied && res.conflicts.length ? `${BACKUPS_DIR}/${chosen.id}` : null;
  return { ...nothing(chosen), ...res, lockRemoved, savedIn };
}

// ---------------------------------------------------------------------------------------------
// Verification: the vault's own CLI before and after

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('MEMORY_KIT_UPGRADE_')) delete env[key];
  return env;
}

/** Runs node <root>/system/memory.mjs <args> --root <root>: { code, stdout, stderr }. */
export function runVaultCli(root, args) {
  touchLock(absOf(root, LOCK_FILE));
  const res = spawnSync(process.execPath, [absOf(root, 'system/memory.mjs'), ...args, '--root', root], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: CHILD_TIMEOUT_MS,
    env: childEnv(),
  });
  const code = res.error ? 3 : Number.isInteger(res.status) ? res.status : 3;
  return { code, stdout: res.stdout ?? '', stderr: res.stderr || res.error?.message || '' };
}

function parseJsonOut(stdout) {
  const text = String(stdout ?? '');
  const at = text.indexOf('{');
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}

function findingsOf(parsed) {
  if (!parsed) return null;
  const out = [];
  for (const [severity, list] of [['error', parsed.errors], ['warning', parsed.warnings]]) {
    for (const f of Array.isArray(list) ? list : []) {
      out.push({ key: `${severity}|${f.code}|${f.root ?? 'main'}|${f.rel}`, severity, code: f.code, rel: f.rel ?? null, root: f.root ?? 'main' });
    }
  }
  return out;
}

function lastLine(text) {
  return String(text ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
}

/** Before applying: the vault's current check (lenient) and eval (when a golden file exists). */
export function verifyBefore(root, { golden }) {
  const check = runVaultCli(root, ['check', '--lenient', '--json']);
  const before = { check: { code: check.code, findings: findingsOf(parseJsonOut(check.stdout)) }, eval: null };
  if (golden && isFile(absOf(root, golden))) {
    const ev = parseJsonOut(runVaultCli(root, ['eval', '--json']).stdout);
    if (ev && typeof ev.hit3 === 'number') before.eval = { hit3: ev.hit3, hits: ev.hits ?? null, total: ev.total ?? null };
  }
  return before;
}

/**
 * Every file under root, the main root or a local one (POSIX rels, with size and mtime), and
 * every folder, outside .git, .memory-kit and node_modules.
 */
function listTree(root) {
  const files = new Map();
  const dirs = new Set();
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(rel ? absOf(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (WALK_SKIP.has(e.name)) continue;
        dirs.add(r);
        walk(r);
      } else if (e.isFile()) {
        let stamp = '';
        try {
          const st = fs.statSync(absOf(root, r));
          stamp = `${st.size}:${st.mtimeMs}`;
        } catch {
          /* vanished meanwhile */
        }
        files.set(r, stamp);
      }
    }
  };
  walk('');
  return { files, dirs };
}

/** True when check --generate would rewrite this note: a BOM, CRLF or text that is not NFC. */
function needsNormalizing(abs) {
  const buf = readBytes(abs);
  if (buf === null) return false;
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff || text.includes('\r\n') || text !== text.normalize('NFC');
}

/**
 * Where the checks write in the main root, as config.mjs resolves it (the vault's language pack,
 * then English): { home: the generated home page, handWritten: RegExp of the archived copies of a
 * hand-written home note, <archive>/<home>-hand-written[-n].md }.
 */
function generatedNames(root, lang) {
  const packs = [...new Set([lang, 'en'])].map((code) => readJson(absOf(root, `system/lang/${code}/pack.json`)));
  const pick = (table, key, fallback) => {
    for (const pack of packs) {
      const raw = pack?.[table]?.[key];
      const value = typeof raw === 'string' ? cleanRel(raw.trim()).replace(/^\/+/, '') : '';
      if (value) return value;
    }
    return fallback;
  };
  const name = pick('files', 'home', 'home');
  const home = name.endsWith('.md') ? name : `${name}.md`;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const handWritten = new RegExp(`^${escape(pick('dirs', 'archive', 'archive'))}/${escape(home.slice(0, -3))}-hand-written(?:-\\d+)?\\.md$`);
  return { home, handWritten };
}

/**
 * Files that the verification's `check --generate` may rewrite, as backup items: the generated
 * views (kind 'generated'), .gitignore (its kit block) and markdown files it would normalize
 * (CRLF, BOM, not NFC). The search log is not one: the verification puts it back itself.
 */
function volatileFiles(root, lang, tree) {
  const out = new Map([['.ignore', 'generated'], ['.gitignore', 'gitignore'], [generatedNames(root, lang).home, 'generated']]);
  for (const rel of tree.files.keys()) {
    if (rel.startsWith('_ai/')) {
      out.set(rel, 'generated');
      continue;
    }
    if (out.has(rel) || !rel.endsWith('.md') || rel.startsWith('system/')) continue;
    if (needsNormalizing(absOf(root, rel))) out.set(rel, 'note');
  }
  return [...out].sort(([a], [b]) => byCodeUnit(a, b)).map(([rel, kind]) => ({ rel, kind }));
}

/**
 * What the checks may have created at rel, as a backup item, or null for a file they never
 * create (another program wrote it meanwhile: it is never recorded, so a rollback leaves it).
 */
function createdItem(root, rel, names) {
  if (rel.startsWith('_ai/') || rel === '.ignore' || rel === names.home) return { rel, kind: 'generated' };
  if (rel === '.gitignore') return { rel, kind: 'gitignore' };
  // The archived hand-written home page: removed on rollback only while it holds what was moved there.
  if (names.handWritten.test(rel)) return { rel, next: rawHash(absOf(root, rel)) };
  return null;
}

/**
 * The local roots of the vault's memory.json that exist on this machine, outside the vault:
 * [{ id, path }]. The checks read and normalize their notes too.
 */
function localRoots(root) {
  const roots = readVaultConfig(root).raw?.roots;
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots.slice(1)) {
    if (!r || typeof r.id !== 'string' || typeof r.path !== 'string' || !r.path.trim()) continue;
    const given = r.path.trim();
    const abs = path.resolve(root, process.platform === 'win32' ? given : given.replace(/\\/g, '/'));
    if (insideDir(root, abs) || !isDirectory(abs) || out.some((x) => x.id === r.id)) continue;
    out.push({ id: r.id, path: abs });
  }
  return out;
}

/** Files of `before` that changed or vanished in `now` and that recorded(rel) does not hold. */
function changedFiles(before, now, recorded) {
  return [...before.files].filter(([rel, stamp]) => !recorded(rel) && now.files.get(rel) !== stamp).map(([rel]) => rel).sort(byCodeUnit);
}

/**
 * After applying: check --generate must not fail internally, start must print a real view,
 * search must run, eval must not lose hit@3. Records everything these runs may change in the
 * backup first (local-root notes they normalize too), so a rollback restores it. Afterwards the
 * files they created are recorded, but only those the checks create: a new file of another program
 * (a sync client, an editor, an agent) is listed in `foreign` and never removed. A file they changed
 * that was not recorded is listed in `unrecorded` ('<root id>:<rel>' for a local root).
 * → { ok, step, detail, newFindings, eval, unrecorded, foreign }.
 */
export function verifyAfter(root, before, backup, { lang }) {
  const tree = listTree(root);
  const locals = localRoots(root).map((r) => ({ ...r, tree: listTree(r.path) }));
  backup.recordMany(volatileFiles(root, lang, tree));
  backup.recordLocal(locals.flatMap((r) => [...r.tree.files.keys()].sort(byCodeUnit)
    .filter((rel) => rel.endsWith('.md') && needsNormalizing(path.join(r.path, ...rel.split('/'))))
    .map((rel) => ({ root: r.id, base: r.path, rel }))));
  const out = { ok: true, step: null, detail: '', newFindings: [], eval: null, unrecorded: [], foreign: [] };
  const fail = (step, detail) => Object.assign(out, { ok: false, step, detail: String(detail ?? '').trim() });
  try {
    const check = runVaultCli(root, ['check', '--generate', '--lenient', '--json']);
    if (check.code === 3 || check.code === null) return fail('check', lastLine(check.stderr) || `exit ${check.code}`);
    const after = findingsOf(parseJsonOut(check.stdout)) ?? [];
    if (before?.check?.findings) {
      const seen = new Set(before.check.findings.map((f) => f.key));
      out.newFindings = after.filter((f) => !seen.has(f.key)).map(({ key, ...f }) => f);
    }

    const start = runVaultCli(root, ['start']);
    if (start.code !== 0) return fail('start', lastLine(start.stderr) || `exit ${start.code}`);
    if (!start.stdout.trim()) return fail('start', 'no output');
    const fallback = start.stdout.split('\n').find((l) => l.startsWith(START_FAILED));
    if (fallback) return fail('start', fallback);

    const logRel = 'system/usage/search.log';
    const logAbs = absOf(root, logRel);
    const logBefore = isFile(logAbs) ? fs.readFileSync(logAbs) : null;
    const search = runVaultCli(root, ['search', 'memory', '--json']);
    const logAfter = isFile(logAbs) ? fs.readFileSync(logAbs) : null;
    if (logAfter && (!logBefore || !logBefore.equals(logAfter))) {
      // The verification's own query does not belong in the owner's search log.
      if (logBefore) {
        writeAtomic(logAbs, logBefore);
      } else {
        unlinkRetry(logAbs);
        if (!tree.dirs.has(parentOf(logRel))) rmdirIfEmpty(absOf(root, parentOf(logRel)));
      }
    }
    if (search.code !== 0) return fail('search', lastLine(search.stderr) || `exit ${search.code}`);

    if (before?.eval) {
      const ev = parseJsonOut(runVaultCli(root, ['eval', '--json']).stdout);
      if (!ev || typeof ev.hit3 !== 'number') return fail('eval', 'eval printed no result');
      out.eval = { before: before.eval.hit3, after: ev.hit3 };
      if (ev.hit3 < before.eval.hit3 - 1e-9) return fail('eval', `hit@3 ${ev.hit3.toFixed(2)} < ${before.eval.hit3.toFixed(2)}`);
    }
    return out;
  } finally {
    const now = listTree(root);
    const names = generatedNames(root, lang);
    const created = [];
    for (const rel of [...now.files.keys()].filter((r) => !tree.files.has(r)).sort(byCodeUnit)) {
      const item = createdItem(root, rel, names);
      if (item) created.push(item);
      else out.foreign.push(rel);
    }
    backup.recordCreated(created, tree.dirs);
    out.unrecorded = changedFiles(tree, now, (rel) => backup.has(rel));
    for (const r of locals) {
      const changed = changedFiles(r.tree, listTree(r.path), (rel) => backup.hasLocal(r.id, rel));
      out.unrecorded.push(...changed.map((rel) => `${r.id}:${rel}`));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Applying

/** Writes the lock; without replace an existing lock (a concurrent upgrade) is an UpgradeError. */
function writeLock(root, data, replace) {
  const abs = absOf(root, LOCK_FILE);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (replace) {
    writeAtomic(abs, text);
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.writeFileSync(abs, text, { flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const lock = lockState(root);
    throw new UpgradeError('locked', { backup: lock?.backup ?? '–', from: lock?.from ?? '–', to: lock?.to ?? '–' });
  }
}

function copyKitFile(sourceRoot, rel, destAbs) {
  const mode = rel.startsWith('.githooks/') ? 0o755 : undefined;
  copyAtomic(absOf(sourceRoot, rel), destAbs, mode === undefined ? undefined : { mode });
}

function sameBytes(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// The entry point of the recovery tool (see writeRecoveryTool). English only: it runs when the
// vault's own code, its language packs included, may be half replaced.
const ROLLBACK_TOOL = [
  '#!/usr/bin/env node',
  '// Undoes the memory-kit upgrade this backup belongs to, with the upgrader that made it. It works',
  '// while the vault\'s own code is half replaced (an interrupted upgrade). Run it from anywhere:',
  '//   node <vault>/.memory-kit/backups/<id>/tool/rollback.mjs [--force] [--dry-run] [--json]',
  '',
  'import path from \'node:path\';',
  'import { fileURLToPath } from \'node:url\';',
  'import { UpgradeError, rollbackUpgrade } from \'./upgrade.mjs\';',
  '',
  'const here = path.dirname(fileURLToPath(import.meta.url));',
  'const id = path.basename(path.dirname(here));',
  'const root = path.resolve(here, \'..\', \'..\', \'..\', \'..\');',
  '',
  'function main(args) {',
  '  const has = (flag) => args.includes(flag);',
  '  if (args.some((a) => ![\'--force\', \'--dry-run\', \'--json\'].includes(a))) {',
  '    process.stderr.write(\'usage: node \' + path.join(here, \'rollback.mjs\') + \' [--force] [--dry-run] [--json]\\n\');',
  '    return 2;',
  '  }',
  '  let res;',
  '  try {',
  '    res = rollbackUpgrade(root, { id, force: has(\'--force\'), dryRun: has(\'--dry-run\') });',
  '  } catch (err) {',
  '    if (!(err instanceof UpgradeError)) throw err;',
  '    process.stderr.write(\'memory: \' + err.message + \'\\n\');',
  '    return 1;',
  '  }',
  '  const refused = res.conflicts.length > 0 && !res.applied && !has(\'--dry-run\');',
  '  if (has(\'--json\')) {',
  '    process.stdout.write(JSON.stringify({ rollback: { ok: !refused, ...res } }, null, 2) + \'\\n\');',
  '    return refused ? 1 : 0;',
  '  }',
  '  const lines = [];',
  '  if (res.applied) {',
  '    lines.push(\'backup \' + id + \' restored, the upgrade \' + res.from + \' → \' + res.to + \' is undone: \'',
  '      + res.restored.length + \' files restored, \' + res.removed.length + \' removed\');',
  '  } else {',
  '    lines.push(\'backup \' + id + \' would restore \' + res.restored.length + \' files and remove \' + res.removed.length',
  '      + \'; nothing was changed\');',
  '  }',
  '  if (res.conflicts.length) {',
  '    lines.push(res.applied',
  '      ? \'these files had changed after the upgrade; your version of each is saved under \' + res.savedIn + \':\'',
  '      : \'these files changed after the upgrade, so nothing was restored; --force restores them anyway (their current version is saved in the backup):\');',
  '    for (const name of res.conflicts) lines.push(\'  \' + name);',
  '  }',
  '  if (res.lockRemoved) lines.push(\'the lock of the interrupted upgrade was removed\');',
  '  process.stdout.write(lines.join(\'\\n\') + \'\\n\');',
  '  return refused ? 1 : 0;',
  '}',
  '',
  'process.exitCode = main(process.argv.slice(2));',
  '',
].join('\n');

/**
 * Copies this upgrader (the modules of TOOL_FILES, which import nothing else) into the backup's
 * tool/ folder with a rollback.mjs entry point, so `node <recoveryTool(id)>` undoes the upgrade
 * even when the vault's code is half replaced and the kit it came from is gone.
 */
function writeRecoveryTool(backupDir) {
  const dir = path.join(backupDir, 'tool');
  for (const name of TOOL_FILES) copyAtomic(path.join(HERE, name), path.join(dir, name));
  writeAtomic(path.join(dir, 'rollback.mjs'), ROLLBACK_TOOL);
}

/** The new AGENTS.md bytes the plan writes (its kit section replaced), or null. */
function newAgents(plan) {
  if (plan.agents.action !== 'replace') return null;
  const buf = readBytes(absOf(plan.vault, AGENTS_FILE));
  const template = agentsTemplate(plan.source, plan.lang);
  if (buf === null || !template) return null;
  const res = replaceKitBlockBytes(buf, template.text);
  return res.state === 'replaced' ? res.bytes : null;
}

/**
 * The backup items of a plan: plannedPaths, each with the hash the apply writes there when that is
 * known beforehand (next; null for a removal), so a rollback tells the upgrade's writes from later
 * edits even when the upgrade was interrupted. Without migrations nothing else writes, so a file
 * the apply leaves alone (memory.json, a skipped AGENTS.md) gets its own hash as next.
 */
function plannedItems(plan, agents) {
  const next = new Map();
  for (const f of plan.files) {
    if (WRITE_ACTIONS.has(f.action)) next.set(f.rel, rawHash(absOf(plan.source, f.rel)));
    else if (f.action === 'remove') next.set(f.rel, null);
  }
  for (const rel of LAST_FILES) {
    const from = absOf(plan.source, rel);
    if (isFile(from) && !sameBytes(from, absOf(plan.vault, rel))) next.set(rel, rawHash(from));
  }
  if (agents) next.set(AGENTS_FILE, sha256(agents));
  const left = (rel) => (plan.migrations.length ? null : rawHash(absOf(plan.vault, rel)));
  return plannedPaths(plan).map((rel) => {
    if (next.has(rel)) return { rel, next: next.get(rel) };
    const hash = left(rel);
    return hash === null ? rel : { rel, next: hash };
  });
}

/**
 * Applies a plan (plan.ok must be true): backup (with a recovery tool), lock, kit files, proposed
 * copies, removals, the AGENTS.md kit section, migrations, then kit-history.json, VERSION and
 * kit.json last. With verify the vault's CLI checks the result; any failure restores the backup.
 * The lock stays until the checks pass, so an upgrade killed half way is refused until --rollback.
 * → result object.
 */
export async function applyUpgrade(plan, { verify = true, now = new Date(), migrations } = {}) {
  if (!plan?.ok) throw new Error('the upgrade plan is not applicable');
  const root = plan.vault;
  const src = plan.source;
  const result = {
    applied: false,
    backup: null,
    written: [],
    removed: [],
    proposed: [],
    agents: plan.agents.action,
    migrations: [],
    verify: null,
    failure: null,
    rolledBack: false,
    pruned: [],
    excluded: false,
  };
  const before = verify ? verifyBefore(root, { golden: plan.golden }) : null;
  const agents = newAgents(plan);
  if (plan.agents.action === 'replace' && !agents) result.agents = 'skip';
  const backup = createBackup(root, { from: plan.from, to: plan.to, now });
  result.backup = backup.id;
  try {
    backup.recordMany(plannedItems(plan, agents));
    writeRecoveryTool(backup.dir);
    writeLock(root, {
      backup: backup.id, from: plan.from, to: plan.to, started: now.toISOString(), pid: process.pid, host: os.hostname(),
      runner: src, recover: recoveryTool(backup.id),
    }, Boolean(plan.lock));
  } catch (err) {
    removeBackup(backup.dir);
    throw err;
  }

  const rollback = (step, err, { unrecorded = [], foreign = [] } = {}) => {
    result.failure = { step, detail: String(err?.message ?? err ?? '').trim(), unrecorded, foreign, saved: [], savedIn: null };
    try {
      // force: a file another program changed meanwhile is restored too, but only after its bytes
      // are saved in the backup, which then stays.
      const res = restoreBackup(root, backup.dir, { force: true });
      if (result.proposed.length) removeTree(absOf(root, plan.proposedDir.slice(0, plan.proposedDir.lastIndexOf('/'))));
      if (res.conflicts.length) {
        markRestored(backup.dir);
        Object.assign(result.failure, { saved: res.conflicts, savedIn: `${BACKUPS_DIR}/${backup.id}` });
      } else {
        removeBackup(backup.dir);
      }
      unlinkRetry(absOf(root, LOCK_FILE));
      result.rolledBack = true;
    } catch (restoreErr) {
      result.failure.restore = String(restoreErr?.message ?? restoreErr);
    }
    return result;
  };

  try {
    try {
      result.excluded = ensureExcluded(root);
    } catch {
      result.excluded = false; // a nicety; the upgrade does not depend on it
    }
    for (const f of plan.files) {
      if (!WRITE_ACTIONS.has(f.action) || LAST_FILES.includes(f.rel)) continue;
      copyKitFile(src, f.rel, absOf(root, f.rel));
      result.written.push(f.rel);
    }
    const proposals = plan.files.filter((f) => f.action === 'propose');
    if (proposals.length) {
      removeTree(absOf(root, plan.proposedDir.slice(0, plan.proposedDir.lastIndexOf('/'))));
      for (const f of proposals) {
        const rel = `${plan.proposedDir}/${f.rel}`;
        copyKitFile(src, f.rel, absOf(root, rel));
        result.proposed.push({ rel: f.rel, path: rel });
      }
    }
    for (const f of plan.files) {
      if (f.action !== 'remove') continue;
      unlinkRetry(absOf(root, f.rel));
      removeEmptyDirs(root, parentOf(f.rel));
      result.removed.push(f.rel);
    }
    if (agents) {
      writeAtomic(absOf(root, AGENTS_FILE), agents);
      result.written.push(AGENTS_FILE);
    }
    if (plan.migrations.length) {
      const list = migrations ?? await loadMigrations(src);
      const chain = migrationChain(list, plan.dataVersion.from, plan.dataVersion.to) ?? [];
      touchLock(absOf(root, LOCK_FILE));
      result.migrations = await runMigrations(chain, {
        root, lang: plan.lang, record: (rel) => backup.record(rel), wrote: (rel) => backup.wrote(rel),
      });
    }
    for (const rel of LAST_FILES) {
      const from = absOf(src, rel);
      const to = absOf(root, rel);
      if (!isFile(from) || sameBytes(from, to)) continue;
      copyKitFile(src, rel, to);
      result.written.push(rel);
    }
  } catch (err) {
    return rollback('apply', err);
  }

  if (verify) {
    let v;
    try {
      v = verifyAfter(root, before, backup, { lang: plan.lang });
    } catch (err) {
      v = { ok: false, step: 'verify', detail: err?.message ?? String(err), newFindings: [], eval: null, unrecorded: [], foreign: [] };
    }
    result.verify = {
      ok: v.ok, step: v.step, eval: v.eval, newFindings: v.newFindings, before: before?.check?.code ?? null, foreign: v.foreign ?? [],
    };
    if (!v.ok) return rollback(v.step, v.detail, v);
  }

  // Another command (a --rollback in a second terminal) may have undone this upgrade meanwhile:
  // then the upgrade is not finished, and its backup must not claim otherwise.
  if (lockState(root)?.backup !== backup.id || !isFile(path.join(backup.dir, 'backup.json'))) {
    result.failure = { step: 'lock', detail: 'undone meanwhile', undone: true, unrecorded: [], foreign: [], saved: [], savedIn: null };
    return result;
  }
  backup.finish();
  unlinkRetry(absOf(root, LOCK_FILE));
  result.pruned = pruneBackups(root);
  result.applied = true;
  return result;
}
