// `connect claude-code|codex --projects`: installs the user-level hooks that give every coding
// project its memory (commands/hook.mjs). Claude Code reads ~/.claude/settings.json in the terminal,
// in VS Code and in JetBrains alike; the hooks use the exec form (command + args, no shell), so paths
// with spaces and Windows need no quoting. Other hooks and keys in the file are kept; a file that is
// not plain JSON (comments) is never rewritten: the snippet to paste is printed instead.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './fsafe.mjs';
import { nodeCommand } from './clients.mjs';
import { parseCli, usageError } from './util.mjs';

export const usage = 'connect claude-code|codex --projects [--remove] [--dry-run] [--no-autosync] [--json]';

const EVENTS = {
  'claude-code': [['SessionStart', 'session-start', 'startup|resume|clear|compact', 20], ['Stop', 'stop', null, 10],
    ['PostToolUseFailure', 'tool-failure', null, 5], ['SessionEnd', 'session-end', null, 2]],
  codex: [['SessionStart', 'session-start', null, 20], ['Stop', 'stop', null, 10]],
};

/** Where each agent keeps its user settings. */
export function settingsPath(agent, { env = process.env, home = os.homedir() } = {}) {
  if (agent === 'claude-code') return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json');
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'hooks.json');
}

const isOurs = (h, agent) => {
  const text = [h?.command, ...(Array.isArray(h?.args) ? h.args : [])].join(' ');
  return /memory\.mjs/.test(text) && new RegExp(`\\bhook\\b.*\\b${agent}\\b`).test(text);
};

function ourHook(agent, event, timeout, { node, script }) {
  if (agent === 'claude-code') return { type: 'command', command: node, args: [script, 'hook', agent, event], timeout };
  const q = (s) => `"${s.replace(/"/g, '\\"')}"`;
  return { type: 'command', command: `${q(node)} ${q(script)} hook ${agent} ${event}`, commandWindows: `& ${q(node)} ${q(script)} hook ${agent} ${event}`, timeout };
}

/** The settings object with our hooks added (or only removed with remove). Pure. */
export function planHooks(settings, agent, { node, script, remove = false }) {
  const out = structuredClone(settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {});
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const [name] of EVENTS[agent]) {
    const groups = Array.isArray(out.hooks[name]) ? out.hooks[name] : [];
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h, agent)) })).filter((g) => g.hooks.length);
    if (kept.length) out.hooks[name] = kept;
    else delete out.hooks[name];
  }
  if (!remove) {
    for (const [name, event, matcher, timeout] of EVENTS[agent]) {
      const group = { ...(matcher ? { matcher } : {}), hooks: [ourHook(agent, event, timeout, { node, script })] };
      out.hooks[name] = [...(out.hooks[name] ?? []), group];
    }
  }
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

/** memory.json with the projects settings switched on (other keys kept). */
function enableProjects(root, { autosync }) {
  const abs = path.join(root, 'memory.json');
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  j.projects = { auto_add: true, checkpoint: true, error_lookup: true, autosync, ...(j.projects ?? {}), ...(autosync === false ? { autosync: false } : {}) };
  if (j.projects.repos === undefined) j.projects.repos = {};
  writeAtomic(abs, `${JSON.stringify(j, null, 2)}\n`);
}

function hasRemote(root) {
  try {
    return /\[remote "/.test(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'));
  } catch {
    return false;
  }
}

export async function runProjects(argv, cfg, ctx) {
  const parsed = parseCli(argv.filter((a) => a !== '--projects'), {
    remove: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'no-autosync': { type: 'boolean' }, json: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  const agent = positionals[0];
  if (!EVENTS[agent]) {
    usageError(`--projects works with claude-code or codex (got ${agent ?? 'nothing'})`, usage);
    return 2;
  }
  const root = path.resolve(ctx?.root ?? cfg?.root);
  const file = settingsPath(agent);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  let settings = {};
  if (text.trim()) {
    try {
      settings = JSON.parse(text.replace(/^﻿/, ''));
    } catch {
      const snippet = JSON.stringify({ hooks: planHooks({}, agent, { node: nodeCommand(), script: path.join(root, 'system', 'memory.mjs') }).hooks }, null, 2);
      process.stderr.write(`memory: ${file} is not plain JSON (comments?), so it is left alone. Add these hooks yourself:\n${snippet}\n`);
      return 1;
    }
  }
  const next = planHooks(settings, agent, { node: nodeCommand(), script: path.join(root, 'system', 'memory.mjs'), remove: values.remove });
  const out = `${JSON.stringify(next, null, 2)}\n`;
  const autosync = values['no-autosync'] ? false : hasRemote(root);
  const cs = cfg?.lang === 'cs';
  if (values['dry-run']) {
    process.stdout.write(values.json ? `${JSON.stringify({ file, settings: next, autosync }, null, 2)}\n` : `${cs ? 'nanečisto, nic se nezměnilo' : 'dry run, nothing changed'}: ${file}\n${out}`);
    return 0;
  }
  if (out !== text) {
    if (text) {
      const backup = path.join(root, '.memory-kit', 'backups', 'connect', `${agent}-settings-${Date.now()}.json`);
      writeAtomic(backup, text, { mode: 0o600 });
    }
    writeAtomic(file, out);
  }
  if (!values.remove) enableProjects(root, { autosync });
  const lines = values.remove
    ? [cs ? `hooky paměti odebrány z ${file}` : `memory hooks removed from ${file}`]
    : cs
      ? [`hooky paměti jsou v ${file}`, 'Každý projekt teď dostane vlastní sektor dev v této paměti; do repa s kódem se nic nezapisuje.',
        autosync ? 'Na konci session se paměť sama commitne a pushne.' : 'Automatický push je vypnutý (paměť nemá remote nebo --no-autosync).',
        agent === 'claude-code' ? 'Platí pro Claude Code v terminálu i ve VS Code. Otevři novou session v libovolném projektu.' : 'Otevři novou session Codexu v libovolném projektu.']
      : [`memory hooks are in ${file}`, 'Every project now gets its own dev sector in this memory; nothing is written into the code repository.',
        autosync ? 'At the end of a session the memory commits and pushes itself.' : 'Automatic push is off (no remote, or --no-autosync).',
        agent === 'claude-code' ? 'Works for Claude Code in the terminal and in VS Code. Open a new session in any project.' : 'Open a new Codex session in any project.'];
  process.stdout.write(values.json ? `${JSON.stringify({ file, removed: Boolean(values.remove), autosync }, null, 2)}\n` : `${lines.join('\n')}\n`);
  return 0;
}
