// `sync`: git pull --rebase, resolve conflicts that touch only generated files (_ai/, .ignore,
// the home page) by regenerating them, then push (docs/architecture.md, 10.5). Never force-pushes, never resolves a conflict in a
// note: any other conflict aborts the rebase and exits 1.

import fs from 'node:fs';
import path from 'node:path';
import { writeGenerated } from '../generate.mjs';
import { loadVault } from '../vault.mjs';
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

function rebaseInProgress(root) {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const res = git(root, ['rev-parse', '--git-path', name], { allowFail: true });
    if (!res.ok) continue;
    const p = res.stdout.trim();
    if (p && fs.existsSync(path.resolve(root, p))) return true;
  }
  return false;
}

/** Conflicted paths in NFC (git prints names as stored, NFD on some disks). */
function conflictedFiles(root) {
  const res = git(root, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true });
  return res.stdout.split('\0').filter(Boolean).map((rel) => rel.normalize('NFC')).sort();
}

function isGenerated(cfg, rel) {
  return rel.startsWith(`${cfg.dirs.ai}/`) || rel === cfg.files.ignore || rel === cfg.files.home;
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
    const files = conflictedFiles(root);
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
