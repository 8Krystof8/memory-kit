// Checks of the vault (docs/architecture.md, section 11). Clock-free: time rules use as-of.
// Kinds: system = error in every mode; data = error in strict, warning in lenient; warn = warning.
// Budget rules are warnings between the warn and hard limits and data errors above hard.

import fs from 'node:fs';
import path from 'node:path';
import { verifyStamp } from './fingerprint.mjs';
import { GenBudgetError, buildContext, expectedFiles, extractSearchBlock, gitignoreText, resolveAsOfInfo } from './generate.mjs';
import { listTextFiles, scanFiles } from './secrets.mjs';
import { extractSection, resolveLink, waitingOpen } from './vault.mjs';
import {
  ATOMIC_TYPES, CANON_PRIVACY, CANON_STATES, CANON_STATUSES, CANON_TYPES, NAME_RE, SECTOR_ID_MAX,
  bytes, chars, cmp, daysBetween, isDate, lineCount,
} from './util.mjs';

export const RULES = [
  { code: 'CONFIG', kind: 'system', desc: 'memory.json or pack invalid; config warnings are warnings' },
  { code: 'SECRET', kind: 'system', desc: 'secret pattern in a scanned text file' },
  { code: 'PRIVACY_LINK', kind: 'system', desc: 'main-root note links to a local note' },
  { code: 'LOCAL_IN_GIT', kind: 'system', desc: 'main-root file in a local sector besides manifest and export' },
  { code: 'GEN_EDITED', kind: 'system', desc: 'generated file header missing or content fingerprint mismatch' },
  { code: 'GEN_BUDGET', kind: 'system', desc: 'start.md cannot fit its hard byte budget' },
  { code: 'GEN_FAILED', kind: 'system', desc: 'a generator threw' },
  { code: 'AGENTS_MARKERS', kind: 'system', desc: 'AGENTS.md missing, kit or search markers missing, or empty search block' },
  { code: 'ADAPTER_IMPORT', kind: 'system', desc: 'CLAUDE.md or GEMINI.md without @AGENTS.md first' },
  { code: 'FM_MISSING', kind: 'data', desc: 'non-inbox note without frontmatter' },
  { code: 'FM_PARSE', kind: 'data', desc: 'frontmatter parser errors' },
  { code: 'FM_REQUIRED', kind: 'data', desc: 'required key missing or empty' },
  { code: 'FM_CREATED', kind: 'data', desc: 'decision or journal without created' },
  { code: 'FM_TYPE', kind: 'data', desc: 'unknown type' },
  { code: 'FM_STATUS', kind: 'data', desc: 'unknown status' },
  { code: 'FM_DATE', kind: 'data', desc: 'updated, created, valid_until or review_on is not a real date' },
  { code: 'FM_DATE_FUTURE', kind: 'warn', desc: 'updated or created later than as-of (a typo moves time)' },
  { code: 'NAME_FORMAT', kind: 'data', desc: 'file name not lowercase ascii with hyphens' },
  { code: 'NAME_GENERIC', kind: 'data', desc: 'generic file name' },
  { code: 'NAME_DUPLICATE', kind: 'data', desc: 'same name twice in all roots' },
  { code: 'DATED_NAME', kind: 'data', desc: 'decision or journal name without its date' },
  { code: 'DECISION_PLACE', kind: 'data', desc: 'decision outside */decisions/ or non-decision inside' },
  { code: 'JOURNAL_PLACE', kind: 'data', desc: 'journal type outside the journal folder or other type inside' },
  { code: 'NFC', kind: 'data', desc: 'text not NFC-normalized' },
  { code: 'SECTOR_NO_MANIFEST', kind: 'data', desc: 'sector folder without its manifest' },
  { code: 'SECTOR_ID', kind: 'data', desc: 'invalid sector id' },
  { code: 'MANIFEST_FIELDS', kind: 'data', desc: 'manifest missing or invalid state, privacy, when_here, not_here' },
  { code: 'SECTOR_STATE_PLACE', kind: 'data', desc: 'off but not in archive, or on/sleep inside archive' },
  { code: 'SECTORS_ON', kind: 'data', desc: 'too many sectors on (budget)' },
  { code: 'GEN_MISSING', kind: 'data', desc: 'expected generated file absent' },
  { code: 'DESC_LONG', kind: 'data', desc: 'description too long (budget)' },
  { code: 'NOTE_LONG', kind: 'data', desc: 'note too long (budget)' },
  { code: 'LINE_LONG', kind: 'data', desc: 'line too long (budget)' },
  { code: 'STATE_LONG', kind: 'data', desc: 'state file or its Now section too long (budget)' },
  { code: 'WAITING_OPEN', kind: 'data', desc: 'too many open items in the waiting file (budget)' },
  { code: 'AGENTS_SIZE', kind: 'data', desc: 'AGENTS.md too long (budget)' },
  { code: 'CLAUDE_SIZE', kind: 'data', desc: 'CLAUDE.md too long (budget)' },
  { code: 'INDEX_SIZE', kind: 'data', desc: 'sector index over budget' },
  { code: 'START_BUDGET', kind: 'warn', desc: 'start.md at or above its warn byte budget' },
  { code: 'ATTACHMENT_SIZE', kind: 'data', desc: 'attachment too large (budget)' },
  { code: 'FM_FOREIGN_KEY', kind: 'warn', desc: 'English key or value in a non-English vault' },
  { code: 'FM_CRLF', kind: 'warn', desc: 'CRLF line endings' },
  { code: 'FM_BOM', kind: 'warn', desc: 'byte order mark' },
  { code: 'LINK_BROKEN', kind: 'warn', desc: 'link target not found' },
  { code: 'NAME_ALIAS_CLASH', kind: 'warn', desc: "alias equals another note's name" },
  { code: 'DOC_TOC', kind: 'warn', desc: 'long document without a Contents heading' },
  { code: 'FACT_VALIDITY', kind: 'warn', desc: 'fact without valid_until and review_on' },
  { code: 'EXPIRED', kind: 'warn', desc: 'active note past valid_until' },
  { code: 'REVIEW_DUE', kind: 'warn', desc: 'review_on reached' },
  { code: 'REPLACED_LINK', kind: 'warn', desc: 'replacement chain broken' },
  { code: 'MANIFEST_KEYWORDS', kind: 'warn', desc: 'manifest with fewer than 5 keywords' },
  { code: 'HUB_TYPE', kind: 'warn', desc: 'state or waiting file not of type hub' },
  { code: 'INBOX_AGE', kind: 'warn', desc: 'old inbox item' },
  { code: 'GEN_STALE', kind: 'warn', desc: 'generated view is stale' },
  { code: 'GEN_ORPHAN', kind: 'warn', desc: 'file in _ai/ that no generator produces' },
  { code: 'GITIGNORE_LOCAL', kind: 'warn', desc: '.gitignore block for local sectors missing or outdated' },
  { code: 'ROOT_MISSING', kind: 'warn', desc: 'configured local root not found' },
  { code: 'LOCAL_UNKNOWN_SECTOR', kind: 'warn', desc: 'local-root note in a sector that is not a local sector' },
];

const KIND = Object.fromEntries(RULES.map((r) => [r.code, r.kind]));
const GEN_CODES = ['GEN_EDITED', 'GEN_BUDGET', 'GEN_FAILED', 'GEN_MISSING', 'GEN_STALE', 'GEN_ORPHAN', 'START_BUDGET', 'INDEX_SIZE', 'GITIGNORE_LOCAL'];
const INACTIVE = new Set(['replaced', 'rejected']);
const NOTE_FILE_RE = /^[a-z0-9]+(-[a-z0-9]+)*\.md$/;
const DATED_RE = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]/;

/** 'hard' above hard, 'warn' above warn, else null. */
function level(value, [warn, hard]) {
  if (value > hard) return 'hard';
  if (value > warn) return 'warn';
  return null;
}

function isInboxNote(n) {
  return n.area === 'inbox' || n.origArea === 'inbox';
}

function sectionHas(note, canon, cfg) {
  const names = new Set([cfg.sections[canon], cfg.enSections?.[canon], canon].map((s) => String(s).normalize('NFC').toLowerCase()));
  return note.headings.some((h) => h.level === 2 && names.has(h.text.normalize('NFC').toLowerCase()));
}

// ---------------------------------------------------------------------------------------------

class Collector {
  constructor(cfg, { strict, only, skip }) {
    this.cfg = cfg;
    this.strict = strict;
    this.only = only ? new Set(only) : null;
    this.skip = new Set(skip ?? []);
    this.list = [];
  }

  on(...codes) {
    return codes.some((c) => (!this.only || this.only.has(c)) && !this.skip.has(c));
  }

  /** add(code, where, vars, {level: 'warn'|'hard', key}) where = {rel, line, root} or a note. */
  add(code, where, vars = {}, { level: lvl, key } = {}) {
    if (!this.on(code)) return;
    const kind = KIND[code];
    let severity;
    if (kind === 'warn' || lvl === 'warn') severity = 'warning';
    else if (kind === 'system') severity = 'error';
    else severity = this.strict ? 'error' : 'warning';
    const f = {
      code,
      severity,
      rel: where.rel,
      line: where.line ?? 0,
      msg: this.cfg.t(key ?? `check.${code}`, vars),
    };
    if (where.root && where.root !== 'main') f.root = where.root;
    this.list.push(f);
  }
}

const at = (note, line) => ({ rel: note.rel, root: note.root, line: line ?? 0 });

// ---------------------------------------------------------------------------------------------
// Rule groups

function checkConfig(c, cfg) {
  for (const w of cfg.warnings) c.add('CONFIG', { rel: cfg.files.config }, { detail: w }, { level: 'warn' });
  for (const r of cfg.roots.slice(1)) {
    if (!r.exists) c.add('ROOT_MISSING', { rel: cfg.files.config }, { path: path.relative(cfg.root, r.path).split(path.sep).join('/') || r.path });
  }
}

function checkSecrets(c, cfg, vault, notesOnly) {
  const rels = notesOnly ? vault.inputs.map((i) => i.rel) : listTextFiles(cfg.root);
  for (const f of scanFiles(cfg.root, rels)) c.add('SECRET', { rel: f.rel, line: f.line }, { rule: f.rule, preview: f.preview });
}

function localSectorDirs(cfg, vault) {
  const { sectors, archive } = cfg.dirs;
  return vault.sectors.filter((s) => s.privacy === 'local').map((s) => ({
    id: s.id,
    prefixes: [`${sectors}/${s.id}/`, `${archive}/${sectors}/${s.id}/`],
    allowed: new Set([`_${s.id}.md`, `_${s.id}${cfg.exportSuffix}.md`]),
  }));
}

function checkLocalInGit(c, cfg, vault, notesOnly) {
  const locals = localSectorDirs(cfg, vault);
  if (!locals.length) return;
  const rels = notesOnly ? vault.inputs.map((i) => i.rel) : [...new Set([...vault.files.map((f) => f.rel), ...vault.inputs.map((i) => i.rel)])];
  for (const rel of rels.sort(cmp)) {
    for (const l of locals) {
      const prefix = l.prefixes.find((p) => rel.startsWith(p));
      if (prefix && !l.allowed.has(rel.slice(prefix.length))) c.add('LOCAL_IN_GIT', { rel });
    }
  }
}

function checkAdapters(c, cfg, vault) {
  const b = cfg.budgets;
  const agents = vault.otherFiles.agents;
  const rel = cfg.files.agents;
  if (agents === null) {
    c.add('AGENTS_MARKERS', { rel });
  } else {
    if (!agents.includes('<!-- kit:start') || !agents.includes('<!-- kit:end -->') || extractSearchBlock(agents) === null) {
      c.add('AGENTS_MARKERS', { rel });
    }
    const n = lineCount(agents);
    const lv = level(n, b.agents_lines);
    if (lv) c.add('AGENTS_SIZE', { rel }, { n, unit: 'lines' }, { level: lv });
    const ch = chars(agents);
    const lc = level(ch, b.agents_chars);
    if (lc) c.add('AGENTS_SIZE', { rel }, { n: ch, unit: 'chars' }, { level: lc });
  }
  for (const [file, text] of [[cfg.files.claude, vault.otherFiles.claude], [cfg.files.gemini, vault.otherFiles.gemini]]) {
    if (text === null) continue;
    const first = text.split('\n').find((l) => l.trim() !== '');
    if (!first || first.trim() !== '@AGENTS.md') c.add('ADAPTER_IMPORT', { rel: file, line: 1 });
  }
  if (vault.otherFiles.claude !== null) {
    const n = lineCount(vault.otherFiles.claude);
    const lv = level(n, b.claude_lines);
    if (lv) c.add('CLAUDE_SIZE', { rel: cfg.files.claude }, { n }, { level: lv });
  }
}

function checkFrontmatter(c, cfg, n) {
  const d = n.data;
  const k = cfg.keys;
  if (!n.fm.has) {
    if (n.fm.errors.length) for (const e of n.fm.errors) c.add('FM_PARSE', at(n, e.line), { detail: e.msg });
    else c.add('FM_MISSING', at(n, 1));
    return;
  }
  for (const e of n.fm.errors) c.add('FM_PARSE', at(n, e.line), { detail: e.msg });
  for (const orig of n.fm.foreignKeys) {
    const canon = cfg.keysRev[orig];
    c.add('FM_FOREIGN_KEY', at(n, n.fm.keyLines[canon]), { local: k[canon], foreign: orig });
  }
  for (const fv of n.fm.foreignValues) {
    c.add('FM_FOREIGN_KEY', at(n, n.fm.keyLines[fv.key]), { local: fv.local, foreign: fv.value });
  }
  const line = (key) => n.fm.keyLines[key] ?? 1;
  for (const key of ['type', 'status', 'description', 'updated']) {
    const v = d[key];
    if (v === null || v === undefined || String(v).trim() === '') c.add('FM_REQUIRED', at(n, line(key)), { key: k[key] });
  }
  if ((d.type === 'decision' || d.type === 'journal') && !(d.created && String(d.created).trim())) {
    c.add('FM_CREATED', at(n, line('created')), { key: k.created });
  }
  if (d.type && !CANON_TYPES.includes(d.type)) c.add('FM_TYPE', at(n, line('type')), { value: d.type });
  if (d.status && !CANON_STATUSES.includes(d.status)) c.add('FM_STATUS', at(n, line('status')), { value: d.status });
  for (const key of ['updated', 'created', 'valid_until', 'review_on']) {
    const v = d[key];
    if (v !== null && v !== '' && !isDate(v)) c.add('FM_DATE', at(n, line(key)), { key: k[key], value: v });
  }
}

function checkNaming(c, cfg, n) {
  const d = n.data;
  if (!n.isManifest && !n.isExport) {
    if (!NOTE_FILE_RE.test(`${n.name}.md`)) c.add('NAME_FORMAT', at(n));
    const plain = n.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    if (cfg.genericNames.has(n.name) || cfg.genericNames.has(plain)) c.add('NAME_GENERIC', at(n));
  }
  if (d.type === 'decision' || d.type === 'journal') {
    const m = DATED_RE.exec(n.name);
    if (!m || !isDate(m[1])) c.add('DATED_NAME', at(n));
  }
  const segs = n.dir.split('/');
  const inDecisions = segs.includes(cfg.dirs.decisions);
  if (d.type === 'decision' && !inDecisions) c.add('DECISION_PLACE', at(n), { dir: cfg.dirs.decisions });
  if (d.type && d.type !== 'decision' && CANON_TYPES.includes(d.type) && inDecisions) {
    c.add('DECISION_PLACE', at(n), { dir: cfg.dirs.decisions });
  }
  const inJournal = n.area === 'journal' || n.origArea === 'journal';
  if ((d.type === 'journal' && !inJournal) || (inJournal && d.type && d.type !== 'journal' && CANON_TYPES.includes(d.type))) {
    c.add('JOURNAL_PLACE', at(n), { dir: cfg.dirs.journal });
  }
}

function checkSizes(c, cfg, n) {
  const b = cfg.budgets;
  const d = n.data;
  if (d.description) {
    const len = chars(d.description);
    const lv = level(len, b.description_chars);
    if (lv) c.add('DESC_LONG', at(n, n.fm.keyLines.description), { n: len }, { level: lv });
  }
  if (n.area !== 'root') {
    const budget = ATOMIC_TYPES.includes(d.type) ? b.atomic_lines : b.document_lines;
    const lv = level(n.lines, budget);
    if (lv) c.add('NOTE_LONG', at(n), { n: n.lines, limit: lv === 'hard' ? budget[1] : budget[0] }, { level: lv });
  }
  if (n.chars > b.document_chars_warn) {
    c.add('NOTE_LONG', at(n), { n: n.chars, limit: b.document_chars_warn }, { level: 'warn', key: 'check.NOTE_LONG.chars' });
  }
  if (n.bytes > b.document_bytes_hard) {
    c.add('NOTE_LONG', at(n), { n: n.bytes, limit: b.document_bytes_hard }, { level: 'hard', key: 'check.NOTE_LONG.bytes' });
  }
  const ll = level(n.maxLineChars, b.line_chars);
  if (ll) c.add('LINE_LONG', at(n, n.maxLineAt), { n: n.maxLineChars }, { level: ll });
  const docType = d.type && CANON_TYPES.includes(d.type) && !ATOMIC_TYPES.includes(d.type)
    && !['hub', 'journal', 'sector'].includes(d.type);
  if (docType && !n.archived && n.lines > 100 && !sectionHas(n, 'contents', cfg)) {
    c.add('DOC_TOC', at(n), { heading: cfg.sections.contents });
  }
}

function checkTime(c, cfg, n, asOf, asOfSource) {
  const d = n.data;
  const k = cfg.keys;
  // With an explicit date any later date is suspect; with an inferred one only a clear outlier.
  const slack = asOfSource === 'notes' ? cfg.budgets.hot_days : 0;
  for (const key of ['updated', 'created']) {
    if (isDate(d[key]) && daysBetween(asOf, d[key]) > slack) {
      c.add('FM_DATE_FUTURE', at(n, n.fm.keyLines[key]), { key: k[key], value: d[key], asOf });
    }
  }
  if (n.archived) return;
  if (d.type === 'fact' && !INACTIVE.has(d.status) && !d.valid_until && !d.review_on) {
    c.add('FACT_VALIDITY', at(n, n.fm.keyLines.type), { k1: k.valid_until, k2: k.review_on });
  }
  if (d.status === 'active' && isDate(d.valid_until) && d.valid_until < asOf) {
    c.add('EXPIRED', at(n, n.fm.keyLines.valid_until), { date: d.valid_until });
  }
  if (!INACTIVE.has(d.status) && isDate(d.review_on) && d.review_on <= asOf) {
    c.add('REVIEW_DUE', at(n, n.fm.keyLines.review_on), { date: d.review_on });
  }
}

const inside = (base, p) => {
  const rel = path.relative(base, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** A '../' path that leaves the main root and lands in a local root (a private file by path). */
function pointsIntoLocalRoot(cfg, n, target) {
  if (!target.startsWith('../') && !target.startsWith('..\\')) return false;
  const absTarget = path.resolve(cfg.root, n.dir || '.', target);
  if (inside(cfg.root, absTarget)) return false;
  return cfg.roots.some((r) => r.id !== 'main' && inside(r.path, absTarget));
}

function checkLinks(c, cfg, vault, n, locals) {
  const d = n.data;
  const strip = (s) => (/\[\[([^[\]\n]+?)\]\]/.exec(s)?.[1] ?? s);
  if (c.on('REPLACED_LINK')) {
    const broken = (d.status === 'replaced' && !d.replaced_by)
      || (d.replaced_by && !resolveLink(vault, strip(d.replaced_by), n))
      || d.replaces.some((r) => !resolveLink(vault, strip(r), n));
    if (broken) c.add('REPLACED_LINK', at(n, n.fm.keyLines.replaced_by ?? n.fm.keyLines.replaces ?? n.fm.keyLines.status));
  }
  for (const link of n.links) {
    if (link.fm && (link.key === 'replaces' || link.key === 'replaced_by')) continue;
    const ext = path.posix.extname(link.target).toLowerCase();
    if (ext && ext !== '.md' && /^\.[a-z0-9]{1,5}$/.test(ext)) continue; // attachments, bases
    const target = resolveLink(vault, link.target, n);
    if (n.root === 'main') {
      if (target && target.root !== 'main') {
        c.add('PRIVACY_LINK', at(n, link.line), { target: link.target });
        continue;
      }
      if (!target && pointsIntoLocalRoot(cfg, n, link.target)) {
        c.add('PRIVACY_LINK', at(n, link.line), { target: link.target });
        continue;
      }
      if (!target && link.target.includes('/')) {
        const norm = path.posix.normalize(link.target.replace(/\.md$/i, '') + '.md');
        const intoLocal = locals.some((l) => {
          const p = l.prefixes.find((x) => norm.startsWith(x));
          return p && !l.allowed.has(norm.slice(p.length));
        });
        if (intoLocal) {
          c.add('PRIVACY_LINK', at(n, link.line), { target: link.target });
          continue;
        }
      }
    }
    if (!target && !n.archived) c.add('LINK_BROKEN', at(n, link.line), { target: link.target });
  }
}

function checkNotes(c, cfg, vault, asOf, asOfSource) {
  const locals = localSectorDirs(cfg, vault);
  for (const n of vault.notes) {
    if (isInboxNote(n)) {
      if (n.area === 'inbox') {
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(n.name);
        const date = m && isDate(m[1]) ? m[1] : isDate(n.data.created) ? n.data.created : null;
        if (date) {
          const days = daysBetween(date, asOf);
          if (days > cfg.budgets.inbox_days[0]) c.add('INBOX_AGE', at(n), { n: days });
        }
      }
      continue;
    }
    if (n.crlf) c.add('FM_CRLF', at(n));
    if (n.bom) c.add('FM_BOM', at(n));
    if (!n.nfc) c.add('NFC', at(n));
    checkFrontmatter(c, cfg, n);
    checkNaming(c, cfg, n);
    checkSizes(c, cfg, n);
    checkTime(c, cfg, n, asOf, asOfSource);
    if (c.on('LINK_BROKEN', 'PRIVACY_LINK', 'REPLACED_LINK')) checkLinks(c, cfg, vault, n, locals);
    for (const alias of n.data.aliases) {
      const other = (vault.byName.get(alias.toLowerCase()) ?? []).find((o) => o !== n);
      if (other) c.add('NAME_ALIAS_CLASH', at(n, n.fm.keyLines.aliases), { alias, other: other.rel });
    }
  }
  // Names are unique across the vault, archive and local roots included (inbox items excepted).
  const groups = new Map();
  for (const n of vault.notes) {
    if (isInboxNote(n)) continue;
    const key = n.name.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  for (const list of groups.values()) {
    for (const n of list.slice(1)) c.add('NAME_DUPLICATE', at(n), { other: list[0].rel });
  }
}

function checkSectors(c, cfg, vault) {
  const { sectors: sectorsDir, archive } = cfg.dirs;
  const k = cfg.keys;
  const withNotes = (prefix) => vault.notes.some((n) => n.root === 'main' && n.rel.startsWith(prefix))
    || vault.files.some((f) => f.rel.startsWith(prefix));
  for (const id of vault.sectorDirs) {
    const dir = `${sectorsDir}/${id}`;
    if (!NAME_RE.test(id) || id.length > SECTOR_ID_MAX) c.add('SECTOR_ID', { rel: dir });
    const manifestRel = `${dir}/_${id}.md`;
    if (!vault.byRel.has(manifestRel) && !fs.existsSync(path.join(cfg.root, ...manifestRel.split('/'))) && withNotes(`${dir}/`)) {
      c.add('SECTOR_NO_MANIFEST', { rel: dir }, { id });
    }
  }
  const hasLocalRoot = cfg.roots.some((r) => r.id !== 'main');
  let on = 0;
  for (const s of vault.sectors) {
    const m = s.manifest;
    const d = m.data;
    const raw = m.fm.data;
    const lineOf = (key) => m.fm.keyLines[key] ?? 1;
    if (s.dir.startsWith(`${archive}/`) && (!NAME_RE.test(s.id) || s.id.length > SECTOR_ID_MAX)) c.add('SECTOR_ID', { rel: s.dir });
    const detail = (key, text) => c.add('MANIFEST_FIELDS', at(m, lineOf(key)), { detail: text });
    if (d.type !== 'sector') detail('type', `${k.type} must be ${cfg.local('type', 'sector')}`);
    if (!d.state) detail('state', `missing ${k.state}`);
    else if (!CANON_STATES.includes(d.state)) detail('state', `invalid ${k.state} "${d.state}"`);
    if (!d.privacy) detail('privacy', `missing ${k.privacy}`);
    else if (!CANON_PRIVACY.includes(d.privacy)) detail('privacy', `invalid ${k.privacy} "${d.privacy}"`);
    if (!d.when_here) detail('when_here', `missing ${k.when_here}`);
    if (!d.not_here) detail('not_here', `missing ${k.not_here}`);
    const rawHot = raw[k.hot_max] ?? raw.hot_max;
    if (rawHot !== undefined && rawHot !== null && (d.hot_max === null || d.hot_max < 0 || d.hot_max > 20)) {
      detail('hot_max', `${k.hot_max} must be an integer 0–20`);
    }
    if (d.cleanup && d.cleanup !== 'none') detail('cleanup', `${k.cleanup} must be none`);
    for (const linked of d.links) {
      if (!vault.sectorById.has(linked)) detail('links', `unknown sector "${linked}" in ${k.links}`);
    }
    const inArchive = s.dir.startsWith(`${archive}/`);
    if ((s.state === 'off' && !inArchive) || (s.state !== 'off' && inArchive)) {
      c.add('SECTOR_STATE_PLACE', at(m, lineOf('state')), { state: cfg.local('state', s.state) });
    }
    if (d.keywords.length < 5) c.add('MANIFEST_KEYWORDS', at(m, lineOf('keywords')));
    if (s.privacy === 'local' && !hasLocalRoot) {
      c.add('ROOT_MISSING', at(m, lineOf('privacy')), { path: '(memory.json has no local root)' });
    }
    if (s.state === 'on') on++;
  }
  const lv = level(on, cfg.budgets.sectors_on);
  if (lv) c.add('SECTORS_ON', { rel: sectorsDir }, { n: on }, { level: lv });

  // Local roots: every sector folder there must belong to a local sector.
  const seen = new Set();
  for (const n of vault.notes) {
    if (n.root === 'main' || n.area !== 'sector' || !n.sector) continue;
    const s = vault.sectorById.get(n.sector);
    if (s && s.privacy === 'local') continue;
    const key = `${n.root}:${n.sector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    c.add('LOCAL_UNKNOWN_SECTOR', at(n), { id: n.sector });
  }
}

function checkHubs(c, cfg, vault) {
  const b = cfg.budgets;
  for (const rel of [cfg.files.state, cfg.files.waiting]) {
    const n = vault.byRel.get(rel);
    if (n && n.fm.has && n.data.type !== 'hub') c.add('HUB_TYPE', at(n, n.fm.keyLines.type ?? 1), { hub: cfg.local('type', 'hub') });
  }
  const state = vault.byRel.get(cfg.files.state);
  if (state) {
    const lv = level(state.lines, b.state_lines);
    if (lv) c.add('STATE_LONG', at(state), { n: state.lines }, { level: lv });
    const now = extractSection(state, 'now', cfg);
    const nowN = now ? now.lines.filter((l) => l.trim() !== '' && !/^\s*<!--.*-->\s*$/.test(l)).length : 0;
    if (nowN > b.now_lines) {
      c.add('STATE_LONG', at(state, now.line), { n: nowN, limit: b.now_lines }, { level: 'hard', key: 'check.STATE_LONG.now' });
    }
  }
  const waiting = vault.byRel.get(cfg.files.waiting);
  if (waiting) {
    const open = waitingOpen(cfg, waiting);
    const lv = level(open, b.waiting_open);
    if (lv) c.add('WAITING_OPEN', at(waiting), { n: open }, { level: lv });
  }
}

function checkAttachments(c, cfg, vault) {
  const b = cfg.budgets;
  const prefix = `${cfg.dirs.attachments}/`;
  let total = 0;
  for (const f of vault.files) {
    if (!f.rel.startsWith(prefix)) continue;
    total += f.size;
    const kb = Math.round(f.size / 1024);
    const lv = level(f.size, b.attachment_kb.map((x) => x * 1024));
    if (lv) c.add('ATTACHMENT_SIZE', { rel: f.rel }, { kb }, { level: lv });
  }
  if (total > b.attachments_total_mb * 1024 * 1024) {
    c.add('ATTACHMENT_SIZE', { rel: cfg.dirs.attachments }, { kb: Math.round(total / 1024) }, { level: 'hard' });
  }
}

async function checkGenerated(c, cfg, vault, today) {
  let ctx;
  let expected;
  try {
    ctx = await buildContext(cfg, vault, { today });
    expected = expectedFiles(cfg, vault, ctx);
  } catch (err) {
    if (err instanceof GenBudgetError || err?.code === 'GEN_BUDGET') {
      c.add('GEN_BUDGET', { rel: '_ai/start.md' }, { bytes: err.bytes ?? '?' });
    } else {
      c.add('GEN_FAILED', { rel: cfg.dirs.ai }, { detail: err?.message ?? String(err) });
    }
    return;
  }
  for (const [rel, text] of expected) {
    let current = null;
    try {
      current = fs.readFileSync(path.join(cfg.root, ...rel.split('/')), 'utf8');
    } catch {
      /* missing */
    }
    if (current === null) {
      c.add('GEN_MISSING', { rel });
      continue;
    }
    const v = verifyStamp(current);
    if (!v.ok) c.add('GEN_EDITED', { rel, line: 1 });
    else if (v.header.source !== ctx.source || current !== text) c.add('GEN_STALE', { rel, line: 1 });
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(cfg.root, cfg.dirs.ai), { withFileTypes: true })
      .filter((e) => e.isFile()).map((e) => e.name).sort(cmp);
  } catch {
    /* no _ai/ */
  }
  for (const name of names) {
    const rel = `${cfg.dirs.ai}/${name}`;
    if (!expected.has(rel) && !name.startsWith('.')) c.add('GEN_ORPHAN', { rel });
  }
  let gitignore = '';
  try {
    gitignore = fs.readFileSync(path.join(cfg.root, '.gitignore'), 'utf8');
  } catch {
    /* none */
  }
  if (gitignoreText(cfg, vault, gitignore) !== null) c.add('GITIGNORE_LOCAL', { rel: '.gitignore' });
  const start = expected.get('_ai/start.md');
  if (start && bytes(start) >= cfg.budgets.start_bytes[0]) c.add('START_BUDGET', { rel: '_ai/start.md' }, { bytes: bytes(start) });
  for (const [rel, text] of expected) {
    if (!rel.startsWith(`${cfg.dirs.ai}/index-`)) continue;
    if (lineCount(text) > cfg.budgets.index_lines[1] || chars(text) > cfg.budgets.index_chars) c.add('INDEX_SIZE', { rel });
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Runs the checks. Expects a vault loaded with roots 'all', archive and inbox.
 * GEN_* rules run only without `only` and without `notesOnly` (the recursion guard for alerts).
 */
export async function runChecks(cfg, vault, { strict = true, only, skip, notesOnly = false, today } = {}) {
  const c = new Collector(cfg, { strict, only, skip });
  if (c.on('CONFIG', 'ROOT_MISSING') && !notesOnly) checkConfig(c, cfg);
  if (c.on('SECRET')) checkSecrets(c, cfg, vault, notesOnly);
  if (c.on('LOCAL_IN_GIT')) checkLocalInGit(c, cfg, vault, notesOnly);
  if (!notesOnly) {
    const { asOf, source } = resolveAsOfInfo(cfg, vault, today);
    if (c.on('AGENTS_MARKERS', 'AGENTS_SIZE', 'ADAPTER_IMPORT', 'CLAUDE_SIZE')) checkAdapters(c, cfg, vault);
    checkNotes(c, cfg, vault, asOf, source);
    checkSectors(c, cfg, vault);
    checkHubs(c, cfg, vault);
    if (c.on('ATTACHMENT_SIZE')) checkAttachments(c, cfg, vault);
    if (!only && c.on(...GEN_CODES)) await checkGenerated(c, cfg, vault, today);
  }
  const sorted = c.list.sort((a, b) =>
    cmp(a.root ?? '', b.root ?? '') || cmp(a.rel, b.rel) || a.line - b.line || cmp(a.code, b.code) || cmp(a.msg, b.msg));
  return {
    errors: sorted.filter((f) => f.severity === 'error'),
    warnings: sorted.filter((f) => f.severity === 'warning'),
    notes: vault.notes.length,
  };
}

/** Human output (10.3): errors, then warnings, at most `max` lines, then the summary. */
export function formatFindings(result, cfg, { mode = 'strict', max = 200 } = {}) {
  const rows = [
    ...result.errors.map((f) => ['ERROR', f]),
    ...result.warnings.map((f) => ['WARN ', f]),
  ];
  const lines = rows.slice(0, max).map(([label, f]) => {
    const where = `${f.root ? `${f.root}:` : ''}${f.rel}${f.line > 0 ? `:${f.line}` : ''}`;
    return `${label} ${f.code} ${where} ${f.msg}`;
  });
  if (rows.length > max) lines.push(`(… ${rows.length - max} more)`);
  lines.push(cfg.t('check.summary', {
    errors: result.errors.length, warnings: result.warnings.length, notes: result.notes, mode,
  }));
  return lines.join('\n') + '\n';
}
