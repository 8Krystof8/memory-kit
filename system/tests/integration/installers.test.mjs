// The one-line installers (install.sh, install.ps1) and the release tooling (release-notes.mjs,
// .github/workflows/release.yml). The installers run for real against this checkout (--source
// <folder>) or a tagged git copy of it, with a temporary HOME and git identity: the result must be
// an initialized memory that passes check, with no git remote and none of the kit's history, and a
// second run must change nothing. Missing prerequisites are simulated with a PATH that lacks them.
// install.sh needs a POSIX sh (not on Windows). install.ps1 runs under every PowerShell found:
// powershell (Windows PowerShell 5.1) and pwsh on PATH, plus the one MEMORY_TEST_PWSH names.
// GitHub is never contacted: a fake gh on PATH stands in for the GitHub CLI, a small local HTTP
// server for api.github.com (MEMORY_KIT_GITHUB_API), and git's url.<x>.insteadOf sends the
// public kit URL to a tagged local copy. Interactive runs use a pseudo-terminal (util-linux script).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { groupOf, hashFile, loadHistory, loadManifest } from '../../lib/kit.mjs';
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
// The Ubuntu runners of GitHub Actions come with shellcheck: there its absence is a failure.
const SHELLCHECK_REQUIRED = process.env.GITHUB_ACTIONS === 'true' && process.platform === 'linux';
const PTY = process.platform === 'linux' && findOnPath('script') ? false : 'needs util-linux script (a pseudo-terminal)';
const KIT_URL = 'https://github.com/8Krystof8/memory-kit.git';

// Variables that would change what the installer or the kit does; the tests set them explicitly.
const SCRUB = ['CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITPOD_WORKSPACE_ID', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT',
  'MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NO_COLOR', 'FORCE_COLOR', 'CI', 'SUDO_USER', 'MEMORY_DEBUG',
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR'];
const NO_PROXY = ['127.0.0.1', 'localhost', process.env.NO_PROXY ?? process.env.no_proxy].filter(Boolean).join(',');

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
    // Nothing listens there: a privacy check of a GitHub remote says "cannot tell" at once.
    MEMORY_KIT_GITHUB_API: 'http://127.0.0.1:9',
    NO_PROXY,
    no_proxy: NO_PROXY,
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

/** env with git sending the public kit URL to the tagged local copy (see taggedSource). */
function withKitUrl(env) {
  fs.appendFileSync(env.GIT_CONFIG_GLOBAL, `[url "${taggedSource().url}"]\n\tinsteadOf = ${KIT_URL}\n`);
  return env;
}

/** A copy of this kit with a git remote per [name, url]. */
function kitWithRemotes(label, remotes, env) {
  const dir = path.join(tmpDir(label), 'memory');
  copyKit(dir);
  assert.equal(git(dir, ['init', '-q'], env).status, 0);
  for (const [name, url] of remotes) assert.equal(git(dir, ['remote', 'add', name, url], env).status, 0);
  return dir;
}

/** A git repository of someone else (a client project) with a remote. */
function clientRepo(env) {
  const client = path.join(tmpDir('client'), 'client-acme');
  fs.mkdirSync(client);
  assert.equal(git(client, ['init', '-q'], env).status, 0);
  assert.equal(git(client, ['remote', 'add', 'origin', 'git@github.com:acme-corp/secret-app.git'], env).status, 0);
  return client;
}

// A fake GitHub CLI: logged in as `tester`; every call is logged; `repo view` knows the
// repositories of state.repos (owner/name -> visibility); `repo create NAME ... --clone` clones a
// copy of this kit into ./NAME with the origin https://github.com/tester/NAME.git.
const FAKE_GH_JS = `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const [a, b, ...rest] = args;
if (a === 'auth' && b === 'status') process.exit(state.loggedIn ? 0 : 1);
if (a === 'api' && b === 'user') { console.log(state.user); process.exit(0); }
if (a === 'repo' && b === 'view') {
  const visibility = state.repos[String(rest[0]).toLowerCase()];
  if (!visibility) { console.error('GraphQL: Could not resolve to a Repository'); process.exit(1); }
  if (rest.includes('--json')) console.log(visibility);
  process.exit(0);
}
if (a === 'repo' && b === 'create') {
  const name = rest[0];
  const dest = path.join(process.cwd(), name);
  fs.cpSync(state.template, dest, { recursive: true });
  const git = (...g) => spawnSync('git', g, { cwd: dest, stdio: 'ignore', windowsHide: true });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'Initial commit');
  git('remote', 'add', 'origin', 'https://github.com/' + state.user + '/' + name + '.git');
  state.repos[(state.user + '/' + name).toLowerCase()] = state.createAs;
  fs.writeFileSync(file, JSON.stringify(state));
  process.exit(0);
}
process.exit(1);
`;

let ghTemplate = null;
function fakeGh({ repos = {}, createAs = 'PRIVATE', loggedIn = true } = {}) {
  ghTemplate ??= copyKit(path.join(tmpDir('gh-template'), 'memory-kit'));
  const dir = tmpDir('fake-gh');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const script = path.join(dir, 'gh.mjs');
  const state = path.join(dir, 'state.json');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(script, FAKE_GH_JS);
  fs.writeFileSync(state, JSON.stringify({ user: 'tester', loggedIn, createAs, template: ghTemplate, repos }));
  if (IS_WIN) fs.writeFileSync(path.join(bin, 'gh.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  else fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: state, FAKE_GH_LOG: log },
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    created: () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"create"'),
  };
}
const GH_CREATE = ['repo', 'create', 'memory', '--template', '8Krystof8/memory-kit', '--private', '--clone'];

// A stand-in for api.github.com in its own process (the tests block in spawnSync): 200 for the
// public repositories named on its command line, 404 (private or missing) for every other one.
const API_STUB_JS = `const http = require('node:http');
const open = new Set(process.argv.slice(1).map((s) => s.toLowerCase()));
const server = http.createServer((req, res) => {
  const m = /^\\/repos\\/([^/]+\\/[^/]+)$/.exec(req.url);
  res.writeHead(m && open.has(m[1].toLowerCase()) ? 200 : 404, { 'content-type': 'application/json' });
  res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

let apiStub = null;
async function githubApi() {
  if (apiStub) return apiStub.url;
  const child = spawn(process.execPath, ['-e', API_STUB_JS, 'octocat/memory-kit'], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (d) => resolve(d.trim()));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the GitHub API stub exited (${code})`)));
  });
  child.stdout.destroy();
  child.unref();
  apiStub = { child, url: `http://127.0.0.1:${port}` };
  return apiStub.url;
}
after(() => apiStub?.child.kill());

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A pseudo-terminal run of a sh command line: every prompt reads the lines of input. */
function runPty(command, { env, input, cwd }) {
  return run('script', ['-qec', command, '/dev/null'], { env, input, cwd });
}

/**
 * A pseudo-terminal conversation: each [pattern, keys] of answers is typed 400 ms after pattern
 * shows up in the output that came after the previous answer (the setup wizard drops keys typed
 * before its prompt is drawn). → { code, stdout (escape codes removed), answered }.
 */
function ptyTalk(command, { env, cwd, answers, timeout = 150_000 }) {
  return new Promise((resolve) => {
    const child = spawn('script', ['-qec', command, '/dev/null'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = setTimeout(() => child.kill('SIGKILL'), timeout);
    let out = '';
    let from = 0;
    let answered = 0;
    let typing = false;
    const check = () => {
      if (typing || answered >= answers.length) return;
      const [pattern, keys] = answers[answered];
      if (!pattern.test(out.slice(from))) return;
      typing = true;
      setTimeout(() => {
        child.stdin.write(keys);
        from = out.length;
        answered += 1;
        typing = false;
        check();
      }, 400);
    };
    child.stdout.on('data', (d) => {
      out += d;
      check();
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      child.stdin.destroy();
      resolve({ code, stdout: out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''), answered });
    });
  });
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

  test('install.ps1: Windows PowerShell 5.1 syntax (no &&, ||, ??, `e or $PSStyle), all of it in & { } @args', () => {
    const text = fs.readFileSync(INSTALL_PS1, 'utf8');
    const code = text.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    for (const token of [' && ', ' || ', ' ?? ', '`e', '$PSStyle', '::new(']) {
      assert.ok(!code.some((line) => line.includes(token)), `no ${token.trim()} in install.ps1`);
    }
    // Under irm | iex the text runs in the caller's scope: a top-level param() would overwrite the
    // caller's variables, and exit would end the caller (its window, or the script around it).
    const outside = code.join('\n').split(/^& \{$/m);
    assert.equal(outside.length, 2, 'one & { at the top level');
    assert.equal(outside[0].trim(), '', 'nothing before & { (no top-level param())');
    assert.ok(text.endsWith('\n  if ($FromFile) { exit $st.code }\n  $global:LASTEXITCODE = $st.code\n} @args\n'));
    assert.match(text, /\n {2}\$FromFile = \[bool\]\(\{ \}\.File\)\n/, 'exit only from a script file, never under iex');
    assert.ok(!/\$script:/.test(code.join('\n')), 'no script-scope variables (under iex that is the user\'s session)');
  });

  test('the kit owns both installers (upgrades ship them), but not the maintainers\' release workflow', () => {
    const manifest = loadManifest(KIT_ROOT);
    for (const rel of ['install.sh', 'install.ps1']) {
      assert.equal(groupOf(rel), 'config', rel);
      assert.equal(manifest.files[rel]?.group, 'config', `system/kit.json lists ${rel} (run: node system/tools/release.mjs)`);
    }
    // A changed workflow file in an upgrade makes the vault's next push need a token with the
    // `workflow` scope (gh's default login has none), and release.yml never runs in a vault.
    assert.equal(groupOf('.github/workflows/release.yml'), null);
    assert.equal(manifest.files['.github/workflows/release.yml'], undefined);
    assert.equal(groupOf('system/tools/release-notes.mjs'), 'code');
  });

  test('0.1.2 ships the ci.yml of 0.1.1, so upgraded vaults push no workflow change', () => {
    const history = loadHistory(KIT_ROOT);
    assert.ok(history['0.1.1']?.['.github/workflows/ci.yml']);
    assert.equal(hashFile(path.join(KIT_ROOT, '.github', 'workflows', 'ci.yml')), history['0.1.1']['.github/workflows/ci.yml']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('install.sh', { skip: !SH ? 'install.sh is for macOS and Linux' : !HAS_GIT ? 'git is not installed' : false }, () => {
  test('parses (sh -n)', () => {
    const res = run(SH, ['-n', INSTALL_SH]);
    assert.equal(res.code, 0, res.all);
  });

  test('shellcheck finds nothing', { skip: SHELLCHECK || SHELLCHECK_REQUIRED ? false : 'shellcheck is not installed' }, () => {
    assert.ok(SHELLCHECK, 'shellcheck comes with the Ubuntu runners of GitHub Actions');
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
    const env = installEnv();
    const vault = kitWithRemotes('sh-public', [['origin', KIT_URL]], env);
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assert.equal(res.code, 3, res.all);
    assert.match(res.all, /clone of the public kit repository/);
    assert.match(res.stdout, /remote remove origin/);
    assert.equal(readJson(path.join(vault, 'memory.json')).initialized, false);

    // The kit as another remote: the advice removes that one, not the owner's own origin.
    const both = kitWithRemotes('sh-upstream', [['origin', 'https://github.com/me/my-memory.git'], ['upstream', KIT_URL]], env);
    const res2 = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', both, ...ANSWERS_SH], { env });
    assert.equal(res2.code, 3, res2.all);
    assert.match(res2.stdout, /remote remove upstream\n/);
    assert.doesNotMatch(res2.stdout, /remote remove origin/);
  });

  test('a folder whose GitHub remote is public (a fork, a public template copy) is refused; a private one goes on', async () => {
    const env = installEnv({ MEMORY_KIT_GITHUB_API: await githubApi() });
    const answers = ['--yes', '--no-gh', '--mode', 'github', '--lang', 'en', '--sectors', 'core'];
    const fork = kitWithRemotes('sh-fork', [['origin', 'https://github.com/octocat/memory-kit.git']], env);
    const res = runSh([...answers, '--dir', fork], { env });
    assert.equal(res.code, 3, res.all);
    assert.match(res.stderr, /the remote origin is the PUBLIC GitHub repository octocat\/memory-kit/);
    assert.equal(readJson(path.join(fork, 'memory.json')).initialized, false, 'nothing was set up');

    const own = kitWithRemotes('sh-own', [['origin', 'git@github.com:me/my-memory.git']], env);
    const done = runSh([...answers, '--dir', own], { env });
    assert.equal(done.code, 0, done.all);
    assert.match(done.stdout, /the GitHub repository me\/my-memory is not public/);
    assert.equal(readJson(path.join(own, 'memory.json')).initialized, true);
    assert.match(done.stdout, /^ {4}git push$/m);

    // No answer from GitHub: a warning, not a refusal.
    const offline = runSh(['--yes', '--no-gh', '--dir', own], { env: installEnv() });
    assert.equal(offline.code, 0, offline.all);
    assert.match(offline.stdout, /cannot tell whether the GitHub repository me\/my-memory is private/);
  });

  test('a new memory inside another git work tree is refused, unless that repository ignores it', () => {
    const env = installEnv();
    const client = clientRepo(env);
    const vault = path.join(client, 'notes');
    const res = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assert.equal(res.code, 3, res.all);
    assert.match(res.stderr, /notes is inside the git repository .*client-acme/);
    assert.match(res.stdout, /MEMORY_KIT_ALLOW_NESTED=1/);
    const relative = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', 'notes', ...ANSWERS_SH], { env, cwd: client });
    assert.equal(relative.code, 3, relative.all);
    assert.equal(git(client, ['status', '--porcelain'], env).stdout, '', 'nothing was created in the client repository');

    // MEMORY_KIT_ALLOW_NESTED=1 lets it through (without the answers it stops after the download).
    const allowed = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault], { env: { ...env, MEMORY_KIT_ALLOW_NESTED: '1' } });
    assert.equal(allowed.code, 2, allowed.all);
    assert.match(allowed.stdout, /is inside the git repository .*MEMORY_KIT_ALLOW_NESTED=1/);
    fs.rmSync(vault, { recursive: true, force: true });

    // Both folders ignored there: nothing of the memory can reach that repository.
    fs.writeFileSync(path.join(client, '.gitignore'), 'notes/\nnotes-private/\n');
    const ignored = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assertFreshVault(vault, ignored);
    assert.equal(git(client, ['status', '--porcelain'], env).stdout, '?? .gitignore\n');
  });

  test('the setup\'s own ending: cancelled (130) and "not now" give 130; its other failures 1', () => {
    const src = copyKit(path.join(tmpDir('fake-init'), 'kit'));
    fs.writeFileSync(path.join(src, 'system', 'init.mjs'), 'process.exit(Number(process.env.FAKE_INIT_EXIT));\n');
    const vault = path.join(tmpDir('sh-cancel'), 'memory');
    const args = ['--yes', '--no-gh', '--source', src, '--dir', vault, ...ANSWERS_SH];
    const cancelled = runSh(args, { env: installEnv({ FAKE_INIT_EXIT: '130' }) });
    assert.equal(cancelled.code, 130, cancelled.all);
    assert.match(cancelled.stdout, /The setup was cancelled; the kit stays in place/);
    assert.doesNotMatch(cancelled.all, /did not finish/);
    const notNow = runSh(args, { env: installEnv({ FAKE_INIT_EXIT: '0' }) });
    assert.equal(notNow.code, 130, notNow.all);
    assert.match(notNow.stdout, /continuing with the setup/);
    assert.doesNotMatch(notNow.stdout, /Your memory is ready/);
    const internal = runSh(args, { env: installEnv({ FAKE_INIT_EXIT: '3' }) });
    assert.equal(internal.code, 1, internal.all);
    assert.match(internal.stderr, /the setup did not finish \(init exit 3\)/);
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

  test('interactive under curl | sh: prompts read the terminal; declining changes nothing (exit 130)', { skip: PTY }, () => {
    const env = installEnv({ NO_COLOR: '1', TERM: 'xterm' });
    const command = `cat ${q(INSTALL_SH)} | sh -s -- --no-gh --source ${q(KIT_ROOT)}`;
    // Blanks alone are the default answer, not a folder named " ".
    const res = runPty(command, { env, input: '   \nn\n', cwd: tmpDir('cwd') });
    assert.equal(res.code, 130, res.all);
    assert.match(res.stdout, /Folder for your memory \[~\/memory\]/);
    assert.match(res.stdout, /Create the memory in ~\/memory\? \[Y\/n\]/);
    assert.match(res.stdout, /Nothing was changed/);
    assert.ok(!fs.existsSync(path.join(env.HOME, 'memory')));

    // A folder name typed at the prompt is in the home folder (the prompt shows ~/memory), not in
    // the directory the installer happens to run in.
    const cwd = tmpDir('cwd');
    const named = runPty(command, { env, input: ' notes \nn\n', cwd });
    assert.equal(named.code, 130, named.all);
    assert.match(named.stdout, /Create the memory in ~\/notes\? \[Y\/n\]/);
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  test('interactive with --mode: the setup wizard asks the rest, never the mode again', { skip: PTY }, async () => {
    // The installer passes the mode it asked (or was given) to init as --mode; the wizard then
    // starts with the language, and its answers are the ones set up.
    const env = installEnv({ NO_COLOR: '1', TERM: 'xterm', LANG: 'en_US.UTF-8' });
    const vault = path.join(env.HOME, 'memory');
    const res = await ptyTalk(`sh ${q(INSTALL_SH)} --no-gh --source ${q(KIT_ROOT)} --dir ${q(vault)} --mode github`, {
      env,
      cwd: env.HOME,
      answers: [
        [/Create the memory in ~\/memory\? \[Y\/n\]/, 'y\n'],
        [/Language of the memory/, '\r'],
        [/Which sectors/, '\r'],
        [/Which AI tools/, '\r'],
        [/Set up the memory now\?/, '\r'],
        [/Anything else\?/, `${ESC}B${ESC}B${ESC}B\r`], // Finish
      ],
    });
    assert.equal(res.code, 0, res.stdout);
    assert.equal(res.answered, 6, res.stdout);
    assert.doesNotMatch(res.stdout, /Where should the memory live\?/);
    assert.match(res.stdout, /Your memory is ready/);
    const cfg = readJson(path.join(vault, 'memory.json'));
    assert.deepEqual([cfg.initialized, cfg.mode, cfg.lang], [true, 'github', 'en']);
  });

  test('an existing memory: doctor and upgrade are offered, and a newer kit is shown with both versions', { skip: PTY }, () => {
    const env = installEnv({ NO_COLOR: '1', TERM: 'xterm' });
    const vault = path.join(tmpDir('sh-vault-flow'), 'memory');
    const made = runSh(['--yes', '--no-gh', '--source', KIT_ROOT, '--dir', vault, ...ANSWERS_SH], { env });
    assert.equal(made.code, 0, made.all);
    const versionFile = path.join(vault, 'system', 'VERSION');
    const commit = (message) => {
      assert.equal(git(vault, ['add', '-A'], env).status, 0);
      assert.equal(git(vault, ['commit', '-q', '--no-verify', '-m', message], env).status, 0);
    };
    commit('Set up memory');
    fs.writeFileSync(versionFile, '0.1.1\n');
    commit('an older kit');
    const kitVersion = fs.readFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), 'utf8').trim();
    const res = runPty(`sh ${q(INSTALL_SH)} --no-gh --source ${q(KIT_ROOT)} --dir ${q(vault)}`, { env, input: 'n\nn\n' });
    assert.equal(res.code, 0, res.all);
    assert.match(res.stdout, /Check it with doctor now\? \[Y\/n\]/);
    assert.ok(res.stdout.includes(`memory-kit ${kitVersion} is available (this memory has 0.1.1)`), res.stdout);
    assert.match(res.stdout, /Upgrade now\?/);
    assert.equal(fs.readFileSync(versionFile, 'utf8'), '0.1.1\n', 'declined: nothing changed');
  });
});

// ---------------------------------------------------------------------------------------------

describe('install.sh with the GitHub CLI (a fake gh)', { skip: !SH ? 'install.sh is for macOS and Linux' : !HAS_GIT ? 'git is not installed' : false }, () => {
  const GH_ANSWERS = ['--yes', '--mode', 'github', '--lang', 'en', '--sectors', 'core'];

  test('a private repository from the template: the exact gh command, the setup, and a push to do', () => {
    const gh = fakeGh();
    const parent = tmpDir('sh-gh');
    const vault = path.join(parent, 'memory');
    const res = runSh([...GH_ANSWERS, '--dir', vault], { env: installEnv(gh.env) });
    assert.equal(res.code, 0, res.all);
    const calls = gh.calls();
    assert.deepEqual(calls.filter((c) => c[1] === 'create'), [GH_CREATE]);
    assert.ok(!calls.flat().includes('--include-all-branches'), 'never the dev and other branches of the kit');
    assert.deepEqual(calls.at(-1), ['repo', 'view', 'tester/memory', '--json', 'visibility', '--jq', '.visibility']);
    assert.match(res.stdout, /in the private repository tester\/memory/);
    assert.equal(git(vault, ['remote', 'get-url', 'origin']).stdout.trim(), 'https://github.com/tester/memory.git');
    const cfg = readJson(path.join(vault, 'memory.json'));
    assert.equal(cfg.initialized, true);
    assert.equal(cfg.mode, 'github');
    assert.match(res.stdout, /^ {4}git push$/m);
    assertNoLeftovers(parent);
  });

  test('a repository that came out public: exit 3 and no folder; an existing name: exit 1 and the clone command', () => {
    const pub = fakeGh({ createAs: 'PUBLIC' });
    const parent = tmpDir('sh-gh-public');
    const vault = path.join(parent, 'memory');
    const res = runSh([...GH_ANSWERS, '--dir', vault], { env: installEnv(pub.env) });
    assert.equal(res.code, 3, res.all);
    assert.match(res.stderr, /tester\/memory is not private \(PUBLIC\)/);
    assert.deepEqual(fs.readdirSync(parent), [], 'no folder is left behind');

    const taken = fakeGh({ repos: { 'tester/memory': 'PRIVATE' } });
    const again = runSh([...GH_ANSWERS, '--dir', vault], { env: installEnv(taken.env) });
    assert.equal(again.code, 1, again.all);
    assert.match(again.stderr, /the repository tester\/memory exists already/);
    assert.match(again.stdout, /gh repo clone tester\/memory /);
    assert.ok(!taken.created());
    assert.deepEqual(fs.readdirSync(parent), []);
  });

  test('--ref, --no-gh and mode local never use gh (the template has only the newest kit)', () => {
    for (const [label, args, why] of [
      ['ref', ['--ref', 'v0.1.9', '--mode', 'github'], /GitHub CLI not used \(--ref v0\.1\.9/],
      ['no-gh', ['--no-gh', '--mode', 'github'], /GitHub CLI not used \(--no-gh\)/],
      ['local', ['--mode', 'local'], /GitHub CLI not used \(mode local/],
    ]) {
      const gh = fakeGh();
      const vault = path.join(tmpDir(`sh-nogh-${label}`), 'memory');
      const res = runSh(['--yes', '--lang', 'en', '--sectors', 'core', '--dir', vault, ...args], { env: withKitUrl(installEnv(gh.env)) });
      assert.equal(res.code, 0, `${label}: ${res.all}`);
      assert.match(res.stdout, why);
      assert.ok(!gh.created(), `${label}: no repository was created`);
      assert.equal(git(vault, ['remote']).stdout.trim(), '', `${label}: no remote`);
      if (label === 'ref') assert.ok(!fs.existsSync(path.join(vault, 'release-marker.txt')), 'v0.1.9 has no marker');
      else assert.equal(fs.readFileSync(path.join(vault, 'release-marker.txt'), 'utf8'), 'v0.1.10\n');
    }
  });

  test('an existing folder whose remote gh reports public is refused (exit 3)', () => {
    const gh = fakeGh({ repos: { 'me/my-memory': 'PUBLIC' } });
    const env = installEnv(gh.env);
    const dir = kitWithRemotes('sh-gh-own', [['origin', 'https://github.com/me/my-memory.git']], env);
    const res = runSh([...GH_ANSWERS, '--dir', dir], { env });
    assert.equal(res.code, 3, res.all);
    assert.match(res.stderr, /PUBLIC GitHub repository me\/my-memory/);
    assert.equal(readJson(path.join(dir, 'memory.json')).initialized, false);
  });

  test('interactive: the mode is asked before GitHub is offered; local never creates a repository', { skip: PTY }, () => {
    const command = `cat ${q(INSTALL_SH)} | sh -s -- --lang en --sectors core`;
    // Enter for the folder, 2 (local), yes to creating the memory.
    const gh = fakeGh();
    const env = withKitUrl(installEnv({ ...gh.env, NO_COLOR: '1', TERM: 'xterm' }));
    const res = runPty(command, { env, input: '\n2\ny\n' });
    assert.equal(res.code, 0, res.all);
    assert.match(res.stdout, /Where should the memory live\?/);
    assert.doesNotMatch(res.stdout, /Create the private GitHub repository/);
    assert.ok(!gh.created(), 'no repository on GitHub');
    const local = path.join(env.HOME, 'memory');
    assert.equal(readJson(path.join(local, 'memory.json')).mode, 'local');
    assert.equal(git(local, ['remote']).stdout.trim(), '');

    // Enter everywhere: github, the private repository from the template, and init gets the mode.
    const gh2 = fakeGh();
    const env2 = withKitUrl(installEnv({ ...gh2.env, NO_COLOR: '1', TERM: 'xterm' }));
    const res2 = runPty(command, { env: env2, input: '\n\n\n\n' });
    assert.equal(res2.code, 0, res2.all);
    assert.match(res2.stdout, /Create the private GitHub repository tester\/memory for it\? \[Y\/n\]/);
    assert.deepEqual(gh2.calls().filter((c) => c[1] === 'create'), [GH_CREATE]);
    assert.equal(readJson(path.join(env2.HOME, 'memory', 'memory.json')).mode, 'github');
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

      // irm | iex at the prompt (options from the environment): the code is left in $LASTEXITCODE.
      const iexEnv = { ...env, MK_TEST_PS1: INSTALL_PS1, MEMORY_KIT_YES: '1', MEMORY_KIT_NO_GH: '1', MEMORY_KIT_SOURCE: KIT_ROOT, MEMORY_KIT_DIR: vault };
      const iex = 'Get-Content -Raw -LiteralPath $env:MK_TEST_PS1 | Invoke-Expression; \'still-alive:\' + $LASTEXITCODE';
      const viaIex = run(ps, ['-NoProfile', '-NonInteractive', '-Command', iex], { env: iexEnv });
      assert.equal(viaIex.code, 0, viaIex.all);
      assert.match(viaIex.stdout, /already; nothing was downloaded/);
      assert.match(viaIex.stdout, /still-alive:0/);

      // irm | iex inside a script file, as a CI step runs it: the installer never ends the script
      // around it (not even on success), and leaves nothing behind: no function, and the caller's
      // $Dir, $Mode, $Help and $ErrorActionPreference as they were.
      const step = path.join(tmpDir(`ps-step-${label}`), 'step.ps1');
      fs.writeFileSync(step, [
        "$Dir = 'mine'; $Mode = 'keep'; $Help = 'x'; $ErrorActionPreference = 'Continue'",
        'Get-Content -Raw -LiteralPath $env:MK_TEST_PS1 | Invoke-Expression',
        "'next step ran:' + $LASTEXITCODE + ' [' + $Dir + '|' + $Mode + '|' + $Help + '|' + $ErrorActionPreference + ']'",
        "if (Get-Command Invoke-Quiet -ErrorAction SilentlyContinue) { 'leaked' }",
        '& ([scriptblock]::Create((Get-Content -Raw -LiteralPath $env:MK_TEST_PS1))) -Bogus',
        "'after an unknown parameter:' + $LASTEXITCODE",
        '',
      ].join('\n'));
      const stepArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', step];
      const inStep = run(ps, stepArgs, { env: iexEnv });
      assert.equal(inStep.code, 0, inStep.all);
      assert.match(inStep.stdout, /already; nothing was downloaded/);
      assert.match(inStep.stdout, /next step ran:0 \[mine\|keep\|x\|Continue\]/);
      assert.ok(!inStep.stdout.includes('leaked'), inStep.stdout);
      assert.match(inStep.stdout, /unknown parameter: -Bogus/);
      assert.match(inStep.stdout, /after an unknown parameter:2/);
      const failing = run(ps, stepArgs, { env: { ...iexEnv, MEMORY_KIT_MODE: 'cloud' } });
      assert.match(failing.stdout, /next step ran:2 \[mine\|keep\|x\|Continue\]/, failing.all);
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
      assert.equal(runPs(ps, ['-Bogus'], { env }).code, 2);
    });

    test('a new memory inside another git work tree is refused (exit 3)', () => {
      const env = installEnv();
      const client = clientRepo(env);
      const res = runPs(ps, ['-Yes', '-NoGh', '-Source', KIT_ROOT, '-Dir', path.join(client, 'notes'), ...ANSWERS_PS], { env });
      assert.equal(res.code, 3, res.all);
      assert.match(res.stdout, /is inside the git repository/);
      assert.equal(git(client, ['status', '--porcelain'], env).stdout, '');
    });

    test('remotes: the kit as upstream is named in the advice; a public GitHub remote is refused', async () => {
      const env = installEnv({ MEMORY_KIT_GITHUB_API: await githubApi() });
      const answers = ['-Yes', '-NoGh', '-Mode', 'github', '-Lang', 'en', '-Sectors', 'core'];
      const both = kitWithRemotes(`ps-upstream-${label}`, [['origin', 'https://github.com/me/my-memory.git'], ['upstream', KIT_URL]], env);
      const res = runPs(ps, [...answers, '-Dir', both], { env });
      assert.equal(res.code, 3, res.all);
      assert.match(res.stdout, /remote remove upstream/);
      assert.doesNotMatch(res.stdout, /remote remove origin/);

      const fork = kitWithRemotes(`ps-fork-${label}`, [['origin', 'https://github.com/octocat/memory-kit.git']], env);
      const pub = runPs(ps, [...answers, '-Dir', fork], { env });
      assert.equal(pub.code, 3, pub.all);
      assert.match(pub.stdout, /the remote origin is the PUBLIC GitHub repository octocat\/memory-kit/);
      assert.equal(readJson(path.join(fork, 'memory.json')).initialized, false);

      const own = kitWithRemotes(`ps-own-${label}`, [['origin', 'git@github.com:me/my-memory.git']], env);
      const priv = runPs(ps, ['-Yes', '-NoGh', '-Dir', own], { env });
      assert.equal(priv.code, 2, priv.all);
      assert.match(priv.stdout, /the GitHub repository me\/my-memory is not public/);
      assert.match(priv.stdout, /--mode github or combined: this folder has a remote/);
    });

    test('with a logged-in gh (a fake): a private repository from the template; a public one is refused', () => {
      const gh = fakeGh();
      const parent = tmpDir(`ps-gh-${label}`);
      const vault = path.join(parent, 'memory');
      const answers = ['-Yes', '-Mode', 'github', '-Lang', 'en', '-Sectors', 'core'];
      const res = runPs(ps, [...answers, '-Dir', vault], { env: installEnv(gh.env) });
      assert.equal(res.code, 0, res.all);
      assert.deepEqual(gh.calls().filter((c) => c[1] === 'create'), [GH_CREATE]);
      assert.equal(git(vault, ['remote', 'get-url', 'origin']).stdout.trim(), 'https://github.com/tester/memory.git');
      assert.equal(readJson(path.join(vault, 'memory.json')).mode, 'github');
      assertNoLeftovers(parent);

      const pub = fakeGh({ createAs: 'PUBLIC' });
      const other = tmpDir(`ps-gh-public-${label}`);
      const bad = runPs(ps, [...answers, '-Dir', path.join(other, 'memory')], { env: installEnv(pub.env) });
      assert.equal(bad.code, 3, bad.all);
      assert.match(bad.stdout, /tester\/memory is not private \(PUBLIC\)/);
      assert.deepEqual(fs.readdirSync(other), []);
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
});
