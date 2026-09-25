// Coding projects at the unit level (system/lib/projects.mjs, repofacts.mjs, hookinput.mjs): the
// repository identity from every remote form and without a remote (the root commit cached), the
// lookup that tolerates ssh host aliases but never joins two servers, the ignore list, the settings
// defaults, the vault command for any shell, the local root made on demand, the facts and commands
// of each ecosystem read from tiny repositories (bounded, secret-free, never executed), the error
// lookup thresholds and the autosync lock.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AUTOSYNC_STALE_MS, ProjectError, autosyncLockFile, autosyncLockState, ensureLocalRoot, findProject, identify, ignoredKeys,
  isIgnored, keyPath, lookupError, mappings, projectSettings, remoteKey, sameServer, setIgnored, takeAutosyncLock, vaultCommand,
} from '../../lib/projects.mjs';
import { justRecipes, makeTargets, readBounded, repoFacts, tomlSections, yamlChildren } from '../../lib/repofacts.mjs';
import { errorBody, lookupCandidate, rawProjects } from '../../lib/hookinput.mjs';
import { bareRoot, loadFixture, plantSecret, removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

/** A folder with the given files ({rel: text}); returns its path. */
function repoWith(files, label = 'facts') {
  const dir = path.join(tmpDir(label), 'repo');
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const cmds = (facts) => facts.commands.map((c) => c.cmd);
const json = (v) => JSON.stringify(v, null, 2);

describe('remoteKey', () => {
  const same = {
    'github.com/linden/shop': [
      'https://github.com/Linden/Shop.git', 'git@github.com:linden/shop.git', 'ssh://git@github.com/linden/shop',
      'https://user@github.com/linden/shop/', 'https://user:pass@github.com/linden/shop', 'ssh://git@ssh.github.com:443/linden/shop.git',
      'https://www.github.com/linden/shop', 'git://github.com/linden/shop.git', 'github.com:linden/shop.git',
      'https://github.com:8443/linden/shop.git', 'git+ssh://git@github.com/linden/shop.git',
    ],
    'dev.azure.com/linden/harbor web/shop': [
      'https://dev.azure.com/linden/Harbor%20Web/_git/shop', 'https://linden@dev.azure.com/linden/Harbor%20Web/_git/shop',
      'git@ssh.dev.azure.com:v3/linden/Harbor%20Web/shop', 'linden@vs-ssh.visualstudio.com:v3/linden/Harbor%20Web/shop',
      'https://linden.visualstudio.com/Harbor%20Web/_git/shop', 'https://linden.visualstudio.com/DefaultCollection/Harbor%20Web/_git/shop',
    ],
    'gitlab.com/linden/web/shop': ['https://gitlab.com/linden/web/shop.git', 'git@gitlab.com:linden/web/shop.git'],
    'github.com-work/linden/shop': ['git@github.com-work:linden/shop.git'],
  };
  for (const [key, urls] of Object.entries(same)) {
    test(`${key}: every form gives the same key`, () => {
      for (const url of urls) assert.equal(remoteKey(url), key, url);
    });
  }

  test('a local remote: the folder name plus a hash of the whole path, so two shop.git stay apart', () => {
    const key = remoteKey('/srv/git/shop.git');
    assert.match(key, /^file:shop@[0-9a-f]{8}$/);
    for (const url of ['file:///srv/git/shop.git', '/srv/git/shop/', '/srv/git/shop', '/SRV/git/Shop.git']) assert.equal(remoteKey(url), key, url);
    assert.notEqual(remoteKey('/home/other/shop.git'), key, 'another folder called shop');
    const win = remoteKey('C:\\repos\\shop.git');
    for (const url of ['C:/repos/shop', 'file:///C:/repos/shop.git', 'c:\\Repos\\shop\\']) assert.equal(remoteKey(url), win, url);
    const base = path.resolve(tmpDir('rel'), 'code', 'app');
    assert.equal(remoteKey('../shop.git', base), remoteKey(path.resolve(base, '..', 'shop.git')), 'a relative path is taken from the repository');
    assert.equal(keyPath(key), null);
  });

  test('sameServer: ssh aliases of one host, never two real hosts', () => {
    for (const [a, b] of [['github.com', 'github.com'], ['github.com-work', 'github.com'], ['github.com-work', 'github.com-home']]) {
      assert.ok(sameServer(a, b) && sameServer(b, a), `${a} ${b}`);
    }
    for (const [a, b] of [['gitlab.clientb.example', 'github.com'], ['github.com', 'gitlab.com'], ['git-server.example.com', 'server.example.com'],
      ['work', 'home'], ['work', 'github.com'], ['localhost', 'github.com'], ['my.host-1.example.com', 'my.host']]) {
      assert.ok(!sameServer(a, b) && !sameServer(b, a), `${a} ${b}`);
    }
  });

  test('nothing usable gives null', () => {
    for (const url of ['', null, undefined, 'garbage', 'https://github.com/', 'ssh://git@github.com']) assert.equal(remoteKey(url), null, String(url));
  });

  test('keyPath: owner/repo of host keys only', () => {
    assert.equal(keyPath('github.com-work/linden/shop'), 'linden/shop');
    assert.equal(keyPath('gitlab.com/linden/web/shop'), 'linden/web/shop');
    for (const k of ['root:0123456789ab', 'path:shop', 'file:shop', 'github.com', '']) assert.equal(keyPath(k), null, k);
  });
});

describe('identify', { skip: !HAS_GIT && 'git is missing' }, () => {
  function repo(name = 'shop') {
    const dir = path.join(tmpDir('ident'), name);
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), '1\n');
    git(dir, ['init', '-q']);
    return dir;
  }
  const commit = (dir) => {
    git(dir, [...ID, 'add', '-A']);
    git(dir, [...ID, 'commit', '-qm', 'init']);
  };

  test('origin first, else the first remote by name', () => {
    const dir = repo();
    git(dir, ['remote', 'add', 'zeta', 'https://example.org/zeta/shop.git']);
    git(dir, ['remote', 'add', 'alpha', 'git@example.com:alpha/shop.git']);
    assert.equal(identify(dir).key, 'example.com/alpha/shop');
    git(dir, ['remote', 'add', 'origin', 'https://github.com/Linden/Shop.git']);
    const id = identify(path.join(dir, 'src', 'deep'));
    assert.equal(id.key, 'github.com/linden/shop');
    assert.equal(id.name, 'shop');
    assert.equal(fs.realpathSync(id.top), fs.realpathSync(dir), 'a subfolder gives the top of its repository');
    assert.equal(id.legacy, 'path:shop');
  });

  test('no remote: the root commit, the same in a worktree; no commit: the folder name, marked unsettled', () => {
    const dir = repo('Můj projekt');
    assert.deepEqual([identify(dir).key, identify(dir).unsettled], ['path:můj projekt', 'no_commit'], 'a repository without commits');
    commit(dir);
    const root = git(dir, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').sort()[0];
    const id = identify(dir);
    assert.equal(id.key, `root:${root.slice(0, 12)}`);
    assert.equal(id.unsettled, undefined);
    assert.equal(id.name, 'Můj projekt');
    const wt = path.join(path.dirname(dir), 'wt');
    git(dir, ['worktree', 'add', '-q', wt, '-b', 'side']);
    assert.equal(identify(wt).key, id.key, 'a worktree is the same project');
  });

  test('the root commit is cached per repository and only confirmed later; a stale entry is replaced', () => {
    const dir = repo('big');
    commit(dir);
    const cacheFile = path.join(tmpDir('cache'), 'roots.json');
    const key = identify(dir, { cacheFile }).key;
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const [[top, sha]] = Object.entries(cache.roots);
    assert.equal(fs.realpathSync(top), fs.realpathSync(dir));
    assert.equal(`root:${sha.slice(0, 12)}`, key);
    // A cached answer is used as it is while its commit exists in the repository.
    const other = repo('other');
    commit(other);
    const otherSha = git(other, ['rev-list', '--max-parents=0', 'HEAD']);
    git(dir, ['fetch', '-q', other, 'HEAD']);
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, roots: { [top]: otherSha } }));
    assert.equal(identify(dir, { cacheFile }).key, `root:${otherSha.slice(0, 12)}`, 'the cache answered, no history walk');
    // A commit that is not in the repository: walked again and the cache fixed.
    fs.writeFileSync(cacheFile, JSON.stringify({ version: 1, roots: { [top]: 'f'.repeat(40) } }));
    assert.equal(identify(dir, { cacheFile }).key, key);
    assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).roots[top], sha);
  });

  test('outside a repository, or a folder that does not exist: null', () => {
    assert.equal(identify(tmpDir('plain')), null);
    assert.equal(identify(path.join(tmpDir('plain'), 'missing')), null);
    assert.equal(identify(''), null);
  });
});

describe('settings and lookup', () => {
  test('projectSettings: the defaults of the settings contract', () => {
    assert.deepEqual(projectSettings({ raw: {} }), {
      enabled: false, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true, repos: {},
    });
    const on = { enabled: true, auto_add: true, store: 'git', autosync: true, checkpoint: false, error_lookup: false, repos: { a: 'dev' } };
    assert.deepEqual(projectSettings({ raw: { projects: on } }), on);
    assert.deepEqual(projectSettings({ raw: { projects: { enabled: 'yes', store: 'cloud', repos: [] } } }), {
      enabled: false, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true, repos: {},
    });
    assert.equal(projectSettings(null).enabled, false);
  });

  test('findProject: exact key, the one sector under the same owner/repo on the same server, then the legacy folder key', async () => {
    const root = bareRoot('en', {
      roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'private', path: '../private', privacy: 'local' }],
      projects: { repos: {
        'github.com-work/linden/shop': 'dev-shop', 'gitlab.com/team/x': 'dev-x', 'github.com/team/x': 'dev-y', 'github.com-home/team/x': 'dev-z',
        'path:tools': 'dev-tools', 'path:api': 'dev-api', 'github.com/gone/app': 'dev-gone', 'github.com/team/website': 'dev-web',
      } },
    });
    for (const id of ['dev', 'dev-shop', 'dev-x', 'dev-y', 'dev-z', 'dev-tools', 'dev-api', 'dev-web']) fs.mkdirSync(path.join(root, 'sectors', id), { recursive: true });
    fs.mkdirSync(path.join(root, '..', 'private'), { recursive: true });
    fs.writeFileSync(path.join(root, '..', 'private', 'projects.json'), json({ version: 1, repos: { 'root:0123456789ab': 'dev' } }));
    const { cfg } = await loadFixture(root);
    const find = (key, legacy = 'path:none') => findProject(cfg, { key, legacy })?.id ?? null;
    assert.equal(find('root:0123456789ab'), 'dev', 'the local map');
    assert.deepEqual(findProject(cfg, { key: 'root:0123456789ab', legacy: 'path:x' }), { key: 'root:0123456789ab', id: 'dev', store: 'local', exact: true });
    assert.equal(find('github.com-work/linden/shop'), 'dev-shop');
    assert.deepEqual(findProject(cfg, { key: 'github.com/linden/shop', legacy: 'path:shop' }), { key: 'github.com-work/linden/shop', id: 'dev-shop', store: 'git', exact: false },
      'an ssh host alias maps to the same project, marked as a loose match');
    assert.equal(find('work/linden/shop'), null, 'an alias that does not name its host may be any server');
    assert.equal(findProject(cfg, { key: 'github.com/linden/shop', legacy: 'path:shop' }, { exactOnly: true }), null);
    assert.equal(find('github.com-other/team/x'), null, 'two sectors under team/x on github.com: no guess');
    assert.equal(find('bitbucket.org/team/x'), null, 'another server is another repository');
    assert.equal(find('gitlab.clientb.example/team/website'), null, 'the same owner/repo of another client on another server');
    assert.equal(find('github.com/team/x'), 'dev-y');
    assert.equal(find('root:ffffffffffff', 'path:tools'), 'dev-tools', 'the folder key of older versions, for a repository without a remote');
    assert.equal(find('github.com/otherclient/billing-api', 'path:api'), null, 'a repository with a remote never borrows a folder key');
    assert.equal(find('github.com/gone/app'), null, 'a mapping whose sector is gone');
    assert.deepEqual(mappings(cfg).map((m) => `${m.store}:${m.id}`),
      ['local:dev', 'git:dev-shop', 'git:dev-x', 'git:dev-y', 'git:dev-z', 'git:dev-tools', 'git:dev-api', 'git:dev-gone', 'git:dev-web']);
    // An ignored repository keeps only its exact match.
    assert.equal(setIgnored(cfg, 'github.com/linden/shop', true), true);
    assert.equal(find('github.com/linden/shop'), null, 'ignore stops a loose match');
  });

  test('the ignore list: in the local root when there is one, else in .memory-kit; unignore clears both', async () => {
    const root = bareRoot('en', { roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'private', path: '../private', privacy: 'local' }] });
    const { cfg } = await loadFixture(root);
    const localFile = path.join(root, '..', 'private', 'projects.json');
    const sideFile = path.join(root, '.memory-kit', 'projects', 'ignored.json');
    assert.equal(setIgnored(cfg, 'github.com/linden/tools', true), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(localFile, 'utf8')), { version: 1, repos: {}, ignored: ['github.com/linden/tools'] });
    assert.equal(setIgnored(cfg, 'github.com/linden/tools', true), false);
    fs.mkdirSync(path.dirname(sideFile), { recursive: true });
    fs.writeFileSync(sideFile, json({ version: 1, ignored: ['github.com/linden/tools', 'gitlab.com/linden/old'] }));
    assert.deepEqual(ignoredKeys(cfg), ['github.com/linden/tools', 'gitlab.com/linden/old']);
    assert.equal(setIgnored(cfg, 'github.com/linden/tools', false), true);
    assert.deepEqual(ignoredKeys(cfg), ['gitlab.com/linden/old'], 'removed from both lists');
    assert.equal(setIgnored(cfg, 'gitlab.com/linden/old', false), true);
    assert.equal(setIgnored(cfg, 'gitlab.com/linden/old', false), false);
    // The folder key of older versions counts only for a repository without a remote.
    setIgnored(cfg, 'path:api', true);
    assert.equal(isIgnored(cfg, { key: 'root:0123456789ab', legacy: 'path:api' }), true);
    assert.equal(isIgnored(cfg, { key: 'github.com/otherclient/billing-api', legacy: 'path:api' }), false);
    // Without a local root the list stays in .memory-kit.
    const plain = bareRoot('en');
    const { cfg: bare } = await loadFixture(plain);
    assert.equal(setIgnored(bare, 'github.com/linden/tools', true), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plain, '.memory-kit', 'projects', 'ignored.json'), 'utf8')).ignored, ['github.com/linden/tools']);
  });

  test('vaultCommand: node and the script in double quotes with forward slashes; single quotes when a shell would expand the path', () => {
    assert.equal(vaultCommand({ root: 'C:\\Users\\jan\\vault' }, { platform: 'win32' }), 'node "C:/Users/jan/vault/system/memory.mjs"');
    assert.equal(vaultCommand({ root: 'C:\\Users\\Jan Novák\\my vault\\' }, { platform: 'win32' }), 'node "C:/Users/Jan Novák/my vault/system/memory.mjs"');
    assert.equal(vaultCommand({ root: '/home/jan/vault' }, { platform: 'linux' }), 'node "/home/jan/vault/system/memory.mjs"');
    for (const bad of ['$HOME', 'a`b`', '100%', 'hi!', 'say "x"']) {
      assert.equal(vaultCommand({ root: `/home/${bad}` }, { platform: 'linux' }), `node '/home/${bad}/system/memory.mjs'`, bad);
    }
    assert.equal(vaultCommand({ root: "/home/it's $x" }, { platform: 'linux' }), `node '/home/it'\\''s $x/system/memory.mjs'`);
  });

  test('lookupError: at least 3 shared words and 40 % of the line', () => {
    const lines = [
      { line: '- [gotcha] 2026-09-20: vite build fails with ENOSPC watcher limit, raise fs.inotify.max_user_watches', role: 'gotchas' },
      { line: '- postgres migration timeout because the docker volume, network bridge, compose file, healthcheck, restart policy and memory limit changed', role: 'gotchas' },
      { line: '- ENOSPC watcher', role: 'deadends' },
    ];
    const hit = lookupError(null, 'dev', 'Error: ENOSPC: System limit for number of file watchers reached (inotify max_user_watches)', { lines });
    assert.deepEqual(hit.map((h) => h.role), ['gotchas']);
    assert.match(hit[0].line, /ENOSPC/);
    const few = lookupError(null, 'dev', 'docker compose healthcheck failed: postgres not ready', { lines });
    assert.deepEqual(few, [], '3 shared words out of many: below 40 %');
    assert.deepEqual(lookupError(null, 'dev', 'ENOSPC', { lines }), [], 'too few words in the error');
  });

  test('lookupCandidate: Bash or PowerShell, no interrupt, 20 characters besides the exit code', () => {
    const error = 'Exit code 1\nError: Cannot find module ./cart imported from src/app.ts';
    assert.deepEqual(lookupCandidate({ tool_name: 'Bash', error }), { tool: 'Bash', text: 'Error: Cannot find module ./cart imported from src/app.ts' });
    assert.ok(lookupCandidate({ tool_name: 'PowerShell', error }));
    assert.equal(lookupCandidate({ tool_name: 'Read', error }), null);
    assert.equal(lookupCandidate({ tool_name: 'Bash', error, is_interrupt: true }), null);
    assert.equal(lookupCandidate({ tool_name: 'Bash', error: 'Exit code 1\nno match' }), null);
    assert.equal(lookupCandidate({ tool_name: 'Bash', error: { text: error } }), null);
    assert.equal(errorBody('Exit code 127\nsh: foo: not found'), 'sh: foo: not found');
  });

  test('rawProjects: a byte order mark is fine; an unreadable memory.json is null', () => {
    const root = tmpDir('raw');
    fs.writeFileSync(path.join(root, 'memory.json'), `\uFEFF${json({ projects: { enabled: true } })}`);
    assert.deepEqual(rawProjects(root), { enabled: true });
    fs.writeFileSync(path.join(root, 'memory.json'), '{ broken');
    assert.equal(rawProjects(root), null);
    assert.equal(rawProjects(tmpDir('none')), null);
  });
});

describe('ensureLocalRoot', () => {
  test('adds ../<vault>-private to memory.json once and creates it', async () => {
    const root = bareRoot('en', { projects: { enabled: true } });
    const before = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'));
    const { cfg } = await loadFixture(root);
    const made = await ensureLocalRoot(cfg);
    assert.equal(made.created, true);
    const expected = { ...before, roots: [...before.roots, { id: 'private', path: '../vault-private', privacy: 'local' }] };
    assert.equal(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
    const dir = path.join(path.dirname(root), 'vault-private');
    assert.ok(fs.statSync(dir).isDirectory());
    assert.equal(fs.realpathSync(cfg.roots[1].path), fs.realpathSync(dir));
    assert.equal(cfg.raw.projects.enabled, true);
    const again = await ensureLocalRoot(cfg);
    assert.equal(again.created, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8')).roots.length, 2);
  });

  test('a local root of another operating system is refused', async () => {
    const foreign = process.platform === 'win32' ? '/home/someone/private' : 'D:/private';
    const root = bareRoot('en', { roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'private', path: foreign, privacy: 'local' }] });
    const { cfg } = await loadFixture(root);
    await assert.rejects(ensureLocalRoot(cfg), (err) => err instanceof ProjectError && err.reason === 'foreign_root');
  });
});

describe('repoFacts', () => {
  test('Node: package manager, workspaces, frameworks and scripts (no lifecycle hooks)', () => {
    const dir = repoWith({
      'package.json': json({
        name: 'harbor-shop', description: 'Pre-orders for Harbor Bakery', packageManager: 'pnpm@9.1.0', workspaces: ['packages/*'],
        scripts: { postinstall: 'patch', zeta: 'node z.js', test: 'vitest', build: 'vite build', dev: 'vite', prepare: 'husky' },
        devDependencies: { vite: '5', vitest: '1' },
      }),
      'src/main.ts': 'export {};\n',
    });
    const f = repoFacts(dir);
    assert.equal(f.name, 'harbor-shop');
    assert.equal(f.description, 'Pre-orders for Harbor Bakery');
    assert.deepEqual(cmds(f), ['pnpm install', 'pnpm run dev', 'pnpm run build', 'pnpm run test', 'pnpm run zeta']);
    assert.deepEqual(f.commands[1], { cmd: 'pnpm run dev', what: 'vite', source: 'package.json' });
    assert.deepEqual(f.commands[0], { cmd: 'pnpm install', what: '', source: 'package.json', kind: 'install' });
    for (const s of ['Node.js (pnpm)', 'workspaces', 'vite', 'vitest']) assert.ok(f.stack.includes(s), s);
    assert.deepEqual(f.languages, ['TypeScript']);
    assert.deepEqual(f.topDirs, ['src']);
    assert.deepEqual(cmds(repoFacts(repoWith({ 'package.json': json({ scripts: { test: 'jest' } }), 'yarn.lock': '' }))), ['yarn install', 'yarn run test']);
    assert.deepEqual(cmds(repoFacts(repoWith({ 'package.json': json({ scripts: { test: 'bun test' } }), 'bun.lock': '' }))), ['bun install', 'bun run test']);
  });

  test('Python: uv, Poetry, Pipenv and pip; pytest, ruff, mypy and Django', () => {
    const uv = repoFacts(repoWith({
      'pyproject.toml': '[project]\nname = "harbor-api"\ndescription = "Orders API"\ndependencies = ["fastapi"]\n\n[tool.pytest.ini_options]\naddopts = "-q"\n\n[tool.ruff]\nline-length = 100\n\n[tool.mypy]\nstrict = true\n',
      'uv.lock': 'version = 1\n',
    }));
    assert.equal(uv.name, 'harbor-api');
    assert.equal(uv.description, 'Orders API');
    assert.deepEqual(cmds(uv), ['uv sync', 'uv run pytest', 'uv run ruff check .', 'uv run mypy .']);
    assert.ok(uv.stack.includes('Python (uv)'));
    const poetry = repoFacts(repoWith({
      'pyproject.toml': '[tool.poetry]\nname = "harbor-admin"\ndescription = \'Admin\'\n', 'poetry.lock': '', 'manage.py': '#!/usr/bin/env python\n',
    }));
    assert.equal(poetry.name, 'harbor-admin');
    assert.deepEqual(cmds(poetry), ['poetry install', 'poetry run python manage.py runserver', 'poetry run python manage.py test']);
    assert.ok(poetry.stack.includes('Django'));
    assert.deepEqual(cmds(repoFacts(repoWith({ Pipfile: '[dev-packages]\npytest = "*"\n' }))), ['pipenv install --dev', 'pipenv run pytest']);
    assert.deepEqual(cmds(repoFacts(repoWith({ 'requirements.txt': 'requests==2.32\npytest>=8\n' }))), ['pip install -r requirements.txt', 'python -m pytest']);
  });

  test('Rust, Go, PHP and Ruby', () => {
    const rust = repoFacts(repoWith({ 'Cargo.toml': '[package]\nname = "harbor-cli"\ndescription = "CLI"\n\n[dependencies]\nclap = "4"\n', 'src/main.rs': 'fn main() {}\n' }));
    assert.equal(rust.name, 'harbor-cli');
    assert.deepEqual(cmds(rust), ['cargo build', 'cargo run', 'cargo test', 'cargo clippy', 'cargo fmt']);
    assert.ok(repoFacts(repoWith({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n' })).stack.includes('Rust (workspace)'));
    const go = repoFacts(repoWith({ 'go.mod': 'module example.com/linden/booking\n\ngo 1.22\n', '.golangci.yml': 'linters: {}\n' }));
    assert.equal(go.name, 'booking');
    assert.deepEqual(cmds(go), ['go build ./...', 'go test ./...', 'go vet ./...', 'golangci-lint run']);
    const php = repoFacts(repoWith({
      'composer.json': json({ name: 'linden/harbor', description: 'Shop', scripts: { 'post-install-cmd': 'x', test: 'phpunit', lint: ['phpcs', 'phpstan'] } }),
      'phpunit.xml': '<phpunit/>\n',
    }));
    assert.equal(php.name, 'harbor');
    assert.deepEqual(cmds(php), ['composer install', 'composer run test', 'composer run lint', 'vendor/bin/phpunit']);
    assert.equal(php.commands[2].what, 'phpcs; phpstan');
    const laravel = repoFacts(repoWith({ 'composer.json': json({ name: 'linden/app' }), artisan: '<?php\n', 'phpunit.xml': '<phpunit/>\n' }));
    assert.deepEqual(cmds(laravel), ['composer install', 'php artisan serve', 'php artisan test']);
    assert.ok(laravel.stack.includes('Laravel'));
    const ruby = repoFacts(repoWith({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "rspec-rails"\n', 'bin/rails': '#!/usr/bin/env ruby\n', Rakefile: '' }));
    assert.deepEqual(cmds(ruby), ['bundle install', 'bin/rails server', 'bundle exec rspec', 'bundle exec rake']);
    assert.ok(ruby.stack.includes('Rails'));
  });

  test('Java, Kotlin, .NET, Dart, Flutter and Deno', () => {
    assert.deepEqual(cmds(repoFacts(repoWith({ 'pom.xml': '<project/>\n', mvnw: '#!/bin/sh\n' }))), ['./mvnw package', './mvnw test']);
    const gradle = repoFacts(repoWith({ 'build.gradle.kts': 'plugins {}\n', gradlew: '#!/bin/sh\n', 'src/Main.kt': 'fun main() {}\n' }));
    assert.deepEqual(cmds(gradle), ['./gradlew build', './gradlew test']);
    assert.ok(gradle.stack.includes('Gradle (Kotlin DSL)'));
    assert.deepEqual(gradle.languages, ['Kotlin']);
    const dotnet = repoFacts(repoWith({ 'Harbor.sln': '\n', 'Harbor.csproj': '<Project/>\n' }));
    assert.deepEqual(dotnet.commands.map((c) => `${c.cmd} (${c.source})`), ['dotnet build (Harbor.sln)', 'dotnet test (Harbor.sln)']);
    const flutter = repoFacts(repoWith({ 'pubspec.yaml': 'name: harbor_app\ndescription: "Bakery app"\ndependencies:\n  flutter:\n    sdk: flutter\n' }));
    assert.equal(flutter.name, 'harbor_app');
    assert.equal(flutter.description, 'Bakery app');
    assert.deepEqual(cmds(flutter), ['flutter pub get', 'flutter run', 'flutter test', 'flutter analyze']);
    assert.deepEqual(cmds(repoFacts(repoWith({ 'pubspec.yaml': 'name: tool\n' }))), ['dart pub get', 'dart run', 'dart test', 'dart analyze']);
    const deno = repoFacts(repoWith({ 'deno.jsonc': '{\n  // tasks\n  "tasks": { "dev": "deno run -A main.ts", "test": { "command": "deno test", "description": "run the tests" } },\n}\n' }));
    assert.deepEqual(deno.commands, [
      { cmd: 'deno task dev', what: 'deno run -A main.ts', source: 'deno.jsonc' },
      { cmd: 'deno task test', what: 'run the tests', source: 'deno.jsonc' },
    ]);
  });

  test('Makefile, justfile, Taskfile and Docker Compose', () => {
    const make = [
      '.PHONY: build test', 'VAR := x', 'CC = gcc', 'export PATH := $(PWD)/bin:$(PATH)', '# Build everything', 'build: deps',
      '\tgo build ./...', 'test: ## Run the tests', '\tgo test ./...', '%.o: %.c', '\tcc -c $<', 'define TEMPLATE', 'fake: target',
      'endef', 'deps:', '\techo deps', 'bin/tool: tool.go', '\tgo build -o $@',
    ].join('\n');
    assert.deepEqual(makeTargets(make), [{ name: 'build', what: 'Build everything' }, { name: 'test', what: 'Run the tests' }, { name: 'deps', what: '' }]);
    const just = ['set shell := ["bash", "-c"]', 'version := "1"', '# Start the dev server', 'dev:', '    npm run dev', 'build target="all":', '    make',
      '_helper:', 'alias b := build', '[private]', 'hidden:', '    echo', '@lint *args:', '    eslint'].join('\n');
    assert.deepEqual(justRecipes(just), [{ name: 'dev', what: 'Start the dev server' }, { name: 'build', what: '' }, { name: 'lint', what: '' }]);
    const task = "version: '3'\nvars:\n  X: 1\ntasks:\n  build:\n    desc: Build it\n    cmds:\n      - go build\n  'test':\n    cmds:\n      - go test\n  _internal:\n    cmds: []\n";
    assert.deepEqual(yamlChildren(task, 'tasks'), [{ name: 'build', what: 'Build it' }, { name: 'test', what: '' }, { name: '_internal', what: '' }]);
    const f = repoFacts(repoWith({ Makefile: make, justfile: just, 'Taskfile.yml': task, 'compose.yaml': 'services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n' }));
    assert.deepEqual(cmds(f), ['make build', 'make test', 'make deps', 'just dev', 'just build', 'just lint', 'task build', 'task test', 'docker compose up']);
    for (const s of ['Make', 'just', 'Task', 'Docker Compose (web, db)']) assert.ok(f.stack.includes(s), s);
  });

  test('TOML sections, bounded reads, secrets dropped and nothing executed', () => {
    const toml = tomlSections('name = "top"\n[package]\nname = "a" # comment\n[[bin]]\nname = \'b\'\n[tool.poetry]\nversion = 1\n');
    assert.deepEqual([...toml.keys()], ['', 'package', 'bin', 'tool.poetry']);
    assert.equal(toml.get('package').name, 'a');
    const big = repoWith({ 'README.md': `# Big\n\n${'word '.repeat(80000)}\n` });
    assert.ok(readBounded(path.join(big, 'README.md')).length <= 256 * 1024);
    assert.ok(repoFacts(big).readme.length <= 400);
    const { aws, github } = plantSecret();
    const marker = 'pwned-by-a-script';
    const dir = repoWith({
      'package.json': json({ name: 'harbor', description: `token ${github}`, scripts: { deploy: `AWS_KEY=${aws} ./deploy.sh`, test: `node -e "require('fs').writeFileSync('${marker}', '1')"` } }),
      'README.md': `# Harbor\n\nKey: ${github}\n`,
    });
    const facts = repoFacts(dir);
    const text = JSON.stringify(facts);
    for (const s of [aws, github]) assert.ok(!text.includes(s), 'a secret reached the facts');
    assert.equal(facts.description, '');
    assert.ok(cmds(facts).includes('npm run deploy'));
    assert.ok(!fs.existsSync(path.join(dir, marker)), 'a script ran');
    assert.deepEqual(repoFacts(repoWith({ 'package.json': '{ not json' })).commands, []);
  });
});

describe('autosync lock', () => {
  test('free, busy, stale by age or by a finished process; taken and released', () => {
    const cfg = { root: tmpDir('lock') };
    assert.equal(autosyncLockState(cfg).state, 'free');
    const release = takeAutosyncLock(cfg);
    assert.equal(typeof release, 'function');
    const held = autosyncLockState(cfg);
    assert.equal(held.state, 'busy');
    assert.equal(held.pid, process.pid);
    assert.equal(takeAutosyncLock(cfg), null, 'a second autosync waits for nothing and skips');
    release();
    assert.equal(autosyncLockState(cfg).state, 'free');
    const file = autosyncLockFile(cfg);
    const write = (lock) => fs.writeFileSync(file, JSON.stringify(lock));
    write({ pid: process.pid, host: os.hostname(), started: new Date(Date.now() - AUTOSYNC_STALE_MS - 1000).toISOString() });
    assert.equal(autosyncLockState(cfg).state, 'stale');
    write({ pid: 2 ** 30, host: os.hostname(), started: new Date().toISOString() });
    assert.equal(autosyncLockState(cfg).state, 'stale', 'the process is gone');
    write({ pid: 2 ** 30, host: 'another-machine', started: new Date().toISOString() });
    assert.equal(autosyncLockState(cfg).state, 'busy', 'another machine: trust it until it is old');
    write({ pid: process.pid, host: os.hostname(), started: new Date(Date.now() - AUTOSYNC_STALE_MS - 1000).toISOString() });
    const again = takeAutosyncLock(cfg);
    assert.equal(typeof again, 'function', 'a stale lock is taken over');
    again();
  });
});
