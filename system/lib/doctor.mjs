// `doctor` checks: is this installation of memory-kit in order? Node.js, memory.json, the kit
// files, AGENTS.md and the agent adapters, git and its pre-commit hook, the roots, the generated
// views, the platform, the MCP clients and the memory hooks for code projects. Every check returns
// { id, status: 'ok'|'warn'|'fail', message, fix }; diagnose() puts them into the shape of
// system/schema/doctor-result.schema.json. Read-only: nothing here writes a file, changes git
// config or prints (commands/doctor.mjs applies the --fix repairs). Only --probe does more: it runs
// the session start hook of the project hooks once, in an empty temporary folder that git sees as
// no repository, marked as a probe (MEMORY_KIT_PROBE=1 and "probe": true in its input), and notes
// that run in the hook log, so it never counts as a session there. The other kit modules are
// loaded per check, so a damaged module fails only its own check and doctor still reports
// everything else.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  git, gitRepoState, insidePath, interpolate, isDir, isForeignAbsolute, realpathLoose, resolvePath, uniq,
} from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Every check, in the order doctor runs and prints them. */
export const CHECK_IDS = Object.freeze([
  'node.version', 'node.fts5', 'config.memory_json', 'config.data_version', 'kit.version', 'kit.integrity',
  'kit.upgrade_lock', 'agents.block', 'adapters', 'git.repo', 'git.hooks_path', 'git.pre_commit', 'git.attributes',
  'roots', 'generated.fresh', 'platform', 'mcp.clients', 'projects.hooks',
]);

/** Repairs `doctor --fix` may apply: git config core.hooksPath, and the hook file's bytes and mode. */
export const REPAIRS = Object.freeze(['hooks_path', 'hook_file']);

export const HOOK_REL = '.githooks/pre-commit';
const DEFAULT_NODE = '22.5.0';
const DEFAULT_SOURCE = 'https://github.com/8Krystof8/memory-kit.git';
const KNOWN_AGENTS = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'chatgpt', 'claude-app'];
const SESSION_SOURCES = ['startup', 'resume', 'clear', 'compact'];
const UTF8_PROBE = 'ěščřžýáíé';
const MAX_LISTED = 3;
// The Node.js major version .githooks/pre-commit asks of a node before it uses it.
const HOOK_NODE_MAJOR = 22;
// Claude Code runs a hook's "args" (exec form) from 2.1.139 on; before, it runs a bare `node`.
const CLAUDE_EXEC_HOOKS = '2.1.139';
// Claude Code fills in ${CLAUDE_PROJECT_DIR} for hooks it runs in PowerShell from 2.1.198 on.
const CLAUDE_POWERSHELL_HOOKS = '2.1.198';

// Generated-view findings of check (section 11) and how doctor rates them.
const GEN_FAIL = new Set(['GEN_EDITED', 'GEN_FAILED', 'GEN_BUDGET']);
const GEN_WARN = new Set(['GEN_MISSING', 'GEN_STALE', 'GEN_ORPHAN', 'GITIGNORE_LOCAL']);

// English defaults; packs may translate the same keys (docs/architecture.md, section 4.10).
export const DEFAULTS = Object.freeze({
  'doctor.title': 'memory-kit doctor · kit {version} · {root}',
  'doctor.summary': '{ok} ok · {warn} warn · {fail} fail',
  'doctor.fix': 'fix: {fix}',
  'doctor.fixed.hooks_path': 'fixed: git config core.hooksPath .githooks',
  'doctor.fixed.hook_file': 'fixed: .githooks/pre-commit now has LF line endings and is executable',
  'doctor.backup': 'the previous file is kept in {path}',
  'doctor.fix_failed': 'could not fix {what}: {detail}',
  'doctor.fix_outside': 'it links to {target}, outside the memory, and doctor --fix changes nothing there',
  'doctor.more': '{list} and {n} more',
  'doctor.not_checked': 'not checked: {reason}',
  'doctor.reason.config': 'memory.json cannot be loaded (see config.memory_json)',
  'doctor.reason.no_git': 'no repository of its own that git can use (see git.repo)',
  'doctor.reason.no_manifest': 'system/kit.json is missing (see kit.version)',
  'doctor.crashed': 'the check itself failed: {detail}',
  'doctor.module': '{file} cannot be loaded ({detail})',
  'doctor.module_fix': 'restore it with git checkout -- {file}',

  'doctor.node.ok': 'Node.js {have} (the kit needs {need} or newer)',
  'doctor.node.old': 'Node.js {have} is older than the kit needs ({need})',
  'doctor.node.old_fix': 'install Node.js {need} or newer (the LTS version from nodejs.org)',
  'doctor.fts5.ok': 'node:sqlite with FTS5 works, so search uses the fts5 engine',
  'doctor.fts5.missing': 'Node.js {have} has no node:sqlite with FTS5, so search uses the slower scan engine',
  'doctor.fts5.fix': 'install Node.js 22.13 or newer',

  'doctor.config.ok': 'memory.json is valid (language {lang}, mode {mode})',
  'doctor.config.missing': 'memory.json is missing',
  'doctor.config.missing_fix': 'git checkout -- memory.json restores it; a new memory is set up with node system/init.mjs',
  'doctor.config.unreadable': 'memory.json cannot be read: {detail}',
  'doctor.config.json': 'memory.json is not valid JSON: {detail}',
  'doctor.config.not_object': 'memory.json must hold a JSON object',
  'doctor.config.diff_fix': 'git diff memory.json shows what changed since the last commit',
  'doctor.config.load': 'the kit cannot load its settings: {detail}',
  'doctor.config.schema': 'memory.json does not match its schema: {errors}',
  'doctor.config.no_schema': 'the schema of memory.json cannot be read: {detail}',
  'doctor.config.warnings': 'memory.json is read with warnings: {warnings}',
  'doctor.config.not_initialized': 'the memory is not set up yet',
  'doctor.config.init_fix': 'follow AGENTS.md, section Setup (node system/init.mjs)',

  'doctor.data.ok': 'data version {vault} (this kit reads {kit})',
  'doctor.data.invalid': 'memory.json "version" is not a whole number of 1 or more: {value}',
  'doctor.data.newer': 'memory.json has data version {vault}, newer than this kit reads ({kit})',
  'doctor.data.newer_fix': 'update the kit: node system/memory.mjs upgrade',
  'doctor.data.older': 'memory.json has data version {vault}, older than this kit reads ({kit}), so its data was not migrated',
  'doctor.data.older_fix': 'undo the kit update with node system/memory.mjs upgrade --rollback, then upgrade again',
  'doctor.data.manifest': 'system/kit.json names data version {manifest}, but the code reads {kit}',

  'doctor.version.ok': 'memory-kit {version}; system/VERSION and system/kit.json agree',
  'doctor.version.missing': 'system/VERSION is missing or holds no version',
  'doctor.version.no_manifest': 'system/kit.json is missing, so the kit files cannot be verified',
  'doctor.version.bad_manifest': 'system/kit.json cannot be read',
  'doctor.version.restore_fix': 'git checkout -- {file}',
  'doctor.version.upgrade_fix': 'update the kit from {version} to {runner}, which writes system/kit.json: {command}',
  'doctor.version.copy_fix': 'copy system/kit.json of memory-kit {version} from the kit ({source})',
  'doctor.version.mismatch': 'system/VERSION says {version}, but system/kit.json says {manifest}: the kit files come from two versions',
  'doctor.version.mismatch_fix': 'node system/memory.mjs upgrade --rollback undoes an unfinished upgrade; otherwise run the upgrade again',

  'doctor.integrity.ok': '{n} kit files match memory-kit {version}',
  'doctor.integrity.kept': '{n} config or docs files are changed here; an upgrade keeps them',
  'doctor.integrity.missing': 'kit files missing: {files}',
  'doctor.integrity.restore_fix': 'git checkout -- {files}',
  'doctor.integrity.restore_many_fix': 'git status lists them; git checkout -- <file> restores each one from the last commit',
  'doctor.integrity.modified': 'kit files changed here: {files}; an upgrade stops at them unless --force',
  'doctor.integrity.known': '{n} of them hold the code of another kit release',
  'doctor.integrity.diff_fix': 'git diff -- {files} shows the changes; git checkout -- <file> undoes one',
  'doctor.integrity.unknown': 'files in system/ that this kit does not ship: {files}',
  'doctor.integrity.unknown_fix': 'delete them unless you added them yourself',

  'doctor.lock.ok': 'no unfinished upgrade',
  'doctor.lock.found': 'the upgrade {from} → {to} (started {started}) did not finish; upgrade refuses to run until it is undone',
  'doctor.lock.invalid': '{file} was left by an interrupted upgrade and cannot be read',
  'doctor.lock.invalid_fix': 'node system/memory.mjs upgrade --rollback --force (this only removes the lock)',
  'doctor.lock.rollback_fix': 'node system/memory.mjs upgrade --rollback',
  'doctor.lock.force_fix': 'node system/memory.mjs upgrade --rollback --force (its backup {backup} is gone, so this only removes the lock)',
  'doctor.lock.recover_fix': 'node {tool} (the upgrader kept with its backup, which works while the kit files are half replaced)',
  'doctor.lock.running': 'an upgrade {from} → {to} is running right now (process {pid}); wait for it to finish, then run doctor again',

  'doctor.agents.ok': 'the kit section of AGENTS.md matches memory-kit {version}',
  'doctor.agents.no_file': 'AGENTS.md is missing',
  'doctor.agents.restore_fix': 'git checkout -- AGENTS.md',
  'doctor.agents.markers': 'AGENTS.md has no kit section (the lines <!-- kit:start and <!-- kit:end --> are missing)',
  'doctor.agents.duplicate': 'AGENTS.md has a kit marker more than once',
  'doctor.agents.broken': 'in AGENTS.md the line <!-- kit:end --> comes before <!-- kit:start',
  'doctor.agents.copy_fix': 'put the content of {template} back into AGENTS.md once, above your own rules',
  'doctor.agents.old': 'the kit section of AGENTS.md is from {marker}, but the kit is {version}',
  'doctor.agents.old_fix': 'copy {template} over the kit section (the lines from <!-- kit:start to <!-- kit:end -->)',
  'doctor.agents.edited': 'the kit section of AGENTS.md was edited; an upgrade replaces it with {template}',
  'doctor.agents.edited_fix': 'move your own rules below the line <!-- kit:end -->, then copy {template} over the kit section',

  'doctor.adapters.ok': 'agent files are in place: {list}',
  'doctor.adapters.none': 'no agent in memory.json "agents" needs an extra file',
  'doctor.adapters.claude_import': 'CLAUDE.md imports AGENTS.md',
  'doctor.adapters.gemini_import': 'GEMINI.md imports AGENTS.md',
  'doctor.adapters.claude_hook': 'the Claude Code SessionStart hook runs start',
  'doctor.adapters.no_file': '{file} is missing, so {agent} does not read AGENTS.md',
  'doctor.adapters.create_fix': 'create {file} with the single line @AGENTS.md',
  'doctor.adapters.import': '{file} must start with the line @AGENTS.md',
  'doctor.adapters.import_fix': 'make @AGENTS.md the first line of {file}',
  'doctor.adapters.settings_missing': '.claude/settings.json is missing, so Claude Code sessions do not start with the memory',
  'doctor.adapters.settings_invalid': '.claude/settings.json is not valid JSON: {detail}',
  'doctor.adapters.no_hook': '.claude/settings.json has no SessionStart hook that runs system/memory.mjs start',
  'doctor.adapters.hook_fix': 'add the SessionStart hook of the kit to .claude/settings.json: "command": "node \\"${CLAUDE_PROJECT_DIR}/system/memory.mjs\\" start"',
  'doctor.adapters.bare_var': 'the SessionStart hook uses $CLAUDE_PROJECT_DIR without braces, which breaks when Claude Code runs hooks in PowerShell (Windows without Git Bash)',
  'doctor.adapters.braced_fix': 'use the braced form: "command": "node \\"${CLAUDE_PROJECT_DIR}/system/memory.mjs\\" start"',
  'doctor.adapters.exec_old': 'the SessionStart hook uses "args" (exec form), which Claude Code {version} ignores (it needs 2.1.139 or newer), so its sessions start without the memory',
  'doctor.adapters.braced_old': 'Claude Code {version} runs hooks in PowerShell here (no Git Bash), which fills in ${CLAUDE_PROJECT_DIR} only from 2.1.198 on, so its sessions start without the memory',
  'doctor.adapters.update_fix': 'update Claude Code (claude update), or install Git for Windows (git-scm.com), whose Git Bash runs the hook',
  'doctor.adapters.matcher': 'the SessionStart hook skips {sources}, so those sessions start without the memory',
  'doctor.adapters.matcher_fix': 'set its "matcher" to "startup|resume|clear|compact"',

  'doctor.git.ok': 'git repository · branch {branch} · remote {remote}',
  'doctor.git.ok_local': 'git repository · branch {branch} · mode local, so nothing is pushed',
  'doctor.git.detached': 'detached HEAD',
  'doctor.git.missing': 'git is not installed or not on the PATH',
  'doctor.git.missing_fix': 'install git (git-scm.com)',
  'doctor.git.none': 'not a git repository: no history, no pre-commit check and no sync',
  'doctor.git.init_fix': 'git init -b main, then git config core.hooksPath .githooks',
  'doctor.git.nested': 'this folder is inside another git repository ({top}); the memory needs its own',
  'doctor.git.nested_fix': 'git init -b main in this folder',
  'doctor.git.error': 'git cannot use this repository: {detail}',
  'doctor.git.safe_fix': 'git config --global --add safe.directory {path}',
  'doctor.git.no_remote': 'the repository has no remote, so nothing is backed up or synced',
  'doctor.git.remote_fix': 'create a private repository, then git remote add origin <its URL> and node system/memory.mjs sync',
  'doctor.git.busy': 'a git {op} is in progress',
  'doctor.git.busy_fix': 'git status shows how to finish it (git {op} --continue) or undo it (git {op} --abort)',

  'doctor.hooks.ok': 'core.hooksPath is .githooks',
  'doctor.hooks.unset': 'core.hooksPath is not set, so git never runs .githooks/pre-commit',
  'doctor.hooks.other': 'core.hooksPath is {value}, so git never runs .githooks/pre-commit',
  'doctor.hooks.fix': 'git config core.hooksPath .githooks',
  'doctor.hooks.auto_fix': 'node system/memory.mjs doctor --fix (or: git config core.hooksPath .githooks)',
  'doctor.hooks.runner_fix': '{command} (or: git config core.hooksPath .githooks)',

  'doctor.hook.ok': '.githooks/pre-commit runs check --pre-commit with {node}',
  'doctor.hook.node_path': 'the node on the PATH',
  'doctor.hook.missing': '.githooks/pre-commit is missing, so commits are not checked (secrets, generated views)',
  'doctor.hook.checkout_fix': 'git checkout HEAD -- .githooks/pre-commit',
  'doctor.hook.copy_fix': 'copy .githooks/pre-commit from the kit ({source})',
  'doctor.hook.bom': '.githooks/pre-commit starts with a byte order mark, which hides its #! line',
  'doctor.hook.crlf': '.githooks/pre-commit has CRLF line endings, which sh cannot run',
  'doctor.hook.shebang': 'the first line of .githooks/pre-commit is not #!/bin/sh',
  'doctor.hook.not_exec': '.githooks/pre-commit is not executable, so git skips it',
  'doctor.hook.repair_fix': 'node system/memory.mjs doctor --fix',
  'doctor.hook.runner_fix': 'the kit of this memory has no doctor, so use this one: {command}',
  'doctor.hook.outside_fix': '.githooks/pre-commit links to {target}, outside the memory, which doctor --fix leaves alone: give that file LF line endings without a BOM and make it executable',
  'doctor.hook.no_check': '.githooks/pre-commit does not run node system/memory.mjs check --pre-commit',
  'doctor.hook.index_mode': 'git stores .githooks/pre-commit without the executable bit, so fresh clones on macOS and Linux skip it',
  'doctor.hook.index_fix': 'git update-index --chmod=+x .githooks/pre-commit, then commit',
  'doctor.hook.pin_broken': 'git config memorykit.node points at {pin}, which cannot be run',
  'doctor.hook.pin_old': 'git config memorykit.node points at Node.js {version} ({pin}), older than the kit needs ({need})',
  'doctor.hook.gui_missing': 'git apps started outside a terminal may not find node ({node} is not in a standard place), so their commits go unchecked',
  'doctor.hook.gui_old': 'git apps started outside a terminal would run the check with {candidate} (Node.js {version}, too old), so their commits fail',
  'doctor.hook.pin_fix': 'git config memorykit.node {node}',

  'doctor.attributes.ok': '.gitattributes stores text with LF (* text=auto eol=lf)',
  'doctor.attributes.missing': '.gitattributes is missing, so line endings depend on the git settings of each computer',
  'doctor.attributes.rule': '.gitattributes has no line * text=auto eol=lf, so line endings depend on the git settings of each computer',
  'doctor.attributes.autocrlf': 'core.autocrlf is {value} here, so files are checked out with CRLF',
  'doctor.attributes.fix': 'add the line * text=auto eol=lf at the top of .gitattributes and commit it',

  'doctor.roots.main_only': 'one root: every note lives in this repository',
  'doctor.roots.ok': 'local roots found: {list}',
  'doctor.roots.inside': 'local root "{id}" ({path}) lies inside the repository, so its private notes would be committed',
  'doctor.roots.inside_fix': 'move the folder out of the repository (for example to ../{name}-private) and change its "path" in memory.json "roots"',
  'doctor.roots.missing': 'local root "{id}" is not at {path}, so its local sectors are missing on this computer',
  'doctor.roots.missing_fix': 'create the folder, or copy it from the computer that has it',
  'doctor.roots.foreign': 'local root "{id}" ("{path}") is an absolute path of another operating system, so it is not available here',
  'doctor.roots.foreign_fix': 'in memory.json "roots" write it relative to the vault (../name) or as ~/name',

  'doctor.generated.ok': 'the generated views (_ai/, .ignore, the home page) are up to date',
  'doctor.generated.stale': 'generated views to refresh: {files}',
  'doctor.generated.fix': 'node system/memory.mjs check --generate',
  'doctor.generated.edited': 'generated views edited by hand: {files}',
  'doctor.generated.edited_fix': 'node system/memory.mjs check --generate rewrites them from the notes; move a hand edit into a note first',
  'doctor.generated.failed': 'the generator failed: {detail}',
  'doctor.generated.failed_fix': 'node system/memory.mjs check shows where it fails',
  'doctor.generated.budget': 'the start view cannot fit its byte budget',
  'doctor.generated.budget_fix': 'shorten the Now section of {state} or pin fewer notes, then node system/memory.mjs check --generate',

  'doctor.platform.ok': '{os} {release} ({arch}) · Node.js at {node} · home {home} · UTF-8 test: {probe}',
  'doctor.platform.home': 'HOME is {homeEnv}, but the user folder is {home}; the kit uses the user folder for ~/ paths, tools that read HOME may look elsewhere',
  'doctor.platform.home_fix': 'remove the HOME variable or set it to {home}',
  'doctor.platform.cloud': 'the memory lies in a {service} folder; sync apps lock files while git writes them and can damage .git',
  'doctor.platform.cloud_fix': 'move the memory to a folder outside {service} (git and its remote already keep copies)',

  'doctor.mcp.connected': 'connected in: {clients}',
  'doctor.mcp.none': 'no MCP client is connected to this memory (optional: node system/memory.mjs connect --list)',
  'doctor.mcp.none_plain': 'no MCP client is connected to this memory',
  'doctor.mcp.unreadable': '{client}: {path} cannot be read ({error})',
  'doctor.mcp.unreadable_fix': 'fix the syntax of {path}',
  'doctor.mcp.stale_command': '{client}: entry "{name}" starts {command}, which no longer exists',
  'doctor.mcp.stale_command_fix': 'node system/memory.mjs connect {id}',
  'doctor.mcp.gone_vault': '{client}: entry "{name}" serves a memory that no longer exists ({root})',
  'doctor.mcp.gone_vault_fix': 'node system/memory.mjs connect {id} --remove --name {name} --force',

  'doctor.projects.off': 'memory for code projects is not set up (optional: node system/memory.mjs connect claude-code --projects)',
  'doctor.projects.off_plain': 'memory for code projects is not set up',
  'doctor.projects.ok': 'memory hooks for {agents} · store {store} · auto_add {auto_add} · autosync {autosync}',
  'doctor.projects.none': 'memory.json turns on the memory for code projects, but this computer has no memory hooks',
  'doctor.projects.connect_fix': 'node system/memory.mjs connect claude-code --projects (or connect codex --projects)',
  'doctor.projects.reconnect_fix': 'node system/memory.mjs connect {id} --projects',
  'doctor.projects.unreadable': '{agent}: {path} cannot be read ({error})',
  'doctor.projects.unreadable_fix': 'fix the syntax of {path}',
  'doctor.projects.incomplete': '{agent}: the memory hooks for {events} are missing',
  'doctor.projects.moved': '{agent}: the hooks run {script}, which does not exist (was the memory moved?)',
  'doctor.projects.other': '{agent}: the hooks serve another memory ({script})',
  'doctor.projects.node_missing': '{agent}: the hooks start node, which is not on the PATH here',
  'doctor.projects.node_gone': '{agent}: the hooks start {node}, which does not exist',
  'doctor.projects.node_old': '{agent}: the hooks start {node}, which is Node.js {have} (the kit needs {need})',
  'doctor.projects.node_fix': 'install Node.js {need} or newer so that node is on the PATH, then node system/memory.mjs connect {id} --projects',
  'doctor.projects.exec_old': 'Claude Code: the hooks use the exec form, which Claude Code {version} does not run (it needs 2.1.139 or newer)',
  'doctor.projects.exec_fix': 'node system/memory.mjs connect claude-code --projects --form shell, or update Claude Code (claude update)',
  'doctor.projects.failure_old': 'Claude Code: the hooks include PostToolUseFailure, and Claude Code {version} (older than 2.1.101) then ignores the whole settings file',
  'doctor.projects.failure_fix': 'update Claude Code (claude update), or run node system/memory.mjs connect claude-code --projects, which leaves that event out',
  'doctor.projects.disabled_all': 'Claude Code: {path} has "disableAllHooks": true, so no hook runs',
  'doctor.projects.disabled_all_fix': 'delete "disableAllHooks" from {path}',
  'doctor.projects.codex_off': 'Codex: {path} turns hooks off ([features] {key} = false)',
  'doctor.projects.codex_off_fix': 'delete that line from {path} or set it to true',
  'doctor.projects.codex_old': 'Codex {version} runs hooks only with [features] hooks = true (on by default from 0.124)',
  'doctor.projects.codex_old_fix': 'update Codex',
  'doctor.projects.not_running': '{agent}: the hooks are in place, but none has run since {since}, though sessions started after that',
  'doctor.projects.not_running_claude_fix': 'accept the folder trust dialog in new sessions (hooks wait for it), update Claude Code (claude update), then node system/memory.mjs doctor --probe',
  'doctor.projects.not_running_codex_fix': 'open /hooks in Codex and trust the memory hooks, update Codex to 0.124 or newer, then node system/memory.mjs doctor --probe',
  'doctor.projects.failures': 'hook failures in the last {days} days: {list}',
  'doctor.projects.failures_fix': 'the details are in {log}',
  'doctor.projects.sync_failed': 'the last automatic sync failed ({step}, {when}): {error}',
  'doctor.projects.sync_fix': 'node system/memory.mjs sync',
  'doctor.projects.probe_ok': '{agent}: the session start hook ran in {ms} ms with clean output',
  'doctor.projects.probe_failed': '{agent}: the session start hook failed when run as {agent} runs it ({detail})',
  'doctor.projects.probe_fix': 'run it yourself to see the error: {command}',
  'doctor.projects.probe_noise': '{agent}: the session start hook printed text outside a project: {text}',
  'doctor.projects.noise_fix': 'a shell profile that prints text (~/.bashrc, ~/.zshenv, ~/.profile) corrupts hook output: let it print only in interactive shells',
  'doctor.projects.probe_slow': '{agent}: the session start hook took {ms} ms outside a project (more than {max} ms)',
  'doctor.projects.slow_fix': 'check what the shell profile runs; on Windows an antivirus scan often slows Node.js down',
});

// ---------------------------------------------------------------------------------------------
// Messages

/** cfg.t-style lookup with the English defaults above as the fallback. */
export function say(t, key, vars = {}) {
  const text = typeof t === 'function' ? t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(DEFAULTS[key] ?? key, vars);
}

const oneLine = (s) => String(s ?? '').replace(/\s*\r?\n\s*/g, ' ').replace(/\s+$/, '').trim();

/** 'a, b, c' or 'a, b, c and 2 more'. */
function listed(c, items, max = MAX_LISTED) {
  const list = items.slice(0, max).join(', ');
  return items.length > max ? say(c.t, 'doctor.more', { list, n: items.length - max }) : list;
}

// ---------------------------------------------------------------------------------------------
// Probes (tests replace them)

/** File and program probes. */
export const IO = Object.freeze({
  /** True for an existing file this process may execute (on Windows: any existing file). */
  isExecutable(p) {
    try {
      if (!fs.statSync(p).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  /** 'x.y.z' that `<p> --version` prints, or null. */
  nodeVersion(p) {
    const res = spawnSync(p, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = /v?(\d+\.\d+\.\d+)/.exec(res.stdout ?? '');
    return !res.error && res.status === 0 && m ? m[1] : null;
  },
  isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  gitAvailable() {
    const res = spawnSync('git', ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 20000 });
    return !res.error && res.status === 0;
  },
  /** 'x.y.z' that `claude --version` prints, or null (no claude on the PATH, a .cmd shim, a timeout). */
  claudeVersion() {
    try {
      const res = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
      const m = /(\d+\.\d+\.\d+)/.exec(res.stdout ?? '');
      return !res.error && res.status === 0 && m ? m[1] : null;
    } catch {
      return null;
    }
  },
  /**
   * True when Claude Code on Windows finds Git Bash to run hooks with: CLAUDE_CODE_GIT_BASH_PATH,
   * or the bash.exe of a Git for Windows whose git.exe is on the PATH or in its usual folders.
   */
  gitBash(env = process.env) {
    const isFile = (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    if (typeof env.CLAUDE_CODE_GIT_BASH_PATH === 'string' && isFile(env.CLAUDE_CODE_GIT_BASH_PATH)) return true;
    const bashes = [];
    for (const dir of String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
      if (!isFile(path.join(dir, 'git.exe'))) continue;
      // Git\cmd\git.exe, Git\bin\git.exe and Git\mingw64\bin\git.exe all lead to Git\bin\bash.exe.
      bashes.push(path.join(dir, 'bash.exe'), path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', '..', 'bin', 'bash.exe'));
    }
    for (const base of [env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
      if (typeof base === 'string' && base) bashes.push(path.join(base, 'Git', 'bin', 'bash.exe'));
    }
    return bashes.some(isFile);
  },
});

// ---------------------------------------------------------------------------------------------
// Small helpers

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Numeric 'x.y.z' comparison (pre-release suffixes ignored): -1, 0 or 1; null when unparsable. */
export function cmpVersion(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function readJsonFile(abs) {
  try {
    const value = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''));
    return isObj(value) ? value : null;
  } catch {
    return null;
  }
}

function readTextOrNull(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

const inVault = (c, rel) => path.join(c.root, ...rel.split('/'));
const posixPath = (p) => String(p).split(path.sep).join('/');

/** True when a and b name the same folder (symlinks, letter case and 8.3 names resolved). */
function sameDir(a, b) {
  const x = realpathLoose(a);
  const y = realpathLoose(b);
  return insidePath(x, y) && insidePath(y, x);
}

/** A command-line argument as people copy it into a shell: quoted when it holds more than path characters. */
function shellArg(s) {
  const t = String(s);
  return /^[\w@%+=:,./\\-]+$/.test(t) ? t : `"${t.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** `node <kit that runs doctor>/system/memory.mjs <args> --root <vault>`: for a vault whose own kit lacks the command. */
function runnerCommand(c, args) {
  return ['node', shellArg(path.join(c.kitRoot, 'system', 'memory.mjs')), ...args, '--root', shellArg(c.root)].join(' ');
}

/** True when `node system/memory.mjs doctor` works in the vault (its kit has doctor, 0.1.1 or newer). */
function vaultHasDoctor(c) {
  return once(c, 'own-doctor', () => sameDir(c.root, c.kitRoot) || fs.existsSync(inVault(c, 'system/lib/commands/doctor.mjs')));
}

/**
 * Where the bytes of the vault's pre-commit hook live: { file, link, inside }. file is the hook
 * itself, or the real file its symbolic link leads to (the link stays a link); inside is false
 * for a link that leaves the vault, which doctor --fix never changes. Throws when the hook is
 * missing or its link dangles.
 */
export function hookFile(root) {
  const hook = path.join(path.resolve(root), ...HOOK_REL.split('/'));
  if (!fs.lstatSync(hook).isSymbolicLink()) return { file: hook, link: false, inside: true };
  const file = fs.realpathSync.native(hook);
  return { file, link: true, inside: insidePath(realpathLoose(root), file) };
}

function once(c, key, fn) {
  if (!c.memo.has(key)) c.memo.set(key, fn());
  return c.memo.get(key);
}

class ModuleError extends Error {
  constructor(file, cause) {
    super(`${file}: ${cause?.message ?? cause}`);
    this.file = file;
    this.detail = oneLine(cause?.message ?? cause).slice(0, 300);
  }
}

/** A kit module (system/lib/<name>), loaded once; a failure becomes a ModuleError. */
async function need(c, name) {
  if (!c.modules.has(name)) {
    const url = pathToFileURL(path.join(HERE, name)).href;
    c.modules.set(name, import(url).then((m) => ({ m }), (err) => ({ err })));
  }
  const r = await c.modules.get(name);
  if (r.err) throw new ModuleError(`system/lib/${name}`, r.err);
  return r.m;
}

// Check results
const ok = (message) => ({ status: 'ok', message, fix: null });
const skipped = (c, reasonKey) => ({ status: 'ok', message: say(c.t, 'doctor.not_checked', { reason: say(c.t, reasonKey) }), fix: null, skipped: true });
const problem = (level, message, fix = null, repair = []) => ({ level, message, fix, repair });

/**
 * The worst level of the problems (fails first), their messages and fixes joined; okMessage when
 * there are none. prefix (for checks that always report facts) goes before the problems.
 */
function combine(problems, okMessage, { prefix } = {}) {
  if (!problems.length) return ok(okMessage);
  const sorted = [...problems.filter((p) => p.level === 'fail'), ...problems.filter((p) => p.level !== 'fail')];
  const text = sorted.map((p) => p.message).join('; ');
  return {
    status: sorted[0].level === 'fail' ? 'fail' : 'warn',
    message: prefix ? `${prefix}; ${text}` : text,
    fix: uniq(sorted.map((p) => p.fix).filter(Boolean)).join('; ') || null,
    repair: uniq(sorted.flatMap((p) => p.repair ?? [])),
  };
}

// ---------------------------------------------------------------------------------------------
// Facts shared by several checks

/** memory.json as it is on disk: { value, error: null|'missing'|'read'|'json'|'shape', detail }. */
function rawConfig(c) {
  return once(c, 'raw', () => {
    let text;
    try {
      text = fs.readFileSync(path.join(c.root, 'memory.json'), 'utf8');
    } catch (err) {
      return { value: null, error: err?.code === 'ENOENT' ? 'missing' : 'read', detail: oneLine(err?.message ?? err) };
    }
    try {
      const value = JSON.parse(text.replace(/^\uFEFF/, ''));
      return isObj(value) ? { value, error: null } : { value: null, error: 'shape' };
    } catch (err) {
      return { value: null, error: 'json', detail: oneLine(err.message) };
    }
  });
}

function readVersion(root) {
  const text = readTextOrNull(path.join(root, 'system', 'VERSION'));
  const v = text?.trim();
  return v && cmpVersion(v, v) === 0 ? v : null;
}

function manifestOf(c) {
  return once(c, 'manifest', () => {
    const file = path.join(c.root, 'system', 'kit.json');
    if (!fs.existsSync(file)) return { value: null, exists: false };
    const value = readJsonFile(file);
    return { value: value && isObj(value.files) ? value : null, exists: true };
  });
}

/** The Node.js version the kit asks for: kit.json "node", else the release default. */
function neededNode(c) {
  const node = manifestOf(c).value?.node ?? readJsonFile(path.join(c.kitRoot, 'system', 'kit.json'))?.node;
  return cmpVersion(node, node) === 0 ? node : DEFAULT_NODE;
}

function langOf(c) {
  const lang = c.cfg?.lang ?? rawConfig(c).value?.lang;
  return typeof lang === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(lang.trim()) ? lang.trim() : 'en';
}

/** { available, state: 'top'|'nested'|'none'|'error', detail } of the vault in git. */
function gitFacts(c) {
  return once(c, 'git', () => {
    const available = c.io.gitAvailable();
    if (!available) {
      const dotGit = fs.existsSync(path.join(c.root, '.git'));
      return { available, state: dotGit ? 'error' : 'none', detail: '' };
    }
    return { available, ...gitRepoState(c.root) };
  });
}

const isTop = (c) => gitFacts(c).state === 'top';

/** Trimmed stdout of a git command in the vault, or null when it fails. */
function gitOut(c, args) {
  const res = git(c.root, args, { allowFail: true });
  return res.ok ? res.stdout.trim() : null;
}

// ---------------------------------------------------------------------------------------------
// The checks

async function checkNodeVersion(c) {
  const minimum = neededNode(c);
  const have = c.nodeVersion;
  if (cmpVersion(have, minimum) === -1) {
    return combine([problem('fail', say(c.t, 'doctor.node.old', { have, need: minimum }), say(c.t, 'doctor.node.old_fix', { need: minimum }))]);
  }
  return ok(say(c.t, 'doctor.node.ok', { have, need: minimum }));
}

async function checkFts5(c) {
  const available = c.fts5 ? await c.fts5() : await (await need(c, 'search.mjs')).fts5Available();
  if (available) return ok(say(c.t, 'doctor.fts5.ok'));
  return combine([problem('warn', say(c.t, 'doctor.fts5.missing', { have: c.nodeVersion }), say(c.t, 'doctor.fts5.fix'))]);
}

async function checkConfig(c) {
  const raw = rawConfig(c);
  if (raw.error === 'missing') return combine([problem('fail', say(c.t, 'doctor.config.missing'), say(c.t, 'doctor.config.missing_fix'))]);
  if (raw.error === 'read') return combine([problem('fail', say(c.t, 'doctor.config.unreadable', { detail: raw.detail }))]);
  if (raw.error === 'json') {
    return combine([problem('fail', say(c.t, 'doctor.config.json', { detail: raw.detail }), isTop(c) ? say(c.t, 'doctor.config.diff_fix') : null)]);
  }
  if (raw.error === 'shape') return combine([problem('fail', say(c.t, 'doctor.config.not_object'))]);

  const problems = [];
  if (c.configError) {
    problems.push(problem('fail', say(c.t, 'doctor.config.load', { detail: oneLine(c.configError.message ?? c.configError) })));
  }
  let schemaErrors = [];
  try {
    const schema = await need(c, 'schema.mjs');
    const res = schema.validateAs(c.kitRoot, 'memory', raw.value, { t: c.t });
    schemaErrors = schema.formatErrors(res.errors);
  } catch (err) {
    problems.push(problem('warn', say(c.t, 'doctor.config.no_schema', { detail: err instanceof ModuleError ? err.message : oneLine(err.message) })));
  }
  if (schemaErrors.length) {
    problems.push(problem(c.configError ? 'fail' : 'warn', say(c.t, 'doctor.config.schema', { errors: listed(c, schemaErrors, 2) })));
  } else if (c.cfg?.warnings?.length) {
    problems.push(problem('warn', say(c.t, 'doctor.config.warnings', { warnings: listed(c, c.cfg.warnings, 2) })));
  }
  const initialized = c.cfg ? c.cfg.initialized : raw.value.initialized === true;
  if (!initialized) problems.push(problem('warn', say(c.t, 'doctor.config.not_initialized'), say(c.t, 'doctor.config.init_fix')));
  const mode = c.cfg?.mode ?? (typeof raw.value.mode === 'string' ? raw.value.mode : 'github');
  return combine(problems, say(c.t, 'doctor.config.ok', { lang: langOf(c), mode }));
}

async function checkDataVersion(c) {
  const raw = rawConfig(c);
  if (!raw.value) return skipped(c, 'doctor.reason.config');
  const { DATA_VERSION: kit } = await need(c, 'config.mjs');
  const v = raw.value.version;
  const vault = v === undefined ? 1 : Number.isInteger(v) && v >= 1 ? v : null;
  const problems = [];
  if (vault === null) {
    problems.push(problem('fail', say(c.t, 'doctor.data.invalid', { value: JSON.stringify(v) })));
  } else if (vault > kit) {
    problems.push(problem('fail', say(c.t, 'doctor.data.newer', { vault, kit }), say(c.t, 'doctor.data.newer_fix')));
  } else if (vault < kit) {
    problems.push(problem('fail', say(c.t, 'doctor.data.older', { vault, kit }), say(c.t, 'doctor.data.older_fix')));
  }
  const manifest = manifestOf(c).value?.data_version;
  if (Number.isInteger(manifest) && manifest !== kit) {
    problems.push(problem('warn', say(c.t, 'doctor.data.manifest', { manifest, kit }), say(c.t, 'doctor.version.restore_fix', { file: 'system/kit.json' })));
  }
  return combine(problems, say(c.t, 'doctor.data.ok', { vault, kit }));
}

/**
 * How system/kit.json comes back: the upgrade by the kit that runs doctor when the vault's kit is
 * older (0.1.0 had no kit.json, so git has none to restore), git checkout when the last commit
 * has the file, else a copy from the kit's source.
 */
function manifestFix(c) {
  const runner = readVersion(c.kitRoot);
  if (cmpVersion(c.version, runner) === -1) {
    return say(c.t, 'doctor.version.upgrade_fix', { version: c.version, runner, command: runnerCommand(c, ['upgrade']) });
  }
  if (isTop(c) && git(c.root, ['cat-file', '-e', 'HEAD:system/kit.json'], { allowFail: true }).ok) {
    return say(c.t, 'doctor.version.restore_fix', { file: 'system/kit.json' });
  }
  return say(c.t, 'doctor.version.copy_fix', { version: c.version, source: DEFAULT_SOURCE });
}

async function checkKitVersion(c) {
  if (!c.version) {
    return combine([problem('fail', say(c.t, 'doctor.version.missing'), say(c.t, 'doctor.version.restore_fix', { file: 'system/VERSION' }))]);
  }
  const m = manifestOf(c);
  if (!m.exists) return combine([problem('warn', say(c.t, 'doctor.version.no_manifest'), manifestFix(c))]);
  if (!m.value) return combine([problem('warn', say(c.t, 'doctor.version.bad_manifest'), manifestFix(c))]);
  if (m.value.version !== c.version) {
    return combine([problem('fail', say(c.t, 'doctor.version.mismatch', { version: c.version, manifest: String(m.value.version) }),
      say(c.t, 'doctor.version.mismatch_fix'))]);
  }
  return ok(say(c.t, 'doctor.version.ok', { version: c.version }));
}

async function checkIntegrity(c) {
  if (!manifestOf(c).value) return skipped(c, 'doctor.reason.no_manifest');
  const kit = await need(c, 'kit.mjs');
  const report = kit.integrityReport(c.root);
  const byState = (state, groups) => report.files.filter((f) => f.state === state && groups.includes(f.group)).map((f) => f.rel);
  const missingCode = byState('missing', ['code']);
  const missingTests = byState('missing', ['tests']);
  const changed = report.files.filter((f) => f.state === 'modified' && (f.group === 'code' || f.group === 'tests'));
  const kept = byState('modified', ['config', 'docs']);
  const unknown = report.unknown.filter((rel) => kit.groupOf(rel) === 'code');
  const problems = [];
  const missing = [...missingCode, ...missingTests];
  if (missing.length) {
    problems.push(problem(missingCode.length ? 'fail' : 'warn', say(c.t, 'doctor.integrity.missing', { files: listed(c, missing) }),
      missing.length <= MAX_LISTED
        ? say(c.t, 'doctor.integrity.restore_fix', { files: missing.join(' ') })
        : say(c.t, 'doctor.integrity.restore_many_fix')));
  }
  if (changed.length) {
    const rels = changed.map((f) => f.rel);
    const known = changed.filter((f) => f.known).length;
    let message = say(c.t, 'doctor.integrity.modified', { files: listed(c, rels) });
    if (known) message += ` (${say(c.t, 'doctor.integrity.known', { n: known })})`;
    problems.push(problem('warn', message, say(c.t, 'doctor.integrity.diff_fix', { files: rels.length <= MAX_LISTED ? rels.join(' ') : 'system' })));
  }
  if (unknown.length) {
    problems.push(problem('warn', say(c.t, 'doctor.integrity.unknown', { files: listed(c, unknown) }), say(c.t, 'doctor.integrity.unknown_fix')));
  }
  const good = report.files.filter((f) => f.state === 'ok').length;
  let message = say(c.t, 'doctor.integrity.ok', { n: good, version: report.manifestVersion ?? c.version ?? '–' });
  if (kept.length) message += `; ${say(c.t, 'doctor.integrity.kept', { n: kept.length })}`;
  return combine(problems, message);
}

async function checkUpgradeLock(c) {
  const upgrade = await need(c, 'upgrade.mjs');
  const lock = upgrade.lockState(c.root);
  if (!lock) return ok(say(c.t, 'doctor.lock.ok'));
  if (!lock.valid) {
    return combine([problem('fail', say(c.t, 'doctor.lock.invalid', { file: lock.rel }), say(c.t, 'doctor.lock.invalid_fix'))]);
  }
  // An upgrade at work holds the lock: undoing it now would mix old and new files.
  if (lock.running) {
    return combine([problem('warn', say(c.t, 'doctor.lock.running', { from: lock.from ?? '?', to: lock.to ?? '?', pid: lock.pid }))]);
  }
  // The backup upgrade --rollback would restore (it looks it up the same way).
  const backup = typeof lock.backup === 'string' && lock.backup ? lock.backup : null;
  const backupThere = backup !== null && upgrade.listBackups(c.root).some((b) => b.id === backup);
  const message = say(c.t, 'doctor.lock.found', { from: lock.from ?? '?', to: lock.to ?? '?', started: lock.started ?? '?' });
  let fix;
  if (backupThere && typeof lock.recover === 'string' && lock.recover) {
    // The vault's own CLI may not load while its code is half replaced; the backup's tool does.
    const tool = vaultHasDoctor(c) ? lock.recover : shellArg(inVault(c, lock.recover));
    fix = say(c.t, 'doctor.lock.recover_fix', { tool });
  } else if (backupThere) {
    fix = say(c.t, 'doctor.lock.rollback_fix');
  } else {
    fix = say(c.t, 'doctor.lock.force_fix', { backup: backup ?? '–' });
  }
  return combine([problem('fail', message, fix)]);
}

// The setup block of a kit that is not set up yet sits inside the kit section; init removes it.
const SETUP_BLOCK = /^[^\n]*<!-- setup:start -->[^\n]*\n[\s\S]*?^[^\n]*<!-- setup:end -->[^\n]*(?:\n|$)/m;

async function checkAgentsBlock(c) {
  const raw = readTextOrNull(inVault(c, 'AGENTS.md'));
  if (raw === null) return combine([problem('fail', say(c.t, 'doctor.agents.no_file'), say(c.t, 'doctor.agents.restore_fix'))]);
  const text = raw.replace(/\r\n/g, '\n').replace(SETUP_BLOCK, '');
  const upgrade = await need(c, 'upgrade.mjs');
  const lang = langOf(c);
  const template = upgrade.agentsTemplate(c.root, lang);
  const templateRel = template?.rel ?? `system/templates/${lang}/kit/agents-system.md`;
  const state = upgrade.replaceKitBlock(text, (template?.text ?? '').replace(/\r\n/g, '\n')).state;
  if (state === 'missing' || state === 'duplicate' || state === 'broken') {
    const key = { missing: 'doctor.agents.markers', duplicate: 'doctor.agents.duplicate', broken: 'doctor.agents.broken' }[state];
    return combine([problem('fail', say(c.t, key), say(c.t, 'doctor.agents.copy_fix', { template: templateRel }))]);
  }
  const startLine = text.split('\n').find((l) => l.includes('<!-- kit:start')) ?? '';
  const marker = /<!--\s*kit:start\s+v?(\d+\.\d+\.\d+[^\s]*)/.exec(startLine)?.[1] ?? null;
  const version = c.version ?? '–';
  if (c.version && marker !== c.version) {
    return combine([problem('warn', say(c.t, 'doctor.agents.old', { marker: marker ? `v${marker}` : '?', version: c.version }),
      say(c.t, 'doctor.agents.old_fix', { template: templateRel }))]);
  }
  if (template && state !== 'unchanged') {
    return combine([problem('warn', say(c.t, 'doctor.agents.edited', { template: templateRel }),
      say(c.t, 'doctor.agents.edited_fix', { template: templateRel }))]);
  }
  return ok(say(c.t, 'doctor.agents.ok', { version }));
}

/** The SessionStart hooks of a Claude Code settings object that run system/memory.mjs start. */
export function sessionStartHooks(settings) {
  const out = [];
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return out;
  for (const g of groups) {
    for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (!isObj(h) || (h.type !== undefined && h.type !== 'command')) continue;
      const args = Array.isArray(h.args) ? h.args.filter((a) => typeof a === 'string') : [];
      const command = typeof h.command === 'string' ? h.command : '';
      const exec = args.some((a) => /system[\\/]memory\.mjs$/.test(a)) && args.includes('start');
      const shell = !exec && /system[\\/]memory\.mjs/.test(command) && /(?:^|\s)start(?:\s|$|["'])/.test(command);
      if (!exec && !shell) continue;
      // `${CLAUDE_PROJECT_DIR}` is substituted by Claude Code; a bare `$CLAUDE_PROJECT_DIR` needs a POSIX shell.
      out.push({ matcher: typeof g.matcher === 'string' ? g.matcher : '', exec, bare: shell && command.includes('$CLAUDE_PROJECT_DIR') });
    }
  }
  return out;
}

/** The session sources (startup, resume, clear, compact) no hook matcher covers. */
export function uncoveredSources(hooks) {
  const covered = new Set();
  for (const h of hooks) {
    const m = h.matcher.trim();
    if (m === '' || m === '*') return [];
    for (const part of m.split('|')) covered.add(part.trim());
  }
  return SESSION_SOURCES.filter((s) => !covered.has(s));
}

/** First non-empty line of a text file (BOM and CR removed), or null when the file is missing. */
function firstLine(file) {
  const text = readTextOrNull(file);
  if (text === null) return null;
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
}

/**
 * The problem of SessionStart hooks that no Claude Code here runs, or null. A bare
 * $CLAUDE_PROJECT_DIR needs a POSIX shell, which Windows has only with Git Bash (else PowerShell
 * runs hooks); the exec form ("args") needs Claude Code 2.1.139, and the braced shell form under
 * PowerShell 2.1.198. `claude --version` is asked only when the answer depends on it.
 */
function hookForm(c, hooks) {
  const powershell = c.platform === 'win32' && !c.io.gitBash(c.env);
  const needsVersion = hooks.some((h) => h.exec) || (powershell && hooks.some((h) => !h.bare));
  const version = needsVersion ? c.io.claudeVersion() : null;
  const older = (min) => version !== null && cmpVersion(version, min) === -1;
  const works = (h) => {
    if (h.exec) return !older(CLAUDE_EXEC_HOOKS);
    if (h.bare) return !powershell;
    return !(powershell && older(CLAUDE_POWERSHELL_HOOKS));
  };
  if (hooks.some(works)) return null;
  if (hooks.some((h) => h.exec)) {
    return problem('warn', say(c.t, 'doctor.adapters.exec_old', { version }),
      say(c.t, powershell ? 'doctor.adapters.update_fix' : 'doctor.adapters.braced_fix'));
  }
  if (hooks.some((h) => !h.bare)) return problem('warn', say(c.t, 'doctor.adapters.braced_old', { version }), say(c.t, 'doctor.adapters.update_fix'));
  return problem('warn', say(c.t, 'doctor.adapters.bare_var'), say(c.t, 'doctor.adapters.braced_fix'));
}

async function checkAdapters(c) {
  const raw = rawConfig(c).value;
  const agents = c.cfg?.agents ?? (Array.isArray(raw?.agents) ? raw.agents.filter((a) => typeof a === 'string') : KNOWN_AGENTS);
  const problems = [];
  const fine = [];
  const importFile = (file, agent, okKey) => {
    const first = firstLine(inVault(c, file));
    if (first === null) {
      problems.push(problem('warn', say(c.t, 'doctor.adapters.no_file', { file, agent }), say(c.t, 'doctor.adapters.create_fix', { file })));
    } else if (first !== '@AGENTS.md') {
      problems.push(problem('fail', say(c.t, 'doctor.adapters.import', { file }), say(c.t, 'doctor.adapters.import_fix', { file })));
    } else {
      fine.push(say(c.t, okKey));
    }
  };
  if (agents.includes('claude-code')) {
    importFile('CLAUDE.md', 'Claude Code', 'doctor.adapters.claude_import');
    const text = readTextOrNull(inVault(c, '.claude/settings.json'));
    if (text === null) {
      problems.push(problem('warn', say(c.t, 'doctor.adapters.settings_missing'), say(c.t, 'doctor.adapters.hook_fix')));
    } else {
      let settings;
      let parsed = true;
      try {
        settings = JSON.parse(text.replace(/^\uFEFF/, ''));
      } catch (err) {
        try {
          settings = (await need(c, 'jsonc.mjs')).parseJsonc(text).value;
        } catch {
          parsed = false;
          problems.push(problem('fail', say(c.t, 'doctor.adapters.settings_invalid', { detail: oneLine(err.message) })));
        }
      }
      if (parsed) {
        const hooks = sessionStartHooks(settings);
        const missing = uncoveredSources(hooks);
        if (!hooks.length) {
          problems.push(problem('warn', say(c.t, 'doctor.adapters.no_hook'), say(c.t, 'doctor.adapters.hook_fix')));
        } else {
          const before = problems.length;
          const form = hookForm(c, hooks);
          if (form) problems.push(form);
          if (missing.length) {
            problems.push(problem('warn', say(c.t, 'doctor.adapters.matcher', { sources: missing.join(', ') }), say(c.t, 'doctor.adapters.matcher_fix')));
          }
          if (problems.length === before) fine.push(say(c.t, 'doctor.adapters.claude_hook'));
        }
      }
    }
  }
  if (agents.includes('gemini-cli')) importFile('GEMINI.md', 'Gemini CLI', 'doctor.adapters.gemini_import');
  const message = fine.length ? say(c.t, 'doctor.adapters.ok', { list: fine.join(', ') }) : say(c.t, 'doctor.adapters.none');
  return combine(problems, message);
}

async function checkGitRepo(c) {
  const g = gitFacts(c);
  const hasDotGit = fs.existsSync(path.join(c.root, '.git'));
  if (!g.available) {
    return combine([problem(hasDotGit ? 'fail' : 'warn', say(c.t, 'doctor.git.missing'), say(c.t, 'doctor.git.missing_fix'))]);
  }
  if (g.state === 'none') return combine([problem('warn', say(c.t, 'doctor.git.none'), say(c.t, 'doctor.git.init_fix'))]);
  if (g.state === 'nested') {
    const top = gitOut(c, ['rev-parse', '--show-toplevel']) ?? '?';
    return combine([problem('warn', say(c.t, 'doctor.git.nested', { top }), say(c.t, 'doctor.git.nested_fix'))]);
  }
  if (g.state === 'error') {
    const detail = oneLine(g.detail).slice(0, 300) || '?';
    const safe = /dubious ownership|safe\.directory/i.test(g.detail);
    return combine([problem('fail', say(c.t, 'doctor.git.error', { detail }), safe ? say(c.t, 'doctor.git.safe_fix', { path: posixPath(c.root) }) : null)]);
  }
  const problems = [];
  const branch = gitOut(c, ['symbolic-ref', '--quiet', '--short', 'HEAD']) || say(c.t, 'doctor.git.detached');
  const remotes = (gitOut(c, ['remote']) ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const mode = c.cfg?.mode ?? (typeof rawConfig(c).value?.mode === 'string' ? rawConfig(c).value.mode : 'github');
  const paths = (gitOut(c, ['rev-parse', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'MERGE_HEAD',
    '--git-path', 'CHERRY_PICK_HEAD']) ?? '').split(/\r?\n/);
  const ops = ['rebase', 'rebase', 'merge', 'cherry-pick'];
  const busy = paths.findIndex((p) => p && fs.existsSync(path.resolve(c.root, p)));
  if (busy >= 0) problems.push(problem('warn', say(c.t, 'doctor.git.busy', { op: ops[busy] }), say(c.t, 'doctor.git.busy_fix', { op: ops[busy] })));
  if (!remotes.length && mode !== 'local') problems.push(problem('warn', say(c.t, 'doctor.git.no_remote'), say(c.t, 'doctor.git.remote_fix')));
  const message = mode === 'local'
    ? say(c.t, 'doctor.git.ok_local', { branch })
    : say(c.t, 'doctor.git.ok', { branch, remote: remotes.join(', ') || '–' });
  return combine(problems, message, { prefix: problems.length ? message : undefined });
}

/** True when a core.hooksPath value names the vault's .githooks folder. */
function isKitHooksPath(c, value) {
  const v = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (v === '.githooks' || v === './.githooks') return true;
  const a = realpathLoose(resolvePath(c.root, value, { home: c.home }));
  const b = realpathLoose(path.join(c.root, '.githooks'));
  return insidePath(a, b) && insidePath(b, a);
}

async function checkHooksPath(c) {
  if (!isTop(c)) return skipped(c, 'doctor.reason.no_git');
  const value = gitOut(c, ['config', '--get', 'core.hooksPath']);
  if (!value) {
    const repairable = fs.existsSync(inVault(c, HOOK_REL));
    let fix = say(c.t, 'doctor.hooks.fix');
    if (repairable) {
      fix = vaultHasDoctor(c)
        ? say(c.t, 'doctor.hooks.auto_fix')
        : say(c.t, 'doctor.hooks.runner_fix', { command: runnerCommand(c, ['doctor', '--fix']) });
    }
    return combine([problem('warn', say(c.t, 'doctor.hooks.unset'), fix, repairable ? ['hooks_path'] : [])]);
  }
  if (isKitHooksPath(c, value)) return ok(say(c.t, 'doctor.hooks.ok'));
  return combine([problem('warn', say(c.t, 'doctor.hooks.other', { value }), say(c.t, 'doctor.hooks.fix'))]);
}

/**
 * The nodes .githooks/pre-commit tries in a git app started outside a terminal, in its order:
 * [{ path, onPath }]. First the node on the app's PATH (launchd gives /usr/bin:/bin on macOS, a
 * Linux desktop also /usr/local/bin), then the usual places of the installers. The hook uses the
 * first one that is Node.js 22 or newer.
 */
function guiNodeCandidates(c) {
  const pathDirs = c.platform === 'darwin' ? ['/usr/bin', '/bin'] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const onPath = pathDirs.map((dir) => `${dir}/node`).find((p) => c.io.isExecutable(p));
  const usual = ['/opt/homebrew/bin/node', '/usr/local/bin/node'];
  if (c.home) usual.push(path.posix.join(posixPath(c.home), '.volta', 'bin', 'node'));
  const out = onPath ? [{ path: onPath, onPath: true }] : [];
  for (const p of usual) if (!out.some((x) => x.path === p)) out.push({ path: p, onPath: false });
  return out;
}

/** The major version of 'x.y.z', or null. */
const majorOf = (version) => (cmpVersion(version, version) === 0 ? Number(/^v?(\d+)/.exec(String(version).trim())[1]) : null);

/** The node path to pin: a stable Homebrew link instead of a versioned Cellar path. */
async function stableNode(c) {
  try {
    return (await need(c, 'clients.mjs')).nodeCommand({ execPath: c.execPath, platform: c.platform });
  } catch {
    return c.execPath;
  }
}

async function nodeForGitApps(c) {
  const problems = [];
  let label = say(c.t, 'doctor.hook.node_path');
  const minimum = neededNode(c);
  const pinFix = async () => say(c.t, 'doctor.hook.pin_fix', { node: await stableNode(c) });
  const pin = gitOut(c, ['config', '--get', 'memorykit.node']);
  if (pin) {
    if (!c.io.isExecutable(pin)) {
      problems.push(problem('warn', say(c.t, 'doctor.hook.pin_broken', { pin }), await pinFix()));
    } else {
      const version = c.io.nodeVersion(pin);
      if (version && cmpVersion(version, minimum) === -1) {
        problems.push(problem('warn', say(c.t, 'doctor.hook.pin_old', { pin, version, need: minimum }), await pinFix()));
      } else {
        label = pin;
      }
    }
    return { problems, label };
  }
  // What the hook does in a git app: the first node new enough runs the check. With none, a too
  // old node on the app's PATH refuses the commit; one only in a usual place counts as no node.
  let tooOld = null;
  for (const candidate of guiNodeCandidates(c)) {
    if (!c.io.isExecutable(candidate.path)) continue;
    const version = c.io.nodeVersion(candidate.path);
    const major = majorOf(version);
    if (major === null || major >= HOOK_NODE_MAJOR) return { problems, label };
    tooOld ??= { ...candidate, version };
  }
  if (tooOld?.onPath) {
    problems.push(problem('warn', say(c.t, 'doctor.hook.gui_old', { candidate: tooOld.path, version: tooOld.version }), await pinFix()));
  } else {
    problems.push(problem('warn', say(c.t, 'doctor.hook.gui_missing', { node: c.execPath }), await pinFix()));
  }
  return { problems, label };
}

async function checkPreCommit(c) {
  const top = isTop(c);
  let buf;
  try {
    buf = fs.readFileSync(inVault(c, HOOK_REL));
  } catch {
    const tracked = top && git(c.root, ['cat-file', '-e', `HEAD:${HOOK_REL}`], { allowFail: true }).ok;
    return combine([problem('fail', say(c.t, 'doctor.hook.missing'),
      tracked ? say(c.t, 'doctor.hook.checkout_fix') : say(c.t, 'doctor.hook.copy_fix', { source: DEFAULT_SOURCE }))]);
  }
  const problems = [];
  // --fix repairs the file a symbolic link leads to only inside the vault.
  let target = null;
  try {
    const hook = hookFile(c.root);
    if (!hook.inside) target = hook.file;
  } catch {
    /* read above; a race is not a finding */
  }
  let repairFix = say(c.t, 'doctor.hook.repair_fix');
  if (target !== null) repairFix = say(c.t, 'doctor.hook.outside_fix', { target });
  else if (!vaultHasDoctor(c)) repairFix = say(c.t, 'doctor.hook.runner_fix', { command: runnerCommand(c, ['doctor', '--fix']) });
  const repair = target === null ? ['hook_file'] : [];
  const copyFix = say(c.t, 'doctor.hook.copy_fix', { source: DEFAULT_SOURCE });
  const text = buf.toString('utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  if (bom) problems.push(problem('fail', say(c.t, 'doctor.hook.bom'), repairFix, repair));
  if (body.includes('\r')) problems.push(problem('fail', say(c.t, 'doctor.hook.crlf'), repairFix, repair));
  const shebang = body.split('\n')[0].replace(/\r$/, '');
  if (!/^#!.*\b(?:sh|bash|dash|ksh|zsh)\b/.test(shebang)) problems.push(problem('fail', say(c.t, 'doctor.hook.shebang'), copyFix));
  if (c.platform !== 'win32') {
    let mode = 0;
    try {
      mode = fs.statSync(inVault(c, HOOK_REL)).mode;
    } catch {
      /* read above; a race is not a finding */
    }
    if (!(mode & 0o111)) problems.push(problem('fail', say(c.t, 'doctor.hook.not_exec'), repairFix, repair));
  }
  if (!/system\/memory\.mjs["']?\s+check\b[^\n]*--pre-commit/.test(body)) problems.push(problem('warn', say(c.t, 'doctor.hook.no_check'), copyFix));
  let label = say(c.t, 'doctor.hook.node_path');
  if (top) {
    const staged = gitOut(c, ['ls-files', '-s', '--', HOOK_REL]);
    if (staged && staged.startsWith('100644')) problems.push(problem('warn', say(c.t, 'doctor.hook.index_mode'), say(c.t, 'doctor.hook.index_fix')));
    // Git for Windows starts hooks with the Windows PATH, which the Node.js installer extends.
    if (c.platform !== 'win32') {
      const node = await nodeForGitApps(c);
      problems.push(...node.problems);
      label = node.label;
    }
  }
  return combine(problems, say(c.t, 'doctor.hook.ok', { node: label }));
}

/** True when a .gitattributes text has `* text=auto eol=lf` (or `* text eol=lf`). */
export function hasEolRule(text) {
  return String(text).replace(/^\uFEFF/, '').split(/\r?\n/).some((line) => {
    const l = line.trim();
    if (!l || l.startsWith('#')) return false;
    const [pattern, ...attrs] = l.split(/\s+/);
    return pattern === '*' && attrs.includes('eol=lf') && (attrs.includes('text=auto') || attrs.includes('text'));
  });
}

async function checkAttributes(c) {
  const text = readTextOrNull(inVault(c, '.gitattributes'));
  if (text !== null && hasEolRule(text)) return ok(say(c.t, 'doctor.attributes.ok'));
  let message = say(c.t, text === null ? 'doctor.attributes.missing' : 'doctor.attributes.rule');
  const autocrlf = isTop(c) ? gitOut(c, ['config', '--get', 'core.autocrlf']) : null;
  if (autocrlf && autocrlf.toLowerCase() === 'true') message += ` (${say(c.t, 'doctor.attributes.autocrlf', { value: autocrlf })})`;
  return combine([problem('warn', message, say(c.t, 'doctor.attributes.fix'))]);
}

async function checkRoots(c) {
  const raw = rawConfig(c).value;
  if (!raw) return skipped(c, 'doctor.reason.config');
  if (raw.roots === undefined) return ok(say(c.t, 'doctor.roots.main_only'));
  if (!Array.isArray(raw.roots) || raw.roots.length === 0) return skipped(c, 'doctor.reason.config');
  const problems = [];
  const found = [];
  const realRoot = realpathLoose(c.root);
  for (const [i, entry] of raw.roots.slice(1).entries()) {
    const r = isObj(entry) ? entry : {};
    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `#${i + 1}`;
    const given = typeof r.path === 'string' ? r.path.trim() : '';
    if (!given) continue; // config.memory_json reports it
    if (isForeignAbsolute(given)) {
      problems.push(problem('warn', say(c.t, 'doctor.roots.foreign', { id, path: given }), say(c.t, 'doctor.roots.foreign_fix')));
      continue;
    }
    const target = resolvePath(c.root, process.platform === 'win32' ? given : given.replace(/\\/g, '/'), { home: c.home });
    if (insidePath(realRoot, realpathLoose(target))) {
      problems.push(problem('fail', say(c.t, 'doctor.roots.inside', { id, path: given }),
        say(c.t, 'doctor.roots.inside_fix', { name: path.basename(c.root) })));
      continue;
    }
    if (!isDir(target)) {
      problems.push(problem('warn', say(c.t, 'doctor.roots.missing', { id, path: target }), say(c.t, 'doctor.roots.missing_fix')));
      continue;
    }
    found.push(`${id} (${target})`);
  }
  if (!found.length && !problems.length) return ok(say(c.t, 'doctor.roots.main_only'));
  return combine(problems, say(c.t, 'doctor.roots.ok', { list: found.join(', ') }));
}

async function checkGenerated(c) {
  if (!c.cfg) return skipped(c, 'doctor.reason.config');
  const [{ loadVault }, { RULES, runChecks }] = await Promise.all([need(c, 'vault.mjs'), need(c, 'check.mjs')]);
  const wanted = new Set([...GEN_FAIL, ...GEN_WARN]);
  const vault = loadVault(c.cfg, { roots: 'all' });
  const res = await runChecks(c.cfg, vault, { strict: false, skip: RULES.map((r) => r.code).filter((code) => !wanted.has(code)) });
  const findings = [...res.errors, ...res.warnings].filter((f) => wanted.has(f.code));
  const rels = (codes) => uniq(findings.filter((f) => codes.includes(f.code)).map((f) => f.rel));
  const problems = [];
  const failed = findings.find((f) => f.code === 'GEN_FAILED');
  if (failed) problems.push(problem('fail', say(c.t, 'doctor.generated.failed', { detail: failed.msg }), say(c.t, 'doctor.generated.failed_fix')));
  if (findings.some((f) => f.code === 'GEN_BUDGET')) {
    problems.push(problem('fail', say(c.t, 'doctor.generated.budget'), say(c.t, 'doctor.generated.budget_fix', { state: c.cfg.files.state })));
  }
  const edited = rels(['GEN_EDITED']);
  if (edited.length) problems.push(problem('fail', say(c.t, 'doctor.generated.edited', { files: listed(c, edited) }), say(c.t, 'doctor.generated.edited_fix')));
  const stale = rels(['GEN_MISSING', 'GEN_STALE', 'GEN_ORPHAN', 'GITIGNORE_LOCAL']);
  if (stale.length) problems.push(problem('warn', say(c.t, 'doctor.generated.stale', { files: listed(c, stale) }), say(c.t, 'doctor.generated.fix')));
  return combine(problems, say(c.t, 'doctor.generated.ok'));
}

// Folder names of sync services; a git repository inside them risks locked files and a damaged .git.
const CLOUD_FOLDERS = [
  [/^OneDrive(?:$|[ -])/i, 'OneDrive'],
  [/^Dropbox(?:$| \()/i, 'Dropbox'],
  [/^(?:Google Drive|My Drive|GoogleDrive-.+)$/i, 'Google Drive'],
  [/^(?:Mobile Documents|iCloud Drive|iCloudDrive)$/i, 'iCloud Drive'],
  [/^(?:Box|Box Sync|Box-Box)$/i, 'Box'],
];

/** The sync service whose folder holds dir ('OneDrive', 'Dropbox', ...), or null. */
export function cloudService(dir, { env = process.env, platform = process.platform } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  for (const name of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const base = env?.[name];
    if (typeof base === 'string' && base && p.isAbsolute(base) && insidePath(base, dir, { platform, pathMod: p })) return 'OneDrive';
  }
  for (const segment of String(dir).split(/[\\/]+/)) {
    for (const [re, service] of CLOUD_FOLDERS) if (re.test(segment)) return service;
  }
  return null;
}

/** A HOME value as a Windows path ('/c/Users/x' from Git Bash becomes 'c:/users/x'), folded for comparison. */
function foldWindowsPath(p) {
  let s = String(p).replace(/\\/g, '/');
  const m = /^\/([a-zA-Z])(?:\/|$)(.*)$/.exec(s);
  if (m) s = `${m[1]}:/${m[2]}`;
  return s.replace(/\/+$/, '').toLowerCase();
}

async function checkPlatform(c) {
  const osName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[c.platform] ?? c.platform;
  const base = say(c.t, 'doctor.platform.ok', {
    os: osName, release: c.osRelease, arch: c.arch, node: c.execPath, home: c.home, probe: UTF8_PROBE,
  });
  const problems = [];
  if (c.platform === 'win32') {
    const homeEnv = c.env?.HOME;
    if (typeof homeEnv === 'string' && homeEnv && foldWindowsPath(homeEnv) !== foldWindowsPath(c.home)) {
      problems.push(problem('warn', say(c.t, 'doctor.platform.home', { homeEnv, home: c.home }), say(c.t, 'doctor.platform.home_fix', { home: c.home })));
    }
  }
  const service = cloudService(c.root, { env: c.env, platform: c.platform });
  if (service) problems.push(problem('warn', say(c.t, 'doctor.platform.cloud', { service }), say(c.t, 'doctor.platform.cloud_fix', { service })));
  return combine(problems, base, { prefix: problems.length ? base : undefined });
}

/** The program an MCP entry starts ({command}, Zed's {command: {path}}, Cline's {transport}). */
function entryCommand(entry) {
  if (typeof entry?.command === 'string') return entry.command;
  if (typeof entry?.command?.path === 'string') return entry.command.path;
  if (typeof entry?.transport?.command === 'string') return entry.transport.command;
  return null;
}

async function checkClients(c) {
  const clients = await need(c, 'clients.mjs');
  const opts = { vault: c.root, env: c.env, home: c.home, ...c.clients };
  const io = opts.io ?? clients.IO;
  const rows = clients.inspectClients(opts);
  const problems = [];
  const connected = [];
  for (const row of rows) {
    if (row.state === 'connected') connected.push(row.name);
    for (const e of row.errors ?? []) {
      problems.push(problem('warn', say(c.t, 'doctor.mcp.unreadable', { client: row.name, path: e.path, error: oneLine(e.error).slice(0, 200) }),
        say(c.t, 'doctor.mcp.unreadable_fix', { path: e.path })));
    }
    const ours = row.entries.filter((e) => e.kind === 'this');
    const files = uniq(ours.map((e) => e.path));
    const table = clients.findClient(row.id);
    for (const file of files) {
      let entries = [];
      try {
        const text = io.readText(file);
        entries = row.format === 'toml' ? clients.tomlEntries(text) : clients.jsonEntries(text, table.key, row.id);
      } catch {
        continue; // reported through row.errors
      }
      for (const e of ours.filter((x) => x.path === file)) {
        const hit = entries.find((x) => x.name === e.name && (x.project ?? null) === (e.project ?? null));
        const command = entryCommand(hit?.entry);
        if (command && (path.isAbsolute(command) || path.win32.isAbsolute(command)) && !io.isFile(command)) {
          problems.push(problem('warn', say(c.t, 'doctor.mcp.stale_command', { client: row.name, name: e.name, command }),
            say(c.t, 'doctor.mcp.stale_command_fix', { id: row.id })));
        }
      }
    }
    for (const e of row.entries.filter((x) => x.kind === 'kit' && typeof x.root === 'string' && x.root)) {
      if ((path.isAbsolute(e.root) || path.win32.isAbsolute(e.root)) && !isDir(e.root)) {
        problems.push(problem('warn', say(c.t, 'doctor.mcp.gone_vault', { client: row.name, name: e.name, root: e.root }),
          say(c.t, 'doctor.mcp.gone_vault_fix', { id: row.id, name: e.name })));
      }
    }
  }
  // A vault whose kit has no connect (0.1.0) has no MCP server either: no hint to connect it.
  const canConnect = sameDir(c.root, c.kitRoot) || fs.existsSync(inVault(c, 'system/lib/commands/connect.mjs'));
  const none = say(c.t, canConnect ? 'doctor.mcp.none' : 'doctor.mcp.none_plain');
  const base = connected.length ? say(c.t, 'doctor.mcp.connected', { clients: connected.join(', ') }) : none;
  return combine(problems, base, { prefix: problems.length ? base : undefined });
}

// Memory hooks for code projects (connect claude-code|codex --projects, lib/hooksetup.mjs).
const PROBE_MAX_MS = 1500; // Claude Code gives all SessionEnd hooks together 1.5 s
const FAILURE_DAYS = 7;
const PROBE_EVENT = 'doctor-probe'; // the hook log entry of a probe run: {agent, event, ok, from, t}

/** The events the hooks need: SessionEnd only starts the autosync, so only with autosync on. */
const neededEvents = (autosync) => ['SessionStart', 'Stop', ...(autosync ? ['SessionEnd'] : [])];

/** A test of hook log entries: true for the runs of doctor --probe (inside a probe entry's from…t). */
function probeRuns(entries) {
  const spans = entries.filter((e) => e.event === PROBE_EVENT && typeof e.from === 'string')
    .map((e) => ({ agent: e.agent, from: Date.parse(e.from), to: Date.parse(e.t) }));
  return (e) => {
    if (e.event === PROBE_EVENT) return true;
    const at = Date.parse(e.t);
    return spans.some((s) => s.agent === e.agent && at >= s.from && at <= s.to);
  };
}

/** An agent's hook file: null when there is none (or it is empty), else { file, settings } or { file, error }. */
async function agentSettings(c, hs, agent) {
  const file = hs.settingsPath(agent, { env: c.env, home: c.home, platform: c.platform });
  const text = readTextOrNull(file);
  if (text === null || !text.trim()) return null;
  try {
    return { file, settings: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (err) {
    try {
      return { file, settings: (await need(c, 'jsonc.mjs')).parseJsonc(text).value };
    } catch {
      return { file, error: oneLine(err.message).slice(0, 200) };
    }
  }
}

/** Problems of the programs the hooks start as Node.js: 'node' on the PATH, or an absolute path. */
function hookNodeProblems(c, agent, name, words) {
  const need = neededNode(c);
  const fix = say(c.t, 'doctor.projects.node_fix', { need, id: agent });
  const out = [];
  for (const node of words) {
    if (node !== 'node' && !c.io.isExecutable(node)) {
      out.push(problem('fail', say(c.t, 'doctor.projects.node_gone', { agent: name, node }), say(c.t, 'doctor.projects.reconnect_fix', { id: agent })));
      continue;
    }
    const have = once(c, `node-version:${node}`, () => c.io.nodeVersion(node));
    if (have === null && node === 'node') out.push(problem('fail', say(c.t, 'doctor.projects.node_missing', { agent: name }), fix));
    else if (have !== null && cmpVersion(have, need) === -1) out.push(problem('fail', say(c.t, 'doctor.projects.node_old', { agent: name, node, have, need }), fix));
  }
  return out;
}

/**
 * doctor --probe: runs the SessionStart hook as the agent does (hooksetup.probeSpec) in an empty
 * temporary folder, with the input of a session start there marked as a probe (hooksetup.probeEnv
 * keeps git from finding a repository above it), and logs the run's span (PROBE_EVENT), so its
 * own log entries never pass for a session. { problem } or { note }.
 */
function probeHook(c, hs, log, agent, name, handler) {
  const tmp = fs.mkdtempSync(path.join(c.io.tmpDir?.() ?? os.tmpdir(), 'memory-kit-probe-'));
  const from = new Date();
  try {
    const bash = c.platform === 'win32' && agent === 'claude-code' ? (c.io.gitBashPath ?? hs.gitBashPath)({ env: c.env }) : null;
    const spec = hs.probeSpec(agent, handler, { platform: c.platform, env: c.env, bash });
    const r = (c.io.probeHook ?? hs.runProbe)(spec, { input: hs.probePayload(tmp), cwd: tmp, env: hs.probeEnv(c.env, tmp) });
    log.logHook(c.root, { agent, event: PROBE_EVENT, ok: true, from: from.toISOString(), ms: r.ms });
    const command = Array.isArray(handler.args) ? [handler.command, ...handler.args].map(shellArg).join(' ') : handler.command;
    if (r.error || r.code !== 0) {
      const why = oneLine(String(r.stderr ?? '').split(/\r?\n/).find((l) => l.trim()) ?? '').slice(0, 160);
      const detail = r.error ?? `exit ${r.code}${why ? `: ${why}` : ''}`;
      return { problem: problem('fail', say(c.t, 'doctor.projects.probe_failed', { agent: name, detail }), say(c.t, 'doctor.projects.probe_fix', { command })) };
    }
    if (String(r.stdout).trim()) {
      const text = oneLine(r.stdout).slice(0, 80);
      return { problem: problem('fail', say(c.t, 'doctor.projects.probe_noise', { agent: name, text }), say(c.t, 'doctor.projects.noise_fix')) };
    }
    if (r.ms > PROBE_MAX_MS) {
      return { problem: problem('warn', say(c.t, 'doctor.projects.probe_slow', { agent: name, ms: r.ms, max: PROBE_MAX_MS }), say(c.t, 'doctor.projects.slow_fix')) };
    }
    return { note: say(c.t, 'doctor.projects.probe_ok', { agent: name, ms: r.ms }) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** The problems of one agent's memory hooks (ours: hooksetup.ourHooks of its settings). */
function agentHookProblems(c, hs, { agent, name, file, settings, ours, entries, autosync }) {
  const opts = { env: c.env, home: c.home, platform: c.platform };
  const problems = [];
  const reconnect = say(c.t, 'doctor.projects.reconnect_fix', { id: agent });
  const names = new Set(ours.map((o) => o.name));
  const missing = neededEvents(autosync).filter((e) => !names.has(e));
  if (missing.length) problems.push(problem('warn', say(c.t, 'doctor.projects.incomplete', { agent: name, events: missing.join(', ') }), reconnect));
  const parsed = ours.map((o) => o.parsed).filter(Boolean);
  const script = path.join(c.root, 'system', 'memory.mjs');
  for (const other of uniq(parsed.map((x) => x.script))) {
    if (hs.sameScript(other, script, c.platform)) continue;
    const exists = c.io.isFile(other);
    problems.push(problem(exists ? 'warn' : 'fail', say(c.t, exists ? 'doctor.projects.other' : 'doctor.projects.moved', { agent: name, script: other }), reconnect));
  }
  problems.push(...hookNodeProblems(c, agent, name, uniq(parsed.map((x) => x.node))));
  if (agent === 'claude-code') {
    const min = (c.io.claudeVersions ?? hs.claudeVersions)(opts).min;
    if (min && parsed.some((x) => x.form === 'exec') && cmpVersion(min, hs.CLAUDE_EXEC_MIN) === -1) {
      problems.push(problem('fail', say(c.t, 'doctor.projects.exec_old', { version: min }), say(c.t, 'doctor.projects.exec_fix')));
    }
    if (min && names.has('PostToolUseFailure') && cmpVersion(min, hs.CLAUDE_FAILURE_MIN) === -1) {
      problems.push(problem('fail', say(c.t, 'doctor.projects.failure_old', { version: min }), say(c.t, 'doctor.projects.failure_fix')));
    }
    if (settings.disableAllHooks === true) {
      problems.push(problem('warn', say(c.t, 'doctor.projects.disabled_all', { path: file }), say(c.t, 'doctor.projects.disabled_all_fix', { path: file })));
    }
  } else {
    const info = (c.io.codexInfo ?? hs.codexInfo)(opts);
    if (info.off) problems.push(problem('warn', say(c.t, 'doctor.projects.codex_off', info.off), say(c.t, 'doctor.projects.codex_off_fix', info.off)));
    if (info.min && cmpVersion(info.min, hs.CODEX_HOOKS_MIN) === -1) {
      problems.push(problem('warn', say(c.t, 'doctor.projects.codex_old', { version: info.min }), say(c.t, 'doctor.projects.codex_old_fix')));
    }
  }
  // Installed, sessions started since, and not one hook run in the log (doctor --probe runs do not
  // count): the agent does not run them.
  let since = 0;
  try {
    since = fs.statSync(file).mtimeMs;
  } catch {
    /* gone meanwhile */
  }
  const started = (c.io.newestSessionStart ?? hs.newestSessionStart)(agent, opts);
  const probed = probeRuns(entries);
  const ran = entries.some((e) => e.agent === agent && Date.parse(e.t) >= since - 1000 && !probed(e));
  if (since && started > since + 60000 && !ran) {
    problems.push(problem('warn', say(c.t, 'doctor.projects.not_running', { agent: name, since: new Date(since).toISOString().slice(0, 16).replace('T', ' ') }),
      say(c.t, agent === 'codex' ? 'doctor.projects.not_running_codex_fix' : 'doctor.projects.not_running_claude_fix')));
  }
  return problems;
}

async function checkProjectHooks(c) {
  const conf = rawConfig(c);
  if (conf.error) return skipped(c, 'doctor.reason.config');
  const p = conf.value.projects;
  if (!isObj(p) || p.enabled !== true) {
    // A vault whose kit has no project hooks (before 0.1.2) gets no hint to connect them.
    const can = sameDir(c.root, c.kitRoot) || fs.existsSync(inVault(c, 'system/lib/hooksetup.mjs'));
    return ok(say(c.t, can ? 'doctor.projects.off' : 'doctor.projects.off_plain'));
  }
  const hs = await need(c, 'hooksetup.mjs');
  const log = await need(c, 'hooklog.mjs');
  const entries = log.readHookLog(c.root);
  const problems = [];
  const agents = [];
  const notes = [];
  for (const agent of Object.keys(hs.AGENTS)) {
    const name = hs.AGENTS[agent];
    const got = await agentSettings(c, hs, agent);
    if (!got) continue;
    if (got.error) {
      problems.push(problem('warn', say(c.t, 'doctor.projects.unreadable', { agent: name, path: got.file, error: got.error }), say(c.t, 'doctor.projects.unreadable_fix', { path: got.file })));
      continue;
    }
    const ours = hs.ourHooks(got.settings, agent);
    if (!ours.length) continue;
    agents.push(name);
    problems.push(...agentHookProblems(c, hs, { agent, name, file: got.file, settings: got.settings, ours, entries, autosync: p.autosync === true }));
    const start = ours.find((o) => o.name === 'SessionStart')?.handler;
    if (c.probe && start) {
      const r = probeHook(c, hs, log, agent, name, start);
      if (r.problem) problems.push(r.problem);
      else notes.push(r.note);
    }
  }
  if (!agents.length) return combine([...problems, problem('warn', say(c.t, 'doctor.projects.none'), say(c.t, 'doctor.projects.connect_fix'))], '');

  // What the hook log shows: failures of the last days, and a failed sync.
  const summary = log.hookSummary(c.root, { now: c.now, days: FAILURE_DAYS });
  const cutoff = c.now.getTime() - FAILURE_DAYS * 86400000;
  const sync = summary.lastSync?.ok === false && Date.parse(summary.lastSync.t) >= cutoff ? summary.lastSync : null;
  const probed = probeRuns(log.readHookLog(c.root));
  const failures = summary.failures.filter((e) => e !== sync && !probed(e)).reverse();
  if (failures.length) {
    const items = failures.map((e) => `${e.event}${e.step ? `/${e.step}` : ''} ${String(e.t).slice(0, 10)}: ${oneLine(e.error ?? '?').slice(0, 120)}`);
    const fixes = uniq(failures.slice(0, MAX_LISTED).map((e) => e.fix).filter((f) => typeof f === 'string' && f));
    problems.push(problem('warn', say(c.t, 'doctor.projects.failures', { days: FAILURE_DAYS, list: listed(c, items) }),
      [...fixes, say(c.t, 'doctor.projects.failures_fix', { log: log.LOG_REL })].join('; ')));
  }
  if (sync) {
    problems.push(problem('warn', say(c.t, 'doctor.projects.sync_failed', { step: sync.step ?? '?', when: String(sync.t).slice(0, 16).replace('T', ' '), error: oneLine(sync.error ?? '?').slice(0, 160) }),
      typeof sync.fix === 'string' && sync.fix ? sync.fix : say(c.t, 'doctor.projects.sync_fix')));
  }
  const base = [say(c.t, 'doctor.projects.ok', {
    agents: agents.join(', '), store: p.store === 'git' ? 'git' : 'local', auto_add: p.auto_add === true, autosync: p.autosync === true,
  }), ...notes].join('; ');
  return combine(problems, base, { prefix: problems.length ? base : undefined });
}

const CHECKS = {
  'node.version': checkNodeVersion,
  'node.fts5': checkFts5,
  'config.memory_json': checkConfig,
  'config.data_version': checkDataVersion,
  'kit.version': checkKitVersion,
  'kit.integrity': checkIntegrity,
  'kit.upgrade_lock': checkUpgradeLock,
  'agents.block': checkAgentsBlock,
  adapters: checkAdapters,
  'git.repo': checkGitRepo,
  'git.hooks_path': checkHooksPath,
  'git.pre_commit': checkPreCommit,
  'git.attributes': checkAttributes,
  roots: checkRoots,
  'generated.fresh': checkGenerated,
  platform: checkPlatform,
  'mcp.clients': checkClients,
  'projects.hooks': checkProjectHooks,
};

// ---------------------------------------------------------------------------------------------
// The report

/**
 * Runs every check on the vault at root. opts: { kitRoot, cfg (null when memory.json or a pack
 * cannot be loaded), configError, t, probe (run the session start hook of the project hooks), and
 * for tests: platform, env, home, execPath, nodeVersion, osRelease, arch, now, fts5 (async () =>
 * boolean), io (see IO; for projects.hooks also claudeVersions, codexInfo, newestSessionStart,
 * gitBashPath and probeHook, which default to lib/hooksetup.mjs, and tmpDir, the folder the probe
 * makes its temporary folder in), clients (options for inspectClients: platform, pathMod, io,
 * findCli) }.
 * Returns { report, skipped: [id], repairs: [name] }: report has the doctor-result shape
 * { kit, root, checks: [{ id, status, message, fix }], summary: { ok, warn, fail } }; skipped
 * names the checks that could not run (their status is ok); repairs lists what --fix can do.
 */
export async function diagnose(root, opts = {}) {
  const c = {
    root: path.resolve(root),
    kitRoot: path.resolve(opts.kitRoot ?? path.join(HERE, '..', '..')),
    cfg: opts.cfg ?? null,
    configError: opts.configError ?? null,
    t: opts.t ?? opts.cfg?.t ?? null,
    platform: opts.platform ?? process.platform,
    env: opts.env ?? process.env,
    home: opts.home ?? os.homedir(),
    execPath: opts.execPath ?? process.execPath,
    nodeVersion: opts.nodeVersion ?? process.versions.node,
    osRelease: opts.osRelease ?? os.release(),
    arch: opts.arch ?? process.arch,
    fts5: opts.fts5,
    probe: opts.probe === true,
    now: opts.now ?? new Date(),
    io: { ...IO, ...opts.io },
    clients: opts.clients ?? {},
    modules: new Map(),
    memo: new Map(),
  };
  c.version = readVersion(c.root);
  const checks = [];
  const skippedIds = [];
  const repairs = [];
  for (const id of CHECK_IDS) {
    let res;
    try {
      res = await CHECKS[id](c);
    } catch (err) {
      res = err instanceof ModuleError
        ? { status: 'fail', message: say(c.t, 'doctor.module', { file: err.file, detail: err.detail }), fix: say(c.t, 'doctor.module_fix', { file: err.file }) }
        : { status: 'fail', message: say(c.t, 'doctor.crashed', { detail: oneLine(err?.message ?? err).slice(0, 300) }), fix: null };
    }
    const message = oneLine(res.message) || id;
    checks.push({ id, status: res.status, message, fix: res.fix ? oneLine(res.fix) : null });
    if (res.skipped) skippedIds.push(id);
    for (const r of res.repair ?? []) if (!repairs.includes(r)) repairs.push(r);
  }
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const ch of checks) summary[ch.status] += 1;
  return { report: { kit: c.version, root: c.root, checks, summary }, skipped: skippedIds, repairs };
}

/** Human output: a title, one line per check (✓ ok, ! warn, ✗ fail, · not checked), the fix under problems, a summary. */
export function formatReport(report, { skipped = [], t } = {}) {
  const marks = { ok: '✓', warn: '!', fail: '✗' };
  const width = Math.max(0, ...report.checks.map((ch) => ch.id.length));
  const lines = [say(t, 'doctor.title', { version: report.kit ?? '–', root: report.root })];
  for (const ch of report.checks) {
    const mark = skipped.includes(ch.id) ? '·' : marks[ch.status];
    lines.push(`${mark} ${ch.id.padEnd(width)}  ${ch.message}`);
    if (ch.status !== 'ok' && ch.fix) lines.push(`${' '.repeat(width + 4)}${say(t, 'doctor.fix', { fix: ch.fix })}`);
  }
  lines.push(say(t, 'doctor.summary', report.summary));
  return `${lines.join('\n')}\n`;
}

/** Validates a report against system/schema/doctor-result.schema.json of kitRoot: { ok, errors }. */
export async function validateReport(report, kitRoot = path.join(HERE, '..', '..')) {
  const { validateAs } = await import(pathToFileURL(path.join(HERE, 'schema.mjs')).href);
  return validateAs(kitRoot, 'doctor-result', report);
}
