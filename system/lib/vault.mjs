// The vault model: which files are notes, their canonical data, sectors and link resolution
// (docs/architecture.md, sections 2.3, 5 and 7.4). Synchronous and clock-free.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './frontmatter.mjs';
import {
  CANON_PRIVACY, CANON_STATES, bytes, chars, cmp, fenceTracker, isDate, lineCount, normalizeText,
  parseHeading, readTextIfExists, toPosix,
} from './util.mjs';

const ARRAY_KEYS = new Set(['aliases', 'keywords', 'questions', 'links', 'sectors', 'used', 'changed', 'search_missed', 'replaces']);
const STRING_KEYS = new Set(['description', 'updated', 'created', 'valid_until', 'review_on', 'replaced_by', 'source', 'when_here', 'not_here', 'cleanup']);
const VALUE_KINDS = { type: 'type', status: 'status', state: 'state', privacy: 'privacy' };
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// ---------------------------------------------------------------------------------------------
// Classification of paths

/** Area, sector and manifest/export flags of a rel path. null when the file is not a note. */
function classify(cfg, rel, isMain) {
  const parts = rel.split('/');
  const { sectors, journal, inbox, archive } = cfg.dirs;
  const base = { area: null, origArea: null, sector: null, archived: false, isManifest: false, isExport: false };
  if (parts.length === 1) {
    if (!isMain) return null;
    // The home page is generated (section 8.8), so it is not a note.
    const hubs = [cfg.files.state, cfg.files.waiting];
    return hubs.includes(rel) ? { ...base, area: 'root' } : null;
  }
  const name = parts[parts.length - 1].slice(0, -3);
  const sectorFlags = (id, depth) => ({
    isManifest: parts.length === depth + 1 && name === `_${id}`,
    isExport: parts.length === depth + 1 && name === `_${id}${cfg.exportSuffix}`,
  });
  if (parts[0] === sectors) {
    if (parts.length < 3) return null; // a file directly in sectors/ is not a note
    return { ...base, area: 'sector', sector: parts[1], ...sectorFlags(parts[1], 2) };
  }
  if (parts[0] === journal) return { ...base, area: 'journal' };
  if (parts[0] === inbox) return { ...base, area: 'inbox' };
  if (parts[0] === archive) {
    const out = { ...base, area: 'archive', archived: true };
    if (parts[1] === sectors && parts.length >= 4) {
      return { ...out, origArea: 'sector', sector: parts[2], ...sectorFlags(parts[2], 3) };
    }
    if (parts[1] === journal) return { ...out, origArea: 'journal' };
    if (parts[1] === inbox) return { ...out, origArea: 'inbox' };
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Frontmatter -> canonical data

function emptyData() {
  return {
    type: null, status: null, description: null, updated: null, created: null,
    aliases: [], keywords: [], replaces: [], replaced_by: null, valid_until: null, review_on: null,
    pin: false, source: null, questions: [], state: null, privacy: null, when_here: null,
    not_here: null, links: [], hot_max: null, cleanup: null, sectors: [], used: [], changed: [],
    search_missed: [],
  };
}

function asString(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(String).join(', ');
  return String(v).trim();
}

function asArray(v) {
  if (v === null || v === undefined) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.filter((x) => x !== null && x !== undefined).map((x) => String(x).trim()).filter(Boolean);
}

function mapData(cfg, fm) {
  const data = emptyData();
  const extra = {};
  const keyLines = {};
  const foreignKeys = [];
  const foreignValues = [];
  const fromLocal = {}; // canon key -> true when set from the localized key
  const nonEn = cfg.lang !== 'en';

  for (const [origKey, value] of Object.entries(fm.data)) {
    const canon = cfg.keysRev[origKey];
    if (!canon) {
      extra[origKey] = value;
      keyLines[origKey] = fm.keyLines[origKey];
      continue;
    }
    const isLocal = cfg.keys[canon] === origKey;
    if (!isLocal && nonEn) foreignKeys.push(origKey);
    if (fromLocal[canon] && !isLocal) continue; // the localized key wins
    fromLocal[canon] = isLocal;
    keyLines[canon] = fm.keyLines[origKey];

    if (ARRAY_KEYS.has(canon)) data[canon] = asArray(value);
    else if (STRING_KEYS.has(canon)) data[canon] = asString(value);
    else if (canon === 'pin') data.pin = value === true || value === 'true';
    else if (canon === 'hot_max') {
      data.hot_max = Number.isInteger(value) ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null;
    } else if (VALUE_KINDS[canon]) {
      const raw = asString(value);
      const mapped = raw === null ? null : cfg.canon(VALUE_KINDS[canon], raw);
      data[canon] = mapped ?? raw;
      if (mapped && nonEn && raw !== cfg.local(VALUE_KINDS[canon], mapped)) {
        foreignValues.push({ key: canon, value: raw, local: cfg.local(VALUE_KINDS[canon], mapped) });
      }
    } else {
      data[canon] = value;
    }
  }
  return { data, extra, keyLines, foreignKeys, foreignValues };
}

// ---------------------------------------------------------------------------------------------
// Body analysis

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

// '\|' is the alias separator inside markdown tables ([[note\|alias]]), so it splits like '|'.
const ALIAS_SEP = /\\?\|/;

function parseWikiInner(inner) {
  const sep = ALIAS_SEP.exec(inner);
  const targetPart = sep ? inner.slice(0, sep.index) : inner;
  const alias = sep ? inner.slice(sep.index + sep[0].length).trim() : null;
  const hash = targetPart.indexOf('#');
  const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
  const heading = hash >= 0 ? targetPart.slice(hash + 1).trim() : null;
  return { target, heading, alias };
}

function linksInLine(line, lineNo, out) {
  const text = stripInlineCode(line);
  for (const m of text.matchAll(WIKILINK)) {
    const { target, heading, alias } = parseWikiInner(m[2]);
    if (target) out.push({ target, heading, alias, embed: m[1] === '!', line: lineNo, kind: 'wiki' });
  }
  for (const m of text.matchAll(MDLINK)) {
    const url = m[3];
    if (SCHEME.test(url) || url.startsWith('#')) continue;
    const hash = url.indexOf('#');
    let p = hash >= 0 ? url.slice(0, hash) : url;
    try {
      p = decodeURI(p);
    } catch {
      /* keep as written */
    }
    if (!p.toLowerCase().endsWith('.md')) continue;
    out.push({ target: p, heading: hash >= 0 ? url.slice(hash + 1) : null, alias: m[2] || null, embed: m[1] === '!', line: lineNo, kind: 'md' });
  }
}

const relationMaps = new WeakMap();
function relationRev(cfg) {
  let rev = relationMaps.get(cfg);
  if (!rev) {
    rev = new Map();
    for (const canon of Object.keys(cfg.relations)) rev.set(canon, canon);
    for (const [canon, local] of Object.entries(cfg.relations)) rev.set(String(local).toLowerCase(), canon);
    relationMaps.set(cfg, rev);
  }
  return rev;
}

function sectionNames(cfg, canon) {
  const names = [cfg.sections?.[canon], cfg.enSections?.[canon], canon].filter(Boolean);
  return new Set(names.map((s) => String(s).normalize('NFC').toLowerCase().trim()));
}

function analyzeBody(cfg, bodyLines, startLine) {
  let title = null;
  let titleIdx = -1;
  const headings = [];
  const links = [];
  const inFence = [];
  const step = fenceTracker();
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const f = step(line);
    inFence.push(f.inside);
    if (f.inside) continue;
    const lineNo = startLine + i;
    const h = parseHeading(line, 3);
    if (h) {
      if (h.level === 1 && title === null) {
        title = h.text;
        titleIdx = i;
      } else if (h.level >= 2) {
        headings.push({ level: h.level, text: h.text, line: lineNo });
      }
    }
    linksInLine(line, lineNo, links);
  }

  // Lead: blockquote lines right after the H1, else the first paragraph (max 5 lines).
  const lead = [];
  let i = titleIdx + 1;
  while (i < bodyLines.length && bodyLines[i].trim() === '') i++;
  if (i < bodyLines.length && !inFence[i]) {
    if (/^\s*>/.test(bodyLines[i])) {
      for (; i < bodyLines.length && /^\s*>/.test(bodyLines[i]); i++) {
        const text = bodyLines[i].replace(/^\s*>\s?/, '').trim();
        if (text) lead.push(text);
      }
    } else if (!/^\s*#/.test(bodyLines[i])) {
      for (; i < bodyLines.length && lead.length < 5; i++) {
        const line = bodyLines[i];
        if (line.trim() === '' || /^\s*#/.test(line) || inFence[i]) break;
        lead.push(line.trim());
      }
    }
  }

  // Relations: '- <relation> [[target]]' lines of the Related section.
  const relations = [];
  const related = sectionNames(cfg, 'related');
  const rev = relationRev(cfg);
  let inRelated = false;
  for (let j = 0; j < bodyLines.length; j++) {
    if (inFence[j]) continue;
    const line = bodyLines[j];
    const h = parseHeading(line);
    if (h) {
      if (h.level <= 2) inRelated = h.level === 2 && related.has(h.text.normalize('NFC').toLowerCase());
      continue;
    }
    if (!inRelated) continue;
    const m = /^\s*[-*]\s+([^\s[]+)\s+!?\[\[([^[\]\n]+?)\]\]/.exec(line);
    if (!m) continue;
    const relation = rev.get(m[1].toLowerCase());
    if (relation) relations.push({ relation, target: parseWikiInner(m[2]).target, line: startLine + j });
  }
  return { title, headings, links, lead, relations };
}

// ---------------------------------------------------------------------------------------------
// Notes

/** Parses one note. `text` may carry a BOM or CRLF; they are removed and reported. */
export function parseNote(cfg, { rel, text, root = 'main', rootPath }) {
  const norm = normalizeText(text);
  const fm = parse(norm.text);
  const isMain = root === 'main';
  const info = classify(cfg, rel, isMain) ?? {
    area: null, origArea: null, sector: null, archived: false, isManifest: false, isExport: false,
  };
  const mapped = mapData(cfg, fm);
  const bodyLines = fm.body.split('\n');
  const body = analyzeBody(cfg, bodyLines, fm.bodyStartLine);

  // Frontmatter wikilinks count as links too (the usual wiki-link convention).
  for (const [origKey, value] of Object.entries(fm.data)) {
    const line = fm.keyLines[origKey] ?? 1;
    const canonKey = cfg.keysRev[origKey] ?? origKey;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== 'string') continue;
      for (const m of v.matchAll(WIKILINK)) {
        const { target, heading, alias } = parseWikiInner(m[2]);
        if (target) body.links.push({ target, heading, alias, embed: m[1] === '!', line, kind: 'wiki', fm: true, key: canonKey });
      }
    }
  }

  const allLines = norm.text.endsWith('\n') ? norm.text.slice(0, -1).split('\n') : norm.text.split('\n');
  let maxLineChars = 0;
  let maxLineAt = 0;
  allLines.forEach((line, idx) => {
    const n = chars(line);
    if (n > maxLineChars) {
      maxLineChars = n;
      maxLineAt = idx + 1;
    }
  });

  const base = path.posix.basename(rel);
  const dir = path.posix.dirname(rel);
  const note = {
    path: path.join(rootPath ?? cfg.root, ...rel.split('/')),
    rel,
    root,
    local: !isMain,
    name: base.endsWith('.md') ? base.slice(0, -3) : base,
    dir: dir === '.' ? '' : dir,
    ...info,
    data: mapped.data,
    extra: mapped.extra,
    fm: {
      has: fm.has,
      errors: fm.errors,
      endLine: fm.endLine,
      bodyStartLine: fm.bodyStartLine,
      keyLines: mapped.keyLines,
      foreignKeys: mapped.foreignKeys,
      foreignValues: mapped.foreignValues,
      data: fm.data,
    },
    text: norm.text,
    body: fm.body,
    crlf: norm.crlf,
    bom: norm.bom,
    nfc: norm.text === norm.text.normalize('NFC'),
    title: body.title,
    lead: body.lead,
    headings: body.headings,
    links: body.links,
    relations: body.relations,
    lines: lineCount(norm.text),
    chars: chars(norm.text),
    bytes: bytes(norm.text),
    maxLineChars,
    maxLineAt,
  };
  Object.defineProperty(note, 'cfg', { value: cfg, enumerable: false });
  return note;
}

// ---------------------------------------------------------------------------------------------
// Walking

/** Every file under dir (rel to rootPath), skipping dot entries and symlinks; sorted. */
function walk(rootPath, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(rootPath, ...relDir.split('/')), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => cmp(a.name, b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) walk(rootPath, rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

function listDirs(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.isSymbolicLink())
      .map((e) => e.name)
      .sort(cmp);
  } catch {
    return [];
  }
}

function fileSize(abs) {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

/**
 * Hash of a text input as every checkout sees it: BOM removed, LF line ends, NFC. A CRLF or NFD
 * copy on one machine must not make _ai/ stale on another (git stores text as LF).
 */
function sha256Text(abs) {
  const { text } = normalizeText(fs.readFileSync(abs, 'utf8'));
  return createHash('sha256').update(text.normalize('NFC')).digest('hex');
}

function pickRoots(cfg, roots) {
  if (roots === 'all') return cfg.roots.filter((r) => r.id === 'main' || r.exists);
  if (Array.isArray(roots)) return cfg.roots.filter((r) => r.id === 'main' || (roots.includes(r.id) && r.exists));
  return cfg.roots.filter((r) => r.id === 'main');
}

/** Loads notes, sectors and generator inputs. Generators only use notes with root 'main'. */
export function loadVault(cfg, { includeArchive = true, includeInbox = true, roots = 'main' } = {}) {
  const notes = [];
  const files = [];
  const inputs = [];
  const { sectors: sectorsDir, journal, inbox, archive, attachments } = cfg.dirs;

  for (const r of pickRoots(cfg, roots)) {
    const isMain = r.id === 'main';
    const rels = [];
    for (const d of [sectorsDir, journal, inbox, archive]) walk(r.path, d, rels);
    if (isMain) {
      for (const hub of [cfg.files.state, cfg.files.waiting]) {
        if (fs.existsSync(path.join(r.path, hub))) rels.push(hub);
      }
      const attach = [];
      walk(r.path, attachments, attach);
      for (const rel of [...rels, ...attach]) files.push({ rel, size: fileSize(path.join(r.path, ...rel.split('/'))) });
    }
    for (const rel of rels.sort(cmp)) {
      if (!rel.endsWith('.md')) continue;
      const info = classify(cfg, rel, isMain);
      if (!info) continue;
      const abs = path.join(r.path, ...rel.split('/'));
      if (isMain) inputs.push({ rel, sha256: sha256Text(abs) });
      if (info.area === 'inbox' && !includeInbox) continue;
      if (info.area === 'archive' && !includeArchive) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      notes.push(parseNote(cfg, { rel, text, root: r.id, rootPath: r.path }));
    }
  }

  // Non-note inputs of the generators (section 8.1).
  for (const rel of [cfg.files.agents, cfg.files.config, `system/lang/${cfg.lang}/pack.json`, cfg.files.version, cfg.files.lastCleanup]) {
    const abs = path.join(cfg.root, ...rel.split('/'));
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) inputs.push({ rel, sha256: sha256Text(abs) });
  }
  inputs.sort((a, b) => cmp(a.rel, b.rel));

  const rootOrder = new Map(cfg.roots.map((r, i) => [r.id, i]));
  notes.sort((a, b) => (rootOrder.get(a.root) - rootOrder.get(b.root)) || cmp(a.rel, b.rel));

  const byRel = new Map();
  const byRootRel = new Map();
  const byName = new Map();
  for (const n of notes) {
    if (n.root === 'main') byRel.set(n.rel, n);
    byRootRel.set(`${n.root}:${n.rel}`, n);
    const key = n.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(n);
  }

  const sectorDirs = listDirs(path.join(cfg.root, sectorsDir));
  const sectors = discoverSectors(cfg, notes, byRel, sectorDirs);

  return {
    cfg,
    notes,
    sectors,
    sectorById: new Map(sectors.map((s) => [s.id, s])),
    byRel,
    byRootRel,
    byName,
    inputs,
    files,
    sectorDirs,
    otherFiles: {
      agents: readTextIfExists(path.join(cfg.root, cfg.files.agents)),
      claude: readTextIfExists(path.join(cfg.root, cfg.files.claude)),
      gemini: readTextIfExists(path.join(cfg.root, cfg.files.gemini)),
      lastCleanup: readTextIfExists(path.join(cfg.root, ...cfg.files.lastCleanup.split('/'))),
    },
  };
}

function discoverSectors(cfg, notes, byRel, sectorDirs) {
  const { sectors: sectorsDir, archive } = cfg.dirs;
  const found = new Map();
  const candidates = [
    ...sectorDirs.map((id) => ({ id, dir: `${sectorsDir}/${id}` })),
    ...listDirs(path.join(cfg.root, archive, sectorsDir)).map((id) => ({ id, dir: `${archive}/${sectorsDir}/${id}` })),
  ];
  for (const { id, dir } of candidates) {
    if (found.has(id)) continue; // the live folder wins over an archived copy
    const rel = `${dir}/_${id}.md`;
    let manifest = byRel.get(rel);
    if (!manifest) {
      const abs = path.join(cfg.root, ...rel.split('/'));
      if (!fs.existsSync(abs)) continue;
      manifest = parseNote(cfg, { rel, text: fs.readFileSync(abs, 'utf8') });
    }
    const d = manifest.data;
    const archived = dir.startsWith(`${archive}/`);
    const state = CANON_STATES.includes(d.state) ? d.state : archived ? 'off' : 'on';
    const privacy = CANON_PRIVACY.includes(d.privacy) ? d.privacy : 'github';
    const own = notes.filter((n) => n.root === 'main' && n.rel.startsWith(`${dir}/`) && !n.isManifest && !n.isExport);
    const dates = own.map((n) => n.data.updated).filter(isDate).sort(cmp);
    const exportRel = `${dir}/_${id}${cfg.exportSuffix}.md`;
    const hotMax = Number.isInteger(d.hot_max) ? Math.max(0, Math.min(20, d.hot_max)) : cfg.budgets.hot_max_default;
    found.set(id, {
      id,
      title: manifest.title ?? id,
      manifest,
      dir,
      state,
      privacy,
      description: d.description ?? '',
      when_here: d.when_here ?? '',
      not_here: d.not_here ?? '',
      keywords: d.keywords,
      links: d.links,
      hot_max: hotMax,
      cleanup: d.cleanup ?? 'none',
      notes: own.length,
      lastUpdated: dates.length ? dates[dates.length - 1] : null,
      exportRel: byRel.has(exportRel) || fs.existsSync(path.join(cfg.root, ...exportRel.split('/'))) ? exportRel : null,
    });
  }
  return [...found.values()].sort((a, b) => cmp(a.id, b.id));
}

// ---------------------------------------------------------------------------------------------
// Queries

/** Resolves a wikilink or relative .md link target to a loaded note (main root first). */
export function resolveLink(vault, target, fromNote) {
  let t = String(target ?? '').split(ALIAS_SEP)[0].split('#')[0].trim().normalize('NFC');
  if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
  if (!t) return null;
  if (!t.includes('/')) return vault.byName.get(t.toLowerCase())?.[0] ?? null;

  const fromRoot = path.posix.normalize(t.replace(/^\/+/, ''));
  const tries = [`${fromRoot}.md`];
  if (fromNote) tries.push(`${path.posix.normalize(path.posix.join(fromNote.dir || '.', t))}.md`);
  const rootIds = fromNote && fromNote.root !== 'main' ? ['main', fromNote.root] : ['main'];
  for (const rel of tries) {
    if (rel.startsWith('../')) continue;
    for (const id of rootIds) {
      const hit = vault.byRootRel?.get(`${id}:${rel}`) ?? (id === 'main' ? vault.byRel.get(rel) : null);
      if (hit) return hit;
    }
  }
  // A partial path also resolves by its ending (the usual wiki-link convention).
  const suffix = `/${fromRoot}.md`.toLowerCase();
  return vault.notes.find((n) => `/${n.rel}`.toLowerCase().endsWith(suffix)) ?? null;
}

/** Lines of a `## <section>` (localized, English or canonical name) up to the next H1/H2. */
export function extractSection(note, canonSection, cfg = note.cfg) {
  const names = sectionNames(cfg ?? { sections: {}, enSections: {} }, canonSection);
  const lines = note.body.split('\n');
  const step = fenceTracker();
  let start = -1;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = step(line);
    const h = !f.inside && parseHeading(line, 2);
    if (start >= 0) {
      if (h) break;
      out.push(line);
    } else if (h && h.level === 2 && names.has(h.text.normalize('NFC').toLowerCase())) {
      start = i;
    }
  }
  if (start < 0) return null;
  return { line: note.fm.bodyStartLine + start, lines: out };
}

/** The `## ` items of the waiting file: [{title, open, line}]; open = no filled answer line. */
export function waitingItems(cfg, note) {
  if (!note) return [];
  const labels = [cfg.waiting?.answer, cfg.enWaiting?.answer, 'Answer'].filter(Boolean);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const answer = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?(?:${labels.map(esc).join('|')})(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*\\S`, 'iu');
  const items = [];
  let item = null;
  const step = fenceTracker();
  note.body.split('\n').forEach((line, i) => {
    if (step(line).inside) return;
    const h = parseHeading(line, 2);
    if (h) {
      item = h.level === 2 ? { title: h.text, open: true, line: note.fm.bodyStartLine + i } : null;
      if (item) items.push(item);
      return;
    }
    if (item && answer.test(line)) item.open = false;
  });
  return items;
}

/** Number of `## ` items in the waiting file without a filled answer line. */
export function waitingOpen(cfg, note) {
  return waitingItems(cfg, note).filter((x) => x.open).length;
}

/** Posix rel of an absolute path inside root. */
export function relOf(root, abs) {
  return toPosix(path.relative(root, abs));
}
