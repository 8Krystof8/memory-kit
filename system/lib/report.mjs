// The report of one answer at Stop, for the owner (Claude Code shows it as a systemMessage, which
// costs the agent no tokens): which notes the answer opened and which it saved, counted from the
// transcript since the owner's last message (and the transcripts of its subagents): a note file a
// tool call was given counts as used, a note file named by a call or its result that changed
// since the owner's message as saved. A path counts only when it leads to a note of the vault or a
// local root: a file under sectors/, inbox/ or journal/ (their names in the vault's language).
// Read-only; nothing here throws.

import fs from 'node:fs';
import path from 'node:path';
import { readTranscript, subagentTranscripts, toolTraces } from './citations.mjs';
import { ownerTexts } from './capture.mjs';

const SHOWN = 3;
const MAX_SUBAGENT = 4 * 1024 * 1024;
// A path to a markdown file in a trace (after the escapes of JSON are undone).
const FILE_RE = /[^\s"'`=:(),[\]]*\.md\b/giu;

/** A trace as plain text: the escapes JSON.stringify left (\n, \t, \", \\) undone. */
const plain = (trace) => trace.replace(/\\[nrt]/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

/**
 * The roots of notes and a function from a path in a trace to the absolute note file it names
 * (null when it names none).
 */
function noteResolver(cfg) {
  const roots = [cfg.root, ...(cfg.roots ?? []).filter((r) => r.id !== 'main' && !r.foreign && r.path).map((r) => r.path)];
  const kept = [cfg.dirs?.sectors ?? 'sectors', cfg.dirs?.inbox ?? 'inbox', cfg.dirs?.journal ?? 'journal'];
  const inNotes = (abs) => roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && kept.includes(rel.split(path.sep)[0]);
  });
  const exists = (abs) => {
    try {
      return fs.statSync(abs).isFile();
    } catch {
      return false;
    }
  };
  return (file) => {
    const p = file.replace(/[\\/]+/g, path.sep);
    const candidates = path.isAbsolute(p) || /^[A-Za-z]:/.test(file) ? [path.resolve(p)]
      : roots.flatMap((root) => {
        // A path relative to the vault (sectors/…) or one remember prints for a local root (../private/sectors/…).
        const parts = p.split(path.sep);
        const at = parts.findIndex((part) => kept.includes(part));
        return at < 0 ? [] : [path.resolve(root, ...parts.slice(at)), path.resolve(cfg.root, p)];
      });
    return candidates.find((abs) => inNotes(abs) && exists(abs)) ?? null;
  };
}

/**
 * { read: [names], saved: [names] } of the answer to the owner's last message; null when there is
 * no transcript or the answer touched no note. Two notes of one name show their folder.
 */
export function turnReport(cfg, { transcript } = {}) {
  const { entries } = readTranscript(transcript);
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (ownerTexts(entries[i]).length) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const since = Date.parse(entries[start]?.timestamp ?? '') || 0;
  const after = (e) => !since || !(Date.parse(e?.timestamp ?? '') < since);
  const sub = since ? subagentTranscripts(transcript).flatMap((f) => readTranscript(f, MAX_SUBAGENT).entries.filter(after)) : [];
  const turn = [...entries.slice(start + 1), ...sub];
  const resolve = noteResolver(cfg);
  const filesIn = (traces) => {
    const out = new Set();
    for (const trace of traces) {
      for (const [file] of plain(trace).matchAll(FILE_RE)) {
        const abs = resolve(file);
        if (abs) out.add(abs);
      }
    }
    return out;
  };
  const changed = (abs) => {
    try {
      return since > 0 && fs.statSync(abs).mtimeMs > since;
    } catch {
      return false;
    }
  };
  // Saved: named by a call or its result (a write, the path remember printed) and changed since
  // the owner asked; a pull or a checkout changes files without naming them.
  const saved = [...filesIn(toolTraces(turn))].filter(changed);
  // Used: given to a tool call (Read, cat, show), not merely listed by a search.
  const read = [...filesIn(toolTraces(turn, { results: false }))].filter((abs) => !saved.includes(abs));
  if (!read.length && !saved.length) return null;
  const names = (list) => {
    const base = (abs) => path.basename(abs, '.md');
    return list.map((abs) => (list.filter((o) => base(o) === base(abs)).length > 1 ? `${path.basename(path.dirname(abs))}/${base(abs)}` : base(abs)));
  };
  return { read: names(read), saved: names(saved) };
}

/** The names of a list for one line: the first SHOWN, then "+n". */
export function shortList(names) {
  const shown = names.slice(0, SHOWN).join(', ');
  return names.length > SHOWN ? `${shown} +${names.length - SHOWN}` : shown;
}
