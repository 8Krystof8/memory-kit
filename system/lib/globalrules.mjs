// The rules block of `connect <agent> --rules`: a few lines in the agent's own global instructions
// (Claude Code ~/.claude/CLAUDE.md, Codex ~/.codex/AGENTS.md, Gemini CLI ~/.gemini/GEMINI.md) that
// make every session use this memory: load it, search it before answering about the past, save
// decisions right away, cite only notes it opened. The block sits between two marker lines and is
// the only part of the file memory-kit ever touches: everything else stays byte for byte. Pure
// functions; commands/connect.mjs reads, backs up and writes the file.

import os from 'node:os';
import path from 'node:path';
import { envGet } from './clients.mjs';

/** The agents whose global instructions file connect --rules writes, and the people's names. */
export const RULE_AGENTS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' });

export const BEGIN = '<!-- memory-kit:rules:start · maintained by memory-kit (connect --rules); edits inside are replaced -->';
export const END = '<!-- memory-kit:rules:end -->';
const BLOCK_RE = /<!-- memory-kit:rules:start[^\n]*-->\n[\s\S]*?<!-- memory-kit:rules:end -->\n?/;

/** The global instructions file of an agent. */
export function rulesFile(agent, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  if (agent === 'claude-code') return path.join(envGet(env, 'CLAUDE_CONFIG_DIR', platform) ?? path.join(home, '.claude'), 'CLAUDE.md');
  if (agent === 'codex') return path.join(envGet(env, 'CODEX_HOME', platform) ?? path.join(home, '.codex'), 'AGENTS.md');
  if (agent === 'gemini-cli') return path.join(home, '.gemini', 'GEMINI.md');
  return null;
}

const TEXT = {
  en: {
    title: '## Long-term memory: memory-kit',
    vault: 'The memory is the vault {vault}; the commands below run it.',
    start: 'At the start of a session, when "Memory: start" is not in your context yet, run `{cmd} start` (or call memory_start when its MCP server is connected).',
    search: 'Before you answer about earlier decisions, projects, people or preferences, search the memory (`{cmd} search "query"`, or memory_search) and read the notes it finds. Not found after a few tries: say "not in memory", never guess.',
    save: 'Save a decision, a correction by the owner, a dated fact or a lesson right away, in the owner\'s words: `{cmd} remember "…"` (in a project: `--type decision|gotcha|convention`).',
    cite: 'End an answer that notes shaped with `📎 memory: [[name]]`, after a write with `📎 saved: [[name]]`. Cite only notes you opened in this session.',
    one: 'Keep what you learn about the owner in this memory, not in another one.',
  },
  cs: {
    title: '## Dlouhodobá paměť: memory-kit',
    vault: 'Paměť je trezor {vault}; příkazy níže ji spouštějí.',
    start: 'Na začátku session, když v kontextu ještě není „Paměť: start“, spusť `{cmd} start` (nebo zavolej memory_start, když je připojený jeho MCP server).',
    search: 'Než odpovíš na otázku o dřívějších rozhodnutích, projektech, lidech nebo preferencích, prohledej paměť (`{cmd} search "dotaz"` nebo memory_search) a přečti nalezené poznámky. Když to ani na pár pokusů nenajdeš, řekni „v paměti není“, nikdy nehádej.',
    save: 'Rozhodnutí, opravu od majitele, datovaný fakt nebo poučení ulož hned, slovy majitele: `{cmd} remember "…"` (v projektu: `--type decision|gotcha|convention`).',
    cite: 'Odpověď, kterou ovlivnily poznámky, zakonči řádkem `📎 z paměti: [[nazev]]`, po zápisu `📎 uloženo: [[nazev]]`. Cituj jen poznámky, které jsi v této session otevřel.',
    one: 'Co se o majiteli dozvíš, drž v této paměti, ne v jiné.',
  },
};

/** The block for a vault: the marker lines around the rules in the vault's language. */
export function rulesBlock({ lang = 'en', vault, command }) {
  const t = TEXT[lang] ?? TEXT.en;
  const fill = (s) => s.replace(/\{vault\}/g, vault).replace(/\{cmd\}/g, command);
  return [BEGIN, t.title, '', fill(t.vault), '', ...['start', 'search', 'save', 'cite', 'one'].map((k) => `- ${fill(t[k])}`), END, ''].join('\n');
}

/**
 * The file's text with the block put in (block given) or taken out (null): { text, action } with
 * action 'add' (appended), 'update' (an older block replaced), 'unchanged', 'remove' or 'absent'.
 * Line ends follow the file (CRLF stays CRLF); a new block is set off by one empty line.
 */
export function applyRules(text, block) {
  const old = String(text ?? '');
  const crlf = /\r\n/.test(old);
  const lf = old.replace(/\r\n/g, '\n');
  const has = BLOCK_RE.test(lf);
  let next;
  let action;
  if (block === null) {
    if (!has) return { text: old, action: 'absent' };
    // The empty line the block was set off by goes with it.
    next = lf.replace(BLOCK_RE, '').replace(/\n+$/, '\n').replace(/^\n$/, '');
    action = 'remove';
  } else if (has) {
    next = lf.replace(BLOCK_RE, block);
    action = next === lf ? 'unchanged' : 'update';
  } else {
    const sep = !lf ? '' : lf.endsWith('\n\n') ? '' : lf.endsWith('\n') ? '\n' : '\n\n';
    next = `${lf}${sep}${block}`;
    action = 'add';
  }
  if (action === 'unchanged') return { text: old, action };
  return { text: crlf ? next.replace(/\n/g, '\r\n') : next, action };
}

/** The vault a block in the text names (the "{vault}" of its first line), or null. */
export function rulesVault(text) {
  const m = BLOCK_RE.exec(String(text ?? '').replace(/\r\n/g, '\n'));
  if (!m) return null;
  const v = /(?:vault|trezor) (.+?); /.exec(m[0]);
  return v ? v[1] : null;
}
