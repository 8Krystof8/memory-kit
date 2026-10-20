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

// Folded phrases: a decision, a correction of the agent, a lasting rule or preference.
const SIGNALS = [
  // English
  /\b(we|i) (have )?decided\b/, /\blet'?s go with\b/, /\b(we|i)'?ll go with\b/, /\bdecision:/, /\bfrom now on\b/,
  /\bgoing forward\b/, /\b(always|never) (use|do|write|call|put|run|commit|push)\b/, /\bdon'?t ever\b/, /\bremember (that|this)\b/,
  /\bthat'?s (wrong|not right|incorrect)\b/, /\bno, (it|that|we|you)\b/, /\bcorrection:/, /\bi prefer\b/,
  // Czech
  /\brozhodl[ai]? (jsem|jsme)\b/, /\brozhodnuti:/, /\bjdeme do toho\b/, /\bvybirame?\b/, /\bod ted\b/, /\bodted\b/, /\bod dneska\b/,
  /\b(vzdycky|vzdy|nikdy) (pouzivej|delej|pis|davej|pust|commituj|pushuj)\b/, /\bzapamatuj si\b/, /\bpamatuj (si )?(ze|to)\b/,
  /\bto je (spatne|blbe|chybne)\b/, /\bne, (to|tak|je|jsi)\b/, /\boprava:/, /\bradsi (pouzivej|delej|pis)\b/, /\bpreferuju\b/,
];

/** The owner's own messages in a transcript (not tool results, not injected context). */
export function ownerMessages(entries) {
  const out = [];
  const keep = (text) => {
    const t = String(text ?? '').trim();
    // Context the harness injects comes in angle-bracket tags (<command-…>, <environment_context>).
    if (t && !t.startsWith('<')) out.push(t);
  };
  for (const e of entries) {
    // Claude Code: {type: 'user', message: {role: 'user', content: string | [{type: 'text', text}]}}
    if (e?.type === 'user' && isObj(e.message) && !e.isMeta && !e.isSidechain) {
      const c = e.message.content;
      if (typeof c === 'string') keep(c);
      else if (Array.isArray(c)) for (const b of c) if (b?.type === 'text') keep(b.text);
    }
    // Codex: {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text}]}}
    const p = e?.type === 'response_item' && isObj(e.payload) ? e.payload : null;
    if (p?.type === 'message' && p.role === 'user' && Array.isArray(p.content)) for (const b of p.content) keep(b?.text);
  }
  return out;
}

/** The first sentence-sized piece of an owner message that carries a signal, or ''. */
export function signalIn(text) {
  for (const piece of String(text).split(/(?<=[.!?\n])\s+/)) {
    const f = fold(piece);
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
  for (const text of ownerMessages(entries)) quote = signalIn(text) || quote;
  if (!quote) return null;
  const notes = files ?? noteFiles(cfg);
  // Only notes count: generated views and hub files (home.md) change without anything saved.
  const kept = [cfg.dirs?.sectors ?? 'sectors', cfg.dirs?.inbox ?? 'inbox', cfg.dirs?.journal ?? 'journal'];
  const isNote = (abs) => abs.split(path.sep).some((part) => kept.includes(part));
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
