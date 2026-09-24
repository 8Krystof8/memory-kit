// The session start view as a pure function (docs/architecture.md, 10.4): the committed
// _ai/start.md when it is fresh, else a view rendered in memory. Writes nothing, runs no git and
// never throws: a view that cannot be built becomes the fallback (search protocol and rules), so a
// session never loses them. Used by commands/start.mjs, the JS API and the MCP server.
// Private content left in a local sector's main-root folder never reaches a view (see
// localFolderNotes in vault.mjs); the JS API applies the same rule to search and read.

import fs from 'node:fs';
import path from 'node:path';
import { verifyStamp } from './fingerprint.mjs';
import { buildContext, extractSearchBlock, renderStart } from './generate.mjs';
import { loadVault, localFolderNotes, withoutNotes } from './vault.mjs';
import { bytes, interpolate, normalizeText, readTextIfExists } from './util.mjs';

/** What `start --format` accepts. */
export const START_FORMATS = Object.freeze(['text', 'gemini-hook', 'json']);

/** Who reads the view: 'cli' (an agent with a shell) or 'mcp' (an app with the memory_* tools only). */
export const START_SURFACES = Object.freeze(['cli', 'mcp']);

// Used when memory.json cannot give a budget (the fallback path).
const DEFAULT_HOOK_BYTES = 9500;

// English defaults of the search rules for the MCP surface; packs may translate the same keys
// (section 4.10). They replace the shell-based search block of AGENTS.md, one numbered line each.
const DEFAULTS = {
  'start.mcp_rule_1': 'First `memory_search` with the key words: up to 5 hits. Then `memory_read` the best of them with `lines: 15`.',
  'start.mcp_rule_2': 'Exact name, number or ID: search for it as written. Words match by their start; accents are ignored.',
  'start.mcp_rule_3': 'Read the header, then only the section you need (`offset` and `lines: 60`). Whole notes only under 250 lines.',
  'start.mcp_rule_4': 'Valid = {status} {active} and the newer `{updated}`. Follow `{replaced_by}` to the valid version.',
  'start.mcp_rule_5': 'The archive, the inbox and sleeping sectors are left out: use `memory_search` with `all: true`.',
  'start.mcp_rule_6': 'When about 70% of hits point to one place, stop searching and work.',
  'start.mcp_rule_7': 'After 3 rephrasings, say "not in memory". Never guess.',
};

function say(cfg, key, vars = {}) {
  let text = null;
  try {
    text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : null;
  } catch {
    text = null;
  }
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(DEFAULTS[key] ?? key, vars);
}

/** The search rules of the MCP surface: the memory_* tools instead of shell commands. */
export function toolSearchBlock(cfg) {
  const word = (fn, fallback) => {
    try {
      return fn() || fallback;
    } catch {
      return fallback;
    }
  };
  const vars = {
    status: word(() => cfg.keys.status, 'status'),
    active: word(() => cfg.local('status', 'active'), 'active'),
    updated: word(() => cfg.keys.updated, 'updated'),
    replaced_by: word(() => cfg.keys.replaced_by, 'replaced_by'),
  };
  return Object.keys(DEFAULTS).map((key, i) => `${i + 1}. ${say(cfg, key, vars)}`).join('\n');
}

// ---------------------------------------------------------------------------------------------

/** Cuts text at a line boundary so that it fits maxBytes. */
export function capBytes(text, maxBytes) {
  if (bytes(text) <= maxBytes) return text;
  const lines = text.split('\n');
  let out = '';
  for (const line of lines) {
    const next = `${out}${line}\n`;
    if (bytes(next) > maxBytes) break;
    out = next;
  }
  return out;
}

/**
 * When the start view cannot be built, the session still gets the search protocol and the rules
 * (for surface 'mcp' the protocol of the memory_* tools).
 */
export function startFallback(cfg, err, { surface = 'cli' } = {}) {
  const t = (key, fallbackText) => {
    try {
      const out = cfg.t(key);
      return out && out !== key ? out : fallbackText;
    } catch {
      return fallbackText;
    }
  };
  const lines = [
    `# ${t('start.title', 'Memory: start')}`,
    `memory: start failed: ${err?.message ?? err}. Run node system/memory.mjs check.`,
  ];
  let block = null;
  try {
    block = surface === 'mcp'
      ? toolSearchBlock(cfg)
      : extractSearchBlock(readTextIfExists(path.join(cfg.root, cfg.files?.agents ?? 'AGENTS.md')));
  } catch {
    /* no AGENTS.md */
  }
  if (block) lines.push('', `## ${t('start.search', 'How to search')}`, block);
  const safety = Array.isArray(cfg?.startSafety) ? cfg.startSafety : [];
  if (safety.length) lines.push('', `## ${t('start.safety', 'Writing and safety')}`, ...safety);
  return `${lines.join('\n')}\n`;
}

/** The fallback view of an error: {text, stale, initialized, failed: true}. Never throws. */
export function failedStartView(cfg, err, { surface = 'cli' } = {}) {
  let text;
  try {
    text = startFallback(cfg, err, { surface });
  } catch {
    text = `memory: start failed: ${err?.message ?? err}. Run node system/memory.mjs check.\n`;
  }
  return {
    text: capBytes(text, cfg?.budgets?.hook_bytes ?? DEFAULT_HOOK_BYTES),
    stale: false,
    initialized: cfg?.initialized === true,
    failed: true,
  };
}

/**
 * Builds the start view: {text, stale, initialized, failed}. `stale` is true when the committed
 * _ai/start.md was missing or out of date and the view was rendered in memory (the text then ends
 * with the start.stale line). A non-empty `sectors` list always renders in memory and is never
 * stale. `today` must be undefined or a real YYYY-MM-DD date (else the fallback is returned).
 * `surface` 'mcp' puts the search rules of the memory_* tools in place of the shell-based block of
 * AGENTS.md; that view is always rendered in memory. So is a view of a vault with private content
 * left in a local sector's main-root folder: those notes are left out, whatever the committed file
 * holds (the LOCAL_IN_GIT alert still names their paths).
 */
export async function renderStartView(cfg, { sectors = [], today, surface = 'cli' } = {}) {
  try {
    const loaded = loadVault(cfg);
    const hidden = localFolderNotes(cfg, loaded);
    const vault = withoutNotes(loaded, hidden);
    const ctx = await buildContext(cfg, vault, { today });
    const view = surface === 'mcp' ? { ...ctx, searchBlock: toolSearchBlock(cfg) } : ctx;
    let text;
    let stale = false;
    if (sectors.length) {
      text = renderStart(cfg, vault, view, { sectors });
    } else {
      let committed = null;
      try {
        // A checkout with core.autocrlf and no eol=lf rule holds CRLF (maybe a BOM): same view.
        committed = normalizeText(fs.readFileSync(path.join(cfg.root, cfg.dirs.ai, 'start.md'), 'utf8')).text;
      } catch {
        /* not generated yet */
      }
      const v = committed === null ? null : verifyStamp(committed);
      const fresh = Boolean(v?.ok && v.header.source === ctx.source);
      if (fresh && view === ctx && !hidden.length) {
        text = committed;
      } else if (fresh) {
        text = renderStart(cfg, vault, view);
      } else {
        text = `${renderStart(cfg, vault, view)}${cfg.t('start.stale')}\n`;
        stale = true;
      }
    }
    if (!cfg.initialized) text = `${cfg.t('start.not_initialized')}\n${text}`;
    return { text: capBytes(text, cfg.budgets.hook_bytes), stale, initialized: cfg.initialized === true, failed: false };
  } catch (err) {
    return failedStartView(cfg, err, { surface });
  }
}

/** JSON text with every character outside ASCII written as \uXXXX (safe in any console code page). */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The bytes `start --format <format>` prints for a view: the text as is; 'json' the view object
 * (pretty, as every --json); 'gemini-hook' the SessionStart hook object of Gemini CLI on one line.
 */
export function formatStartView(view, format = 'text') {
  if (format === 'json') {
    const { text, stale, initialized, failed } = view;
    return `${JSON.stringify({ text, stale, initialized, failed }, null, 2)}\n`;
  }
  if (format === 'gemini-hook') {
    return `${asciiJson({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: view.text } })}\n`;
  }
  return view.text;
}
