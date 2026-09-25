// Memory for coding projects: connect --projects (user hooks for Claude Code and Codex), the hook
// events (session start creates the dev sector outside the code repository, stop asks once for the
// handoff, a failed tool looks the error up) and remember. Everything runs against a fake home.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { remoteKey } from '../../lib/projects.mjs';
import { planHooks } from '../../lib/hooksetup.mjs';
import { checkJson, describeFindings, fixtureVault, removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function cli(root, args, { home, cwd, input } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
  for (const k of ['MEMORY_SECTORS', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[k];
  const res = spawnSync(process.execPath, [path.join(root, 'system', 'memory.mjs'), ...args, '--root', root], {
    cwd: cwd ?? root, env, input: input ?? '', encoding: 'utf8', windowsHide: true,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function codeRepo() {
  const dir = path.join(tmpDir('code'), 'shop');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', description: 'A small shop', scripts: { dev: 'vite', test: 'vitest' } }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1);\n');
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  return dir;
}

describe('remoteKey', () => {
  test('https, ssh and scp forms give the same key', () => {
    for (const url of ['https://github.com/Acme/Shop.git', 'git@github.com:acme/shop.git', 'ssh://git@github.com/acme/shop', 'https://user@github.com/acme/shop/']) {
      assert.equal(remoteKey(url), 'github.com/acme/shop', url);
    }
  });
});

describe('planHooks', () => {
  test('keeps foreign hooks, adds ours once and removes them cleanly', () => {
    const foreign = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }, model: 'x' };
    const once = planHooks(foreign, 'claude-code', { node: 'node', script: '/v/system/memory.mjs' });
    const twice = planHooks(once, 'claude-code', { node: 'node', script: '/v/system/memory.mjs' });
    assert.deepEqual(twice, once);
    assert.equal(once.hooks.Stop.length, 2);
    assert.deepEqual(once.hooks.SessionStart[0].hooks[0].args, ['/v/system/memory.mjs', 'hook', 'claude-code', 'session-start']);
    assert.deepEqual(planHooks(once, 'claude-code', { node: 'node', script: '/v/system/memory.mjs', remove: true }), foreign);
  });
});

describe('projects end to end', { skip: !HAS_GIT && 'git is missing' }, () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: connect, session start, remember, stop and error lookup`, () => {
      const { root } = fixtureVault(lang);
      const home = tmpDir('home');
      const repo = codeRepo();

      const c1 = cli(root, ['connect', 'claude-code', '--projects'], { home });
      assert.equal(c1.code, 0, c1.stderr);
      const settingsFile = path.join(home, '.claude', 'settings.json');
      const first = fs.readFileSync(settingsFile, 'utf8');
      assert.equal(cli(root, ['connect', 'claude-code', '--projects'], { home }).code, 0);
      assert.equal(fs.readFileSync(settingsFile, 'utf8'), first, 'connect --projects is idempotent');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8')).projects.checkpoint, true);

      const start = cli(root, ['hook', 'claude-code', 'session-start'], { home, cwd: repo, input: JSON.stringify({ cwd: repo, session_id: 's1' }) });
      assert.equal(start.code, 0, start.stderr);
      assert.match(start.stdout, /shop/);
      const repos = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8')).projects.repos;
      assert.equal(repos['github.com/acme/shop'], 'dev');
      assert.ok(fs.existsSync(path.join(root, lang === 'cs' ? 'sektory' : 'sectors', 'dev')), 'dev sector exists');
      assert.equal(git(repo, ['status', '--porcelain']).stdout, '', 'nothing written into the code repository');

      // Second start: same sector, no second project.
      cli(root, ['hook', 'claude-code', 'session-start'], { home, cwd: repo, input: JSON.stringify({ cwd: repo, session_id: 's1' }) });
      assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8')).projects.repos), ['dev']);

      const rem = cli(root, ['remember', '--type', 'gotcha', 'vite build fails with ENOSPC watcher limit, raise fs.inotify.max_user_watches'], { home, cwd: repo });
      assert.equal(rem.code, 0, rem.stderr);
      const secret = cli(root, ['remember', `token ghp_${'a1B2c3D4e5'.repeat(4)}`], { home, cwd: repo });
      assert.equal(secret.code, 1);

      // Stop: silent without code changes, asks once after a change, then silent again.
      const stopIn = JSON.stringify({ cwd: repo, session_id: 's1', stop_hook_active: false });
      assert.equal(cli(root, ['hook', 'claude-code', 'stop'], { home, cwd: repo, input: stopIn }).stdout, '');
      fs.appendFileSync(path.join(repo, 'index.js'), 'console.log(2);\n');
      const ask = cli(root, ['hook', 'claude-code', 'stop'], { home, cwd: repo, input: stopIn });
      assert.equal(JSON.parse(ask.stdout).decision, 'block');
      assert.equal(cli(root, ['hook', 'claude-code', 'stop'], { home, cwd: repo, input: stopIn }).stdout, '');

      const fail = cli(root, ['hook', 'claude-code', 'tool-failure'], { home, cwd: repo, input: JSON.stringify({ cwd: repo, error: 'Error: ENOSPC: System limit for number of file watchers reached (inotify max_user_watches)' }) });
      assert.match(JSON.parse(fail.stdout).hookSpecificOutput.additionalContext, /ENOSPC/);

      assert.equal(cli(root, ['hook', 'claude-code', 'session-start'], { home, input: '{not json' }).code, 0);
      assert.equal(cli(root, ['hook', 'nobody', 'stop'], { home }).code, 0);

      const res = checkJson(root, ['--generate', '--strict']);
      assert.equal(res.code, 0, describeFindings(res));
    });
  }
});
