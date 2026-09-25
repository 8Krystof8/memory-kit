#!/usr/bin/env node
// memory-kit CLI: node system/memory.mjs <command> [args] [--root <path>]
// Maps localized command, subcommand and flag aliases to canonical names, then runs
// system/lib/commands/<command>.mjs. Exit codes: 0 ok, 1 problem found, 2 usage, 3 internal.
// Every command module exports `usage` and `run(argv, cfg, ctx)`; ctx is
// { root, kitRoot, configError }. Commands in CONFIGLESS also run when memory.json or a
// pack cannot be loaded; they then get cfg = null and must read what they need themselves.
// Their localized names and flags still work then: the aliases of every readable pack apply.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) {
  // An agent hook must not fail a session: it logs the problem and ends quietly (lib/oldnode.mjs).
  const { quietHook } = await import('./lib/oldnode.mjs');
  if (quietHook(process.argv.slice(2), { kitRoot: fileURLToPath(new URL('..', import.meta.url)) })) process.exit(0);
  process.stderr.write(`memory: Node.js 22 or newer is required (this is ${process.version})\n`);
  process.exit(3);
}

installSqliteWarningFilter();

// A reader that closes the pipe early (`| head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = ['start', 'check', 'search', 'new', 'sector', 'sync', 'eval', 'doctor', 'upgrade', 'connect', 'mcp', 'remember', 'project', 'hook'];
const CONFIGLESS = new Set(['doctor', 'upgrade', 'mcp', 'hook']);
const HOOK_AGENTS = new Set(['claude-code', 'codex']);
const HELP = new Set(['help', '--help', '-h']);

/** Drops only the ExperimentalWarning that node:sqlite prints on Node 22; every other warning passes. */
function installSqliteWarningFilter() {
  const mark = Symbol.for('memory-kit.sqlite-warning-filter');
  if (process[mark]) return;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = String((typeof warning === 'string' ? warning : warning?.message) ?? '');
    const opt = rest[0];
    const type = typeof opt === 'string' ? opt : opt?.type ?? (typeof warning === 'object' ? warning?.name : undefined);
    if (type === 'ExperimentalWarning' && text.startsWith('SQLite')) return undefined;
    return original.call(process, warning, ...rest);
  };
  process[mark] = true;
}

function takeRoot(argv) {
  const rest = [];
  let root = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--root') {
      if (argv[i + 1] === undefined) throw new UsageError('--root needs a path');
      root = argv[++i];
    } else if (a.startsWith('--root=')) {
      root = a.slice('--root='.length);
    } else {
      rest.push(a);
    }
  }
  return { root, rest };
}

class UsageError extends Error {}

function mapFlags(cfg, args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq < 0 ? a : a.slice(0, eq);
    const mapped = cfg.flags[name] ?? name;
    out.push(eq < 0 ? mapped : mapped + a.slice(eq));
  }
  return out;
}

/**
 * Command and flag aliases of every pack that can be read, first one wins (sorted by code), for
 * when memory.json cannot say which language applies. A broken pack is skipped.
 */
function fallbackAliases(root) {
  const commands = {};
  const flags = {};
  const dashed = (flag) => (flag.startsWith('--') ? flag : `--${flag.replace(/^-+/, '')}`);
  for (const dir of new Set([path.join(root, 'system', 'lang'), path.join(HERE, 'lang')])) {
    let codes;
    try {
      codes = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const code of codes) {
      let pack;
      try {
        pack = JSON.parse(fs.readFileSync(path.join(dir, code, 'pack.json'), 'utf8'));
      } catch {
        continue;
      }
      for (const [table, out, form] of [[pack?.commands, commands, String], [pack?.flags, flags, dashed]]) {
        if (!table || typeof table !== 'object' || Array.isArray(table)) continue;
        for (const [alias, canon] of Object.entries(table)) {
          if (!alias || typeof canon !== 'string' || !canon || Object.hasOwn(out, form(alias))) continue;
          out[form(alias)] = form(canon);
        }
      }
    }
  }
  return { commands, flags };
}

async function importCommand(name) {
  const file = path.join(HERE, 'lib', 'commands', `${name}.mjs`);
  if (!fs.existsSync(file)) return null;
  return import(pathToFileURL(file).href);
}

async function printHelp(cfg, stream = process.stdout) {
  const lines = ['usage:'];
  for (const name of COMMANDS) {
    let mod = null;
    try {
      mod = await importCommand(name);
    } catch {
      mod = null;
    }
    if (!mod?.usage) continue;
    const localized = cfg ? cfg.t(`usage.${name}`) : `usage.${name}`;
    const text = localized !== `usage.${name}` ? localized : mod.usage;
    lines.push(`  node system/memory.mjs ${text.startsWith(name) ? text : `${name} ${text}`}`);
  }
  lines.push('  node system/memory.mjs help | --version', '  every command accepts --root <path>');
  if (cfg && Object.keys(cfg.commands).length) {
    const aliases = Object.entries(cfg.commands).map(([a, c]) => `${a}=${c}`).join(', ');
    lines.push(`aliases (${cfg.lang}): ${aliases}`);
  }
  stream.write(lines.join('\n') + '\n');
}

async function main(argv) {
  let parsed;
  try {
    parsed = takeRoot(argv);
  } catch (err) {
    process.stderr.write(`memory: ${err.message}\n`);
    return 2;
  }
  const kitRoot = path.resolve(HERE, '..');
  const root = parsed.root ? path.resolve(parsed.root) : kitRoot;
  const args = parsed.rest;
  const first = args[0];

  if (first === '--version' || first === '-v') {
    let version = '0.0.0';
    try {
      version = fs.readFileSync(path.join(root, 'system', 'VERSION'), 'utf8').trim() || version;
    } catch {
      /* keep default */
    }
    process.stdout.write(`${version}\n`);
    return 0;
  }

  // Most failed commands of an agent can have no error lookup: those hook runs end here, before
  // the config and the language packs load (the agent waits for the hook after each failure).
  let hookCtx = {};
  if (first === 'hook' && args[2] === 'tool-failure' && HOOK_AGENTS.has(args[1])) {
    const early = await earlyToolFailure(root, args[1]);
    if (early.done) return 0;
    hookCtx = early.ctx;
  }

  const { loadConfig, ConfigError } = await import('./lib/config.mjs');
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    if (first === undefined || HELP.has(first)) {
      await printHelp(null);
      return 0;
    }
    // The language is unknown without memory.json, so the aliases of every pack apply.
    const aliases = fallbackAliases(root);
    const command = Object.hasOwn(aliases.commands, first) ? aliases.commands[first] : first;
    if (command === 'help') {
      await printHelp(null);
      return 0;
    }
    if (CONFIGLESS.has(command)) {
      return runCommand(command, mapFlags(aliases, args.slice(1)), null, { root, kitRoot, configError: err });
    }
    process.stderr.write(`memory: config error: ${err.message}\n`);
    return 3;
  }

  const command = first === undefined ? 'help' : cfg.commands[first] ?? first;
  if (command === 'help' || HELP.has(command)) {
    await printHelp(cfg);
    return 0;
  }
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`memory: unknown command "${first}"\n`);
    await printHelp(cfg, process.stderr);
    return 2;
  }

  const rest = mapFlags(cfg, args.slice(1));
  if ((command === 'sector' || command === 'project') && rest.length && !rest[0].startsWith('-')) {
    const table = cfg.subcommands[command] ?? cfg.pack?.subcommands?.[command];
    if (table && typeof table === 'object' && Object.hasOwn(table, rest[0]) && typeof table[rest[0]] === 'string') rest[0] = table[rest[0]];
  }
  return runCommand(command, rest, cfg, { root, kitRoot, configError: null, ...hookCtx });
}

/**
 * The cheap part of `hook <agent> tool-failure`: memory.json read directly, the hook input read
 * and filtered. { done: true } when nothing more is to be done (the run is logged when the
 * project hooks are on); else { done: false, ctx } with the input for commands/hook.mjs. A
 * memory.json this cannot read goes the full way, where the config loader decides and logs.
 */
async function earlyToolFailure(root, agent) {
  const started = performance.now();
  const hi = await import('./lib/hookinput.mjs');
  const projects = hi.rawProjects(root);
  if (projects === null) return { done: false, ctx: {} };
  if (projects.enabled !== true) return { done: true };
  const input = await hi.readHookInput();
  // A session the session start saw outside any known project has nothing to look up in.
  const outside = hi.readSessionFile(root, input.session_id)?.sector === null;
  if (projects.error_lookup !== false && !outside && hi.lookupCandidate(input)) return { done: false, ctx: { hookInput: input, hookStarted: started } };
  const { logHook } = await import('./lib/hooklog.mjs');
  logHook(root, { agent, event: 'tool-failure', ok: true, ms: Math.round(performance.now() - started) });
  return { done: true };
}

async function runCommand(command, rest, cfg, ctx) {
  const mod = await importCommand(command);
  if (!mod || typeof mod.run !== 'function') {
    process.stderr.write(`memory: command "${command}" is not installed (system/lib/commands/${command}.mjs)\n`);
    await printRecovery(ctx.root);
    return 3;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`usage: node system/memory.mjs ${mod.usage ?? command}\n`);
    return 0;
  }
  return mod.run(rest, cfg, ctx);
}

/** A path or argument as a shell user would type it (display only). */
function shellArg(s) {
  const t = String(s);
  return /^[\w@%+=:,./\\-]+$/.test(t) ? t : `"${t.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * When an upgrade stopped half way (its lock is still there), the kit files may be half replaced,
 * which is a likely reason for a crash: says how to undo it with the upgrader kept in its backup,
 * which needs none of the vault's code. An upgrade still at work is left alone. Reads the lock
 * by itself (the upgrade module may be one of the broken files) and never throws.
 */
async function printRecovery(root) {
  try {
    const lockFile = path.join(root, '.memory-kit', 'upgrade.lock');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const rel = typeof lock?.recover === 'string' ? lock.recover : '';
    const parts = rel.split('/');
    if (!/^\.memory-kit\/backups\/[^/]+\/tool\/rollback\.mjs$/.test(rel) || parts.includes('..')) return;
    const tool = path.join(root, ...parts);
    if (!fs.statSync(tool).isFile()) return;
    if (lock.pid !== process.pid && await upgradeRunning(lock, fs.statSync(lockFile).mtimeMs)) {
      process.stderr.write(`memory: an upgrade is running right now (process ${lock.pid}); wait for it to finish, then run the command again\n`);
      return;
    }
    const fromHere = path.relative(process.cwd(), tool);
    const shown = fromHere && !fromHere.startsWith('..') && !path.isAbsolute(fromHere) ? fromHere.split(path.sep).join('/') : tool;
    process.stderr.write(`memory: the upgrade stopped before it finished; undo it with: node ${shellArg(shown)}\n`);
  } catch {
    /* no lock, or none that names its recovery tool */
  }
}

/** The running test of the upgrade lock, shared with lib/upgrade.mjs; unknown counts as not running. */
async function upgradeRunning(lock, mtimeMs) {
  try {
    const { upgradeRunning: running } = await import('./lib/lockcheck.mjs');
    return running(lock, mtimeMs);
  } catch {
    return false;
  }
}

/** The vault root of argv (--root), for the error handler. */
function rootOf(argv) {
  try {
    const { root } = takeRoot(argv);
    return root ? path.resolve(root) : path.resolve(HERE, '..');
  } catch {
    return path.resolve(HERE, '..');
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  },
  async (err) => {
    process.stderr.write(`memory: internal error: ${err?.message ?? err}\n`);
    if (process.env.MEMORY_DEBUG) process.stderr.write(`${err?.stack ?? ''}\n`);
    process.exitCode = 3;
    await printRecovery(rootOf(process.argv.slice(2)));
  },
);
