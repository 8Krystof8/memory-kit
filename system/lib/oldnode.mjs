// What memory.mjs does on a Node.js older than 22 for `hook <agent> <event>` (connect --projects
// installs those): an agent hook must never fail a session (Claude Code shows every non-zero exit
// as a hook error, on every turn), so the run ends quietly (exit 0, no output) and leaves the
// reason and its fix in the hook log (lib/hooklog.mjs), which doctor and the next session start
// on a newer Node.js show. It happens where a repository pins an older Node.js (nvm, fnm, volta,
// mise, asdf) and the hooks start the node on the PATH. Every other command still refuses such a
// Node.js. Kept to what old Node.js versions run, and loads no kit module but hooklog.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { logHook } from './hooklog.mjs';

const NEED = '22.5.0';
const AGENTS = ['claude-code', 'codex'];
const PROBE_ENV = 'MEMORY_KIT_PROBE'; // hookinput.PROBE_ENV: a run of doctor --probe logs nothing

// English defaults; packs may translate the same keys (section 4.10).
const OLDNODE_DEFAULTS = {
  'hook.old_node': 'the hook ran on Node.js {version} and did nothing: memory-kit needs {need} or newer (does the repository pin an older Node.js?)',
  'hook.old_node_fix': 'with Node.js {need} or newer, run node system/memory.mjs connect {agent} --projects: the hooks then start that Node.js by its full path',
};

/** The command line of a hook run ([--root <path>] hook <agent> <event>): {agent, event, root}, or null for another command. */
export function hookCall(argv, kitRoot) {
  let root = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') root = argv[++i] ?? null;
    else if (a.startsWith('--root=')) root = a.slice('--root='.length);
    else rest.push(a);
  }
  if (rest[0] !== 'hook') return null;
  return { agent: rest[1] ?? null, event: rest[2] ?? null, root: path.resolve(root ?? kitRoot) };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** A message in the vault's language (its kit pack), else the English default. */
function say(root, lang, key, vars) {
  const packed = typeof lang === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]+)?$/.test(lang) ? readJson(path.join(root, 'system', 'lang', lang, 'pack.json'))?.messages?.[key] : null;
  const text = typeof packed === 'string' && packed ? packed : OLDNODE_DEFAULTS[key];
  return text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));
}

/**
 * On a Node.js too old for the kit: true for a hook run, which memory.mjs then ends with exit 0,
 * after logging it (only when the vault's memory.json turns the project hooks on, as the hook
 * itself would, and never for a run of doctor --probe); false for every other command.
 */
export function quietHook(argv, { kitRoot, version = process.versions.node, env = process.env } = {}) {
  const call = hookCall(argv, kitRoot);
  if (!call) return false;
  if (env[PROBE_ENV] === '1') return true;
  const config = readJson(path.join(call.root, 'memory.json'));
  if (config?.projects?.enabled !== true || !AGENTS.includes(call.agent)) return true;
  const vars = { version, need: NEED, agent: call.agent };
  logHook(call.root, {
    agent: call.agent, event: typeof call.event === 'string' ? call.event : '?', ok: false,
    error: say(call.root, config.lang, 'hook.old_node', vars), fix: say(call.root, config.lang, 'hook.old_node_fix', vars),
  });
  return true;
}
