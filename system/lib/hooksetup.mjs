// `connect claude-code|codex --projects`: installs the user-level hooks that give every coding
// project its memory (commands/hook.mjs) and writes the "projects" settings of memory.json.
// Claude Code reads $CLAUDE_CONFIG_DIR/settings.json (~/.claude) in the terminal, in VS Code and in
// JetBrains alike; Codex reads $CODEX_HOME/hooks.json (~/.codex). The hooks use the shell form, one
// command string that every Claude Code version runs: the executable a bare word, each path in
// double quotes, forward slashes on Windows, so /bin/sh, Git Bash, PowerShell and cmd.exe read it
// the same. A vault path no shell passes on safely (" $ ` % ! or a line break) gets the exec form
// (command + args, no shell) when every Claude Code seen here is 2.1.139 or newer; otherwise
// nothing is written. PostToolUseFailure is written only when every Claude Code seen here is
// 2.1.101 or newer (older ones ignore the whole settings file for one event they do not know).
// Other hooks and keys are kept, the file is read again right before it is replaced atomically,
// a copy goes to .memory-kit/backups/connect/, and a file that is not plain JSON is never
// rewritten: the hooks to paste come back instead. installProjects() prints nothing;
// commands/connect.mjs prints formatInstall() of its result, the setup wizard renders it its way.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './fsafe.mjs';
import { detectStyle, formatJson } from './jsonc.mjs';
import { envGet, nodeCommand, scanToml } from './clients.mjs';
import { git, interpolate, isDir, resolvePath } from './util.mjs';

/** The agents with project hooks and the names people know them by. */
export const AGENTS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });

/** memory.json "projects" when nobody chose otherwise: nothing is added or pushed by itself. */
export const SAFE_DEFAULTS = Object.freeze({ auto_add: false, store: 'local', autosync: false });

// Claude Code runs "args" (exec form) from 2.1.139 on; older versions run a bare `node`.
export const CLAUDE_EXEC_MIN = '2.1.139';
// Before 2.1.101 one unknown event makes Claude Code ignore the whole settings file.
export const CLAUDE_FAILURE_MIN = '2.1.101';
// Codex runs hooks by default from 0.124 and reads commandWindows from 0.131.
export const CODEX_HOOKS_MIN = '0.124.0';
export const CODEX_WINDOWS_MIN = '0.131.0';
export const NODE_MIN = '22.5.0';

const BACKUP_DIR = '.memory-kit/backups/connect';
const CLI_TIMEOUT_MS = 5000;
const TRANSCRIPTS = 5; // the newest transcripts read for the version that wrote them
const PROJECT_DIRS = 20; // transcript folders looked into, the newest first
const TAIL_BYTES = 256 * 1024;
const HEAD_BYTES = 16 * 1024;
const WRITE_TRIES = 3;

/** The hooks per agent: [settings event, hook event, matcher, timeout in seconds]. */
export const EVENTS = Object.freeze({
  'claude-code': Object.freeze([
    ['SessionStart', 'session-start', 'startup|resume|clear|compact', 20],
    ['Stop', 'stop', null, 10],
    ['PostToolUseFailure', 'tool-failure', 'Bash|PowerShell', 5],
    ['SessionEnd', 'session-end', null, 5], // the detached child does the slow work
  ]),
  codex: Object.freeze([
    ['SessionStart', 'session-start', null, 20],
    ['Stop', 'stop', null, 10],
    ['SessionEnd', 'session-end', null, 3], // Codex allows at most 3 seconds
  ]),
});

// English defaults; packs may translate the same keys (section 4.10).
const HOOKSETUP_DEFAULTS = {
  'connect.projects.installed': '{agent}: memory hooks installed in {path}',
  'connect.projects.updated': '{agent}: memory hooks updated in {path}',
  'connect.projects.unchanged': '{agent}: the memory hooks are already in {path}',
  'connect.projects.removed': '{agent}: memory hooks removed from {path}',
  'connect.projects.absent': '{agent}: {path} has no memory hooks, nothing to remove',
  'connect.projects.plan_install': '{agent}: would install memory hooks in {path}',
  'connect.projects.plan_update': '{agent}: would update the memory hooks in {path}',
  'connect.projects.plan_remove': '{agent}: would remove the memory hooks from {path}',
  'connect.projects.dry_run': 'dry run: nothing was changed',
  'connect.projects.backup': 'the previous file is kept in {path}',
  'connect.projects.events': 'events: {list}',
  'connect.projects.form_shell': 'form: shell command, {command}',
  'connect.projects.form_exec': 'form: exec (no shell, needs Claude Code 2.1.139 or newer), {command}',
  'connect.projects.seen': '{agent} seen here: {list}',
  'connect.projects.seen_none': '{agent} seen here: no version found',
  'connect.projects.source.extension': '{editor} extension',
  'connect.projects.source.sessions': 'recent sessions',
  'connect.projects.settings': 'settings in memory.json "projects":',
  'connect.projects.default': 'default',
  'connect.projects.auto_add_on': 'the first session in a new repository gives it a memory by itself',
  'connect.projects.auto_add_off': 'a repository gets a memory only when you add it',
  'connect.projects.store_local': 'dev notes stay on this computer, in {path}',
  'connect.projects.store_local_new': 'dev notes stay on this computer, in {path} (made with the first project)',
  'connect.projects.store_git': 'dev notes go into this memory repository and travel with it',
  'connect.projects.autosync_on': 'at the end of a session the memory commits and pushes itself',
  'connect.projects.autosync_off': 'nothing is committed or pushed by itself',
  'connect.projects.privacy': 'privacy: the hooks run in every repository you open, so nothing is added to the memory or pushed unless you opt in (--auto-add, --store git, --autosync)',
  'connect.projects.privacy_on': 'privacy: the hooks run in every repository you open, work and client ones too; with {list} on, make sure their notes may go where this memory goes',
  'connect.projects.disabled': 'memory.json "projects": enabled is now false, the other settings stay',
  'connect.projects.still_enabled': '{agent} still has memory hooks, so memory.json "projects" stays enabled',
  'connect.projects.warning': 'warning: {text}',
  'connect.projects.next': 'next: {text}',
  'connect.projects.fix': 'fix: {text}',
  'connect.projects.next.claude-code': 'start a new Claude Code session in a code repository (running sessions keep their hooks; in VS Code reload the window) and accept the folder trust dialog when it asks',
  'connect.projects.next.codex': 'start Codex, open /hooks and trust the memory hooks (Codex runs a new or changed hook only after that)',
  'connect.projects.next.add': 'give a repository its memory: run node {script} project add inside it, or connect again with --auto-add',
  'connect.projects.next.check': 'node system/memory.mjs doctor checks the hooks (line projects.hooks)',
  'connect.projects.next.remove': 'new sessions start without the memory hooks; the notes stay in the memory',
  'connect.projects.enabled_anyway': 'memory.json "projects" is set, so the hooks work as soon as they are in the file',
  'connect.projects.warn.failure_unknown': 'PostToolUseFailure (the error lookup) is left out because no Claude Code version was found here; update Claude Code to 2.1.101 or newer, use it once, then connect again',
  'connect.projects.warn.failure_old': 'PostToolUseFailure (the error lookup) is left out because Claude Code {version} is older than 2.1.101 and would ignore the whole settings file; update Claude Code (claude update), then connect again',
  'connect.projects.warn.exec_unknown': 'the exec form needs Claude Code 2.1.139 or newer and no version was found here; older versions run a bare node instead of the hook',
  'connect.projects.warn.exec_old': 'the exec form needs Claude Code 2.1.139 or newer, but {version} was seen here; it runs a bare node instead of the hook',
  'connect.projects.warn.exec_path': 'the memory path contains {chars}, which no shell passes on safely, so the exec form is used (every Claude Code seen here is 2.1.139 or newer)',
  'connect.projects.warn.exec_node': 'the path of Node.js ({node}) has spaces and no short 8.3 name, so the exec form is used (every Claude Code seen here is 2.1.139 or newer)',
  'connect.projects.warn.node_quoted': 'node is not on the PATH and the path of Node.js ({node}) has spaces: the hook works where Claude Code runs hooks in Git Bash, not in PowerShell; put node on the PATH, or update Claude Code to 2.1.139 or newer, then connect again',
  'connect.projects.warn.node_absolute': 'node on the PATH is missing or older than {need}, so the hooks start {node}; after moving or updating Node.js, connect again',
  'connect.projects.warn.codex_exec': 'Codex has no exec form, so the shell form is used',
  'connect.projects.warn.codex_old': 'Codex {version} runs hooks only with [features] hooks = true in config.toml (on by default from 0.124); update Codex',
  'connect.projects.warn.codex_windows': 'Codex {version} on Windows reads commandWindows only from 0.131 on and runs no hooks before 0.120; update Codex',
  'connect.projects.warn.codex_off': '{path} turns hooks off ([features] {key} = false); delete that line or set it to true',
  'connect.projects.warn.disabled_all': '{path} has "disableAllHooks": true, so Claude Code runs no hooks at all; delete that key',
  'connect.projects.warn.other_vault': 'the memory hooks of another memory ({path}) were replaced',
  'connect.projects.warn.autosync_remote': 'autosync is on, but this memory has no git remote, so the sync at the end of a session fails; add a remote, or connect again with --no-autosync',
  'connect.projects.warn.autosync_local': 'autosync is on, but memory.json "mode" is local, so the sync at the end of a session fails; connect again with --no-autosync',
  'connect.projects.refused.not_vault': 'no memory-kit vault here: {path} is missing',
  'connect.projects.refused.config': 'memory.json cannot be read ({error}), so nothing was changed',
  'connect.projects.refused.config_fix': 'node system/memory.mjs doctor shows what is wrong with memory.json',
  'connect.projects.refused.autosync_remote': '--autosync needs a git remote, and this memory has none, so nothing was changed',
  'connect.projects.refused.autosync_remote_fix': 'create a private repository, run git remote add origin <its URL> and node system/memory.mjs sync, then connect again with --autosync',
  'connect.projects.refused.autosync_local': '--autosync needs a memory that syncs through git, but memory.json "mode" is local, so nothing was changed',
  'connect.projects.refused.autosync_local_fix': 'connect without --autosync; the memory stays on this computer',
  'connect.projects.refused.unsafe_path': 'the memory path {path} contains {chars}, which a hook command cannot pass safely through every shell, so nothing was changed',
  'connect.projects.refused.unsafe_path_fix': 'move the memory to a folder whose path has none of " $ ` % ! (for example in your home folder), then connect again',
  'connect.projects.refused.unsafe_path_claude_fix': 'move the memory to a folder whose path has none of " $ ` % ! (for example in your home folder), or update Claude Code to 2.1.139 or newer and use it once (the exec form needs no shell); then connect again',
  'connect.projects.refused.unsafe_node': 'node is not on the PATH, and the path of Node.js ({node}) contains {chars}, which a hook command cannot pass safely, so nothing was changed',
  'connect.projects.refused.unsafe_node_fix': 'install Node.js {need} or newer so that node is on the PATH, then connect again',
  'connect.projects.refused.not_json': '{path} is not plain JSON (comments or a syntax error), so it is left alone. Add these hooks yourself:',
  'connect.projects.refused.not_json_remove': '{path} is not plain JSON (comments or a syntax error), so it is left alone; delete the hooks that run system/memory.mjs hook {id} yourself',
  'connect.projects.refused.layout': '{path} does not have the expected layout ("hooks" must be an object of lists). Add these hooks yourself:',
  'connect.projects.refused.unreadable': '{path} cannot be read ({error}), so nothing was changed',
  'connect.projects.refused.unreadable_fix': 'fix the file or its permissions, then connect again',
  'connect.projects.refused.link': '{path} is a link to {target}, whose folder does not exist, so nothing was changed',
  'connect.projects.refused.link_fix': 'create that folder or remove the link, then connect again',
  'connect.projects.refused.changed': '{path} kept changing while connecting (another program writes it), so it was not written',
  'connect.projects.refused.write': '{path} could not be written ({error})',
  'connect.projects.refused.write_fix': 'close {agent} and connect again',
};

/** Every message key of connect --projects with its English text. */
export const MESSAGES = Object.freeze({ ...HOOKSETUP_DEFAULTS });

/** A message in the vault's language (a cfg.t-style translator) or the English default. */
export function say(t, key, vars = {}) {
  const text = typeof t === 'function' ? t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(HOOKSETUP_DEFAULTS[key] ?? key, vars);
}

// ---------------------------------------------------------------------------------------------
// Versions

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 'x.y.z' from a text such as '2.1.282 (Claude Code)' or 'codex-cli 0.124.0', or null. */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** -1, 0 or 1 comparing two 'x.y.z' (suffixes ignored); null when one cannot be read. */
export function cmpVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  const p = x.split('.').map(Number);
  const q = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  return 0;
}

/** True when version is known and at least min. */
export const atLeast = (version, min) => typeof version === 'string' && cmpVersion(version, min) >= 0;

function pickVersion(list, dir) {
  let best = null;
  for (const v of list) {
    const p = parseVersion(v);
    if (p && (best === null || cmpVersion(p, best) === dir)) best = p;
  }
  return best;
}

/** The newest of some versions, or null. */
export const maxVersion = (list) => pickVersion(list, 1);
/** The oldest of some versions, or null. */
export const minVersion = (list) => pickVersion(list, -1);

/**
 * `<name> --version` as 'x.y.z', or null (not installed, a timeout, no version in the output).
 * On Windows through cmd.exe, since npm installs claude and codex as .cmd files, which Node
 * cannot start without a shell. run is spawnSync (tests replace it).
 */
export function cliVersion(name, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], env };
  let res;
  try {
    res = platform === 'win32'
      ? run(envGet(env, 'ComSpec', platform) ?? 'cmd.exe', ['/d', '/s', '/c', `"${name} --version"`], { ...options, windowsVerbatimArguments: true })
      : run(name, ['--version'], options);
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0) return null;
  return parseVersion(res.stdout);
}

// The folders of VS Code-family editors whose extensions/ may hold anthropic.claude-code-X.Y.Z.
const EDITORS = [['.vscode', 'VS Code'], ['.vscode-insiders', 'VS Code Insiders'], ['.cursor', 'Cursor'], ['.windsurf', 'Windsurf'], ['.vscode-server', 'VS Code Server']];

function readdirOrEmpty(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** The newest Claude Code extension of each editor: [{source: 'extension', editor, version}]. */
export function extensionVersions(home) {
  const out = [];
  for (const [dir, editor] of EDITORS) {
    const versions = readdirOrEmpty(path.join(home, dir, 'extensions'))
      .map((n) => /^anthropic\.claude-code-(\d+\.\d+\.\d+)(?:$|[-+])/i.exec(n)?.[1])
      .filter(Boolean);
    const newest = maxVersion(versions);
    if (newest) out.push({ source: 'extension', editor, version: newest });
  }
  return out;
}

/** At most bytes of a file, from its end (tail) or its start: {text, whole}, or null. */
function readPart(file, bytes, { tail }) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const got = fs.readSync(fd, buf, 0, len, tail ? size - len : 0);
    return { text: buf.subarray(0, got).toString('utf8'), whole: len === size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The newest *.jsonl files in the folders depth levels under dir, newest first: [{file, mtime}]. */
function newestFiles(dir, limit, { depth = 1 } = {}) {
  const subdirs = readdirOrEmpty(dir).map((n) => path.join(dir, n)).filter((p) => isDir(p))
    .map((p) => ({ p, m: mtimeOf(p) })).sort((a, b) => b.m - a.m || (a.p < b.p ? 1 : -1)).slice(0, PROJECT_DIRS);
  const files = [];
  for (const { p } of subdirs) {
    if (depth > 1) {
      files.push(...newestFiles(p, limit, { depth: depth - 1 }));
      continue;
    }
    for (const n of readdirOrEmpty(p)) if (n.endsWith('.jsonl')) files.push({ file: path.join(p, n), mtime: mtimeOf(path.join(p, n)) });
  }
  return files.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : 1)).slice(0, limit);
}

/** The top-level "version" of the last transcript line that has one, with its "entrypoint". */
function lastVersionLine(part) {
  const lines = part.text.split('\n');
  const first = part.whole ? 0 : 1; // a tail read may start in the middle of a line
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.includes('"version"')) continue;
    try {
      const j = JSON.parse(line);
      if (typeof j.version === 'string' && /^\d+\.\d+\.\d+/.test(j.version)) {
        return { version: parseVersion(j.version), entrypoint: typeof j.entrypoint === 'string' ? j.entrypoint : null };
      }
    } catch {
      /* not a whole JSON line */
    }
  }
  return null;
}

/** Where Claude Code keeps its settings and transcripts ($CLAUDE_CONFIG_DIR, else ~/.claude). */
export function claudeDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  return envGet(env, 'CLAUDE_CONFIG_DIR', platform) ?? path.join(home, '.claude');
}

/** Where Codex keeps its config, hooks and sessions ($CODEX_HOME, else ~/.codex). */
export function codexDir({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  return envGet(env, 'CODEX_HOME', platform) ?? path.join(home, '.codex');
}

/**
 * The versions that wrote the newest transcripts (<configDir>/projects/<folder>/*.jsonl, read
 * from their end): [{source: 'sessions', version, entrypoints}], one per version, newest first.
 */
export function transcriptVersions(configDir, { limit = TRANSCRIPTS } = {}) {
  const byVersion = new Map();
  for (const { file } of newestFiles(path.join(configDir, 'projects'), limit)) {
    const part = readPart(file, TAIL_BYTES, { tail: true });
    const hit = part && lastVersionLine(part);
    if (!hit) continue;
    const row = byVersion.get(hit.version) ?? { source: 'sessions', version: hit.version, entrypoints: [] };
    if (hit.entrypoint && !row.entrypoints.includes(hit.entrypoint)) row.entrypoints.push(hit.entrypoint);
    byVersion.set(hit.version, row);
  }
  return [...byVersion.values()].sort((a, b) => cmpVersion(b.version, a.version));
}

/**
 * Every Claude Code version seen on this computer, from `claude --version`, the VS Code-family
 * extensions and the newest transcripts: {observed: [{source, version, editor?, entrypoints?}],
 * min}. min is the oldest (null when none was seen): a hook must work in all of them.
 */
export function claudeVersions({ env = process.env, home = os.homedir(), platform = process.platform, run } = {}) {
  const observed = [];
  const cli = cliVersion('claude', { platform, env, run });
  if (cli) observed.push({ source: 'cli', version: cli });
  observed.push(...extensionVersions(home));
  observed.push(...transcriptVersions(claudeDir({ env, home, platform })));
  return { observed, min: minVersion(observed.map((o) => o.version)) };
}

/**
 * What Codex shows here: {observed: [{source: 'cli', version}], min, off: {path, key} | null}.
 * off names a config.toml setting that turns hooks off ([features] hooks or codex_hooks = false).
 */
export function codexInfo({ env = process.env, home = os.homedir(), platform = process.platform, run } = {}) {
  const version = cliVersion('codex', { platform, env, run });
  const config = path.join(codexDir({ env, home, platform }), 'config.toml');
  let off = null;
  try {
    const scan = scanToml(fs.readFileSync(config, 'utf8'));
    const hit = scan.pairs.find((p) => p.path.length === 2 && p.path[0] === 'features' && ['hooks', 'codex_hooks'].includes(p.path[1]) && p.value === false);
    if (hit) off = { path: config, key: hit.path[1] };
  } catch {
    /* no config.toml, or one Codex itself would refuse */
  }
  return { observed: version ? [{ source: 'cli', version }] : [], min: version, off };
}

/**
 * The start (ms) of the newest session the transcripts of an agent show, from the first
 * "timestamp" of the newest transcripts: Claude Code <config>/projects/<folder>/*.jsonl, Codex
 * <codex home>/sessions/<yyyy>/<mm>/<dd>/*.jsonl. 0 when there is none.
 */
export function newestSessionStart(agent, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const files = agent === 'codex'
    ? newestFiles(path.join(codexDir({ env, home, platform }), 'sessions'), TRANSCRIPTS, { depth: 3 })
    : newestFiles(path.join(claudeDir({ env, home, platform }), 'projects'), TRANSCRIPTS);
  let newest = 0;
  for (const { file } of files) {
    const part = readPart(file, HEAD_BYTES, { tail: false });
    for (const line of part ? part.text.split('\n').slice(0, 20) : []) {
      const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      const ms = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(ms)) {
        newest = Math.max(newest, ms);
        break;
      }
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------------------------
// The hook commands (pure: the platform comes in, nothing is read)

const toSlashes = (p) => String(p).replace(/\\/g, '/');

/**
 * The characters of a path that no hook shell passes on safely inside double quotes: " $ `
 * (sh, bash and PowerShell expand them), % (cmd.exe, which Codex uses on Windows), ! and line
 * breaks; on macOS and Linux also \ (Windows paths get forward slashes instead).
 */
export function unsafeChars(p, platform = process.platform) {
  const set = ['"', '$', '`', '%', '!', '\n', '\r', ...(platform === 'win32' ? [] : ['\\'])];
  return set.filter((ch) => String(p).includes(ch)).map((ch) => (ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch));
}

// A word every hook shell reads as it is, without quotes: letters of any script, digits, _ . / : + ~ -.
const BARE_WORD = /^[\p{L}\p{N}_./:+][\p{L}\p{N}_./:+~-]*$/u;

/** The vault's memory.mjs as a hook names it: forward slashes on Windows. */
export function hookScript(vault, platform = process.platform) {
  return platform === 'win32' ? toSlashes(path.win32.join(vault, 'system', 'memory.mjs')) : path.posix.join(vault, 'system', 'memory.mjs');
}

/** `<node> "<script>" hook <agent> <event>`: the shell form. */
export function shellCommand(nodeWord, script, agent, event) {
  return `${nodeWord} "${script}" hook ${agent} ${event}`;
}

/**
 * How a hook starts Node.js: {word, exe, via, quoted?, bad?}. word goes into a shell command
 * (null when no bare or quoted form is safe), exe into the exec form. 'node' when the node on the
 * PATH is new enough (pathVersion); else the absolute path (execPath): double-quoted on macOS and
 * Linux; on Windows a bare word when it has no spaces, else its 8.3 short name (shortPath), else
 * none (quoted then holds the quoted form, which Git Bash and cmd.exe read but PowerShell does not).
 */
export function chooseNode({ platform = process.platform, pathVersion = null, execPath, shortPath = () => null }) {
  if (atLeast(pathVersion, NODE_MIN)) return { word: 'node', exe: 'node', via: 'path' };
  if (platform !== 'win32') {
    const bad = unsafeChars(execPath, platform);
    return { word: bad.length ? null : `"${execPath}"`, exe: execPath, via: 'absolute', bad };
  }
  const exe = toSlashes(execPath);
  if (BARE_WORD.test(exe)) return { word: exe, exe: execPath, via: 'absolute' };
  const short = shortPath(execPath);
  if (short && BARE_WORD.test(toSlashes(short))) return { word: toSlashes(short), exe: execPath, via: 'short' };
  const bad = unsafeChars(exe, platform);
  return { word: null, exe: execPath, via: 'absolute', quoted: bad.length ? null : `"${exe}"`, bad };
}

/**
 * The form of the hooks: {form: 'shell'|'exec', nodeWord?, exe?, warnings: [{key, vars}]} or
 * {refused: {key, fixKey, vars}}. min is the oldest Claude Code seen here (null: none seen),
 * requested is --form. The shell form, unless exec is asked for, or is needed and safe (every
 * Claude Code seen is 2.1.139 or newer) for a vault path no shell passes on or a Windows node
 * path with spaces and no short name. Codex has only the shell form.
 */
export function planForm({ agent, platform = process.platform, script, requested = 'shell', min = null, node }) {
  const warnings = [];
  const execOk = agent === 'claude-code' && atLeast(min, CLAUDE_EXEC_MIN);
  const bad = unsafeChars(script, platform);
  const exec = (key, vars = {}) => {
    if (key) warnings.push({ key, vars });
    return { form: 'exec', exe: node.exe, warnings };
  };
  const shell = (nodeWord) => {
    if (node.via !== 'path') warnings.push({ key: 'connect.projects.warn.node_absolute', vars: { node: node.exe, need: NODE_MIN } });
    return { form: 'shell', nodeWord, warnings };
  };
  const unsafeNode = () => ({
    refused: {
      key: 'connect.projects.refused.unsafe_node', fixKey: 'connect.projects.refused.unsafe_node_fix',
      vars: { node: node.exe, chars: (node.bad ?? []).join(' '), need: NODE_MIN },
    },
  });
  const unsafePath = (fixKey) => ({ refused: { key: 'connect.projects.refused.unsafe_path', fixKey, vars: { path: script, chars: bad.join(' ') } } });
  if (agent === 'codex') {
    if (requested === 'exec') warnings.push({ key: 'connect.projects.warn.codex_exec', vars: {} });
    if (bad.length) return unsafePath('connect.projects.refused.unsafe_path_fix');
    // cmd.exe (Codex on Windows) reads a quoted program path, so spaces there are fine.
    const word = node.word ?? node.quoted;
    return word ? shell(word) : unsafeNode();
  }
  if (requested === 'exec') {
    if (execOk) return exec(null);
    return min === null ? exec('connect.projects.warn.exec_unknown') : exec('connect.projects.warn.exec_old', { version: min });
  }
  if (bad.length) return execOk ? exec('connect.projects.warn.exec_path', { chars: bad.join(' ') }) : unsafePath('connect.projects.refused.unsafe_path_claude_fix');
  if (node.word) return shell(node.word);
  if (execOk) return exec('connect.projects.warn.exec_node', { node: node.exe });
  if (platform === 'win32' && node.quoted) {
    warnings.push({ key: 'connect.projects.warn.node_quoted', vars: { node: node.exe } });
    return { form: 'shell', nodeWord: node.quoted, warnings };
  }
  return unsafeNode();
}

/** The events to install: {events: [[name, event, matcher, timeout]], omitted: [name]}. */
export function eventsFor(agent, min) {
  const all = EVENTS[agent];
  if (agent !== 'claude-code' || atLeast(min, CLAUDE_FAILURE_MIN)) return { events: [...all], omitted: [] };
  return { events: all.filter(([name]) => name !== 'PostToolUseFailure'), omitted: ['PostToolUseFailure'] };
}

/** One hook entry. Codex on Windows gets commandWindows too (the same cmd.exe-safe string). */
export function hookHandler(agent, event, timeout, plan, { script, platform = process.platform }) {
  if (plan.form === 'exec') return { type: 'command', command: plan.exe, args: [script, 'hook', agent, event], timeout };
  const command = shellCommand(plan.nodeWord, script, agent, event);
  if (agent === 'codex' && platform === 'win32') return { type: 'command', command, commandWindows: command, timeout };
  return { type: 'command', command, timeout };
}

/** {<settings event>: group} for the chosen events and form. */
export function hookGroups(agent, events, plan, { script, platform = process.platform }) {
  const out = {};
  for (const [name, event, matcher, timeout] of events) {
    out[name] = { ...(matcher ? { matcher } : {}), hooks: [hookHandler(agent, event, timeout, plan, { script, platform })] };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Settings files

/** Where each agent keeps its user hooks. */
export function settingsPath(agent, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (agent === 'claude-code') return path.join(claudeDir({ env, home, platform }), 'settings.json');
  return path.join(codexDir({ env, home, platform }), 'hooks.json');
}

/** True for a hook entry that runs `system/memory.mjs hook <agent>` (either form). */
export function isOurs(h, agent) {
  if (!isObj(h)) return false;
  const text = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === 'string').join(' ');
  return /memory\.mjs/i.test(text) && new RegExp(`(?:^|[\\s"'])hook\\s+${agent}(?:\\s|$)`).test(text);
}

const SHELL_RE = /^\s*(?:&\s*)?(?:"([^"]*)"|(\S+))\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s+hook\s+([a-z-]+)\s+([a-z-]+)\s*$/;

/**
 * What one of our hook entries runs: {form, node, script, agent, event} (node and script as
 * written, without quotes), or null for a command of another shape.
 */
export function parseHandler(h) {
  if (!isObj(h)) return null;
  if (Array.isArray(h.args)) {
    const [script, word, agent, event] = h.args;
    if (typeof h.command !== 'string' || typeof script !== 'string' || word !== 'hook') return null;
    return { form: 'exec', node: h.command, script, agent: agent ?? null, event: event ?? null };
  }
  const m = typeof h.command === 'string' ? SHELL_RE.exec(h.command) : null;
  if (!m) return null;
  return { form: 'shell', node: m[1] ?? m[2], script: m[3] ?? m[4] ?? m[5], agent: m[6], event: m[7] };
}

/** Our hook entries in a settings object: [{name (the settings event), matcher, handler, parsed}]. */
export function ourHooks(settings, agent) {
  const out = [];
  const hooks = isObj(settings) && isObj(settings.hooks) ? settings.hooks : {};
  for (const [name, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      for (const h of isObj(g) && Array.isArray(g.hooks) ? g.hooks : []) {
        if (isOurs(h, agent)) out.push({ name, matcher: typeof g.matcher === 'string' ? g.matcher : '', handler: h, parsed: parseHandler(h) });
      }
    }
  }
  return out;
}

/** True when settings can take groups: an object whose "hooks" (if any) is an object of lists. */
export function layoutFits(settings, names) {
  if (!isObj(settings)) return false;
  if (settings.hooks === undefined) return true;
  if (!isObj(settings.hooks)) return false;
  return names.every((n) => settings.hooks[n] === undefined || Array.isArray(settings.hooks[n]));
}

/**
 * The settings object with our hooks set to groups ({<settings event>: group}), or only taken out
 * with remove. Pure. Every other key, group and hook stays where it is; our group takes the place
 * of our old one, so a run that changes nothing gives an equal object (Codex asks to trust a hook
 * again when its place or its text changes). A group shared with foreign hooks keeps them.
 */
export function planHooks(settings, agent, { groups = {}, remove = false } = {}) {
  const out = structuredClone(isObj(settings) ? settings : {});
  const had = isObj(out.hooks);
  const hooks = had ? out.hooks : {};
  const want = remove ? {} : groups;
  let removedAny = false;
  for (const name of [...Object.keys(hooks), ...Object.keys(want).filter((n) => !Object.hasOwn(hooks, n))]) {
    const desired = want[name];
    const list = hooks[name];
    if (list === undefined) {
      if (desired) hooks[name] = [desired];
      continue;
    }
    if (!Array.isArray(list)) continue;
    const next = [];
    let placed = false;
    let removed = false;
    for (const g of list) {
      const inner = isObj(g) && Array.isArray(g.hooks) ? g.hooks : null;
      if (!inner || !inner.some((h) => isOurs(h, agent))) {
        next.push(g);
        continue;
      }
      removed = true;
      const others = inner.filter((h) => !isOurs(h, agent));
      if (others.length) next.push({ ...g, hooks: others });
      if (desired && !placed) {
        next.push(desired);
        placed = true;
      }
    }
    if (desired && !placed) next.push(desired);
    removedAny ||= removed;
    if (next.length || !removed) hooks[name] = next;
    else delete hooks[name];
  }
  if (Object.keys(hooks).length || (had && !removedAny)) out.hooks = hooks;
  else delete out.hooks;
  return out;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** {text, exists} of a settings file ('' when there is none), or {error}. */
function readSettings(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), exists: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { text: '', exists: false };
    return { error: String(err?.code ?? err?.message ?? err) };
  }
}

/** The settings object of a text: {value} ('' is an empty object) or {error: 'json'}. */
function parseSettings(text) {
  if (!text.trim()) return { value: {} };
  try {
    return { value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch {
    return { error: 'json' };
  }
}

/** Where a write to file lands: file, or the real file its symlink leads to. Throws for a link into a missing folder. */
function writeTarget(file) {
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return file;
  } catch {
    return file;
  }
  try {
    return fs.realpathSync(file);
  } catch {
    const target = path.resolve(path.dirname(file), fs.readlinkSync(file));
    if (isDir(path.dirname(target))) return target;
    throw Object.assign(new Error(`dangling link: ${file}`), { code: 'LINK', target });
  }
}

/** YYYYMMDD-HHMMSS in local time, as connect names its backups. */
function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Copies file into <vault>/.memory-kit/backups/connect/ (never over an older copy); the copy's path. */
function backupFile(vault, label, file, now) {
  const dir = path.join(vault, ...BACKUP_DIR.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const dest = path.join(dir, `${label}-${stamp(now)}${n > 1 ? `-${n}` : ''}.json`);
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    // Settings can hold other tools' keys: only the owner may read the copy.
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o600);
    return dest;
  }
}

function modeOf(file) {
  if (process.platform === 'win32') return undefined;
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Probes of this computer (tests replace them through opts.io)

/** The 8.3 short name of a Windows path, from cmd.exe (for %I in ("p") do @echo %~sI), or null. */
function windowsShortPath(p, { env = process.env } = {}) {
  if (/["%\r\n]/.test(p)) return null;
  try {
    const res = spawnSync(envGet(env, 'ComSpec', 'win32') ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
      encoding: 'latin1', windowsHide: true, timeout: CLI_TIMEOUT_MS, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(res.stdout ?? '').trim().split(/\r?\n/)[0] ?? '';
    return !res.error && res.status === 0 && /^[\x21-\x7e]+$/.test(line) && fs.existsSync(line) ? line : null;
  } catch {
    return null;
  }
}

/** The probes installProjects uses (tests replace them). */
export const IO = Object.freeze({
  /** 'x.y.z' of the node on the PATH, or null. */
  nodeOnPath({ env = process.env } = {}) {
    try {
      const res = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: CLI_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env });
      return !res.error && res.status === 0 ? parseVersion(res.stdout) : null;
    } catch {
      return null;
    }
  },
  shortPath: (p, opts) => (process.platform === 'win32' ? windowsShortPath(p, opts) : null),
  claudeVersions: (opts) => claudeVersions(opts),
  codexInfo: (opts) => codexInfo(opts),
  /** True when the vault is the top of its own git repository and that has a remote. */
  hasRemote(root) {
    const top = git(root, ['rev-parse', '--show-cdup'], { allowFail: true });
    if (!top.ok || top.stdout.trim() !== '') return false;
    const remotes = git(root, ['remote'], { allowFail: true });
    return remotes.ok && remotes.stdout.trim() !== '';
  },
});

// ---------------------------------------------------------------------------------------------
// Running a hook the way its agent does (doctor --probe)

const fileExists = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Git for Windows' bash.exe as Claude Code finds it (CLAUDE_CODE_GIT_BASH_PATH, next to a git.exe
 * on the PATH, the usual install folders), or null: then Claude Code runs hooks in PowerShell.
 */
export function gitBashPath({ env = process.env, isFile = fileExists } = {}) {
  const p = path.win32;
  const get = (name) => envGet(env, name, 'win32');
  const given = get('CLAUDE_CODE_GIT_BASH_PATH');
  if (given && isFile(given)) return given;
  const candidates = [];
  for (const dir of (get('PATH') ?? '').split(';').map((d) => d.trim()).filter(Boolean)) {
    if (!isFile(p.join(dir, 'git.exe'))) continue;
    // Git\cmd\git.exe, Git\bin\git.exe and Git\mingw64\bin\git.exe all lead to Git\bin\bash.exe.
    candidates.push(p.join(dir, 'bash.exe'), p.join(dir, '..', 'bin', 'bash.exe'), p.join(dir, '..', '..', 'bin', 'bash.exe'));
  }
  const local = get('LOCALAPPDATA');
  for (const base of [get('ProgramFiles'), local && p.join(local, 'Programs')]) if (base) candidates.push(p.join(base, 'Git', 'bin', 'bash.exe'));
  return candidates.find((c) => isFile(c)) ?? null;
}

/**
 * How the agent starts a hook entry: {command, args, options, shell}. Claude Code: the exec form
 * without a shell; the shell form through /bin/sh -c, on Windows Git Bash (bash -c) or else
 * PowerShell (the command text passed encoded, so no second round of quoting changes it). Codex:
 * $SHELL -lc, on Windows cmd.exe /C "<commandWindows>".
 */
export function probeSpec(agent, handler, { platform = process.platform, env = process.env, bash = null } = {}) {
  if (Array.isArray(handler.args)) return { command: handler.command, args: [...handler.args], options: {}, shell: 'exec' };
  if (agent === 'codex') {
    if (platform === 'win32') {
      const line = handler.commandWindows ?? handler.command;
      return { command: envGet(env, 'ComSpec', platform) ?? 'cmd.exe', args: ['/C', `"${line}"`], options: { windowsVerbatimArguments: true }, shell: 'cmd' };
    }
    return { command: envGet(env, 'SHELL', platform) ?? '/bin/sh', args: ['-lc', handler.command], options: {}, shell: 'login' };
  }
  if (platform !== 'win32') return { command: '/bin/sh', args: ['-c', handler.command], options: {}, shell: 'sh' };
  if (bash) return { command: bash, args: ['-c', handler.command], options: {}, shell: 'bash' };
  const encoded = Buffer.from(handler.command, 'utf16le').toString('base64');
  return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], options: {}, shell: 'powershell' };
}

/** The input of a session start outside any project (doctor --probe). */
export function probePayload(cwd) {
  return JSON.stringify({ session_id: 'doctor-probe', transcript_path: '', cwd, hook_event_name: 'SessionStart', source: 'startup' });
}

/** Runs a probeSpec with input on stdin: {code, stdout, stderr, ms, error}. */
export function runProbe(spec, { input = '', cwd, env = process.env, timeout = 15000 } = {}) {
  const started = process.hrtime.bigint();
  const res = spawnSync(spec.command, spec.args, {
    ...spec.options, cwd, env, input, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
  });
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms, error: res.error ? String(res.error.code ?? res.error.message) : null };
}

// ---------------------------------------------------------------------------------------------
// Installing

async function vaultTranslator(root) {
  try {
    const { loadConfig } = await import('./config.mjs');
    return loadConfig(root).t;
  } catch {
    return null;
  }
}

/** Where the notes of local-store projects go: {path, exists, configured} (configured: a local root in memory.json). */
export function localRootOf(root, raw, { home = os.homedir() } = {}) {
  const roots = Array.isArray(raw?.roots) ? raw.roots : [];
  const local = roots.slice(1).find((r) => isObj(r) && r.privacy === 'local' && typeof r.path === 'string' && r.path.trim());
  const abs = local ? resolvePath(root, local.path, { home }) : path.resolve(root, '..', `${path.basename(path.resolve(root))}-private`);
  return { path: abs, exists: isDir(abs), configured: Boolean(local) };
}

/**
 * memory.json "projects" after a run: {enabled, auto_add, store, autosync, checkpoint,
 * error_lookup, and every other key as it was}. A choice not given (undefined) keeps the earlier
 * one, else the safe default. With remove only enabled changes (false, unless keepEnabled).
 */
export function nextProjects(prev, { autoAdd, store, autosync, remove = false, keepEnabled = false } = {}) {
  const p = isObj(prev) ? prev : {};
  const bool = (v) => typeof v === 'boolean';
  const pick = (value, old, fallback, valid) => (value !== undefined && !remove ? value : valid(old) ? old : fallback);
  const out = {
    enabled: remove ? keepEnabled : true,
    auto_add: pick(autoAdd, p.auto_add, SAFE_DEFAULTS.auto_add, bool),
    store: pick(store, p.store, SAFE_DEFAULTS.store, (v) => v === 'local' || v === 'git'),
    autosync: pick(autosync, p.autosync, SAFE_DEFAULTS.autosync, bool),
    checkpoint: bool(p.checkpoint) ? p.checkpoint : true,
    error_lookup: bool(p.error_lookup) ? p.error_lookup : true,
  };
  for (const [k, v] of Object.entries(p)) if (!Object.hasOwn(out, k)) out[k] = v;
  return out;
}

/**
 * Installs (or with remove takes out) the memory hooks of one agent and writes memory.json
 * "projects". Prints nothing. opts: {agent: 'claude-code'|'codex', autoAdd, store: 'local'|'git',
 * autosync, form: 'shell'|'exec', dryRun, remove, env, home}: autoAdd, store and autosync left
 * undefined keep the earlier choice, else the safe default (false, local, false). For tests and
 * the wizard also t (a translator; default: the vault's language), platform, now, execPath and io
 * (see IO). Returns {agent, file, script, changed, backup, settings: {enabled, auto_add, store,
 * autosync, checkpoint, error_lookup, ...}, defaults: {auto_add, store, autosync} (true: the safe
 * default), form, command, events, omitted, versions: {observed, min}, localRoot, memoryChanged,
 * dryRun, remove, keptBy?, action: installed|updated|unchanged|removed|absent|refused, ok, exit,
 * warnings: [string], error?, fix?, snippet?}. exit 1 when refused: nothing was written then,
 * except memory.json when only the settings file cannot be rewritten (the snippet is pasted).
 */
export async function installProjects(root, opts = {}) {
  const agent = opts.agent;
  if (!Object.hasOwn(AGENTS, agent)) throw new Error(`unknown agent: ${agent}`);
  if (![undefined, 'local', 'git'].includes(opts.store)) throw new Error(`store must be local or git, got ${opts.store}`);
  if (![undefined, 'shell', 'exec'].includes(opts.form)) throw new Error(`form must be shell or exec, got ${opts.form}`);
  const vault = path.resolve(root);
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const io = { ...IO, ...opts.io };
  const now = opts.now ?? new Date();
  const t = opts.t !== undefined ? opts.t : await vaultTranslator(vault);
  const remove = Boolean(opts.remove);
  const dryRun = Boolean(opts.dryRun);
  const file = settingsPath(agent, { env, home, platform });
  const script = hookScript(vault, platform);
  const res = {
    agent, file, script, changed: false, backup: null, settings: null, defaults: null, form: null, command: null,
    events: [], omitted: [], versions: { observed: [], min: null }, localRoot: null, memoryChanged: false, dryRun,
    remove, action: null, ok: true, exit: 0, warnings: [],
  };
  const warn = (key, vars = {}) => res.warnings.push(say(t, key, vars));
  const refuse = (key, vars = {}, fixKey = null) => {
    res.action = 'refused';
    res.ok = false;
    res.exit = 1;
    res.error = say(t, key, vars);
    if (fixKey) res.fix = say(t, fixKey, vars);
    return res;
  };

  // The vault and its settings.
  if (!fs.existsSync(path.join(vault, 'system', 'memory.mjs'))) {
    return refuse('connect.projects.refused.not_vault', { path: path.join(vault, 'system', 'memory.mjs') });
  }
  const memoryFile = path.join(vault, 'memory.json');
  let memoryText;
  let raw;
  try {
    memoryText = fs.readFileSync(memoryFile, 'utf8');
    raw = JSON.parse(memoryText.replace(/^\uFEFF/, ''));
    if (!isObj(raw)) throw new Error('not a JSON object');
  } catch (err) {
    return refuse('connect.projects.refused.config', { error: String(err?.code ?? err?.message ?? err) }, 'connect.projects.refused.config_fix');
  }

  // The versions of the agent seen here (not needed to take hooks out).
  const none = { observed: [], min: null, off: null };
  const seen = remove ? none : agent === 'claude-code' ? io.claudeVersions({ env, home, platform }) : io.codexInfo({ env, home, platform });
  res.versions = { observed: seen.observed, min: seen.min };

  // The settings. The other agent's hooks keep the projects on when this one's are removed.
  const otherAgent = agent === 'claude-code' ? 'codex' : 'claude-code';
  let keepEnabled = false;
  if (remove && raw.projects?.enabled === true) {
    const other = readSettings(settingsPath(otherAgent, { env, home, platform }));
    const parsed = other.text ? parseSettings(other.text) : { value: {} };
    keepEnabled = ourHooks(parsed.value, otherAgent).length > 0;
  }
  const projects = nextProjects(raw.projects, { autoAdd: opts.autoAdd, store: opts.store, autosync: opts.autosync, remove, keepEnabled });
  res.settings = projects;
  res.defaults = Object.fromEntries(Object.entries(SAFE_DEFAULTS).map(([k, v]) => [k, projects[k] === v]));
  res.localRoot = localRootOf(vault, raw, { home });
  if (keepEnabled) res.keptBy = otherAgent;

  // Autosync needs a remote to push to: refused when asked for now, a warning when kept.
  if (!remove && projects.autosync) {
    const why = raw.mode === 'local' ? 'local' : io.hasRemote(vault) ? null : 'remote';
    if (why && opts.autosync === true) return refuse(`connect.projects.refused.autosync_${why}`, {}, `connect.projects.refused.autosync_${why}_fix`);
    if (why) warn(`connect.projects.warn.autosync_${why}`);
  }

  // The form, the events and the entries.
  let groups = {};
  if (!remove) {
    const execPath = opts.execPath ?? nodeCommand({ platform });
    const node = chooseNode({ platform, pathVersion: io.nodeOnPath({ env }), execPath, shortPath: (p) => io.shortPath(p, { env }) });
    const plan = planForm({ agent, platform, script, requested: opts.form ?? 'shell', min: seen.min, node });
    if (plan.refused) return refuse(plan.refused.key, plan.refused.vars, plan.refused.fixKey);
    for (const w of plan.warnings) warn(w.key, w.vars);
    const { events, omitted } = eventsFor(agent, seen.min);
    if (omitted.length) warn(seen.min === null ? 'connect.projects.warn.failure_unknown' : 'connect.projects.warn.failure_old', { version: seen.min });
    groups = hookGroups(agent, events, plan, { script, platform });
    res.form = plan.form;
    res.events = events.map(([name]) => name);
    res.omitted = omitted;
    const start = groups.SessionStart.hooks[0];
    res.command = plan.form === 'exec' ? [start.command, ...start.args] : start.command;
    if (agent === 'codex') {
      if (seen.min && !atLeast(seen.min, CODEX_HOOKS_MIN)) warn('connect.projects.warn.codex_old', { version: seen.min });
      if (seen.min && platform === 'win32' && !atLeast(seen.min, CODEX_WINDOWS_MIN)) warn('connect.projects.warn.codex_windows', { version: seen.min });
      if (seen.off) warn('connect.projects.warn.codex_off', { path: seen.off.path, key: seen.off.key });
    }
  }

  // memory.json is written after the settings file, or alone when the hooks are pasted by hand.
  const nextRaw = { ...raw, projects };
  res.memoryChanged = !sameJson(raw, nextRaw);
  const writeMemory = () => {
    if (res.memoryChanged && !dryRun) writeAtomic(memoryFile, formatJson(nextRaw, detectStyle(memoryText)));
  };

  // The settings file: read, plan, and replace it only while nobody else changed it.
  let dest;
  try {
    dest = writeTarget(file);
  } catch (err) {
    return refuse('connect.projects.refused.link', { path: file, target: err.target ?? '?' }, 'connect.projects.refused.link_fix');
  }
  for (let attempt = 1; ; attempt++) {
    const read = readSettings(file);
    if (read.error !== undefined) return refuse('connect.projects.refused.unreadable', { path: file, error: read.error }, 'connect.projects.refused.unreadable_fix');
    const parsed = parseSettings(read.text);
    if (remove && !parsed.error && !layoutFits(parsed.value, [])) {
      res.action = 'absent'; // "hooks" of another shape holds none of ours
      break;
    }
    if (parsed.error || !layoutFits(parsed.value, Object.keys(groups))) {
      // Never rewritten. memory.json is still set, so hooks pasted by hand work (or on remove stop).
      const key = remove ? 'connect.projects.refused.not_json_remove' : parsed.error ? 'connect.projects.refused.not_json' : 'connect.projects.refused.layout';
      refuse(key, { path: file, id: agent });
      if (!remove) res.snippet = JSON.stringify({ hooks: groups }, null, 2);
      try {
        writeMemory();
      } catch {
        res.memoryChanged = false;
      }
      return res;
    }
    const settings = parsed.value;
    const before = ourHooks(settings, agent);
    if (!remove) {
      for (const other of new Set(before.map((h) => h.parsed?.script).filter(Boolean))) {
        if (!sameScript(other, script, platform)) warn('connect.projects.warn.other_vault', { path: other });
      }
      if (agent === 'claude-code' && settings.disableAllHooks === true) warn('connect.projects.warn.disabled_all', { path: file });
    }
    const next = planHooks(settings, agent, { groups, remove });
    res.changed = !sameJson(settings, next);
    if (remove) res.action = before.length ? 'removed' : 'absent';
    else res.action = !res.changed ? 'unchanged' : before.length ? 'updated' : 'installed';
    if (dryRun || !res.changed) break;
    const text = formatJson(next, detectStyle(read.text));
    // Another program (Claude Code, its VS Code extension) may have written the file since.
    const again = readSettings(file);
    if (again.error !== undefined || again.text !== read.text) {
      if (attempt < WRITE_TRIES) continue;
      return refuse('connect.projects.refused.changed', { path: file, agent: AGENTS[agent] }, 'connect.projects.refused.write_fix');
    }
    try {
      if (read.exists) res.backup = backupFile(vault, `${agent}-hooks`, file, now);
      const mode = modeOf(dest);
      writeAtomic(dest, text, mode === undefined ? {} : { mode });
    } catch (err) {
      return refuse('connect.projects.refused.write', { path: file, error: err?.code ?? err?.message, agent: AGENTS[agent] }, 'connect.projects.refused.write_fix');
    }
    break;
  }
  try {
    writeMemory();
  } catch (err) {
    return refuse('connect.projects.refused.write', { path: memoryFile, error: err?.code ?? err?.message, agent: AGENTS[agent] }, 'connect.projects.refused.write_fix');
  }
  return res;
}

/** True when two memory.mjs paths name the same file (slashes, letter case on Windows, links). */
export function sameScript(a, b, platform = process.platform) {
  const norm = (p) => {
    let s = String(p);
    try {
      s = fs.realpathSync.native(s);
    } catch {
      /* as written */
    }
    s = toSlashes(s).replace(/\/+$/, '');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------------------------------------
// The text of a result (connect --projects)

function sourceLabel(o, agent, t) {
  if (o.source === 'cli') return `${agent === 'codex' ? 'codex' : 'claude'} --version`;
  if (o.source === 'extension') return say(t, 'connect.projects.source.extension', { editor: o.editor });
  const label = say(t, 'connect.projects.source.sessions');
  return o.entrypoints?.length ? `${label}: ${o.entrypoints.join(', ')}` : label;
}

const shown = (p) => (/\s/.test(p) ? `"${p}"` : p);

/** The lines connect --projects prints for a result of installProjects, in the language of t. */
export function formatInstall(res, t) {
  const s = (key, vars) => say(t, key, vars);
  const name = AGENTS[res.agent];
  const lines = [];
  if (res.action === 'refused') {
    lines.push(`memory: ${res.error}`);
    if (res.snippet) lines.push(res.snippet);
    if (res.fix) lines.push(s('connect.projects.fix', { text: res.fix }));
    if (res.memoryChanged && !res.dryRun) lines.push(s(res.remove ? 'connect.projects.disabled' : 'connect.projects.enabled_anyway'));
    for (const w of res.warnings) lines.push(s('connect.projects.warning', { text: w }));
    return lines;
  }
  const head = res.dryRun ? { installed: 'plan_install', updated: 'plan_update', removed: 'plan_remove' }[res.action] ?? res.action : res.action;
  lines.push(s(`connect.projects.${head}`, { agent: name, path: res.file }));
  if (res.backup) lines.push(`  ${s('connect.projects.backup', { path: res.backup })}`);
  const p = res.settings;
  if (res.remove) {
    if (res.keptBy) lines.push(s('connect.projects.still_enabled', { agent: AGENTS[res.keptBy] }));
    else if (res.memoryChanged) lines.push(s('connect.projects.disabled'));
  } else {
    const seen = res.versions.observed.map((o) => `${o.version} (${sourceLabel(o, res.agent, t)})`);
    const command = Array.isArray(res.command) ? res.command.map(shown).join(' ') : res.command;
    lines.push(`  ${s('connect.projects.events', { list: res.events.join(', ') })}`);
    lines.push(`  ${s(res.form === 'exec' ? 'connect.projects.form_exec' : 'connect.projects.form_shell', { command })}`);
    lines.push(`  ${seen.length ? s('connect.projects.seen', { agent: name, list: seen.join(', ') }) : s('connect.projects.seen_none', { agent: name })}`);
    const mark = (k) => (res.defaults[k] ? ` (${s('connect.projects.default')})` : '');
    const store = p.store === 'git'
      ? s('connect.projects.store_git')
      : s(res.localRoot.exists ? 'connect.projects.store_local' : 'connect.projects.store_local_new', { path: res.localRoot.path });
    lines.push(s('connect.projects.settings'));
    for (const [k, v, text] of [
      ['auto_add', String(p.auto_add), s(p.auto_add ? 'connect.projects.auto_add_on' : 'connect.projects.auto_add_off')],
      ['store', p.store, store],
      ['autosync', String(p.autosync), s(p.autosync ? 'connect.projects.autosync_on' : 'connect.projects.autosync_off')],
    ]) {
      lines.push(`  ${k.padEnd(9)}${v}${mark(k)}: ${text}`);
    }
    const on = [p.auto_add && '--auto-add', p.store === 'git' && '--store git', p.autosync && '--autosync'].filter(Boolean);
    lines.push(on.length ? s('connect.projects.privacy_on', { list: on.join(', ') }) : s('connect.projects.privacy'));
  }
  for (const w of res.warnings) lines.push(s('connect.projects.warning', { text: w }));
  if (res.dryRun) {
    if (res.changed || res.memoryChanged) lines.push(s('connect.projects.dry_run'));
    return lines;
  }
  const next = (key, vars) => lines.push(s('connect.projects.next', { text: s(key, vars) }));
  if (res.remove) {
    if (res.action === 'removed') next('connect.projects.next.remove');
    return lines;
  }
  if (res.changed) next(`connect.projects.next.${res.agent}`);
  if (!p.auto_add) next('connect.projects.next.add', { script: shown(res.script) });
  next('connect.projects.next.check');
  return lines;
}
