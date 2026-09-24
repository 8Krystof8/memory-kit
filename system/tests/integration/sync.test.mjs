// `sync` against a local bare remote: conflicts only in generated files are regenerated and the
// push goes through; a conflict in a note aborts the rebase and exits 1; never --force
// (docs/architecture.md, section 10.5).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  TODAY, checkJson, describeFindings, fixtureVault, readFile, removeTmpDirs, runCli, tmpDir, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

// A clean git identity and no user or system configuration (signing, hooks, aliases).
function gitEnv() {
  const home = tmpDir('git-home');
  const global = path.join(home, 'gitconfig');
  fs.writeFileSync(global, '');
  return {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'memory-kit test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'memory-kit test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(cwd, env, ...args) {
  const res = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  return res.stdout.trim();
}

/** Machine A with a generated fixture vault pushed to a bare remote, and a clone B of it. */
function twoMachines() {
  const env = gitEnv();
  const fx = fixtureVault('en');
  const a = fx.root;
  const regen = runCli(a, ['check', '--generate', '--lenient', '--today', TODAY], { env });
  assert.equal(regen.code, 0, regen.stdout);
  const remote = path.join(tmpDir('remote'), 'vault.git');
  git(path.dirname(remote), env, 'init', '-q', '--bare', '-b', 'main', remote);
  git(a, env, 'init', '-q', '-b', 'main');
  git(a, env, 'add', '-A');
  git(a, env, 'commit', '-q', '-m', 'vault');
  git(a, env, 'remote', 'add', 'origin', remote);
  git(a, env, 'push', '-q', '-u', 'origin', 'main');
  const b = path.join(tmpDir('machine-b'), 'vault');
  git(path.dirname(b), env, 'clone', '-q', remote, b);
  return { env, a, b, remote };
}

/** Appends a line to a note, regenerates _ai/ and commits: every generated header changes. */
function change(root, env, rel, line) {
  writeFile(root, rel, `${readFile(root, rel)}${line}\n`);
  const res = runCli(root, ['check', '--generate', '--lenient', '--today', TODAY], { env });
  assert.equal(res.code, 0, res.stdout);
  git(root, env, 'add', '-A');
  git(root, env, 'commit', '-q', '-m', `edit ${rel}`);
}

describe('sync', { skip: !HAS_GIT && 'git is not installed' }, () => {
  test('outside git and without a remote: nothing to do, exit 0', () => {
    const fx = fixtureVault('en');
    const env = gitEnv();
    const none = runCli(fx.root, ['sync'], { env });
    assert.equal(none.code, 0, none.stderr);
    git(fx.root, env, 'init', '-q', '-b', 'main');
    const local = runCli(fx.root, ['sync'], { env });
    assert.equal(local.code, 0, local.stderr);
    assert.match(local.stdout, /no git remote/);
  });

  test('a conflict only in _ai/ is regenerated and pushed', () => {
    const { env, a, b } = twoMachines();
    change(a, env, 'sectors/work/pricing.md', '- [fact] 2026-09-20: Machine A was here.');
    git(a, env, 'push', '-q');
    change(b, env, 'sectors/school/exam-schedule.md', '- [fact] 2026-09-20: Machine B was here.');

    const res = runCli(b, ['sync', '--today', TODAY], { env });
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /regenerated/);
    assert.match(res.stdout, /pushed/);
    assert.ok(readFile(b, 'sectors/work/pricing.md').includes('Machine A was here.'));
    assert.ok(readFile(b, 'sectors/school/exam-schedule.md').includes('Machine B was here.'));
    const status = git(b, env, 'status', '--porcelain');
    assert.equal(status, '', 'clean work tree after sync');
    const result = checkJson(b, ['--strict', '--today', TODAY], { env });
    assert.ok(!result.codes.has('GEN_EDITED') && !result.codes.has('GEN_STALE'), describeFindings(result));

    git(a, env, 'pull', '-q', '--rebase');
    assert.ok(readFile(a, 'sectors/school/exam-schedule.md').includes('Machine B was here.'), 'A receives B');
  });

  test('a conflict in a note aborts the rebase, keeps the local commit and exits 1', () => {
    const { env, a, b } = twoMachines();
    const rel = 'sectors/work/pricing.md';
    const edit = (root, text) => {
      writeFile(root, rel, readFile(root, rel).replace('Standard has up to six pages and a blog.', text));
      git(root, env, 'commit', '-q', '-am', `edit on ${text}`);
    };
    edit(a, 'Standard has up to eight pages.');
    git(a, env, 'push', '-q');
    edit(b, 'Standard has up to seven pages.');
    const head = git(b, env, 'rev-parse', 'HEAD');

    const res = runCli(b, ['sync', '--today', TODAY], { env });
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.ok(res.stderr.includes(rel), res.stderr);
    assert.equal(git(b, env, 'rev-parse', 'HEAD'), head, 'the local commit is untouched');
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      assert.ok(!fs.existsSync(path.join(b, '.git', dir)), 'no rebase left in progress');
    }
    assert.ok(readFile(b, rel).includes('seven pages'));
  });
});
