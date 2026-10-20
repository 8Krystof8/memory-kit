// The report of one answer at Stop, for the owner (Claude Code shows it as a systemMessage, which
// costs the agent no tokens): which notes the answer opened and which it saved, counted from the
// transcript since the owner's last message: a note a tool call was given counts as used, a note
// named by a call or its result that changed since the owner's message as saved. Read-only; nothing
// here throws.

import fs from 'node:fs';
import { nameKey, noteFiles, readTranscript, toolTraces } from './citations.mjs';
import { ownerTexts } from './capture.mjs';

const SHOWN = 3;
// A path to a markdown file named in a tool call or result.
const FILE_RE = /[^\s"'`=:([\]]*\.md\b/giu;

/**
 * { read: [names], saved: [names] } of the answer to the owner's last message; null when there is
 * no transcript or the answer touched no note.
 */
export function turnReport(cfg, { transcript, files } = {}) {
  const { entries } = readTranscript(transcript);
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (ownerTexts(entries[i]).length) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const turn = entries.slice(start + 1);
  const since = Date.parse(entries[start]?.timestamp ?? '') || 0;
  const notes = files ?? noteFiles(cfg);
  // Only the notes count, not README.md or a file of the code repository with the same name: a
  // path read must go through a notes folder (sectors, inbox, journal in the vault's language).
  const kept = [cfg.dirs?.sectors ?? 'sectors', cfg.dirs?.inbox ?? 'inbox', cfg.dirs?.journal ?? 'journal'];
  const namedIn = (traces) => {
    const out = new Set();
    for (const trace of traces) {
      for (const [file] of trace.matchAll(FILE_RE)) {
        const parts = file.split(/[\\/]+/);
        const key = nameKey(parts.at(-1));
        if (notes.has(key) && parts.slice(0, -1).some((part) => kept.includes(part))) out.add(key);
      }
    }
    return out;
  };
  const changed = (key) => since > 0 && notes.get(key).some((abs) => {
    try {
      return fs.statSync(abs).mtimeMs > since;
    } catch {
      return false;
    }
  });
  // Saved: a note named by a tool call or its result (a write, the path remember printed) that
  // changed since the owner asked; a pull or a checkout changes files without naming them.
  const saved = new Set([...namedIn(toolTraces(turn))].filter(changed));
  // Used: a note a tool call was given (Read, cat, show), not one a search merely listed.
  const read = new Set([...namedIn(toolTraces(turn, { results: false }))].filter((key) => !saved.has(key)));
  if (!read.size && !saved.size) return null;
  return { read: [...read], saved: [...saved] };
}

/** The names of a list for one line: the first SHOWN, then "+n". */
export function shortList(names) {
  const shown = names.slice(0, SHOWN).join(', ');
  return names.length > SHOWN ? `${shown} +${names.length - SHOWN}` : shown;
}
