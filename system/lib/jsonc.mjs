// JSON with comments (JSONC), the way editors and CLIs keep their settings: // and /* */
// comments and trailing commas are allowed. parseJsonc reports what it met, so a caller can
// refuse to rewrite a file whose comments it would lose, and formatJson writes a value back in
// the style (indent, line endings, final newline) of the text it came from. Pure: no file access.

export class JsoncError extends Error {
  /** at is {offset, line, column}, or null when the position is unknown. */
  constructor(message, at = null) {
    super(at ? `${message} at line ${at.line}, column ${at.column}` : message);
    this.name = 'JsoncError';
    this.code = 'JSONC_PARSE';
    this.offset = at?.offset ?? null;
    this.line = at?.line ?? null;
    this.column = at?.column ?? null;
  }
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** {line, column} (1-based) of an offset. */
function where(text, offset) {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      start = i + 1;
    }
  }
  return { offset, line, column: offset - start + 1 };
}

/** Index of the next character that is neither whitespace nor inside a comment. */
function nextSignificant(text, from) {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      return i;
    }
  }
  return i;
}

/** Spaces in place of a comment; line breaks stay, so JSON.parse positions still match. */
function blank(s) {
  return s.replace(/[^\r\n]/g, ' ');
}

/**
 * Turns JSONC into plain JSON of the same length (comments and trailing commas become spaces)
 * and reports what it removed: {json, comments, trailingCommas, unsafeNumbers, bom}.
 * unsafeNumbers is true when an integer is too large to survive a JSON.parse round trip.
 */
export function stripJsonc(input) {
  let text = String(input ?? '');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = ` ${text.slice(1)}`;
  const n = text.length;
  const parts = [];
  let from = 0; // text before this index is already in parts
  let comments = false;
  let trailingCommas = false;
  let unsafeNumbers = false;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // A string: skip to its closing quote (a line break ends a broken one; JSON.parse reports it).
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 0x5c) i += 2;
        else if (d === 0x22 || d === 0x0a) break;
        else i++;
      }
      i++;
    } else if (c === 0x2f && (text[i + 1] === '/' || text[i + 1] === '*')) {
      let end;
      if (text[i + 1] === '/') {
        end = text.indexOf('\n', i);
        if (end < 0) end = n;
      } else {
        const close = text.indexOf('*/', i + 2);
        if (close < 0) throw new JsoncError('unterminated comment', where(text, i));
        end = close + 2;
      }
      parts.push(text.slice(from, i), blank(text.slice(i, end)));
      comments = true;
      from = end;
      i = end;
    } else if (c === 0x2c) {
      const next = text[nextSignificant(text, i + 1)];
      if (next === '}' || next === ']') {
        parts.push(text.slice(from, i), ' ');
        from = i + 1;
        trailingCommas = true;
      }
      i++;
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (!m) {
        i++;
        continue;
      }
      const value = Number(m[0]);
      if (!Number.isFinite(value) || (!/[.eE]/.test(m[0]) && !Number.isSafeInteger(value))) unsafeNumbers = true;
      i += m[0].length;
    } else {
      i++;
    }
  }
  parts.push(text.slice(from));
  return { json: parts.join(''), comments, trailingCommas, unsafeNumbers, bom };
}

/**
 * Parses JSON that may carry comments and trailing commas. Returns {value, empty, comments,
 * trailingCommas, unsafeNumbers, bom}; value is undefined and empty true for a text with no
 * value at all (an empty file). Throws JsoncError with the line and column of a syntax error.
 */
export function parseJsonc(input) {
  const stripped = stripJsonc(input);
  const { json, ...flags } = stripped;
  if (json.trim() === '') return { value: undefined, empty: true, ...flags };
  try {
    return { value: JSON.parse(json), empty: false, ...flags };
  } catch (err) {
    // V8 quotes a piece of the text in some messages; drop it, a settings file may hold secrets.
    const m = /position (\d+)/.exec(err.message);
    const reason = String(err.message)
      .replace(/\s*\(line \d+ column \d+\)/, '')
      .replace(/ in JSON at position \d+.*$/, '')
      .replace(/, ".*" is not valid JSON$/s, '')
      .trim();
    throw new JsoncError(reason || 'invalid JSON', m ? where(json, Number(m[1])) : null);
  }
}

/**
 * The layout of a JSON text: {indent, eol, finalNewline}. indent is a tab, a number of spaces,
 * or 0 for a one-line (minified) text with content; a new or empty text gets 2 spaces, LF and
 * a final newline.
 */
export function detectStyle(input) {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  if (text.trim() === '') return { indent: 2, eol: '\n', finalNewline: true };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = /\n$/.test(text);
  const body = text.replace(/\s+$/, '');
  if (!body.includes('\n')) return { indent: /:/.test(body) ? 0 : 2, eol, finalNewline };
  const m = /\n([ \t]+)\S/.exec(body);
  if (!m) return { indent: 2, eol, finalNewline };
  if (m[1][0] === '\t') return { indent: '\t', eol, finalNewline };
  return { indent: Math.min(m[1].length, 10), eol, finalNewline };
}

/** JSON text of value in the given style (see detectStyle). */
export function formatJson(value, { indent = 2, eol = '\n', finalNewline = true } = {}) {
  let text = indent === 0 ? JSON.stringify(value) : JSON.stringify(value, null, indent);
  if (eol !== '\n') text = text.replace(/\n/g, eol);
  return finalNewline ? text + eol : text;
}
