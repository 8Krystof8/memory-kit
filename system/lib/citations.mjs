// The check of the 📎 line at Stop: an answer that ends with `📎 memory: [[a]], [[b]]` (Czech
// `📎 z paměti:`) must name notes that exist and that the session read; `📎 saved: [[c]]` (Czech
// `📎 uloženo:`) must name a note that exists and changed during the session. Read-only and
// bounded: the transcript is read up to its last MAX_TRANSCRIPT bytes, the vault is walked for
// note file names only, and nothing here throws (a transcript that cannot be read checks nothing).
//
// What counts as read: the note's file (name.md) or its name after a memory command in a tool call
// of the session or in what a tool returned (Read, a shell command such as cat or sed, Grep, the
// evidence lines of a subagent, `memory.mjs show <name>`, an MCP memory_read), in the session's
// transcript or the transcripts of its subagents; and the notes the session start put into the
// context (seen). Claude Code and Codex transcripts are both understood: Claude Code "tool_use"
// and "tool_result" blocks, Codex "function_call", "custom_tool_call", "local_shell_call" and
// their outputs. When the transcript was too long to read whole, nothing is called unread.

import fs from 'node:fs';
import path from 'node:path';

const MAX_TRANSCRIPT = 16 * 1024 * 1024;
const MAX_SUBAGENT = 4 * 1024 * 1024;
const MAX_SUBAGENTS = 20;
const MAX_NAMES = 20;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.memory-kit', '_ai', 'system']);
const SAVED_LABELS = /^(saved|uloženo|ulozeno)\b/i;
const LINK_RE = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

/** The key a note name is compared by: the file name without .md and folders, NFC, lower case. */
export const nameKey = (name) => path.posix.basename(String(name).trim().replace(/\\/g, '/')).replace(/\.md$/i, '').normalize('NFC').toLowerCase();

/**
 * The last 📎 line of a text outside code (a fenced block or inline code): { kind: 'memory' |
 * 'saved', names } or null. The names are the link targets without a section or alias, at most
 * MAX_NAMES, each once.
 */
export function citeLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let fenced = false;
  let found = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const at = line.indexOf('📎');
    if (fenced || at < 0) continue;
    // Inside inline code: an odd number of backticks before it (a quoted example of the rule).
    if ((line.slice(0, at).match(/`/g) ?? []).length % 2 === 1) continue;
    const rest = line.slice(at + 2).replace(/^[\s*_]+/, '');
    const names = [...new Set([...rest.matchAll(LINK_RE)].map((m) => m[1].trim()).filter(Boolean))].slice(0, MAX_NAMES);
    if (names.length) found = { kind: SAVED_LABELS.test(rest) ? 'saved' : 'memory', names };
  }
  return found;
}

/** The last max bytes of a JSONL file: { entries, cut } (no entries when it cannot be read). */
export function readTranscript(file, max = MAX_TRANSCRIPT) {
  if (typeof file !== 'string' || !file) return { entries: [], cut: false };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    // A cut at the start leaves a partial first line.
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* a line still being written */
      }
    }
    return { entries, cut: len < size };
  } catch {
    return { entries: [], cut: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

/** The text an assistant line of the transcript says ('' for other lines). */
function assistantText(entry) {
  // Claude Code: {type: 'assistant', message: {role, content: [{type: 'text', text}]}}
  const msg = entry?.type === 'assistant' && isObj(entry.message) ? entry.message : null;
  if (msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  // Codex: {type: 'response_item', payload: {type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}}
  const p = entry?.type === 'response_item' && isObj(entry.payload) ? entry.payload : null;
  if (p?.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
    return p.content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

/** The text of the last assistant line that has some ('' when there is none). */
export function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = assistantText(entries[i]);
    if (text.trim()) return text;
  }
  return '';
}

/**
 * What the tool calls of the transcript were given and (results: true) what they returned, each
 * as one string.
 */
export function toolTraces(entries, { results = true } = {}) {
  const out = [];
  for (const e of entries) {
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    for (const b of content) {
      if (b?.type === 'tool_use') out.push(`${b.name ?? ''} ${str(b.input)}`);
      else if (b?.type === 'tool_result' && results) out.push(str(b.content));
    }
    const p = e?.type === 'response_item' && isObj(e.payload) ? e.payload : null;
    if (!p) continue;
    if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) out.push(`${p.name ?? ''} ${str(p.arguments ?? p.input ?? p.action)}`);
    else if (/_output$/.test(String(p.type)) && results) out.push(str(p.output));
  }
  return out;
}

/** The transcripts of the session's subagents (Claude Code: <dir>/<session id>/subagents/*.jsonl). */
function subagentTranscripts(transcript) {
  if (typeof transcript !== 'string' || !transcript.endsWith('.jsonl')) return [];
  const dir = path.join(transcript.slice(0, -'.jsonl'.length), 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).slice(0, MAX_SUBAGENTS).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Every note file of the vault and its local roots: name key → [absolute paths]. */
export function noteFiles(cfg) {
  const out = new Map();
  const roots = [cfg.root, ...(cfg.roots ?? []).filter((r) => r.id !== 'main' && !r.foreign && r.path).map((r) => r.path)];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const it of items) {
        if (it.isDirectory()) {
          if (!SKIP_DIRS.has(it.name) && !it.name.startsWith('.')) stack.push(path.join(dir, it.name));
        } else if (it.isFile() && it.name.endsWith('.md')) {
          const key = nameKey(it.name);
          if (!out.has(key)) out.set(key, []);
          out.get(key).push(path.join(dir, it.name));
        }
      }
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A test of a trace for the note: its file (name.md) or the name after a memory command. */
function namedBy(name) {
  const n = escapeRe(name);
  const file = new RegExp(`(^|[\\\\/\\s"'\`=:(\\[])${n}\\.md\\b`, 'iu');
  const command = new RegExp(`(memory\\.mjs\\s+(show|read)|memory_read)[^\\n]{0,200}?(^|[\\s"'\`:])${n}($|[\\s"'\`,}])`, 'iu');
  return (trace) => file.test(trace) || command.test(trace);
}

const mtimeOf = (abs) => {
  try {
    return fs.statSync(abs).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * The problems of the last answer's 📎 line: { kind, missing, unread, unsaved } (empty lists when
 * it is right), or null when there is no 📎 line to check. last is the answer's text when the
 * agent passes it (Claude Code and Codex send last_assistant_message); only without it is the
 * transcript's last answer taken. seen: absolute paths of notes the context already holds.
 */
export function checkCitations(cfg, { transcript, last, since = 0, seen = [], files } = {}) {
  const given = typeof last === 'string';
  let line = given ? citeLine(last) : null;
  if (given && !line) return null;
  const main = readTranscript(transcript);
  if (!given) line = citeLine(lastAssistantText(main.entries));
  if (!line) return null;
  const notes = files ?? noteFiles(cfg);
  const out = { kind: line.kind, missing: [], unread: [], unsaved: [] };
  let traces = null;
  const seenSet = new Set(seen.map((p) => path.resolve(p)));
  for (const name of line.names) {
    const paths = notes.get(nameKey(name)) ?? [];
    if (!paths.length) {
      out.missing.push(name);
      continue;
    }
    if (line.kind === 'saved') {
      if (Math.max(...paths.map(mtimeOf)) <= since) out.unsaved.push(name);
      continue;
    }
    if (paths.some((p) => seenSet.has(path.resolve(p)))) continue;
    // A transcript cut at the start may have lost the read: nothing is called unread then.
    if (main.cut) continue;
    traces ??= [...toolTraces(main.entries), ...subagentTranscripts(transcript).flatMap((f) => toolTraces(readTranscript(f, MAX_SUBAGENT).entries))];
    const test = namedBy(nameKey(name));
    if (!traces.some(test)) out.unread.push(name);
  }
  return out;
}

/** True when a result of checkCitations has something to fix. */
export const hasProblems = (r) => !!r && (r.missing.length + r.unread.length + r.unsaved.length) > 0;
