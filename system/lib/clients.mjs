// The MCP clients `connect` can set up: where each one keeps its config on Windows, macOS and
// Linux, the entry it expects, how to edit that config without losing anything else in it, and
// readers that tell whether a config already points at a vault (connect --list and doctor).
// Path resolution is a pure function of { platform, env, home } (resolveClient); the few
// clients whose file depends on what exists on disk (the Microsoft Store build of Claude
// Desktop, the Windsurf to Devin rename, the LM Studio home pointer, Cline's old location) are
// decided by locateClient through injectable file probes, so tests can simulate every system.
// Nothing here writes files or prints.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStyle, formatJson, parseJsonc } from './jsonc.mjs';
import { stableNodePath } from './nodepath.mjs';

export const DEFAULT_NAME = 'memory-kit';
/** Server names: letters, digits and hyphens (Gemini splits tool names at '_', TOML keys need no quotes). */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** The script path in a portable project entry (Cursor and VS Code expand the variable). */
export const WORKSPACE = '${workspaceFolder}';
export const PORTABLE_SCRIPT = `${WORKSPACE}/system/memory.mjs`;

// ---------------------------------------------------------------------------------------------
// The client table (sources: the verified client research of 2026-09-24)

/**
 * id, display name, file format, key path of the server map, entry shape, optional project
 * file (only where a portable ${workspaceFolder} entry works), aliases, and `guide` for
 * clients that cannot run a local server or keep no documented file (connect prints how).
 */
export const CLIENTS = Object.freeze([
  { id: 'claude-code', name: 'Claude Code', format: 'json', key: ['mcpServers'], shape: 'claude-code', cli: 'claude' },
  { id: 'claude-desktop', name: 'Claude Desktop', format: 'json', key: ['mcpServers'], shape: 'plain' },
  { id: 'cursor', name: 'Cursor', format: 'json', key: ['mcpServers'], shape: 'typed', project: '.cursor/mcp.json' },
  { id: 'vscode', name: 'VS Code', format: 'json', key: ['servers'], shape: 'typed', project: '.vscode/mcp.json', aliases: ['code'] },
  { id: 'windsurf', name: 'Windsurf (Devin Desktop)', format: 'json', key: ['mcpServers'], shape: 'plain', aliases: ['devin'] },
  { id: 'gemini-cli', name: 'Gemini CLI', format: 'jsonc', key: ['mcpServers'], shape: 'plain', aliases: ['gemini'] },
  { id: 'codex', name: 'Codex', format: 'toml', key: ['mcp_servers'], shape: 'plain' },
  { id: 'zed', name: 'Zed', format: 'jsonc', key: ['context_servers'], shape: 'zed' },
  { id: 'lm-studio', name: 'LM Studio', format: 'json', key: ['mcpServers'], shape: 'plain', aliases: ['lmstudio'] },
  { id: 'cline', name: 'Cline', format: 'json', key: ['mcpServers'], shape: 'cline' },
  { id: 'copilot-cli', name: 'GitHub Copilot CLI', format: 'json', key: ['mcpServers'], shape: 'copilot', aliases: ['copilot'] },
  { id: 'junie', name: 'Junie', format: 'json', key: ['mcpServers'], shape: 'plain' },
  { id: 'jetbrains', name: 'JetBrains AI Assistant', guide: 'jetbrains' },
  { id: 'chatgpt', name: 'ChatGPT', guide: 'chatgpt', aliases: ['chatgpt-desktop'] },
  { id: 'claude-app', name: 'Claude app (web and mobile)', guide: 'claude-app', aliases: ['claude-web'] },
].map((c) => Object.freeze({ aliases: [], ...c })));

/** The client with this id or alias (letter case ignored), or null. */
export function findClient(id) {
  const want = String(id ?? '').toLowerCase();
  return CLIENTS.find((c) => c.id === want || c.aliases.includes(want)) ?? null;
}

// Entry shapes: `owned` fields are always ours; `defaults` are added only when missing, so a
// value the owner set (env variables, a tool list, a disabled switch) survives an update.
const SHAPES = {
  plain: { type: null, defaults: {} },
  typed: { type: 'stdio', defaults: {} },
  'claude-code': { type: 'stdio', defaults: { env: {} } },
  zed: { type: null, defaults: { env: {} } },
  cline: { type: null, defaults: { disabled: false } },
  copilot: { type: 'stdio', defaults: { tools: ['*'] } },
};

// ---------------------------------------------------------------------------------------------
// Environment and paths

/** The path module of a platform: path.win32 for 'win32', path.posix for any other. */
export function pathModFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** env[name] when non-empty; names are case-insensitive on Windows, as the system treats them. */
export function envGet(env, name, platform = process.platform) {
  if (!env) return undefined;
  let value = env[name];
  if (value === undefined && platform === 'win32') {
    const lower = name.toLowerCase();
    const hit = Object.keys(env).find((k) => k.toLowerCase() === lower);
    if (hit !== undefined) value = env[hit];
  }
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** {platform, env, home, p} with defaults from this process. */
function context({ platform = process.platform, env = process.env, home, pathMod } = {}) {
  return { platform, env: env ?? {}, home: home ?? os.homedir(), p: pathMod ?? pathModFor(platform) };
}

/** An absolute directory from an environment variable, or null (relative values are ignored). */
function envDir(c, name) {
  const value = envGet(c.env, name, c.platform);
  return value && c.p.isAbsolute(value) ? value : null;
}

const xdgConfig = (c) => envDir(c, 'XDG_CONFIG_HOME') ?? c.p.join(c.home, '.config');
const appData = (c) => envDir(c, 'APPDATA') ?? c.p.join(c.home, 'AppData', 'Roaming');
const localAppData = (c) => envDir(c, 'LOCALAPPDATA') ?? c.p.join(c.home, 'AppData', 'Local');

/** The per-user settings folder VS Code uses (User/ lives inside <base>/<product>/). */
function vscodeBase(c) {
  if (c.platform === 'win32') return appData(c);
  if (c.platform === 'darwin') return c.p.join(c.home, 'Library', 'Application Support');
  return xdgConfig(c);
}

const one = (c, file, appDir, role = 'user') => ({ path: file, role, appDir: appDir ?? c.p.dirname(file) });

// Per client: the candidate files in order of preference, each with the folder whose existence
// shows the app is installed. `pick` says how locateClient chooses among them.
const RESOLVERS = {
  'claude-code': (c) => {
    const dir = envDir(c, 'CLAUDE_CONFIG_DIR');
    const file = dir ? c.p.join(dir, '.claude.json') : c.p.join(c.home, '.claude.json');
    return { candidates: [one(c, file, dir ?? c.p.join(c.home, '.claude'))] };
  },
  'claude-desktop': (c) => {
    const name = 'claude_desktop_config.json';
    if (c.platform === 'win32') {
      return {
        candidates: [one(c, c.p.join(appData(c), 'Claude', name), undefined, 'appdata')],
        // Microsoft Store (MSIX) build: a private per-package copy, read before the real file.
        msix: { packages: c.p.join(localAppData(c), 'Packages'), prefix: 'Claude_', rel: ['LocalCache', 'Roaming', 'Claude', name] },
      };
    }
    if (c.platform === 'darwin') return { candidates: [one(c, c.p.join(c.home, 'Library', 'Application Support', 'Claude', name))] };
    return { candidates: [one(c, c.p.join(xdgConfig(c), 'Claude', name))] };
  },
  cursor: (c) => ({ candidates: [one(c, c.p.join(c.home, '.cursor', 'mcp.json'))] }),
  vscode: (c) => ({
    pick: 'ordered',
    candidates: [['Code', 'stable'], ['Code - Insiders', 'insiders']].map(([product, role]) =>
      one(c, c.p.join(vscodeBase(c), product, 'User', 'mcp.json'), c.p.join(vscodeBase(c), product), role)),
  }),
  windsurf: (c) => {
    // Renamed to Devin Desktop on 2026-06-02; during the transition it reads both files.
    const devin = c.platform === 'win32' ? c.p.join(appData(c), 'devin') : c.p.join(xdgConfig(c), 'devin');
    const legacy = c.p.join(c.home, '.codeium', 'windsurf');
    return {
      pick: 'all',
      candidates: [one(c, c.p.join(devin, 'mcp_config.json'), devin, 'devin'), one(c, c.p.join(legacy, 'mcp_config.json'), legacy, 'windsurf')],
    };
  },
  'gemini-cli': (c) => {
    const dir = c.p.join(envDir(c, 'GEMINI_CLI_HOME') ?? c.home, '.gemini');
    return { candidates: [one(c, c.p.join(dir, 'settings.json'), dir)] };
  },
  codex: (c) => {
    const dir = envDir(c, 'CODEX_HOME') ?? c.p.join(c.home, '.codex');
    return { candidates: [one(c, c.p.join(dir, 'config.toml'), dir)] };
  },
  zed: (c) => {
    let dir;
    if (c.platform === 'win32') dir = c.p.join(appData(c), 'Zed');
    else if (c.platform === 'darwin') dir = c.p.join(c.home, '.config', 'zed');
    else dir = c.p.join(envDir(c, 'FLATPAK_XDG_CONFIG_HOME') ?? xdgConfig(c), 'zed');
    return { candidates: [one(c, c.p.join(dir, 'settings.json'), dir)] };
  },
  'lm-studio': (c) => {
    // LM Studio's own lookup: the home pointer file, then ~/.cache/lm-studio, then ~/.lmstudio.
    const cache = c.p.join(c.home, '.cache', 'lm-studio');
    const home = c.p.join(c.home, '.lmstudio');
    return {
      pick: 'files-first',
      pointer: c.p.join(c.home, '.lmstudio-home-pointer'),
      primary: 1,
      candidates: [one(c, c.p.join(cache, 'mcp.json'), cache, 'cache'), one(c, c.p.join(home, 'mcp.json'), home, 'home')],
    };
  },
  cline: (c) => {
    const explicit = envGet(c.env, 'CLINE_MCP_SETTINGS_PATH', c.platform);
    if (explicit && c.p.isAbsolute(explicit)) return { candidates: [one(c, explicit, undefined, 'env')] };
    const clineDir = envDir(c, 'CLINE_DIR');
    const dataDir = envDir(c, 'CLINE_DATA_DIR') ?? (clineDir ? c.p.join(clineDir, 'data') : c.p.join(c.home, '.cline', 'data'));
    const appDir = envDir(c, 'CLINE_DATA_DIR') ?? clineDir ?? c.p.join(c.home, '.cline');
    // Older extension versions kept the file in VS Code's global storage.
    const legacy = c.p.join(vscodeBase(c), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    return {
      pick: 'ordered',
      candidates: [
        one(c, c.p.join(dataDir, 'settings', 'cline_mcp_settings.json'), appDir, 'user'),
        one(c, c.p.join(legacy, 'settings', 'cline_mcp_settings.json'), legacy, 'legacy'),
      ],
    };
  },
  'copilot-cli': (c) => {
    const dir = envDir(c, 'COPILOT_HOME') ?? c.p.join(c.home, '.copilot');
    return { candidates: [one(c, c.p.join(dir, 'mcp-config.json'), dir)] };
  },
  junie: (c) => ({ candidates: [one(c, c.p.join(c.home, '.junie', 'mcp', 'mcp.json'), c.p.join(c.home, '.junie'))] }),
};

/**
 * Pure: where a client keeps its user config on the given system. Returns the client row plus
 * {candidates: [{path, role, appDir}], pick, primary, pointer?, msix?}; a guidance-only
 * client gets candidates []. Throws for an unknown id.
 */
export function resolveClient(id, opts = {}) {
  const client = findClient(id);
  if (!client) throw new Error(`unknown client: ${id}`);
  const c = context(opts);
  if (client.guide) return { ...client, candidates: [], pick: 'first', primary: 0 };
  const r = RESOLVERS[client.id](c);
  return { ...client, pick: r.pick ?? 'first', primary: r.primary ?? 0, candidates: r.candidates, pointer: r.pointer, msix: r.msix };
}

/** The project config of a client inside a vault (cursor and vscode), or null. */
export function projectConfigPath(client, vault, { pathMod = path } = {}) {
  const row = typeof client === 'string' ? findClient(client) : client;
  if (!row?.project) return null;
  return pathMod.join(vault, ...row.project.split('/'));
}

// ---------------------------------------------------------------------------------------------
// Locating the file to use on this machine

/** File probes; tests replace them. */
export const IO = Object.freeze({
  isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  isDir(p) {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readText(p) {
    return fs.readFileSync(p, 'utf8');
  },
  readdir(p) {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
  mtime(p) {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  },
  realpath(p) {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return null;
    }
  },
  isExecutable(p) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
});

/** The LM Studio home named by its pointer file, or null (never created here). */
function pointerHome(file, p, io) {
  if (!file || !io.isFile(file)) return null;
  let text;
  try {
    text = io.readText(file);
  } catch {
    return null;
  }
  const dir = String(text).replace(/^\uFEFF/, '').trim();
  return dir && !dir.includes('\n') && p.isAbsolute(dir) ? dir : null;
}

/**
 * paths split into the first name of each real file and the other names of the same file (a
 * symlink to one named before it, or a path through a linked folder): {files, aliases: [{path,
 * target}]}. io.realpath decides; a path it cannot resolve stands for itself.
 */
function byRealFile(paths, io) {
  const first = new Map();
  const files = [];
  const aliases = [];
  for (const f of paths) {
    const key = io.realpath?.(f) ?? f;
    if (first.has(key)) {
      aliases.push({ path: f, target: first.get(key) });
    } else {
      first.set(key, f);
      files.push(f);
    }
  }
  return { files, aliases };
}

/**
 * Which file to edit for a resolved client on this machine: {targets: [{path, role, exists}],
 * appFound, notes: [{key, vars}]}. Existing files win, so connect never creates a second
 * config that would shadow the one the app reads. Rules per `pick`:
 * first/files-first (the first existing file, else the first candidate whose app folder
 * exists), ordered (the first candidate whose file or app folder exists), all (every existing
 * file, each real file once, else as ordered). Nothing found: the primary candidate and
 * appFound false.
 */
export function locateClient(resolved, { pathMod, platform = process.platform, io = IO } = {}) {
  const p = pathMod ?? pathModFor(platform);
  const notes = [];
  if (!resolved.candidates.length) return { targets: [], appFound: false, notes };
  let candidates = resolved.candidates;
  let primary = resolved.primary ?? 0;
  const pointed = pointerHome(resolved.pointer, p, io);
  if (pointed) {
    candidates = [{ path: p.join(pointed, 'mcp.json'), role: 'pointer', appDir: pointed }];
    primary = 0;
  }
  const target = (c) => ({ path: c.path, role: c.role, exists: io.isFile(c.path) });

  if (resolved.msix) {
    const { packages, prefix, rel } = resolved.msix;
    const pkgs = io.readdir(packages)
      .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((n) => p.join(packages, n))
      .filter((d) => io.isDir(d))
      .sort();
    const privates = pkgs.map((d) => p.join(d, ...rel)).filter((f) => io.isFile(f));
    if (privates.length) {
      privates.sort((a, b) => io.mtime(b) - io.mtime(a) || (a < b ? -1 : a > b ? 1 : 0));
      notes.push({ key: 'connect.msix', vars: { path: privates[0] } });
      if (privates.length > 1) notes.push({ key: 'connect.msix_many', vars: { path: privates[0], others: privates.slice(1).join(', ') } });
      return { targets: [{ path: privates[0], role: 'msix', exists: true }], appFound: true, notes };
    }
    if (pkgs.length) {
      // No private copy yet: the packaged app falls back to the real file, so edit (or create)
      // that one. Creating the private copy would hide the owner's existing settings.
      notes.push({ key: 'connect.msix_real', vars: { path: candidates[0].path } });
      return { targets: [target(candidates[0])], appFound: true, notes };
    }
  }

  const existing = candidates.filter((c) => io.isFile(c.path));
  const withApp = candidates.filter((c) => io.isFile(c.path) || io.isDir(c.appDir));
  if (resolved.pick === 'all' && existing.length) {
    // Both names of one file (the old folder linked to the new one) are edited once.
    const { files, aliases } = byRealFile(existing.map((c) => c.path), io);
    for (const a of aliases) notes.push({ key: 'connect.same_file', vars: a });
    return { targets: existing.filter((c) => files.includes(c.path)).map(target), appFound: true, notes };
  }
  if (resolved.pick === 'ordered' || resolved.pick === 'all') {
    if (withApp.length) return { targets: [target(withApp[0])], appFound: true, notes };
  } else {
    if (existing.length) return { targets: [target(existing[0])], appFound: true, notes };
    const dirOnly = candidates.find((c) => io.isDir(c.appDir));
    if (dirOnly) return { targets: [target(dirOnly)], appFound: true, notes };
  }
  return { targets: [target(candidates[primary] ?? candidates[0])], appFound: false, notes };
}

// ---------------------------------------------------------------------------------------------
// The entry

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * The Node program a config should start. process.execPath, except inside a folder a package
 * manager deletes by itself (lib/nodepath.mjs): a Homebrew Cellar (macOS and Linuxbrew; `brew
 * upgrade`) gives <prefix>/bin/node or <prefix>/opt/<formula>/bin/node, when that link exists and
 * leads to the same formula; a snap revision gives /snap/<name>/current/….
 */
export function nodeCommand({ execPath = process.execPath, platform = process.platform, realpath = realpathOrNull } = {}) {
  return stableNodePath(execPath, { platform, realpath, multishell: false });
}

/** [<vault>/system/memory.mjs, 'mcp', '--root', <vault>] plus '--read-only'. */
export function serverArgs(vault, { readOnly = false, pathMod = path } = {}) {
  const args = [pathMod.join(vault, 'system', 'memory.mjs'), 'mcp', '--root', vault];
  if (readOnly) args.push('--read-only');
  return args;
}

/** The same for a project file: paths through ${workspaceFolder}, so it works on any computer. */
export function portableArgs({ readOnly = false } = {}) {
  const args = [PORTABLE_SCRIPT, 'mcp', '--root', WORKSPACE];
  if (readOnly) args.push('--read-only');
  return args;
}

/**
 * The entry a client expects: {owned, defaults, full}. owned (type, command, args) is always
 * written; defaults are added only when missing; full is what a new entry looks like.
 */
export function buildEntry(client, { command, args }) {
  const row = typeof client === 'string' ? findClient(client) : client;
  const shape = SHAPES[row?.shape] ?? SHAPES.plain;
  const owned = shape.type ? { type: shape.type, command, args: [...args] } : { command, args: [...args] };
  const defaults = structuredClone(shape.defaults);
  return { owned, defaults, full: { ...owned, ...structuredClone(defaults) } };
}

/** existing with our owned fields and any missing defaults (key order of existing kept). */
export function mergeEntry(existing, built) {
  const out = { ...existing };
  for (const [k, v] of Object.entries(built.owned)) out[k] = structuredClone(v);
  for (const [k, v] of Object.entries(built.defaults)) if (!Object.hasOwn(out, k)) out[k] = structuredClone(v);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recognizing entries that serve a vault

/** A path folded the way the platform compares file names (separators, letter case, NFC). */
function foldPath(s, platform, p) {
  let t = String(s);
  if (p.sep === '\\') t = t.replace(/\//g, '\\');
  t = p.normalize(t);
  if (t.length > 1 && !/^[A-Za-z]:[\\/]$/.test(t)) t = t.replace(/[\\/]+$/, '');
  if (platform === 'win32' || platform === 'darwin') t = t.normalize('NFC').toLowerCase();
  return t;
}

/**
 * What identifies a vault in a config: {scripts, roots, platform, p}, with the path as given
 * and its real path (symlinks, 8.3 names), each folded for comparison.
 */
export function vaultRefs(vault, { platform = process.platform, pathMod, realpath = (x) => IO.realpath(x) } = {}) {
  const p = pathMod ?? pathModFor(platform);
  const roots = [vault];
  const real = realpath(vault);
  if (real && real !== vault) roots.push(real);
  return {
    platform,
    p,
    roots: roots.map((r) => foldPath(r, platform, p)),
    scripts: roots.map((r) => foldPath(p.join(r, 'system', 'memory.mjs'), platform, p)),
  };
}

function argLists(entry) {
  const lists = [];
  if (!entry || typeof entry !== 'object') return lists;
  if (Array.isArray(entry.args)) lists.push(entry.args);
  // Older Zed ({command: {path, args}}) and Cline's nested {transport: {...}} forms.
  for (const inner of [entry.command, entry.transport]) {
    if (inner && typeof inner === 'object' && Array.isArray(inner.args)) lists.push(inner.args);
  }
  return lists;
}

const SCRIPT_TAIL = /(?:^|[\\/])system[\\/]memory\.mjs$/i;

/**
 * Whom an entry serves: {kind: 'this'} when its args name this vault's memory.mjs (or another
 * kit's memory.mjs run as `mcp --root <this vault>`), {kind: 'kit', root} for a memory-kit
 * server of another vault, else {kind: null}. portable accepts
 * ${workspaceFolder}/system/memory.mjs, which a vault's own project file uses.
 */
export function entryTarget(entry, refs, { portable = false } = {}) {
  let other = null;
  for (const list of argLists(entry)) {
    const args = list.filter((a) => typeof a === 'string');
    const fold = (a) => foldPath(a, refs.platform, refs.p);
    if (portable && args.includes(PORTABLE_SCRIPT)) return { kind: 'this' };
    if (args.some((a) => refs.scripts.includes(fold(a)))) return { kind: 'this' };
    if (!args.some((a) => SCRIPT_TAIL.test(a)) || !args.includes('mcp')) continue;
    const i = args.indexOf('--root');
    const root = i >= 0 && typeof args[i + 1] === 'string' ? args[i + 1] : null;
    if (root && refs.roots.includes(fold(root))) return { kind: 'this' };
    other = { kind: 'kit', root };
  }
  return other ?? { kind: null };
}

// ---------------------------------------------------------------------------------------------
// JSON configs

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function getIn(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** JSON text a person pastes: `"<name>": {...}` inside the server map, or the map itself. */
export function jsonSnippet(key, name, entry, { inside = false } = {}) {
  let value = { [name]: entry };
  const keys = inside ? [] : [...key];
  while (keys.length > 1) {
    value = { [keys.pop()]: value };
  }
  const body = keys.length ? { [keys[0]]: value } : value;
  const text = JSON.stringify(body, null, 2);
  return text.slice(2, -2).replace(/^ {2}/gm, '');
}

/** The servers of a parsed JSON config and, for Claude Code, of its per-project sections. */
function jsonServerMaps(root, key, clientId) {
  const maps = [];
  const main = getIn(root, key);
  if (isPlainObject(main)) maps.push({ scope: 'user', servers: main });
  if (clientId === 'claude-code' && isPlainObject(root?.projects)) {
    for (const [project, section] of Object.entries(root.projects)) {
      if (isPlainObject(section?.mcpServers)) maps.push({ scope: 'local', project, servers: section.mcpServers });
    }
  }
  return maps;
}

/**
 * Plans an edit of a JSON (or JSONC) config. text is the file's text, or null when it does
 * not exist. Returns {action, reason?, error?, text?, entry?, others, snippet?, inside?}:
 * add, update, replace (a foreign entry, --force), remove, unchanged, absent (nothing to
 * remove), connected-as (another name already serves this vault), conflict (a foreign entry
 * has the name) or refused (reason: parse, root, key, comments, numbers). text is the new file
 * text for add, update, replace and remove.
 */
export function planJsonEdit(text, { key, name, built, refs, portable = false, remove = false, force = false }) {
  let parsed = { value: undefined, empty: true, comments: false, unsafeNumbers: false };
  if (text != null) {
    try {
      parsed = parseJsonc(text);
    } catch (err) {
      return { action: 'refused', reason: 'parse', error: err.message, others: [], snippet: jsonSnippet(key, name, built.full), inside: false };
    }
  }
  const root = parsed.empty ? {} : parsed.value;
  if (!isPlainObject(root)) return { action: 'refused', reason: 'root', others: [], snippet: jsonSnippet(key, name, built.full), inside: false };
  const servers = getIn(root, key);
  if (servers !== undefined && !isPlainObject(servers)) {
    return { action: 'refused', reason: 'key', others: [], snippet: jsonSnippet(key, name, built.full), inside: false };
  }
  const map = servers ?? {};
  const others = Object.keys(map).filter((n) => n !== name && entryTarget(map[n], refs, { portable }).kind === 'this');
  const existing = Object.hasOwn(map, name) ? map[name] : undefined;
  const ours = existing !== undefined && entryTarget(existing, refs, { portable }).kind === 'this';

  let action;
  let entry = null;
  if (remove) {
    if (existing === undefined) return { action: 'absent', others };
    if (!ours && !force) return { action: 'conflict', others };
    action = 'remove';
  } else if (existing === undefined) {
    if (others.length && !force) return { action: 'connected-as', others };
    action = 'add';
    entry = built.full;
  } else if (ours) {
    entry = mergeEntry(isPlainObject(existing) ? existing : {}, built);
    if (JSON.stringify(entry) === JSON.stringify(existing)) return { action: 'unchanged', entry, existing, others };
    action = 'update';
  } else if (force) {
    action = 'replace';
    entry = built.full;
  } else {
    return { action: 'conflict', others };
  }

  const inside = servers !== undefined;
  const snippet = entry ? jsonSnippet(key, name, entry, { inside }) : null;
  if (parsed.comments) return { action: 'refused', reason: 'comments', planned: action, others, snippet, inside, entry, existing };
  if (parsed.unsafeNumbers) return { action: 'refused', reason: 'numbers', planned: action, others, snippet, inside, entry, existing };

  if (servers === undefined) {
    // Create the map (and any missing parents) at the end of the object.
    let cur = root;
    for (const k of key.slice(0, -1)) {
      if (!isPlainObject(cur[k])) cur[k] = {};
      cur = cur[k];
    }
    cur[key[key.length - 1]] = map;
  }
  if (action === 'remove') delete map[name];
  else map[name] = entry;
  const next = formatJson(root, detectStyle(text ?? ''));
  return { action, text: next, entry, existing, others };
}

/** The server entries of a JSON config text: [{scope, project?, name, entry}]; throws on a parse error. */
export function jsonEntries(text, key, clientId) {
  const parsed = parseJsonc(text);
  if (parsed.empty) return [];
  const out = [];
  for (const m of jsonServerMaps(parsed.value, key, clientId)) {
    for (const [name, entry] of Object.entries(m.servers)) out.push({ scope: m.scope, project: m.project, name, entry });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// TOML configs (Codex). A small reader for what connect needs: every table header and
// key/value with its exact span, so one server's block can be replaced or removed while every
// other byte of the file stays as it was. Values are decoded (strings, arrays, inline tables,
// booleans, numbers; other scalars stay as their text).

export class TomlError extends Error {
  constructor(message, line) {
    super(`${message} at line ${line}`);
    this.name = 'TomlError';
    this.code = 'TOML_PARSE';
    this.line = line;
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

function setPath(obj, keys, value) {
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) {
      if (Object.hasOwn(cur, k)) return;
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function scalar(token) {
  if (token === 'true') return true;
  if (token === 'false') return false;
  const plain = token.replace(/_/g, '');
  if (/^[+-]?\d+$/.test(plain)) {
    const n = Number(plain);
    return Number.isSafeInteger(n) ? n : token;
  }
  if (/^0x[0-9a-f]+$/i.test(plain)) return Number.parseInt(plain.slice(2), 16);
  if (/^0o[0-7]+$/i.test(plain)) return Number.parseInt(plain.slice(2), 8);
  if (/^0b[01]+$/i.test(plain)) return Number.parseInt(plain.slice(2), 2);
  if (/^[+-]?(?:\d+\.\d+(?:[eE][+-]?\d+)?|\d+[eE][+-]?\d+)$/.test(plain)) return Number(plain);
  return token;
}

/**
 * Scans a TOML text: {tables: [{path, array, start, headerEnd, contentEnd, end}], pairs: [{table,
 * key, path, start, end, value}], eol}. Offsets are UTF-16 indexes; start is the start of the
 * line, end is after its line break (or the end of the text); a table's contentEnd is the end
 * of its last key/value (comments after it belong to what follows). Throws TomlError.
 */
export function scanToml(input) {
  const text = String(input ?? '');
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const tables = [];
  const pairs = [];
  let current = -1;

  const lineAt = (at) => {
    let line = 1;
    for (let k = 0; k < at && k < n; k++) if (text[k] === '\n') line++;
    return line;
  };
  const fail = (message, at = i) => {
    throw new TomlError(message, lineAt(at));
  };
  const skipWs = () => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  const skipComment = () => {
    if (text[i] !== '#') return;
    while (i < n && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) i++;
  };
  const eatEol = () => {
    if (i >= n) return;
    if (text[i] === '\n') i++;
    else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    else fail('expected the end of the line');
  };
  const skipBlank = () => {
    for (;;) {
      skipWs();
      skipComment();
      if (text[i] === '\n') i++;
      else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      else return;
    }
  };
  const escape = () => {
    // i is at the backslash
    const e = text[i + 1];
    if (e !== undefined && Object.hasOwn(ESCAPES, e)) {
      i += 2;
      return ESCAPES[e];
    }
    const size = e === 'u' ? 4 : e === 'U' ? 8 : e === 'x' ? 2 : 0;
    const hex = text.slice(i + 2, i + 2 + size);
    if (!size || !new RegExp(`^[0-9A-Fa-f]{${size}}$`).test(hex)) fail('invalid escape');
    const cp = Number.parseInt(hex, 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('invalid escape');
    i += 2 + size;
    return String.fromCodePoint(cp);
  };
  const basicString = () => {
    i++;
    let out = '';
    for (;;) {
      if (i >= n || text[i] === '\n' || text[i] === '\r') fail('unterminated string');
      const ch = text[i];
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === '\\') out += escape();
      else {
        out += ch;
        i++;
      }
    }
  };
  const literalString = () => {
    const start = ++i;
    while (i < n && text[i] !== "'" && text[i] !== '\n' && text[i] !== '\r') i++;
    if (text[i] !== "'") fail('unterminated string', start);
    return text.slice(start, i++);
  };
  const multiline = (quote) => {
    const start = i;
    i += 3;
    if (text[i] === '\n') i++;
    else if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
    let out = '';
    for (;;) {
      if (i >= n) fail('unterminated string', start);
      if (text.startsWith(quote.repeat(3), i)) {
        let run = 3;
        while (text[i + run] === quote && run < 5) run++;
        out += quote.repeat(run - 3);
        i += run;
        return out;
      }
      const ch = text[i];
      if (quote === '"' && ch === '\\') {
        // A backslash at the end of a line trims the break and the whitespace that follows.
        let j = i + 1;
        while (text[j] === ' ' || text[j] === '\t') j++;
        if (text[j] === '\n' || (text[j] === '\r' && text[j + 1] === '\n')) {
          i = j;
          while (i < n && /[ \t\r\n]/.test(text[i])) i++;
          continue;
        }
        out += escape();
        continue;
      }
      if (ch === '\r' && text[i + 1] === '\n') {
        out += '\n';
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
  };
  const simpleKey = () => {
    if (text[i] === '"') {
      if (text.startsWith('"""', i)) fail('a key cannot be a multi-line string');
      return basicString();
    }
    if (text[i] === "'") {
      if (text.startsWith("'''", i)) fail('a key cannot be a multi-line string');
      return literalString();
    }
    const start = i;
    while (i < n && BARE_KEY.test(text[i])) i++;
    if (i === start) fail('expected a key');
    return text.slice(start, i);
  };
  const keyPath = () => {
    const keys = [simpleKey()];
    for (;;) {
      skipWs();
      if (text[i] !== '.') return keys;
      i++;
      skipWs();
      keys.push(simpleKey());
    }
  };
  const value = () => {
    const ch = text[i];
    if (text.startsWith('"""', i)) return multiline('"');
    if (text.startsWith("'''", i)) return multiline("'");
    if (ch === '"') return basicString();
    if (ch === "'") return literalString();
    if (ch === '[') {
      i++;
      const arr = [];
      for (;;) {
        skipBlank();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        skipBlank();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return arr;
        } else fail('expected , or ] in an array');
      }
    }
    if (ch === '{') {
      i++;
      const obj = {};
      for (;;) {
        skipBlank();
        if (text[i] === '}') {
          i++;
          return obj;
        }
        const keys = keyPath();
        skipWs();
        if (text[i] !== '=') fail('expected =');
        i++;
        skipWs();
        setPath(obj, keys, value());
        skipBlank();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return obj;
        } else fail('expected , or } in an inline table');
      }
    }
    const start = i;
    while (i < n && !/[\s,\]}#]/.test(text[i])) i++;
    // A date and a time may be separated by one space: 1979-05-27 07:32:00Z.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(start, i)) && text[i] === ' ' && /^\d{2}:/.test(text.slice(i + 1, i + 4))) {
      i++;
      while (i < n && !/[\s,\]}#]/.test(text[i])) i++;
    }
    if (i === start) fail('expected a value');
    return scalar(text.slice(start, i));
  };

  while (i < n) {
    const lineStart = i;
    skipWs();
    if (i >= n) break;
    if (text[i] === '#' || text[i] === '\n' || text[i] === '\r') {
      skipComment();
      eatEol();
      continue;
    }
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      skipWs();
      const keys = keyPath();
      skipWs();
      if (text[i] !== ']' || (array && text[i + 1] !== ']')) fail('expected ] to close the table header');
      i += array ? 2 : 1;
      skipWs();
      skipComment();
      eatEol();
      tables.push({ path: keys, array, start: lineStart, headerEnd: i, contentEnd: i, end: n });
      current = tables.length - 1;
      continue;
    }
    const keys = keyPath();
    skipWs();
    if (text[i] !== '=') fail('expected =');
    i++;
    skipWs();
    const v = value();
    skipWs();
    skipComment();
    eatEol();
    const base = current >= 0 ? tables[current].path : [];
    pairs.push({ table: current, key: keys, path: [...base, ...keys], start: lineStart, end: i, value: v });
    if (current >= 0) tables[current].contentEnd = i;
  }
  for (let t = 0; t < tables.length - 1; t++) tables[t].end = tables[t + 1].start;
  return { tables, pairs, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

const startsWith = (list, prefix) => prefix.every((k, idx) => list[idx] === k);

/** {name: entry} of every mcp_servers.<name> a scanned file defines, in any TOML form. */
export function tomlServers(scan) {
  const out = {};
  for (const t of scan.tables) {
    if (!t.array && t.path.length === 2 && t.path[0] === 'mcp_servers' && !isPlainObject(out[t.path[1]])) out[t.path[1]] = {};
  }
  for (const pair of scan.pairs) {
    if (pair.table >= 0 && scan.tables[pair.table].array) continue;
    if (pair.path[0] !== 'mcp_servers') continue;
    if (pair.path.length === 1) {
      if (isPlainObject(pair.value)) for (const [k, v] of Object.entries(pair.value)) out[k] = v;
    } else {
      setPath(out, pair.path.slice(1), pair.value);
    }
  }
  return out;
}

/** A TOML basic string: backslashes, quotes and control characters escaped. */
export function tomlString(s) {
  let out = '"';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).padStart(4, '0').toUpperCase()}`;
    else out += ch;
  }
  return `${out}"`;
}

const tomlLines = (entry, eol) => ({
  command: `command = ${tomlString(entry.command)}${eol}`,
  args: `args = [${entry.args.map(tomlString).join(', ')}]${eol}`,
});

/** The table text connect writes for a server. */
export function tomlBlock(name, entry, eol = '\n') {
  const lines = tomlLines(entry, eol);
  return `[mcp_servers.${name}]${eol}${lines.command}${lines.args}`;
}

/**
 * Removes spans [[start, end], ...] (not overlapping) from text. With each span goes one blank
 * line when blank lines surround it, so an appended block is removed without a trace.
 */
function cutSpans(text, spans, eol) {
  let out = text;
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    let before = out.slice(0, start);
    let after = out.slice(end);
    const blankBefore = before === '' || before.endsWith(eol + eol) || before === eol;
    const blankAfter = after === '' || after.startsWith(eol);
    if (blankBefore && blankAfter) {
      if (before.endsWith(eol + eol) || before === eol) before = before.slice(0, -eol.length);
      else if (before === '' && after.startsWith(eol)) after = after.slice(eol.length);
    }
    out = before + after;
  }
  return out;
}

/**
 * Plans an edit of a Codex config.toml; the same result shape as planJsonEdit (reason for
 * refused: parse, or form when the server or mcp_servers is written in a form connect does not
 * edit: inline tables, dotted keys, arrays of tables). Only the [mcp_servers.<name>] block (and
 * its sub-tables when removing or replacing) changes; every other byte stays.
 */
export function planTomlEdit(text, { name, built, refs, remove = false, force = false }) {
  const src = text ?? '';
  const entry = built.owned;
  const snippet = tomlBlock(name, entry);
  let scan;
  try {
    scan = scanToml(src);
  } catch (err) {
    return { action: 'refused', reason: 'parse', error: err.message, others: [], snippet };
  }
  const eol = scan.eol;
  const servers = tomlServers(scan);
  const others = Object.keys(servers).filter((n) => n !== name && entryTarget(servers[n], refs).kind === 'this');
  const existing = Object.hasOwn(servers, name) ? servers[name] : undefined;
  const ours = existing !== undefined && entryTarget(existing, refs).kind === 'this';

  const mains = scan.tables.filter((t) => t.path.length === 2 && t.path[0] === 'mcp_servers' && t.path[1] === name);
  const subs = scan.tables.filter((t) => t.path.length > 2 && startsWith(t.path, ['mcp_servers', name]));
  const ownTables = new Set([...mains, ...subs]);
  // Our server defined by dotted keys or an inline table, outside its own tables.
  const stray = scan.pairs.some((pair) => startsWith(pair.path, ['mcp_servers', name]) && !ownTables.has(scan.tables[pair.table]));
  const sealed = scan.pairs.some((pair) => pair.path.length === 1 && pair.path[0] === 'mcp_servers')
    || scan.tables.some((t) => t.array && (t.path.length === 1 || t.path.length === 2) && t.path[0] === 'mcp_servers' && (t.path.length === 1 || t.path[1] === name));
  const manageable = !stray && !sealed && mains.length <= 1 && !mains.some((t) => t.array);

  let action;
  if (remove) {
    if (existing === undefined) return { action: 'absent', others };
    if (!ours && !force) return { action: 'conflict', others };
    action = 'remove';
  } else if (existing === undefined) {
    if (others.length && !force) return { action: 'connected-as', others };
    action = 'add';
  } else if (ours) {
    action = 'update';
  } else if (force) {
    action = 'replace';
  } else {
    return { action: 'conflict', others };
  }
  if (!manageable) return { action: 'refused', reason: 'form', planned: action, others, snippet, entry };

  const main = mains[0];
  let next;
  if (action === 'add') {
    let base = src;
    if (base.replace(/^\uFEFF/, '') !== '' && !base.endsWith('\n')) base += eol;
    const body = base.replace(/^\uFEFF/, '');
    const sep = body === '' || body.endsWith(eol + eol) || body === eol ? '' : eol;
    next = base + sep + tomlBlock(name, entry, eol);
  } else if (action === 'remove') {
    next = cutSpans(src, [...ownTables].map((t) => [t.start, t.contentEnd]), eol);
  } else if (action === 'replace') {
    // The foreign server goes entirely (its sub-tables too); ours takes the main block's place.
    const cutSubs = (t) => {
      const again = scanToml(t);
      const spans = again.tables.filter((tb) => tb.path.length > 2 && startsWith(tb.path, ['mcp_servers', name])).map((tb) => [tb.start, tb.contentEnd]);
      return cutSpans(t, spans, eol);
    };
    if (main) {
      next = cutSubs(src.slice(0, main.start) + tomlBlock(name, entry, eol) + src.slice(main.contentEnd));
    } else {
      const added = planTomlEdit(cutSubs(src), { name, built, refs, force: true });
      if (added.action !== 'add') return added;
      next = added.text;
    }
  } else {
    // update: replace the command and args lines in place, keep everything else of the block
    if (!main) return { action: 'refused', reason: 'form', planned: action, others, snippet, entry };
    const lines = tomlLines(entry, eol);
    const headerHasEol = /\n$/.test(src.slice(main.start, main.headerEnd));
    const edits = [];
    const inMain = scan.pairs.filter((pair) => scan.tables[pair.table] === main && pair.key.length === 1);
    for (const field of ['command', 'args']) {
      const pair = inMain.find((pr) => pr.key[0] === field);
      if (pair) {
        const old = src.slice(pair.start, pair.end);
        const indent = /^[ \t]*/.exec(old)[0];
        const line = /\n$/.test(old) ? lines[field] : lines[field].slice(0, -eol.length);
        edits.push([pair.start, pair.end, indent + line]);
      } else {
        edits.push([main.headerEnd, main.headerEnd, (headerHasEol ? '' : eol) + lines[field]]);
      }
    }
    if (!headerHasEol && edits.filter((e) => e[0] === main.headerEnd && e[1] === main.headerEnd).length === 2) {
      edits[1][2] = edits[1][2].slice(eol.length);
    }
    next = src;
    // Apply from the end; the two inserts at headerEnd keep their order (command, then args).
    const ordered = edits.map((e, idx) => ({ e, idx })).sort((a, b) => b.e[0] - a.e[0] || b.idx - a.idx);
    for (const { e: [start, end, repl] } of ordered) next = next.slice(0, start) + repl + next.slice(end);
    if (next === src) return { action: 'unchanged', entry, others };
  }
  return { action, text: next, entry, others };
}

/** The server entries of a TOML config text: [{scope, name, entry}]; throws on a parse error. */
export function tomlEntries(text) {
  return Object.entries(tomlServers(scanToml(text))).map(([name, entry]) => ({ scope: 'user', name, entry }));
}

// ---------------------------------------------------------------------------------------------
// Readers: which clients already serve a vault (connect --list, doctor)

function readEntries(file, row, io) {
  const text = io.readText(file);
  return row.format === 'toml' ? tomlEntries(text) : jsonEntries(text, row.key, row.id);
}

/**
 * The state of one client for a vault: {id, name, aliases, guide, format, path, paths,
 * appFound, state, entries: [{name, path, scope, project?, kind, root?}], errors: [{path,
 * error}]}. state: connected (an entry serves this vault), not-connected, app-not-found,
 * unreadable (the config cannot be read or parsed) or guidance (nothing to write for this
 * client).
 * opts: {vault, platform, env, home, pathMod, io, refs, cli} where cli (optional) is the path
 * of the client's command-line tool; for claude-code it also counts as "installed".
 */
export function inspectClient(id, opts = {}) {
  const c = context(opts);
  const io = opts.io ?? IO;
  const resolved = resolveClient(id, opts);
  const base = { id: resolved.id, name: resolved.name, aliases: resolved.aliases, guide: resolved.guide ?? null, format: resolved.format ?? null };
  if (resolved.guide) return { ...base, path: null, paths: [], appFound: false, state: 'guidance', entries: [], errors: [] };
  const refs = opts.refs ?? (opts.vault ? vaultRefs(opts.vault, { platform: c.platform, pathMod: c.p }) : { platform: c.platform, p: c.p, roots: [], scripts: [] });
  const located = locateClient(resolved, { pathMod: c.p, platform: c.platform, io });
  // Read every existing candidate too (a second VS Code channel, the other Windsurf file),
  // each real file once.
  const userFiles = byRealFile([...located.targets.map((t) => t.path), ...resolved.candidates.map((x) => x.path).filter((f) => io.isFile(f))], io).files;
  const files = userFiles.map((f) => ({ path: f, scope: 'user', portable: false }));
  const project = opts.vault ? projectConfigPath(resolved, opts.vault, { pathMod: c.p }) : null;
  if (project) files.push({ path: project, scope: 'project', portable: true });
  const entries = [];
  const errors = [];
  for (const f of files) {
    if (!io.isFile(f.path)) continue;
    let list;
    try {
      list = readEntries(f.path, resolved, io);
    } catch (err) {
      errors.push({ path: f.path, error: err.message });
      continue;
    }
    for (const e of list) {
      const target = entryTarget(e.entry, refs, { portable: f.portable });
      entries.push({
        name: e.name, path: f.path, scope: f.scope === 'project' ? 'project' : e.scope,
        ...(e.project ? { project: e.project } : {}),
        kind: target.kind ?? 'other', ...(target.root ? { root: target.root } : {}),
      });
    }
  }
  const appFound = located.appFound || files.some((f) => io.isFile(f.path) && f.scope === 'user') || Boolean(opts.cli);
  let state;
  if (entries.some((e) => e.kind === 'this')) state = 'connected';
  else if (errors.some((e) => located.targets.some((t) => t.path === e.path))) state = 'unreadable';
  else state = appFound ? 'not-connected' : 'app-not-found';
  return {
    ...base,
    path: located.targets[0]?.path ?? null,
    paths: located.targets.map((t) => t.path),
    appFound,
    state,
    entries: entries.filter((e) => e.kind !== 'other'),
    errors,
    notes: located.notes,
  };
}

/** inspectClient for every client, in table order. */
export function inspectClients(opts = {}) {
  const c = context(opts);
  const refs = opts.vault ? vaultRefs(opts.vault, { platform: c.platform, pathMod: c.p }) : undefined;
  return CLIENTS.map((row) => {
    const cli = row.cli ? (opts.findCli ?? findExecutable)(row.cli, { platform: c.platform, env: c.env, pathMod: c.p, io: opts.io ?? IO }) : null;
    return inspectClient(row.id, { ...opts, refs, cli });
  });
}

// ---------------------------------------------------------------------------------------------
// Running a client's own command-line tool (claude mcp add)

const RUNNABLE_EXT = new Set(['.exe', '.com', '.cmd', '.bat']);

/**
 * The first executable called name on PATH, or null. Windows: PATHEXT (only .exe, .com, .cmd
 * and .bat, which can be started from Node); elsewhere: the execute bit. Relative PATH
 * entries are skipped, since they depend on the current folder.
 */
export function findExecutable(name, { platform = process.platform, env = process.env, pathMod, io = IO } = {}) {
  const p = pathMod ?? pathModFor(platform);
  const raw = envGet(env, 'PATH', platform) ?? '';
  const dirs = raw.split(platform === 'win32' ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts = platform === 'win32'
    ? (envGet(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toLowerCase()).filter((e) => RUNNABLE_EXT.has(e))
    : [''];
  for (const dir of dirs) {
    if (!p.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (platform === 'win32' ? io.isFile(file) : io.isExecutable(file)) return file;
    }
  }
  return null;
}

/**
 * `claude mcp add` for the user scope; `--` keeps --root from being read as Claude's option.
 * env values come first as -e KEY=VALUE: -e takes several values, so placed right before the
 * name it would swallow the name.
 */
export function claudeAddArgs(name, { command, args }, { env = {} } = {}) {
  const vars = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return ['mcp', 'add', ...vars, '--scope', 'user', '--transport', 'stdio', name, '--', command, ...args];
}

/** `claude mcp remove` for the user scope. */
export function claudeRemoveArgs(name) {
  return ['mcp', 'remove', '--scope', 'user', name];
}

// cmd.exe metacharacters; each gets a caret so cmd passes it through literally.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The text after `cmd.exe /d /s /c` (without its outer quotes) that runs a .cmd or .bat file
 * with args, each argument arriving unchanged in the program the batch file starts. The file
 * is quoted. Every argument is quoted for the C runtime (trailing backslashes doubled) and then
 * caret-escaped, its quotes too, so cmd.exe sees no quoted region, removes the carets and
 * treats nothing as special; the batch file's %* then hands on the quoted arguments. null when
 * a value cannot be passed safely this way (a quote, % or a line break in the file path; a
 * quote, NUL or a line break in an argument), so the caller writes the config itself.
 */
export function windowsCommandLine(file, args) {
  if (/["%\r\n\0]/.test(file)) return null;
  if (args.some((a) => /["\r\n\0]/.test(String(a)))) return null;
  const quoted = args.map((a) => `"${String(a).replace(/(\\+)$/, '$1$1')}"`.replace(CMD_META, '^$1'));
  return [`"${file}"`, ...quoted].join(' ');
}

/**
 * How to start file with args without a shell: {command, args, options}. On Windows a .cmd or
 * .bat file runs through cmd.exe (Node refuses to start one directly), with the command line
 * built by windowsCommandLine and passed verbatim; delayed expansion is switched off so '!'
 * stays literal. null when that command line cannot be built safely.
 */
export function spawnSpec(file, args, { platform = process.platform, env = process.env } = {}) {
  const base = { windowsHide: true };
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    const line = windowsCommandLine(file, args);
    if (line === null) return null;
    const shell = envGet(env, 'ComSpec', platform) ?? 'cmd.exe';
    return { command: shell, args: ['/d', '/v:off', '/s', '/c', `"${line}"`], options: { ...base, windowsVerbatimArguments: true } };
  }
  return { command: file, args: [...args], options: base };
}
