#!/usr/bin/env node
// memory-kit CLI: node system/memory.mjs <command> [args] [--root <path>]
// Maps localized command, subcommand and flag aliases to canonical names, then runs
// system/lib/commands/<command>.mjs. Exit codes: 0 ok, 1 problem found, 2 usage, 3 internal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

installSqliteWarningFilter();

// A reader that closes the pipe early (`| head`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
  });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS = ['start', 'check', 'search', 'new', 'sector', 'sync', 'eval'];
const HELP = new Set(['help', '--help', '-h']);

/** Drops the ExperimentalWarning that node:sqlite prints; every other warning passes. */
function installSqliteWarningFilter() {
  const mark = Symbol.for('memory-kit.sqlite-warning-filter');
  if (process[mark]) return;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (String(text ?? '').includes('SQLite')) return undefined;
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
  const root = parsed.root ? path.resolve(parsed.root) : path.resolve(HERE, '..');
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
  if (command === 'sector' && rest.length && !rest[0].startsWith('-')) {
    rest[0] = cfg.subcommands.sector[rest[0]] ?? rest[0];
  }
  const mod = await importCommand(command);
  if (!mod || typeof mod.run !== 'function') {
    process.stderr.write(`memory: command "${command}" is not installed (system/lib/commands/${command}.mjs)\n`);
    return 3;
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`usage: node system/memory.mjs ${mod.usage ?? command}\n`);
    return 0;
  }
  return mod.run(rest, cfg);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  },
  (err) => {
    process.stderr.write(`memory: internal error: ${err?.message ?? err}\n`);
    if (process.env.MEMORY_DEBUG) process.stderr.write(`${err?.stack ?? ''}\n`);
    process.exitCode = 3;
  },
);
