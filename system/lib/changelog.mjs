// CHANGELOG.md as data, for the "What's new" part of the upgrade screen: the "## x.y.z (…)"
// sections, their "### …" groups and a one-line headline of every top-level bullet. A headline is
// the bullet's first sentence without markdown (bold, code, links; a link to the docs in
// parentheses is dropped). Pure functions except readReleaseNotes, which never throws.

import fs from 'node:fs';
import path from 'node:path';

const VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b\s*(.*)$/;
// Groups that list files or tests rather than what changed for the user.
const MIN_CLAUSE = 24;
const SKIP_GROUPS = /^(kit(-owned)? files|files|testing|tests)$/i;

/** Markdown of one bullet as plain text: links, code, emphasis removed; spaces collapsed. */
export function plainText(md) {
  return String(md)
    .replace(/\s*\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, '') // "([docs/x.md](docs/x.md))": a pointer, not content
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A short headline of a bullet: its first sentence, cut earlier at a ": " or "; " that comes after
 * the first MIN_CLAUSE characters ("upgrade: updates the kit" stays whole), without the final
 * punctuation.
 */
export function headline(text) {
  const plain = plainText(text);
  let end = plain.length;
  // A sentence ends before a capital letter or at the end ("e.g. from" goes on).
  const sentence = /[.!?](?=\s+\p{Lu}|\s*$)/u.exec(plain);
  if (sentence) end = sentence.index;
  const clause = /[:;](?=\s)/g;
  for (let m = clause.exec(plain); m && m.index < end; m = clause.exec(plain)) {
    if (m.index >= MIN_CLAUSE) {
      end = m.index;
      break;
    }
  }
  return plain.slice(0, end).replace(/[\s.:;,]+$/, '').trim();
}

/**
 * [{ version, title, groups: [{ title, items: [{ headline, text }] }] }] in file order. `title`
 * is the rest of the heading line ("(2026-09-25, not released yet)"). Bullets before the first
 * "###" land in a group with an empty title; nested bullets belong to their parent.
 */
export function parseChangelog(markdown) {
  const sections = [];
  let section = null;
  let group = null;
  let item = null;
  const flush = () => {
    if (item && group) group.items.push({ headline: headline(item.lines.join(' ')), text: plainText(item.lines.join(' ')) });
    item = null;
  };
  for (const raw of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const v = VERSION_HEADING.exec(line);
    if (v) {
      flush();
      section = { version: v[1], title: v[2].trim(), groups: [] };
      sections.push(section);
      group = null;
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      section = null;
      group = null;
      continue;
    }
    if (!section) continue;
    const g = /^###\s+(.*)$/.exec(line);
    if (g) {
      flush();
      group = { title: g[1].trim(), items: [] };
      section.groups.push(group);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      if (!group) {
        group = { title: '', items: [] };
        section.groups.push(group);
      }
      item = { lines: [bullet[1]], nested: false };
      continue;
    }
    if (item && /^\s+[-*]\s/.test(line)) {
      // Nested bullets are details of their parent, not part of its headline.
      item.nested = true;
      continue;
    }
    if (item && /^\s+\S/.test(line)) {
      if (!item.nested) item.lines.push(line.trim());
      continue;
    }
    if (line === '') continue;
    flush();
  }
  flush();
  return sections;
}

/** -1, 0 or 1 for two x.y.z versions (a pre-release suffix is ignored); null when one is not a version. */
export function compareVersions(a, b) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * The headlines of what a version changed for the user (every group except the file and test
 * lists), at most max of them: { version, title, headlines, more } or null when the changelog
 * has no section for the version. With from, the sections of every version after from up to
 * version count too (newest first), so skipping a release loses nothing.
 */
export function releaseNotes(markdown, version, { max = 6, from } = {}) {
  const sections = parseChangelog(markdown);
  const target = sections.find((s) => s.version === String(version).replace(/^v/, ''));
  if (!target) return null;
  const chosen = from === undefined
    ? [target]
    : sections.filter((s) => compareVersions(s.version, version) <= 0 && compareVersions(s.version, from) > 0)
      .sort((a, b) => compareVersions(b.version, a.version));
  const all = chosen.flatMap((s) => s.groups.filter((g) => !SKIP_GROUPS.test(g.title)).flatMap((g) => g.items.map((i) => i.headline)))
    .filter(Boolean);
  return { version: target.version, title: target.title, headlines: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** releaseNotes of <kitDir>/CHANGELOG.md; null when the file or the section is missing. */
export function readReleaseNotes(kitDir, version, opts) {
  let text;
  try {
    text = fs.readFileSync(path.join(kitDir, 'CHANGELOG.md'), 'utf8');
  } catch {
    return null;
  }
  try {
    return releaseNotes(text, version, opts);
  } catch {
    return null;
  }
}
