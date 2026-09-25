// `doctor`: every check on real vaults (a copy of the kit set up with init, the fixture notes and
// git, cloned per test), through the library in-process and through the CLI. Every report is
// validated against system/schema/doctor-result.schema.json.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from '../../lib/config.mjs';
import {
  CHECK_IDS, DEFAULTS, IO, cloudService, cmpVersion, diagnose, formatReport, hasEolRule, say, sessionStartHooks,
  uncoveredSources,
} from '../../lib/doctor.mjs';
import { applyRepairs, hookBytes } from '../../lib/commands/doctor.mjs';
import { EVENTS, hookGroups, installProjects, planHooks } from '../../lib/hooksetup.mjs';
import { LOG_REL, logHook } from '../../lib/hooklog.mjs';
import { buildManifest, hashText } from '../../lib/kit.mjs';
import { loadSchema, validate } from '../../lib/schema.mjs';
import {
  FIXTURES_DIR, KIT_ROOT, TODAY, bareRoot, cloneDir, copyKit, fixtureVault, overlay, readFile, removeTmpDirs, runCli, runInit,
  tmpDir, writeFile, writeJson,
} from '../helpers.mjs';

after(removeTmpDirs);

// ---------------------------------------------------------------------------------------------
// Helpers of this file

// git reads no global or system settings in this process and its children.
const gitDir = tmpDir('doctor-gitconfig');
fs.writeFileSync(path.join(gitDir, 'gitconfig'), '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: path.join(gitDir, 'gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org',
});

const HAS_GIT = (() => {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();
const NO_GIT = !HAS_GIT && 'git is not installed';
const POSIX = process.platform !== 'win32';

async function fts5Loads() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_FTS5 = await fts5Loads();

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

const gitConfigValue = (cwd, key) => spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8', windowsHide: true }).stdout.trim();

const schema = loadSchema(KIT_ROOT, 'doctor-result');

function assertValid(report, what = 'doctor report') {
  const res = validate(schema, report);
  assert.ok(res.ok, `${what} does not match doctor-result.schema.json:\n${res.errors.map((e) => `${e.path} ${e.message}`).join('\n')}`);
  assert.deepEqual(report.checks.map((c) => c.id), CHECK_IDS, 'every check, in order');
  const count = (s) => report.checks.filter((c) => c.status === s).length;
  assert.deepEqual(report.summary, { ok: count('ok'), warn: count('warn'), fail: count('fail') });
}

/** An empty home with the variables that would point clients elsewhere cleared. */
function homeEnv(home) {
  return {
    HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: '', FLATPAK_XDG_CONFIG_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', GEMINI_CLI_HOME: '',
    COPILOT_HOME: '', CLINE_DIR: '', CLINE_DATA_DIR: '', CLINE_MCP_SETTINGS_PATH: '',
  };
}

const emptyHome = tmpDir('doctor-home');

/** doctor in-process, the way the CLI calls it (cfg null and configError on a broken config). */
async function doctorOf(root, opts = {}) {
  let cfg = null;
  let configError = null;
  try {
    cfg = loadConfig(root);
  } catch (err) {
    configError = err;
  }
  // No real `claude --version` and a Git Bash that exists: neither the Claude Code nor the
  // shell setup of the machine that runs the tests (a Windows runner too) decides anything.
  const { io, ...rest } = opts;
  const res = await diagnose(root, {
    kitRoot: root, cfg, configError, env: {}, home: emptyHome, clients: { findCli: () => null }, ...rest,
    io: { claudeVersion: () => null, gitBash: () => true, ...io },
  });
  assertValid(res.report);
  const byId = Object.fromEntries(res.report.checks.map((c) => [c.id, c]));
  return { ...res, byId };
}

/** An argument as doctor quotes it in the commands it prints. */
const shellArg = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);

/** Runs `node <kit>/system/memory.mjs <args> --root <root>`: another kit's CLI on this vault. */
function runKit(kit, root, args) {
  const env = { ...process.env, ...homeEnv(emptyHome) };
  for (const key of ['MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CODE_REMOTE', 'CODESPACES', 'GITPOD_WORKSPACE_ID']) delete env[key];
  const res = spawnSync(process.execPath, [path.join(kit, 'system', 'memory.mjs'), ...args, '--root', root], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function jsonOf(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}

/** Only the checks that are not ok, as 'id status' lines (fts5 may be missing on older Node). */
function problems(report) {
  return report.checks.filter((c) => c.status !== 'ok' && !(c.id === 'node.fts5' && !HAS_FTS5)).map((c) => `${c.id} ${c.status}: ${c.message}`);
}

// ---------------------------------------------------------------------------------------------
// A healthy vault: the kit copied, git, init (combined, one local sector), the fixture notes,
// fresh views, a remote, the node for git apps pinned, all committed. Tests work on copies.

let healthy = null;

before(() => {
  if (!HAS_GIT) return;
  const base = tmpDir('doctor-healthy');
  const root = copyKit(path.join(base, 'vault'));
  git(root, ['init', '-q', '-b', 'main']);
  const init = runInit(root, [
    '--mode', 'combined', '--lang', 'en', '--sectors', 'core,work,school,health:local',
    '--private-root', '../private', '--cleanup', 'none', '--today', TODAY, '--yes',
  ]);
  assert.equal(init.code, 0, `init:\n${init.stdout}\n${init.stderr}`);
  overlay(path.join(FIXTURES_DIR, 'en', 'vault'), root);
  overlay(path.join(FIXTURES_DIR, 'en', 'private'), path.join(base, 'private'));
  const gen = runCli(root, ['check', '--generate']);
  assert.equal(gen.code, 0, `check --generate:\n${gen.stdout}\n${gen.stderr}`);
  // The kit files of this working tree are the release this vault runs.
  writeJson(root, 'system/kit.json', buildManifest(root));
  git(root, ['remote', 'add', 'origin', 'https://example.org/owner/memory.git']);
  git(root, ['config', 'memorykit.node', process.execPath]);
  git(root, ['add', '-A']);
  git(root, ['update-index', '--chmod=+x', '.githooks/pre-commit']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'memory']);
  healthy = base;
});

/** A copy of the healthy vault (with its .git and its private root): { root, priv }. */
function clone(label = 'copy') {
  const dest = path.join(tmpDir(`doctor-${label}`), 'copy');
  cloneDir(healthy, dest);
  return { root: path.join(dest, 'vault'), priv: path.join(dest, 'private') };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

describe('helpers', () => {
  test('cmpVersion compares x.y.z numerically', () => {
    assert.equal(cmpVersion('22.5.0', '22.13.1'), -1);
    assert.equal(cmpVersion('v22.13.1', '22.5.0'), 1);
    assert.equal(cmpVersion('22.5.0', '22.5.0'), 0);
    assert.equal(cmpVersion('22.5.0-rc.1', '22.5.0'), 0);
    assert.equal(cmpVersion('nope', '22.5.0'), null);
  });

  test('hasEolRule finds the LF rule and nothing else', () => {
    assert.ok(hasEolRule('# comment\n* text=auto eol=lf\n'));
    assert.ok(hasEolRule('\uFEFF*   text   eol=lf\r\n'));
    assert.ok(!hasEolRule('* text=auto\n'));
    assert.ok(!hasEolRule('*.md text eol=lf\n'));
    assert.ok(!hasEolRule('# * text=auto eol=lf\n'));
  });

  test('sessionStartHooks tells the exec form, the braced and the bare shell form apart', () => {
    const group = (matcher, hook) => ({ hooks: { SessionStart: [{ matcher, hooks: [hook] }] } });
    const exec = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/system/memory.mjs', 'start'] };
    assert.deepEqual(sessionStartHooks(group('startup|resume|clear|compact', exec)), [{ matcher: 'startup|resume|clear|compact', exec: true, bare: false }]);
    const braced = { type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start' };
    assert.deepEqual(sessionStartHooks(group('', braced)), [{ matcher: '', exec: false, bare: false }]);
    const bare = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/system/memory.mjs" start' };
    assert.deepEqual(sessionStartHooks(group('startup', bare)), [{ matcher: 'startup', exec: false, bare: true }]);
    assert.deepEqual(sessionStartHooks(group('', { type: 'command', command: 'echo hi' })), []);
    assert.deepEqual(sessionStartHooks({}), []);
    assert.deepEqual(sessionStartHooks(null), []);
  });

  test('hookBytes drops a leading BOM and the CR bytes and keeps every other byte', () => {
    const b = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p, 'latin1')));
    // Windows-1250 bytes (0xF8 is ř) are not UTF-8; decoding them would turn them into U+FFFD.
    assert.ok(hookBytes(b('\xef\xbb\xbf#!/bin/sh\r\necho p\xf8ed\r\n')).equals(b('#!/bin/sh\necho p\xf8ed\n')));
    assert.ok(hookBytes(b('a\rb\r\r\nc\r')).equals(b('a\nb\n\nc\n')), 'a lone CR ends a line too');
    assert.ok(hookBytes(b('#!/bin/sh\n\xef\xbb\xbf\n')).equals(b('#!/bin/sh\n\xef\xbb\xbf\n')), 'only a leading BOM');
    const lf = b('#!/bin/sh\n# vlastn\xed\n');
    assert.ok(hookBytes(lf).equals(lf));
    assert.equal(hookBytes(Buffer.alloc(0)).length, 0);
  });

  test('uncoveredSources lists the session sources no matcher covers', () => {
    assert.deepEqual(uncoveredSources([{ matcher: 'startup|resume|compact' }]), ['clear']);
    assert.deepEqual(uncoveredSources([{ matcher: 'startup' }, { matcher: 'resume|clear|compact' }]), []);
    assert.deepEqual(uncoveredSources([{ matcher: '' }]), []);
    assert.deepEqual(uncoveredSources([{ matcher: '*' }]), []);
  });

  test('cloudService recognizes the folders of sync services', () => {
    assert.equal(cloudService('C:\\Users\\me\\OneDrive - Contoso\\memory', { platform: 'win32', env: {} }), 'OneDrive');
    assert.equal(cloudService('D:\\Sync\\memory', { platform: 'win32', env: { OneDrive: 'D:\\Sync' } }), 'OneDrive');
    assert.equal(cloudService('/Users/me/Library/CloudStorage/Dropbox/memory', { platform: 'darwin', env: {} }), 'Dropbox');
    assert.equal(cloudService('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/memory', { platform: 'darwin', env: {} }), 'iCloud Drive');
    assert.equal(cloudService('/Users/me/Library/CloudStorage/GoogleDrive-me@example.org/My Drive/memory', { platform: 'darwin', env: {} }), 'Google Drive');
    assert.equal(cloudService('/home/me/memory', { platform: 'linux', env: {} }), null);
    assert.equal(cloudService('/home/me/dropbox-notes/memory', { platform: 'linux', env: {} }), null);
  });

  test('formatReport prints one line per check, the fix under problems and a summary', () => {
    const report = {
      kit: '0.1.1',
      root: '/v',
      checks: [
        { id: 'node.version', status: 'ok', message: 'fine', fix: null },
        { id: 'git.repo', status: 'warn', message: 'no remote', fix: 'git remote add origin <url>' },
        { id: 'roots', status: 'fail', message: 'inside', fix: 'move it' },
        { id: 'generated.fresh', status: 'ok', message: 'not checked: no config', fix: null },
      ],
      summary: { ok: 2, warn: 1, fail: 1 },
    };
    assert.equal(formatReport(report, { skipped: ['generated.fresh'] }), [
      'memory-kit doctor · kit 0.1.1 · /v',
      '✓ node.version     fine',
      '! git.repo         no remote',
      '                   fix: git remote add origin <url>',
      '✗ roots            inside',
      '                   fix: move it',
      '· generated.fresh  not checked: no config',
      '2 ok · 1 warn · 1 fail',
      '',
    ].join('\n'));
  });

  test('messages: a pack translation wins, the English default fills the gaps', () => {
    const t = (key) => (key === 'doctor.lock.ok' ? 'žádná nedokončená aktualizace' : key);
    assert.equal(say(t, 'doctor.lock.ok'), 'žádná nedokončená aktualizace');
    assert.equal(say(t, 'doctor.fix', { fix: 'x' }), 'fix: x');
    assert.equal(say(null, 'doctor.node.ok', { have: '22.1.0', need: '22.5.0' }), 'Node.js 22.1.0 (the kit needs 22.5.0 or newer)');
  });

  test('every message key the code uses has an English default, and every default is used', () => {
    const sources = [
      fs.readFileSync(path.join(KIT_ROOT, 'system', 'lib', 'doctor.mjs'), 'utf8'),
      fs.readFileSync(path.join(KIT_ROOT, 'system', 'lib', 'commands', 'doctor.mjs'), 'utf8'),
    ].join('\n');
    const code = sources.replace(/^\s*'doctor\.[^']+':.*$/gm, ''); // without the DEFAULTS table itself
    const used = new Set(code.match(/'doctor\.[a-z0-9_.]+'/g).map((s) => s.slice(1, -1)));
    for (const name of ['hooks_path', 'hook_file']) used.add(`doctor.fixed.${name}`); // built as `doctor.fixed.${name}`
    for (const state of ['markers', 'duplicate', 'broken']) assert.ok(used.has(`doctor.agents.${state}`));
    for (const key of used) assert.ok(Object.hasOwn(DEFAULTS, key), `no English default for ${key}`);
    for (const key of Object.keys(DEFAULTS)) assert.ok(used.has(key), `unused message ${key}`);
    for (const [key, text] of Object.entries(DEFAULTS)) assert.ok(text.trim() && !text.includes('\n'), key);
  });
});

// ---------------------------------------------------------------------------------------------
// Whole vaults

describe('doctor on a healthy vault', { skip: NO_GIT }, () => {
  test('every check passes, the JSON matches the schema and the exit code is 0', () => {
    const v = clone('healthy');
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    const report = jsonOf(res);
    assertValid(report, 'doctor --json');
    assert.deepEqual(problems(report), []);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(report.kit, readFile(v.root, 'system/VERSION').trim());
    assert.equal(fs.realpathSync.native(report.root), fs.realpathSync.native(v.root));
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.match(byId['git.repo'].message, /branch main · remote origin/);
    // The pinned node is probed on macOS and Linux; Git for Windows uses the Windows PATH.
    const nodeLabel = POSIX ? process.execPath : 'the node on the PATH';
    assert.equal(byId['git.pre_commit'].message, `.githooks/pre-commit runs check --pre-commit with ${nodeLabel}`);
    assert.match(byId.roots.message, /private/);
    assert.ok(report.checks.every((c) => c.fix === null || c.status !== 'ok'));
  });

  test('the human output is one line per check plus the title and the summary', () => {
    const v = clone('human');
    const res = runCli(v.root, ['doctor'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^memory-kit doctor · kit \d+\.\d+\.\d+ · /);
    const rows = lines.slice(1, -1).filter((l) => !/^\s+fix: /.test(l));
    assert.equal(rows.length, CHECK_IDS.length);
    rows.forEach((row, i) => assert.ok(row.startsWith(`✓ ${CHECK_IDS[i]} `) || (!HAS_FTS5 && row.startsWith('! node.fts5')), row));
    assert.match(lines.at(-1), /^\d+ ok · \d+ warn · 0 fail$/);
    assert.equal(res.stderr, '');
  });

  test('doctor writes nothing', async () => {
    const v = clone('readonly');
    const snap = (dir) => {
      const out = {};
      const walk = (rel) => {
        for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
          const r = path.join(rel, e.name);
          if (e.isDirectory()) walk(r);
          else out[r] = fs.readFileSync(path.join(dir, r)).toString('base64');
        }
      };
      walk('');
      return out;
    };
    const before = snap(path.dirname(v.root));
    await doctorOf(v.root);
    const cli = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(snap(path.dirname(v.root)), before);
  });
});

describe('config', { skip: NO_GIT }, () => {
  test('a broken memory.json fails config.memory_json; the other checks still run', () => {
    const v = clone('broken');
    writeFile(v.root, 'memory.json', '{ "version": 1, ');
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 1, res.stderr);
    const report = jsonOf(res);
    assertValid(report);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['config.memory_json'].status, 'fail');
    assert.match(byId['config.memory_json'].message, /^memory\.json is not valid JSON: /);
    assert.equal(byId['config.memory_json'].fix, 'git diff memory.json shows what changed since the last commit');
    for (const id of ['config.data_version', 'roots', 'generated.fresh']) {
      assert.equal(byId[id].status, 'ok', id);
      assert.match(byId[id].message, /^not checked: memory\.json cannot be loaded/, id);
    }
    // Everything that does not need the config is still checked.
    assert.equal(byId['git.hooks_path'].message, 'core.hooksPath is .githooks');
    assert.equal(byId['kit.integrity'].status, 'ok');
    assert.deepEqual(problems(report), [`config.memory_json fail: ${byId['config.memory_json'].message}`]);

    const human = runCli(v.root, ['doctor'], { env: homeEnv(emptyHome) });
    assert.equal(human.code, 1);
    assert.match(human.stdout, /^✗ config\.memory_json +memory\.json is not valid JSON/m);
    assert.match(human.stdout, /^ +fix: git diff memory\.json/m);
    assert.match(human.stdout, /^· generated\.fresh +not checked/m);
    assert.match(human.stdout, /^\d+ ok · 0 warn · 1 fail$/m);
  });

  test('a missing memory.json and one that is not an object', async () => {
    const v = clone('nocfg');
    fs.rmSync(path.join(v.root, 'memory.json'));
    let d = await doctorOf(v.root);
    assert.equal(d.byId['config.memory_json'].status, 'fail');
    assert.equal(d.byId['config.memory_json'].message, 'memory.json is missing');
    assert.match(d.byId['config.memory_json'].fix, /git checkout -- memory\.json/);
    writeFile(v.root, 'memory.json', '[1, 2]\n');
    d = await doctorOf(v.root);
    assert.equal(d.byId['config.memory_json'].message, 'memory.json must hold a JSON object');
  });

  test('schema problems are warnings while the kit still loads the file', async () => {
    const v = clone('schema');
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    cfg.budgets = { no_such_budget: 3 };
    cfg.search = { n: 50 };
    writeJson(v.root, 'memory.json', cfg);
    const d = await doctorOf(v.root);
    const ch = d.byId['config.memory_json'];
    assert.equal(ch.status, 'warn');
    assert.match(ch.message, /^memory\.json does not match its schema: /);
    assert.match(ch.message, /budgets\.no_such_budget|search\.n/);
    assert.equal(d.report.summary.fail, 0);
  });

  test('a memory that is not set up yet is a warning with the setup step', async () => {
    const v = clone('uninit');
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    cfg.initialized = false;
    writeJson(v.root, 'memory.json', cfg);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['config.memory_json'].status, 'warn');
    assert.equal(d.byId['config.memory_json'].message, 'the memory is not set up yet');
    assert.match(d.byId['config.memory_json'].fix, /node system\/init\.mjs/);
  });

  test('a newer data version fails with the upgrade step; an invalid one fails too', () => {
    const v = clone('newer');
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...cfg, version: 2 });
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 1);
    const report = jsonOf(res);
    assertValid(report);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['config.data_version'].status, 'fail');
    assert.equal(byId['config.data_version'].message, 'memory.json has data version 2, newer than this kit reads (1)');
    assert.equal(byId['config.data_version'].fix, 'update the kit: node system/memory.mjs upgrade');
    assert.equal(byId['config.memory_json'].status, 'fail');
    assert.match(byId['config.memory_json'].message, /data version 1/);

    writeJson(v.root, 'memory.json', { ...cfg, version: 'one' });
    const again = jsonOf(runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) }));
    const data = again.checks.find((c) => c.id === 'config.data_version');
    assert.equal(data.status, 'fail');
    assert.equal(data.message, 'memory.json "version" is not a whole number of 1 or more: "one"');
  });

  test('messages come from the language pack also when the config cannot be loaded', () => {
    const v = clone('pack');
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...cfg, lang: 'cs', version: 9 });
    const pack = JSON.parse(readFile(v.root, 'system/lang/cs/pack.json'));
    pack.messages = { ...pack.messages, 'doctor.summary': 'v pořádku {ok} · upozornění {warn} · chyby {fail}' };
    delete pack.messages['doctor.data.newer'];
    writeJson(v.root, 'system/lang/cs/pack.json', pack);
    const res = runCli(v.root, ['doctor'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 1);
    assert.match(res.stdout.trimEnd().split('\n').at(-1), /^v pořádku \d+ · upozornění \d+ · chyby [1-9]\d*$/);
    // Keys the pack does not have fall back to English.
    assert.match(res.stdout, /memory\.json has data version 9, newer than this kit reads \(1\)/);
  });
});

describe('kit files', { skip: NO_GIT }, () => {
  test('a modified kit file is a warning that names it; config and docs changes are kept', async () => {
    const v = clone('modified');
    fs.appendFileSync(path.join(v.root, 'system', 'lib', 'text.mjs'), '// a local change\n');
    fs.appendFileSync(path.join(v.root, 'docs', 'maintenance.md'), '\nA local note.\n');
    const d = await doctorOf(v.root);
    const ch = d.byId['kit.integrity'];
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'kit files changed here: system/lib/text.mjs; an upgrade stops at them unless --force');
    assert.equal(ch.fix, 'git diff -- system/lib/text.mjs shows the changes; git checkout -- <file> undoes one');
    assert.equal(d.report.summary.fail, 0);

    fs.writeFileSync(path.join(v.root, 'system', 'lib', 'text.mjs'), readFile(healthyRoot(), 'system/lib/text.mjs'));
    const kept = await doctorOf(v.root);
    assert.equal(kept.byId['kit.integrity'].status, 'ok');
    assert.match(kept.byId['kit.integrity'].message, /^\d+ kit files match memory-kit \d+\.\d+\.\d+; 1 config or docs files are changed here; an upgrade keeps them$/);
  });

  test('a missing code file fails with the restore command; an extra one is a warning', async () => {
    const v = clone('missing');
    fs.rmSync(path.join(v.root, 'system', 'tools', 'release.mjs'));
    writeFile(v.root, 'system/lib/extra.mjs', 'export const x = 1;\n');
    const d = await doctorOf(v.root);
    const ch = d.byId['kit.integrity'];
    assert.equal(ch.status, 'fail');
    assert.equal(ch.message, 'kit files missing: system/tools/release.mjs; files in system/ that this kit does not ship: system/lib/extra.mjs');
    assert.equal(ch.fix, 'git checkout -- system/tools/release.mjs; delete them unless you added them yourself');
  });

  test('VERSION and kit.json that disagree fail kit.version; without kit.json integrity is not checked', async () => {
    const v = clone('version');
    const manifest = JSON.parse(readFile(v.root, 'system/kit.json'));
    writeJson(v.root, 'system/kit.json', { ...manifest, version: '9.9.9' });
    let d = await doctorOf(v.root);
    assert.equal(d.byId['kit.version'].status, 'fail');
    assert.match(d.byId['kit.version'].message, /system\/VERSION says \d+\.\d+\.\d+, but system\/kit\.json says 9\.9\.9/);
    assert.match(d.byId['kit.version'].fix, /upgrade --rollback/);

    fs.rmSync(path.join(v.root, 'system', 'kit.json'));
    d = await doctorOf(v.root);
    assert.equal(d.byId['kit.version'].status, 'warn');
    assert.equal(d.byId['kit.version'].fix, 'git checkout -- system/kit.json');
    assert.equal(d.byId['kit.integrity'].message, 'not checked: system/kit.json is missing (see kit.version)');
    assert.ok(d.skipped.includes('kit.integrity'));

    fs.rmSync(path.join(v.root, 'system', 'VERSION'));
    d = await doctorOf(v.root);
    assert.equal(d.report.kit, null);
    assert.equal(d.byId['kit.version'].status, 'fail');
    assert.equal(d.byId['kit.version'].message, 'system/VERSION is missing or holds no version');
  });

  test('without kit.json: git checkout only when the last commit has it; an older kit gets the upgrade of the kit that runs doctor', async () => {
    const v = clone('nomanifest');
    const version = readFile(v.root, 'system/VERSION').trim();
    git(v.root, ['rm', '-q', 'system/kit.json']);
    git(v.root, ['commit', '-q', '--no-verify', '-m', 'without kit.json']);
    let d = await doctorOf(v.root);
    assert.equal(d.byId['kit.version'].status, 'warn');
    assert.equal(d.byId['kit.version'].message, 'system/kit.json is missing, so the kit files cannot be verified');
    assert.equal(d.byId['kit.version'].fix, `copy system/kit.json of memory-kit ${version} from the kit (https://github.com/8Krystof8/memory-kit.git)`);

    // Like a 0.1.0 vault: kit.json never committed and no doctor of its own; the new kit's doctor runs on it.
    writeFile(v.root, 'system/VERSION', '0.1.0\n');
    fs.rmSync(path.join(v.root, 'system', 'lib', 'commands', 'doctor.mjs'));
    fs.rmSync(path.join(v.root, 'system', 'lib', 'commands', 'connect.mjs'));
    git(v.root, ['config', '--unset', 'core.hooksPath']);
    if (POSIX) fs.chmodSync(path.join(v.root, '.githooks', 'pre-commit'), 0o644);
    const kit = healthyRoot();
    const cli = `node ${shellArg(path.join(kit, 'system', 'memory.mjs'))}`;
    const vault = shellArg(v.root);
    const res = runKit(kit, v.root, ['doctor', '--json']);
    const byId = Object.fromEntries(jsonOf(res).checks.map((c) => [c.id, c]));
    assert.equal(byId['kit.version'].fix, `update the kit from 0.1.0 to ${version}, which writes system/kit.json: ${cli} upgrade --root ${vault}`);
    assert.equal(byId['git.hooks_path'].fix, `${cli} doctor --fix --root ${vault} (or: git config core.hooksPath .githooks)`);
    if (POSIX) assert.equal(byId['git.pre_commit'].fix, `the kit of this memory has no doctor, so use this one: ${cli} doctor --fix --root ${vault}`);
    assert.doesNotMatch(byId['mcp.clients'].message, /system\/memory\.mjs connect/, 'a kit without connect is not told to run it');
    // The command it names does what it says.
    const fixed = runKit(kit, v.root, ['doctor', '--fix']);
    assert.match(fixed.stdout, /^fixed: git config core\.hooksPath \.githooks$/m);
    assert.equal(gitConfigValue(v.root, 'core.hooksPath'), '.githooks');
    if (POSIX) assert.equal(fs.statSync(path.join(v.root, '.githooks', 'pre-commit')).mode & 0o777, 0o755);

    // The last commit has kit.json: git checkout, unless the kit is older than the one running doctor.
    const w = clone('oldmanifest');
    fs.rmSync(path.join(w.root, 'system', 'kit.json'));
    assert.equal((await doctorOf(w.root)).byId['kit.version'].fix, 'git checkout -- system/kit.json');
    writeFile(w.root, 'system/VERSION', '0.1.0\n');
    d = await doctorOf(w.root, { kitRoot: kit });
    assert.equal(d.byId['kit.version'].fix, `update the kit from 0.1.0 to ${version}, which writes system/kit.json: ${cli} upgrade --root ${shellArg(w.root)}`);
  });

  test('a damaged kit module fails only its own check', () => {
    const v = clone('damaged');
    writeFile(v.root, 'system/lib/clients.mjs', 'throw new Error("damaged on purpose");\n');
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 1, res.stderr);
    const report = jsonOf(res);
    assertValid(report);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId['mcp.clients'].status, 'fail');
    assert.equal(byId['mcp.clients'].message, 'system/lib/clients.mjs cannot be loaded (damaged on purpose)');
    assert.equal(byId['mcp.clients'].fix, 'restore it with git checkout -- system/lib/clients.mjs');
    assert.equal(byId['kit.integrity'].status, 'warn');
    assert.equal(byId['git.pre_commit'].status, 'ok', 'the other checks still run');
  });
});

describe('upgrade lock', { skip: NO_GIT }, () => {
  test('a lock whose backup is gone needs --rollback --force; with its backup, --rollback', async () => {
    const v = clone('lock');
    const lock = { backup: '20260924-100000-0.1.1-to-0.1.2', from: '0.1.1', to: '0.1.2', started: '2026-09-24T10:00:00.000Z', pid: 1 };
    writeJson(v.root, '.memory-kit/upgrade.lock', lock);
    let d = await doctorOf(v.root);
    const ch = d.byId['kit.upgrade_lock'];
    assert.equal(ch.status, 'fail');
    assert.equal(ch.message, 'the upgrade 0.1.1 → 0.1.2 (started 2026-09-24T10:00:00.000Z) did not finish; upgrade refuses to run until it is undone');
    assert.equal(ch.fix, `node system/memory.mjs upgrade --rollback --force (its backup ${lock.backup} is gone, so this only removes the lock)`);

    // A folder without backup.json is no backup upgrade --rollback could restore.
    fs.mkdirSync(path.join(v.root, '.memory-kit', 'backups', lock.backup), { recursive: true });
    d = await doctorOf(v.root);
    assert.match(d.byId['kit.upgrade_lock'].fix, /--rollback --force/);
    writeJson(v.root, `.memory-kit/backups/${lock.backup}/backup.json`, { id: lock.backup, from: '0.1.1', to: '0.1.2', created: lock.started, files: [] });
    d = await doctorOf(v.root);
    assert.equal(d.byId['kit.upgrade_lock'].fix, 'node system/memory.mjs upgrade --rollback');

    writeFile(v.root, '.memory-kit/upgrade.lock', 'not json');
    d = await doctorOf(v.root);
    assert.equal(d.byId['kit.upgrade_lock'].status, 'fail');
    assert.equal(d.byId['kit.upgrade_lock'].message, '.memory-kit/upgrade.lock was left by an interrupted upgrade and cannot be read');
    assert.equal(d.byId['kit.upgrade_lock'].fix, 'node system/memory.mjs upgrade --rollback --force (this only removes the lock)');

    // The fix does what it says: the CLI of the vault clears the lock.
    const cleared = runCli(v.root, ['upgrade', '--rollback', '--force']);
    assert.equal(cleared.code, 0, `${cleared.stdout}\n${cleared.stderr}`);
    assert.equal((await doctorOf(v.root)).byId['kit.upgrade_lock'].status, 'ok');
  });

  test('an upgrade at work is a warning without a fix; an interrupted one is undone with its backup\'s tool', async () => {
    const v = clone('lockrun');
    const id = '20260924-100000-0.1.1-to-0.1.2';
    const tool = `.memory-kit/backups/${id}/tool/rollback.mjs`;
    writeJson(v.root, `.memory-kit/backups/${id}/backup.json`, { id, from: '0.1.1', to: '0.1.2', created: '2026-09-24T10:00:00.000Z', files: [] });
    writeFile(v.root, tool, '// the recovery tool of this backup\n');
    // A process whose command line names memory.mjs, like an upgrade does.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'memory.mjs', 'upgrade'], { stdio: 'ignore', windowsHide: true });
    try {
      writeJson(v.root, '.memory-kit/upgrade.lock', {
        backup: id, from: '0.1.1', to: '0.1.2', started: new Date().toISOString(), pid: sleeper.pid, host: os.hostname(), recover: tool,
      });
      const ch = (await doctorOf(v.root)).byId['kit.upgrade_lock'];
      assert.equal(ch.status, 'warn');
      assert.equal(ch.message, `an upgrade 0.1.1 → 0.1.2 is running right now (process ${sleeper.pid}); wait for it to finish, then run doctor again`);
      assert.equal(ch.fix, null);
    } finally {
      sleeper.kill();
    }
    await new Promise((resolve) => sleeper.once('exit', resolve));
    let ch = (await doctorOf(v.root)).byId['kit.upgrade_lock'];
    assert.equal(ch.status, 'fail');
    assert.match(ch.message, /^the upgrade 0\.1\.1 → 0\.1\.2 \(started .+\) did not finish/);
    assert.equal(ch.fix, `node ${tool} (the upgrader kept with its backup, which works while the kit files are half replaced)`);
    // A vault without a doctor of its own (0.1.0) is examined by another kit: the tool by its full path.
    fs.rmSync(path.join(v.root, 'system', 'lib', 'commands', 'doctor.mjs'));
    ch = (await doctorOf(v.root, { kitRoot: KIT_ROOT })).byId['kit.upgrade_lock'];
    assert.equal(ch.fix, `node ${shellArg(path.join(v.root, ...tool.split('/')))} (the upgrader kept with its backup, which works while the kit files are half replaced)`);
    // A backup of a build without the tool: --rollback of the vault's CLI.
    fs.rmSync(path.join(v.root, ...tool.split('/')));
    assert.equal((await doctorOf(v.root)).byId['kit.upgrade_lock'].fix, 'node system/memory.mjs upgrade --rollback');
  });
});

describe('AGENTS.md and the agent files', { skip: NO_GIT }, () => {
  const kitSection = (text) => text.slice(text.indexOf('<!-- kit:start'), text.indexOf('<!-- kit:end -->') + '<!-- kit:end -->'.length);

  test('missing markers fail; an older marker and an edited section are warnings', async () => {
    const v = clone('agents');
    const text = readFile(v.root, 'AGENTS.md');
    writeFile(v.root, 'AGENTS.md', text.replace('<!-- kit:end -->', ''));
    let d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].status, 'fail');
    assert.match(d.byId['agents.block'].message, /^AGENTS\.md has no kit section/);
    assert.equal(d.byId['agents.block'].fix, 'put the content of system/templates/en/kit/agents-system.md back into AGENTS.md once, above your own rules');

    writeFile(v.root, 'AGENTS.md', `${text}\n${kitSection(text)}\n`);
    d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].message, 'AGENTS.md has a kit marker more than once');

    writeFile(v.root, 'AGENTS.md', text.replace(/<!-- kit:start v[^ ]+/, '<!-- kit:start v0.0.9'));
    d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].status, 'warn');
    assert.match(d.byId['agents.block'].message, /^the kit section of AGENTS\.md is from v0\.0\.9, but the kit is \d+\.\d+\.\d+$/);

    writeFile(v.root, 'AGENTS.md', text.replace('## Five laws', '## Five laws\n- my own rule'));
    d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].status, 'warn');
    assert.equal(d.byId['agents.block'].message, 'the kit section of AGENTS.md was edited; an upgrade replaces it with system/templates/en/kit/agents-system.md');

    // CRLF line endings are no edit, and neither is the setup block of a kit not yet set up.
    writeFile(v.root, 'AGENTS.md', text.replace(/\n/g, '\r\n'));
    assert.equal((await doctorOf(v.root)).byId['agents.block'].status, 'ok');
    writeFile(v.root, 'AGENTS.md', readFile(KIT_ROOT, 'AGENTS.md'));
    assert.equal((await doctorOf(v.root)).byId['agents.block'].status, 'ok');

    fs.rmSync(path.join(v.root, 'AGENTS.md'));
    d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].message, 'AGENTS.md is missing');
    assert.equal(d.byId['agents.block'].fix, 'git checkout -- AGENTS.md');
  });

  test('adapters: the exec form needs Claude Code 2.1.139, the braced form under PowerShell 2.1.198', async () => {
    const v = clone('hookform');
    const group = (hook) => ({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [hook] }] } });
    const exec = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/system/memory.mjs', 'start'] };
    const asked = [];
    const claude = (version) => () => {
      asked.push(version);
      return version;
    };
    const adapters = async (opts) => (await doctorOf(v.root, opts)).byId.adapters;
    const fine = /the Claude Code SessionStart hook runs start/;
    const braced = 'use the braced form: "command": "node \\"${CLAUDE_PROJECT_DIR}/system/memory.mjs\\" start"';
    const update = 'update Claude Code (claude update), or install Git for Windows (git-scm.com), whose Git Bash runs the hook';

    // The shipped hook (braced shell form) works under sh and bash: claude is never asked.
    assert.match((await adapters({ io: { claudeVersion: () => assert.fail('claude asked') } })).message, fine);

    writeJson(v.root, '.claude/settings.json', group(exec));
    let ch = await adapters({ io: { claudeVersion: claude('2.1.138') } });
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'the SessionStart hook uses "args" (exec form), which Claude Code 2.1.138 ignores (it needs 2.1.139 or newer), so its sessions start without the memory');
    assert.equal(ch.fix, braced);
    assert.match((await adapters({ io: { claudeVersion: claude('2.1.139') } })).message, fine);
    assert.match((await adapters({ io: { claudeVersion: claude(null) } })).message, fine, 'no claude found: nothing to say');
    ch = await adapters({ platform: 'win32', io: { claudeVersion: claude('2.1.100'), gitBash: () => false } });
    assert.equal(ch.fix, update, 'PowerShell before 2.1.198 runs no form of the hook');

    // The braced shell form in PowerShell (Windows without Git Bash).
    writeFile(v.root, '.claude/settings.json', readFile(KIT_ROOT, '.claude/settings.json'));
    ch = await adapters({ platform: 'win32', io: { claudeVersion: claude('2.1.197'), gitBash: () => false } });
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'Claude Code 2.1.197 runs hooks in PowerShell here (no Git Bash), which fills in ${CLAUDE_PROJECT_DIR} only from 2.1.198 on, so its sessions start without the memory');
    assert.equal(ch.fix, update);
    assert.match((await adapters({ platform: 'win32', io: { claudeVersion: claude('2.1.198'), gitBash: () => false } })).message, fine);
    asked.length = 0;
    assert.match((await adapters({ platform: 'win32', io: { claudeVersion: claude('2.1.100'), gitBash: () => true } })).message, fine);
    assert.deepEqual(asked, [], 'Git Bash runs the braced form on every version');
  });

  test('IO.gitBash finds Git Bash the way Claude Code does on Windows', () => {
    const dir = tmpDir('doctor-gitbash');
    const bash = writeFile(dir, 'Git/bin/bash.exe', '');
    writeFile(dir, 'Git/cmd/git.exe', '');
    writeFile(dir, 'Other/git.exe', '');
    assert.equal(IO.gitBash({ PATH: path.join(dir, 'Git', 'cmd') }), true);
    assert.equal(IO.gitBash({ PATH: [path.join(dir, 'none'), path.join(dir, 'Other')].join(path.delimiter) }), false);
    assert.equal(IO.gitBash({ CLAUDE_CODE_GIT_BASH_PATH: bash }), true);
    assert.equal(IO.gitBash({ CLAUDE_CODE_GIT_BASH_PATH: path.join(dir, 'nope.exe') }), false);
    assert.equal(IO.gitBash({ ProgramFiles: dir }), true);
    assert.equal(IO.gitBash({ LOCALAPPDATA: path.join(dir, 'none') }), false);
    assert.equal(IO.gitBash({}), false);
  });

  test('adapters: the import line, the missing file, the hook form and its matcher', async () => {
    const v = clone('adapters');
    writeFile(v.root, 'CLAUDE.md', '# Claude\n@AGENTS.md\n');
    fs.rmSync(path.join(v.root, 'GEMINI.md'));
    let d = await doctorOf(v.root);
    let ch = d.byId.adapters;
    assert.equal(ch.status, 'fail');
    assert.equal(ch.message, 'CLAUDE.md must start with the line @AGENTS.md; GEMINI.md is missing, so Gemini CLI does not read AGENTS.md');
    assert.equal(ch.fix, 'make @AGENTS.md the first line of CLAUDE.md; create GEMINI.md with the single line @AGENTS.md');

    writeFile(v.root, 'CLAUDE.md', readFile(healthyRoot(), 'CLAUDE.md'));
    writeFile(v.root, 'GEMINI.md', '@AGENTS.md\n');
    const settings = {
      hooks: { SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/system/memory.mjs" start' }] }] },
    };
    writeJson(v.root, '.claude/settings.json', settings);
    // A bare $CLAUDE_PROJECT_DIR needs a POSIX shell: fine on Linux and macOS, and on Windows
    // with Git Bash; only PowerShell (Windows without Git Bash) leaves it empty.
    d = await doctorOf(v.root);
    ch = d.byId.adapters;
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'the SessionStart hook skips clear, so those sessions start without the memory');
    assert.equal(ch.fix, 'set its "matcher" to "startup|resume|clear|compact"');
    const noClaude = { claudeVersion: () => null };
    d = await doctorOf(v.root, { platform: 'win32', io: { ...noClaude, gitBash: () => true } });
    assert.equal(d.byId.adapters.message, 'the SessionStart hook skips clear, so those sessions start without the memory');
    d = await doctorOf(v.root, { platform: 'win32', io: { ...noClaude, gitBash: () => false } });
    ch = d.byId.adapters;
    assert.match(ch.message, /without braces, which breaks when Claude Code runs hooks in PowerShell/);
    assert.match(ch.message, /the SessionStart hook skips clear, so those sessions start without the memory/);
    assert.match(ch.fix, /use the braced form: "command": "node \\"\$\{CLAUDE_PROJECT_DIR\}\/system\/memory\.mjs\\" start"/);
    assert.match(ch.fix, /"startup\|resume\|clear\|compact"/);

    writeJson(v.root, '.claude/settings.json', { hooks: {} });
    assert.equal((await doctorOf(v.root)).byId.adapters.message, '.claude/settings.json has no SessionStart hook that runs system/memory.mjs start');
    writeFile(v.root, '.claude/settings.json', '{ "hooks": ');
    assert.equal((await doctorOf(v.root)).byId.adapters.status, 'fail');
    fs.rmSync(path.join(v.root, '.claude', 'settings.json'));
    assert.match((await doctorOf(v.root)).byId.adapters.message, /^\.claude\/settings\.json is missing/);

    // Agents that are not used need no files.
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...cfg, agents: ['codex', 'cursor'] });
    d = await doctorOf(v.root);
    assert.equal(d.byId.adapters.status, 'ok');
    assert.equal(d.byId.adapters.message, 'no agent in memory.json "agents" needs an extra file');
  });
});

describe('git', { skip: NO_GIT }, () => {
  test('a missing pre-commit hook fails; the fix restores it from git or from the kit', async () => {
    const v = clone('nohook');
    fs.rmSync(path.join(v.root, '.githooks', 'pre-commit'));
    const d = await doctorOf(v.root);
    assert.equal(d.byId['git.pre_commit'].status, 'fail');
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit is missing, so commits are not checked (secrets, generated views)');
    assert.equal(d.byId['git.pre_commit'].fix, 'git checkout HEAD -- .githooks/pre-commit');
    assert.equal(d.byId['git.hooks_path'].fix, null, 'nothing to repair without the hook file');

    const { root } = fixtureVault('en');
    const plain = await doctorOf(root);
    assert.equal(plain.byId['git.pre_commit'].fix, 'copy .githooks/pre-commit from the kit (https://github.com/8Krystof8/memory-kit.git)');
  });

  test('core.hooksPath unset is a warning that doctor --fix repairs; another value is left alone', async () => {
    const v = clone('hookspath');
    git(v.root, ['config', '--unset', 'core.hooksPath']);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['git.hooks_path'].status, 'warn');
    assert.equal(d.byId['git.hooks_path'].message, 'core.hooksPath is not set, so git never runs .githooks/pre-commit');
    assert.equal(d.byId['git.hooks_path'].fix, 'node system/memory.mjs doctor --fix (or: git config core.hooksPath .githooks)');
    assert.deepEqual(d.repairs, ['hooks_path']);

    const fixed = runCli(v.root, ['doctor', '--fix'], { env: homeEnv(emptyHome) });
    assert.equal(fixed.code, 0, fixed.stdout);
    assert.match(fixed.stdout, /^fixed: git config core\.hooksPath \.githooks$/m);
    assert.match(fixed.stdout, /^✓ git\.hooks_path +core\.hooksPath is \.githooks$/m);
    assert.equal(gitConfigValue(v.root, 'core.hooksPath'), '.githooks');

    git(v.root, ['config', 'core.hooksPath', '.husky']);
    const other = await doctorOf(v.root);
    assert.equal(other.byId['git.hooks_path'].message, 'core.hooksPath is .husky, so git never runs .githooks/pre-commit');
    assert.equal(other.byId['git.hooks_path'].fix, 'git config core.hooksPath .githooks');
    assert.deepEqual(other.repairs, []);
    const res = runCli(v.root, ['doctor', '--fix', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.stderr, '');
    assert.equal(gitConfigValue(v.root, 'core.hooksPath'), '.husky');

    // An absolute path to the same folder counts as set.
    git(v.root, ['config', 'core.hooksPath', path.join(v.root, '.githooks')]);
    assert.equal((await doctorOf(v.root)).byId['git.hooks_path'].status, 'ok');
  });

  test('a CRLF pre-commit hook fails, and doctor --fix rewrites it with LF and mode 755', async () => {
    const v = clone('crlf');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    const lf = fs.readFileSync(hook, 'utf8');
    fs.writeFileSync(hook, lf.replace(/\n/g, '\r\n'));
    const d = await doctorOf(v.root);
    const ch = d.byId['git.pre_commit'];
    assert.equal(ch.status, 'fail');
    assert.equal(ch.message, '.githooks/pre-commit has CRLF line endings, which sh cannot run');
    assert.equal(ch.fix, 'node system/memory.mjs doctor --fix');
    assert.deepEqual(d.repairs, ['hook_file']);

    const res = runCli(v.root, ['doctor', '--fix', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 0, res.stdout);
    const [fixed, kept, ...rest] = res.stderr.split('\n');
    assert.equal(fixed, 'fixed: .githooks/pre-commit now has LF line endings and is executable');
    const backup = /^the previous file is kept in (.+)$/.exec(kept)?.[1];
    assert.ok(backup, res.stderr);
    assert.deepEqual(rest, ['']);
    assert.equal(path.dirname(backup), path.join(v.root, '.memory-kit', 'backups', 'doctor'));
    assert.match(path.basename(backup), /^pre-commit-\d{8}-\d{6}\.bak$/);
    assert.equal(fs.readFileSync(backup, 'utf8'), lf.replace(/\n/g, '\r\n'), 'the backup holds the old bytes');
    assert.equal(jsonOf(res).checks.find((c) => c.id === 'git.pre_commit').status, 'ok');
    assert.equal(fs.readFileSync(hook, 'utf8'), lf);
    if (POSIX) assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
  });

  test('a BOM and a missing executable bit fail too; --fix repairs both at once', { skip: !POSIX && 'file modes' }, async () => {
    const v = clone('bom');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    const lf = fs.readFileSync(hook, 'utf8');
    fs.writeFileSync(hook, `\uFEFF${lf}`);
    fs.chmodSync(hook, 0o644);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit starts with a byte order mark, which hides its #! line; .githooks/pre-commit is not executable, so git skips it');
    assert.equal(d.byId['git.pre_commit'].fix, 'node system/memory.mjs doctor --fix');
    const done = applyRepairs(v.root, d.repairs, { now: new Date(2026, 8, 24, 10, 0, 0) });
    const backup = path.join(v.root, '.memory-kit', 'backups', 'doctor', 'pre-commit-20260924-100000.bak');
    assert.deepEqual(done, [{ name: 'hook_file', ok: true, detail: '', backup }]);
    assert.equal(fs.readFileSync(backup, 'utf8'), `﻿${lf}`);
    assert.equal(fs.readFileSync(hook, 'utf8'), lf);
    assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
    assert.equal((await doctorOf(v.root)).byId['git.pre_commit'].status, 'ok');
    // A second repair in the same second never overwrites the first backup.
    fs.writeFileSync(hook, `﻿${lf}`);
    const again = applyRepairs(v.root, ['hook_file'], { now: new Date(2026, 8, 24, 10, 0, 0) });
    assert.equal(again[0].backup, backup.replace(/\.bak$/, '-2.bak'));
    assert.equal(fs.readFileSync(backup, 'utf8'), `﻿${lf}`);
  });

  test('--fix changes only BOM and CR bytes: a Windows-1250 comment keeps its bytes, and the backup is not committed', async () => {
    const v = clone('cp1250');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    // A vault whose .gitignore does not ignore .memory-kit/ (a 0.1.0 one): the backup goes to .git/info/exclude.
    writeFile(v.root, '.gitignore', readFile(v.root, '.gitignore').split('\n').filter((l) => l.trim() !== '.memory-kit/').join('\n'));
    git(v.root, ['commit', '-q', '--no-verify', '-am', 'no .memory-kit in .gitignore']);
    const probe = spawnSync('git', ['check-ignore', '-q', '.memory-kit/x'], { cwd: v.root, windowsHide: true });
    assert.equal(probe.status, 1, '.memory-kit/ is not ignored now');
    // "# vlastní kontrola" and "echo před commitem" as Windows-1250 bytes (í is 0xED, ř is 0xF8): not UTF-8.
    const wanted = Buffer.concat([fs.readFileSync(hook), Buffer.from('# vlastn\xed kontrola\necho p\xf8ed commitem\n', 'latin1')]);
    const crlf = Buffer.from(wanted.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
    fs.writeFileSync(hook, crlf);
    const res = runCli(v.root, ['doctor', '--fix'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /^fixed: \.githooks\/pre-commit now has LF line endings and is executable$/m);
    assert.ok(fs.readFileSync(hook).equals(wanted), 'only the CR bytes are gone');
    const backup = /^the previous file is kept in (.+)$/m.exec(res.stdout)?.[1];
    assert.ok(backup && fs.readFileSync(backup).equals(crlf), 'the backup holds the old bytes');
    assert.equal(git(v.root, ['status', '--porcelain', '--untracked-files=all']), 'M .githooks/pre-commit', 'the backup is not something to commit');
    assert.match(fs.readFileSync(path.join(v.root, '.git', 'info', 'exclude'), 'utf8'), /^\.memory-kit\/$/m);
  });

  test('a hook that is only not executable gets the executable bits and keeps its bytes and inode', { skip: !POSIX && 'file modes' }, async () => {
    const v = clone('modeonly');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    fs.appendFileSync(hook, Buffer.from('# p\xf8ed commitem\n', 'latin1'));
    fs.chmodSync(hook, 0o640);
    const before = fs.readFileSync(hook);
    const { ino } = fs.statSync(hook);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit is not executable, so git skips it');
    assert.deepEqual(applyRepairs(v.root, d.repairs), [{ name: 'hook_file', ok: true, detail: '', backup: null }]);
    assert.ok(fs.readFileSync(hook).equals(before), 'the same bytes');
    assert.equal(fs.statSync(hook).ino, ino, 'the same file, not a rewritten one');
    assert.equal(fs.statSync(hook).mode & 0o777, 0o751, 'the other permission bits stay');
    assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit', 'backups', 'doctor')), 'no backup without a change of bytes');
  });

  test('a hook that is a symbolic link stays one: --fix repairs the file it leads to inside the vault, never outside', { skip: !POSIX && 'symbolic links' }, async () => {
    const v = clone('symlink');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    const lf = fs.readFileSync(hook);
    const shared = path.join(v.root, 'tools', 'shared-hook.sh');
    fs.mkdirSync(path.dirname(shared));
    fs.writeFileSync(shared, lf);
    fs.chmodSync(shared, 0o644);
    fs.rmSync(hook);
    fs.symlinkSync('../tools/shared-hook.sh', hook);
    let d = await doctorOf(v.root);
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit is not executable, so git skips it');
    assert.deepEqual(d.repairs, ['hook_file']);
    const fixed = runCli(v.root, ['doctor', '--fix', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(fixed.stderr, 'fixed: .githooks/pre-commit now has LF line endings and is executable\n');
    assert.equal(fs.readlinkSync(hook), '../tools/shared-hook.sh', 'still the link');
    assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
    assert.equal(jsonOf(fixed).checks.find((c) => c.id === 'git.pre_commit').status, 'ok');

    fs.writeFileSync(shared, lf.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
    const done = applyRepairs(v.root, ['hook_file'], { now: new Date(2026, 8, 24, 10, 0, 0) });
    assert.deepEqual(done, [{ name: 'hook_file', ok: true, detail: '', backup: path.join(v.root, '.memory-kit', 'backups', 'doctor', 'shared-hook-20260924-100000.sh') }]);
    assert.equal(fs.readlinkSync(hook), '../tools/shared-hook.sh');
    assert.ok(fs.readFileSync(shared).equals(lf));
    assert.equal(fs.statSync(shared).mode & 0o777, 0o755);

    // A link that leaves the vault: doctor names the file, --fix leaves it alone.
    const outside = path.join(path.dirname(v.root), 'outside-hook.sh');
    fs.writeFileSync(outside, lf);
    fs.chmodSync(outside, 0o644);
    fs.rmSync(hook);
    fs.symlinkSync(outside, hook);
    d = await doctorOf(v.root);
    assert.equal(d.byId['git.pre_commit'].status, 'fail');
    assert.equal(d.byId['git.pre_commit'].fix,
      `.githooks/pre-commit links to ${outside}, outside the memory, which doctor --fix leaves alone: give that file LF line endings without a BOM and make it executable`);
    assert.deepEqual(d.repairs, []);
    const refused = applyRepairs(v.root, ['hook_file']);
    assert.deepEqual(refused, [{ name: 'hook_file', ok: false, detail: `it links to ${outside}, outside the memory, and doctor --fix changes nothing there`, backup: null }]);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o644);
    assert.equal(fs.readlinkSync(hook), outside);
  });

  test('a hook without #! fails; one without the check, or stored without the executable bit, warns', async () => {
    const v = clone('hookbody');
    const hook = path.join(v.root, '.githooks', 'pre-commit');
    fs.writeFileSync(hook, 'node system/memory.mjs check --pre-commit\n');
    const noShebang = await doctorOf(v.root);
    assert.equal(noShebang.byId['git.pre_commit'].status, 'fail');
    assert.equal(noShebang.byId['git.pre_commit'].message, 'the first line of .githooks/pre-commit is not #!/bin/sh');
    assert.equal(noShebang.byId['git.pre_commit'].fix, 'copy .githooks/pre-commit from the kit (https://github.com/8Krystof8/memory-kit.git)');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    git(v.root, ['update-index', '--chmod=-x', '.githooks/pre-commit']);
    const d = await doctorOf(v.root);
    const ch = d.byId['git.pre_commit'];
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, '.githooks/pre-commit does not run node system/memory.mjs check --pre-commit; git stores .githooks/pre-commit without the executable bit, so fresh clones on macOS and Linux skip it');
    assert.match(ch.fix, /git update-index --chmod=\+x \.githooks\/pre-commit, then commit/);
  });

  test('the node that git apps started outside a terminal would use', { skip: !POSIX && 'POSIX hooks only' }, async () => {
    const v = clone('guinode');
    git(v.root, ['config', '--unset', 'memorykit.node']);
    const io = (map) => ({ isExecutable: (p) => Object.hasOwn(map, p), nodeVersion: (p) => map[p] ?? null });
    const opts = (map) => ({ io: io(map), platform: 'linux', home: '/home/me' });

    let d = await doctorOf(v.root, opts({ '/usr/local/bin/node': '20.20.2' }));
    let ch = d.byId['git.pre_commit'];
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'git apps started outside a terminal would run the check with /usr/local/bin/node (Node.js 20.20.2, too old), so their commits fail');
    assert.equal(ch.fix, `git config memorykit.node ${process.execPath}`);

    d = await doctorOf(v.root, opts({ '/usr/bin/node': '22.14.0' }));
    assert.equal(d.byId['git.pre_commit'].status, 'ok');
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit runs check --pre-commit with the node on the PATH');

    d = await doctorOf(v.root, opts({}));
    assert.match(d.byId['git.pre_commit'].message, /^git apps started outside a terminal may not find node/);
    d = await doctorOf(v.root, opts({ '/home/me/.volta/bin/node': '22.14.0' }));
    assert.equal(d.byId['git.pre_commit'].status, 'ok');

    git(v.root, ['config', 'memorykit.node', '/gone/bin/node']);
    d = await doctorOf(v.root, opts({}));
    assert.equal(d.byId['git.pre_commit'].message, 'git config memorykit.node points at /gone/bin/node, which cannot be run');
    d = await doctorOf(v.root, opts({ '/gone/bin/node': '18.0.0' }));
    assert.equal(d.byId['git.pre_commit'].message, 'git config memorykit.node points at Node.js 18.0.0 (/gone/bin/node), older than the kit needs (22.5.0)');
    d = await doctorOf(v.root, opts({ '/gone/bin/node': '24.1.0' }));
    assert.equal(d.byId['git.pre_commit'].message, '.githooks/pre-commit runs check --pre-commit with /gone/bin/node');
    // Git for Windows starts hooks with the Windows PATH: no probing there.
    d = await doctorOf(v.root, { io: io({}), platform: 'win32' });
    assert.equal(d.byId['git.pre_commit'].status, 'ok');
  });

  test('git apps: the hook takes the first node that is 22 or newer; a too old one refuses commits only from the app\'s PATH',
    { skip: !POSIX && 'POSIX hooks only' }, async () => {
      const v = clone('guinode22');
      git(v.root, ['config', '--unset', 'memorykit.node']);
      const io = (map) => ({ isExecutable: (p) => Object.hasOwn(map, p), nodeVersion: (p) => map[p] ?? null });
      const linux = (map) => ({ io: io(map), platform: 'linux', home: '/home/me' });
      const mac = (map) => ({ io: io(map), platform: 'darwin', home: '/Users/me' });
      const hook = async (opts) => (await doctorOf(v.root, opts)).byId['git.pre_commit'];
      const ok = '.githooks/pre-commit runs check --pre-commit with the node on the PATH';
      const unchecked = /^git apps started outside a terminal may not find node \(.+ is not in a standard place\), so their commits go unchecked$/;

      // A stale node in a usual place does not hide a newer one behind it.
      assert.equal((await hook(linux({ '/usr/local/bin/node': '20.20.2', '/home/me/.volta/bin/node': '22.14.0' }))).message, ok);
      assert.equal((await hook(linux({ '/usr/bin/node': '18.19.1', '/opt/homebrew/bin/node': '22.1.0' }))).message, ok);
      assert.equal((await hook(mac({ '/usr/bin/node': '20.20.2', '/opt/homebrew/bin/node': '24.1.0' }))).message, ok);
      // `command -v node` finds only the first node on the PATH: /usr/local/bin before /usr/bin on Linux.
      assert.equal((await hook(linux({ '/usr/bin/node': '18.19.1', '/usr/local/bin/node': '22.1.0' }))).message, ok);

      // Only too old nodes: one on the app's PATH refuses every commit ...
      let ch = await hook(linux({ '/usr/bin/node': '18.19.1', '/home/me/.volta/bin/node': '20.0.0' }));
      assert.equal(ch.status, 'warn');
      assert.equal(ch.message, 'git apps started outside a terminal would run the check with /usr/bin/node (Node.js 18.19.1, too old), so their commits fail');
      assert.equal(ch.fix, `git config memorykit.node ${process.execPath}`);
      ch = await hook(mac({ '/usr/bin/node': '20.20.2' }));
      assert.match(ch.message, /with \/usr\/bin\/node \(Node\.js 20\.20\.2, too old\), so their commits fail$/);
      // ... while one only in a usual place counts as no node: the hook skips the check.
      ch = await hook(mac({ '/usr/local/bin/node': '20.20.2' }));
      assert.match(ch.message, unchecked);
      assert.equal(ch.fix, `git config memorykit.node ${process.execPath}`);
      assert.match((await hook(linux({ '/opt/homebrew/bin/node': '20.0.0', '/home/me/.volta/bin/node': '18.0.0' }))).message, unchecked);
    });

  test('no repository, a repository around the vault, a broken .git, no remote, a rebase', async () => {
    const { base, root } = fixtureVault('en');
    let d = await doctorOf(root);
    assert.equal(d.byId['git.repo'].status, 'warn');
    assert.equal(d.byId['git.repo'].fix, 'git init -b main, then git config core.hooksPath .githooks');
    assert.equal(d.byId['git.hooks_path'].message, 'not checked: no repository of its own that git can use (see git.repo)');
    assert.ok(d.skipped.includes('git.hooks_path'));

    git(base, ['init', '-q', '-b', 'main']);
    d = await doctorOf(root);
    assert.match(d.byId['git.repo'].message, /^this folder is inside another git repository \(.+\); the memory needs its own$/);
    assert.equal(d.byId['git.repo'].fix, 'git init -b main in this folder');

    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ../no-such-dir\n');
    d = await doctorOf(root);
    assert.equal(d.byId['git.repo'].status, 'fail');
    assert.match(d.byId['git.repo'].message, /^git cannot use this repository: /);

    const v = clone('remote');
    git(v.root, ['remote', 'remove', 'origin']);
    d = await doctorOf(v.root);
    assert.equal(d.byId['git.repo'].status, 'warn');
    assert.equal(d.byId['git.repo'].message, 'git repository · branch main · remote –; the repository has no remote, so nothing is backed up or synced');
    fs.mkdirSync(path.join(v.root, '.git', 'rebase-merge'));
    d = await doctorOf(v.root);
    assert.match(d.byId['git.repo'].message, /a git rebase is in progress/);
    assert.match(d.byId['git.repo'].fix, /git rebase --continue\) or undo it \(git rebase --abort\)/);
    fs.rmSync(path.join(v.root, '.git', 'rebase-merge'), { recursive: true });
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...cfg, mode: 'local' });
    d = await doctorOf(v.root);
    assert.equal(d.byId['git.repo'].status, 'ok');
    assert.equal(d.byId['git.repo'].message, 'git repository · branch main · mode local, so nothing is pushed');
  });

  test('.gitattributes without the LF rule is a warning that names core.autocrlf', async () => {
    const v = clone('attributes');
    writeFile(v.root, '.gitattributes', '*.png binary\n');
    git(v.root, ['config', 'core.autocrlf', 'true']);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['git.attributes'].status, 'warn');
    assert.equal(d.byId['git.attributes'].message, '.gitattributes has no line * text=auto eol=lf, so line endings depend on the git settings of each computer (core.autocrlf is true here, so files are checked out with CRLF)');
    assert.equal(d.byId['git.attributes'].fix, 'add the line * text=auto eol=lf at the top of .gitattributes and commit it');
    fs.rmSync(path.join(v.root, '.gitattributes'));
    assert.match((await doctorOf(v.root)).byId['git.attributes'].message, /^\.gitattributes is missing/);
  });
});

describe('roots and generated views', { skip: NO_GIT }, () => {
  test('a local root inside the repository fails roots and the config', () => {
    const v = clone('inside');
    fs.mkdirSync(path.join(v.root, 'inner'));
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    cfg.roots[1].path = 'inner';
    writeJson(v.root, 'memory.json', cfg);
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    assert.equal(res.code, 1);
    const report = jsonOf(res);
    assertValid(report);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.roots.status, 'fail');
    assert.equal(byId.roots.message, `local root "${cfg.roots[1].id}" (inner) lies inside the repository, so its private notes would be committed`);
    assert.equal(byId.roots.fix, 'move the folder out of the repository (for example to ../vault-private) and change its "path" in memory.json "roots"');
    assert.equal(byId['config.memory_json'].status, 'fail');
    assert.match(byId['config.memory_json'].message, /lies inside the repository/);
    assert.match(byId['generated.fresh'].message, /^not checked/);
  });

  test('a missing local root and one written for another system are warnings', async () => {
    const v = clone('roots');
    fs.rmSync(v.priv, { recursive: true });
    let d = await doctorOf(v.root);
    assert.equal(d.byId.roots.status, 'warn');
    assert.match(d.byId.roots.message, /^local root "\S+" is not at .+, so its local sectors are missing on this computer$/);
    assert.equal(d.byId.roots.fix, 'create the folder, or copy it from the computer that has it');

    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    cfg.roots[1].path = POSIX ? 'D:/private' : '/home/me/private';
    writeJson(v.root, 'memory.json', cfg);
    d = await doctorOf(v.root);
    assert.equal(d.byId.roots.status, 'warn');
    assert.match(d.byId.roots.message, /is an absolute path of another operating system, so it is not available here$/);

    delete cfg.roots;
    writeJson(v.root, 'memory.json', cfg);
    d = await doctorOf(v.root);
    assert.equal(d.byId.roots.message, 'one root: every note lives in this repository');
  });

  test('stale views are a warning, views edited by hand a failure', async () => {
    const v = clone('views');
    fs.rmSync(path.join(v.root, '_ai', 'catalog.tsv'));
    let d = await doctorOf(v.root);
    assert.equal(d.byId['generated.fresh'].status, 'warn');
    assert.equal(d.byId['generated.fresh'].message, 'generated views to refresh: _ai/catalog.tsv');
    assert.equal(d.byId['generated.fresh'].fix, 'node system/memory.mjs check --generate');

    fs.appendFileSync(path.join(v.root, '_ai', 'start.md'), 'a hand edit\n');
    d = await doctorOf(v.root);
    assert.equal(d.byId['generated.fresh'].status, 'fail');
    assert.equal(d.byId['generated.fresh'].message, 'generated views edited by hand: _ai/start.md; generated views to refresh: _ai/catalog.tsv');

    const gen = runCli(v.root, ['check', '--generate']);
    assert.equal(gen.code, 0, gen.stdout);
    assert.equal((await doctorOf(v.root)).byId['generated.fresh'].status, 'ok');
  });
});

describe('Node.js and the platform', { skip: NO_GIT }, () => {
  test('an older Node.js fails; no FTS5 is a warning', async () => {
    const v = clone('node');
    const d = await doctorOf(v.root, { nodeVersion: '22.4.0', fts5: async () => false });
    assert.equal(d.byId['node.version'].status, 'fail');
    assert.equal(d.byId['node.version'].message, 'Node.js 22.4.0 is older than the kit needs (22.5.0)');
    assert.equal(d.byId['node.version'].fix, 'install Node.js 22.5.0 or newer (the LTS version from nodejs.org)');
    assert.equal(d.byId['node.fts5'].status, 'warn');
    assert.equal(d.byId['node.fts5'].message, 'Node.js 22.4.0 has no node:sqlite with FTS5, so search uses the slower scan engine');
    const fine = await doctorOf(v.root, { nodeVersion: '24.1.0', fts5: async () => true });
    assert.equal(fine.byId['node.version'].message, 'Node.js 24.1.0 (the kit needs 22.5.0 or newer)');
    assert.equal(fine.byId['node.fts5'].status, 'ok');
  });

  test('platform: the facts, a HOME that differs from the user folder on Windows, a sync folder', async () => {
    const v = clone('platform');
    let d = await doctorOf(v.root, { platform: 'linux', osRelease: '6.1.0', arch: 'x64', execPath: '/usr/bin/node', home: '/home/me' });
    assert.equal(d.byId.platform.status, 'ok');
    assert.equal(d.byId.platform.message, 'Linux 6.1.0 (x64) · Node.js at /usr/bin/node · home /home/me · UTF-8 test: ěščřžýáíé');

    const win = { platform: 'win32', osRelease: '10.0.26100', arch: 'x64', execPath: 'C:\\Program Files\\nodejs\\node.exe', home: 'C:\\Users\\me' };
    d = await doctorOf(v.root, { ...win, env: { HOME: '/c/Users/me' } });
    assert.equal(d.byId.platform.status, 'ok', 'Git Bash spelling of the same folder');
    d = await doctorOf(v.root, { ...win, env: { HOME: 'D:\\home' } });
    assert.equal(d.byId.platform.status, 'warn');
    assert.match(d.byId.platform.message, /^Windows 10\.0\.26100 \(x64\) · .*; HOME is D:\\home, but the user folder is C:\\Users\\me;/);
    assert.equal(d.byId.platform.fix, 'remove the HOME variable or set it to C:\\Users\\me');

    const cloud = path.join(tmpDir('doctor-cloud'), 'OneDrive - Contoso', 'memory');
    cloneDir(v.root, cloud);
    d = await doctorOf(cloud, { platform: 'linux' });
    assert.equal(d.byId.platform.status, 'warn');
    assert.match(d.byId.platform.message, /the memory lies in a OneDrive folder; sync apps lock files while git writes them and can damage \.git$/);
  });
});

describe('MCP clients', { skip: NO_GIT }, () => {
  function fakeHome(root) {
    const home = tmpDir('doctor-mcp-home');
    const script = path.join(root, 'system', 'memory.mjs');
    const ours = (command) => ({ command, args: [script, 'mcp', '--root', root] });
    writeJson(home, '.cursor/mcp.json', { mcpServers: { 'memory-kit': { type: 'stdio', ...ours(process.execPath) } } });
    writeJson(home, '.claude.json', { mcpServers: { memory: { type: 'stdio', ...ours(path.join(home, 'gone', 'node')), env: {} } } });
    const gone = path.join(home, 'old-vault');
    const goneScript = path.join(gone, 'system', 'memory.mjs').replace(/\\/g, '/');
    writeFile(home, '.codex/config.toml', `[mcp_servers.old]\ncommand = "node"\nargs = ["${goneScript}", "mcp", "--root", "${gone.replace(/\\/g, '/')}"]\n`);
    writeFile(home, '.gemini/settings.json', '{ "mcpServers": ');
    return home;
  }

  test('connected clients, a stale command, an entry for a vault that is gone, an unreadable config', async () => {
    const v = clone('mcp');
    const home = fakeHome(v.root);
    const d = await doctorOf(v.root, { home, env: {}, clients: { findCli: () => null } });
    const ch = d.byId['mcp.clients'];
    assert.equal(ch.status, 'warn');
    const parts = ch.message.split('; ');
    assert.equal(parts[0], 'connected in: Claude Code, Cursor');
    assert.ok(parts.includes(`Claude Code: entry "memory" starts ${path.join(home, 'gone', 'node')}, which no longer exists`), ch.message);
    assert.ok(parts.some((p) => /^Gemini CLI: .+settings\.json cannot be read \(/.test(p)), ch.message);
    assert.ok(parts.includes(`Codex: entry "old" serves a memory that no longer exists (${path.join(home, 'old-vault').replace(/\\/g, '/')})`), ch.message);
    assert.match(ch.fix, /node system\/memory\.mjs connect claude-code/);
    assert.match(ch.fix, /node system\/memory\.mjs connect codex --remove --name old --force/);
    assert.match(ch.fix, /fix the syntax of .+settings\.json/);
    assert.equal(d.report.summary.fail, 0);
  });

  test('the CLI reads the clients of the home it runs with', () => {
    const v = clone('mcp-cli');
    const home = tmpDir('doctor-mcp-cli');
    writeJson(home, '.cursor/mcp.json', { mcpServers: { 'memory-kit': { command: process.execPath, args: [path.join(v.root, 'system', 'memory.mjs'), 'mcp', '--root', v.root] } } });
    const res = runCli(v.root, ['doctor', '--json'], { env: homeEnv(home) });
    assert.equal(res.code, 0, res.stderr);
    const ch = jsonOf(res).checks.find((c) => c.id === 'mcp.clients');
    assert.equal(ch.status, 'ok');
    assert.equal(ch.message, 'connected in: Cursor');
  });

  test('with no client the check is ok and points at connect', async () => {
    const v = clone('mcp-none');
    const d = await doctorOf(v.root);
    assert.equal(d.byId['mcp.clients'].status, 'ok');
    assert.equal(d.byId['mcp.clients'].message, 'no MCP client is connected to this memory (optional: node system/memory.mjs connect --list)');
  });
});

describe('more cases', { skip: NO_GIT }, () => {
  test('kit.json that names another data version, and one that cannot be read', async () => {
    const v = clone('manifest');
    const manifest = JSON.parse(readFile(v.root, 'system/kit.json'));
    writeJson(v.root, 'system/kit.json', { ...manifest, data_version: 2 });
    let d = await doctorOf(v.root);
    assert.equal(d.byId['config.data_version'].status, 'warn');
    assert.equal(d.byId['config.data_version'].message, 'system/kit.json names data version 2, but the code reads 1');
    assert.equal(d.byId['config.data_version'].fix, 'git checkout -- system/kit.json');
    writeFile(v.root, 'system/kit.json', '{ nope');
    d = await doctorOf(v.root);
    assert.equal(d.byId['kit.version'].status, 'warn');
    assert.equal(d.byId['kit.version'].message, 'system/kit.json cannot be read');
    assert.ok(d.skipped.includes('kit.integrity'));
  });

  test('a file of another kit release is named as such; many missing files get a general fix', async () => {
    const v = clone('known');
    const rel = 'system/lib/text.mjs';
    const old = '// this file as an older release shipped it\n';
    writeFile(v.root, rel, old);
    writeJson(v.root, 'system/kit-history.json', { '0.0.9': { [rel]: hashText(old) } });
    let d = await doctorOf(v.root);
    assert.equal(d.byId['kit.integrity'].message,
      'kit files changed here: system/lib/text.mjs; an upgrade stops at them unless --force (1 of them hold the code of another kit release)');

    const w = clone('many');
    const gone = ['system/migrations/index.mjs', 'system/schema/kit.schema.json', 'system/schema/note.schema.json', 'system/tools/release.mjs'];
    for (const r of gone) fs.rmSync(path.join(w.root, ...r.split('/')));
    d = await doctorOf(w.root);
    assert.equal(d.byId['kit.integrity'].status, 'fail');
    assert.equal(d.byId['kit.integrity'].message, `kit files missing: ${gone.slice(0, 3).join(', ')} and 1 more`);
    assert.equal(d.byId['kit.integrity'].fix, 'git status lists them; git checkout -- <file> restores each one from the last commit');
  });

  test('AGENTS.md with the end marker before the start marker fails', async () => {
    const v = clone('order');
    const text = readFile(v.root, 'AGENTS.md');
    writeFile(v.root, 'AGENTS.md', `<!-- kit:end -->\n${text.replace('<!-- kit:end -->\n', '')}`);
    const d = await doctorOf(v.root);
    assert.equal(d.byId['agents.block'].status, 'fail');
    assert.equal(d.byId['agents.block'].message, 'in AGENTS.md the line <!-- kit:end --> comes before <!-- kit:start');
  });

  test('without git: a failure in a repository, a warning outside one', async () => {
    const v = clone('nogit');
    const noGit = { io: { gitAvailable: () => false } };
    let d = await doctorOf(v.root, noGit);
    assert.equal(d.byId['git.repo'].status, 'fail');
    assert.equal(d.byId['git.repo'].message, 'git is not installed or not on the PATH');
    assert.equal(d.byId['git.repo'].fix, 'install git (git-scm.com)');
    assert.ok(d.skipped.includes('git.hooks_path'));
    const { root } = fixtureVault('en');
    d = await doctorOf(root, noGit);
    assert.equal(d.byId['git.repo'].status, 'warn');
  });

  test('a start view over its byte budget fails generated.fresh', async () => {
    const v = clone('budget');
    const cfg = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...cfg, budgets: { start_bytes: [100, 200] } });
    const d = await doctorOf(v.root);
    assert.equal(d.byId['generated.fresh'].status, 'fail');
    assert.equal(d.byId['generated.fresh'].message, 'the start view cannot fit its byte budget');
    assert.equal(d.byId['generated.fresh'].fix, 'shorten the Now section of state.md or pin fewer notes, then node system/memory.mjs check --generate');
  });

  test('a check that throws is reported as failed and the others still run', async () => {
    const v = clone('crash');
    const d = await doctorOf(v.root, { fts5: async () => { throw new Error('boom'); } });
    assert.deepEqual(d.byId['node.fts5'], { id: 'node.fts5', status: 'fail', message: 'the check itself failed: boom', fix: null });
    assert.equal(d.byId['node.version'].status, 'ok');
    assert.equal(d.byId['mcp.clients'].status, 'ok');
    assert.equal(d.report.summary.fail, 1);
  });

  test('a repair that cannot be done is reported, not thrown; unknown repairs are ignored', () => {
    const v = clone('repair');
    fs.rmSync(path.join(v.root, '.githooks', 'pre-commit'));
    const done = applyRepairs(v.root, ['hook_file', 'no_such_repair']);
    assert.equal(done.length, 1);
    assert.equal(done[0].name, 'hook_file');
    assert.equal(done[0].ok, false);
    assert.match(done[0].detail, /ENOENT/);
    const { root } = fixtureVault('en');
    const outside = applyRepairs(root, ['hooks_path']);
    assert.equal(outside[0].ok, false, 'git config outside a repository fails');
    assert.ok(outside[0].detail);
  });
});

describe('CLI', () => {
  test('usage errors exit 2', () => {
    const { root } = fixtureVault('en');
    const flag = runCli(root, ['doctor', '--bogus']);
    assert.equal(flag.code, 2);
    assert.match(flag.stderr, /usage: node system\/memory\.mjs doctor \[--json\] \[--fix\]/);
    const arg = runCli(root, ['doctor', 'extra']);
    assert.equal(arg.code, 2);
    assert.match(arg.stderr, /unexpected argument "extra"/);
  });

  test('a fixture vault without git: the exit code follows the failures', () => {
    const { root } = fixtureVault('cs');
    const res = runCli(root, ['doctor', '--json'], { env: homeEnv(emptyHome) });
    const report = jsonOf(res);
    assertValid(report);
    assert.equal(res.code, report.summary.fail ? 1 : 0);
    assert.equal(report.checks.find((c) => c.id === 'config.memory_json').message, 'memory.json je v pořádku (jazyk cs, režim combined)');
  });
});

describe('the library probes', () => {
  test('IO.nodeVersion reads this Node.js; IO.isExecutable knows files from folders', () => {
    assert.equal(IO.nodeVersion(process.execPath), process.versions.node);
    assert.equal(IO.nodeVersion(path.join(emptyHome, 'no-node')), null);
    assert.ok(IO.isExecutable(process.execPath));
    assert.ok(!IO.isExecutable(emptyHome));
    // A version, or null where no claude runs; never an error.
    const claude = IO.claudeVersion();
    assert.ok(claude === null || /^\d+\.\d+\.\d+$/.test(claude), String(claude));
  });
});

/** The root of the healthy vault (read-only use). */
function healthyRoot() {
  return path.join(healthy, 'vault');
}

// ---------------------------------------------------------------------------------------------
// Memory hooks for code projects (connect --projects)

describe('project hooks (projects.hooks)', () => {
  const NOW = new Date('2026-09-25T12:00:00.000Z');
  const ENABLED = { enabled: true, auto_add: false, store: 'local', autosync: false };

  /** A vault with a system/memory.mjs and memory.json "projects", and an empty home. */
  function vaultWith(projects = ENABLED) {
    const root = bareRoot('en', projects === null ? {} : { projects });
    fs.writeFileSync(path.join(root, 'system', 'memory.mjs'), '// the vault CLI\n');
    const home = tmpDir('proj-home');
    return { root, home, settings: path.join(home, '.claude', 'settings.json'), codex: path.join(home, '.codex', 'hooks.json') };
  }

  /** Probes that make the machine running the tests irrelevant. */
  const quiet = (over = {}) => ({
    nodeVersion: () => '22.22.0',
    isExecutable: () => true,
    claudeVersions: () => ({ observed: [{ source: 'cli', version: '2.1.200' }], min: '2.1.200' }),
    codexInfo: () => ({ observed: [{ source: 'cli', version: '0.140.0' }], min: '0.140.0', off: null }),
    newestSessionStart: () => 0,
    ...over,
  });

  async function connect(v, opts = {}) {
    const res = await installProjects(v.root, {
      agent: 'claude-code', env: {}, home: v.home, t: null, ...opts,
      io: { nodeOnPath: () => '22.22.0', shortPath: () => null, claudeVersions: () => ({ observed: [], min: '2.1.200' }), codexInfo: () => ({ observed: [], min: '0.140.0', off: null }), hasRemote: () => false, ...opts.io },
    });
    assert.equal(res.exit, 0, res.error);
    return res;
  }

  async function hooksOf(v, opts = {}) {
    const { io, ...rest } = opts;
    const d = await doctorOf(v.root, { home: v.home, env: {}, now: NOW, io: quiet(io), ...rest });
    return d.byId['projects.hooks'];
  }

  /** Our hooks for script written straight into the settings file (with extra settings keys). */
  function writeHooks(v, script, { form = 'shell', events = EVENTS['claude-code'], extra = {} } = {}) {
    const plan = form === 'exec' ? { form, exe: 'node' } : { form, nodeWord: 'node' };
    const groups = hookGroups('claude-code', events, plan, { script, platform: process.platform });
    fs.mkdirSync(path.dirname(v.settings), { recursive: true });
    fs.writeFileSync(v.settings, JSON.stringify(planHooks(extra, 'claude-code', { groups }), null, 2));
  }

  test('not set up: ok, with the command only where the kit has it', async () => {
    const v = vaultWith(null);
    const ch = await hooksOf(v);
    assert.equal(ch.status, 'ok');
    assert.equal(ch.message, 'memory for code projects is not set up (optional: node system/memory.mjs connect claude-code --projects)');
    const plain = await hooksOf(v, { kitRoot: KIT_ROOT });
    assert.equal(plain.message, 'memory for code projects is not set up');
    assert.equal((await hooksOf(vaultWith({ enabled: false, auto_add: true }))).status, 'ok');
  });

  test('turned on but no hooks on this computer: a warning with the command', async () => {
    const ch = await hooksOf(vaultWith());
    assert.equal(ch.status, 'warn');
    assert.equal(ch.message, 'memory.json turns on the memory for code projects, but this computer has no memory hooks');
    assert.equal(ch.fix, 'node system/memory.mjs connect claude-code --projects (or connect codex --projects)');
  });

  test('connected: ok with the settings', async () => {
    const v = vaultWith(null);
    await connect(v, { autoAdd: true });
    const ch = await hooksOf(v);
    assert.equal(ch.status, 'ok', ch.message);
    assert.equal(ch.message, 'memory hooks for Claude Code · store local · auto_add true · autosync false');
    await connect(v, { agent: 'codex' });
    assert.equal((await hooksOf(v)).message, 'memory hooks for Claude Code, Codex · store local · auto_add true · autosync false');
  });

  test('a moved vault fails; hooks of another memory warn', async () => {
    const v = vaultWith();
    writeHooks(v, path.join(tmpDir('gone'), 'old', 'system', 'memory.mjs'));
    const moved = await hooksOf(v, { io: { isFile: () => false } });
    assert.equal(moved.status, 'fail');
    assert.match(moved.message, /Claude Code: the hooks run .*old[\\/]system[\\/]memory\.mjs, which does not exist \(was the memory moved\?\)/);
    assert.equal(moved.fix, 'node system/memory.mjs connect claude-code --projects');
    const other = vaultWith();
    writeHooks(v, path.join(other.root, 'system', 'memory.mjs'));
    const ch = await hooksOf(v);
    assert.equal(ch.status, 'warn');
    assert.match(ch.message, /Claude Code: the hooks serve another memory/);
  });

  test('a missing event, the exec form and PostToolUseFailure on old versions', async () => {
    const v = vaultWith();
    const script = path.join(v.root, 'system', 'memory.mjs');
    writeHooks(v, script, { events: EVENTS['claude-code'].filter(([n]) => n !== 'Stop') });
    const missing = await hooksOf(v);
    assert.equal(missing.status, 'warn');
    assert.match(missing.message, /Claude Code: the memory hooks for Stop are missing/);
    writeHooks(v, script, { form: 'exec' });
    const old = await hooksOf(v, { io: { claudeVersions: () => ({ observed: [], min: '2.1.100' }) } });
    assert.equal(old.status, 'fail');
    assert.match(old.message, /the hooks use the exec form, which Claude Code 2\.1\.100 does not run/);
    assert.match(old.message, /include PostToolUseFailure, and Claude Code 2\.1\.100 \(older than 2\.1\.101\)/);
    assert.match(old.fix, /--form shell/);
    const unknown = await hooksOf(v, { io: { claudeVersions: () => ({ observed: [], min: null }) } });
    assert.equal(unknown.status, 'ok', 'an unknown version is no finding');
    const fine = await hooksOf(v, { io: { claudeVersions: () => ({ observed: [], min: '2.1.139' }) } });
    assert.equal(fine.status, 'ok', fine.message);
  });

  test('node: missing, too old, or a path that is gone', async () => {
    const v = vaultWith();
    writeHooks(v, path.join(v.root, 'system', 'memory.mjs'));
    const missing = await hooksOf(v, { io: { nodeVersion: () => null } });
    assert.equal(missing.status, 'fail');
    assert.match(missing.message, /the hooks start node, which is not on the PATH here/);
    assert.match(missing.fix, /install Node\.js 22\.5\.0 or newer so that node is on the PATH/);
    const old = await hooksOf(v, { io: { nodeVersion: () => '20.11.0' } });
    assert.match(old.message, /the hooks start node, which is Node\.js 20\.11\.0 \(the kit needs 22\.5\.0\)/);
    const groups = hookGroups('claude-code', EVENTS['claude-code'], { form: 'shell', nodeWord: '"/opt/old node/bin/node"' }, { script: path.join(v.root, 'system', 'memory.mjs') });
    fs.writeFileSync(v.settings, JSON.stringify(planHooks({}, 'claude-code', { groups })));
    const gone = await hooksOf(v, { io: { isExecutable: () => false } });
    assert.equal(gone.status, 'fail');
    assert.match(gone.message, /the hooks start \/opt\/old node\/bin\/node, which does not exist/);
  });

  test('disableAllHooks, an unreadable settings file, Codex switched off or old', async () => {
    const v = vaultWith();
    writeHooks(v, path.join(v.root, 'system', 'memory.mjs'), { extra: { disableAllHooks: true } });
    const off = await hooksOf(v);
    assert.equal(off.status, 'warn');
    assert.match(off.message, /"disableAllHooks": true, so no hook runs/);
    fs.writeFileSync(v.settings, '{ "hooks": ');
    const broken = await hooksOf(v);
    assert.equal(broken.status, 'warn');
    assert.match(broken.message, /Claude Code: .*settings\.json cannot be read/);
    fs.rmSync(v.settings);
    await connect(v, { agent: 'codex' });
    const codex = await hooksOf(v, { io: { codexInfo: () => ({ observed: [], min: '0.120.0', off: { path: '/h/.codex/config.toml', key: 'codex_hooks' } }) } });
    assert.equal(codex.status, 'warn');
    assert.match(codex.message, /Codex: \/h\/\.codex\/config\.toml turns hooks off \(\[features\] codex_hooks = false\)/);
    assert.match(codex.message, /Codex 0\.120\.0 runs hooks only with \[features\] hooks = true/);
  });

  test('installed but not running: sessions after the change and no run in the log', async () => {
    const v = vaultWith();
    await connect(v);
    const changed = fs.statSync(v.settings).mtimeMs;
    const later = () => changed + 3600000;
    const ch = await hooksOf(v, { io: { newestSessionStart: later } });
    assert.equal(ch.status, 'warn');
    assert.match(ch.message, /Claude Code: the hooks are in place, but none has run since \d{4}-\d\d-\d\d \d\d:\d\d, though sessions started after that/);
    assert.match(ch.fix, /accept the folder trust dialog/);
    logHook(v.root, { agent: 'claude-code', event: 'session-start', ok: true, ms: 40 }, { now: new Date(changed + 60000) });
    assert.equal((await hooksOf(v, { io: { newestSessionStart: later } })).status, 'ok');
    assert.equal((await hooksOf(v, { io: { newestSessionStart: () => changed + 30000 } })).status, 'ok', 'the session that ran connect');
  });

  test('failures of the last 7 days and a failed sync, with their fixes', async () => {
    const v = vaultWith();
    await connect(v);
    const at = (days) => new Date(NOW.getTime() - days * 86400000);
    logHook(v.root, { agent: 'claude-code', event: 'stop', ok: false, error: 'old failure' }, { now: at(10) });
    for (const [i, err] of ['EACCES one', 'EACCES two', 'EACCES three', 'EACCES four'].entries()) {
      logHook(v.root, { agent: 'claude-code', event: 'session-start', ok: false, error: err, fix: i === 3 ? 'fix the permissions' : undefined }, { now: at(4 - i) });
    }
    logHook(v.root, { agent: 'claude-code', event: 'autosync', step: 'push', ok: false, error: 'rejected (fetch first)', fix: 'node system/memory.mjs sync' }, { now: at(0.5) });
    const ch = await hooksOf(v);
    assert.equal(ch.status, 'warn');
    assert.match(ch.message, /hook failures in the last 7 days: session-start 2026-09-24: EACCES four, session-start 2026-09-23: EACCES three, session-start 2026-09-22: EACCES two and 1 more/);
    assert.doesNotMatch(ch.message, /old failure/);
    assert.match(ch.message, /the last automatic sync failed \(push, 2026-09-25 00:00\): rejected \(fetch first\)/);
    assert.equal(ch.fix, `fix the permissions; the details are in ${LOG_REL}; node system/memory.mjs sync`);
    logHook(v.root, { agent: 'claude-code', event: 'autosync', step: 'done', ok: true }, { now: at(0.1) });
    assert.doesNotMatch((await hooksOf(v)).message, /automatic sync failed/);
  });

  test('--probe runs the session start hook as Claude Code does', async () => {
    const v = vaultWith();
    const res = await connect(v);
    const seen = [];
    const probe = (result) => (spec, opts) => {
      seen.push({ spec, opts, cwdExists: fs.existsSync(opts.cwd) });
      return { code: 0, stdout: '', stderr: '', ms: 120, error: null, ...result };
    };
    const ok = await hooksOf(v, { probe: true, io: { probeHook: probe({}) } });
    assert.equal(ok.status, 'ok', ok.message);
    assert.match(ok.message, /; Claude Code: the session start hook ran in 120 ms with clean output$/);
    const { spec, opts } = seen[0];
    if (POSIX) assert.deepEqual([spec.command, spec.args], ['/bin/sh', ['-c', res.command]]);
    const input = JSON.parse(opts.input);
    assert.deepEqual([input.session_id, input.hook_event_name, input.source, input.cwd], ['doctor-probe', 'SessionStart', 'startup', opts.cwd]);
    assert.ok(seen[0].cwdExists && !fs.existsSync(opts.cwd), 'an empty temporary folder, removed afterwards');

    const noise = await hooksOf(v, { probe: true, io: { probeHook: probe({ stdout: 'Welcome to zsh!\n' }) } });
    assert.equal(noise.status, 'fail');
    assert.match(noise.message, /the session start hook printed text outside a project: Welcome to zsh!/);
    assert.match(noise.fix, /shell profile/);
    const failed = await hooksOf(v, { probe: true, io: { probeHook: probe({ code: 127, stderr: 'sh: node: not found\n' }) } });
    assert.equal(failed.status, 'fail');
    assert.match(failed.message, /failed when run as Claude Code runs it \(exit 127: sh: node: not found\)/);
    assert.equal(failed.fix, `run it yourself to see the error: ${res.command}`);
    const slow = await hooksOf(v, { probe: true, io: { probeHook: probe({ ms: 2400 }) } });
    assert.equal(slow.status, 'warn');
    assert.match(slow.message, /took 2400 ms outside a project \(more than 1500 ms\)/);
    assert.equal((await hooksOf(v, { io: { probeHook: () => assert.fail('no probe without --probe') } })).status, 'ok');
  });

  test('doctor --probe is a flag of the command', () => {
    const { root } = fixtureVault('en');
    const res = runCli(root, ['doctor', '--probe', '--json'], { env: homeEnv(emptyHome) });
    const report = jsonOf(res);
    assertValid(report);
    assert.equal(report.checks.at(-1).id, 'projects.hooks');
    assert.equal(report.checks.at(-1).status, 'ok');
  });
});

