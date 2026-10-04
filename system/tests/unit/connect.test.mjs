// connect and the MCP client table: JSONC reading, where every client keeps its config on
// Windows, macOS and Linux (pure resolution and fake homes), JSON and TOML edits that keep
// everything else, conflicts, --force, --remove, --dry-run, backups, --list, the Claude Code
// command path, the cmd.exe command line for Windows, and configs that cannot be read, are
// symlinks (dangling ones too) or have two names.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JsoncError, detectStyle, formatJson, parseJsonc, stripJsonc } from '../../lib/jsonc.mjs';
import {
  CLIENTS, DEFAULT_NAME, IO, NAME_RE, PORTABLE_SCRIPT, TomlError, buildEntry, claudeAddArgs, claudeRemoveArgs, entryTarget,
  envGet, findClient, findExecutable, inspectClient, inspectClients, jsonEntries, jsonSnippet, locateClient, mergeEntry,
  nodeCommand, planJsonEdit, planTomlEdit, portableArgs, projectConfigPath, resolveClient, scanToml, serverArgs,
  spawnSpec, tomlBlock, tomlServers, tomlString, vaultRefs, windowsCommandLine,
} from '../../lib/clients.mjs';
import { MESSAGES, connectClient, formatList, listClients, renderResult, say, writeTarget } from '../../lib/commands/connect.mjs';
import { KIT_ROOT, bareRoot, removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const IS_WIN = process.platform === 'win32';
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const NODE = '/usr/bin/node';

// ---------------------------------------------------------------------------------------------
// Local helpers

/** A vault loadConfig accepts, with a system/memory.mjs for the entry to point at. */
function makeVault() {
  const root = bareRoot('en');
  fs.writeFileSync(path.join(root, 'system', 'memory.mjs'), '// the vault\'s CLI\n');
  return root;
}

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const posixRefs = (vault) => vaultRefs(vault, { platform: 'linux', pathMod: path.posix, realpath: () => null });

/** The entry connect builds for a vault on Linux (node at NODE). */
function linuxBuilt(client, vault, opts = {}) {
  return buildEntry(client, { command: NODE, args: serverArgs(vault, { pathMod: path.posix, ...opts }) });
}

/** A child environment with nothing from this machine that would change where configs are. */
function childEnv(home, extra = {}) {
  const env = { HOME: home, USERPROFILE: home, PATH: extra.PATH ?? path.join(home, 'no-bin') };
  if (IS_WIN) {
    for (const k of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'windir']) if (process.env[k]) env[k] = process.env[k];
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  }
  return { ...env, ...extra };
}

/** node <kit>/system/memory.mjs connect <args> --root <vault>, with a fake home. */
function runConnect(vault, args, { home, env = {} } = {}) {
  const res = spawnSync(process.execPath, [path.join(KIT_ROOT, 'system', 'memory.mjs'), 'connect', ...args, '--root', vault], {
    cwd: vault, env: childEnv(home, env), encoding: 'utf8', windowsHide: true,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** The config path this machine's connect uses for a client in a fake home. */
function configPath(id, home, env = {}) {
  return resolveClient(id, { home, env: childEnv(home, env) }).candidates[0].path;
}

function messageKeys(res) {
  return res.messages.filter((m) => m.key).map((m) => m.key);
}

/** True when a file with mode 000 cannot be read here (root and Windows read it anyway). */
function modeBlocksReads() {
  if (IS_WIN) return false;
  const file = path.join(tmpDir('probe'), 'probe');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0);
  try {
    fs.readFileSync(file);
    return false;
  } catch {
    return true;
  } finally {
    fs.chmodSync(file, 0o600);
  }
}

// ---------------------------------------------------------------------------------------------

describe('jsonc', () => {
  test('plain JSON parses and reports no comments', () => {
    const r = parseJsonc('{"a": [1, 2], "b": {"c": null}}');
    assert.deepEqual(r.value, { a: [1, 2], b: { c: null } });
    assert.equal(r.comments, false);
    assert.equal(r.trailingCommas, false);
    assert.equal(r.empty, false);
  });

  test('line and block comments are found; comment marks inside strings are text', () => {
    const r = parseJsonc('// head\n{\n  "url": "https://x//y", /* why */ "glob": "/*.md",\n  "n": 1 // tail\n}');
    assert.deepEqual(r.value, { url: 'https://x//y', glob: '/*.md', n: 1 });
    assert.equal(r.comments, true);
    assert.equal(parseJsonc('{"a": "// no /* no */"}').comments, false);
    assert.equal(parseJsonc('{"a": "q\\" // still a string"}').comments, false);
  });

  test('trailing commas are accepted and reported', () => {
    const r = parseJsonc('{"a": [1, 2, ], "b": 3, }');
    assert.deepEqual(r.value, { a: [1, 2], b: 3 });
    assert.equal(r.trailingCommas, true);
    assert.equal(r.comments, false);
    assert.equal(parseJsonc('{"a": [1, /* c */ ], }').trailingCommas, true);
  });

  test('a BOM and an empty text', () => {
    const r = parseJsonc('\uFEFF{"a": 1}');
    assert.deepEqual(r.value, { a: 1 });
    assert.equal(r.bom, true);
    for (const t of ['', '  \n', '// only a comment\n']) {
      const e = parseJsonc(t);
      assert.equal(e.empty, true, JSON.stringify(t));
      assert.equal(e.value, undefined);
    }
  });

  test('stripped text keeps every offset, so errors point at the right line', () => {
    const text = '{\n  // c\n  "a": 1,\n}';
    assert.equal(stripJsonc(text).json.length, text.length);
    assert.throws(() => parseJsonc('{\n  /* x */ "a": 1\n  "b": 2\n}'), (err) => {
      assert.ok(err instanceof JsoncError);
      assert.equal(err.line, 3);
      assert.match(err.message, /at line 3, column 3/);
      return true;
    });
    assert.throws(() => parseJsonc('{"a": 1 /* open'), /unterminated comment at line 1/);
  });

  test('errors never quote the file (it may hold keys)', () => {
    assert.throws(() => parseJsonc('{"token": "SECRET-VALUE" x}'), (err) => !err.message.includes('SECRET'));
    assert.throws(() => parseJsonc('{"token": SECRET}'), (err) => !err.message.includes('SECRET'));
  });

  test('integers that would change on a round trip are reported', () => {
    assert.equal(parseJsonc('{"n": 9007199254740991}').unsafeNumbers, false);
    assert.equal(parseJsonc('{"n": 12345678901234567890}').unsafeNumbers, true);
    assert.equal(parseJsonc('{"n": 1e999}').unsafeNumbers, true);
    assert.equal(parseJsonc('{"n": 1.25e3, "m": -0.5}').unsafeNumbers, false);
    assert.equal(parseJsonc('{"s": "12345678901234567890"}').unsafeNumbers, false);
  });

  test('style detection and formatting keep a file\'s layout', () => {
    assert.deepEqual(detectStyle('{\n\t"a": 1\n}\n'), { indent: '\t', eol: '\n', finalNewline: true });
    assert.deepEqual(detectStyle('{\r\n    "a": 1\r\n}'), { indent: 4, eol: '\r\n', finalNewline: false });
    assert.deepEqual(detectStyle('{"a":1}\n'), { indent: 0, eol: '\n', finalNewline: true });
    assert.deepEqual(detectStyle('{}'), { indent: 2, eol: '\n', finalNewline: false });
    assert.deepEqual(detectStyle(''), { indent: 2, eol: '\n', finalNewline: true });
    assert.equal(formatJson({ a: [1] }, { indent: 4, eol: '\r\n', finalNewline: true }), '{\r\n    "a": [\r\n        1\r\n    ]\r\n}\r\n');
    assert.equal(formatJson({ a: 1 }, { indent: 0, eol: '\n', finalNewline: false }), '{"a":1}');
  });
});

// ---------------------------------------------------------------------------------------------

describe('client table and pure path resolution', () => {
  const W = { platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } };
  const M = { platform: 'darwin', home: '/Users/me', env: {} };
  const L = { platform: 'linux', home: '/home/me', env: {} };
  const first = (id, sys) => resolveClient(id, sys).candidates.map((c) => c.path);

  test('every client of the spec is known, with aliases', () => {
    const ids = CLIENTS.map((c) => c.id);
    for (const id of ['claude-code', 'claude-desktop', 'cursor', 'vscode', 'windsurf', 'gemini-cli', 'codex', 'zed', 'lm-studio', 'cline', 'copilot-cli', 'junie', 'chatgpt', 'claude-app']) {
      assert.ok(ids.includes(id), id);
    }
    assert.equal(findClient('claude-web').id, 'claude-app');
    assert.equal(findClient('ChatGPT-Desktop').id, 'chatgpt');
    assert.equal(findClient('devin').id, 'windsurf');
    assert.equal(findClient('gemini').id, 'gemini-cli');
    assert.equal(findClient('nope'), null);
    assert.throws(() => resolveClient('nope'), /unknown client/);
    for (const g of ['chatgpt', 'claude-app', 'jetbrains']) assert.deepEqual(resolveClient(g, L).candidates, [], g);
  });

  test('Windows paths', () => {
    assert.deepEqual(first('claude-code', W), ['C:\\Users\\me\\.claude.json']);
    assert.deepEqual(first('claude-desktop', W), ['C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json']);
    assert.deepEqual(resolveClient('claude-desktop', W).msix, {
      packages: 'C:\\Users\\me\\AppData\\Local\\Packages', prefix: 'Claude_', rel: ['LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'],
    });
    assert.deepEqual(first('cursor', W), ['C:\\Users\\me\\.cursor\\mcp.json']);
    assert.deepEqual(first('vscode', W), ['C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json', 'C:\\Users\\me\\AppData\\Roaming\\Code - Insiders\\User\\mcp.json']);
    assert.deepEqual(first('windsurf', W), ['C:\\Users\\me\\AppData\\Roaming\\devin\\mcp_config.json', 'C:\\Users\\me\\.codeium\\windsurf\\mcp_config.json']);
    assert.deepEqual(first('gemini-cli', W), ['C:\\Users\\me\\.gemini\\settings.json']);
    assert.deepEqual(first('codex', W), ['C:\\Users\\me\\.codex\\config.toml']);
    assert.deepEqual(first('zed', W), ['C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json']);
    assert.deepEqual(first('lm-studio', W), ['C:\\Users\\me\\.cache\\lm-studio\\mcp.json', 'C:\\Users\\me\\.lmstudio\\mcp.json']);
    assert.equal(resolveClient('lm-studio', W).pointer, 'C:\\Users\\me\\.lmstudio-home-pointer');
    assert.deepEqual(first('cline', W), [
      'C:\\Users\\me\\.cline\\data\\settings\\cline_mcp_settings.json',
      'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json',
    ]);
    assert.deepEqual(first('copilot-cli', W), ['C:\\Users\\me\\.copilot\\mcp-config.json']);
    assert.deepEqual(first('junie', W), ['C:\\Users\\me\\.junie\\mcp\\mcp.json']);
  });

  test('Windows without APPDATA falls back under the profile; variable names ignore case', () => {
    const bare = { platform: 'win32', home: 'C:\\Users\\me', env: {} };
    assert.deepEqual(first('zed', bare), ['C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json']);
    assert.equal(resolveClient('claude-desktop', bare).msix.packages, 'C:\\Users\\me\\AppData\\Local\\Packages');
    const lower = { platform: 'win32', home: 'C:\\Users\\me', env: { appdata: 'D:\\Roam', codex_home: 'D:\\cx' } };
    assert.deepEqual(first('zed', lower), ['D:\\Roam\\Zed\\settings.json']);
    assert.deepEqual(first('codex', lower), ['D:\\cx\\config.toml']);
    assert.equal(envGet({ Path: 'x' }, 'PATH', 'win32'), 'x');
    assert.equal(envGet({ Path: 'x' }, 'PATH', 'linux'), undefined);
    assert.equal(envGet({ PATH: '' }, 'PATH', 'linux'), undefined);
  });

  test('macOS paths', () => {
    assert.deepEqual(first('claude-code', M), ['/Users/me/.claude.json']);
    assert.deepEqual(first('claude-desktop', M), ['/Users/me/Library/Application Support/Claude/claude_desktop_config.json']);
    assert.equal(resolveClient('claude-desktop', M).msix, undefined);
    assert.deepEqual(first('vscode', M)[0], '/Users/me/Library/Application Support/Code/User/mcp.json');
    assert.deepEqual(first('windsurf', M), ['/Users/me/.config/devin/mcp_config.json', '/Users/me/.codeium/windsurf/mcp_config.json']);
    assert.deepEqual(first('zed', M), ['/Users/me/.config/zed/settings.json']);
    // Zed on macOS does not follow XDG_CONFIG_HOME; Devin does.
    const xdg = { ...M, env: { XDG_CONFIG_HOME: '/Users/me/xdg' } };
    assert.deepEqual(first('zed', xdg), ['/Users/me/.config/zed/settings.json']);
    assert.deepEqual(first('windsurf', xdg)[0], '/Users/me/xdg/devin/mcp_config.json');
    assert.deepEqual(first('cline', M)[1], '/Users/me/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json');
  });

  test('Linux paths and XDG variables', () => {
    assert.deepEqual(first('claude-desktop', L), ['/home/me/.config/Claude/claude_desktop_config.json']);
    assert.deepEqual(first('vscode', L)[0], '/home/me/.config/Code/User/mcp.json');
    assert.deepEqual(first('zed', L), ['/home/me/.config/zed/settings.json']);
    const xdg = { ...L, env: { XDG_CONFIG_HOME: '/xdg' } };
    assert.deepEqual(first('claude-desktop', xdg), ['/xdg/Claude/claude_desktop_config.json']);
    assert.deepEqual(first('vscode', xdg)[0], '/xdg/Code/User/mcp.json');
    assert.deepEqual(first('zed', xdg), ['/xdg/zed/settings.json']);
    assert.deepEqual(first('zed', { ...L, env: { XDG_CONFIG_HOME: '/xdg', FLATPAK_XDG_CONFIG_HOME: '/fp' } }), ['/fp/zed/settings.json']);
    // A relative XDG_CONFIG_HOME is invalid by the XDG rules and ignored.
    assert.deepEqual(first('zed', { ...L, env: { XDG_CONFIG_HOME: 'rel' } }), ['/home/me/.config/zed/settings.json']);
  });

  test('home overrides of the command-line clients', () => {
    assert.deepEqual(first('claude-code', { ...L, env: { CLAUDE_CONFIG_DIR: '/cc' } }), ['/cc/.claude.json']);
    assert.equal(resolveClient('claude-code', { ...L, env: { CLAUDE_CONFIG_DIR: '/cc' } }).candidates[0].appDir, '/cc');
    assert.equal(resolveClient('claude-code', L).candidates[0].appDir, '/home/me/.claude');
    assert.deepEqual(first('codex', { ...L, env: { CODEX_HOME: '/cx' } }), ['/cx/config.toml']);
    assert.deepEqual(first('gemini-cli', { ...L, env: { GEMINI_CLI_HOME: '/gh' } }), ['/gh/.gemini/settings.json']);
    assert.deepEqual(first('copilot-cli', { ...L, env: { COPILOT_HOME: '/cp' } }), ['/cp/mcp-config.json']);
    assert.deepEqual(first('cline', { ...L, env: { CLINE_MCP_SETTINGS_PATH: '/x/mcp.json' } }), ['/x/mcp.json']);
    assert.equal(first('cline', { ...L, env: { CLINE_DATA_DIR: '/d' } })[0], '/d/settings/cline_mcp_settings.json');
    assert.equal(first('cline', { ...L, env: { CLINE_DIR: '/c' } })[0], '/c/data/settings/cline_mcp_settings.json');
    assert.equal(first('cline', { ...L, env: { CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' } })[0], '/d/settings/cline_mcp_settings.json');
  });

  test('project files exist only for cursor and vscode', () => {
    assert.equal(projectConfigPath('cursor', '/v', { pathMod: path.posix }), '/v/.cursor/mcp.json');
    assert.equal(projectConfigPath('vscode', 'C:\\v', { pathMod: path.win32 }), 'C:\\v\\.vscode\\mcp.json');
    for (const id of CLIENTS.map((c) => c.id).filter((i) => !['cursor', 'vscode'].includes(i))) {
      assert.equal(projectConfigPath(id, '/v', { pathMod: path.posix }), null, id);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('locating the file on fake homes', () => {
  /** Resolves and locates with Windows (or other) rules on this machine's file system. */
  const locate = (id, platform, home, env = {}) =>
    locateClient(resolveClient(id, { platform, home, env, pathMod: path }), { platform, pathMod: path });

  function winHome(label) {
    const home = tmpDir(label);
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    return { home, env, real: path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'), pkgs: path.join(env.LOCALAPPDATA, 'Packages') };
  }
  const privateOf = (pkgs, name) => path.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json');

  test('Claude Desktop from the Store: an existing private copy is the one to edit', () => {
    const w = winHome('cd-msix');
    put(w.real, '{}');
    const priv = put(privateOf(w.pkgs, 'Claude_pzs8sxrjxfjjc'), '{}');
    fs.mkdirSync(path.join(w.pkgs, 'Microsoft.Other_123'), { recursive: true });
    const loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.deepEqual(loc.targets.map((t) => t.path), [priv]);
    assert.equal(loc.targets[0].role, 'msix');
    assert.equal(loc.appFound, true);
    assert.deepEqual(loc.notes.map((n) => n.key), ['connect.msix']);
  });

  test('Claude Desktop from the Store: of several packages the newest config wins', () => {
    const w = winHome('cd-msix2');
    const old = put(privateOf(w.pkgs, 'Claude_aaaa'), '{}');
    const fresh = put(privateOf(w.pkgs, 'Claude_bbbb'), '{}');
    fs.utimesSync(old, new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(fresh, new Date(2026, 5, 1), new Date(2026, 5, 1));
    const loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.deepEqual(loc.targets.map((t) => t.path), [fresh]);
    assert.deepEqual(loc.notes.map((n) => n.key), ['connect.msix', 'connect.msix_many']);
  });

  test('Claude Desktop from the Store without a private copy: the real file, never a shadowing copy', () => {
    const w = winHome('cd-msix3');
    fs.mkdirSync(path.join(w.pkgs, 'Claude_pzs8sxrjxfjjc'), { recursive: true });
    put(w.real, '{"preferences": {}}');
    let loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.deepEqual(loc.targets, [{ path: w.real, role: 'appdata', exists: true }]);
    fs.rmSync(w.real);
    loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.deepEqual(loc.targets, [{ path: w.real, role: 'appdata', exists: false }]);
    assert.equal(loc.appFound, true, 'the package shows the app is installed');
    assert.deepEqual(loc.notes.map((n) => n.key), ['connect.msix_real']);
  });

  test('Claude Desktop classic install, and not installed at all', () => {
    const w = winHome('cd-classic');
    let loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.equal(loc.appFound, false);
    assert.equal(loc.targets[0].path, w.real);
    fs.mkdirSync(path.dirname(w.real), { recursive: true });
    loc = locate('claude-desktop', 'win32', w.home, w.env);
    assert.equal(loc.appFound, true);
    assert.equal(loc.targets[0].exists, false);
  });

  test('Windsurf and Devin: existing files first, both when both exist', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const home = tmpDir(`ws-${platform}`);
      const env = platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming') } : {};
      const [devin, legacy] = resolveClient('windsurf', { platform, home, env, pathMod: path }).candidates.map((c) => c.path);
      let loc = locate('windsurf', platform, home, env);
      assert.equal(loc.appFound, false, platform);
      assert.equal(loc.targets[0].path, devin);
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      assert.deepEqual(locate('windsurf', platform, home, env).targets.map((t) => t.path), [legacy], 'only the old app folder');
      put(legacy, '{}');
      fs.mkdirSync(path.dirname(devin), { recursive: true });
      assert.deepEqual(locate('windsurf', platform, home, env).targets.map((t) => t.path), [legacy], 'the existing file beats a bare folder');
      put(devin, '{}');
      loc = locate('windsurf', platform, home, env);
      assert.deepEqual(loc.targets.map((t) => t.path), [devin, legacy], 'both files are read, so both are written');
    }
  });

  test('Windsurf and Devin: one file under both names is one target, read once', () => {
    // The old folder linked to the new one: two names, one real file.
    const sys = { platform: 'linux', home: '/h', env: {}, pathMod: path.posix };
    const [devin, legacy] = resolveClient('windsurf', sys).candidates.map((c) => c.path);
    const vault = '/v';
    const text = JSON.stringify({ mcpServers: { 'memory-kit': { command: NODE, args: serverArgs(vault, { pathMod: path.posix }) } } });
    const io = {
      isFile: (p) => p === devin || p === legacy,
      isDir: () => true,
      readdir: () => [],
      mtime: () => 0,
      realpath: (p) => (p === legacy ? devin : p === devin ? devin : null),
      readText: () => text,
    };
    const loc = locateClient(resolveClient('windsurf', sys), { platform: 'linux', pathMod: path.posix, io });
    assert.deepEqual(loc.targets, [{ path: devin, role: 'devin', exists: true }]);
    assert.deepEqual(loc.notes, [{ key: 'connect.same_file', vars: { path: legacy, target: devin } }]);
    const row = inspectClient('windsurf', { ...sys, vault, io, refs: posixRefs(vault) });
    assert.equal(row.state, 'connected');
    assert.deepEqual(row.paths, [devin]);
    assert.deepEqual(row.entries.map((e) => e.path), [devin], 'the entry is listed once');
    // Two real files stay two targets.
    const two = locateClient(resolveClient('windsurf', sys), { platform: 'linux', pathMod: path.posix, io: { ...io, realpath: (p) => p } });
    assert.deepEqual(two.targets.map((t) => t.path), [devin, legacy]);
    assert.deepEqual(two.notes, []);
  });

  test('LM Studio: the home pointer first, never created', () => {
    const home = tmpDir('lms');
    const custom = path.join(home, 'models', 'lmhome');
    fs.mkdirSync(custom, { recursive: true });
    let loc = locate('lm-studio', 'linux', home);
    assert.equal(loc.appFound, false);
    assert.equal(loc.targets[0].path, path.join(home, '.lmstudio', 'mcp.json'), 'the documented place when nothing exists');
    put(path.join(home, '.lmstudio-home-pointer'), `${custom}\n`);
    loc = locate('lm-studio', 'linux', home);
    assert.deepEqual(loc.targets, [{ path: path.join(custom, 'mcp.json'), role: 'pointer', exists: false }]);
    assert.equal(loc.appFound, true);
    put(path.join(home, '.lmstudio-home-pointer'), 'relative/dir\n');
    fs.mkdirSync(path.join(home, '.cache', 'lm-studio'), { recursive: true });
    fs.mkdirSync(path.join(home, '.lmstudio'), { recursive: true });
    loc = locate('lm-studio', 'darwin', home);
    assert.equal(loc.targets[0].path, path.join(home, '.cache', 'lm-studio', 'mcp.json'), 'LM Studio looks in the cache folder first');
    put(path.join(home, '.lmstudio', 'mcp.json'), '{}');
    loc = locate('lm-studio', 'darwin', home);
    assert.equal(loc.targets[0].path, path.join(home, '.lmstudio', 'mcp.json'), 'an existing mcp.json wins');
    assert.equal(fs.readFileSync(path.join(home, '.lmstudio-home-pointer'), 'utf8'), 'relative/dir\n');
  });

  test('Cline: the shared file, the old extension file only when it is all there is', () => {
    const home = tmpDir('cline');
    const [primary, legacy] = resolveClient('cline', { platform: 'linux', home, env: {}, pathMod: path }).candidates.map((c) => c.path);
    assert.equal(locate('cline', 'linux', home).appFound, false);
    put(legacy, '{}');
    assert.equal(locate('cline', 'linux', home).targets[0].path, legacy);
    fs.mkdirSync(path.join(home, '.cline'), { recursive: true });
    assert.equal(locate('cline', 'linux', home).targets[0].path, primary, 'the new code reads ~/.cline');
    put(primary, '{}');
    assert.deepEqual(locate('cline', 'linux', home).targets.map((t) => t.path), [primary]);
  });

  test('VS Code: stable first, Insiders when only it is installed', () => {
    const home = tmpDir('vsc');
    const [stable, insiders] = resolveClient('vscode', { platform: 'linux', home, env: {}, pathMod: path }).candidates.map((c) => c.path);
    fs.mkdirSync(path.dirname(path.dirname(insiders)), { recursive: true });
    assert.equal(locate('vscode', 'linux', home).targets[0].path, insiders);
    fs.mkdirSync(path.dirname(path.dirname(stable)), { recursive: true });
    assert.equal(locate('vscode', 'linux', home).targets[0].path, stable);
  });
});

// ---------------------------------------------------------------------------------------------

describe('entries', () => {
  const args = serverArgs('/v', { pathMod: path.posix });

  test('server arguments, also for Windows and read-only', () => {
    assert.deepEqual(args, ['/v/system/memory.mjs', 'mcp', '--root', '/v']);
    assert.deepEqual(serverArgs('C:\\Users\\Žluťoučký\\my vault', { pathMod: path.win32, readOnly: true }),
      ['C:\\Users\\Žluťoučký\\my vault\\system\\memory.mjs', 'mcp', '--root', 'C:\\Users\\Žluťoučký\\my vault', '--read-only']);
    assert.deepEqual(portableArgs(), [PORTABLE_SCRIPT, 'mcp', '--root', '${workspaceFolder}']);
    assert.deepEqual(portableArgs({ readOnly: true }).slice(-1), ['--read-only']);
  });

  test('each client gets the shape it expects', () => {
    const full = (id) => buildEntry(id, { command: NODE, args }).full;
    assert.deepEqual(full('claude-code'), { type: 'stdio', command: NODE, args, env: {} });
    assert.deepEqual(Object.keys(full('claude-desktop')), ['command', 'args'], 'Claude Desktop: exactly command and args');
    assert.deepEqual(full('cursor'), { type: 'stdio', command: NODE, args });
    assert.deepEqual(full('vscode'), { type: 'stdio', command: NODE, args });
    assert.deepEqual(full('copilot-cli'), { type: 'stdio', command: NODE, args, tools: ['*'] });
    assert.deepEqual(full('zed'), { command: NODE, args, env: {} });
    assert.deepEqual(full('cline'), { command: NODE, args, disabled: false });
    for (const id of ['windsurf', 'gemini-cli', 'codex', 'lm-studio', 'junie']) assert.deepEqual(full(id), { command: NODE, args }, id);
  });

  test('an update keeps what the owner added and fills only missing defaults', () => {
    const built = buildEntry('copilot-cli', { command: NODE, args });
    const merged = mergeEntry({ command: 'old', args: [], tools: ['memory_search'], env: { A: '1' }, timeout: 5 }, built);
    assert.deepEqual(merged, { command: NODE, args, tools: ['memory_search'], env: { A: '1' }, timeout: 5, type: 'stdio' });
    assert.deepEqual(Object.keys(merged), ['command', 'args', 'tools', 'env', 'timeout', 'type'], 'key order kept, new keys last');
  });

  test('the name rule', () => {
    for (const ok of ['memory-kit', 'memory', 'm2', 'Work-Memory']) assert.ok(NAME_RE.test(ok), ok);
    for (const bad of ['memory_kit', 'memory.kit', '-x', '', 'a b', 'x'.repeat(65), 'paměť']) assert.ok(!NAME_RE.test(bad), bad);
    assert.equal(DEFAULT_NAME, 'memory-kit');
  });

  test('Homebrew on macOS: a stable link instead of the versioned Cellar folder', () => {
    const cellar = '/opt/homebrew/Cellar/node/22.9.0/bin/node';
    const links = { '/opt/homebrew/bin/node': cellar, '/opt/homebrew/opt/node/bin/node': cellar };
    assert.equal(nodeCommand({ execPath: cellar, platform: 'darwin', realpath: (p) => links[p] ?? null }), '/opt/homebrew/bin/node');
    // bin/node belongs to another formula (node@22 is keg-only): use its own opt link.
    const keg = '/usr/local/Cellar/node@22/22.9.0/bin/node';
    const other = { '/usr/local/bin/node': '/usr/local/Cellar/node/24.1.0/bin/node', '/usr/local/opt/node@22/bin/node': keg };
    assert.equal(nodeCommand({ execPath: keg, platform: 'darwin', realpath: (p) => other[p] ?? null }), '/usr/local/opt/node@22/bin/node');
    assert.equal(nodeCommand({ execPath: cellar, platform: 'darwin', realpath: () => null }), cellar, 'no link: keep the real path');
    assert.equal(nodeCommand({ execPath: '/Users/me/.nvm/versions/node/v22.9.0/bin/node', platform: 'darwin' }), '/Users/me/.nvm/versions/node/v22.9.0/bin/node');
    assert.equal(nodeCommand({ execPath: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' }), 'C:\\Program Files\\nodejs\\node.exe');
  });

  test('Linuxbrew and snap: the stable link instead of a folder the package manager deletes by itself', () => {
    const cellar = '/home/linuxbrew/.linuxbrew/Cellar/node/24.1.0/bin/node';
    const links = { '/home/linuxbrew/.linuxbrew/bin/node': cellar };
    for (const platform of ['linux', 'darwin']) {
      assert.equal(nodeCommand({ execPath: cellar, platform, realpath: (p) => links[p] ?? null }), '/home/linuxbrew/.linuxbrew/bin/node', platform);
    }
    const snap = '/snap/node/10245/bin/node';
    const current = { '/snap/node/current/bin/node': '/snap/node/10245/bin/node' };
    assert.equal(nodeCommand({ execPath: snap, platform: 'linux', realpath: (p) => current[p] ?? null }), '/snap/node/current/bin/node');
    assert.equal(nodeCommand({ execPath: snap, platform: 'linux', realpath: () => null }), snap, 'no current link: keep the real path');
    assert.equal(nodeCommand({ execPath: '/snap/node/current/bin/node', platform: 'linux', realpath: () => '/snap/node/10245/bin/node' }), '/snap/node/current/bin/node');
    assert.equal(nodeCommand({ execPath: 'C:\\snap\\node\\1\\node.exe', platform: 'win32', realpath: () => null }), 'C:\\snap\\node\\1\\node.exe');
  });

  test('recognizing entries that serve a vault', () => {
    const refs = posixRefs('/v');
    assert.equal(entryTarget({ command: 'node', args: ['/v/system/memory.mjs', 'mcp', '--root', '/v'] }, refs).kind, 'this');
    assert.equal(entryTarget({ command: 'node', args: ['/v/./system/memory.mjs'] }, refs).kind, 'this', 'normalized');
    assert.equal(entryTarget({ command: 'node', args: ['/kit/system/memory.mjs', 'mcp', '--root', '/v/'] }, refs).kind, 'this', 'by --root');
    assert.deepEqual(entryTarget({ command: 'node', args: ['/w/system/memory.mjs', 'mcp', '--root', '/w'] }, refs), { kind: 'kit', root: '/w' });
    assert.equal(entryTarget({ command: 'npx', args: ['-y', 'some-server'] }, refs).kind, null);
    assert.equal(entryTarget({ url: 'https://x' }, refs).kind, null);
    assert.equal(entryTarget('odd', refs).kind, null);
    assert.equal(entryTarget({ command: { path: 'node', args: ['/v/system/memory.mjs'] } }, refs).kind, 'this', 'older Zed shape');
    assert.equal(entryTarget({ transport: { type: 'stdio', command: 'node', args: ['/v/system/memory.mjs'] } }, refs).kind, 'this', 'Cline nested shape');
    assert.equal(entryTarget({ args: [PORTABLE_SCRIPT, 'mcp'] }, refs).kind, 'kit');
    assert.equal(entryTarget({ args: [PORTABLE_SCRIPT, 'mcp'] }, refs, { portable: true }).kind, 'this');
    // Windows compares without letter case and with either slash.
    const w = vaultRefs('C:\\Users\\Me\\Vault', { platform: 'win32', pathMod: path.win32, realpath: () => null });
    assert.equal(entryTarget({ args: ['c:/users/me/vault/system/memory.mjs'] }, w).kind, 'this');
    assert.equal(entryTarget({ args: ['C:\\Users\\Me\\Vault2\\system\\memory.mjs', 'mcp'] }, w).kind, 'kit');
    // Linux keeps letter case.
    assert.equal(entryTarget({ args: ['/V/system/memory.mjs', 'mcp'] }, refs).kind, 'kit');
    // A memory.mjs that is not run as a server is someone else's business, and so is any other
    // program that happens to take --root <vault>.
    assert.equal(entryTarget({ command: 'files-server', args: ['--root', '/v'] }, refs).kind, null);
    assert.equal(entryTarget({ args: ['/w/system/memory.mjs', 'start'] }, refs).kind, null);
  });

  test('a vault reached through a link is recognized by its real path too', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const base = tmpDir('link');
    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, 'alias'));
    const refs = vaultRefs(path.join(base, 'alias'));
    assert.equal(entryTarget({ args: [path.join(real, 'system', 'memory.mjs')] }, refs).kind, 'this');
    assert.equal(entryTarget({ args: [path.join(base, 'alias', 'system', 'memory.mjs')] }, refs).kind, 'this');
  });
});

// ---------------------------------------------------------------------------------------------

describe('JSON configs', () => {
  const vault = '/v';
  const refs = posixRefs(vault);
  const built = linuxBuilt('cursor', vault);
  const plan = (text, opts = {}) => planJsonEdit(text, { key: ['mcpServers'], name: 'memory-kit', built, refs, ...opts });
  const foreign = { command: 'npx', args: ['-y', 'other-server'] };

  test('adding keeps every other server and key, the indent and the line endings', () => {
    const before = '{\r\n    "theme": "dark",\r\n    "mcpServers": {\r\n        "github": {"command": "gh", "env": {"TOKEN": "x"}}\r\n    },\r\n    "z": [1, 2]\r\n}\r\n';
    const res = plan(before);
    assert.equal(res.action, 'add');
    const after = JSON.parse(res.text);
    assert.deepEqual(after.mcpServers.github, { command: 'gh', env: { TOKEN: 'x' } });
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.z, [1, 2]);
    assert.deepEqual(after.mcpServers['memory-kit'], built.full);
    assert.deepEqual(Object.keys(after), ['theme', 'mcpServers', 'z']);
    assert.ok(res.text.includes('\r\n    "theme"'), 'four spaces and CRLF kept');
    assert.ok(!/[^\r]\n/.test(res.text), 'no bare LF');
    assert.ok(res.text.endsWith('}\r\n'));
  });

  test('a missing file or a file without the server map', () => {
    const res = plan(null);
    assert.equal(res.action, 'add');
    assert.equal(res.text, `${JSON.stringify({ mcpServers: { 'memory-kit': built.full } }, null, 2)}\n`);
    const tabs = plan('{\n\t"other": true\n}');
    assert.deepEqual(Object.keys(JSON.parse(tabs.text)), ['other', 'mcpServers']);
    assert.ok(tabs.text.startsWith('{\n\t"other": true,\n\t"mcpServers"'));
    assert.ok(!tabs.text.endsWith('\n'), 'no final newline when the file had none');
    assert.equal(plan('').action, 'add', 'an empty file counts as {}');
  });

  test('unchanged, then updated when something of ours changes', () => {
    const once = plan(null).text;
    assert.equal(plan(once).action, 'unchanged');
    const readOnly = linuxBuilt('cursor', vault, { readOnly: true });
    const withEnv = JSON.parse(once);
    withEnv.mcpServers['memory-kit'].env = { MEMORY_SECTORS: 'work' };
    const res = planJsonEdit(JSON.stringify(withEnv, null, 2), { key: ['mcpServers'], name: 'memory-kit', built: readOnly, refs });
    assert.equal(res.action, 'update');
    const entry = JSON.parse(res.text).mcpServers['memory-kit'];
    assert.deepEqual(entry.args.slice(-1), ['--read-only']);
    assert.deepEqual(entry.env, { MEMORY_SECTORS: 'work' }, 'the owner\'s env stays');
  });

  test('a foreign entry with the same name is a conflict; --force replaces it', () => {
    const before = JSON.stringify({ mcpServers: { 'memory-kit': foreign, keep: foreign } }, null, 2);
    assert.equal(plan(before).action, 'conflict');
    const forced = plan(before, { force: true });
    assert.equal(forced.action, 'replace');
    const after = JSON.parse(forced.text).mcpServers;
    assert.deepEqual(after['memory-kit'], built.full);
    assert.deepEqual(after.keep, foreign);
    assert.deepEqual(Object.keys(after), ['memory-kit', 'keep'], 'the entry keeps its place');
  });

  test('remove: ours goes, a foreign one only with --force, a missing one is nothing to do', () => {
    const ours = plan(JSON.stringify({ mcpServers: { a: foreign } })).text;
    const removed = plan(ours, { remove: true });
    assert.equal(removed.action, 'remove');
    assert.deepEqual(JSON.parse(removed.text), { mcpServers: { a: foreign } });
    const theirs = JSON.stringify({ mcpServers: { 'memory-kit': foreign } });
    assert.equal(plan(theirs, { remove: true }).action, 'conflict');
    assert.equal(plan(theirs, { remove: true, force: true }).action, 'remove');
    assert.equal(plan('{"x": 1}', { remove: true }).action, 'absent');
    assert.equal(plan(null, { remove: true }).action, 'absent');
  });

  test('connected under another name: no second entry unless --force', () => {
    const before = JSON.stringify({ mcpServers: { memory: built.full } });
    const res = plan(before);
    assert.equal(res.action, 'connected-as');
    assert.deepEqual(res.others, ['memory']);
    assert.equal(plan(before, { force: true }).action, 'add');
    const absent = plan(before, { remove: true });
    assert.equal(absent.action, 'absent');
    assert.deepEqual(absent.others, ['memory']);
  });

  test('a file with comments is never rewritten; the snippet says where it goes', () => {
    const inside = plan('{\n  // my servers\n  "mcpServers": {}\n}');
    assert.equal(inside.action, 'refused');
    assert.equal(inside.reason, 'comments');
    assert.equal(inside.planned, 'add');
    assert.equal(inside.inside, true);
    assert.equal(inside.text, undefined);
    assert.deepEqual(JSON.parse(`{${inside.snippet}}`), { 'memory-kit': built.full });
    const top = plan('/* zed */ {"theme": "x"}');
    assert.equal(top.inside, false);
    assert.deepEqual(JSON.parse(`{${top.snippet}}`), { mcpServers: { 'memory-kit': built.full } });
    // Already connected: nothing to write, so the comments do not matter.
    const connected = `// c\n${plan(null).text}`;
    assert.equal(plan(connected).action, 'unchanged');
    const rm = plan(connected, { remove: true });
    assert.equal(rm.action, 'refused');
    assert.equal(rm.planned, 'remove');
  });

  test('trailing commas alone do not block; the rewrite drops them', () => {
    const res = plan('{"mcpServers": {"a": {"command": "x",},},}');
    assert.equal(res.action, 'add');
    assert.deepEqual(JSON.parse(res.text).mcpServers.a, { command: 'x' });
  });

  test('broken or odd files are refused with the entry to paste', () => {
    const broken = plan('{"mcpServers": {');
    assert.equal(broken.reason, 'parse');
    assert.match(broken.error, /line 1/);
    assert.deepEqual(JSON.parse(`{${broken.snippet}}`), { mcpServers: { 'memory-kit': built.full } });
    assert.equal(plan('[1, 2]').reason, 'root');
    assert.equal(plan('{"mcpServers": []}').reason, 'key');
    assert.equal(plan('{"mcpServers": {}, "id": 123456789012345678901}').reason, 'numbers');
  });

  test('snippets for nested and flat keys', () => {
    assert.equal(jsonSnippet(['a', 'b'], 'n', { x: 1 }), '"a": {\n  "b": {\n    "n": {\n      "x": 1\n    }\n  }\n}');
    assert.equal(jsonSnippet(['a'], 'n', { x: 1 }, { inside: true }), '"n": {\n  "x": 1\n}');
  });

  test('Claude Code: user entries and per-project entries are both read', () => {
    const text = JSON.stringify({
      numStartups: 3,
      mcpServers: { a: foreign },
      projects: { '/p': { mcpServers: { b: built.full } }, '/q': { allowedTools: [] } },
    });
    const list = jsonEntries(text, ['mcpServers'], 'claude-code');
    assert.deepEqual(list.map((e) => [e.scope, e.project ?? null, e.name]), [['user', null, 'a'], ['local', '/p', 'b']]);
    assert.deepEqual(jsonEntries(text, ['mcpServers'], 'cursor').map((e) => e.name), ['a']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('TOML configs (Codex)', () => {
  const vault = '/v';
  const refs = posixRefs(vault);
  const built = linuxBuilt('codex', vault);
  const plan = (text, opts = {}) => planTomlEdit(text, { name: 'memory-kit', built, refs, ...opts });
  const block = tomlBlock('memory-kit', built.owned);
  const RICH = [
    '# Codex settings',
    'model = "o3"  # the default',
    'approval_policy = "on-request"',
    'when = 1979-05-27 07:32:00Z',
    '',
    '[mcp_servers.github]',
    'command = "npx"',
    'args = [',
    '  "-y", # comment inside an array',
    '  "[not a table]",',
    '  \'literal\\path\',',
    ']',
    'env = { GITHUB_TOKEN = "x", nested = { a = [1, 2] } }',
    '',
    '# about the profile',
    '[ profiles . "deep work" ]',
    'note = """',
    '[mcp_servers.memory-kit]',
    'command = "a fake header inside a string"',
    '"""',
    "raw = '''",
    "[also.not.a.table]'''",
    '',
    '[[projects]]',
    'path = "/x"',
    '',
  ].join('\n');

  test('the scanner finds headers and values, not text inside strings and arrays', () => {
    const scan = scanToml(RICH);
    assert.deepEqual(scan.tables.map((t) => [t.path.join('.'), t.array]), [['mcp_servers.github', false], ['profiles.deep work', false], ['projects', true]]);
    const servers = tomlServers(scan);
    assert.deepEqual(Object.keys(servers), ['github']);
    assert.deepEqual(servers.github.args, ['-y', '[not a table]', 'literal\\path']);
    assert.deepEqual(servers.github.env, { GITHUB_TOKEN: 'x', nested: { a: [1, 2] } });
    const note = scan.pairs.find((p) => p.key[0] === 'note');
    assert.equal(note.value, '[mcp_servers.memory-kit]\ncommand = "a fake header inside a string"\n');
    assert.equal(scan.pairs.find((p) => p.key[0] === 'raw').value, '[also.not.a.table]');
    assert.equal(scan.pairs.find((p) => p.key[0] === 'when').value, '1979-05-27 07:32:00Z');
  });

  test('strings decode like TOML: escapes, literal strings, line-ending backslashes', () => {
    const scan = scanToml('a = "C:\\\\Users\\\\x \\u00e9 \\"q\\""\nb = \'C:\\Users\\x\'\nc = """\\\n    one \\\n    two"""\nd = 0x1F\ne = true\nf = 1_000\n');
    const v = Object.fromEntries(scan.pairs.map((p) => [p.key[0], p.value]));
    assert.deepEqual(v, { a: 'C:\\Users\\x é "q"', b: 'C:\\Users\\x', c: 'one two', d: 31, e: true, f: 1000 });
  });

  test('broken TOML is reported with its line', () => {
    assert.throws(() => scanToml('a = 1\nb = "open\n'), (err) => err instanceof TomlError && err.line === 2);
    assert.throws(() => scanToml('[table\n'), TomlError);
    assert.throws(() => scanToml('x = [1, 2\n'), TomlError);
    assert.throws(() => scanToml('x = \n'), TomlError);
    const res = plan('a = "open\n');
    assert.equal(res.action, 'refused');
    assert.equal(res.reason, 'parse');
    assert.equal(res.snippet, block);
  });

  test('tomlString escapes what TOML needs and keeps the rest', () => {
    assert.equal(tomlString('C:\\Users\\Žluťoučký\\vault'), '"C:\\\\Users\\\\Žluťoučký\\\\vault"');
    assert.equal(tomlString('say "hi"\t\n'), '"say \\"hi\\"\\t\\n"');
    assert.equal(tomlString('\u0001\u007f'), '"\\u0001\\u007F"');
    assert.equal(tomlString("it's"), '"it\'s"');
    const round = scanToml(`x = ${tomlString('C:\\a "b"\u0007\u007f é')}\n`).pairs[0].value;
    assert.equal(round, 'C:\\a "b"\u0007\u007f é');
  });

  test('adding appends one block and leaves every other byte', () => {
    const res = plan(RICH);
    assert.equal(res.action, 'add');
    assert.ok(res.text.startsWith(RICH), 'the original text is untouched');
    assert.equal(res.text.slice(RICH.length), `\n${block}`);
    assert.deepEqual(tomlServers(scanToml(res.text))['memory-kit'], built.owned);
    assert.equal(plan(res.text).action, 'unchanged');
    assert.equal(plan(null).text, block, 'a new file holds only the block');
    assert.equal(plan('a = 1').text, `a = 1\n\n${block}`, 'a missing final newline is added first');
    assert.equal(plan('a = 1\n\n').text, `a = 1\n\n${block}`, 'no second blank line');
  });

  test('removing restores the original bytes', () => {
    for (const original of [RICH, 'a = 1\n', '', '[x]\ny = 2\n', '[x]\r\ny = 2\r\n']) {
      const added = plan(original).text;
      const removed = plan(added, { remove: true });
      assert.equal(removed.action, 'remove');
      assert.equal(removed.text, original, JSON.stringify(original));
    }
    // A block in the middle, between other tables.
    const middle = `a = 1\n\n${block}\n[mcp_servers.github]\ncommand = "gh"\n`;
    assert.equal(plan(middle, { remove: true }).text, 'a = 1\n\n[mcp_servers.github]\ncommand = "gh"\n');
    assert.equal(plan('a = 1\n', { remove: true }).action, 'absent');
    // A file that ended in a blank line loses that one line: the blank before our block goes with it.
    assert.equal(plan(plan('[x]\ny = 2\n\n').text, { remove: true }).text, '[x]\ny = 2\n');
  });

  test('an update rewrites only the command and args lines of our block', () => {
    const before = [
      'model = "o3"',
      '',
      '# memory',
      '[mcp_servers.memory-kit]',
      'command = "/old/node"',
      'startup_timeout_sec = 30 # slow disk',
      'args = [',
      '  "/v/system/memory.mjs",',
      '  "mcp", "--root", "/v",',
      ']',
      'enabled = true',
      '',
      '[mcp_servers.memory-kit.env]',
      'MEMORY_SECTORS = "work"',
      '',
      '[mcp_servers.github]',
      'command = "gh"',
      '',
    ].join('\n');
    const res = plan(before);
    assert.equal(res.action, 'update');
    const lines = tomlBlock('memory-kit', built.owned).split('\n');
    const expected = before
      .replace('command = "/old/node"', lines[1])
      .replace('args = [\n  "/v/system/memory.mjs",\n  "mcp", "--root", "/v",\n]', lines[2]);
    assert.equal(res.text, expected);
    assert.equal(plan(res.text).action, 'unchanged');
    const server = tomlServers(scanToml(res.text))['memory-kit'];
    assert.deepEqual(server.env, { MEMORY_SECTORS: 'work' });
    assert.equal(server.startup_timeout_sec, 30);
  });

  test('an update adds missing lines right under the header', () => {
    const before = '[mcp_servers.memory-kit]\nargs = ["/v/system/memory.mjs"]\nenabled = false\n';
    const res = plan(before);
    assert.equal(res.action, 'update');
    assert.equal(res.text, `[mcp_servers.memory-kit]\ncommand = "${NODE}"\n${block.split('\n')[2]}\nenabled = false\n`);
    const bare = plan('[mcp_servers."memory-kit"]\nargs = ["/v/system/memory.mjs"]');
    assert.equal(bare.text, `[mcp_servers."memory-kit"]\ncommand = "${NODE}"\n${block.split('\n')[2]}`, 'quoted header kept, no newline added at the end');
  });

  test('a foreign server of the same name: conflict, --force replaces it and its sub-tables', () => {
    const before = 'x = 1\n\n[mcp_servers.memory-kit]\ncommand = "other"\n\n[mcp_servers.memory-kit.env]\nK = "v"\n\n[mcp_servers.github]\ncommand = "gh"\n';
    assert.equal(plan(before).action, 'conflict');
    assert.equal(plan(before, { remove: true }).action, 'conflict');
    const forced = plan(before, { force: true });
    assert.equal(forced.action, 'replace');
    assert.equal(forced.text, `x = 1\n\n${block}\n[mcp_servers.github]\ncommand = "gh"\n`);
    // Only a sub-table (no main table): it goes and ours is appended.
    const subOnly = plan('[mcp_servers.memory-kit.env]\nK = "v"\n\n[other]\na = 1\n', { force: true });
    assert.equal(subOnly.action, 'replace');
    assert.equal(subOnly.text, `[other]\na = 1\n\n${block}`);
    const removed = plan(before, { remove: true, force: true });
    assert.equal(removed.text, 'x = 1\n\n[mcp_servers.github]\ncommand = "gh"\n');
  });

  test('forms connect does not edit are refused with the block to paste, but still read', () => {
    const inline = `[mcp_servers]\nmemory-kit = { command = "${NODE}", args = ["/v/system/memory.mjs", "mcp"] }\n`;
    assert.equal(tomlServers(scanToml(inline))['memory-kit'].command, NODE);
    const forms = [
      inline,
      '[mcp_servers]\nmemory-kit.command = "x"\n',
      'mcp_servers = { github = { command = "gh" } }\n',
      'mcp_servers.memory-kit.command = "x"\n',
      '[[mcp_servers]]\nname = "x"\n',
    ];
    for (const text of forms) {
      const res = plan(text, { force: true });
      assert.equal(res.action, 'refused', text);
      assert.equal(res.reason, 'form', text);
      assert.equal(res.snippet, block);
    }
    // Dotted keys for another server leave room for our own table.
    const dotted = '[mcp_servers]\ngithub.command = "gh"\n';
    assert.equal(plan(dotted).text, `${dotted}\n${block}`);
  });

  test('CRLF files and a BOM stay as they are', () => {
    const crlf = 'a = 1\r\n\r\n[mcp_servers.github]\r\ncommand = "gh"\r\n';
    const added = plan(crlf).text;
    assert.equal(added, `${crlf}\r\n${block.replace(/\n/g, '\r\n')}`);
    assert.equal(plan(added, { remove: true }).text, crlf);
    const bom = '\uFEFFa = 1\n';
    const withBom = plan(bom).text;
    assert.ok(withBom.startsWith('\uFEFFa = 1\n\n[mcp_servers.memory-kit]'));
    assert.equal(plan(withBom, { remove: true }).text, bom);
  });

  test('another name already serving this vault', () => {
    const other = tomlBlock('memory', built.owned);
    assert.equal(plan(other).action, 'connected-as');
    assert.equal(plan(other, { force: true }).action, 'add');
    assert.deepEqual(plan(other, { remove: true }).others, ['memory']);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Windows command line and finding executables', () => {
  /** cmd.exe's second phase on our line: carets escape outside quotes; specials must be escaped. */
  function cmdPhase(line) {
    let out = '';
    let quote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '^' && !quote) {
        out += line[++i];
        continue;
      }
      if (c === '"') quote = !quote;
      else if (!quote && '&|<>()'.includes(c)) throw new Error(`unescaped ${c} at ${i}`);
      out += c;
    }
    return out;
  }
  /** A batch file's %* hands the text on; cmd parses the line again, now with real quotes. */
  function batchPhase(line) {
    let quote = false;
    for (const c of line) {
      if (c === '"') quote = !quote;
      else if (!quote && '&|<>()^%!'.includes(c)) throw new Error(`special ${c} outside quotes`);
    }
    return line;
  }
  /** How the C runtime (node.exe) splits a command line. */
  function parseMsvcrt(line) {
    const args = [];
    let i = 0;
    while (i < line.length) {
      while (line[i] === ' ' || line[i] === '\t') i++;
      if (i >= line.length) break;
      let arg = '';
      let quote = false;
      while (i < line.length) {
        const c = line[i];
        if (c === '\\') {
          let k = 0;
          while (line[i] === '\\') {
            k++;
            i++;
          }
          if (line[i] === '"') {
            arg += '\\'.repeat(Math.floor(k / 2));
            if (k % 2) {
              arg += '"';
              i++;
            }
          } else {
            arg += '\\'.repeat(k);
          }
          continue;
        }
        if (c === '"') {
          quote = !quote;
          i++;
          continue;
        }
        if (!quote && (c === ' ' || c === '\t')) break;
        arg += c;
        i++;
      }
      args.push(arg);
    }
    return args;
  }

  const file = 'C:\\Users\\my user\\AppData\\Roaming\\npm\\claude.cmd';

  test('the command line for a .cmd shim, exactly', () => {
    const line = windowsCommandLine(file, ['mcp', 'add', '--', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\A&B (x)\\v\\']);
    assert.equal(line, '"C:\\Users\\my user\\AppData\\Roaming\\npm\\claude.cmd" ^"mcp^" ^"add^" ^"--^" ^"C:\\Program^ Files\\nodejs\\node.exe^" ^"C:\\A^&B^ ^(x^)\\v\\\\^"');
  });

  test('every argument arrives unchanged, whatever a Windows path may hold', () => {
    const args = claudeAddArgs('memory-kit', {
      command: 'C:\\Program Files (x86)\\nodejs\\node.exe',
      args: [
        'C:\\Users\\R&D\\100% ^done!\\Žluťoučký 日本\\vault\\system\\memory.mjs', 'mcp', '--root',
        'C:\\Users\\R&D\\100% ^done!\\Žluťoučký 日本\\vault\\', '--read-only', 'a;b,c=d', '[x]`y\'', '',
      ],
    });
    const line = windowsCommandLine(file, args);
    // Percent signs never form a variable reference cmd would expand: each one has a caret.
    for (const m of line.matchAll(/%/g)) assert.equal(line[m.index - 1], '^');
    const afterCmd = cmdPhase(line);
    const [shim, ...rest] = parseMsvcrt(afterCmd);
    assert.equal(shim, file);
    assert.deepEqual(rest, args);
    // The shim runs "node" "cli.js" %*: the same text, parsed again by cmd and by node.
    const tail = afterCmd.slice(afterCmd.indexOf('claude.cmd"') + 'claude.cmd"'.length);
    assert.deepEqual(parseMsvcrt(batchPhase(tail)), args);
  });

  test('values that cannot pass safely give null (the file is written instead)', () => {
    assert.equal(windowsCommandLine(file, ['say "hi"']), null);
    assert.equal(windowsCommandLine(file, ['a\nb']), null);
    assert.equal(windowsCommandLine('C:\\100%\\claude.cmd', ['x']), null);
    assert.equal(windowsCommandLine('C:\\a"b\\claude.cmd', ['x']), null);
  });

  test('spawnSpec: cmd.exe for .cmd and .bat, directly for everything else', () => {
    const viaCmd = spawnSpec(file, ['mcp', 'list'], { platform: 'win32', env: { comspec: 'C:\\Windows\\system32\\cmd.exe' } });
    assert.equal(viaCmd.command, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepEqual(viaCmd.args.slice(0, 4), ['/d', '/v:off', '/s', '/c']);
    assert.equal(viaCmd.args[4], `"${windowsCommandLine(file, ['mcp', 'list'])}"`);
    assert.equal(viaCmd.options.windowsVerbatimArguments, true);
    assert.equal(viaCmd.options.windowsHide, true);
    assert.equal(spawnSpec('C:\\x\\CLAUDE.BAT', ['a'], { platform: 'win32', env: {} }).command, 'cmd.exe');
    const exe = spawnSpec('C:\\Users\\me\\.local\\bin\\claude.exe', ['mcp', 'list'], { platform: 'win32', env: {} });
    assert.deepEqual([exe.command, exe.args, exe.options.windowsVerbatimArguments], ['C:\\Users\\me\\.local\\bin\\claude.exe', ['mcp', 'list'], undefined]);
    const posix = spawnSpec('/usr/local/bin/claude', ['mcp'], { platform: 'linux', env: {} });
    assert.deepEqual([posix.command, posix.args], ['/usr/local/bin/claude', ['mcp']]);
    assert.equal(spawnSpec(file, ['bad "quote"'], { platform: 'win32', env: {} }), null);
  });

  test('the claude arguments put -- before the server command', () => {
    const args = claudeAddArgs('memory-kit', { command: NODE, args: ['/v/system/memory.mjs', 'mcp', '--root', '/v'] });
    assert.deepEqual(args, ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'memory-kit', '--', NODE, '/v/system/memory.mjs', 'mcp', '--root', '/v']);
    assert.deepEqual(claudeRemoveArgs('memory-kit'), ['mcp', 'remove', '--scope', 'user', 'memory-kit']);
  });

  test('findExecutable on Windows: PATHEXT order, runnable kinds only, quoted entries', () => {
    const files = new Set([
      'C:\\a\\claude.ps1', 'C:\\a\\claude.js',
      'C:\\b b\\claude.cmd', 'C:\\b b\\claude.exe',
      'C:\\c\\claude.cmd',
    ]);
    const io = { isFile: (p) => files.has(p), isExecutable: () => false };
    const env = { Path: 'rel\\dir;C:\\a;"C:\\b b";C:\\c', PATHEXT: '.COM;.EXE;.BAT;.CMD;.JS;.PS1' };
    assert.equal(findExecutable('claude', { platform: 'win32', env, io }), 'C:\\b b\\claude.exe');
    files.delete('C:\\b b\\claude.exe');
    assert.equal(findExecutable('claude', { platform: 'win32', env, io }), 'C:\\b b\\claude.cmd');
    assert.equal(findExecutable('claude', { platform: 'win32', env: {}, io }), null);
  });

  test('findExecutable on POSIX needs the execute bit', { skip: IS_WIN && 'no execute bit on Windows' }, () => {
    const dir = tmpDir('which');
    const plain = put(path.join(dir, 'a', 'claude'), 'x');
    const bin = put(path.join(dir, 'b', 'claude'), '#!/bin/sh\n');
    fs.chmodSync(plain, 0o644);
    fs.chmodSync(bin, 0o755);
    const env = { PATH: ['relative', path.dirname(plain), path.dirname(bin)].join(':') };
    assert.equal(findExecutable('claude', { platform: 'linux', env }), bin);
    assert.equal(findExecutable('nothing-here', { platform: 'linux', env }), null);
  });
});

// ---------------------------------------------------------------------------------------------

describe('connectClient on simulated systems', () => {
  const NOW = new Date(2026, 8, 24, 10, 11, 12);
  const base = (vault, home, extra = {}) => ({
    vault, name: 'memory-kit', platform: 'linux', env: {}, home, pathMod: path, execPath: NODE, now: NOW, findCli: () => null, ...extra,
  });
  const keysKnown = (res) => {
    for (const key of messageKeys(res)) assert.ok(Object.hasOwn(MESSAGES, key), `message ${key} has an English text`);
  };

  test('Windows, Claude Desktop from the Store: merges into the private copy and backs it up', () => {
    const vault = makeVault();
    const home = tmpDir('sim-win');
    const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
    const real = put(path.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'), '{"mcpServers": {"real": {"command": "x"}}}');
    const privateText = '{\n  "preferences": {"sidebarMode": "chat"},\n  "mcpServers": {"fs": {"command": "npx", "args": ["fs"]}}\n}\n';
    const priv = put(path.join(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'), privateText);
    const res = connectClient({ ...base(vault, home, { platform: 'win32', env }), client: 'claude-desktop' });
    keysKnown(res);
    assert.equal(res.action, 'add');
    assert.equal(res.exit, 0);
    assert.deepEqual(res.targets.map((t) => t.path), [priv]);
    const after = json(priv);
    assert.deepEqual(after.preferences, { sidebarMode: 'chat' });
    assert.deepEqual(after.mcpServers.fs, { command: 'npx', args: ['fs'] });
    assert.deepEqual(Object.keys(after.mcpServers['memory-kit']), ['command', 'args']);
    assert.equal(read(real), '{"mcpServers": {"real": {"command": "x"}}}', 'the real file is left alone');
    assert.equal(path.basename(res.targets[0].backup), 'claude-desktop-20260924-101112.json');
    assert.equal(read(res.targets[0].backup), privateText);
    assert.ok(messageKeys(res).includes('connect.msix'));
    assert.ok(messageKeys(res).includes('connect.next'));
  });

  test('Windsurf with both files: both get the same entry; a conflict in one writes neither', () => {
    const vault = makeVault();
    const home = tmpDir('sim-ws');
    const [devin, legacy] = resolveClient('windsurf', { platform: 'darwin', home, env: {}, pathMod: path }).candidates.map((c) => c.path);
    put(devin, '{"mcpServers": {}}');
    put(legacy, '{"mcpServers": {"memory-kit": {"command": "someone-else"}}}');
    const blocked = connectClient({ ...base(vault, home, { platform: 'darwin' }), client: 'windsurf' });
    assert.equal(blocked.action, 'conflict');
    assert.equal(blocked.exit, 1);
    assert.equal(read(devin), '{"mcpServers": {}}');
    assert.equal(fs.existsSync(path.join(vault, '.memory-kit')), false, 'no backup when nothing is written');
    const forced = connectClient({ ...base(vault, home, { platform: 'darwin' }), client: 'windsurf', force: true });
    assert.equal(forced.action, 'replace');
    assert.deepEqual(json(devin).mcpServers['memory-kit'], json(legacy).mcpServers['memory-kit']);
    assert.deepEqual(forced.targets.map((t) => t.action), ['add', 'replace']);
    assert.equal(new Set(forced.targets.map((t) => t.backup)).size, 2, 'one backup per file');
  });

  test('app not found: refused unless --force, which creates the folders', () => {
    const vault = makeVault();
    const home = tmpDir('sim-none');
    const res = connectClient({ ...base(vault, home), client: 'zed' });
    assert.equal(res.action, 'app-not-found');
    assert.equal(res.exit, 1);
    assert.equal(fs.existsSync(path.join(home, '.config')), false);
    const forced = connectClient({ ...base(vault, home), client: 'zed', force: true });
    assert.equal(forced.action, 'add');
    assert.equal(forced.targets[0].created, true);
    assert.ok(json(path.join(home, '.config', 'zed', 'settings.json')).context_servers['memory-kit']);
    const rm = connectClient({ ...base(vault, tmpDir('sim-none2')), client: 'zed', remove: true });
    assert.equal(rm.action, 'absent');
    assert.equal(rm.exit, 0);
  });

  test('project scope: a portable entry in the vault for cursor and vscode only', () => {
    const vault = makeVault();
    const home = tmpDir('sim-proj');
    const res = connectClient({ ...base(vault, home), client: 'vscode', scope: 'project' });
    assert.equal(res.action, 'add');
    const entry = json(path.join(vault, '.vscode', 'mcp.json')).servers['memory-kit'];
    assert.deepEqual(entry, { type: 'stdio', command: 'node', args: [PORTABLE_SCRIPT, 'mcp', '--root', '${workspaceFolder}'] });
    assert.ok(messageKeys(res).includes('connect.project'));
    assert.equal(connectClient({ ...base(vault, home), client: 'vscode', scope: 'project' }).action, 'unchanged');
    const listed = inspectClient('vscode', { vault, platform: 'linux', env: {}, home, pathMod: path });
    assert.equal(listed.state, 'connected');
    assert.deepEqual(listed.entries.map((e) => [e.scope, e.name]), [['project', 'memory-kit']]);
    for (const id of ['codex', 'claude-code', 'zed']) {
      const refused = connectClient({ ...base(vault, home), client: id, scope: 'project' });
      assert.equal(refused.action, 'scope', id);
      assert.equal(refused.exit, 1);
    }
  });

  test('dry run: nothing written, no backup; the plan shows the entry', () => {
    const vault = makeVault();
    const home = tmpDir('sim-dry');
    const file = put(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers": {}}');
    const res = connectClient({ ...base(vault, home), client: 'cursor', dryRun: true });
    assert.equal(res.action, 'add');
    assert.equal(read(file), '{"mcpServers": {}}');
    assert.equal(fs.existsSync(path.join(vault, '.memory-kit')), false);
    assert.deepEqual(messageKeys(res), ['connect.plan.add', 'connect.dry_run']);
    const raw = res.messages.find((m) => m.raw !== undefined).raw;
    assert.deepEqual(JSON.parse(`{${raw}}`)['memory-kit'].args[0], path.join(vault, 'system', 'memory.mjs'));
    assert.equal(res.targets[0].written, false);
  });

  test('a file that changes during connect is not overwritten', () => {
    const vault = makeVault();
    const home = tmpDir('sim-race');
    const file = put(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers": {}}');
    let reads = 0;
    const io = {
      isFile: (p) => fs.existsSync(p) && fs.statSync(p).isFile(),
      isDir: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
      readdir: (p) => (fs.existsSync(p) ? fs.readdirSync(p) : []),
      mtime: () => 0,
      realpath: (p) => (fs.existsSync(p) ? fs.realpathSync(p) : null),
      readText: (p) => {
        const text = fs.readFileSync(p, 'utf8');
        return p === file && ++reads > 1 ? `${text} ` : text;
      },
    };
    const res = connectClient({ ...base(vault, home), client: 'cursor', io });
    assert.equal(res.action, 'changed');
    assert.equal(res.exit, 1);
    assert.equal(read(file), '{"mcpServers": {}}');
  });

  test('a file that cannot be written is reported, not a crash', { skip: IS_WIN && 'Windows retries a locked target for seconds' }, () => {
    const vault = makeVault();
    const home = tmpDir('sim-locked');
    // A folder where the file should be: the final rename fails at once.
    fs.mkdirSync(path.join(home, '.cursor', 'mcp.json'), { recursive: true });
    const res = connectClient({ ...base(vault, home), client: 'cursor' });
    assert.equal(res.action, 'failed');
    assert.equal(res.exit, 1);
    assert.ok(messageKeys(res).includes('connect.write_failed'));
    assert.deepEqual(fs.readdirSync(path.join(home, '.cursor')), ['mcp.json'], 'no temporary file left behind');
  });

  test('a config that cannot be read is refused with the entry to paste, not a crash', () => {
    // A root-owned ~/.claude.json left by `sudo claude`, or a file another program locks.
    const vault = makeVault();
    const home = tmpDir('sim-unreadable');
    const built = (id) => buildEntry(id, { command: NODE, args: serverArgs(vault, { pathMod: path }) });
    const deny = (...files) => ({
      ...IO,
      readText: (p) => {
        if (files.includes(p)) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
        return IO.readText(p);
      },
    });
    const cursor = put(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers": {}}');
    const res = connectClient({ ...base(vault, home), client: 'cursor', io: deny(cursor) });
    keysKnown(res);
    assert.deepEqual([res.action, res.exit, res.ok], ['refused', 1, false]);
    assert.deepEqual(res.targets, [{ path: cursor, format: 'json', exists: true, action: 'refused', reason: 'read', error: 'EACCES', written: false }]);
    assert.deepEqual(messageKeys(res), ['connect.unreadable']);
    assert.match(renderResult(res, null)[0], /mcp\.json cannot be read \(EACCES\)\. Fix it, or add this yourself:$/);
    assert.deepEqual(JSON.parse(`{${res.snippet}}`).mcpServers['memory-kit'], built('cursor').full);
    assert.equal(read(cursor), '{"mcpServers": {}}');
    assert.equal(fs.existsSync(path.join(vault, '.memory-kit')), false, 'no backup');
    for (const extra of [{ dryRun: true }, { force: true }]) {
      assert.equal(connectClient({ ...base(vault, home), client: 'cursor', io: deny(cursor), ...extra }).action, 'refused');
    }

    // --remove cannot tell whether the entry is there: it says so, without a snippet.
    const rm = connectClient({ ...base(vault, home), client: 'cursor', io: deny(cursor), remove: true });
    assert.deepEqual([rm.action, rm.exit], ['refused', 1]);
    assert.deepEqual(messageKeys(rm), ['connect.unreadable_remove']);
    assert.equal(rm.snippet, undefined);
    assert.match(renderResult(rm, null)[0], /cannot be read \(EACCES\), so "memory-kit" cannot be removed from it/);

    // Codex: the TOML block to paste.
    const toml = put(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n');
    const codex = connectClient({ ...base(vault, home), client: 'codex', io: deny(toml) });
    assert.deepEqual([codex.action, codex.exit, codex.targets[0].reason], ['refused', 1, 'read']);
    assert.equal(codex.snippet, tomlBlock('memory-kit', built('codex').owned));

    // Claude Code: neither its command nor the file path can go on.
    const claudeFile = put(path.join(home, '.claude.json'), '{}');
    const spawned = [];
    const viaCli = connectClient({
      ...base(vault, home), client: 'claude-code', io: deny(claudeFile), findCli: () => '/bin/claude', spawn: (...a) => spawned.push(a),
    });
    assert.deepEqual([viaCli.method, viaCli.action, viaCli.exit], ['cli', 'refused', 1]);
    assert.deepEqual(spawned, [], 'the claude command is not run');
    assert.deepEqual(viaCli.targets.map((t) => [t.exists, t.reason, t.error]), [[true, 'read', 'EACCES']]);
    assert.deepEqual(messageKeys(viaCli), ['connect.unreadable']);
    assert.deepEqual(JSON.parse(`{${viaCli.snippet}}`).mcpServers['memory-kit'], built('claude-code').full);
    const viaFile = connectClient({ ...base(vault, home), client: 'claude-code', io: deny(claudeFile) });
    assert.deepEqual([viaFile.method, viaFile.action, viaFile.exit], ['file', 'refused', 1]);
    assert.equal(read(claudeFile), '{}');

    // Readable when planned, unreadable just before the write: not written.
    let reads = 0;
    const late = {
      ...IO,
      readText: (p) => {
        if (p === cursor && ++reads > 1) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        return IO.readText(p);
      },
    };
    const changed = connectClient({ ...base(vault, home), client: 'cursor', io: late });
    assert.deepEqual([changed.action, changed.exit], ['changed', 1]);
    assert.equal(read(cursor), '{"mcpServers": {}}');
  });

  test('Windsurf: the old folder linked to the new one is one file, written once', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const vault = makeVault();
    const home = tmpDir('sim-ws-link');
    const [devin, legacy] = resolveClient('windsurf', { platform: 'linux', home, env: {}, pathMod: path }).candidates.map((c) => c.path);
    put(devin, '{"mcpServers": {"x": {"command": "y"}}}');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(legacy), devin), legacy);
    const opts = { ...base(vault, home), client: 'windsurf' };
    const res = connectClient(opts);
    keysKnown(res);
    assert.deepEqual([res.action, res.exit], ['add', 0]);
    assert.deepEqual(res.targets.map((t) => [t.path, t.action, t.written]), [[devin, 'add', true]]);
    assert.equal(messageKeys(res)[0], 'connect.same_file');
    assert.ok(!messageKeys(res).includes('connect.changed'));
    assert.ok(fs.lstatSync(legacy).isSymbolicLink(), 'the link stays');
    assert.deepEqual(Object.keys(json(legacy).mcpServers), ['x', 'memory-kit']);
    assert.equal(fs.readdirSync(path.join(vault, '.memory-kit', 'backups', 'connect')).length, 1, 'one backup');
    assert.equal(connectClient(opts).action, 'unchanged');
    const rm = connectClient({ ...opts, remove: true });
    assert.deepEqual([rm.action, rm.exit], ['remove', 0]);
    assert.deepEqual(json(devin), { mcpServers: { x: { command: 'y' } } });
    assert.equal(connectClient({ ...opts, remove: true }).action, 'absent');
    // --list reads the file once too.
    assert.equal(connectClient(opts).exit, 0);
    const row = listClients({ vault, platform: 'linux', env: {}, home, pathMod: path }).clients.find((c) => c.id === 'windsurf');
    assert.equal(row.state, 'connected');
    assert.deepEqual(row.entries.map((e) => e.path), [devin]);
  });

  test('a dangling symlink: the new file goes where the link leads, the link stays', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const vault = makeVault();
    const home = tmpDir('sim-dangling');
    // ~/.cursor is itself a linked folder, and mcp.json a chain of two relative links; a
    // relative link counts from the real folder it is in, as the system reads it.
    fs.mkdirSync(path.join(home, 'cfg', 'cursor'), { recursive: true });
    fs.symlinkSync(path.join('cfg', 'cursor'), path.join(home, '.cursor'));
    fs.mkdirSync(path.join(home, 'dotfiles', 'real'), { recursive: true });
    fs.symlinkSync(path.join('..', '..', 'dotfiles', 'hop.json'), path.join(home, 'cfg', 'cursor', 'mcp.json'));
    fs.symlinkSync(path.join('real', 'cursor.json'), path.join(home, 'dotfiles', 'hop.json'));
    const link = path.join(home, '.cursor', 'mcp.json');
    const real = path.join(fs.realpathSync(home), 'dotfiles', 'real', 'cursor.json');
    assert.equal(writeTarget(link), real);

    const dry = connectClient({ ...base(vault, home), client: 'cursor', dryRun: true });
    assert.deepEqual([dry.action, dry.exit], ['add', 0]);
    assert.equal(fs.existsSync(real), false);

    const res = connectClient({ ...base(vault, home), client: 'cursor' });
    keysKnown(res);
    assert.deepEqual([res.action, res.exit], ['add', 0]);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
    assert.ok(fs.lstatSync(path.join(home, 'dotfiles', 'hop.json')).isSymbolicLink(), 'so does the next one');
    assert.deepEqual(json(real).mcpServers['memory-kit'], buildEntry('cursor', { command: NODE, args: serverArgs(vault, { pathMod: path }) }).full);
    assert.equal(res.targets[0].created, true);
    assert.ok(messageKeys(res).includes('connect.new_file_link'));
    assert.ok(!messageKeys(res).includes('connect.new_file'));
    assert.ok(renderResult(res, null).includes(`${link} is a link, so the new file is ${real}; to undo, delete ${real}`));
    assert.equal(connectClient({ ...base(vault, home), client: 'cursor' }).action, 'unchanged');
  });

  test('a dangling symlink into a missing folder is refused; a link loop too', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const vault = makeVault();
    const home = tmpDir('sim-dangling-dir');
    fs.mkdirSync(path.join(home, '.cursor'));
    const link = path.join(home, '.cursor', 'mcp.json');
    fs.symlinkSync(path.join('..', 'unmounted', 'dotfiles', 'cursor.json'), link);
    for (const extra of [{}, { dryRun: true }, { force: true }]) {
      const res = connectClient({ ...base(vault, home), client: 'cursor', ...extra });
      keysKnown(res);
      assert.deepEqual([res.action, res.exit, res.targets[0].reason], ['refused', 1, 'link']);
      assert.deepEqual(messageKeys(res), ['connect.dangling']);
    }
    const text = renderResult(connectClient({ ...base(vault, home), client: 'cursor' }), null)[0];
    assert.match(text, /mcp\.json is a link to .*unmounted.dotfiles.cursor\.json, whose folder does not exist; create that folder or remove the link/);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.existsSync(path.join(home, 'unmounted')), false, 'no folder is made');
    assert.equal(connectClient({ ...base(vault, home), client: 'cursor', remove: true }).action, 'absent');

    fs.rmSync(link);
    fs.symlinkSync('mcp.json', link);
    assert.throws(() => writeTarget(link), { code: 'ELOOP' });
    const loop = connectClient({ ...base(vault, home), client: 'cursor' });
    assert.deepEqual([loop.action, loop.exit, loop.targets[0].reason, loop.targets[0].error], ['refused', 1, 'read', 'ELOOP']);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
  });

  test('not a vault', () => {
    const empty = tmpDir('sim-novault');
    const res = connectClient({ ...base(empty, tmpDir('sim-h')), client: 'cursor' });
    assert.equal(res.action, 'not-vault');
    assert.equal(res.exit, 1);
  });

  test('guidance-only clients', () => {
    const vault = makeVault();
    const chat = connectClient({ ...base(vault, tmpDir('g')), client: 'chatgpt' });
    assert.deepEqual([chat.action, chat.exit, chat.method], ['guidance', 0, 'guidance']);
    assert.match(renderResult(chat, null)[0], /connect codex/);
    const web = connectClient({ ...base(vault, tmpDir('g2')), client: 'claude-web' });
    assert.equal(web.client, 'claude-app');
    assert.match(renderResult(web, null)[0], /docs\/integrations\/claude-app\.md/);
    const jb = connectClient({ ...base(vault, tmpDir('g3')), client: 'jetbrains' });
    assert.deepEqual(JSON.parse(`{${jb.snippet}}`).mcpServers['memory-kit'].args, serverArgs(vault, { pathMod: path }));
  });

  test('Claude Code through its command on Windows: cmd.exe for the shim, remove then add to update', () => {
    const vault = makeVault();
    const home = tmpDir('sim-cc');
    const configFile = path.join(home, '.claude.json');
    const calls = [];
    const shim = path.join(home, 'npm', 'claude.cmd');
    // A fake claude: records the call and edits the file as the real one would.
    const spawn = (command, args, options) => {
      calls.push({ command, args, options });
      const line = args[4].slice(1, -1).replace(/\^(.)/g, '$1');
      const argv = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\\\/g, '\\')).slice(1);
      const cfg = fs.existsSync(configFile) ? json(configFile) : {};
      cfg.mcpServers ??= {};
      const name = argv[1] === 'add' ? argv[argv.indexOf('--') - 1] : argv[argv.length - 1];
      if (argv[1] === 'add') {
        const sep = argv.indexOf('--');
        const vars = {};
        for (let i = 2; i < sep; i++) {
          if (argv[i] === '-e') {
            const [k, ...v] = argv[++i].split('=');
            vars[k] = v.join('=');
          }
        }
        const [cmd, ...rest] = argv.slice(sep + 1);
        cfg.mcpServers[name] = { type: 'stdio', command: cmd, args: rest, env: vars };
      } else {
        delete cfg.mcpServers[name];
      }
      fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
      return { status: 0, stdout: '', stderr: '' };
    };
    const opts = { ...base(vault, home, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }), client: 'claude-code', spawn, findCli: () => shim };
    put(configFile, JSON.stringify({ numStartups: 5, mcpServers: { other: { command: 'x' } } }));
    const res = connectClient(opts);
    keysKnown(res);
    assert.equal(res.method, 'cli');
    assert.equal(res.action, 'add');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
    assert.equal(calls[0].options.windowsHide, true);
    assert.deepEqual(res.commands, [['claude', ...claudeAddArgs('memory-kit', { command: NODE, args: serverArgs(vault, { pathMod: path }) })]]);
    assert.equal(json(configFile).numStartups, 5);
    assert.ok(res.targets[0].backup, 'the file is backed up before the command changes it');
    assert.ok(!messageKeys(res).includes('connect.cli.unverified'));
    assert.equal(res.messages.find((m) => m.key === 'connect.next').vars.textKey, 'connect.next.claude-code');

    assert.equal(connectClient(opts).action, 'unchanged');
    assert.equal(calls.length, 1, 'nothing to run when already connected');

    // An update is remove and add; env variables the owner set go along as -e.
    const withEnv = json(configFile);
    withEnv.mcpServers['memory-kit'].env = { MEMORY_SECTORS: 'work,school' };
    fs.writeFileSync(configFile, JSON.stringify(withEnv, null, 2));
    const ro = connectClient({ ...opts, readOnly: true });
    assert.equal(ro.action, 'update');
    assert.deepEqual(ro.commands.map((c) => c[2]), ['remove', 'add']);
    assert.deepEqual(ro.commands[1].slice(0, 5), ['claude', 'mcp', 'add', '-e', 'MEMORY_SECTORS=work,school']);
    assert.deepEqual(json(configFile).mcpServers['memory-kit'].args.slice(-1), ['--read-only']);
    assert.deepEqual(json(configFile).mcpServers['memory-kit'].env, { MEMORY_SECTORS: 'work,school' });

    // A setting the command cannot pass on: the file is merged instead, nothing is lost.
    const withTimeout = json(configFile);
    withTimeout.mcpServers['memory-kit'].timeout = 30000;
    fs.writeFileSync(configFile, JSON.stringify(withTimeout, null, 2));
    const before = calls.length;
    const merged = connectClient({ ...opts, readOnly: false });
    assert.equal(merged.method, 'file');
    assert.equal(merged.action, 'update');
    assert.equal(calls.length, before, 'the command was not run');
    assert.ok(messageKeys(merged).includes('connect.cli.fields'));
    const kept = json(configFile).mcpServers['memory-kit'];
    assert.equal(kept.timeout, 30000);
    assert.deepEqual(kept.env, { MEMORY_SECTORS: 'work,school' });
    assert.equal(kept.args.includes('--read-only'), false);

    const failing = connectClient({ ...opts, remove: true, spawn: () => ({ status: 1, stdout: '', stderr: 'warning\nError: no such server\n' }) });
    assert.equal(failing.action, 'failed');
    assert.equal(failing.exit, 1);
    assert.equal(failing.messages.find((m) => m.key === 'connect.cli.failed').vars.detail, 'Error: no such server');

    const removed = connectClient({ ...opts, remove: true });
    assert.equal(removed.action, 'remove');
    assert.deepEqual(Object.keys(json(configFile).mcpServers), ['other']);
  });

  test('Claude Code without its command: the user entry goes into .claude.json (CLAUDE_CONFIG_DIR)', () => {
    const vault = makeVault();
    const home = tmpDir('sim-ccfile');
    const dir = path.join(home, 'cc-config');
    fs.mkdirSync(dir);
    const res = connectClient({ ...base(vault, home, { env: { CLAUDE_CONFIG_DIR: dir } }), client: 'claude-code' });
    assert.equal(res.method, 'file');
    assert.equal(res.action, 'add');
    assert.deepEqual(json(path.join(dir, '.claude.json')).mcpServers['memory-kit'], { type: 'stdio', command: NODE, args: serverArgs(vault, { pathMod: path }), env: {} });
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
    assert.equal(messageKeys(res)[0], 'connect.cli.fallback');
    assert.equal(res.messages.find((m) => m.key === 'connect.next').vars.textKey, 'connect.next.claude-code-file');
  });
});

// ---------------------------------------------------------------------------------------------

describe('messages', () => {
  test('every client with a file has next and check texts; every guide has its text', () => {
    for (const c of CLIENTS) {
      if (c.guide) assert.ok(MESSAGES[`connect.guide.${c.guide}`], c.id);
      else {
        assert.ok(MESSAGES[`connect.next.${c.id}`], `next ${c.id}`);
        assert.ok(MESSAGES[`connect.check.${c.id}`], `check ${c.id}`);
      }
    }
    for (const state of ['connected', 'not-connected', 'app-not-found', 'guidance', 'unreadable']) assert.ok(MESSAGES[`connect.state.${state}`]);
  });

  test('a pack translation wins, the English default fills the gaps', () => {
    const cfg = { t: (key, vars) => (key === 'connect.added' ? `přidáno ${vars.name}` : key) };
    assert.equal(say(cfg, 'connect.added', { name: 'x' }), 'přidáno x');
    assert.equal(say(cfg, 'connect.removed', { client: 'Cursor', name: 'x', path: '/p' }), 'Cursor: removed "x" from /p');
    assert.equal(say(null, 'connect.project'), MESSAGES['connect.project'], '${workspaceFolder} stays as it is');
  });
});

// ---------------------------------------------------------------------------------------------

describe('connect --list and the readers', () => {
  test('states per client, other vaults and unreadable files', () => {
    const vault = makeVault();
    const home = tmpDir('list');
    const sys = { platform: 'linux', env: {}, home, pathMod: path };
    const args = serverArgs(vault, { pathMod: path });
    put(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { mem: { command: NODE, args } } }));
    put(path.join(home, '.codex', 'config.toml'), '[mcp_servers.memory-kit]\ncommand = "node"\nargs = ["/elsewhere/system/memory.mjs", "mcp", "--root", "/elsewhere"]\n');
    fs.mkdirSync(path.join(home, '.gemini'));
    put(path.join(home, '.copilot', 'mcp-config.json'), '{ broken');
    const list = listClients({ vault, ...sys });
    const state = Object.fromEntries(list.clients.map((c) => [c.id, c.state]));
    assert.equal(state.cursor, 'connected');
    assert.equal(state.codex, 'not-connected');
    assert.equal(state['gemini-cli'], 'not-connected');
    assert.equal(state['copilot-cli'], 'unreadable');
    assert.equal(state.zed, 'app-not-found');
    assert.equal(state.chatgpt, 'guidance');
    const codex = list.clients.find((c) => c.id === 'codex');
    assert.deepEqual(codex.entries, [{ name: 'memory-kit', path: path.join(home, '.codex', 'config.toml'), scope: 'user', kind: 'kit', root: '/elsewhere' }]);
    assert.equal(list.clients.find((c) => c.id === 'copilot-cli').errors.length, 1);
    const text = formatList(list, null);
    assert.match(text, /^MCP clients for /);
    assert.match(text, /\n {2}cursor +connected +Cursor · /);
    assert.match(text, /codex +not connected +Codex · .*another vault: \/elsewhere/);
    assert.match(text, /chatgpt +guidance only +ChatGPT · –/);
    // Without a vault the readers still work (doctor may call them early).
    assert.equal(inspectClients({ ...sys }).find((c) => c.id === 'cursor').state, 'not-connected');
  });

  test('Claude Code counts as installed when its command is on PATH', () => {
    const home = tmpDir('list-cc');
    const sys = { platform: 'linux', env: {}, home, pathMod: path };
    assert.equal(inspectClients({ ...sys, findCli: () => null }).find((c) => c.id === 'claude-code').state, 'app-not-found');
    assert.equal(inspectClients({ ...sys, findCli: () => '/bin/claude' }).find((c) => c.id === 'claude-code').state, 'not-connected');
  });
});

// ---------------------------------------------------------------------------------------------

describe('connect CLI', () => {
  test('usage errors exit 2', () => {
    const vault = makeVault();
    const home = tmpDir('cli-usage');
    for (const args of [[], ['nope'], ['cursor', 'codex'], ['cursor', '--scope', 'global'], ['cursor', '--name', 'memory_kit'], ['--list', 'cursor'], ['--list', '--remove'], ['cursor', '--bogus']]) {
      const res = runConnect(vault, args, { home });
      assert.equal(res.code, 2, `${args.join(' ')}\n${res.stderr}`);
      assert.match(res.stderr, /usage: node system\/memory\.mjs connect/);
    }
    assert.match(runConnect(vault, ['nope'], { home }).stderr, /known clients: claude-code, claude-desktop/);
  });

  test('connect, again, --json, --remove: other servers stay; backups are private copies', () => {
    const vault = makeVault();
    const home = tmpDir('cli-cursor');
    const file = put(path.join(home, '.cursor', 'mcp.json'), '{\n    "mcpServers": {\n        "gh": {"command": "gh"}\n    }\n}\n');
    if (!IS_WIN) fs.chmodSync(file, 0o600);
    const first = runConnect(vault, ['cursor'], { home });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Cursor: added "memory-kit" to /);
    assert.match(first.stdout, /\nnext: restart Cursor/);
    assert.match(first.stdout, /\ncheck: Cursor Settings > MCP/);
    const after = json(file);
    assert.deepEqual(after.mcpServers.gh, { command: 'gh' });
    assert.deepEqual(after.mcpServers['memory-kit'], { type: 'stdio', command: nodeCommand(), args: serverArgs(vault, { pathMod: path }) });
    const backups = fs.readdirSync(path.join(vault, '.memory-kit', 'backups', 'connect'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^cursor-\d{8}-\d{6}\.json$/);
    const backup = path.join(vault, '.memory-kit', 'backups', 'connect', backups[0]);
    assert.equal(read(backup), '{\n    "mcpServers": {\n        "gh": {"command": "gh"}\n    }\n}\n');
    if (!IS_WIN) {
      assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the config keeps its mode');
    }

    const again = runConnect(vault, ['cursor', '--json'], { home });
    assert.equal(again.code, 0);
    const out = JSON.parse(again.stdout);
    assert.equal(out.action, 'unchanged');
    assert.equal(out.client, 'cursor');
    assert.equal(out.method, 'file');
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets.map((t) => [t.path, t.action, t.written]), [[file, 'unchanged', false]]);
    assert.ok(Array.isArray(out.text));
    assert.equal(out.messages, undefined);

    const removed = runConnect(vault, ['cursor', '--remove'], { home });
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /removed "memory-kit"/);
    assert.deepEqual(json(file), { mcpServers: { gh: { command: 'gh' } } });
    assert.match(runConnect(vault, ['cursor', '--remove'], { home }).stdout, /nothing to remove/);
  });

  test('a foreign entry: refused with exit 1, replaced with --force', () => {
    const vault = makeVault();
    const home = tmpDir('cli-conflict');
    const file = put(path.join(home, '.copilot', 'mcp-config.json'), '{"mcpServers": {"memory-kit": {"command": "other"}}}');
    const refused = runConnect(vault, ['copilot-cli'], { home });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already has a "memory-kit" entry that starts something else/);
    assert.equal(read(file), '{"mcpServers": {"memory-kit": {"command": "other"}}}');
    const forced = runConnect(vault, ['copilot', '--force', '--read-only'], { home });
    assert.equal(forced.code, 0, forced.stderr);
    const entry = json(file).mcpServers['memory-kit'];
    assert.deepEqual(entry.tools, ['*']);
    assert.deepEqual(entry.args.slice(-1), ['--read-only']);
  });

  test('JSONC with comments: exit 1, the snippet to paste, the file untouched', () => {
    const vault = makeVault();
    const home = tmpDir('cli-zed');
    const settings = '// Zed settings\n{\n  "theme": "One Dark", // mine\n}\n';
    const file = put(configPath('zed', home), settings);
    const res = runConnect(vault, ['zed'], { home });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /contains comments, and connect never rewrites such a file/);
    const snippet = res.stderr.slice(res.stderr.indexOf('"context_servers"'));
    assert.deepEqual(JSON.parse(`{${snippet}}`).context_servers['memory-kit'].args, serverArgs(vault, { pathMod: path }));
    assert.equal(read(file), settings);
    const dry = runConnect(vault, ['gemini-cli', '--json'], { home });
    assert.equal(dry.code, 1, 'no ~/.gemini: app not found');
    assert.equal(JSON.parse(dry.stdout).action, 'app-not-found');
  });

  test('Codex TOML through the CLI: the rest of the file stays byte for byte', () => {
    const vault = makeVault();
    const home = tmpDir('cli-codex');
    const original = '# my config\r\nmodel = "o3"\r\n\r\n[mcp_servers.github]\r\ncommand = "npx"\r\nargs = ["-y", "@x/github"] # pinned\r\n';
    const file = put(configPath('codex', home), original);
    const res = runConnect(vault, ['codex', '--dry-run'], { home });
    assert.equal(res.code, 0);
    assert.match(res.stdout, /would add "memory-kit"/);
    assert.match(res.stdout, /\[mcp_servers\.memory-kit\]/);
    assert.equal(read(file), original);
    assert.equal(runConnect(vault, ['codex'], { home }).code, 0);
    const text = read(file);
    assert.ok(text.startsWith(original));
    assert.deepEqual(tomlServers(scanToml(text))['memory-kit'].args, serverArgs(vault, { pathMod: path }));
    assert.equal(runConnect(vault, ['codex', '--remove'], { home }).code, 0);
    assert.equal(read(file), original);
  });

  test('--list, human and JSON', () => {
    const vault = makeVault();
    const home = tmpDir('cli-list');
    put(path.join(home, '.cursor', 'mcp.json'), '{}');
    assert.equal(runConnect(vault, ['cursor'], { home }).code, 0);
    const human = runConnect(vault, ['--list'], { home });
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /\n {2}cursor +connected +Cursor · /);
    assert.match(human.stdout, /\n {2}claude-desktop +app not found +Claude Desktop · /);
    assert.match(human.stdout, /connect one with: node system\/memory\.mjs connect <client>\n$/);
    const out = JSON.parse(runConnect(vault, ['--list', '--json'], { home }).stdout);
    assert.equal(out.vault, vault);
    assert.deepEqual(out.clients.map((c) => c.id), CLIENTS.map((c) => c.id));
    assert.equal(out.clients.find((c) => c.id === 'cursor').state, 'connected');
    assert.equal(out.clients.find((c) => c.id === 'claude-app').state, 'guidance');
  });

  test('a config reached through a symlink is edited in place, the link stays', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const vault = makeVault();
    const home = tmpDir('cli-link');
    const real = put(path.join(home, 'dotfiles', 'cursor.json'), '{}\n');
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.symlinkSync(real, path.join(home, '.cursor', 'mcp.json'));
    assert.equal(runConnect(vault, ['cursor'], { home }).code, 0);
    assert.ok(fs.lstatSync(path.join(home, '.cursor', 'mcp.json')).isSymbolicLink());
    assert.ok(json(real).mcpServers['memory-kit']);
  });

  test('a dangling dotfiles link: the file is made where it leads, the link stays', { skip: IS_WIN && 'symlinks need rights on Windows' }, () => {
    const vault = makeVault();
    const home = tmpDir('cli-dangling');
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.mkdirSync(path.join(home, 'dotfiles'));
    const link = path.join(home, '.cursor', 'mcp.json');
    fs.symlinkSync(path.join('..', 'dotfiles', 'cursor-mcp.json'), link);
    const res = runConnect(vault, ['cursor'], { home });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /mcp\.json is a link, so the new file is .*cursor-mcp\.json; to undo, delete /);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link stays');
    assert.ok(json(path.join(home, 'dotfiles', 'cursor-mcp.json')).mcpServers['memory-kit']);
  });

  test('a config connect cannot read: exit 1 with the entry to paste, as --list reports it', { skip: !modeBlocksReads() && 'this user reads any file (root, or Windows)' }, () => {
    const vault = makeVault();
    const home = tmpDir('cli-unreadable');
    const file = put(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers": {}}');
    fs.chmodSync(file, 0);
    try {
      const res = runConnect(vault, ['cursor'], { home });
      assert.equal(res.code, 1, res.stderr);
      assert.match(res.stderr, /mcp\.json cannot be read \(EACCES\)\. Fix it, or add this yourself:\n"mcpServers": \{/);
      assert.doesNotMatch(res.stderr, /internal error/);
      const out = JSON.parse(runConnect(vault, ['cursor', '--remove', '--json'], { home }).stdout);
      assert.deepEqual([out.action, out.targets[0].reason, out.targets[0].error], ['refused', 'read', 'EACCES']);
      assert.match(runConnect(vault, ['--list'], { home }).stdout, /\n {2}cursor +unreadable +Cursor · /);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  test('backups stay out of git through .git/info/exclude', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const vault = makeVault();
    const home = tmpDir('cli-git');
    const gitEnv = { GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, '');
    const g = (args) => spawnSync('git', args, { cwd: vault, env: { ...process.env, ...gitEnv }, encoding: 'utf8', windowsHide: true });
    assert.equal(g(['init', '-q']).status, 0);
    put(path.join(home, '.cursor', 'mcp.json'), '{}');
    const res = runConnect(vault, ['cursor'], { home, env: { ...gitEnv, PATH: process.env.PATH } });
    assert.equal(res.code, 0, res.stderr);
    assert.match(read(path.join(vault, '.git', 'info', 'exclude')), /^\.memory-kit\/$/m);
    assert.doesNotMatch(g(['status', '--porcelain', '--untracked-files=all']).stdout, /\.memory-kit/);
    // A project file git ignores cannot travel with the vault: connect says so.
    fs.writeFileSync(path.join(vault, '.gitignore'), '.vscode/\n');
    const project = runConnect(vault, ['vscode', '--scope', 'project'], { home, env: { ...gitEnv, PATH: process.env.PATH } });
    assert.equal(project.code, 0, project.stderr);
    assert.match(project.stdout, /git ignores \.vscode\/mcp\.json, so this entry stays on this computer/);
    const cursor = runConnect(vault, ['cursor', '--scope', 'project'], { home, env: { ...gitEnv, PATH: process.env.PATH } });
    assert.match(cursor.stdout, /works on every computer that opens this vault/);
  });

  describe('Claude Code with a claude command on PATH', { skip: IS_WIN && 'the fake claude is a shell script' }, () => {
    /** A fake `claude` that logs its arguments and edits ~/.claude.json like the real one. */
    function fakeClaude(home) {
      const bin = path.join(home, 'bin');
      const script = path.join(home, 'fake-claude.mjs');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(script, `
import fs from 'node:fs';
import path from 'node:path';
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(argv) + '\\n');
if (process.env.FAKE_CLAUDE_FAIL) { process.stderr.write('Error: failed on purpose\\n'); process.exit(1); }
const file = path.join(process.env.CLAUDE_CONFIG_DIR || process.env.HOME, '.claude.json');
const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
cfg.mcpServers ??= {};
if (argv[1] === 'add') {
  const sep = argv.indexOf('--');
  const name = argv[sep - 1];
  if (cfg.mcpServers[name]) { process.stderr.write('MCP server ' + name + ' already exists\\n'); process.exit(1); }
  const env = {};
  for (let i = 2; i < sep; i++) if (argv[i] === '-e') { const [k, ...v] = argv[++i].split('='); env[k] = v.join('='); }
  cfg.mcpServers[name] = { type: 'stdio', command: argv[sep + 1], args: argv.slice(sep + 2), env };
} else if (argv[1] === 'remove') {
  const name = argv[argv.length - 1];
  if (!cfg.mcpServers[name]) { process.stderr.write('No MCP server named ' + name + '\\n'); process.exit(1); }
  delete cfg.mcpServers[name];
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
`);
      const claude = path.join(bin, 'claude');
      fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      fs.chmodSync(claude, 0o755);
      return { PATH: bin, FAKE_CLAUDE_LOG: path.join(home, 'claude.log') };
    }
    const calls = (env) => (fs.existsSync(env.FAKE_CLAUDE_LOG) ? read(env.FAKE_CLAUDE_LOG).trim().split('\n').map((l) => JSON.parse(l)) : []);

    test('add, unchanged, update, remove and a failing command', () => {
      const vault = makeVault();
      const home = tmpDir('cli-claude');
      const env = fakeClaude(home);
      const args = serverArgs(vault, { pathMod: path });
      put(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 2, projects: {} }, null, 2));

      const dry = runConnect(vault, ['claude-code', '--dry-run'], { home, env });
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /would run: claude mcp add --scope user --transport stdio memory-kit -- /);
      assert.deepEqual(calls(env), []);

      const added = runConnect(vault, ['claude-code'], { home, env });
      assert.equal(added.code, 0, added.stderr);
      assert.match(added.stdout, /ran: claude mcp add/);
      assert.match(added.stdout, /next: start a new Claude Code session/);
      assert.doesNotMatch(added.stdout, /does not show the change/);
      assert.deepEqual(calls(env), [['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'memory-kit', '--', nodeCommand(), ...args]]);
      assert.equal(json(path.join(home, '.claude.json')).numStartups, 2);

      assert.match(runConnect(vault, ['claude-code'], { home, env }).stdout, /already connected/);
      assert.equal(calls(env).length, 1);

      const cfgFile = path.join(home, '.claude.json');
      const withEnv = json(cfgFile);
      withEnv.mcpServers['memory-kit'].env = { MEMORY_SECTORS: 'work' };
      fs.writeFileSync(cfgFile, JSON.stringify(withEnv, null, 2));
      const updated = runConnect(vault, ['claude-code', '--read-only', '--json'], { home, env });
      assert.equal(updated.code, 0, updated.stderr);
      assert.equal(JSON.parse(updated.stdout).action, 'update');
      assert.deepEqual(calls(env).slice(1).map((c) => c[1]), ['remove', 'add']);
      assert.deepEqual(calls(env)[2].slice(2, 4), ['-e', 'MEMORY_SECTORS=work']);
      assert.deepEqual(json(cfgFile).mcpServers['memory-kit'].args.slice(-1), ['--read-only']);
      assert.deepEqual(json(cfgFile).mcpServers['memory-kit'].env, { MEMORY_SECTORS: 'work' });

      const failed = runConnect(vault, ['claude-code', '--remove'], { home, env: { ...env, FAKE_CLAUDE_FAIL: '1' } });
      assert.equal(failed.code, 1);
      assert.match(failed.stderr, /this command failed \(Error: failed on purpose\): claude mcp remove --scope user memory-kit/);

      const removed = runConnect(vault, ['claude-code', '--remove'], { home, env });
      assert.equal(removed.code, 0, removed.stderr);
      assert.deepEqual(json(path.join(home, '.claude.json')).mcpServers, {});
      assert.ok(fs.readdirSync(path.join(vault, '.memory-kit', 'backups', 'connect')).every((n) => /^claude-code-\d{8}-\d{6}(-\d+)?\.json$/.test(n)));
    });

    test('without the command the file is written, with a restart warning', () => {
      const vault = makeVault();
      const home = tmpDir('cli-claude-file');
      fs.mkdirSync(path.join(home, '.claude'));
      const res = runConnect(vault, ['claude-code'], { home });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /no claude command that connect can run was found/);
      assert.match(res.stdout, /Claude Code rewrites this file while it runs/);
      assert.deepEqual(json(path.join(home, '.claude.json')).mcpServers['memory-kit'].type, 'stdio');
    });
  });
});
