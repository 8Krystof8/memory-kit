// connect claude-code|codex --projects (lib/hooksetup.mjs): the shell-form command for macOS,
// Linux and Windows (spaces, diacritics, characters no shell passes on), which node a hook starts,
// the Claude Code and Codex versions seen here (the command, the editor extensions, the
// transcripts), which events a version may get, the settings file edit (foreign hooks, places,
// removal, backups, files that are not plain JSON, refusals), memory.json "projects" with its safe
// defaults, the CLI, the proof that the generated command reaches the hook unchanged through the
// shells that really run it (also where a repository pins an old node on the PATH), the marks of
// the doctor probe, and memory.mjs ending a hook quietly on a too old Node.js.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  AGENTS, EVENTS, IO, PROBE_ENV, ProjectsRefused, SAFE_DEFAULTS, chooseNode, claudeVersions, cliVersion, cmpVersion, codexInfo,
  eventsFor, extensionVersions, formatInstall, gitBashPath, hookGroups, hookHandler, hookNodePath, hookScript, installProjects, isOurs,
  localRootOf, maxVersion, minVersion, newestSessionStart, nextProjects, ourHooks, parseHandler, parseVersion, planForm, planHooks,
  probeEnv, probePayload, probeSpec, removedProjects, runProbe, say, settingsPath, shellCommand, transcriptVersions, unsafeChars,
} from '../../lib/hooksetup.mjs';
import { hookCall, quietHook } from '../../lib/oldnode.mjs';
import { commandNode } from '../../lib/nodepath.mjs';
import { readHookLog } from '../../lib/hooklog.mjs';
import { KIT_ROOT, bareRoot, fixtureVault, removeTmpDirs, runCli, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const IS_WIN = process.platform === 'win32';
const HAS_GIT = (() => {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();
const NODE_DIR = path.dirname(process.execPath);
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
// The Node.js the installs of these tests name, and how their commands start it.
const FAKE_NODE = IS_WIN ? 'C:\\nodejs\\node.exe' : '/opt/node/bin/node';
const NODE_WORD = IS_WIN ? 'C:/nodejs/node.exe' : '"/opt/node/bin/node"';

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Probes that decide nothing on the machine that runs the tests. */
function fakeIO(over = {}) {
  return {
    nodeOnPath: () => '22.22.0',
    nodePath: () => FAKE_NODE,
    shortPath: () => null,
    claudeVersions: () => ({ observed: [{ source: 'cli', version: '2.1.200' }], min: '2.1.200' }),
    codexInfo: () => ({ observed: [{ source: 'cli', version: '0.140.0' }], min: '0.140.0', off: null }),
    hasRemote: () => false,
    ...over,
  };
}

/** A vault installProjects accepts (memory.json and a system/memory.mjs) and an empty home. */
function setup(config = {}) {
  const root = bareRoot('en', config);
  put(path.join(root, 'system', 'memory.mjs'), '// the vault CLI\n');
  const home = tmpDir('home');
  return { root, home, claude: path.join(home, '.claude', 'settings.json'), codex: path.join(home, '.codex', 'hooks.json') };
}

const install = (s, { io, ...opts } = {}) => installProjects(s.root, { agent: 'claude-code', env: {}, home: s.home, t: null, ...opts, io: fakeIO(io) });
const projectsOf = (root) => json(path.join(root, 'memory.json')).projects;

/** The result of an install that must be refused: it throws ProjectsRefused, whose result has exit 1. */
async function refusedBy(promise) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProjectsRefused, `refused with ProjectsRefused, got ${caught?.stack ?? 'no error'}`);
  assert.deepEqual([caught.result.action, caught.result.ok, caught.result.exit, caught.exit], ['refused', false, 1, 1]);
  assert.equal(caught.error, caught.result.error);
  assert.equal(caught.message, caught.fix ? `${caught.error}; fix: ${caught.fix}` : caught.error);
  return caught.result;
}

// ---------------------------------------------------------------------------------------------
// The command strings

describe('the shell form', () => {
  test('macOS and Linux: node bare, the script in double quotes', () => {
    const script = hookScript('/home/jan/Jan Novák/my memory', 'linux');
    assert.equal(script, '/home/jan/Jan Novák/my memory/system/memory.mjs');
    assert.equal(shellCommand('node', script, 'claude-code', 'session-start'), 'node "/home/jan/Jan Novák/my memory/system/memory.mjs" hook claude-code session-start');
  });

  test('Windows: forward slashes, spaces and diacritics inside the quotes', () => {
    const script = hookScript('C:\\Users\\Jan Novák\\Moje paměť', 'win32');
    assert.equal(script, 'C:/Users/Jan Novák/Moje paměť/system/memory.mjs');
    assert.equal(shellCommand('node', script, 'codex', 'stop'), 'node "C:/Users/Jan Novák/Moje paměť/system/memory.mjs" hook codex stop');
  });

  test('characters no shell passes on safely are named', () => {
    assert.deepEqual(unsafeChars('/home/jan/memory', 'linux'), []);
    assert.deepEqual(unsafeChars("/home/jan/Jan's (old) memory & more", 'linux'), []);
    assert.deepEqual(unsafeChars('/home/$USER/100% "x"', 'linux'), ['"', '$', '%']);
    assert.deepEqual(unsafeChars('/home/jan/`x`!', 'darwin'), ['`', '!']);
    assert.deepEqual(unsafeChars('/home/jan/a\\b', 'linux'), ['\\'], 'a backslash in a POSIX name');
    assert.deepEqual(unsafeChars('C:/Users/Jan/a\nb', 'win32'), ['\\n']);
    assert.deepEqual(unsafeChars('C:/Users/Jan Novák/paměť', 'win32'), []);
  });

  test('Windows: Czech quotation marks end a PowerShell string, so they are named too', () => {
    assert.deepEqual(unsafeChars('C:/Users/Jan/„Paměť“/system/memory.mjs', 'win32'), ['„', '“']);
    assert.deepEqual(unsafeChars('C:/Users/Jan/Deník “Honza”/system/memory.mjs', 'win32'), ['“', '”']);
    assert.deepEqual(unsafeChars('/home/jan/„Paměť“/system/memory.mjs', 'linux'), [], 'sh reads them as letters');
    const node = chooseNode({ platform: 'win32', execPath: 'C:\\nodejs\\node.exe' });
    const script = 'C:/Users/Jan/„Paměť“/system/memory.mjs';
    const refused = planForm({ agent: 'claude-code', platform: 'win32', script, min: null, node });
    assert.equal(refused.refused.key, 'connect.projects.refused.unsafe_path');
    assert.equal(refused.refused.vars.chars, '„ “');
    assert.equal(planForm({ agent: 'claude-code', platform: 'win32', script, min: '2.1.200', node }).form, 'exec');
  });
});

describe('which node a hook starts', () => {
  test('the Node.js running connect by its full path, even when node on the PATH is new enough', () => {
    // A repository can pin another node on the PATH (nvm use, fnm, volta, mise, asdf): its hooks
    // must still start the Node.js connect ran on.
    const posix = chooseNode({ platform: 'linux', pathVersion: '22.5.0', execPath: '/opt/node/bin/node', execVersion: '22.9.0' });
    assert.deepEqual([posix.word, posix.exe, posix.via, posix.pathOk, posix.old], ['"/opt/node/bin/node"', '/opt/node/bin/node', 'absolute', true, false]);
    const win = chooseNode({ platform: 'win32', pathVersion: '24.1.0', execPath: 'C:\\Program Files\\nodejs\\node.exe', shortPath: () => 'C:\\PROGRA~1\\nodejs\\node.exe' });
    assert.deepEqual([win.word, win.via], ['C:/PROGRA~1/nodejs/node.exe', 'short']);
    assert.equal(chooseNode({ platform: 'linux', execPath: '/opt/node/bin/node', execVersion: '22.1.0' }).old, true, 'older than the kit needs');
  });

  test('macOS and Linux: the absolute path in double quotes', () => {
    const n = chooseNode({ platform: 'darwin', pathVersion: '20.11.0', execPath: '/Users/jan/.nvm/versions/node/v22.9.0/bin/node' });
    assert.equal(n.word, '"/Users/jan/.nvm/versions/node/v22.9.0/bin/node"');
    assert.equal(n.via, 'absolute');
    assert.deepEqual([chooseNode({ platform: 'linux', pathVersion: null, execPath: '/opt/$x/node' }).word, chooseNode({ platform: 'linux', execPath: '/opt/$x/node' }).bad], [null, ['$']]);
  });

  test('the path hooks keep: a Homebrew link instead of the Cellar (Linuxbrew too), snap\'s current revision, the real folder behind an fnm multishell', () => {
    const real = { 'C:\\Users\\jan\\AppData\\Local\\fnm_multishells\\123_456\\node.exe': 'C:\\Users\\jan\\AppData\\Roaming\\fnm\\node-versions\\v22.9.0\\installation\\node.exe' };
    const realpath = (p) => real[p] ?? null;
    assert.equal(hookNodePath('C:\\Users\\jan\\AppData\\Local\\fnm_multishells\\123_456\\node.exe', { platform: 'win32', realpath }), 'C:\\Users\\jan\\AppData\\Roaming\\fnm\\node-versions\\v22.9.0\\installation\\node.exe');
    assert.equal(hookNodePath('C:\\Program Files\\nodejs\\node.exe', { platform: 'win32', realpath }), 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(hookNodePath('/home/jan/.nvm/versions/node/v22.9.0/bin/node', { platform: 'linux', realpath }), '/home/jan/.nvm/versions/node/v22.9.0/bin/node');
    // Linuxbrew (brew upgrade) and snap (automatic refresh) delete the versioned folder by themselves.
    const stable = { '/home/linuxbrew/.linuxbrew/bin/node': '/home/linuxbrew/.linuxbrew/Cellar/node/24.1.0/bin/node', '/snap/node/current/bin/node': '/snap/node/10245/bin/node' };
    const linked = (p) => stable[p] ?? null;
    assert.equal(hookNodePath('/home/linuxbrew/.linuxbrew/Cellar/node/24.1.0/bin/node', { platform: 'linux', realpath: linked }), '/home/linuxbrew/.linuxbrew/bin/node');
    assert.equal(hookNodePath('/snap/node/10245/bin/node', { platform: 'linux', realpath: linked }), '/snap/node/current/bin/node');
    const plan = planForm({ agent: 'claude-code', platform: 'linux', script: '/v/system/memory.mjs', min: '2.1.282',
      node: chooseNode({ platform: 'linux', execPath: hookNodePath('/snap/node/10245/bin/node', { platform: 'linux', realpath: linked }), execVersion: '22.9.0' }) });
    assert.equal(plan.nodeWord, '"/snap/node/current/bin/node"', 'the hook word names the stable link');
    assert.equal(typeof IO.nodePath(), 'string');
  });

  test('Windows: a bare path, else the 8.3 short name, else none', () => {
    const plain = chooseNode({ platform: 'win32', pathVersion: null, execPath: 'C:\\nodejs\\node.exe' });
    assert.deepEqual([plain.word, plain.via], ['C:/nodejs/node.exe', 'absolute']);
    const spaced = 'C:\\Program Files\\nodejs\\node.exe';
    const short = chooseNode({ platform: 'win32', pathVersion: null, execPath: spaced, shortPath: () => 'C:\\PROGRA~1\\nodejs\\node.exe' });
    assert.deepEqual([short.word, short.via, short.exe], ['C:/PROGRA~1/nodejs/node.exe', 'short', spaced]);
    const none = chooseNode({ platform: 'win32', pathVersion: null, execPath: spaced, shortPath: () => null });
    assert.deepEqual([none.word, none.quoted], [null, '"C:/Program Files/nodejs/node.exe"']);
    // 8.3 names switched off: cmd.exe answers with the long path, which is no bare word either.
    assert.equal(chooseNode({ platform: 'win32', pathVersion: null, execPath: spaced, shortPath: () => spaced }).word, null);
  });
});

describe('the form of the hooks', () => {
  const posixNode = chooseNode({ platform: 'linux', execPath: '/opt/node/bin/node', execVersion: '22.9.0', pathVersion: '22.9.0' });
  const script = '/home/jan/memory/system/memory.mjs';

  test('the shell form by default, on any Claude Code version', () => {
    for (const min of [null, '1.0.90', '2.1.100', '2.1.300']) {
      const plan = planForm({ agent: 'claude-code', platform: 'linux', script, min, node: posixNode });
      assert.deepEqual([plan.form, plan.nodeWord, plan.warnings], ['shell', '"/opt/node/bin/node"', []], String(min));
    }
  });

  test('node from the PATH only when the full path cannot go into a command, with a warning', () => {
    const odd = chooseNode({ platform: 'linux', execPath: '/opt/$node/bin/node', execVersion: '22.9.0', pathVersion: '22.9.0' });
    for (const agent of ['claude-code', 'codex']) {
      const plan = planForm({ agent, platform: 'linux', script, min: '2.1.100', node: odd });
      assert.deepEqual([plan.form, plan.nodeWord, plan.warnings.map((w) => w.key)], ['shell', 'node', ['connect.projects.warn.node_bare']], agent);
    }
    const none = planForm({ agent: 'claude-code', platform: 'linux', script, min: null, node: { ...odd, pathOk: false } });
    assert.deepEqual([none.refused.key, none.refused.vars.chars], ['connect.projects.refused.unsafe_node', '$']);
    const old = planForm({ agent: 'claude-code', platform: 'linux', script, node: chooseNode({ platform: 'linux', execPath: '/opt/node/bin/node', execVersion: '22.1.0' }) });
    assert.deepEqual(old.warnings, [{ key: 'connect.projects.warn.node_old', vars: { node: '/opt/node/bin/node', version: '22.1.0', need: '22.5.0' } }]);
  });

  test('--form exec is kept, with a warning when a version here cannot run it', () => {
    const at = (min) => planForm({ agent: 'claude-code', platform: 'linux', script, requested: 'exec', min, node: posixNode });
    assert.deepEqual([at('2.1.139').form, at('2.1.139').warnings], ['exec', []]);
    assert.deepEqual(at(null).warnings.map((w) => w.key), ['connect.projects.warn.exec_unknown']);
    assert.deepEqual(at('2.1.138').warnings, [{ key: 'connect.projects.warn.exec_old', vars: { version: '2.1.138' } }]);
  });

  test('a vault path no shell passes on: exec when every version allows it, else refused', () => {
    const bad = '/home/jan/100% $x/system/memory.mjs';
    const ok = planForm({ agent: 'claude-code', platform: 'linux', script: bad, min: '2.1.150', node: posixNode });
    assert.equal(ok.form, 'exec');
    assert.equal(ok.warnings[0].key, 'connect.projects.warn.exec_path');
    for (const min of [null, '2.1.138']) {
      const no = planForm({ agent: 'claude-code', platform: 'linux', script: bad, min, node: posixNode });
      assert.equal(no.refused.key, 'connect.projects.refused.unsafe_path');
      assert.equal(no.refused.fixKey, 'connect.projects.refused.unsafe_path_claude_fix');
      assert.equal(no.refused.vars.chars, '$ %');
    }
    const codex = planForm({ agent: 'codex', platform: 'win32', script: 'C:/Users/100%/system/memory.mjs', min: '0.140.0', node: posixNode });
    assert.equal(codex.refused.fixKey, 'connect.projects.refused.unsafe_path_fix');
  });

  test('Windows: a node path with spaces and no short name', () => {
    const node = chooseNode({ platform: 'win32', pathVersion: null, execPath: 'C:\\Program Files\\nodejs\\node.exe' });
    const exec = planForm({ agent: 'claude-code', platform: 'win32', script: 'C:/m/system/memory.mjs', min: '2.1.200', node });
    assert.deepEqual([exec.form, exec.exe, exec.warnings[0].key], ['exec', 'C:\\Program Files\\nodejs\\node.exe', 'connect.projects.warn.exec_node']);
    const bare = planForm({ agent: 'claude-code', platform: 'win32', script: 'C:/m/system/memory.mjs', min: '2.1.100', node: { ...node, pathOk: true } });
    assert.deepEqual([bare.nodeWord, bare.warnings.map((w) => w.key)], ['node', ['connect.projects.warn.node_bare']], 'every shell reads it');
    const quoted = planForm({ agent: 'claude-code', platform: 'win32', script: 'C:/m/system/memory.mjs', min: '2.1.100', node });
    assert.equal(quoted.form, 'shell');
    assert.equal(quoted.nodeWord, '"C:/Program Files/nodejs/node.exe"');
    assert.ok(quoted.warnings.some((w) => w.key === 'connect.projects.warn.node_quoted'));
    // cmd.exe (Codex) reads a quoted program path, so the full path wins over node on the PATH.
    const codex = planForm({ agent: 'codex', platform: 'win32', script: 'C:/m/system/memory.mjs', min: '0.140.0', node: { ...node, pathOk: true } });
    assert.equal(codex.nodeWord, '"C:/Program Files/nodejs/node.exe"');
    assert.deepEqual(codex.warnings, []);
  });

  test('Codex has only the shell form', () => {
    const plan = planForm({ agent: 'codex', platform: 'linux', script, requested: 'exec', min: '0.140.0', node: posixNode });
    assert.equal(plan.form, 'shell');
    assert.deepEqual(plan.warnings.map((w) => w.key), ['connect.projects.warn.codex_exec']);
  });
});

describe('events by version', () => {
  test('PostToolUseFailure only when every Claude Code seen is 2.1.101 or newer', () => {
    const names = (min) => eventsFor('claude-code', min, { autosync: true }).events.map(([n]) => n);
    assert.deepEqual(names('2.1.101'), ['SessionStart', 'Stop', 'PostToolUseFailure', 'SessionEnd']);
    assert.deepEqual(names('2.2.0'), ['SessionStart', 'Stop', 'PostToolUseFailure', 'SessionEnd']);
    for (const min of [null, '2.1.100', '2.0.56', '1.0.90']) {
      assert.deepEqual(names(min), ['SessionStart', 'Stop', 'SessionEnd'], String(min));
      assert.deepEqual(eventsFor('claude-code', min).omitted, ['PostToolUseFailure']);
    }
    assert.deepEqual(eventsFor('codex', null, { autosync: true }).events.map(([n]) => n), ['SessionStart', 'Stop', 'SessionEnd']);
  });

  test('SessionEnd only with autosync, its only work (the agent waits for it on every exit)', () => {
    assert.deepEqual(eventsFor('claude-code', '2.1.200').events.map(([n]) => n), ['SessionStart', 'Stop', 'PostToolUseFailure']);
    assert.deepEqual(eventsFor('claude-code', '2.1.200', { autosync: false }).omitted, []);
    assert.deepEqual(eventsFor('codex', null).events.map(([n]) => n), ['SessionStart', 'Stop']);
  });

  test('matchers and timeouts', () => {
    const groups = hookGroups('claude-code', EVENTS['claude-code'], { form: 'shell', nodeWord: 'node' }, { script: '/v/system/memory.mjs', platform: 'linux' });
    assert.equal(groups.SessionStart.matcher, 'startup|resume|clear|compact|fork', 'a forked session (2.1.214+) gets its brief too');
    assert.equal(groups.PostToolUseFailure.matcher, 'Bash|PowerShell');
    assert.equal(groups.Stop.matcher, undefined);
    assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.hooks[0].timeout])), { SessionStart: 20, Stop: 10, PostToolUseFailure: 5, SessionEnd: 5 });
    assert.ok(EVENTS.codex.every(([, , , timeout]) => timeout <= 20) && EVENTS.codex.find(([n]) => n === 'SessionEnd')[3] <= 3);
  });

  test('entries: exec form, and Codex with commandWindows on Windows only', () => {
    assert.deepEqual(hookHandler('claude-code', 'stop', 10, { form: 'exec', exe: 'node' }, { script: '/v/system/memory.mjs' }),
      { type: 'command', command: 'node', args: ['/v/system/memory.mjs', 'hook', 'claude-code', 'stop'], timeout: 10 });
    assert.deepEqual(hookHandler('codex', 'stop', 10, { form: 'shell', nodeWord: 'node' }, { script: '/v/system/memory.mjs', platform: 'linux' }),
      { type: 'command', command: 'node "/v/system/memory.mjs" hook codex stop', timeout: 10 });
    const win = hookHandler('codex', 'stop', 10, { form: 'shell', nodeWord: 'node' }, { script: 'C:/Users/Jan Novák/m/system/memory.mjs', platform: 'win32' });
    assert.equal(win.command, 'node "C:/Users/Jan Novák/m/system/memory.mjs" hook codex stop');
    assert.equal(win.commandWindows, win.command);
  });
});

// ---------------------------------------------------------------------------------------------
// Versions

describe('versions', () => {
  test('parse and compare', () => {
    assert.equal(parseVersion('2.1.282 (Claude Code)'), '2.1.282');
    assert.equal(parseVersion('codex-cli 0.124.0\n'), '0.124.0');
    assert.equal(parseVersion('nothing'), null);
    assert.equal(cmpVersion('2.1.100', '2.1.101'), -1);
    assert.equal(cmpVersion('2.10.0', '2.9.9'), 1);
    assert.equal(minVersion(['2.1.200', 'x', '2.1.99', '2.1.150']), '2.1.99');
    assert.equal(maxVersion(['2.1.200', '2.1.99']), '2.1.200');
    assert.equal(minVersion([]), null);
  });

  test('`claude --version`: directly on macOS and Linux, through cmd.exe on Windows', () => {
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, verbatim: options.windowsVerbatimArguments === true, timeout: options.timeout, hide: options.windowsHide });
      return { status: 0, stdout: '2.1.282 (Claude Code)\n' };
    };
    assert.equal(cliVersion('claude', { platform: 'linux', env: {}, run }), '2.1.282');
    assert.equal(cliVersion('claude', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, run }), '2.1.282');
    assert.deepEqual(calls[0], { command: 'claude', args: ['--version'], verbatim: false, timeout: 5000, hide: true });
    assert.deepEqual(calls[1], { command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', '"claude --version"'], verbatim: true, timeout: 5000, hide: true });
    assert.equal(cliVersion('claude', { platform: 'linux', env: {}, run: () => ({ status: 1, stdout: '' }) }), null);
    assert.equal(cliVersion('claude', { platform: 'linux', env: {}, run: () => ({ error: new Error('ENOENT') }) }), null);
    assert.equal(cliVersion('claude', { platform: 'linux', env: {}, run: () => { throw new Error('EINVAL'); } }), null);
  });

  test('the newest extension of every VS Code-family editor', () => {
    const home = tmpDir('ext-home');
    for (const dir of ['.vscode/extensions/anthropic.claude-code-2.1.120-linux-x64', '.vscode/extensions/anthropic.claude-code-2.1.140-linux-x64',
      '.vscode/extensions/ms-python.python-2026.1.0', '.cursor/extensions/anthropic.claude-code-2.1.99', '.windsurf/extensions/other']) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
    }
    assert.deepEqual(extensionVersions(home), [
      { source: 'extension', editor: 'VS Code', version: '2.1.140' },
      { source: 'extension', editor: 'Cursor', version: '2.1.99' },
    ]);
    assert.deepEqual(extensionVersions(tmpDir('empty-home')), []);
  });

  test('transcripts: the last version line of the newest few, read from their end only', () => {
    const dir = tmpDir('claude-config');
    const line = (o) => `${JSON.stringify(o)}\n`;
    const pad = line({ type: 'assistant', message: { content: 'x'.repeat(1000) } }).repeat(400); // about 400 KB
    const at = (rel, text, secondsAgo) => {
      const file = put(path.join(dir, 'projects', ...rel.split('/')), text);
      const t = new Date(Date.now() - secondsAgo * 1000);
      fs.utimesSync(file, t, t);
    };
    // The version line near the end wins; a line in a tool result ("version" nested) does not count.
    at('-home-jan-shop/a.jsonl', line({ version: '2.1.50' }) + pad + line({ version: '2.1.150', entrypoint: 'cli' }) + line({ type: 'x', payload: { version: '9.9.9' } }), 10);
    // Only at the start of a big file: beyond the bounded read.
    at('-home-jan-shop/b.jsonl', line({ version: '2.0.10' }) + pad, 20);
    at('-home-jan-web/c.jsonl', line({ version: '2.1.160', entrypoint: 'claude-vscode' }), 30);
    at('-home-jan-web/d.jsonl', `${line({ version: '2.1.150', entrypoint: 'claude-vscode' })}{"torn`, 40);
    at('-home-jan-web/e.jsonl', line({ version: '2.1.170' }), 50);
    at('-home-jan-web/f.jsonl', line({ version: '1.0.1' }), 60); // the sixth newest: not read
    at('-home-jan-web/sub/g.jsonl', line({ version: '1.0.2' }), 5); // a subagent transcript: not a session
    assert.deepEqual(transcriptVersions(dir), [
      { source: 'sessions', version: '2.1.170', entrypoints: [] },
      { source: 'sessions', version: '2.1.160', entrypoints: ['claude-vscode'] },
      { source: 'sessions', version: '2.1.150', entrypoints: ['cli', 'claude-vscode'] },
    ]);
    assert.deepEqual(transcriptVersions(tmpDir('no-config')), []);
  });

  test('claudeVersions: all three sources, CLAUDE_CONFIG_DIR, and the oldest', () => {
    const home = tmpDir('cv-home');
    fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'anthropic.claude-code-2.1.130-win32-x64'), { recursive: true });
    const config = tmpDir('cv-config');
    put(path.join(config, 'projects', 'p', 's.jsonl'), `${JSON.stringify({ version: '2.1.140', entrypoint: 'cli' })}\n`);
    put(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), `${JSON.stringify({ version: '1.0.0' })}\n`); // not used: CLAUDE_CONFIG_DIR wins
    const run = () => ({ status: 0, stdout: '2.1.150 (Claude Code)' });
    const seen = claudeVersions({ env: { CLAUDE_CONFIG_DIR: config }, home, platform: 'linux', run });
    assert.deepEqual(seen.observed.map((o) => `${o.source}:${o.version}`), ['cli:2.1.150', 'extension:2.1.130', 'sessions:2.1.140']);
    assert.equal(seen.min, '2.1.130');
    assert.equal(claudeVersions({ env: {}, home: tmpDir('none'), platform: 'linux', run: () => ({ status: 1 }) }).min, null);
  });

  test('codexInfo: the version and a config.toml that turns hooks off', () => {
    const home = tmpDir('codex-home');
    const run = () => ({ status: 0, stdout: 'codex-cli 0.123.0\n' });
    assert.deepEqual(codexInfo({ env: {}, home, platform: 'linux', run }), { observed: [{ source: 'cli', version: '0.123.0' }], min: '0.123.0', off: null });
    const config = put(path.join(home, '.codex', 'config.toml'), 'model = "x"\n\n[features]\ncodex_hooks = false\n');
    assert.deepEqual(codexInfo({ env: {}, home, platform: 'linux', run }).off, { path: config, key: 'codex_hooks' });
    put(config, 'features.hooks = false\n');
    assert.equal(codexInfo({ env: {}, home, platform: 'linux', run }).off.key, 'hooks');
    put(config, '[features]\nhooks = true\n');
    assert.equal(codexInfo({ env: {}, home, platform: 'linux', run }).off, null);
    const other = tmpDir('codex-home-env');
    put(path.join(other, 'config.toml'), '[features]\nhooks = false\n');
    assert.equal(codexInfo({ env: { CODEX_HOME: other }, home, platform: 'linux', run }).off.path, path.join(other, 'config.toml'));
  });

  test('newestSessionStart reads the first timestamp of the newest transcripts', () => {
    const home = tmpDir('sessions-home');
    put(path.join(home, '.claude', 'projects', 'p', 'a.jsonl'), '{"type":"summary"}\n{"timestamp":"2026-09-20T10:00:00.000Z","version":"2.1.200"}\n');
    put(path.join(home, '.claude', 'projects', 'q', 'b.jsonl'), '{"timestamp":"2026-09-22T08:30:00.000Z"}\n');
    assert.equal(newestSessionStart('claude-code', { env: {}, home, platform: 'linux' }), Date.parse('2026-09-22T08:30:00.000Z'));
    put(path.join(home, '.codex', 'sessions', '2026', '09', '24', 'rollout-2026-09-24T09-00-00-abc.jsonl'), '{"timestamp":"2026-09-24T09:00:00.000Z","type":"session_meta"}\n');
    assert.equal(newestSessionStart('codex', { env: {}, home, platform: 'linux' }), Date.parse('2026-09-24T09:00:00.000Z'));
    assert.equal(newestSessionStart('codex', { env: {}, home: tmpDir('nothing'), platform: 'linux' }), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// The settings object

describe('planHooks', () => {
  const plan = { form: 'shell', nodeWord: 'node' };
  const groupsFor = (script, events = EVENTS['claude-code']) => hookGroups('claude-code', events, plan, { script, platform: 'linux' });
  const ours = groupsFor('/v/system/memory.mjs');
  const foreignStop = { hooks: [{ type: 'command', command: 'echo done' }] };
  const vaultStart = { matcher: 'startup', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/system/memory.mjs" start' }] };

  test('adds ours once, keeps every foreign key and hook, and is idempotent', () => {
    const settings = { model: 'opus', env: { A: '1' }, hooks: { Stop: [foreignStop], SessionStart: [vaultStart] }, permissions: { allow: ['Bash(ls)'] } };
    const once = planHooks(settings, 'claude-code', { groups: ours });
    assert.deepEqual(planHooks(once, 'claude-code', { groups: ours }), once);
    assert.deepEqual(Object.keys(once), ['model', 'env', 'hooks', 'permissions']);
    assert.deepEqual(once.hooks.Stop, [foreignStop, ours.Stop]);
    assert.deepEqual(once.hooks.SessionStart, [vaultStart, ours.SessionStart], 'the vault project hook is not ours');
    assert.deepEqual(Object.keys(once.hooks), ['Stop', 'SessionStart', 'PostToolUseFailure', 'SessionEnd']);
    assert.deepEqual(settings.hooks.Stop, [foreignStop], 'the input is not changed');
  });

  test('our group keeps its place when it changes, and foreign groups after it stay after it', () => {
    const settings = { hooks: { Stop: [ours.Stop, foreignStop] } };
    const moved = groupsFor('/w/system/memory.mjs');
    const next = planHooks(settings, 'claude-code', { groups: moved });
    assert.deepEqual(next.hooks.Stop, [moved.Stop, foreignStop]);
  });

  test('a group shared with a foreign hook keeps it; old exec-form entries are replaced', () => {
    const oldExec = { type: 'command', command: '/usr/bin/node', args: ['/v/system/memory.mjs', 'hook', 'claude-code', 'stop'] };
    const shared = { hooks: [{ type: 'command', command: 'echo a' }, oldExec] };
    const next = planHooks({ hooks: { Stop: [shared] } }, 'claude-code', { groups: ours });
    assert.deepEqual(next.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo a' }] }, ours.Stop]);
  });

  test('without PostToolUseFailure an old entry of it goes away', () => {
    const all = planHooks({}, 'claude-code', { groups: ours });
    const fewer = groupsFor('/v/system/memory.mjs', eventsFor('claude-code', null).events);
    assert.equal(planHooks(all, 'claude-code', { groups: fewer }).hooks.PostToolUseFailure, undefined);
  });

  test('remove takes out only ours and gives back the file it found', () => {
    const settings = { hooks: { Stop: [foreignStop] }, theme: 'dark' };
    const added = planHooks(settings, 'claude-code', { groups: ours });
    assert.deepEqual(planHooks(added, 'claude-code', { remove: true }), settings);
    assert.deepEqual(planHooks(planHooks({}, 'claude-code', { groups: ours }), 'claude-code', { remove: true }), {});
    assert.deepEqual(planHooks({ hooks: {} }, 'claude-code', { remove: true }), { hooks: {} }, 'an empty hooks object of the owner stays');
    assert.deepEqual(planHooks({ hooks: { Stop: [] } }, 'claude-code', { groups: {} }), { hooks: { Stop: [] } });
  });

  test('Codex hooks of this agent only; Claude Code entries in the same file stay', () => {
    const claude = ours.Stop;
    const codex = hookGroups('codex', EVENTS.codex, plan, { script: '/v/system/memory.mjs', platform: 'linux' });
    const next = planHooks({ hooks: { Stop: [claude] } }, 'codex', { groups: codex });
    assert.deepEqual(next.hooks.Stop, [claude, codex.Stop]);
  });

  test('isOurs, parseHandler and ourHooks', () => {
    const shell = ours.SessionStart.hooks[0];
    assert.ok(isOurs(shell, 'claude-code'));
    assert.ok(!isOurs(shell, 'codex'));
    assert.ok(!isOurs(vaultStart.hooks[0], 'claude-code'));
    assert.ok(!isOurs({ command: 'echo hook claude-code' }, 'claude-code'));
    assert.deepEqual(parseHandler(shell), { form: 'shell', node: 'node', script: '/v/system/memory.mjs', agent: 'claude-code', event: 'session-start' });
    assert.deepEqual(parseHandler({ command: '"C:/Program Files/nodejs/node.exe" "C:/Users/Jan Novák/m/system/memory.mjs" hook codex stop' }),
      { form: 'shell', node: 'C:/Program Files/nodejs/node.exe', script: 'C:/Users/Jan Novák/m/system/memory.mjs', agent: 'codex', event: 'stop' });
    assert.deepEqual(parseHandler({ command: 'node', args: ['/v/system/memory.mjs', 'hook', 'claude-code', 'stop'] }),
      { form: 'exec', node: 'node', script: '/v/system/memory.mjs', agent: 'claude-code', event: 'stop' });
    assert.equal(parseHandler({ command: 'echo x' }), null);
    const found = ourHooks(planHooks({ hooks: { Stop: [foreignStop] } }, 'claude-code', { groups: ours }), 'claude-code');
    assert.deepEqual(found.map((h) => h.name), ['Stop', 'SessionStart', 'PostToolUseFailure', 'SessionEnd']);
  });
});

describe('memory.json "projects"', () => {
  test('safe defaults: nothing added, stored in git or pushed by itself', () => {
    assert.deepEqual(SAFE_DEFAULTS, { auto_add: false, store: 'local', autosync: false });
    assert.deepEqual(nextProjects(undefined, {}), { enabled: true, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true });
  });

  test('a run without choices keeps the earlier ones and every other key', () => {
    const prev = { auto_add: true, store: 'git', autosync: true, checkpoint: false, repos: { 'github.com/acme/shop': 'dev' }, extra: 1 };
    assert.deepEqual(nextProjects(prev, {}), { enabled: true, auto_add: true, store: 'git', autosync: true, checkpoint: false, error_lookup: true, repos: { 'github.com/acme/shop': 'dev' }, extra: 1 });
    assert.deepEqual(nextProjects(prev, { autoAdd: false, store: 'local' }).auto_add, false);
    assert.equal(nextProjects(prev, { store: 'local' }).store, 'local');
    assert.equal(nextProjects({ store: 'cloud', auto_add: 'yes' }, {}).store, 'local', 'an invalid value falls back');
    assert.equal(nextProjects({ auto_add: 'yes' }, {}).auto_add, false);
  });

  test('remove turns only enabled off, and leaves alone what was not on', () => {
    const prev = { enabled: true, auto_add: true, store: 'git', autosync: true };
    assert.deepEqual(removedProjects(prev), { enabled: false, auto_add: true, store: 'git', autosync: true });
    assert.equal(removedProjects(prev, { keepEnabled: true }), prev);
    const off = { enabled: false, auto_add: true };
    assert.equal(removedProjects(off), off);
    assert.equal(removedProjects(undefined), null);
    assert.equal(removedProjects('x'), null);
  });

  test('the local root: the one in memory.json, else ../<vault>-private', () => {
    const base = tmpDir('lr');
    const root = path.join(base, 'Moje paměť');
    assert.deepEqual(localRootOf(root, {}), { path: path.join(base, 'Moje paměť-private'), exists: false, configured: false });
    fs.mkdirSync(path.join(base, 'soukrome'));
    const raw = { roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'p', path: '../soukrome', privacy: 'local' }] };
    assert.deepEqual(localRootOf(root, raw), { path: path.join(base, 'soukrome'), exists: true, configured: true });
  });
});

// ---------------------------------------------------------------------------------------------
// installProjects

describe('installProjects', () => {
  test('a first run: the settings file, memory.json with the safe defaults, no printing', async () => {
    const s = setup();
    const before = json(path.join(s.root, 'memory.json'));
    const res = await install(s);
    assert.equal(res.exit, 0);
    assert.equal(res.action, 'installed');
    assert.equal(res.file, s.claude);
    assert.equal(res.changed, true);
    assert.equal(res.backup, null, 'a new file has nothing to back up');
    assert.equal(res.form, 'shell');
    assert.deepEqual(res.events, ['SessionStart', 'Stop', 'PostToolUseFailure'], 'no SessionEnd without autosync');
    assert.equal(res.command, `${NODE_WORD} "${hookScript(s.root)}" hook claude-code session-start`);
    assert.equal(res.node, FAKE_NODE);
    assert.deepEqual(res.defaults, { auto_add: true, store: true, autosync: true });
    assert.deepEqual(res.warnings, []);
    const settings = json(s.claude);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, res.command);
    assert.ok(read(s.claude).endsWith('}\n'));
    const after = json(path.join(s.root, 'memory.json'));
    assert.deepEqual(after.projects, { enabled: true, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true });
    const { projects, ...rest } = after;
    assert.deepEqual(rest, before, 'every other key of memory.json stays');
    assert.deepEqual(Object.keys(after), [...Object.keys(before), 'projects']);
    assert.ok(!fs.existsSync(res.localRoot.path), 'the local root is not made here');
    assert.deepEqual(res.localRoot, { path: path.join(path.dirname(s.root), 'vault-private'), exists: false, configured: false });
  });

  test('a second run changes nothing and makes no backup', async () => {
    const s = setup();
    await install(s);
    const text = read(s.claude);
    const memory = read(path.join(s.root, 'memory.json'));
    const res = await install(s);
    assert.deepEqual([res.action, res.changed, res.backup, res.memoryChanged], ['unchanged', false, null, false]);
    assert.equal(read(s.claude), text);
    assert.equal(read(path.join(s.root, 'memory.json')), memory);
    assert.ok(!fs.existsSync(path.join(s.root, '.memory-kit')));
  });

  test('choices stick until changed; other keys of "projects" stay', async () => {
    const s = setup({ projects: { repos: { 'github.com/acme/shop': 'dev' }, checkpoint: false } });
    let res = await install(s, { autoAdd: true, store: 'git' });
    assert.deepEqual(res.defaults, { auto_add: false, store: false, autosync: true });
    res = await install(s);
    assert.deepEqual(projectsOf(s.root), { enabled: true, auto_add: true, store: 'git', autosync: false, checkpoint: false, error_lookup: true, repos: { 'github.com/acme/shop': 'dev' } });
    await install(s, { autoAdd: false });
    assert.equal(projectsOf(s.root).auto_add, false);
    assert.equal(projectsOf(s.root).store, 'git');
  });

  test('--autosync: refused without a remote or in mode local, kept with a warning', async () => {
    const s = setup();
    const res = await refusedBy(install(s, { autosync: true }));
    assert.match(res.error, /--autosync needs a git remote/);
    assert.match(res.fix, /git remote add origin/);
    assert.ok(!fs.existsSync(s.claude), 'nothing written');
    assert.equal(projectsOf(s.root), undefined);
    assert.equal(res.settings, null, 'the settings memory.json holds, not the refused ones');

    const local = setup({ mode: 'local', projects: { enabled: true, auto_add: true } });
    const r2 = await refusedBy(install(local, { autosync: true, io: { hasRemote: () => true } }));
    assert.match(r2.error, /"mode" is local/);
    assert.deepEqual(r2.settings, { enabled: true, auto_add: true });

    const ok = await install(s, { autosync: true, io: { hasRemote: () => true } });
    assert.equal(ok.exit, 0);
    assert.equal(projectsOf(s.root).autosync, true);
    assert.deepEqual(ok.events, ['SessionStart', 'Stop', 'PostToolUseFailure', 'SessionEnd'], 'SessionEnd starts the autosync');
    const kept = await install(s);
    assert.equal(kept.exit, 0);
    assert.match(kept.warnings.join('\n'), /no git remote/);
    const off = await install(s, { autosync: false });
    assert.deepEqual([off.action, off.events.includes('SessionEnd')], ['updated', false]);
    assert.equal(json(s.claude).hooks.SessionEnd, undefined, 'the SessionEnd hook goes with autosync');
  });

  test('a refusal throws, and the wizard reads it as a failure with its fix', async () => {
    const base = tmpDir('refused');
    const root = path.join(base, 'Důležité!');
    fs.cpSync(bareRoot('en'), root, { recursive: true });
    put(path.join(root, 'system', 'memory.mjs'), '// cli\n');
    const home = tmpDir('home');
    let caught = null;
    try {
      await install({ root, home }, { autoAdd: false, store: 'local', autosync: false, io: { claudeVersions: () => ({ observed: [], min: null }) } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ProjectsRefused, 'thrown, not returned as "unchanged"');
    assert.match(caught.message, /^the memory path .*Důležité!.* contains !, .*; fix: move the memory to a folder/);
    assert.equal(caught.result.changed, false);
    assert.equal(caught.result.settings, null, 'memory.json has no projects: nothing was saved');
    assert.equal(projectsOf(root), undefined);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
    assert.match(formatInstall(caught.result, null)[0], /^memory: the memory path/);
  });

  test('an existing file: foreign content kept, a private backup, its style kept', async () => {
    const s = setup();
    const original = `{\n    "model": "opus",\n    "hooks": {\n        "Stop": [{ "hooks": [{ "type": "command", "command": "echo done" }] }]\n    }\n}\n`;
    put(s.claude, original);
    const res = await install(s, { now: new Date(2026, 8, 25, 10, 4, 5) });
    assert.equal(res.action, 'installed');
    assert.equal(path.basename(res.backup), 'claude-code-hooks-20260925-100405.json');
    assert.equal(path.dirname(res.backup), path.join(s.root, '.memory-kit', 'backups', 'connect'));
    assert.equal(read(res.backup), original);
    if (!IS_WIN) assert.equal(fs.statSync(res.backup).mode & 0o777, 0o600);
    const text = read(s.claude);
    assert.match(text, /^\{\n {4}"model": "opus",\n/, 'four spaces, as the file had');
    const settings = JSON.parse(text);
    assert.equal(settings.model, 'opus');
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo done');
    assert.equal(settings.hooks.Stop.length, 2);
  });

  test('a file that is not plain JSON is never rewritten; the snippet comes back', async () => {
    const s = setup();
    const text = '{\n  // my settings\n  "model": "opus"\n}\n';
    put(s.claude, text);
    const res = await refusedBy(install(s));
    assert.match(res.error, /is not plain JSON/);
    assert.match(res.fix, /connect claude-code --projects --dry-run prints/);
    assert.deepEqual(Object.keys(JSON.parse(res.snippet).hooks), ['SessionStart', 'Stop', 'PostToolUseFailure']);
    // The snippet has the layout of the settings file (each event a list of groups), so pasted as
    // it is, it holds exactly the hooks an install writes into an empty file.
    assert.deepEqual(ourHooks(JSON.parse(res.snippet), 'claude-code').map((h) => h.name), ['SessionStart', 'Stop', 'PostToolUseFailure']);
    const home = tmpDir('home');
    await install({ ...s, home });
    assert.deepEqual(JSON.parse(res.snippet), json(path.join(home, '.claude', 'settings.json')));
    assert.equal(read(s.claude), text);
    assert.equal(projectsOf(s.root).enabled, true, 'memory.json is set, so pasted hooks work');
    assert.equal(res.settings.enabled, true, 'the settings that were saved');
    const lines = formatInstall(res, null);
    assert.match(lines[0], /^memory: .* is not plain JSON/);
    assert.ok(lines.includes(res.snippet));
    assert.ok(lines.includes('memory.json "projects" is set, so the hooks work as soon as they are in the file'));
    put(s.claude, '{"hooks": []}');
    const layout = await refusedBy(install(s));
    assert.match(layout.error, /does not have the expected layout/);
    assert.equal(layout.memoryChanged, false, 'memory.json was already set');
  });

  test('remove: our hooks go, enabled turns false, the rest stays; the other agent keeps it on', async () => {
    const s = setup();
    put(s.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, null, 2));
    await install(s, { autoAdd: true });
    const res = await install(s, { remove: true });
    assert.deepEqual([res.action, res.changed], ['removed', true]);
    assert.deepEqual(json(s.claude), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } });
    assert.deepEqual(projectsOf(s.root), { enabled: false, auto_add: true, store: 'local', autosync: false, checkpoint: true, error_lookup: true });
    assert.match(formatInstall(res, null).join('\n'), /enabled is now false/);
    const again = await install(s, { remove: true });
    assert.deepEqual([again.action, again.changed, again.exit], ['absent', false, 0]);

    await install(s);
    await install(s, { agent: 'codex' });
    const kept = await install(s, { remove: true });
    assert.equal(kept.keptBy, 'codex');
    assert.equal(projectsOf(s.root).enabled, true);
  });

  test('remove: Codex hooks of another memory do not keep this one on', async () => {
    const a = setup();
    const b = setup();
    const home = a.home;
    await install({ ...b, home }, { agent: 'codex' });
    await install(a);
    const res = await install(a, { remove: true });
    assert.equal(res.keptBy, undefined);
    assert.equal(projectsOf(a.root).enabled, false);
    assert.match(formatInstall(res, null).join('\n'), /enabled is now false/);
    assert.equal(projectsOf(b.root).enabled, true);
  });

  test('remove on a memory that never had project hooks leaves memory.json alone', async () => {
    const s = setup();
    const before = read(path.join(s.root, 'memory.json'));
    const res = await install(s, { remove: true });
    assert.deepEqual([res.action, res.memoryChanged, res.settings, res.exit], ['absent', false, null, 0]);
    assert.equal(read(path.join(s.root, 'memory.json')), before, 'byte for byte');
    const off = setup({ projects: { enabled: false, auto_add: true } });
    const text = read(path.join(off.root, 'memory.json'));
    assert.equal((await install(off, { remove: true })).memoryChanged, false);
    assert.equal(read(path.join(off.root, 'memory.json')), text);
  });

  test('dry run: the plan without a write', async () => {
    const s = setup();
    const res = await install(s, { dryRun: true });
    assert.deepEqual([res.action, res.changed, res.memoryChanged], ['installed', true, true]);
    assert.ok(!fs.existsSync(s.claude));
    assert.equal(projectsOf(s.root), undefined);
    const lines = formatInstall(res, null);
    assert.match(lines[0], /would install memory hooks/);
    assert.equal(lines.at(-1), 'dry run: nothing was changed');
  });

  test('versions decide the events and warn', async () => {
    const s = setup();
    const unknown = await install(s, { io: { claudeVersions: () => ({ observed: [], min: null }) } });
    assert.deepEqual(unknown.events, ['SessionStart', 'Stop']);
    assert.deepEqual(unknown.omitted, ['PostToolUseFailure']);
    assert.match(unknown.warnings[0], /no Claude Code version was found/);
    const old = await install(s, { io: { claudeVersions: () => ({ observed: [{ source: 'cli', version: '2.1.100' }], min: '2.1.100' }) } });
    assert.match(old.warnings[0], /Claude Code 2\.1\.100 is older than 2\.1\.101/);
    assert.equal(json(s.claude).hooks.PostToolUseFailure, undefined);
  });

  test('a vault path no shell passes on: refused, or the exec form on new versions', async () => {
    const base = tmpDir('unsafe');
    const root = path.join(base, '100% $memory');
    fs.cpSync(bareRoot('en'), root, { recursive: true });
    put(path.join(root, 'system', 'memory.mjs'), '// cli\n');
    const home = tmpDir('home');
    const s = { root, home, claude: path.join(home, '.claude', 'settings.json') };
    const refused = await refusedBy(install(s, { io: { claudeVersions: () => ({ observed: [], min: null }) } }));
    assert.match(refused.error, /contains \$ %/);
    assert.ok(!fs.existsSync(s.claude));
    const exec = await install(s, { io: { claudeVersions: () => ({ observed: [{ source: 'cli', version: '2.1.200' }], min: '2.1.200' }) } });
    assert.equal(exec.form, 'exec');
    assert.deepEqual(json(s.claude).hooks.Stop[0].hooks[0], { type: 'command', command: FAKE_NODE, args: [hookScript(root), 'hook', 'claude-code', 'stop'], timeout: 10 });
    await refusedBy(install(s, { agent: 'codex' })); // Codex has no exec form
  });

  test('Codex: hooks.json, byte for byte the same on a second run, warnings from its version and config', async () => {
    const s = setup();
    const res = await install(s, { agent: 'codex', io: { codexInfo: () => ({ observed: [{ source: 'cli', version: '0.123.0' }], min: '0.123.0', off: { path: '/h/.codex/config.toml', key: 'hooks' } }) } });
    assert.equal(res.file, s.codex);
    const text = read(s.codex);
    const hooks = JSON.parse(text).hooks;
    assert.deepEqual(Object.keys(hooks), ['SessionStart', 'Stop']);
    assert.deepEqual(hooks.Stop, [{ hooks: [{ type: 'command', command: `${NODE_WORD} "${hookScript(s.root)}" hook codex stop`, timeout: 10 }] }]);
    assert.equal(hooks.Stop[0].hooks[0].commandWindows, undefined, 'commandWindows only on Windows');
    assert.match(res.warnings.join('\n'), /Codex 0\.123\.0 runs hooks only with \[features\] hooks = true/);
    assert.match(res.warnings.join('\n'), /turns hooks off \(\[features\] hooks = false\)/);
    await install(s, { agent: 'codex' });
    assert.equal(read(s.codex), text);
    assert.match(formatInstall(res, null).join('\n'), /open \/hooks and trust the memory hooks/);
    await install(s, { agent: 'codex', autosync: true, io: { hasRemote: () => true } });
    const synced = json(s.codex).hooks;
    assert.deepEqual(synced.SessionEnd, [{ hooks: [{ type: 'command', command: `${NODE_WORD} "${hookScript(s.root)}" hook codex session-end`, timeout: 3 }] }]);
    assert.deepEqual([synced.SessionStart, synced.Stop], [hooks.SessionStart, hooks.Stop], 'the other hooks keep their place and text (Codex trust)');
    const win = await install(s, { agent: 'codex', platform: 'win32', io: { codexInfo: () => ({ observed: [{ source: 'cli', version: '0.125.0' }], min: '0.125.0', off: null }) } });
    assert.match(win.warnings.join('\n'), /Codex 0\.125\.0 on Windows reads commandWindows only from 0\.131/);
  });

  test('warnings: disableAllHooks, hooks of another memory, node not on the PATH', async () => {
    const s = setup();
    const other = hookGroups('claude-code', EVENTS['claude-code'], { form: 'shell', nodeWord: 'node' }, { script: '/elsewhere/system/memory.mjs', platform: 'linux' });
    put(s.claude, JSON.stringify({ disableAllHooks: true, hooks: { Stop: [other.Stop] } }));
    const res = await install(s, { io: { nodeOnPath: () => '20.0.0' }, execPath: '/opt/node 22/bin/node', platform: 'linux' });
    const text = res.warnings.join('\n');
    assert.match(text, /"disableAllHooks": true/);
    assert.match(text, /another memory \(\/elsewhere\/system\/memory\.mjs\)/);
    assert.ok(res.command.startsWith('"/opt/node 22/bin/node" "'));
    assert.ok(formatInstall(res, null).includes('  Node.js: /opt/node 22/bin/node, the one running this command; a repository that pins another version does not change it; after removing it, connect again'));
    assert.equal(json(s.claude).hooks.Stop.length, 1, 'the other memory\'s hook was replaced');
  });

  test('a settings file that is a link is edited where it leads', { skip: IS_WIN && 'symlinks need rights on Windows' }, async () => {
    const s = setup();
    const real = put(path.join(tmpDir('dotfiles'), 'claude-settings.json'), '{"model":"opus"}\n');
    fs.mkdirSync(path.dirname(s.claude), { recursive: true });
    fs.symlinkSync(real, s.claude);
    await install(s);
    assert.ok(fs.lstatSync(s.claude).isSymbolicLink());
    assert.equal(json(real).model, 'opus');
    assert.ok(json(real).hooks.SessionStart);
  });

  test('messages: English defaults, a pack translation wins', () => {
    assert.equal(say(null, 'connect.projects.events', { list: 'Stop' }), 'events: Stop');
    assert.equal(say((k) => (k === 'connect.projects.events' ? 'události: {list}'.replace('{list}', 'Stop') : k), 'connect.projects.events', { list: 'Stop' }), 'události: Stop');
    assert.deepEqual(Object.keys(AGENTS), ['claude-code', 'codex']);
  });
});

describe('formatInstall', () => {
  test('a short summary: file, events, form, versions, settings with (default), privacy, next steps', async () => {
    const s = setup();
    const res = await install(s, {
      io: { claudeVersions: () => ({ observed: [{ source: 'cli', version: '2.1.200' }, { source: 'extension', editor: 'VS Code', version: '2.1.190' }, { source: 'sessions', version: '2.1.195', entrypoints: ['cli'] }], min: '2.1.190' }) },
    });
    const lines = formatInstall(res, null);
    assert.equal(lines[0], `Claude Code: memory hooks installed in ${s.claude}`);
    assert.equal(lines[1], '  events: SessionStart, Stop, PostToolUseFailure');
    assert.equal(lines[2], `  form: shell command, ${res.command}`);
    assert.equal(lines[3], `  Node.js: ${FAKE_NODE}, the one running this command; a repository that pins another version does not change it; after removing it, connect again`);
    assert.equal(lines[4], '  Claude Code seen here: 2.1.200 (claude --version), 2.1.190 (VS Code extension), 2.1.195 (recent sessions: cli)');
    assert.equal(lines[5], 'settings in memory.json "projects":');
    assert.equal(lines[6], '  auto_add false (default): a repository gets a memory only when you add it');
    assert.match(lines[7], /^ {2}store {4}local \(default\): dev notes stay on this computer, in .*vault-private \(made with the first project\)$/);
    assert.equal(lines[8], '  autosync false (default): nothing is committed or pushed by itself');
    assert.match(lines[9], /^privacy: the hooks run in every repository you open, so nothing is added/);
    assert.match(lines[10], /^next: start a new Claude Code session/);
    assert.ok(lines[11].startsWith(`next: give a repository its memory: run ${commandNode()} "${res.script}" project add inside it`), lines[11]);
    assert.equal(lines[12], 'next: node system/memory.mjs doctor checks the hooks (line projects.hooks)');
    const on = formatInstall({ ...res, settings: { ...res.settings, auto_add: true, store: 'git' }, defaults: { auto_add: false, store: false, autosync: true } }, null).join('\n');
    assert.match(on, /with --auto-add, --store git on, make sure/);
    assert.doesNotMatch(on, /auto_add true \(default\)/);
  });

  test('in the vault\'s language', async () => {
    const { loadConfig } = await import('../../lib/config.mjs');
    const s = setup();
    const cs = bareRoot('cs');
    const res = await install(s, { t: loadConfig(cs).t });
    const lines = formatInstall(res, loadConfig(cs).t);
    assert.match(lines[0], /^Claude Code: hooky paměti nainstalované v /);
    assert.match(lines.join('\n'), /false \(výchozí\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// The CLI

describe('connect --projects (CLI)', () => {
  let vault;
  before(() => {
    vault = fixtureVault('en').root;
  });
  const env = (home) => ({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' });

  test('usage errors', () => {
    const home = tmpDir('cli-home');
    for (const args of [['--store', 'cloud'], ['--form', 'pipe'], ['--auto-add', '--no-auto-add'], ['--autosync', '--no-autosync'], ['--remove', '--auto-add'], ['--scope', 'user']]) {
      const res = runCli(vault, ['connect', 'claude-code', '--projects', ...args], { env: env(home) });
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.stderr}`);
      assert.match(res.stderr, /usage: node system\/memory\.mjs connect/);
    }
    assert.equal(runCli(vault, ['connect', 'cursor', '--projects'], { env: env(home) }).code, 2);
    assert.equal(runCli(vault, ['connect', '--projects'], { env: env(home) }).code, 2);
    assert.ok(!fs.existsSync(path.join(home, '.claude')));
  });

  test('--json, --autosync without a remote, --dry-run', () => {
    const home = tmpDir('cli-home');
    const dry = runCli(vault, ['connect', 'claude-code', '--projects', '--dry-run'], { env: env(home) });
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /would install memory hooks/);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'settings.json')));
    const refused = runCli(vault, ['connect', 'claude-code', '--projects', '--autosync'], { env: env(home) });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^memory: --autosync needs a git remote/);
    assert.match(refused.stderr, /fix: create a private repository/);
    const res = runCli(vault, ['connect', 'claude-code', '--projects', '--json', '--no-auto-add', '--store', 'local'], { env: env(home) });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.file, path.join(home, '.claude', 'settings.json'));
    assert.deepEqual(out.settings, { enabled: true, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true });
    assert.ok(Array.isArray(out.text) && out.text[0].startsWith('Claude Code: memory hooks installed'));
    assert.equal(json(path.join(vault, 'memory.json')).projects.enabled, true);
  });
});

// ---------------------------------------------------------------------------------------------
// End to end: the generated command reaches the hook unchanged

// A memory.mjs that records what it gets: its arguments and its standard input.
const STUB = `import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const out = fileURLToPath(new URL('../received.json', import.meta.url));
fs.writeFileSync(out, JSON.stringify({ argv: process.argv.slice(2), input: Buffer.concat(chunks).toString('utf8') }));
`;

describe('the command runs through the shells that run hooks', () => {
  const base = tmpDir('e2e');
  const vault = path.join(base, "Jan Novák's paměť (2)");
  put(path.join(vault, 'system', 'memory.mjs'), STUB);
  put(path.join(vault, 'memory.json'), '{}\n');
  const received = path.join(vault, 'received.json');
  const cwd = tmpDir('e2e-cwd');
  const payload = probePayload(cwd);
  // The PATH an IDE gives its hooks has node on it; so does this one.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(path|claude_config_dir|codex_home)$/i.test(k)) delete env[k];
  env.PATH = `${NODE_DIR}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;

  /** The SessionStart entry installProjects writes into a fresh home (never the real one). */
  async function installed(agent, io = {}) {
    const home = tmpDir('e2e-home');
    const res = await installProjects(vault, {
      agent, env: { PATH: env.PATH }, home, t: null,
      io: { claudeVersions: () => ({ observed: [], min: null }), codexInfo: () => ({ observed: [], min: null, off: null }), hasRemote: () => false, ...io },
    });
    assert.equal(res.exit, 0, res.error);
    return json(settingsPath(agent, { env: {}, home })).hooks.SessionStart[0].hooks[0];
  }

  /** Runs one way and checks that the stub got exactly [hook, agent, session-start] and the input. */
  function check(label, agent, run) {
    fs.rmSync(received, { force: true });
    const res = run();
    assert.equal(res.status, 0, `${label}: ${res.error ?? ''} ${res.stderr ?? ''}`);
    const got = json(received);
    assert.deepEqual(got.argv, ['hook', agent, 'session-start'], label);
    assert.equal(got.input, payload, `${label}: the input arrives unchanged`);
  }

  test('POSIX: /bin/sh -c runs the command, whatever node a repository puts first on the PATH', { skip: IS_WIN && 'Windows runs hooks in Git Bash or PowerShell' }, async () => {
    const hook = await installed('claude-code');
    assert.ok(hook.command.startsWith(`"${IO.nodePath()}" "`), hook.command);
    // A repository that pins an old Node.js (nvm use, volta, mise, asdf): its node exits 3 as
    // memory.mjs does on Node.js 20. The hook must not start it.
    const pinned = tmpDir('pinned-node');
    put(path.join(pinned, 'node'), '#!/bin/sh\necho "memory: Node.js 22 or newer is required (this is v20.20.2)" >&2\nexit 3\n');
    fs.chmodSync(path.join(pinned, 'node'), 0o755);
    const old = { ...env, PATH: `${pinned}${path.delimiter}${env.PATH}` };
    assert.equal(spawnSync('/bin/sh', ['-c', 'node --version'], { env: old, encoding: 'utf8' }).status, 3, 'the PATH has the pinned node first');
    check('sh, pinned old node on the PATH', 'claude-code', () => spawnSync('/bin/sh', ['-c', hook.command], { input: payload, env: old, cwd, encoding: 'utf8' }));
    check('sh, no node on the PATH', 'claude-code', () => spawnSync('/bin/sh', ['-c', hook.command], { input: payload, env: { ...env, PATH: '/usr/bin:/bin' }, cwd, encoding: 'utf8' }));
  });

  test('POSIX: node from the PATH when the full path cannot go into a command', { skip: IS_WIN && 'POSIX only' }, async () => {
    const res = await installProjects(vault, {
      agent: 'claude-code', env: { PATH: env.PATH }, home: tmpDir('e2e-home'), t: null, execPath: '/opt/$odd/bin/node',
      io: { claudeVersions: () => ({ observed: [], min: null }), hasRemote: () => false },
    });
    assert.match(res.command, /^node "/);
    assert.match(res.warnings.join('\n'), /the hooks start the node on the PATH/);
    check('sh, node', 'claude-code', () => spawnSync('/bin/sh', ['-c', res.command], { input: payload, env, cwd, encoding: 'utf8' }));
  });

  test('the doctor probe runs it as the agent does (Claude Code and Codex)', async () => {
    const claude = await installed('claude-code');
    const spec = probeSpec('claude-code', claude, { env, bash: IS_WIN ? gitBashPath({ env }) : null });
    check(`probe ${spec.shell}`, 'claude-code', () => {
      const r = runProbe(spec, { input: payload, cwd, env });
      return { status: r.code, error: r.error, stderr: r.stderr };
    });
    const codex = await installed('codex');
    // Codex on POSIX: $SHELL -lc; /bin/sh keeps the profile of the machine out of the test.
    const codexSpec = probeSpec('codex', codex, { env: { ...env, SHELL: '/bin/sh' } });
    check(`codex ${codexSpec.shell}`, 'codex', () => {
      const r = runProbe(codexSpec, { input: payload, cwd, env });
      return { status: r.code, error: r.error, stderr: r.stderr };
    });
  });

  test('the exec form (a path no shell passes on) runs without a shell', async () => {
    const hook = hookHandler('claude-code', 'session-start', 20, { form: 'exec', exe: process.execPath }, { script: hookScript(vault) });
    const spec = probeSpec('claude-code', hook, {});
    assert.equal(spec.shell, 'exec');
    check('exec', 'claude-code', () => spawnSync(spec.command, spec.args, { input: payload, env, cwd, encoding: 'utf8', windowsHide: true }));
  });

  test('Windows: PowerShell -Command, PowerShell encoded, Git Bash and cmd.exe', { skip: !IS_WIN && 'Windows only' }, async () => {
    const hook = await installed('claude-code');
    check('powershell -Command', 'claude-code', () => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.command], { input: payload, env, cwd, encoding: 'utf8', windowsHide: true }));
    const ps = probeSpec('claude-code', hook, { platform: 'win32', env, bash: null });
    check('powershell encoded', 'claude-code', () => spawnSync(ps.command, ps.args, { ...ps.options, input: payload, env, cwd, encoding: 'utf8', windowsHide: true }));
    const bash = gitBashPath({ env });
    if (bash) check('git bash', 'claude-code', () => spawnSync(bash, ['-c', hook.command], { input: payload, env, cwd, encoding: 'utf8', windowsHide: true }));
    const codex = await installed('codex');
    const cmd = probeSpec('codex', codex, { platform: 'win32', env });
    check('cmd.exe /C', 'codex', () => spawnSync(cmd.command, cmd.args, { ...cmd.options, input: payload, env, cwd, encoding: 'utf8', windowsHide: true }));
  });
});

describe('probe helpers', () => {
  test('probeSpec per agent and platform', () => {
    const h = { type: 'command', command: 'node "C:/m/system/memory.mjs" hook claude-code session-start' };
    assert.deepEqual(probeSpec('claude-code', h, { platform: 'linux', env: {} }).args, ['-c', h.command]);
    assert.equal(probeSpec('claude-code', h, { platform: 'win32', env: {}, bash: 'C:\\Git\\bin\\bash.exe' }).command, 'C:\\Git\\bin\\bash.exe');
    const ps = probeSpec('claude-code', h, { platform: 'win32', env: {}, bash: null });
    assert.equal(ps.command, 'powershell.exe');
    assert.equal(Buffer.from(ps.args.at(-1), 'base64').toString('utf16le'), h.command);
    const codex = { type: 'command', command: 'node "/m/system/memory.mjs" hook codex session-start' };
    assert.deepEqual(probeSpec('codex', codex, { platform: 'darwin', env: { SHELL: '/bin/zsh' } }), { command: '/bin/zsh', args: ['-lc', codex.command], options: {}, shell: 'login' });
    const win = probeSpec('codex', { ...codex, commandWindows: 'node "C:/m/system/memory.mjs" hook codex session-start' }, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } });
    assert.deepEqual([win.command, win.args, win.options.windowsVerbatimArguments], ['C:\\Windows\\cmd.exe', ['/C', '"node "C:/m/system/memory.mjs" hook codex session-start"'], true]);
  });

  test('gitBashPath finds Git for Windows as Claude Code does', () => {
    const files = new Set(['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']);
    const isFile = (p) => files.has(path.win32.normalize(p));
    assert.equal(gitBashPath({ env: { PATH: 'C:\\Windows;C:\\Program Files\\Git\\cmd' }, isFile }), 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.equal(gitBashPath({ env: { PATH: 'C:\\Windows' }, isFile }), null);
    assert.equal(gitBashPath({ env: { PATH: '', ProgramFiles: 'C:\\Program Files' }, isFile }), 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.equal(gitBashPath({ env: { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\tools\\bash.exe' }, isFile: (p) => p === 'D:\\tools\\bash.exe' }), 'D:\\tools\\bash.exe');
  });

  test('the probe is marked, and git sees no repository above its folder', { skip: !HAS_GIT && 'git is not installed' }, () => {
    assert.equal(JSON.parse(probePayload('/tmp/x')).probe, true);
    // A temporary folder inside a repository (on Windows %TEMP% lies in a home folder, which is sometimes one).
    const repo = tmpDir('probe-repo');
    assert.equal(spawnSync('git', ['init', '-q', repo], { windowsHide: true }).status, 0);
    const cwd = path.join(repo, 'Temp', 'memory-kit-probe-x');
    fs.mkdirSync(cwd, { recursive: true });
    const env = probeEnv({ ...process.env, KEEP: '1' }, cwd);
    assert.deepEqual([env[PROBE_ENV], env.KEEP, env.CLAUDE_PROJECT_DIR], ['1', '1', cwd]);
    const top = (e) => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, env: e, encoding: 'utf8', windowsHide: true });
    assert.equal(top(process.env).status, 0, 'without the ceiling git finds the repository above');
    assert.notEqual(top(env).status, 0, 'with it, none');
  });

  test('the real probes answer on this machine', () => {
    assert.equal(typeof IO.nodeOnPath({ env: { ...process.env, PATH: NODE_DIR } }), 'string');
    assert.equal(IO.hasRemote(KIT_ROOT) === true || IO.hasRemote(KIT_ROOT) === false, true);
    if (!IS_WIN) assert.equal(IO.shortPath('/x'), null);
  });
});

// ---------------------------------------------------------------------------------------------
// memory.mjs on a Node.js older than 22 (a repository that pins one, while the hooks start node)

describe('a hook on a too old Node.js', () => {
  // Makes the Node.js running memory.mjs report version 20.20.2.
  const preload = put(path.join(tmpDir('old-node'), 'node20.mjs'), "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '20.20.2' } });\n");
  const run = (root, args) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'system', 'memory.mjs'), ...args], {
    input: '{"session_id":"s1","hook_event_name":"Stop"}', encoding: 'utf8', windowsHide: true, cwd: root,
  });
  const enable = (root) => {
    const file = path.join(root, 'memory.json');
    fs.writeFileSync(file, JSON.stringify({ ...json(file), projects: { enabled: true } }, null, 2));
  };

  test('ends quietly (exit 0, no output) and logs why, with the fix, in the vault\'s language', () => {
    const { root } = fixtureVault('cs');
    enable(root);
    const res = run(root, ['hook', 'claude-code', 'stop']);
    assert.deepEqual([res.status, res.stdout, res.stderr], [0, '', '']);
    const [entry] = readHookLog(root);
    assert.deepEqual([entry.agent, entry.event, entry.ok], ['claude-code', 'stop', false]);
    assert.match(entry.error, /^hook běžel na Node\.js 20\.20\.2 a nic neudělal: memory-kit potřebuje 22\.5\.0 nebo novější/);
    assert.match(entry.fix, /node system\/memory\.mjs connect claude-code --projects/);
    const other = run(root, ['check']);
    assert.equal(other.status, 3, 'every other command still refuses');
    assert.match(other.stderr, /Node\.js 22 or newer is required/);
  });

  test('logs nothing while the project hooks are off; --root is read', () => {
    const { root } = fixtureVault('en');
    const res = run(root, ['hook', 'codex', 'session-start']);
    assert.deepEqual([res.status, res.stdout], [0, '']);
    assert.deepEqual(readHookLog(root), []);
    assert.deepEqual(hookCall(['--root', root, 'hook', 'codex', 'stop'], '/kit'), { agent: 'codex', event: 'stop', root: path.resolve(root) });
    assert.deepEqual(hookCall(['hook', 'codex'], KIT_ROOT), { agent: 'codex', event: null, root: KIT_ROOT });
    assert.equal(hookCall(['doctor'], KIT_ROOT), null);
    enable(root);
    assert.equal(quietHook(['--root', root, 'hook', 'codex', 'stop'], { kitRoot: '/kit', version: '18.0.0', env: { MEMORY_KIT_PROBE: '1' } }), true);
    assert.deepEqual(readHookLog(root), [], 'a doctor --probe run logs nothing');
    assert.equal(quietHook(['--root', root, 'hook', 'codex', 'stop'], { kitRoot: '/kit', version: '18.0.0', env: {} }), true);
    assert.match(readHookLog(root)[0].error, /^the hook ran on Node\.js 18\.0\.0 and did nothing/);
    assert.equal(quietHook(['check', '--root', root], { kitRoot: '/kit' }), false);
  });
});
