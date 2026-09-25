// The one-line installers (install.sh, install.ps1) and the release tooling (release-notes.mjs,
// .github/workflows/release.yml). The installers run for real against this checkout (--source
// <folder>) or a tagged git copy of it, with a temporary HOME and git identity: the result must be
// an initialized memory that passes check, with no git remote and none of the kit's history, and a
// second run must change nothing. Missing prerequisites are simulated with a PATH that lacks them.
// install.sh needs a POSIX sh (not on Windows). install.ps1 runs under every PowerShell found:
// powershell (Windows PowerShell 5.1) and pwsh on PATH, plus the one MEMORY_TEST_PWSH names.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { groupOf, loadManifest } from '../../lib/kit.mjs';
import { absoluteLinks, extractSection, main as releaseNotes } from '../../tools/release-notes.mjs';
import { KIT_ROOT, copyKit, removeTmpDirs, runCli, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const IS_WIN = process.platform === 'win32';
const INSTALL_SH = path.join(KIT_ROOT, 'install.sh');
const INSTALL_PS1 = path.join(KIT_ROOT, 'install.ps1');
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const SH = !IS_WIN && fs.existsSync('/bin/sh') ? '/bin/sh' : null;
const ANSWERS_SH = ['--lang', 'en', '--mode', 'local', '--sectors', 'core'];
const ANSWERS_PS = ['-Lang', 'en', '-Mode', 'local', '-Sectors', 'core'];
const ESC = '\u001b[';
// A folder name with a space and Czech letters: paths like this must work everywhere.
const VAULT_NAME = 'Moje Pam\u011b\u0165';

function findOnPath(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

const POWERSHELLS = [...new Set([IS_WIN ? findOnPath('powershell') : null, findOnPath('pwsh'), process.env.MEMORY_TEST_PWSH || null]
  .filter(Boolean))];
const SHELLCHECK = findOnPath('shellcheck');

// Variables that would change what the installer or the kit does; the tests set them explicitly.
const SCRUB = ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITPOD_WORKSPACE_ID', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT',
  'MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'SUDO_USER', 'MEMORY_DEBUG'];

/** A clean environment: temporary HOME, a git identity and no user or system git configuration. */
function installEnv(extra = {}) {
  const home = tmpDir('home');
  const gitconfig = path.join(home, '.gitconfig');
  fs.writeFileSync(gitconfig, '');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SCRUB.includes(key) || key.startsWith('MEMORY_KIT_')) delete env[key];
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'memory-kit test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'memory-kit test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
    // GitHub's Windows runners are administrators; the installer refuses that by default.
    MEMORY_KIT_ALLOW_ADMIN: '1',
    ...extra,
  };
}

function run(exe, args, { env, input = '', cwd } = {}) {
  const res = spawnSync(exe, args, {
    env, input, cwd, encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, all: `${res.stdout}\n${res.stderr}` };
}

const runSh = (args, opts) => run(SH, [INSTALL_SH, ...args], opts);
const runPs = (exe, args, opts) => run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1, ...args], opts);

function git(cwd, args, env = installEnv()) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
}

function kitHead() {
  const res = git(KIT_ROOT, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return res.status === 0 ? res.stdout.trim() : null;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** What every fresh install must leave behind. */
function assertFreshVault(vault, res, { history = [kitHead()] } = {}) {
  assert.equal(res.code, 0, res.all);
  assert.match(res.stdout, /Your memory is ready/, res.all);
  assert.ok(!res.stdout.includes(ESC), 'no color codes when stdout is not a terminal');
  const cfg = readJson(path.join(vault, 'memory.json'));
  assert.equal(cfg.initialized, true);
  assert.equal(cfg.mode, 'local');
  const check = runCli(vault, ['check']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  const top = git(vault, ['rev-parse', '--show-toplevel']);
  assert.equal(top.status, 0, top.stderr);
  assert.equal(fs.realpathSync(top.stdout.trim()), fs.realpathSync(vault), 'the vault is a git repository of its own');
  assert.equal(git(vault, ['remote']).stdout.trim(), '', 'no remote');
  assert.equal(git(vault, ['rev-list', '--all']).stdout.trim(), '', 'no commits: none of the kit history');
  for (const sha of history.filter(Boolean)) {
    assert.notEqual(git(vault, ['cat-file', '-e', `${sha}^{commit}`]).status, 0, `kit commit ${sha} is not in the vault`);
  }
  assert.ok(fs.existsSync(path.join(path.dirname(vault), `${path.basename(vault)}-private`)), 'local mode made the private folder');
  assertNoLeftovers(path.dirname(vault));
}

function assertNoLeftovers(parent) {
  const left = fs.readdirSync(parent).filter((name) => name.startsWith('.memory-kit-install.'));
  assert.deepEqual(left, [], 'no temporary folder is left behind');
}

/** A second run on the same folder: nothing downloaded, nothing changed, exit 0. */
function assertRerunSafe(vault, res, before) {
  assert.equal(res.code, 0, res.all);
  assert.match(res.stdout, /already; nothing was downloaded/, res.all);
  assert.match(res.stdout, /node system\/memory\.mjs doctor/);
  assert.equal(fs.readFileSync(path.join(vault, 'memory.json'), 'utf8'), before);
  assert.equal(git(vault, ['remote']).stdout.trim(), '');
  assertNoLeftovers(path.dirname(vault));
}

/** A folder with a fake `node` that reports an old version (a POSIX shell script). */
function fakeOldNode() {
  const bin = tmpDir('fake-bin');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho 20.11.1\n', { mode: 0o755 });
  return bin;
}

// A git copy of this checkout with tags, served by URL: v0.1.9, v0.1.10 (the newest release),
// a newer untagged commit and a pre-release tag. The installer must take v0.1.10.
let tagged = null;
function taggedSource() {
  if (tagged) return tagged;
  const dir = path.join(tmpDir('kit-src'), 'kit');
  copyKit(dir);
  const env = installEnv();
  const step = (args) => {
    const res = git(dir, args, env);
    assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    return res.stdout.trim();
  };
  const marker = path.join(dir, 'release-marker.txt');
  step(['init', '-q']);
  step(['add', '-A']);
  step(['commit', '-q', '--no-verify', '-m', 'kit']);
  step(['tag', 'v0.1.9']);
  fs.writeFileSync(marker, 'v0.1.10\n');
  step(['add', '-A']);
  step(['commit', '-q', '--no-verify', '-m', 'release']);
  step(['tag', 'v0.1.10']);
  fs.writeFileSync(marker, 'unreleased\n');
  step(['commit', '-q', '--no-verify', '-am', 'later']);
  step(['tag', 'v0.2.0-rc.1']);
  const commits = step(['rev-list', '--all']).split('\n');
  tagged = { url: pathToFileURL(dir).href, commits };
  return tagged;
}

// ---------------------------------------------------------------------------------------------

describe('installer files', () => {
  for (const file of [INSTALL_SH, INSTALL_PS1]) {
    test(`${path.basename(file)}: pure ASCII, LF, no BOM, one final newline`, () => {
      const buf = fs.readFileSync(file);
      const bad = [...buf].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a));
      assert.equal(bad, -1, `byte ${bad} is not printable ASCII (Windows PowerShell 5.1 reads the file as ANSI)`);
      assert.ok(buf.toString('latin1').endsWith('\n') && !buf.toString('latin1').endsWith('\n\n'));
    });
  }

  test('install.sh: POSIX sh, and the whole body is one { } group that ends with the call of main', () => {
    const text = fs.readFileSync(INSTALL_SH, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.ok(text.endsWith('\nmain ${1+"$@"}\n}\n'), 'ends with main ${1+"$@"} inside the group');
    assert.match(text, /\n\{\nset -eu\n/);
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    for (const bashism of [/(?:^|\s)\[\[\s/, /\bfunction\s+\w+/, /^\s*local\s+\w/, /\bset -o pipefail/, /\becho\s+-e\b/, /&>/, /<<</]) {
      assert.ok(!code.some((line) => bashism.test(line)), `no ${bashism} in install.sh`);
    }
  });

  test('install.ps1: Windows PowerShell 5.1 syntax (no &&, ||, ??, `e or $PSStyle), body in & { }', () => {
    const text = fs.readFileSync(INSTALL_PS1, 'utf8');
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    for (const token of [' && ', ' || ', ' ?? ', '`e', '$PSStyle', '::new(']) {
      assert.ok(!code.some((line) => line.includes(token)), `no ${token.trim()} in install.ps1`);
    }
    assert.match(text, /\n& \{\n/);
    assert.match(text, /if \(\$FromFile\) \{ exit \$st\.code \}\n  \$global:LASTEXITCODE = \$st\.code\n\}/, 'never exit under irm | iex');
    assert.ok(!/\$script:/.test(code.join('\n')), 'no script-scope variables (under iex that is the user\'s session)');
  });

  test('the kit owns both installers and the release workflow (upgrades ship them)', () => {
    const manifest = loadManifest(KIT_ROOT);
    for (const rel of ['install.sh', 'install.ps1', '.github/workflows/release.yml']) {
      assert.equal(groupOf(rel), 'config', rel);
      assert.equal(manifest.files[rel]?.group, 'config', `system/kit.json lists ${rel} (run: node system/tools/release.mjs)`);
    }
    assert.equal(groupOf('system/tools/release-notes.mjs'), 'code');
  });
});

// ---------------------------------------------------------------------------------------------

describe('install.sh', { skip: !SH ? 'install.sh is for macOS and Linux' : !HAS_GIT ? 'git is not installed' : false }, () => {
  test('parses (sh -n)', () => {
    const res = run(SH, ['-n', INSTALL_SH]);
    assert.equal(res.code, 0, res.all);
  });

  test('shellcheck finds nothing', { skip: SHELLCHECK ? false : 'shellcheck is not installed' }, () => {
    const res = run(SHELLCHECK, ['--shell=sh', INSTALL_SH]);
    assert.equal(res.code, 0, res.all);
  });

  test('a download cut short runs nothing, wherever it is cut', () => {
    const buf = fs.readFileSync(INSTALL_SH);
    const open = buf.indexOf('\n{\n') + 3;
    const cuts = [open, buf.length - 2, buf.length - 5, buf.indexOf('\nmain ${1+') + 5];
    for (let i = 1; i <= 8; i++) cuts.push(open + Math.floor(((buf.length - 2 - open) * i) / 9));
    const parent = tmpDir('cut');
    const target = path.join(parent, 'memory');
    const env = installEnv();
    for (const n of cuts) {
      const res = run(SH, ['-s', '--', '--yes', '--no-gh', '--source', KIT_ROOT, '--dir', target, ...ANSWERS_SH],
        { env, input: buf.subarray(0, n) });
      assert.notEqual(res.code, 0, `cut at byte ${n} of ${buf.length} must fail`);
      assert.equal(res.stdout, '', `cut at byte ${n}: nothing ran`);
      assert.deepEqual(fs.readdirSync(parent), [], `cut at byte ${n}: nothing was created`);
    }
  });

  test('--yes with the answers: a set-up private memory without a remote, from a folder with spaces and diacritics', () => {
    const env = installEnv();
    const vault = path.join(tmpDir('sh'), VAULT_NAME);
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assertFreshVault(vault, res);
    assert.match(res.stdout, /fresh git repository, no remote/);

    const before = fs.readFileSync(path.join(vault, 'memory.json'), 'utf8');
    const again = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assertRerunSafe(vault, again, before);
  });

  test('from a git URL: the newest vX.Y.Z tag, cloned without its history; the same options as env variables', () => {
    const src = taggedSource();
    const vault = path.join(tmpDir('sh-url'), 'memory');
    const env = installEnv({
      MEMORY_KIT_YES: '1', MEMORY_KIT_NO_GH: '1', MEMORY_KIT_SOURCE: src.url, MEMORY_KIT_DIR: vault,
      MEMORY_KIT_LANG: 'en', MEMORY_KIT_MODE: 'local', MEMORY_KIT_SECTORS: 'core',
    });
    const res = runSh([], { env });
    assertFreshVault(vault, res, { history: src.commits });
    assert.equal(fs.readFileSync(path.join(vault, 'release-marker.txt'), 'utf8'), 'v0.1.10\n');
    assert.match(res.stdout, /\(v0\.1\.10\)/);
  });

  test('without the answers it stops after the download and says how to finish (exit 2); a rerun finishes', () => {
    const env = installEnv();
    const vault = path.join(tmpDir('sh-partial'), 'memory');
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault], { env });
    assert.equal(res.code, 2, res.all);
    assert.match(res.stdout, /node system\/init\.mjs --mode github --lang en --sectors core,work --yes/);
    assert.equal(readJson(path.join(vault, 'memory.json')).initialized, false);
    const done = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assert.match(done.stdout, /continuing with the setup/);
    assertFreshVault(vault, done);
  });

  test('a folder in the way is refused (exit 3) and left alone', () => {
    const parent = tmpDir('sh-other');
    const dir = path.join(parent, 'notes');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep\n');
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', dir, ...ANSWERS_SH], { env: installEnv() });
    assert.equal(res.code, 3, res.all);
    assert.match(res.stderr, /is not a memory-kit folder/);
    assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);
    assertNoLeftovers(parent);
  });

  test('a clone of the public kit repository is refused: notes must never be pushed there', () => {
    const vault = path.join(tmpDir('sh-public'), 'memory');
    copyKit(vault);
    const env = installEnv();
    assert.equal(git(vault, ['init', '-q'], env).status, 0);
    assert.equal(git(vault, ['remote', 'add', 'origin', 'https://github.com/8Krystof8/memory-kit.git'], env).status, 0);
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /clone of the public kit repository/);
    assert.equal(readJson(path.join(vault, 'memory.json')).initialized, false);
  });

  test('missing git and Node.js are reported with the commands to install them (exit 2)', () => {
    const empty = tmpDir('empty-path');
    const target = path.join(tmpDir('sh-missing'), 'memory');
    const res = runSh(['--yes', '--source', KIT_ROOT, '--dir', target], { env: installEnv({ PATH: empty }) });
    assert.equal(res.code, 2, res.all);
    assert.match(res.stderr, /git is missing/);
    assert.match(res.stderr, /Node\.js is missing: memory-kit needs 22\.5 or newer/);
    assert.match(res.stdout, /fnm install 24|brew install node/);
    assert.ok(!fs.existsSync(target));

    const old = runSh(['--yes', '--source', KIT_ROOT, '--dir', target], { env: installEnv({ PATH: fakeOldNode() }) });
    assert.equal(old.code, 2, old.all);
    assert.match(old.stderr, /Node\.js 20\.11\.1 is too old/);
    assert.ok(!fs.existsSync(target));
  });

  test('usage errors exit 2; --help exits 0', () => {
    const env = installEnv();
    assert.equal(runSh(['--mode', 'cloud'], { env }).code, 2);
    assert.equal(runSh(['--bogus'], { env }).code, 2);
    assert.equal(runSh(['--ref', '--yes'], { env }).code, 2);
    const help = runSh(['--help'], { env });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /MEMORY_KIT_DIR/);
  });

  test('sudo is refused (exit 3)', { skip: process.getuid?.() === 0 ? false : 'needs root' }, () => {
    const target = path.join(tmpDir('sh-sudo'), 'memory');
    const res = runSh(['--yes', '--source', KIT_ROOT, '--dir', target], { env: installEnv({ SUDO_USER: 'someone' }) });
    assert.equal(res.code, 3, res.all);
    assert.ok(!fs.existsSync(target));
  });

  test('look: color only when forced or on a terminal, NO_COLOR wins otherwise; UTF-8 glyphs with ASCII fallback', () => {
    const dir = path.join(tmpDir('sh-look'), 'taken');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.txt'), '');
    const args = ['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', dir];
    const fancy = runSh(args, { env: installEnv({ FORCE_COLOR: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'xterm-256color' }) });
    assert.ok(fancy.stdout.includes(`${ESC}32m\u2713${ESC}0m git`), fancy.stdout);
    const plain = runSh(args, { env: installEnv({ NO_COLOR: '1', LANG: 'C', LC_ALL: 'C', TERM: 'xterm' }) });
    assert.ok(!plain.all.includes('\u001b'), plain.all);
    assert.match(plain.stdout, /^ {2}\+ git /m);
    assert.match(plain.stdout, /^ {2}-{34}$/m);
  });

  test('interactive under curl | sh: prompts read the terminal; declining changes nothing (exit 130)',
    { skip: process.platform === 'linux' && findOnPath('script') ? false : 'needs util-linux script (a pseudo-terminal)' }, () => {
      const env = installEnv({ NO_COLOR: '1', TERM: 'xterm' });
      const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
      const command = `cat ${q(INSTALL_SH)} | sh -s -- --no-gh --source ${q(KIT_ROOT)}`;
      const res = run('script', ['-qec', command, '/dev/null'], { env, input: '\nn\n' });
      assert.equal(res.code, 130, res.all);
      assert.match(res.stdout, /Folder for your memory \[~\/memory\]/);
      assert.match(res.stdout, /Create the memory in ~\/memory\? \[Y\/n\]/);
      assert.match(res.stdout, /Nothing was changed/);
      assert.ok(!fs.existsSync(path.join(env.HOME, 'memory')));
    });
});

// ---------------------------------------------------------------------------------------------

for (const ps of POWERSHELLS) {
  const label = path.basename(ps).replace(/\.exe$/i, '');
  describe(`install.ps1 under ${label}`, { skip: HAS_GIT ? false : 'git is not installed' }, () => {
    test('parses without errors', () => {
      const script = '$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:MK_TEST_PS1, [ref]$t, [ref]$e); '
        + 'if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }; exit 0';
      const res = run(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, MK_TEST_PS1: INSTALL_PS1 } });
      assert.equal(res.code, 0, res.all);
    });

    test('-Yes with the answers: a set-up private memory without a remote; a second run changes nothing', () => {
      const env = installEnv();
      const vault = path.join(tmpDir(`ps-${label}`), VAULT_NAME);
      const res = runPs(ps, ['-Yes', '-NoGh', '-Source', KIT_ROOT, '-Dir', vault, ...ANSWERS_PS], { env });
      assertFreshVault(vault, res);

      const before = fs.readFileSync(path.join(vault, 'memory.json'), 'utf8');
      const again = runPs(ps, ['-Yes', '-NoGh', '-Source', KIT_ROOT, '-Dir', vault, ...ANSWERS_PS], { env });
      assertRerunSafe(vault, again, before);

      // irm | iex: the same run through Invoke-Expression (options from the environment) never
      // closes the window, leaves the code in $LASTEXITCODE and no function behind.
      const iex = 'Get-Content -Raw -LiteralPath $env:MK_TEST_PS1 | Invoke-Expression; \'still-alive:\' + $LASTEXITCODE; '
        + 'if (Get-Command Invoke-Quiet -ErrorAction SilentlyContinue) { \'leaked\' }';
      const viaIex = run(ps, ['-NoProfile', '-NonInteractive', '-Command', iex], {
        env: { ...env, MK_TEST_PS1: INSTALL_PS1, MEMORY_KIT_YES: '1', MEMORY_KIT_NO_GH: '1', MEMORY_KIT_SOURCE: KIT_ROOT, MEMORY_KIT_DIR: vault },
      });
      assert.equal(viaIex.code, 0, viaIex.all);
      assert.match(viaIex.stdout, /still-alive:0/);
      assert.ok(!viaIex.stdout.includes('leaked'), viaIex.stdout);
      assert.match(viaIex.stdout, /already; nothing was downloaded/);
    });

    test('from a git URL: the newest vX.Y.Z tag, cloned without its history', () => {
      const src = taggedSource();
      const vault = path.join(tmpDir(`ps-url-${label}`), 'memory');
      const res = runPs(ps, ['-Yes', '-NoGh', '-Source', src.url, '-Dir', vault, ...ANSWERS_PS], { env: installEnv() });
      assertFreshVault(vault, res, { history: src.commits });
      assert.equal(fs.readFileSync(path.join(vault, 'release-marker.txt'), 'utf8'), 'v0.1.10\n');
    });

    test('a folder in the way is refused (exit 3); usage errors exit 2', () => {
      const dir = path.join(tmpDir(`ps-other-${label}`), 'notes');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'mine.txt'), 'keep\n');
      const env = installEnv();
      const res = runPs(ps, ['-Yes', '-NoGh', '-Source', KIT_ROOT, '-Dir', dir], { env });
      assert.equal(res.code, 3, res.all);
      assert.match(res.stdout, /is not a memory-kit folder/);
      assert.deepEqual(fs.readdirSync(dir), ['mine.txt']);
      assert.equal(runPs(ps, ['-Mode', 'cloud'], { env }).code, 2);
    });

    // On Windows the installer first looks at the PATH of the system settings, which has them.
    test('missing git and Node.js are reported (exit 2)', { skip: IS_WIN ? 'Windows refreshes PATH from the registry' : false }, () => {
      const target = path.join(tmpDir(`ps-missing-${label}`), 'memory');
      const res = runPs(ps, ['-Yes', '-Source', KIT_ROOT, '-Dir', target], { env: installEnv({ PATH: tmpDir('empty-path') }) });
      assert.equal(res.code, 2, res.all);
      assert.match(res.stdout, /git is missing/);
      assert.match(res.stdout, /Node\.js is missing/);
      const old = runPs(ps, ['-Yes', '-Source', KIT_ROOT, '-Dir', target], { env: installEnv({ PATH: fakeOldNode() }) });
      assert.equal(old.code, 2, old.all);
      assert.match(old.stdout, /Node\.js 20\.11\.1 is too old/);
      assert.ok(!fs.existsSync(target));
    });
  });
}

test('install.ps1 runs under every PowerShell found', { skip: POWERSHELLS.length ? false : 'no powershell or pwsh here (set MEMORY_TEST_PWSH)' }, () => {
  assert.ok(POWERSHELLS.length > 0);
});

// ---------------------------------------------------------------------------------------------

const CHANGELOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  'Nothing yet.',
  '',
  '## 0.1.20 (2026-10-01)',
  '',
  'Twenty.',
  '',
  '## 0.1.2 (2026-09-25, not released yet)',
  '',
  'Two: [the guide](docs/projects.md#hooks), [site](https://example.com/x), [top](#top), [up](./README.md).',
  '',
  '```sh',
  '## a comment in a code block, not a heading',
  '```',
  '',
  '### Added',
  '',
  '- a thing',
  '',
  '',
  '## 0.1.1',
  '',
  'One.',
  '',
].join('\n');

describe('release-notes.mjs', () => {
  const two = [
    'Two: [the guide](docs/projects.md#hooks), [site](https://example.com/x), [top](#top), [up](./README.md).',
    '',
    '```sh',
    '## a comment in a code block, not a heading',
    '```',
    '',
    '### Added',
    '',
    '- a thing',
  ].join('\n');

  test('the section of a version: up to the next "## " heading, headings in code blocks are text', () => {
    assert.equal(extractSection(CHANGELOG, '0.1.2'), two);
    assert.equal(extractSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.2'), two);
    assert.equal(extractSection(CHANGELOG, '0.1.20'), 'Twenty.');
    assert.equal(extractSection(CHANGELOG, '0.1.1'), 'One.');
    assert.equal(extractSection(CHANGELOG, '0.1.0'), null);
    assert.equal(extractSection(CHANGELOG, '1.2'), null);
  });

  test('--repo links relative targets to the files at the tag', () => {
    assert.equal(absoluteLinks(two.split('\n')[0], '8Krystof8/memory-kit', 'v0.1.2'),
      'Two: [the guide](https://github.com/8Krystof8/memory-kit/blob/v0.1.2/docs/projects.md#hooks), '
      + '[site](https://example.com/x), [top](#top), [up](https://github.com/8Krystof8/memory-kit/blob/v0.1.2/README.md).');
  });

  test('the CLI: exit 0 with the notes, 1 for a version without a section, 2 for usage errors', () => {
    const file = path.join(tmpDir('notes'), 'CHANGELOG.md');
    fs.writeFileSync(file, CHANGELOG);
    const call = (argv) => {
      let out = '';
      let err = '';
      const code = releaseNotes(argv, { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } });
      return { code, out, err };
    };
    assert.deepEqual(call(['0.1.20', '--file', file]), { code: 0, out: 'Twenty.\n', err: '' });
    assert.equal(call(['v0.1.1', '--file', file]).out, 'One.\n');
    const missing = call(['9.9.9', '--file', file]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no section "## 9\.9\.9"/);
    assert.equal(call(['nonsense', '--file', file]).code, 2);
    assert.equal(call(['0.1.2', '0.1.1', '--file', file]).code, 2);
    assert.equal(call(['0.1.2', '--file', file, '--repo', 'no slash']).code, 2);
  });

  test('the real CHANGELOG.md has non-empty sections for 0.1.1 and 0.1.2, each without the other', () => {
    const text = fs.readFileSync(path.join(KIT_ROOT, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    const sections = {};
    for (const version of ['0.1.1', '0.1.2']) {
      const section = extractSection(text, version);
      assert.ok(section, `CHANGELOG.md has a section for ${version}`);
      assert.ok(text.includes(section), 'the section is a verbatim part of the file');
      assert.ok(!section.split('\n').some((line) => line.startsWith('## ')), 'no other version inside');
      sections[version] = section;
    }
    assert.ok(!sections['0.1.2'].includes(sections['0.1.1'].split('\n')[0]));
    const res = run(process.execPath, [path.join(KIT_ROOT, 'system', 'tools', 'release-notes.mjs'), '0.1.2', '--repo', '8Krystof8/memory-kit']);
    assert.equal(res.code, 0, res.all);
    assert.ok(res.stdout.length > 100);
    assert.ok(!/\]\((?!https?:|#)/.test(res.stdout), 'every link is absolute');
  });
});

describe('release workflow', () => {
  const read = (rel) => fs.readFileSync(path.join(KIT_ROOT, ...rel.split('/')), 'utf8');
  const release = read('.github/workflows/release.yml');
  const ci = read('.github/workflows/ci.yml');

  test('runs on pushes to main and by hand (inputs ref and version), with contents: write', () => {
    assert.match(release, /\non:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/);
    assert.match(release, /\n {6}ref:\n/);
    assert.match(release, /\n {6}version:\n/);
    assert.match(release, /\npermissions:\n {2}contents: read\n/);
    assert.match(release, /\n {4}permissions:\n {6}contents: write\n/);
  });

  test('only in the public kit: private repositories and set-up vaults skip it', () => {
    assert.match(release, /if: \$\{\{ github\.event\.repository\.private == false \}\}/);
    assert.match(release, /initialized === true \? 0 : 1/);
  });

  test('actions pinned by commit SHA, the same ones ci.yml uses', () => {
    const uses = (text) => [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    for (const ref of uses(release)) {
      assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref);
      assert.ok(uses(ci).includes(ref), `${ref} is the pin ci.yml uses`);
    }
  });

  test('idempotent: an existing tag means nothing to do; notes from release-notes.mjs; a backfill is not "Latest"', () => {
    assert.match(release, /git ls-remote --exit-code --tags origin "refs\/tags\/\$tag"/);
    assert.match(release, /node system\/tools\/release-notes\.mjs "\$version" --repo "\$GITHUB_REPOSITORY"/);
    assert.match(release, /gh release create "\$tag"/);
    assert.match(release, /--latest="\$latest"/);
    assert.ok(!release.slice(release.indexOf('run: |')).includes('${{'), 'inputs reach the script only through env variables');
  });

  test('ci.yml runs shellcheck on install.sh on Linux', () => {
    assert.match(ci, /if: \$\{\{ !cancelled\(\) && runner\.os == 'Linux' \}\}\n {8}run: shellcheck --shell=sh install\.sh/);
  });
});
