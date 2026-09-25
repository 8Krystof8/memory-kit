// `connect`: switches the memory on in an AI app. It adds the MCP server entry
// (node <vault>/system/memory.mjs mcp --root <vault>) to that app's own config and keeps
// everything else in the file: other servers and settings, and every other byte of a TOML file.
// A file with comments is never rewritten; the entry is printed to paste instead. Claude Code
// gets the entry through its own `claude mcp add` when that command can be run. Changed files
// are copied to .memory-kit/backups/connect/ first. `connect --list` shows which apps serve
// this vault. Where each app keeps its config and how it is edited: lib/clients.mjs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from '../fsafe.mjs';
import {
  CLIENTS, DEFAULT_NAME, IO, NAME_RE, buildEntry, claudeAddArgs, claudeRemoveArgs, entryTarget, findClient,
  findExecutable, inspectClients, jsonEntries, jsonSnippet, locateClient, nodeCommand, pathModFor, planJsonEdit,
  planTomlEdit, portableArgs, projectConfigPath, resolveClient, serverArgs, spawnSpec, tomlBlock, vaultRefs,
} from '../clients.mjs';
import { git, parseCli, usageError } from '../util.mjs';

export const usage = 'connect <client> [--scope user|project] [--name memory-kit] [--read-only] [--dry-run] [--remove] [--force] [--json] | connect claude-code|codex --projects [--remove] [--no-autosync] | connect --list [--json]';

export const BACKUP_DIR = '.memory-kit/backups/connect';
const CLI_TIMEOUT_MS = 120000;

// English defaults; packs may translate the same keys (section 4.10).
const DEFAULTS = {
  'connect.added': '{client}: added "{name}" to {path}',
  'connect.updated': '{client}: updated "{name}" in {path}',
  'connect.replaced': '{client}: replaced the other "{name}" entry in {path} (--force)',
  'connect.removed': '{client}: removed "{name}" from {path}',
  'connect.unchanged': '{client}: "{name}" is already connected in {path}',
  'connect.absent': '{client}: {path} has no "{name}" entry, nothing to remove',
  'connect.absent_other': '{client}: {path} has no "{name}" entry; this vault is connected there as "{other}" (to remove that one: connect {id} --remove --name {other})',
  'connect.plan.add': '{client}: would add "{name}" to {path}',
  'connect.plan.update': '{client}: would update "{name}" in {path}',
  'connect.plan.replace': '{client}: would replace the other "{name}" entry in {path}',
  'connect.plan.remove': '{client}: would remove "{name}" from {path}',
  'connect.dry_run': 'dry run: nothing was changed',
  'connect.new_file': 'this is a new file; to undo, delete it',
  'connect.new_file_link': '{path} is a link, so the new file is {target}; to undo, delete {target}',
  'connect.backup': 'the previous file is kept in {path}',
  'connect.connected_as': '{client}: this vault is already connected as "{other}" in {path}; to change that entry run connect {id} --name {other}, to add a second one use --force',
  'connect.conflict': '{client}: {path} already has a "{name}" entry that starts something else; choose another name with --name, or replace it with --force',
  'connect.conflict_remove': '{client}: the "{name}" entry in {path} does not serve this vault, so it stays; --force removes it anyway',
  'connect.comments.inside': '{client}: {path} contains comments, and connect never rewrites such a file. Add this inside "{key}" yourself and save:',
  'connect.comments.top': '{client}: {path} contains comments, and connect never rewrites such a file. Add this at the top level of the file (inside the outer braces) yourself and save:',
  'connect.comments.remove': '{client}: {path} contains comments, and connect never rewrites such a file. Delete the "{name}" entry inside "{key}" yourself.',
  'connect.numbers': '{client}: {path} holds numbers too large to write back exactly, so connect leaves it alone. Add this yourself:',
  'connect.unreadable': '{client}: {path} cannot be read ({error}). Fix it, or add this yourself:',
  'connect.unreadable_remove': '{client}: {path} cannot be read ({error}), so "{name}" cannot be removed from it; fix the file and run the command again',
  'connect.dangling': '{client}: {path} is a link to {target}, whose folder does not exist; create that folder or remove the link, then run the command again',
  'connect.not_object': '{client}: {path} does not have the expected layout ("{key}" must be an object). Add this yourself:',
  'connect.toml_form': '{client}: {path} defines the MCP servers in a form connect does not edit (inline or dotted tables). Change it yourself to:',
  'connect.changed': '{client}: {path} changed while connecting, so it was not written; run the command again',
  'connect.write_failed': '{client}: {path} could not be written ({detail}); close {client} and run the command again',
  'connect.app_missing': '{client} was not found on this computer ({dir} does not exist). Install it and start it once, or use --force to write {path} anyway',
  'connect.scope': '{client} has no project config that works on every computer, so only --scope user is possible (project scope works for cursor and vscode)',
  'connect.not_vault': 'no memory-kit vault here: {path} is missing',
  'connect.msix': 'Claude Desktop from the Microsoft Store reads {path}; its Edit Config button may open another file',
  'connect.msix_many': 'more than one Claude Desktop package has a config; the newest is used, {path} (the others: {others})',
  'connect.msix_real': 'Claude Desktop from the Microsoft Store has no private config yet, so it reads {path}',
  'connect.same_file': '{path} is the same file as {target}, so it is edited once',
  'connect.cli.plan': 'would run: {command}',
  'connect.cli.run': 'ran: {command}',
  'connect.cli.failed': '{client}: this command failed ({detail}): {command}',
  'connect.cli.unverified': 'the claude command reported success, but {path} does not show the change yet; check with: claude mcp get {name}',
  'connect.cli.fallback': 'no claude command that connect can run was found, so the entry goes straight into {path}',
  'connect.cli.fields': 'the "{name}" entry holds settings the claude command cannot keep, so connect edits {path} itself',
  'connect.project': 'the entry uses ${workspaceFolder}, so it works on every computer that opens this vault, as long as node is on the PATH there',
  'connect.project_ignored': 'git ignores {rel}, so this entry stays on this computer; on another computer run connect there too',
  'connect.next': 'next: {text}',
  'connect.check': 'check: {text}',
  'connect.try': 'then ask the agent to call memory_start; it answers with the start page of your memory',
  'connect.next_remove': 'next: restart {client} so it stops the server',
  'connect.next.claude-code': 'start a new Claude Code session (running sessions keep their old servers)',
  'connect.next.claude-code-file': 'close running Claude Code sessions and start a new one; Claude Code rewrites this file while it runs, so connect again if the entry disappears',
  'connect.check.claude-code': 'claude mcp get {name}, or /mcp inside a session',
  'connect.next.claude-desktop': 'quit Claude Desktop completely (on Windows from the tray icon) and start it again; it rewrites this file while it runs, so connect again if the entry disappears',
  'connect.check.claude-desktop': 'a new chat lists {name} among its tools; problems are logged in mcp-server-{name}.log',
  'connect.next.cursor': 'restart Cursor and allow {name} when it asks',
  'connect.check.cursor': 'Cursor Settings > MCP lists {name} with its tools',
  'connect.next.vscode': 'no restart needed: VS Code starts {name} with the next chat message and asks you to trust it',
  'connect.check.vscode': 'run MCP: List Servers from the command palette',
  'connect.next.windsurf': 'restart Windsurf (Devin Desktop) and allow {name} when it asks',
  'connect.check.windsurf': 'the MCP servers panel lists {name}',
  'connect.next.gemini-cli': 'start gemini again (or run /mcp reload) and trust the folder when it asks; in untrusted folders Gemini CLI starts no MCP servers',
  'connect.check.gemini-cli': '/mcp list shows {name} as connected',
  'connect.next.codex': 'restart Codex (the command, the IDE extension or the ChatGPT desktop app)',
  'connect.check.codex': 'codex mcp list, or /mcp in a session',
  'connect.next.zed': 'no restart needed: Zed notices the change by itself',
  'connect.check.zed': 'the Agent panel settings list {name} among the MCP servers',
  'connect.next.lm-studio': 'restart LM Studio and allow the tool calls when it asks',
  'connect.check.lm-studio': 'Program > Install > Edit mcp.json shows {name}',
  'connect.next.cline': 'reload the Cline extension or restart the IDE (or the cline command)',
  'connect.check.cline': 'MCP Servers > Installed lists {name}',
  'connect.next.copilot-cli': 'start copilot again and allow the tool calls when it asks',
  'connect.check.copilot-cli': '/mcp lists {name}',
  'connect.next.junie': 'restart the IDE or the junie command',
  'connect.check.junie': 'the MCP settings of Junie list {name}',
  'connect.guide.chatgpt': 'ChatGPT on the desktop uses the same config as Codex: run connect codex. ChatGPT on the web cannot start anything on your computer; it reads the memory through its GitHub connector (docs/integrations/chatgpt.md).',
  'connect.guide.claude-app': 'Claude on the web and in the mobile apps reaches only remote MCP servers, from Anthropic\'s cloud, so it cannot start the memory on your computer. Use the GitHub integration or a Claude Code session (docs/integrations/claude-app.md). For the Claude Desktop app on this computer run connect claude-desktop.',
  'connect.guide.jetbrains': 'JetBrains AI Assistant keeps MCP servers in the IDE settings, not in a file connect can edit. Open Settings | Tools | AI Assistant | Model Context Protocol (MCP), add a server and paste the JSON below, or run connect claude-desktop and use Import from Claude there. For Junie run connect junie.',
  'connect.list.title': 'MCP clients for {vault}:',
  'connect.list.hint': 'connect one with: node system/memory.mjs connect <client>',
  'connect.list.other': 'another vault: {root}',
  'connect.state.connected': 'connected',
  'connect.state.not-connected': 'not connected',
  'connect.state.app-not-found': 'app not found',
  'connect.state.guidance': 'guidance only',
  'connect.state.unreadable': 'unreadable',
};

/** Every message key of connect with its English text. */
export const MESSAGES = Object.freeze({ ...DEFAULTS });

/** A message in the vault's language (pack) or the English default. */
export function say(cfg, key, vars = {}) {
  const text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  const template = DEFAULTS[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(vars, name) && vars[name] !== undefined ? String(vars[name]) : all));
}

// ---------------------------------------------------------------------------------------------
// Helpers

const WRITES = new Set(['add', 'update', 'replace', 'remove']);
const FAILS = new Set(['conflict', 'refused', 'app-not-found', 'failed', 'changed', 'not-vault', 'scope']);
const DONE = { add: 'added', update: 'updated', replace: 'replaced', remove: 'removed' };

/** A command line for people to read (not for a shell). */
function showCommand(args) {
  return args.map((a) => (a === '' || /[\s"'$`\\;&|<>()*?!{}[\]]/.test(a) ? `"${String(a).replace(/(["\\$`])/g, '\\$1')}"` : a)).join(' ');
}

/** YYYYMMDD-HHMMSS in local time, as upgrade backups are named. */
function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

const pathOfBackups = (vault) => path.join(vault, ...BACKUP_DIR.split('/'));

/** Copies a config into <vault>/.memory-kit/backups/connect/, never over an older backup. */
function backupFile(vault, label, src, now) {
  const dir = pathOfBackups(vault);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(src) || '.bak';
  for (let n = 1; ; n++) {
    const file = path.join(dir, `${label}-${stamp(now)}${n > 1 ? `-${n}` : ''}${ext}`);
    try {
      fs.copyFileSync(src, file, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
    // A client config can hold other servers' keys: only the owner may read the copy.
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    return file;
  }
}

const MAX_LINKS = 32;

/**
 * Where a write to file lands: file itself, or the real file its symlink leads to, which does
 * not exist yet when the link dangles (a dotfiles link to a file still to be made). A dangling
 * link is followed by hand, a relative one from the real folder of the link, as the system
 * reads it. Throws ELOOP for a chain that never ends.
 */
export function writeTarget(file) {
  let cur = file;
  for (let hops = 0; hops < MAX_LINKS; hops++) {
    let stat;
    try {
      stat = fs.lstatSync(cur);
    } catch {
      return cur; // nothing there yet: a new file
    }
    if (!stat.isSymbolicLink()) return cur;
    try {
      return fs.realpathSync(cur);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    let base = path.dirname(cur);
    try {
      base = fs.realpathSync(base);
    } catch {
      /* the folder as named */
    }
    cur = path.resolve(base, fs.readlinkSync(cur));
  }
  throw Object.assign(new Error(`too many symbolic links: ${file}`), { code: 'ELOOP' });
}

/** Replaces a config atomically at dest (writeTarget of the config), keeping its mode. */
function writeConfig(dest, text) {
  let mode;
  if (process.platform !== 'win32') {
    try {
      mode = fs.statSync(dest).mode & 0o777;
    } catch {
      /* a new file gets the default mode */
    }
  }
  writeAtomic(dest, text, mode === undefined ? {} : { mode });
}

/** True when root is in a git work tree whose ignore rules leave out rel (a POSIX path). */
function gitIgnores(root, rel) {
  const res = git(root, ['check-ignore', '-q', '--no-index', rel], { allowFail: true });
  return res.ok;
}

/** Keeps .memory-kit/ out of git through .git/info/exclude (never the owner's .gitignore). */
export function ensureIgnored(vault) {
  const inside = git(vault, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  if (!inside.ok || inside.stdout.trim() !== 'true') return false;
  const probe = git(vault, ['check-ignore', '-q', '--no-index', `${BACKUP_DIR}/probe.json`], { allowFail: true });
  if (probe.ok || probe.code !== 1) return false;
  const where = git(vault, ['rev-parse', '--git-path', 'info/exclude'], { allowFail: true });
  if (!where.ok || !where.stdout.trim()) return false;
  const abs = path.resolve(vault, where.stdout.trim());
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    /* no exclude file yet */
  }
  writeAtomic(abs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}.memory-kit/\n`);
  return true;
}

/**
 * A config's text: {text} (null when there is no file) or {text: null, error} when the file
 * is there but cannot be read (no permission, a lock); exists tells the two apart.
 */
function readConfig(file, io) {
  if (!io.isFile(file)) return { text: null, exists: false };
  try {
    return { text: io.readText(file), exists: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { text: null, exists: false };
    return { text: null, exists: true, error: String(err?.code ?? err?.message ?? err) };
  }
}

/** The plan for a config connect cannot read: refused, with the entry to paste. */
function unreadablePlan({ row, name, built, error }) {
  const snippet = row.format === 'toml' ? tomlBlock(name, built.owned) : jsonSnippet(row.key, name, built.full);
  return { action: 'refused', reason: 'read', error, others: [], snippet, inside: false };
}

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function lastLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/** The action a result with several files reports: the strongest write, else unchanged, else absent. */
function pickOverall(actions) {
  for (const a of ['replace', 'update', 'add', 'remove', 'unchanged']) if (actions.includes(a)) return a;
  return actions[0] ?? 'absent';
}

// ---------------------------------------------------------------------------------------------
// connect <client>

/**
 * Connects (or with remove disconnects) one client. Prints nothing and returns the result:
 * {client, clientName, server, scope, method: file|cli|guidance, action, ok, exit, dryRun,
 * remove, entry, targets: [{path, format, exists, action, reason?, error?, backup?, created?,
 * written}], commands?, snippet?, messages}. reason of a refused target: read (the file cannot
 * be read), link (a symlink into a folder that does not exist), or what planJsonEdit and
 * planTomlEdit give. messages are the lines the command prints, in
 * order: {key, vars} or {raw} (a snippet to paste). action: add, update, replace, remove,
 * unchanged, absent, connected-as, guidance (exit 0), or conflict, refused, app-not-found,
 * not-vault, scope, changed, failed (exit 1).
 * opts: {client, vault, name, scope, readOnly, dryRun, remove, force} plus, for tests,
 * {platform, env, home, pathMod, io, execPath, now, spawn, findCli}.
 */
export function connectClient(opts) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const pathMod = opts.pathMod ?? (platform === process.platform ? path : pathModFor(platform));
  const io = opts.io ?? IO;
  const now = opts.now ?? new Date();
  const row = findClient(opts.client);
  if (!row) throw new Error(`unknown client: ${opts.client}`);
  if (!opts.vault) throw new Error('connectClient needs the vault folder');
  const name = opts.name ?? DEFAULT_NAME;
  const scope = opts.scope ?? 'user';
  const remove = Boolean(opts.remove);
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const res = {
    client: row.id, clientName: row.name, server: name, scope, method: row.guide ? 'guidance' : 'file',
    action: null, ok: true, exit: 0, dryRun, remove, entry: null, targets: [], messages: [],
  };
  const vars = { client: row.name, id: row.id, name };
  const msg = (key, extra = {}) => res.messages.push({ key, vars: { ...vars, ...extra } });
  const finish = (action) => {
    res.action = action;
    res.ok = !FAILS.has(action);
    res.exit = res.ok ? 0 : 1;
    return res;
  };

  const vault = io.realpath(opts.vault) ?? opts.vault;
  const liveArgs = serverArgs(vault, { readOnly: opts.readOnly, pathMod });
  const liveCommand = nodeCommand({ execPath: opts.execPath ?? process.execPath, platform });

  // Clients without a file to write: explain what works instead.
  if (row.guide) {
    msg(`connect.guide.${row.guide}`);
    if (row.guide === 'jetbrains') {
      res.snippet = jsonSnippet(['mcpServers'], name, buildEntry('junie', { command: liveCommand, args: liveArgs }).full);
      res.messages.push({ raw: res.snippet });
    }
    return finish('guidance');
  }

  const script = pathMod.join(vault, 'system', 'memory.mjs');
  if (!io.isFile(script)) {
    msg('connect.not_vault', { path: script });
    return finish('not-vault');
  }
  if (scope === 'project' && !row.project) {
    msg('connect.scope');
    return finish('scope');
  }
  const portable = scope === 'project';
  const built = buildEntry(row, portable
    ? { command: 'node', args: portableArgs({ readOnly: opts.readOnly }) }
    : { command: liveCommand, args: liveArgs });
  res.entry = remove ? null : built.full;
  const refs = vaultRefs(opts.vault, { platform, pathMod, realpath: (p) => io.realpath(p) });

  // Where the entry goes.
  let targets;
  let appFound = true;
  let appDir = null;
  if (portable) {
    const file = projectConfigPath(row, vault, { pathMod });
    targets = [{ path: file, role: 'project', exists: io.isFile(file) }];
  } else {
    const resolved = resolveClient(row.id, { platform, env, home, pathMod });
    const located = locateClient(resolved, { pathMod, platform, io });
    targets = located.targets;
    appFound = located.appFound;
    appDir = resolved.candidates.find((c) => c.path === targets[0].path)?.appDir ?? pathMod.dirname(targets[0].path);
    res.messages.push(...located.notes);
  }

  // Claude Code: its own command when it can do the job, the file otherwise.
  if (row.cli && !portable) {
    const cli = (opts.findCli ?? findExecutable)(row.cli, { platform, env, pathMod, io });
    const plan = cli ? planCli({ cli, row, name, built, refs, remove, force, file: targets[0].path, io, platform, env }) : null;
    if (plan && !plan.fallback) return runCli({ opts, res, row, cli, plan, refs, target: targets[0], msg, finish, platform, env, io, now, vault });
    if (cli) appFound = true;
    if (plan?.fallback === 'fields') msg('connect.cli.fields', { path: targets[0].path });
    else if (!remove) msg('connect.cli.fallback', { path: targets[0].path });
  }

  if (!appFound && !remove && !force) {
    msg('connect.app_missing', { dir: appDir, path: targets[0].path });
    res.targets = targets.map((t) => ({ path: t.path, format: row.format, exists: t.exists, action: 'app-not-found', written: false }));
    return finish('app-not-found');
  }

  // Plan every file first; nothing is written unless every file can be done.
  const plans = targets.map((t) => {
    const read = readConfig(t.path, io);
    if (read.error !== undefined) return { target: t, before: null, plan: unreadablePlan({ row, name, built, error: read.error }) };
    const before = read.text;
    const plan = row.format === 'toml'
      ? planTomlEdit(before, { name, built, refs, remove, force })
      : planJsonEdit(before, { key: row.key, name, built, refs, portable, remove, force });
    if (!WRITES.has(plan.action)) return { target: t, before, plan };
    // A config that is a symlink is written where the link leads, even when that file is
    // still to be made; the link itself stays.
    let dest;
    try {
      dest = writeTarget(t.path);
    } catch (err) {
      return { target: t, before, plan: unreadablePlan({ row, name, built, error: err.code ?? err.message }) };
    }
    if (dest !== t.path && !isDir(path.dirname(dest))) {
      return { target: t, before, plan: { action: 'refused', reason: 'link', link: dest, others: [] } };
    }
    return { target: t, before, plan, dest };
  });
  res.targets = plans.map(({ target, plan }) => ({
    path: target.path, format: row.format, exists: target.exists, action: plan.action,
    ...(plan.reason ? { reason: plan.reason } : {}), ...(plan.error ? { error: plan.error } : {}), written: false,
  }));

  const blocking = plans.find((p) => p.plan.action === 'refused' || p.plan.action === 'conflict');
  if (blocking) {
    reportBlock(blocking, { row, remove, msg, res });
    return finish(blocking.plan.action);
  }
  const connectedAs = plans.find((p) => p.plan.action === 'connected-as');
  if (connectedAs) {
    msg('connect.connected_as', { other: connectedAs.plan.others[0], path: connectedAs.target.path });
    return finish('connected-as');
  }

  const overall = pickOverall(plans.map((p) => p.plan.action));
  if (dryRun) {
    for (const { target, plan } of plans) {
      if (!WRITES.has(plan.action)) {
        reportQuiet(plan.action, plan.others, target.path, msg);
        continue;
      }
      msg(`connect.plan.${plan.action}`, { path: target.path });
      if (plan.entry) {
        res.messages.push({ raw: row.format === 'toml' ? tomlBlock(name, plan.entry).trimEnd() : jsonSnippet(row.key, name, plan.entry, { inside: true }) });
      }
    }
    if (plans.some((p) => WRITES.has(p.plan.action))) msg('connect.dry_run');
    return finish(overall);
  }

  // Apply: back up, then write each file that changes.
  let backedUp = false;
  for (let k = 0; k < plans.length; k++) {
    const { target, before, plan, dest } = plans[k];
    if (!WRITES.has(plan.action)) {
      reportQuiet(plan.action, plan.others, target.path, msg);
      continue;
    }
    // Another program may have changed the file (or taken away access to it) since the plan.
    const current = readConfig(target.path, io);
    if (current.error !== undefined || current.text !== before) {
      res.targets[k].action = 'changed';
      msg('connect.changed', { path: target.path });
      return finish('changed');
    }
    try {
      if (before !== null) {
        res.targets[k].backup = backupFile(vault, `${row.id}${portable ? '-project' : ''}`, target.path, now);
        backedUp = true;
      } else {
        res.targets[k].created = true;
      }
      writeConfig(dest, plan.text);
    } catch (err) {
      // Windows keeps a file locked while an app or a virus scanner holds it open.
      res.targets[k].action = 'failed';
      res.targets[k].error = err.code ?? err.message;
      msg('connect.write_failed', { path: target.path, detail: err.code ?? err.message });
      if (res.targets[k].backup) msg('connect.backup', { path: res.targets[k].backup });
      return finish('failed');
    }
    res.targets[k].written = true;
    msg(`connect.${DONE[plan.action]}`, { path: target.path });
    if (res.targets[k].backup) msg('connect.backup', { path: res.targets[k].backup });
    if (res.targets[k].created) msg(dest === target.path ? 'connect.new_file' : 'connect.new_file_link', { path: target.path, target: dest });
  }
  if (backedUp) {
    try {
      ensureIgnored(vault);
    } catch {
      /* a nicety: the backups work without it */
    }
  }
  const ignored = portable && WRITES.has(overall) && overall !== 'remove' && gitIgnores(vault, row.project);
  nextSteps({ res, row, action: overall, portable, ignored, viaCli: false, msg });
  return finish(overall);
}

/** unchanged, or absent (naming the entry that does serve this vault, if one does). */
function reportQuiet(action, others, file, msg) {
  if (action === 'absent' && others?.length) msg('connect.absent_other', { path: file, other: others[0] });
  else msg(`connect.${action}`, { path: file });
}

function reportBlock({ target, plan }, { row, remove, msg, res }) {
  const where = { path: target.path, key: row.key.join('.') };
  if (plan.action === 'conflict') {
    msg(remove ? 'connect.conflict_remove' : 'connect.conflict', where);
    return;
  }
  if (plan.reason === 'link') {
    msg('connect.dangling', { ...where, target: plan.link });
    return;
  }
  if (plan.reason === 'comments' && remove) {
    msg('connect.comments.remove', where);
    return;
  }
  if ((plan.reason === 'parse' || plan.reason === 'read') && remove) {
    msg('connect.unreadable_remove', { ...where, error: plan.error });
    return;
  }
  const key = {
    comments: plan.inside ? 'connect.comments.inside' : 'connect.comments.top',
    numbers: 'connect.numbers',
    parse: 'connect.unreadable',
    read: 'connect.unreadable',
    form: 'connect.toml_form',
  }[plan.reason] ?? 'connect.not_object';
  msg(key, { ...where, error: plan.error });
  if (plan.snippet && !remove) {
    res.snippet = plan.snippet;
    res.messages.push({ raw: plan.snippet });
  }
}

function nextSteps({ res, row, action, portable, ignored = false, viaCli, msg }) {
  if (action === 'remove') {
    msg('connect.next_remove');
    return;
  }
  if (!WRITES.has(action) && action !== 'unchanged') return;
  const textOf = (key) => ({ textKey: key, text: say(null, key, { name: res.server }) });
  if (WRITES.has(action)) {
    msg('connect.next', textOf(row.id === 'claude-code' && !viaCli ? 'connect.next.claude-code-file' : `connect.next.${row.id}`));
    if (portable) msg(ignored ? 'connect.project_ignored' : 'connect.project', { rel: row.project });
  }
  msg('connect.check', textOf(`connect.check.${row.id}`));
  if (WRITES.has(action)) msg('connect.try');
}

const CLI_FIELDS = new Set(['type', 'command', 'args', 'env']);

/**
 * What `claude mcp add|remove --scope user` has to do: {before, exists, planned, action, steps},
 * or {fallback} when the command cannot do it without loss: 'fields' (our entry holds settings
 * a remove and add would drop) or 'unsafe' (a value cmd.exe cannot pass on safely). A file
 * that cannot be read is refused here: the file path would fail to read it the same way.
 */
function planCli({ cli, row, name, built, refs, remove, force, file, io, platform, env }) {
  const read = readConfig(file, io);
  if (read.error !== undefined) {
    return { before: null, exists: true, planned: unreadablePlan({ row, name, built, error: read.error }), action: 'refused', steps: [] };
  }
  const before = read.text;
  const planned = planJsonEdit(before, { key: row.key, name, built, refs, remove, force });
  // The command writes the file itself, so comments or big numbers in it do not matter here,
  // and only command and args count: the tool may store the other fields its own way.
  let action = planned.action === 'refused' && planned.planned ? planned.planned : planned.action;
  const had = planned.existing;
  if (action === 'update' && had.command === built.owned.command && JSON.stringify(had.args) === JSON.stringify(built.owned.args)) {
    action = 'unchanged';
  }
  const steps = [];
  if (['update', 'replace', 'remove'].includes(action)) steps.push(claudeRemoveArgs(name));
  if (['add', 'update', 'replace'].includes(action)) {
    let keep = {};
    if (action === 'update') {
      if (Object.keys(had).some((k) => !CLI_FIELDS.has(k))) return { fallback: 'fields' };
      keep = had.env && typeof had.env === 'object' && !Array.isArray(had.env) ? had.env : {};
      if (Object.entries(keep).some(([k, v]) => typeof v !== 'string' || /[=\s]/.test(k))) return { fallback: 'fields' };
    }
    steps.push(claudeAddArgs(name, built.owned, { env: keep }));
  }
  if (steps.some((args) => !spawnSpec(cli, args, { platform, env }))) return { fallback: 'unsafe' };
  return { before, exists: read.exists, planned, action, steps };
}

/** Claude Code through its own command (the tool keeps its own file). */
function runCli({ opts, res, row, cli, plan, refs, target, msg, finish, platform, env, io, now, vault }) {
  res.method = 'cli';
  const name = res.server;
  const remove = res.remove;
  const { before, exists, planned, action, steps } = plan;
  res.targets = [{
    path: target.path, format: row.format, exists, action, written: false,
    ...(action === 'refused' ? { reason: planned.reason, error: planned.error } : {}),
  }];
  if (action === 'refused' || action === 'conflict') {
    reportBlock({ target, plan: planned }, { row, remove, msg, res });
    return finish(action);
  }
  if (action === 'connected-as') {
    msg('connect.connected_as', { other: planned.others[0], path: target.path });
    return finish(action);
  }
  if (action === 'unchanged' || action === 'absent') {
    reportQuiet(action, planned.others, target.path, msg);
    nextSteps({ res, row, action, portable: false, viaCli: true, msg });
    return finish(action);
  }

  res.commands = steps.map((args) => [row.cli, ...args]);
  if (res.dryRun) {
    msg(`connect.plan.${action}`, { path: target.path });
    for (const args of steps) msg('connect.cli.plan', { command: showCommand([row.cli, ...args]) });
    msg('connect.dry_run');
    return finish(action);
  }

  if (before !== null) {
    try {
      res.targets[0].backup = backupFile(vault, row.id, target.path, now);
    } catch (err) {
      msg('connect.write_failed', { path: pathOfBackups(vault), detail: err.code ?? err.message });
      return finish('failed');
    }
  }
  const spawn = opts.spawn ?? spawnSync;
  for (const args of steps) {
    const spec = spawnSpec(cli, args, { platform, env });
    const shown = showCommand([row.cli, ...args]);
    const ran = spawn(spec.command, spec.args, {
      ...spec.options, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: CLI_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    });
    if (ran.error || ran.status !== 0) {
      const detail = ran.error ? ran.error.code ?? ran.error.message : lastLine(ran.stderr) || lastLine(ran.stdout) || `exit ${ran.status}`;
      msg('connect.cli.failed', { command: shown, detail });
      if (res.targets[0].backup) msg('connect.backup', { path: res.targets[0].backup });
      return finish('failed');
    }
    msg('connect.cli.run', { command: shown });
  }
  res.targets[0].written = true;
  msg(`connect.${DONE[action]}`, { path: target.path });
  if (res.targets[0].backup) msg('connect.backup', { path: res.targets[0].backup });

  // Check what the command did: a change of its file's place would otherwise go unnoticed.
  let present = null;
  try {
    const after = readConfig(target.path, io);
    if (after.error === undefined) {
      present = after.text !== null && jsonEntries(after.text, row.key, row.id)
        .some((e) => e.scope === 'user' && e.name === name && entryTarget(e.entry, refs).kind === 'this');
    }
  } catch {
    present = null;
  }
  if (present === null || present === remove) msg('connect.cli.unverified', { path: target.path });
  if (res.targets[0].backup) {
    try {
      ensureIgnored(vault);
    } catch {
      /* a nicety */
    }
  }
  nextSteps({ res, row, action, portable: false, viaCli: true, msg });
  return finish(action);
}

// ---------------------------------------------------------------------------------------------
// connect --list

/** {vault, platform, clients: [inspectClients rows]} for a vault. */
export function listClients({ vault, platform, env, home, pathMod, io } = {}) {
  const clients = inspectClients({ vault, platform, env, home, pathMod, io });
  return { vault, platform: platform ?? process.platform, clients };
}

/** The human table of connect --list. */
export function formatList(list, cfg) {
  const rows = list.clients.map((c) => {
    const state = say(cfg, `connect.state.${c.state}`);
    let where = c.guide ? '–' : c.path ?? '–';
    const other = c.state !== 'connected' ? c.entries.find((e) => e.kind === 'kit' && e.root) : null;
    if (other) where += ` · ${say(cfg, 'connect.list.other', { root: other.root })}`;
    return { id: c.id, state, rest: `${c.name} · ${where}` };
  });
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const stateWidth = Math.max(...rows.map((r) => [...r.state].length));
  const lines = [say(cfg, 'connect.list.title', { vault: list.vault })];
  for (const r of rows) lines.push(`  ${r.id.padEnd(idWidth)}  ${r.state}${' '.repeat(stateWidth - [...r.state].length)}  ${r.rest}`);
  lines.push(say(cfg, 'connect.list.hint'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI

/** The printed lines of a connectClient result, in the vault's language. */
export function renderResult(res, cfg) {
  return res.messages.map((m) => {
    if (m.raw !== undefined) return m.raw;
    const v = { ...m.vars };
    if (v.textKey) v.text = say(cfg, v.textKey, v);
    return say(cfg, m.key, v);
  });
}

export async function run(argv, cfg, ctx) {
  if (argv.includes('--projects')) return (await import('../hooksetup.mjs')).runProjects(argv, cfg, ctx);
  const parsed = parseCli(argv, {
    scope: { type: 'string' },
    name: { type: 'string' },
    'read-only': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    remove: { type: 'boolean' },
    force: { type: 'boolean' },
    list: { type: 'boolean' },
    json: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  const vault = ctx?.root ?? cfg?.root;
  if (!vault) {
    usageError('no vault: pass --root <path>', usage);
    return 2;
  }
  const ids = CLIENTS.map((c) => c.id).join(', ');

  if (values.list) {
    const extra = ['scope', 'name', 'read-only', 'dry-run', 'remove', 'force'].find((k) => values[k] !== undefined);
    if (positionals.length || extra) {
      usageError(`--list takes no client and no option but --json (got ${positionals.length ? positionals[0] : `--${extra}`})`, usage);
      return 2;
    }
    const list = listClients({ vault: fs.existsSync(vault) ? fs.realpathSync.native(vault) : vault });
    process.stdout.write(values.json ? `${JSON.stringify(list, null, 2)}\n` : `${formatList(list, cfg)}\n`);
    return 0;
  }

  if (positionals.length !== 1) {
    usageError(positionals.length ? `one client at a time, got: ${positionals.join(' ')}` : `name a client: ${ids}`, usage);
    return 2;
  }
  const row = findClient(positionals[0]);
  if (!row) {
    usageError(`unknown client "${positionals[0]}"; known clients: ${ids}`, usage);
    return 2;
  }
  const scope = values.scope ?? 'user';
  if (scope !== 'user' && scope !== 'project') {
    usageError(`--scope must be user or project, got "${scope}"`, usage);
    return 2;
  }
  const name = values.name ?? DEFAULT_NAME;
  if (!NAME_RE.test(name)) {
    usageError(`--name takes letters, digits and hyphens only (at most 64, no underscore or dot), got "${name}"`, usage);
    return 2;
  }

  const res = connectClient({
    client: row.id, vault, name, scope, readOnly: values['read-only'] === true, dryRun: values['dry-run'] === true,
    remove: values.remove === true, force: values.force === true,
  });
  const lines = renderResult(res, cfg);
  if (values.json) {
    const { messages, exit, ...rest } = res;
    process.stdout.write(`${JSON.stringify({ ...rest, text: lines }, null, 2)}\n`);
  } else if (lines.length) {
    (res.ok ? process.stdout : process.stderr).write(`${lines.join('\n')}\n`);
  }
  return res.exit;
}
