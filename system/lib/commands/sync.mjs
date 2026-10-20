// `sync`: git pull --rebase, resolve conflicts that touch only generated files (_ai/, .ignore,
// the home page) by regenerating them and notes that both sides only added lines to by merging
// them (lib/appendmerge.mjs), then push (docs/architecture.md, 10.5). Never force-pushes, never resolves a conflict in a
// note: any other conflict aborts the rebase and exits 1. It never commits: uncommitted changes to
// tracked files stop it at once (exit 1) with the commands that commit them, before git refuses the
// pull with its own words. fastForward() is the quiet part the session start runs with autosync
// on: fetch, and fast-forward a clean vault that is only behind.

import fs from 'node:fs';
import path from 'node:path';
import { writeGenerated } from '../generate.mjs';
import { mergeAdditions } from '../appendmerge.mjs';
import { loadVault } from '../vault.mjs';
import { spawnSync } from 'node:child_process';
import { checkToday, git, gitRepoState, parseCli, usageError } from '../util.mjs';

export const usage = 'sync [--no-push] [--today YYYY-MM-DD]';

const MAX_ROUNDS = 20;
const PUSH_ATTEMPTS = 3;

// sync runs unattended (hooks, agents, GUI hosts): git must never wait for a person. A missing
// credential fails instead of prompting, and continuing a rebase never opens an editor, whatever
// GIT_EDITOR the shell exports (it outranks core.editor).
const NO_PROMPT = { GIT_TERMINAL_PROMPT: '0' };
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

class SyncError extends Error {}

/**
 * Takes in what other devices pushed, never more: fetch (at most `timeout` ms), then a
 * fast-forward only when the vault has an upstream, no change to tracked files and is behind but
 * not ahead. { n: commits taken in, fetched: false and why when the fetch failed }. Never throws.
 */
export function fastForward(root, { timeout = 6000 } = {}) {
  const run = (args, ms = 3000) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: ms, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...NO_PROMPT } });
  try {
    if (run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).status !== 0) return { n: 0 };
    if (run(['status', '--porcelain', '--untracked-files=no']).stdout.trim()) return { n: 0 };
    const fetch = run(['fetch', '--quiet'], timeout);
    if (fetch.status !== 0) {
      const why = `${fetch.stderr ?? ''}`.split('\n').map((l) => l.trim()).find(Boolean) ?? (fetch.error?.code === 'ETIMEDOUT' ? 'timeout' : `exit ${fetch.status}`);
      return { n: 0, fetched: false, why };
    }
    const counts = run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']).stdout.trim().split(/\s+/).map(Number);
    const [ahead, behind] = counts.length === 2 ? counts : [0, 0];
    if (!behind || ahead) return { n: 0 };
    if (run(['merge', '--ff-only', '--quiet', '@{u}']).status !== 0) return { n: 0, merged: false };
    return { n: behind };
  } catch {
    return { n: 0 };
  }
}

function rebaseInProgress(root) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const res = git(root, ['rev-parse', '--git-path', name], { allowFail: true });
    if (!res.ok) continue;
    const p = res.stdout.trim();
    if (p && fs.existsSync(path.resolve(root, p))) return true;
  }
  return false;
}

/**
 * Tracked files with changes that are not committed (staged or not), in NFC; untracked files do
 * not stop a pull. Empty while a rebase or merge waits: git's own message says more then.
 */
function uncommitted(root) {
  const res = git(root, ['status', '--porcelain', '-z', '--untracked-files=no'], { allowFail: true });
  if (!res.ok) return [];
  const out = [];
  const parts = res.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3).normalize('NFC'));
    // A rename or copy is followed by its old name, which is no file of its own.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return out;
}

/** Conflicted paths in NFC (git prints names as stored, NFD on some disks). */
function conflictedFiles(root) {
  const res = git(root, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true });
  return res.stdout.split('\0').filter(Boolean).map((rel) => rel.normalize('NFC')).sort();
}

function isGenerated(cfg, rel) {
  return rel.startsWith(`${cfg.dirs.ai}/`) || rel === cfg.files.ignore || rel === cfg.files.home;
}

/**
 * A conflicted markdown note that both sides only added to (lib/appendmerge.mjs): written merged
 * and staged. True when it was merged; false leaves it to the owner.
 */
function mergeNote(root, rel) {
  if (!rel.endsWith('.md')) return false;
  const stage = (n) => {
    const res = git(root, ['show', `:${n}:${rel}`], { allowFail: true });
    return res.ok ? res.stdout : null;
  };
  const merged = mergeAdditions(stage(1), stage(2), stage(3));
  if (merged === null) return false;
  fs.writeFileSync(path.join(root, ...rel.split('/')), merged);
  return git(root, ['add', '--', rel], { allowFail: true }).ok;
}

/** Pull with rebase; conflicts only in _ai/ or .ignore are regenerated, anything else aborts. */
async function pull(cfg, today) {
  const root = cfg.root;
  const res = git(root, ['pull', '--rebase'], { allowFail: true, env: { ...NO_PROMPT, ...NO_EDITOR } });
  if (res.ok) return false;
  if (!rebaseInProgress(root)) {
    throw new SyncError(cfg.t('sync.failed', { step: 'pull --rebase', detail: (res.stderr || res.stdout).trim() }));
  }
  let regenerated = false;
  for (let round = 0; round < MAX_ROUNDS && rebaseInProgress(root); round++) {
    // Notes two devices only added to are merged line by line; the rest must be generated files.
    const files = conflictedFiles(root).filter((f) => isGenerated(cfg, f) || !mergeNote(root, f));
    if (files.some((f) => !isGenerated(cfg, f))) {
      git(root, ['rebase', '--abort'], { allowFail: true });
      throw new SyncError(cfg.t('sync.conflict', { files: files.join(', ') }));
    }
    if (files.length) {
      await writeGenerated(cfg, loadVault(cfg), { today });
      git(root, ['add', '-A', '--', cfg.dirs.ai, cfg.files.ignore, cfg.files.home]);
      regenerated = true;
    }
    const cont = git(root, ['-c', 'core.editor=true', 'rebase', '--continue'], { allowFail: true, env: NO_EDITOR });
    if (cont.ok) continue;
    if (!rebaseInProgress(root)) {
      throw new SyncError(cfg.t('sync.failed', { step: 'rebase --continue', detail: (cont.stderr || cont.stdout).trim() }));
    }
    // Regenerating can make a commit identical to what is already upstream: skip that commit.
    const staged = git(root, ['diff', '--cached', '--quiet'], { allowFail: true });
    if (staged.ok && conflictedFiles(root).length === 0) git(root, ['rebase', '--skip'], { allowFail: true });
  }
  if (rebaseInProgress(root)) {
    git(root, ['rebase', '--abort'], { allowFail: true });
    throw new SyncError(cfg.t('sync.too_many', { n: MAX_ROUNDS }));
  }
  return regenerated;
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, { 'no-push': { type: 'boolean' }, today: { type: 'string' } }, usage);
  if (!parsed) return 2;
  if (parsed.positionals.length) {
    usageError(`unexpected argument "${parsed.positionals[0]}"`, usage);
    return 2;
  }
  if (!checkToday(parsed.values.today, usage)) return 2;
  const { today } = parsed.values;
  const root = cfg.root;

  const repo = gitRepoState(root);
  if (repo.state === 'error') {
    // A .git entry that git cannot use (git missing, safe.directory): saying "nothing to sync"
    // would hide that nothing reaches the remote.
    process.stderr.write(`${cfg.t('sync.git_error', { detail: repo.detail || 'git failed' })}\n`);
    return 1;
  }
  if (repo.state !== 'top') {
    process.stdout.write(`${cfg.t('sync.no_git')}\n`);
    return 0;
  }
  // Mode local promises that nothing leaves this computer, even when a remote exists.
  if (cfg.mode === 'local') {
    process.stdout.write(`${cfg.t('sync.local_mode')}\n`);
    return 0;
  }
  const remotes = git(root, ['remote'], { allowFail: true }).stdout.trim();
  if (!remotes) {
    process.stdout.write(`${cfg.t('sync.no_remote')}\n`);
    return 0;
  }
  const changed = rebaseInProgress(root) ? [] : uncommitted(root);
  if (changed.length) {
    const files = `${changed.slice(0, 5).join(', ')}${changed.length > 5 ? `, … +${changed.length - 5}` : ''}`;
    process.stderr.write(`${cfg.t('sync.uncommitted', { n: changed.length, files })}\n`);
    return 1;
  }

  try {
    if (await pull(cfg, today)) process.stdout.write(`${cfg.t('sync.regenerated')}\n`);
    process.stdout.write(`${cfg.t('sync.pulled')}\n`);
    if (parsed.values['no-push']) return 0;
    let last = null;
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      const res = git(root, ['push'], { allowFail: true, env: NO_PROMPT });
      if (res.ok) {
        process.stdout.write(`${cfg.t('sync.pushed')}\n`);
        return 0;
      }
      last = (res.stderr || res.stdout).trim();
      if (attempt < PUSH_ATTEMPTS && (await pull(cfg, today))) {
        process.stdout.write(`${cfg.t('sync.regenerated')}\n`);
      }
    }
    throw new SyncError(cfg.t('sync.failed', { step: 'push', detail: last }));
  } catch (err) {
    if (err instanceof SyncError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
