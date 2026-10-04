// Header line and fingerprints of generated files (docs/architecture.md, section 8.1).
// `source` covers every input file, the as-of date and the kit version; `content` covers the text
// after the header line. Neither depends on the clock, mtimes or git.

import { createHash } from 'node:crypto';
import { cmp } from './util.mjs';

export const FORMAT_VERSION = 1;

// The header is plain, behind '# ' (tsv, .ignore) or inside an HTML comment (the home page).
const HEADER_RE = /^(?:# |<!-- )?memory-kit v(\d+) · source ([0-9a-f]{12}) · content ([0-9a-f]{12}) · as-of (\d{4}-\d{2}-\d{2}) · DO NOT EDIT(?: -->)?$/;

export function sha256hex(bufOrString) {
  return createHash('sha256').update(bufOrString).digest('hex');
}

/** 12 hex chars over the sorted inputs of a vault, the as-of date and the kit version. */
export function sourceFingerprint(vault, asOf, kitVersion) {
  const inputs = [...vault.inputs].sort((a, b) => cmp(a.rel, b.rel));
  let s = '';
  for (const { rel, sha256 } of inputs) s += `${rel}\n${sha256}\n`;
  s += `as-of ${asOf}\nkit ${kitVersion}\n`;
  return sha256hex(Buffer.from(s, 'utf8')).slice(0, 12);
}

/** 12 hex chars over everything after the first line of a generated file. */
export function contentFingerprint(textAfterFirstLine) {
  return sha256hex(Buffer.from(String(textAfterFirstLine), 'utf8')).slice(0, 12);
}

export function headerLine({ source, content, asOf, prefix = '', suffix = '' }) {
  return `${prefix}memory-kit v${FORMAT_VERSION} · source ${source} · content ${content} · as-of ${asOf} · DO NOT EDIT${suffix}`;
}

export function parseHeader(line) {
  const m = HEADER_RE.exec(String(line ?? ''));
  if (!m) return null;
  return { version: Number(m[1]), source: m[2], content: m[3], asOf: m[4] };
}

/** Header + body. bodyText has no header and ends with '\n'. */
export function stamp(bodyText, { source, asOf, prefix = '', suffix = '' }) {
  return `${headerLine({ source, content: contentFingerprint(bodyText), asOf, prefix, suffix })}\n${bodyText}`;
}

/**
 * Verifies a generated file's own header: {ok, header, reason}. reason is 'missing' (no parsable
 * header) or 'content' (the text after line 1 does not match its content fingerprint).
 */
export function verifyStamp(text) {
  const s = String(text ?? '');
  const nl = s.indexOf('\n');
  const header = parseHeader(nl < 0 ? s : s.slice(0, nl));
  if (!header) return { ok: false, header: null, reason: 'missing' };
  if (contentFingerprint(nl < 0 ? '' : s.slice(nl + 1)) !== header.content) return { ok: false, header, reason: 'content' };
  return { ok: true, header, reason: null };
}
