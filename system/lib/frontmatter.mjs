// A small, never-throwing parser for the YAML subset notes use (docs/architecture.md, 5.1 and 7.3):
// `key: scalar`, `key: [flow, list]`, `key:` followed by `- item` lines, blank lines and comments.

// Any key up to the first ': ' (letters with diacritics and spaces too: "due date", "poznámka").
// Canonical keys stay ASCII; a key may not start with a YAML indicator or a space.
const KEY_LINE = /^([^\s:#'"\-?[\]{},&*!|>%@`][^:]*?):(?:[ \t]+(.*?))?[ \t]*$/u;
const LIST_ITEM = /^([ \t]*)-(?:[ \t]+(.*?))?[ \t]*$/;
const COMMENT = /^[ \t]*#/;
const INT = /^-?\d+$/;
const NUMBER_LIKE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$|^0x[0-9a-fA-F]+$|^0o[0-7]+$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/;
const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', '~', 'on', 'off', 'y', 'n']);
const SPECIAL_START = new Set([...'[]{},&*!|>\'"%@`#-?:']);

// ---------------------------------------------------------------------------------------------
// Scalars

/** Strips a trailing ' # comment' from a plain scalar. */
function stripComment(s) {
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

function parseDoubleQuoted(s) {
  // s starts with '"'. Returns {value, rest} or null when unclosed.
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) return null;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next === '"' ? '"' : next === '\\' ? '\\' : next;
      i++;
    } else if (ch === '"') {
      return { value: out, rest: s.slice(i + 1) };
    } else {
      out += ch;
    }
  }
  return null;
}

function parseSingleQuoted(s) {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
      } else {
        return { value: out, rest: s.slice(i + 1) };
      }
    } else {
      out += ch;
    }
  }
  return null;
}

/** Parses one scalar. Returns {value} or {error} (never throws). */
function parseScalar(text) {
  const s = text.trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s.startsWith('"') ? parseDoubleQuoted(s) : parseSingleQuoted(s);
    if (!q) return { error: 'unclosed quote' };
    const rest = q.rest.trim();
    if (rest !== '' && !rest.startsWith('#')) return { error: 'text after closing quote' };
    return { value: q.value };
  }
  const plain = stripComment(s);
  if (plain === '') return { value: null };
  if (plain === 'true') return { value: true };
  if (plain === 'false') return { value: false };
  if (plain === 'null' || plain === '~') return { value: null };
  if (INT.test(plain)) {
    const n = Number(plain);
    return Number.isSafeInteger(n) ? { value: n } : { value: plain };
  }
  const c = plain[0];
  if (c === '&' || c === '*' || c === '!' || c === '{' || c === '|' || c === '>') {
    return { error: `unsupported YAML (${c === '|' || c === '>' ? 'block scalar' : c === '{' ? 'flow map' : 'anchor, alias or tag'})` };
  }
  // What real YAML parsers (and every tool that shows properties) reject: put such values in quotes.
  if (c === '@' || c === '`' || c === '%' || c === ',' || c === ']' || c === '}') {
    return { error: `a value starting with ${c} must be in quotes` };
  }
  if ((c === '-' || c === '?' || c === ':') && (plain.length === 1 || plain[1] === ' ' || plain[1] === '\t')) {
    return { error: `a value starting with "${c} " must be in quotes` };
  }
  if (/:[ \t]/.test(plain) || plain.endsWith(':')) return { error: 'a value containing ": " must be in quotes' };
  return { value: plain };
}

/** Splits the inside of a flow list on commas outside quotes. */
function splitFlow(inner) {
  const items = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') {
        cur += inner[i + 1] ?? '';
        i++;
      } else if (ch === quote) {
        if (quote === "'" && inner[i + 1] === "'") {
          cur += "'";
          i++;
        } else {
          quote = null;
        }
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      items.push(cur);
      cur = '';
    } else if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      return { error: 'nested collections are not supported' };
    } else {
      cur += ch;
    }
  }
  if (quote) return { error: 'unclosed quote' };
  items.push(cur);
  return { items };
}

/** Parses the value part of `key: value`. Returns {value} or {error}. */
function parseValue(text) {
  const s = text.trim();
  if (s.startsWith('[')) {
    // Find the closing bracket outside quotes; allow a trailing comment after it.
    let quote = null;
    let end = -1;
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (quote === '"' && ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ']') {
        end = i;
        break;
      } else if (ch === '[') {
        return { error: 'nested collections are not supported' };
      }
    }
    if (end < 0) return { error: 'unclosed flow list' };
    const rest = s.slice(end + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) return { error: 'text after flow list' };
    const inner = s.slice(1, end);
    if (inner.trim() === '') return { value: [] };
    const split = splitFlow(inner);
    if (split.error) return split;
    const out = [];
    for (const [i, item] of split.items.entries()) {
      if (item.trim() === '') {
        if (i === split.items.length - 1) continue; // trailing comma
        return { error: 'empty flow list item' };
      }
      const v = parseScalar(item);
      if (v.error) return v;
      out.push(v.value);
    }
    return { value: out };
  }
  return parseScalar(s);
}

// ---------------------------------------------------------------------------------------------
// Parser

/**
 * Parses frontmatter. Never throws. Line numbers are 1-based file lines.
 * Extra field `spans` ({key: [firstLine, lastLine]}) lets updateFrontmatter replace a key in place.
 */
export function parse(input) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.includes('\r\n')) text = text.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const none = (errors = []) => ({
    has: false, data: {}, raw: '', body: text, endLine: 0, bodyStartLine: 1, errors, keyLines: {}, spans: {},
  });
  if (lines[0] !== '---') return none();
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return none([{ line: 1, msg: 'unclosed frontmatter' }]);

  const data = {};
  const errors = [];
  const keyLines = {};
  const spans = {};
  let listKey = null; // key whose value may continue as a block list / raw block
  let rawBlock = null; // {key, lines} for unsupported indented content

  const flushRaw = () => {
    if (rawBlock && rawBlock.lines.length > 0) data[rawBlock.key] = rawBlock.lines.join('\n');
    rawBlock = null;
  };

  for (let i = 1; i < end; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.trim() === '' || COMMENT.test(line)) continue;

    const item = LIST_ITEM.exec(line);
    const indented = /^[ \t]/.test(line);
    if (item && listKey && !rawBlock) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      spans[listKey][1] = lineNo;
      const v = parseScalar(item[2] ?? '');
      if (v.error) {
        errors.push({ line: lineNo, msg: `${listKey}: ${v.error}` });
        data[listKey].push((item[2] ?? '').trim());
      } else if (v.value !== null) {
        data[listKey].push(v.value);
      }
      continue;
    }
    if (indented && listKey) {
      // Nested map or block scalar content under the current key: keep it raw.
      if (!rawBlock) {
        rawBlock = { key: listKey, lines: [] };
        if (!errors.some((e) => e.line === keyLines[listKey])) {
          errors.push({ line: lineNo, msg: `${listKey}: nested maps and multi-line values are not supported` });
        }
      }
      rawBlock.lines.push(line.trim());
      spans[listKey][1] = lineNo;
      continue;
    }

    flushRaw();
    listKey = null;
    const m = KEY_LINE.exec(line);
    if (!m || indented) {
      errors.push({ line: lineNo, msg: `unsupported line "${line.trim().slice(0, 40)}"` });
      continue;
    }
    const key = m[1].trim();
    const valueText = m[2] ?? '';
    if (Object.hasOwn(data, key)) errors.push({ line: lineNo, msg: `duplicate key ${key}` });
    keyLines[key] = lineNo;
    spans[key] = [lineNo, lineNo];

    if (stripComment(valueText) === '' && !/^["']/.test(valueText.trim())) {
      data[key] = null;
      listKey = key;
      continue;
    }
    const v = parseValue(valueText);
    if (v.error) {
      errors.push({ line: lineNo, msg: `${key}: ${v.error}` });
      data[key] = valueText.trim();
      if (/^[|>]/.test(valueText.trim())) {
        listKey = key; // swallow the block lines that follow
        rawBlock = { key, lines: [] };
      }
    } else {
      data[key] = v.value;
    }
  }
  flushRaw();

  return {
    has: true,
    data,
    raw: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
    endLine: end + 1,
    bodyStartLine: end + 2,
    errors,
    keyLines,
    spans,
  };
}

// ---------------------------------------------------------------------------------------------
// Writer

function needsQuotes(s, inFlow) {
  if (s === '') return true;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return true;
  if (/[\n\t\r]/.test(s)) return true;
  if (SPECIAL_START.has(s[0]) || s[0] === ' ' || s.endsWith(' ')) return true;
  if (RESERVED.has(s.toLowerCase())) return true;
  if (NUMBER_LIKE.test(s)) return true;
  if (inFlow && /[,\[\]{}]/.test(s)) return true;
  return false;
}

function quote(s) {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '') + '"';
}

function formatScalar(v, inFlow) {
  if (v === null || v === undefined) return inFlow ? '""' : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : quote(String(v));
  const s = String(v);
  return needsQuotes(s, inFlow) ? quote(s) : s;
}

/** Formats a value for `key: <value>` (empty string for null/undefined). */
export function formatValue(v) {
  if (Array.isArray(v)) return '[' + v.map((item) => formatScalar(item, true)).join(', ') + ']';
  return formatScalar(v, false);
}

function keyLine(key, value) {
  const f = formatValue(value);
  return f === '' ? `${key}:` : `${key}: ${f}`;
}

function orderedKeys(keys, order = []) {
  const set = new Set(keys);
  const first = order.filter((k) => set.has(k));
  const firstSet = new Set(first);
  return [...first, ...keys.filter((k) => !firstSet.has(k))];
}

/** '---\n' + one line per key (undefined values skipped) + '---\n'. */
export function serialize(data, { order } = {}) {
  const keys = orderedKeys(Object.keys(data).filter((k) => data[k] !== undefined), order);
  return '---\n' + keys.map((k) => keyLine(k, data[k]) + '\n').join('') + '---\n';
}

/**
 * Changes only the lines of patched keys (a block list becomes one flow line), appends new keys
 * before the closing fence in `order`, removes a key only for an `undefined` patch value, and
 * leaves every other byte unchanged. Without frontmatter it prepends serialize(patch).
 */
export function updateFrontmatter(text, patch, { order } = {}) {
  const src = String(text);
  const bom = src.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
  const body = bom ? src.slice(1) : src;
  const crlf = body.includes('\r\n');
  const lf = crlf ? body.replace(/\r\n/g, '\n') : body;
  const fm = parse(lf);
  const eol = crlf ? '\r\n' : '\n';

  if (!fm.has) {
    const present = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) present[k] = v;
    const head = serialize(present, { order });
    return bom + (crlf ? head.replace(/\n/g, '\r\n') : head) + body;
  }

  const lines = lf.split('\n');
  const replace = new Map(); // first line index -> replacement lines (array) for [start, end]
  const drop = new Set();
  const appended = [];
  for (const [key, value] of Object.entries(patch)) {
    const span = fm.spans[key];
    if (!span) {
      if (value !== undefined) appended.push(key);
      continue;
    }
    const [start, stop] = span; // 1-based file lines
    for (let ln = start; ln <= stop; ln++) drop.add(ln - 1);
    if (value !== undefined) replace.set(start - 1, [keyLine(key, value)]);
  }
  const closing = fm.endLine - 1;
  const newLines = orderedKeys(appended, order).map((k) => keyLine(k, patch[k]));

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === closing) out.push(...newLines);
    if (replace.has(i)) out.push(...replace.get(i));
    else if (!drop.has(i)) out.push(lines[i]);
  }
  return bom + out.join(eol);
}
