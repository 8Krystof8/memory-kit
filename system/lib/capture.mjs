// The capture check at Stop: when the owner said something in the session that reads like a
// decision, a correction or a lasting preference ("let's go with", "from now on", "that's wrong",
// Czech "rozhodli jsme", "od teď", "to je špatně") and no note of the memory changed since the
// session began, the agent is asked once to save it, or to finish when it was nothing to keep.
// Deterministic word lists in both languages, matched on folded text (lower case, no accents);
// read-only like lib/citations.mjs, and nothing here throws.

import fs from 'node:fs';
import path from 'node:path';
import { readTranscript, noteFiles } from './citations.mjs';
import { fold } from './text.mjs';

const MAX_QUOTE = 160;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Folded phrases: a decision, a correction of the agent, a lasting rule or preference. A bare
// "no, …" is an everyday answer, not a correction: those need a word that says wrong.
const SIGNALS = [
  // English
  /\b(we|i) (have )?decided (to|on|that)\b/, /\blet'?s go with\b/, /\b(we|i)'?ll go with\b/, /\bdecision:/, /\bfrom now on\b/,
  /\bgoing forward\b/, /\b(always|never) (use|do|write|call|put|run|commit|push)\b/, /\bdon'?t ever\b/, /\bdon'?t use \S+( \S+)? anymore\b/,
  /\bremember (that|this)\b/, /\bthat'?s (wrong|not right|incorrect|not true)\b/, /\bcorrection:/, /\bi prefer (to |that |\w+ over )/,
  // Czech
  /\brozhodl[ai]? (jsem|jsme)\b/, /\b(jsem|jsme) se rozhodl[ai]?\b/, /\brozhodnuti:/, /\bjdeme do toho\b/, /\bvybrali jsme\b/,
  /\b(od ted|od tedka|odted|odtedka|od dneska)\b(?! do\b)/, /\b(vzdycky|vzdy|nikdy|uz nikdy) (pouzivej|delej|pis|davej|pust|commituj|pushuj)\b/,
  /\bnepouzivej\b/, /\bbudeme pouzivat\b/, /\bzapamatuj si\b/, /\bpamatuj (si )?(ze|to)\b/,
  /\bto je (spatne|blbe|chybne)\b/, /\bto neni pravda\b/, /^spatne\b/, /\boprava:/, /\bradsi (pouzivej|delej|pis)\b/, /\bpreferuju\b/,
];

// Lines the harness or the agent's tools put on the owner's side of the transcript.
const INJECTED = /^(# AGENTS\.md instructions for|<)|<INSTRUCTIONS>|<user_instructions>/;

/**
 * The owner's own messages in a transcript (not tool results, not injected context, not a
 * compaction summary), only those written after `since` (ms) when the line carries a time.
 */
export function ownerMessages(entries, since = 0) {
  const out = [];
  const keep = (text, e) => {
    const t = String(text ?? '').trim();
    const at = Date.parse(e?.timestamp ?? '');
    if (t && !INJECTED.test(t) && !(at && at < since)) out.push(t);
  };
  for (const e of entries) {
    // Claude Code: {type: 'user', message: {role: 'user', content: string | [{type: 'text', text}]}}
    if (e?.type === 'user' && isObj(e.message) && !e.isMeta && !e.isSidechain && !e.isCompactSummary && !e.isVisibleInTranscriptOnly) {
      const c = e.message.content;
      if (typeof c === 'string') keep(c, e);
      else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') keep(b.text, e);
    }
    // Codex: {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}}
    const p = e?.type === 'response_item' && isObj(e.payload) ? e.payload : null;
    if (p?.type === 'message' && p.role === 'user' && Array.isArray(p.content)) for (const b of p.content) keep(b?.text, e);
  }
  return out;
}

/** The first sentence or line of an owner message that carries a signal (not a question), or ''. */
export function signalIn(text) {
  for (const piece of String(text).split(/\n+|(?<=[.!?])\s+/)) {
    const f = fold(piece).replace(/[‘’ʼ]/g, "'").trim();
    if (!f || f.endsWith('?')) continue;
    if (SIGNALS.some((re) => re.test(f))) return piece.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);
  }
  return '';
}

/**
 * { quote } when an owner message of the session carries a decision or correction and no note
 * changed since `since` (ms); null otherwise (also without a transcript to read).
 */
export function checkCapture(cfg, { transcript, since = 0, files } = {}) {
  const { entries } = readTranscript(transcript);
  let quote = '';
  for (const text of ownerMessages(entries, since)) quote = signalIn(text) || quote;
  if (!quote) return null;
  const notes = files ?? noteFiles(cfg);
  // Only notes count: generated views and hub files (home.md) change without anything saved.
  const kept = [cfg.dirs?.sectors ?? 'sectors', cfg.dirs?.inbox ?? 'inbox', cfg.dirs?.journal ?? 'journal'];
  const roots = [cfg.root, ...(cfg.roots ?? []).filter((r) => r.id !== 'main' && !r.foreign && r.path).map((r) => r.path)];
  const isNote = (abs) => roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && kept.includes(rel.split(path.sep)[0]);
  });
  for (const paths of notes.values()) {
    for (const abs of paths) {
      if (!isNote(abs)) continue;
      try {
        if (fs.statSync(abs).mtimeMs > since) return null;
      } catch {
        /* gone since the walk */
      }
    }
  }
  return { quote };
}
