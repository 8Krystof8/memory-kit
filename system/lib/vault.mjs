// The vault model: which files are notes, their canonical data, sectors and link resolution
// (docs/architecture.md, sections 2.3, 5 and 7.4). Synchronous and clock-free.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './frontmatter.mjs';
import {
  CANON_PRIVACY, CANON_STATES, bytes, chars, cmp, direntKind, fenceTracker, isDate, isDir, isOsJunk, lineCount,
  normalizeText, parseHeading, readTextIfExists, resolveExact, toPosix,
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

/**
 * Parses one note. `text` may carry a BOM or CRLF; they are removed and reported. `rel` is the
 * NFC form that identifies the note; `diskRel` the on-disk spelling when it differs (an NFD name),
 * used for note.path so that a rewrite lands on the same file.
 */
export function parseNote(cfg, { rel, text, root = 'main', rootPath, diskRel }) {
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
    path: path.join(rootPath ?? cfg.root, ...(diskRel ?? rel).split('/')),
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

/**
 * Every file under diskDir (rel to rootPath) as {rel, disk}: rel is the NFC spelling (identity,
 * order, hashes and output are the same on every machine), disk the name on this disk for I/O.
 * Skips dot entries, OS junk files and real symlinks; sorted by rel.
 */
function walk(rootPath, relDir, out, diskDir = relDir) {
  const dirAbs = path.join(rootPath, ...diskDir.split('/'));
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  const items = entries.map((e) => ({ e, name: e.name.normalize('NFC') }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.e.name, b.e.name));
  for (const { e, name } of items) {
    if (e.name.startsWith('.') || isOsJunk(e.name)) continue;
    const kind = direntKind(dirAbs, e);
    const rel = `${relDir}/${name}`;
    const disk = `${diskDir}/${e.name}`;
    if (kind === 'dir') walk(rootPath, rel, out, disk);
    else if (kind === 'file') out.push({ rel, disk });
  }
}

/** walk() of a top folder of the vault, found only under its exact name (see resolveExact). */
function walkArea(rootPath, dir, out, cache) {
  const disk = resolveExact(rootPath, dir, cache);
  if (disk !== null) walk(rootPath, dir, out, disk);
}

/** Folder names (NFC, sorted) under rel of root, found by their exact names. */
function listDirs(root, rel, cache) {
  const disk = resolveExact(root, rel, cache);
  if (disk === null) return [];
  const dirAbs = path.join(root, ...disk.split('/'));
  try {
    return fs.readdirSync(dirAbs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && direntKind(dirAbs, e) === 'dir')
      .map((e) => e.name.normalize('NFC'))
      .sort(cmp);
  } catch {
    return [];
  }
}

/** Absolute path of rel's exact on-disk file under root, or null (see resolveExact). */
function exactFile(root, rel, cache) {
  const disk = resolveExact(root, rel, cache);
  if (disk === null) return null;
  const abs = path.join(root, ...disk.split('/'));
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
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

// ---------------------------------------------------------------------------------------------
// Private content left in a local sector's main-root folder

/**
 * True when a sector's notes are private: a manifest of it in the main root (live or archived)
 * says privacy local, or the main root has no readable manifest of it and a local root holds its
 * folder. A manifest that says github is the owner's choice and wins over a local folder.
 */
export function sectorIsLocal(cfg, id, cache) {
  let manifest = false;
  for (const dir of [`${cfg.dirs.sectors}/${id}`, `${cfg.dirs.archive}/${cfg.dirs.sectors}/${id}`]) {
    const rel = `${dir}/_${id}.md`;
    const disk = resolveExact(cfg.root, rel, cache);
    if (disk === null) continue;
    try {
      const note = parseNote(cfg, { rel, text: fs.readFileSync(path.join(cfg.root, ...disk.split('/')), 'utf8') });
      if (note.data.privacy === 'local') return true;
      manifest = true;
    } catch {
      /* an unreadable manifest decides nothing */
    }
  }
  if (manifest) return false;
  return cfg.roots.some((r) => r.id !== 'main' && r.exists && isDir(path.join(r.path, ...cfg.dirs.sectors.split('/'), id)));
}

/**
 * A test of main-root rels: true for a file inside a local sector's folder (sectors/<id>/ or
 * archive/sectors/<id>/) other than its manifest and export file. Such a file is private content
 * that belongs in the local root (check reports it as LOCAL_IN_GIT, git ignores it), so it is only
 * ever counted, never listed, shown, read or generated into _ai/. Sector answers are cached for
 * the test's lifetime.
 */
export function localFolderTest(cfg, cache) {
  const known = new Map();
  const isLocal = (id) => {
    if (!known.has(id)) known.set(id, sectorIsLocal(cfg, id, cache));
    return known.get(id);
  };
  const prefixes = [`${cfg.dirs.sectors}/`, `${cfg.dirs.archive}/${cfg.dirs.sectors}/`];
  return (rel) => {
    const lower = rel.toLowerCase();
    for (const prefix of prefixes) {
      if (!lower.startsWith(prefix.toLowerCase())) continue;
      const rest = rel.slice(prefix.length).split('/');
      if (rest.length < 2) return false;
      const id = rest[0];
      if (!isLocal(id)) return false;
      return !(rest.length === 2 && (rest[1] === `_${id}.md` || rest[1] === `_${id}${cfg.exportSuffix}.md`));
    }
    return false;
  };
}

/** localFolderTest for one rel. */
export function inLocalSectorFolder(cfg, rel) {
  return localFolderTest(cfg)(rel);
}

/**
 * The main-root notes of a vault that are private content of a local sector (see localFolderTest).
 * loadVault marks them: misplacedLocal and local are true.
 */
export function localFolderNotes(cfg, vault) {
  return vault.notes.filter((n) => n.root === 'main' && n.misplacedLocal === true);
}

/** A shallow copy of a vault without the given notes; inputs, files and sectors stay as they are. */
export function withoutNotes(vault, drop) {
  const gone = new Set(drop);
  if (!gone.size) return vault;
  const notes = vault.notes.filter((n) => !gone.has(n));
  const byName = new Map();
  for (const n of notes) {
    const key = n.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(n);
  }
  const keep = (map) => new Map([...map].filter(([, n]) => !gone.has(n)));
  return { ...vault, notes, byRel: keep(vault.byRel), byRootRel: keep(vault.byRootRel), byName };
}

// ---------------------------------------------------------------------------------------------
// Loading

/**
 * Loads notes, sectors and generator inputs. Generators only use notes with root 'main'.
 * Fixed names (hubs, manifests, export files, AGENTS.md…) count only with their exact letter
 * case, so Windows and macOS see the same vault as Linux and git (resolveExact).
 * A main-root note in a local sector's folder (localFolderTest) gets misplacedLocal: true and
 * local: true: search only counts it, and the generated views and the start view leave it out.
 */
export function loadVault(cfg, { includeArchive = true, includeInbox = true, roots = 'main' } = {}) {
  const notes = [];
  const files = [];
  const inputs = [];
  const { sectors: sectorsDir, journal, inbox, archive, attachments } = cfg.dirs;
  const cache = new Map();

  for (const r of pickRoots(cfg, roots)) {
    const isMain = r.id === 'main';
    const entries = [];
    for (const d of [sectorsDir, journal, inbox, archive]) walkArea(r.path, d, entries, cache);
    if (isMain) {
      for (const hub of [cfg.files.state, cfg.files.waiting]) {
        const abs = exactFile(r.path, hub, cache);
        if (abs) entries.push({ rel: hub, disk: relOf(r.path, abs) });
      }
      const attach = [];
      walkArea(r.path, attachments, attach, cache);
      for (const x of [...entries, ...attach]) files.push({ rel: x.rel, size: fileSize(path.join(r.path, ...x.disk.split('/'))) });
    }
    entries.sort((a, b) => cmp(a.rel, b.rel) || cmp(a.disk, b.disk));
    for (const { rel, disk } of entries) {
      if (!rel.endsWith('.md')) continue;
      const info = classify(cfg, rel, isMain);
      if (!info) continue;
      const abs = path.join(r.path, ...disk.split('/'));
      if (isMain) inputs.push(disk === rel ? { rel, sha256: sha256Text(abs) } : { rel, sha256: sha256Text(abs), disk });
      if (info.area === 'inbox' && !includeInbox) continue;
      if (info.area === 'archive' && !includeArchive) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      notes.push(parseNote(cfg, { rel, text, root: r.id, rootPath: r.path, ...(disk === rel ? {} : { diskRel: disk }) }));
    }
  }

  // Private content left in a local sector's main-root folder (LOCAL_IN_GIT) is a local note.
  const misplaced = localFolderTest(cfg, cache);
  for (const n of notes) {
    if (n.root === 'main' && misplaced(n.rel)) {
      n.misplacedLocal = true;
      n.local = true;
    }
  }

  // Non-note inputs of the generators (section 8.1).
  for (const rel of [cfg.files.agents, cfg.files.config, `system/lang/${cfg.lang}/pack.json`, cfg.files.version, cfg.files.lastCleanup]) {
    const abs = exactFile(cfg.root, rel, cache);
    if (abs) inputs.push({ rel, sha256: sha256Text(abs) });
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

  const sectorDirs = listDirs(cfg.root, sectorsDir, cache);
  const archiveSectorDirs = listDirs(cfg.root, `${archive}/${sectorsDir}`, cache);
  const sectors = discoverSectors(cfg, notes, byRel, sectorDirs, archiveSectorDirs, cache);
  const readExact = (rel) => {
    const abs = exactFile(cfg.root, rel, cache);
    return abs ? readTextIfExists(abs) : null;
  };

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
    archiveSectorDirs,
    otherFiles: {
      agents: readExact(cfg.files.agents),
      claude: readExact(cfg.files.claude),
      gemini: readExact(cfg.files.gemini),
      lastCleanup: readExact(cfg.files.lastCleanup),
    },
  };
}

function discoverSectors(cfg, notes, byRel, sectorDirs, archiveSectorDirs, cache) {
  const { sectors: sectorsDir, archive } = cfg.dirs;
  const found = new Map();
  const candidates = [
    ...sectorDirs.map((id) => ({ id, dir: `${sectorsDir}/${id}` })),
    ...archiveSectorDirs.map((id) => ({ id, dir: `${archive}/${sectorsDir}/${id}` })),
  ];
  for (const { id, dir } of candidates) {
    if (found.has(id)) continue; // the live folder wins over an archived copy
    const rel = `${dir}/_${id}.md`;
    let manifest = byRel.get(rel);
    if (!manifest) {
      const abs = exactFile(cfg.root, rel, cache);
      if (!abs) continue;
      const diskRel = relOf(cfg.root, abs);
      manifest = parseNote(cfg, { rel, text: fs.readFileSync(abs, 'utf8'), ...(diskRel === rel ? {} : { diskRel }) });
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
      exportRel: byRel.has(exportRel) || exactFile(cfg.root, exportRel, cache) ? exportRel : null,
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
