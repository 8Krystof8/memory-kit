// The check of the 📎 line at Stop: an answer that ends with `📎 memory: [[a]], [[b]]` (Czech
// `📎 z paměti:`) must name notes that exist and that the session read; `📎 saved: [[c]]` (Czech
// `📎 uloženo:`) must name a note that exists and changed during the session. Read-only and
// bounded: the transcript is read up to its last MAX_TRANSCRIPT bytes, the vault is walked for
// note file names only, and nothing here throws (a transcript that cannot be read checks nothing).
//
// What counts as read: a tool call of the session whose input names the note's file, by its name
// with ".md" or by the name alone in a memory command (Read, a shell command such as cat or
// sed, Grep with that path, `memory.mjs show <name>`, an MCP memory_read). Claude Code and Codex
// transcripts are both understood: Claude Code "tool_use" blocks, Codex "function_call",
// "custom_tool_call" and "local_shell_call" items.

import fs from 'node:fs';
import path from 'node:path';

const MAX_TRANSCRIPT = 16 * 1024 * 1024;
const MAX_NAMES = 20;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.memory-kit', '_ai', 'system']);
const SAVED_LABELS = /^(saved|uloženo|ulozeno)\b/i;
const LINK_RE = /\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

/**
 * The last 📎 line of a text: { kind: 'memory' | 'saved', names } or null. The names are the link
 * targets without a section or alias, at most MAX_NAMES, each once.
 */
export function citeLine(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf('📎');
    if (at < 0) continue;
    const rest = lines[i].slice(at + 2).replace(/^[\s*_`]+/, '');
    const names = [...new Set([...rest.matchAll(LINK_RE)].map((m) => m[1].trim()).filter(Boolean))].slice(0, MAX_NAMES);
    if (!names.length) return null;
    return { kind: SAVED_LABELS.test(rest) ? 'saved' : 'memory', names };
  }
  return null;
}

/** The last MAX_TRANSCRIPT bytes of a transcript as parsed JSON lines ([] when unreadable). */
export function readTranscript(file) {
  if (typeof file !== 'string' || !file) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, MAX_TRANSCRIPT);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    // A cut at the start leaves a partial first line.
    if (len < size) text = text.slice(text.indexOf('\n') + 1);
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* a line still being written */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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

/** The inputs of every tool call in the transcript, each as one string. */
export function toolInputs(entries) {
  const out = [];
  const str = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));
  for (const e of entries) {
    const content = e?.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : [];
    for (const b of content) if (b?.type === 'tool_use') out.push(`${b.name ?? ''} ${str(b.input)}`);
    const p = e?.type === 'response_item' && isObj(e.payload) ? e.payload : null;
    if (p && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      out.push(`${p.name ?? ''} ${str(p.arguments ?? p.input ?? p.action)}`);
    }
  }
  return out;
}

/** Every note file of the vault and its local roots: name (without .md) → absolute path. */
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
          const name = it.name.slice(0, -3);
          if (!out.has(name)) out.set(name, path.join(dir, it.name));
        }
      }
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when a tool input names the note: its file (name.md) or the name after a memory command. */
function names(input, name) {
  const n = escapeRe(name);
  if (new RegExp(`(^|[\\\\/\\s"'\`=:])${n}\\.md\\b`, 'i').test(input)) return true;
  return new RegExp(`(memory\\.mjs\\s+(show|read)|memory_read)[^\\n]{0,200}?(^|[\\s"'\`:])${n}($|[\\s"'\`,}])`, 'i').test(input);
}

/**
 * The problems of the last answer's 📎 line: { kind, missing, unread, unsaved } (empty lists when
 * it is right), or null when there is no 📎 line to check. last is the answer's text when the
 * agent passes it (Claude Code and Codex send last_assistant_message), else the transcript's.
 */
export function checkCitations(cfg, { transcript, last, since = 0, files } = {}) {
  const entries = readTranscript(transcript);
  const line = citeLine(typeof last === 'string' && last.includes('📎') ? last : lastAssistantText(entries));
  if (!line) return null;
  const notes = files ?? noteFiles(cfg);
  const inputs = toolInputs(entries);
  const out = { kind: line.kind, missing: [], unread: [], unsaved: [] };
  for (const name of line.names) {
    const abs = notes.get(name);
    if (!abs) {
      out.missing.push(name);
      continue;
    }
    if (line.kind === 'saved') {
      let mtime = 0;
      try {
        mtime = fs.statSync(abs).mtimeMs;
      } catch {
        /* gone since the walk */
      }
      if (mtime <= since) out.unsaved.push(name);
    } else if (!inputs.some((input) => names(input, name))) {
      out.unread.push(name);
    }
  }
  return out;
}

/** True when a result of checkCitations has something to fix. */
export const hasProblems = (r) => !!r && (r.missing.length + r.unread.length + r.unsaved.length) > 0;
