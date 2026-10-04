// Generators of the AI view: _ai/start.md, _ai/index-<id>.md, _ai/catalog.tsv, _ai/profile.md and
// .ignore (docs/architecture.md, section 8). Deterministic: no clock, no randomness, no mtimes, no
// git. Only notes of the main root are ever used, and never private content left in a local
// sector's main-root folder (loadVault marks it misplacedLocal; check reports it as LOCAL_IN_GIT).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headerLine, parseHeader, sourceFingerprint, stamp } from './fingerprint.mjs';
import { renameRetry, unlinkRetry } from './fsafe.mjs';
import { extractSection, resolveLink, waitingItems, waitingOpen } from './vault.mjs';
import {
  CANON_TYPES, bytes, chars, cmp, daysBetween, fenceTracker, isDate, lineCount, monthDay, replaceFile,
  truncate, uniq, writeIfChanged,
} from './util.mjs';

export class GenBudgetError extends Error {
  code = 'GEN_BUDGET';
  constructor(message, size) {
    super(message);
    this.bytes = size;
  }
}

const SEARCH_START = '<!-- search:start -->';
const SEARCH_END = '<!-- search:end -->';
const INACTIVE = new Set(['replaced', 'rejected']);
const START = '_ai/start.md';
const CATALOG = '_ai/catalog.tsv';
const PROFILE = '_ai/profile.md';
const CATALOG_COLUMNS = '# path\ttype\tstatus\tupdated\ttier\tdescription\tnames\tstems';

/** A note the generated views may show: of the main root and not private content of a local sector. */
const shared = (n) => n.root === 'main' && n.misplacedLocal !== true;

// ---------------------------------------------------------------------------------------------
// Inputs

/** Lines strictly between the search markers of AGENTS.md, trimmed of blank edges; or null. */
export function extractSearchBlock(agentsText) {
  if (typeof agentsText !== 'string') return null;
  const lines = agentsText.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes(SEARCH_START));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.includes(SEARCH_END));
  if (end < 0) return null;
  const block = lines.slice(start + 1, end);
  while (block.length && block[0].trim() === '') block.shift();
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  return block.length ? block.join('\n') : null;
}

// Two notes dated within this many days of each other confirm a date as the vault's "today".
const AS_OF_WINDOW = 14;

/**
 * The as-of date and where it came from: --today ('today'), the date in system/cleanup/last.txt
 * ('cleanup'), else the notes ('notes'): the newest note date (max of updated and created) that
 * another note confirms within AS_OF_WINDOW days, so one mistyped future date (2206 for 2026)
 * cannot move the whole vault's time. A vault with one dated note uses that date; none: 1970-01-01.
 */
export function resolveAsOfInfo(cfg, vault, today) {
  if (today !== undefined && today !== null) {
    if (!isDate(today)) throw new Error(`--today must be a real date YYYY-MM-DD, got "${today}"`);
    return { asOf: today, source: 'today' };
  }
  const last = vault.otherFiles?.lastCleanup;
  if (typeof last === 'string') {
    const first = last.split('\n')[0].trim().split(/\s+/)[0];
    if (isDate(first)) return { asOf: first, source: 'cleanup' };
  }
  const dates = [];
  for (const n of vault.notes) {
    if (!shared(n) || n.area === 'inbox') continue;
    const own = [n.data.updated, n.data.created].filter(isDate).sort(cmp);
    if (own.length) dates.push(own[own.length - 1]);
  }
  dates.sort((a, b) => cmp(b, a));
  for (let i = 0; i + 1 < dates.length; i++) {
    if (daysBetween(dates[i + 1], dates[i]) <= AS_OF_WINDOW) return { asOf: dates[i], source: 'notes' };
  }
  return { asOf: dates[0] ?? '1970-01-01', source: 'notes' };
}

/** --today, else system/cleanup/last.txt, else the newest confirmed note date (resolveAsOfInfo). */
export function resolveAsOf(cfg, vault, today) {
  return resolveAsOfInfo(cfg, vault, today).asOf;
}

const TEXT_MODULE = fileURLToPath(new URL('./text.mjs', import.meta.url));

/** The search builder's analyzer, or null when text.mjs is not installed. */
async function loadAnalyzer(cfg) {
  let mod;
  try {
    mod = await import('./text.mjs');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(`'${TEXT_MODULE}'`)) return null;
    throw err;
  }
  return typeof mod.analyzer === 'function' ? mod.analyzer(cfg) : null;
}

// ---------------------------------------------------------------------------------------------
// Hot set and tiers (8.2)

function linkTarget(s) {
  const m = /\[\[([^[\]\n]+?)\]\]/.exec(String(s));
  return m ? m[1] : String(s);
}

function noteDate(n) {
  return isDate(n.data.updated) ? n.data.updated : isDate(n.data.created) ? n.data.created : null;
}

function isExpired(n, asOf) {
  return isDate(n.data.valid_until) && n.data.valid_until < asOf;
}

/** Ordered hot notes of on-sectors (optionally only the given sector ids), capped by budgets. */
export function computeHot(cfg, vault, asOf, onlySectors = null) {
  const b = cfg.budgets;
  const onSectors = new Map(vault.sectors.filter((s) => s.state === 'on').map((s) => [s.id, s]));
  const used = new Set();
  for (const j of vault.notes) {
    if (j.root !== 'main' || j.area !== 'journal' || !isDate(j.data.created)) continue;
    if (daysBetween(j.data.created, asOf) > b.hot_days) continue;
    for (const item of [...j.data.used, ...j.data.changed]) {
      const target = resolveLink(vault, linkTarget(item), j);
      if (target) used.add(target.rel);
    }
  }
  const candidates = vault.notes.filter((n) =>
    shared(n) && n.area === 'sector' && onSectors.has(n.sector) && !n.isManifest && !n.isExport
    && !INACTIVE.has(n.data.status) && n.rel !== cfg.profile
    && (!onlySectors || onlySectors.has(n.sector)));
  const hot = candidates.filter((n) => {
    if (n.data.pin) return true;
    const d = noteDate(n);
    if (d && daysBetween(d, asOf) <= b.hot_days) return true;
    return used.has(n.rel);
  });
  hot.sort((a, b2) => (Number(b2.data.pin) - Number(a.data.pin))
    || cmp(noteDate(b2) ?? '', noteDate(a) ?? '') || cmp(a.rel, b2.rel));
  const perSector = new Map();
  const out = [];
  for (const n of hot) {
    if (out.length >= b.hot_total) break;
    const count = perSector.get(n.sector) ?? 0;
    if (count >= onSectors.get(n.sector).hot_max) continue;
    perSector.set(n.sector, count + 1);
    out.push(n);
  }
  return out;
}

export async function buildContext(cfg, vault, { today } = {}) {
  const asOf = resolveAsOf(cfg, vault, today);
  const source = sourceFingerprint(vault, asOf, cfg.kitVersion);
  const analyzer = await loadAnalyzer(cfg);
  const hotList = computeHot(cfg, vault, asOf);
  const hot = new Set(hotList.map((n) => n.rel));
  const coldDays = cfg.budgets.cold_days;
  const tier = (note) => {
    if (note.archived) return 'archive';
    if (note.root === 'main' && hot.has(note.rel)) return 'hot';
    if (!note.data.pin && isDate(note.data.updated) && daysBetween(note.data.updated, asOf) > coldDays) return 'cold';
    return 'warm';
  };

  // Alerts depend only on main-root inputs, so start.md is the same on every machine.
  const { runChecks } = await import('./check.mjs');
  const found = await runChecks(cfg, vault, { only: ['SECRET', 'LOCAL_IN_GIT'], notesOnly: true, today: asOf });
  const alerts = [...found.errors, ...found.warnings]
    .sort((a, b) => cmp(a.rel, b.rel) || a.line - b.line || cmp(a.code, b.code));

  const inboxPrefix = `${cfg.dirs.inbox}/`;
  const counts = {
    notes: vault.notes.filter((n) => shared(n) && (n.area === 'sector' || n.area === 'journal') && !n.isManifest && !n.isExport).length,
    sectors: vault.sectors.filter((s) => s.state !== 'off').length,
    inbox: vault.inputs.filter((i) => i.rel.startsWith(inboxPrefix) && i.rel.endsWith('.md')).length,
    waiting: waitingOpen(cfg, vault.byRel.get(cfg.files.waiting)),
  };
  return {
    asOf,
    source,
    analyzer,
    hot,
    hotList,
    tier,
    searchBlock: extractSearchBlock(vault.otherFiles.agents) ?? '',
    alerts,
    counts,
    kitVersion: cfg.kitVersion,
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers for rendering

const oneLine = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const cell = (s, max) => truncate(oneLine(s), max).replace(/\|/g, '\\|');

function localType(cfg, t) {
  return t && CANON_TYPES.includes(t) ? cfg.local('type', t) : String(t ?? '');
}

function localStatus(cfg, s) {
  return s ? cfg.local('status', s) : '';
}

function finish(body, ctx, prefix = '', suffix = '') {
  const text = body.normalize('NFC').replace(/\n*$/, '\n');
  return stamp(text, { source: ctx.source, asOf: ctx.asOf, prefix, suffix });
}

// ---------------------------------------------------------------------------------------------
// _ai/start.md (8.3)

function alertLines(cfg, alerts) {
  const line = (f) => {
    const where = f.line > 0 ? `${f.rel}:${f.line}` : f.rel;
    return f.code === 'SECRET' ? `- SECRET ${where} ${cfg.t('start.value_hidden')}` : `- ${f.code} ${where} ${f.msg}`;
  };
  if (alerts.length <= 5) return alerts.map(line);
  return [...alerts.slice(0, 4).map(line), `- ${cfg.t('start.alerts_more', { n: alerts.length - 4 })}`];
}

function sectorRow(cfg, s) {
  const sleeping = s.state === 'sleep';
  if (s.privacy === 'local') {
    const file = `_${s.id}${cfg.exportSuffix}.md`;
    const notes = sleeping ? cfg.t('start.sleeping') : '–';
    return `| ${s.id} | ${cell(cfg.t('start.local', { file }), 60)} | ${cell(s.when_here, 60)} | ${notes} | – |`;
  }
  const notes = sleeping ? cfg.t('start.sleeping') : String(s.notes);
  return `| ${s.id} | ${cell(s.description, 60)} | ${cell(s.when_here, 60)} | ${notes} | ${monthDay(s.lastUpdated)} |`;
}

/** Sectors shown in start.md: on first, then sleeping; off never. */
function startSectors(vault, filter) {
  const rank = { on: 0, sleep: 1 };
  return vault.sectors
    .filter((s) => s.state !== 'off' && (!filter || filter.has(s.id)))
    .sort((a, b) => rank[a.state] - rank[b.state] || cmp(a.id, b.id));
}

function profileLead(cfg, vault) {
  const note = cfg.profile ? vault.byRel.get(cfg.profile) : null;
  return note && shared(note) ? note.lead.map((l) => oneLine(l)).filter(Boolean) : [];
}

function nowLines(cfg, vault) {
  const state = vault.byRel.get(cfg.files.state);
  const section = state ? extractSection(state, 'now', cfg) : null;
  if (!section) return [];
  return section.lines
    .filter((l) => l.trim() !== '' && !/^\s*<!--.*-->\s*$/.test(l))
    .map((l) => truncate(l.replace(/\s+$/, ''), 160));
}

export function renderStart(cfg, vault, ctx, { sectors } = {}) {
  const t = cfg.t;
  const b = cfg.budgets;
  const filter = sectors && sectors.length ? new Set(sectors) : null;
  const hotNotes = filter || !ctx.hotList ? computeHot(cfg, vault, ctx.asOf, filter) : ctx.hotList;
  const hot = hotNotes.map((n) =>
    `- ${n.rel} · ${localType(cfg, n.data.type)} · ${localStatus(cfg, n.data.status)} · ${truncate(oneLine(n.data.description), b.start_desc_chars)}`);
  const now = nowLines(cfg, vault).slice(0, b.now_lines);
  const profile = profileLead(cfg, vault).slice(0, 6).map((l) => `- ${truncate(l, 160)}`);

  const sectorList = startSectors(vault, filter);
  const sleeping = sectorList.filter((s) => s.state === 'sleep').map((s) => s.id);
  // sleepMode 0: a table row per sleeping sector; 1: their ids on one line; 2: as many ids as fit.
  const fixedTop = (sleepMode, sleepShown) => {
    const blocks = [[`# ${t('start.title')}`, t('start.summary', { notes: ctx.counts.notes, sectors: ctx.counts.sectors, asOf: ctx.asOf })]];
    if (ctx.alerts.length) blocks.push([`## ${t('start.alerts')}`, ...alertLines(cfg, ctx.alerts)]);
    if (ctx.searchBlock) blocks.push([`## ${t('start.search')}`, ctx.searchBlock]);
    if (cfg.startSafety.length) blocks.push([`## ${t('start.safety')}`, ...cfg.startSafety]);
    const rows = sectorList.filter((s) => sleepMode === 0 || s.state !== 'sleep').map((s) => sectorRow(cfg, s));
    const table = rows.length ? [
      `| ${t('start.col_sector')} | ${t('start.col_what')} | ${t('start.col_when')} | ${t('start.col_notes')} | ${t('start.col_updated')} |`,
      '|---|---|---|---|---|',
      ...rows,
    ] : [];
    const asleep = [];
    if (sleepMode > 0 && sleeping.length) {
      const shown = sleeping.slice(0, sleepShown);
      const more = sleeping.length - shown.length;
      asleep.push(t('start.sleeping_list', { n: sleeping.length, ids: `${shown.join(', ')}${more ? ` … +${more}` : ''}` }));
    }
    if (table.length || asleep.length) blocks.push([`## ${t('start.sectors')}`, ...table, ...asleep]);
    return blocks;
  };
  const counts = t('start.counts', {
    waiting: ctx.counts.waiting, file: cfg.files.waiting, inbox: ctx.counts.inbox, version: ctx.kitVersion,
  });

  let sleepMode = 0;
  let sleepShown = sleeping.length;
  const build = (hotN, nowN, profN) => {
    const blocks = [...fixedTop(sleepMode, sleepShown)];
    if (profN > 0) blocks.push([`## ${t('start.profile', { rel: cfg.profile })}`, ...profile.slice(0, profN)]);
    if (hotN > 0) blocks.push([`## ${t('start.hot', { days: b.hot_days, asOf: ctx.asOf, max: b.hot_total })}`, ...hot.slice(0, hotN)]);
    if (nowN > 0) blocks.push([`## ${t('start.now', { file: cfg.files.state })}`, ...now.slice(0, nowN)]);
    blocks.push([counts]);
    return finish(blocks.map((lines) => lines.join('\n')).join('\n\n'), ctx);
  };

  const limit = b.start_bytes[1];
  let [hotN, nowN, profN] = [hot.length, now.length, profile.length];
  let text = build(hotN, nowN, profN);
  // Sleeping sectors are the cheapest to fold: their ids stay, their table rows go first.
  if (bytes(text) > limit && sleeping.length) {
    sleepMode = 1;
    text = build(hotN, nowN, profN);
  }
  const shrink = (get, set, floor) => {
    while (bytes(text) > limit && get() > floor) {
      set(get() - 1);
      text = build(hotN, nowN, profN);
    }
  };
  shrink(() => hotN, (v) => { hotN = v; }, 5);
  shrink(() => nowN, (v) => { nowN = v; }, 5);
  shrink(() => profN, (v) => { profN = v; }, 2);
  shrink(() => hotN, (v) => { hotN = v; }, 0);
  shrink(() => nowN, (v) => { nowN = v; }, 0);
  shrink(() => profN, (v) => { profN = v; }, 0);
  if (sleepMode === 1) {
    sleepMode = 2;
    shrink(() => sleepShown, (v) => { sleepShown = v; }, 0);
  }
  if (bytes(text) > limit) {
    throw new GenBudgetError(`_ai/start.md needs ${bytes(text)} bytes, the budget is ${limit}`, bytes(text));
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// _ai/index-<id>.md (8.4)

function sectorRulesLine(cfg, sector) {
  const section = extractSection(sector.manifest, 'sector_rules', cfg);
  if (!section) return null;
  const items = [];
  const step = fenceTracker();
  for (const line of section.lines) {
    if (step(line).inside) continue;
    const m = /^\s*(?:\d+[.)]|[-*+])\s+(.+?)\s*$/.exec(line);
    if (m) items.push(m[1]);
  }
  if (!items.length) return null;
  return truncate(`${cfg.t('index.rules')}: ${items.map((x, i) => `${i + 1}) ${x}`).join(' ')}`, 600);
}

function indexedNotes(vault, sector, asOf) {
  return vault.notes.filter((n) => shared(n) && n.rel.startsWith(`${sector.dir}/`) && !n.archived
    && !n.isManifest && !n.isExport && !INACTIVE.has(n.data.status)
    && CANON_TYPES.includes(n.data.type) && n.data.type !== 'sector' && n.data.type !== 'hub'
    && !(n.data.type === 'fact' && isExpired(n, asOf)));
}

export function renderSectorIndex(cfg, vault, ctx, sectorId) {
  const t = cfg.t;
  const b = cfg.budgets;
  const sector = vault.sectorById.get(sectorId);
  if (!sector) throw new Error(`unknown sector ${sectorId}`);
  const asOf = ctx.asOf;
  const notes = indexedNotes(vault, sector, asOf);

  const groups = [];
  for (const type of CANON_TYPES) {
    const list = notes.filter((n) => n.data.type === type);
    if (!list.length) continue;
    const key = (n) => {
      const d = type === 'decision' ? (isDate(n.data.created) ? n.data.created : n.data.updated) : n.data.updated;
      return isDate(d) ? d : '';
    };
    list.sort((a, c) => cmp(key(c), key(a)) || cmp(a.rel, c.rel));
    const rows = list.map((n) => {
      const parts = [n.rel.slice(sector.dir.length + 1)];
      if (type !== 'decision' || n.data.status !== 'active') parts.push(localStatus(cfg, n.data.status));
      parts.push(monthDay(n.data.updated));
      if (ctx.hot.has(n.rel)) parts.push(t('index.hot'));
      if (isDate(n.data.review_on) && n.data.review_on <= asOf) parts.push(t('index.verify'));
      parts.push(truncate(oneLine(n.data.description), b.index_desc_chars));
      return parts.join(' · ');
    });
    groups.push({ type, label: localType(cfg, type), rows, shown: rows.length });
  }

  // Cross-links to notes of other sectors.
  const cross = new Set();
  for (const n of [sector.manifest, ...notes]) {
    for (const link of n.links) {
      const target = resolveLink(vault, link.target, n);
      if (!target || !shared(target) || target.archived || !target.sector || target.sector === sector.id) continue;
      cross.add(`${n.name} → ${target.sector}/${target.name}`);
    }
  }
  const crossLines = [...cross].sort(cmp).slice(0, 15);

  const own = vault.notes.filter((n) => shared(n) && n.rel.startsWith(`${sector.dir}/`) && !n.archived && !n.isManifest && !n.isExport);
  const outside = t('index.outside', {
    replaced: own.filter((n) => n.data.status === 'replaced').length,
    rejected: own.filter((n) => n.data.status === 'rejected').length,
    expired: own.filter((n) => n.data.type === 'fact' && !INACTIVE.has(n.data.status) && isExpired(n, asOf)).length,
    archived: vault.notes.filter((n) => shared(n) && n.archived && n.sector === sector.id && !n.isManifest && !n.isExport).length,
  });

  const head = [`# ${t('index.title', { sector: sector.id, notes: sector.notes, dir: sector.dir })}`];
  const rules = sectorRulesLine(cfg, sector);
  if (rules) head.push(rules);
  if (sector.links.length) head.push(`${t('index.linked')}: ${sector.links.join(', ')}`);
  head.push(`${t('index.search')}: \`node system/memory.mjs search "${t('index.query')}" --sector ${sector.id}\` · ${t('index.fallback')} \`rg -il '${t('index.stem')}' ${sector.dir}/\``);

  const build = () => {
    const lines = [...head, ''];
    for (const g of groups) {
      lines.push(`## ${g.label}`, ...g.rows.slice(0, g.shown));
      if (g.shown < g.rows.length) {
        lines.push(t('index.more', { n: g.rows.length - g.shown, sector: sector.id, type: g.label }));
      }
    }
    if (crossLines.length) lines.push(`## ${t('index.cross')}`, ...crossLines);
    lines.push(`## ${outside}`);
    return finish(lines.join('\n'), ctx);
  };

  // Trim the largest group from its end until the file fits. Sizes are tracked incrementally
  // (prefix sums per group) so a big sector does not rebuild the file once per removed row.
  const lineLen = (s) => chars(s) + 1;
  const moreLen = (g) => lineLen(t('index.more', { n: g.rows.length - g.shown, sector: sector.id, type: g.label }));
  const header = headerLine({ source: ctx.source, content: '0'.repeat(12), asOf });
  const fixed = [header, ...head, '', ...(crossLines.length ? [`## ${t('index.cross')}`, ...crossLines] : []), `## ${outside}`];
  const fixedLines = fixed.length;
  const fixedChars = fixed.reduce((sum, l) => sum + lineLen(l), 0);
  for (const g of groups) {
    g.labelLen = lineLen(`## ${g.label}`);
    g.prefix = [0];
    for (const row of g.rows) g.prefix.push(g.prefix[g.prefix.length - 1] + lineLen(row));
  }
  const measure = () => {
    let lines = fixedLines;
    let size = fixedChars;
    for (const g of groups) {
      const more = g.shown < g.rows.length;
      lines += 1 + g.shown + (more ? 1 : 0);
      size += g.labelLen + g.prefix[g.shown] + (more ? moreLen(g) : 0);
    }
    return { lines, size };
  };
  const fitsBudget = ({ lines, size }) => lines <= b.index_lines[1] && size <= b.index_chars;
  const trimOne = () => {
    let biggest = null;
    for (const g of groups) if (g.shown > 0 && (!biggest || g.shown > biggest.shown)) biggest = g;
    if (!biggest) return false; // nothing left to trim; check reports INDEX_SIZE
    biggest.shown--;
    return true;
  };
  while (!fitsBudget(measure()) && trimOne());
  let text = build();
  // Safety net for anything the estimate cannot see (for example NFC normalization).
  while (!fitsBudget({ lines: lineCount(text), size: chars(text) }) && trimOne()) text = build();
  return text;
}

// ---------------------------------------------------------------------------------------------
// _ai/catalog.tsv (8.5)

function fitRow(cols, max) {
  const [rel, type, status, updated, tier] = cols;
  let [desc, names, stems] = [cols[5], cols[6], cols[7]];
  const row = () => [rel, type, status, updated, tier, desc, names.join('|'), stems.join(' ')].join('\t');
  while (chars(row()) > max && stems.length) stems = stems.slice(0, -1);
  while (chars(row()) > max && names.length) names = names.slice(0, -1);
  if (chars(row()) > max) {
    const fixed = chars(row()) - chars(desc);
    desc = max - fixed >= 1 ? truncate(desc, max - fixed) : '';
  }
  return row();
}

export function renderCatalog(cfg, vault, ctx) {
  const max = cfg.budgets.catalog_row_chars;
  const lines = [CATALOG_COLUMNS];
  // Stopwords and one-letter stems never help an rg lookup; they only eat the row budget.
  const fold = (s) => s.normalize('NFC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  const stop = new Set([...cfg.stopwords].map(fold));
  const useful = (s) => s && [...s].length > 1 && !stop.has(s);
  const notes = vault.notes
    .filter((n) => shared(n) && n.area !== 'inbox' && n.origArea !== 'inbox')
    .sort((a, b) => cmp(a.rel, b.rel));
  for (const n of notes) {
    const d = n.data;
    const names = uniq([n.title, ...d.aliases, ...d.keywords].map(oneLine).filter(Boolean));
    const stemSource = [n.name.replace(/-/g, ' '), n.title, ...d.aliases, ...d.keywords, d.description]
      .filter(Boolean).join(' ');
    const stems = ctx.analyzer ? ctx.analyzer.stems(stemSource).filter(useful) : [];
    lines.push(fitRow([
      n.rel,
      oneLine(localType(cfg, d.type)),
      oneLine(localStatus(cfg, d.status)),
      isDate(d.updated) ? d.updated : oneLine(d.updated ?? ''),
      cfg.local('tier', ctx.tier(n)),
      oneLine(d.description),
      names.map((s) => s.replace(/\|/g, '/')),
      stems,
    ], max));
  }
  return finish(lines.join('\n'), ctx, '# ');
}

// ---------------------------------------------------------------------------------------------
// _ai/profile.md (8.6)

export function renderProfile(cfg, vault, ctx) {
  const t = cfg.t;
  const limit = cfg.budgets.profile_chars;
  let lead = profileLead(cfg, vault);
  const sectors = vault.sectors.filter((s) => s.state === 'on' && s.privacy === 'github');
  const described = sectors.map((s) => ({ id: s.id, desc: truncate(oneLine(s.description), 80) }));

  const body = () => {
    const lines = [`# ${t('profile.title')}`, ...lead];
    if (described.length) {
      lines.push(`${t('profile.sectors')}: ${described.map((s) => (s.desc ? `${s.id} (${s.desc})` : s.id)).join('; ')}`);
    }
    lines.push(t('profile.memory'));
    return lines.join('\n').normalize('NFC') + '\n';
  };
  for (let i = described.length - 1; i >= 0 && chars(body()) > limit; i--) described[i].desc = '';
  while (chars(body()) > limit && lead.length) lead = lead.slice(0, -1);
  return finish(body(), ctx);
}

// ---------------------------------------------------------------------------------------------
// .ignore (8.7)

export function renderIgnore(cfg, vault, ctx) {
  const lines = [`# ${cfg.t('ignore.comment')}`, `${cfg.dirs.archive}/`, `/${cfg.files.home}`];
  for (const s of vault.sectors) {
    if (s.state === 'sleep' && !s.dir.startsWith(`${cfg.dirs.archive}/`)) lines.push(`${s.dir}/`);
  }
  return finish(lines.join('\n'), ctx, '# ');
}

// ---------------------------------------------------------------------------------------------
// Home page for people (8.8): plain markdown with ordinary relative links, readable on GitHub,
// in any editor and on a phone. Generated like _ai/, so it is never edited by hand.

const HOME_RECENT = 25;
const HOME_DECISIONS = 10;
const HOME_WAITING = 10;

const mdLink = (text, rel) => `[${String(text).replace(/[[\]]/g, '')}](${encodeURI(rel)})`;

export function renderHome(cfg, vault, ctx) {
  const t = cfg.t;
  const inbox = cfg.dirs.inbox;
  const lines = [
    `# ${t('home.title')}`,
    `> ${t('home.lead', { inbox })}`,
    '',
    t('home.summary', { notes: ctx.counts.notes, sectors: ctx.counts.sectors, asOf: ctx.asOf }),
  ];

  const now = nowLines(cfg, vault);
  lines.push('', `## ${t('home.now')} · ${mdLink(cfg.files.state, cfg.files.state)}`, ...(now.length ? now : ['–']));

  const open = waitingItems(cfg, vault.byRel.get(cfg.files.waiting)).filter((x) => x.open);
  lines.push('', `## ${t('home.waiting', { n: open.length })} · ${mdLink(cfg.files.waiting, cfg.files.waiting)}`);
  lines.push(...(open.length ? open.slice(0, HOME_WAITING).map((x) => `- ${oneLine(x.title)}`) : ['–']));
  if (open.length > HOME_WAITING) lines.push(`- … +${open.length - HOME_WAITING}`);

  const live = vault.sectors.filter((s) => s.state !== 'off');
  if (live.length) {
    lines.push('', `## ${t('home.sectors')}`,
      `| ${t('home.col_sector')} | ${t('home.col_state')} | ${t('home.col_privacy')} | ${t('home.col_what')} | ${t('home.col_notes')} | ${t('home.col_updated')} |`,
      '|---|---|---|---|---|---|');
    const indexed = new Set(indexedSectors(vault).map((s) => s.id));
    for (const s of live) {
      const local = s.privacy === 'local';
      const name = mdLink(s.title || s.id, s.manifest.rel);
      const overview = indexed.has(s.id) ? ` · ${mdLink(t('home.overview'), `${cfg.dirs.ai}/index-${s.id}.md`)}` : '';
      lines.push(`| ${name}${overview} | ${cfg.local('state', s.state)} | ${cfg.local('privacy', s.privacy)} | ${cell(local ? t('home.local_row') : s.description, 100)} | ${local ? '–' : s.notes} | ${local ? '–' : s.lastUpdated ?? '–'} |`);
    }
  }

  const githubLive = new Set(live.filter((s) => s.privacy === 'github').map((s) => s.id));
  const shown = (n) => shared(n) && !n.archived && !n.isManifest && !n.isExport
    && !INACTIVE.has(n.data.status) && CANON_TYPES.includes(n.data.type)
    && ((n.area === 'sector' && githubLive.has(n.sector)) || n.area === 'journal');
  const byDate = (key) => (a, b) => cmp(b.data[key] ?? '', a.data[key] ?? '') || cmp(a.rel, b.rel);
  const recent = vault.notes.filter((n) => shown(n) && n.data.type !== 'decision' && isDate(n.data.updated)).sort(byDate('updated'));
  if (recent.length) {
    lines.push('', `## ${t('home.recent')}`,
      `| ${t('home.col_note')} | ${t('home.col_type')} | ${t('home.col_status')} | ${t('home.col_updated')} | ${t('home.col_what')} |`,
      '|---|---|---|---|---|');
    for (const n of recent.slice(0, HOME_RECENT)) {
      lines.push(`| ${mdLink(n.title || n.name, n.rel)} | ${localType(cfg, n.data.type)} | ${localStatus(cfg, n.data.status)} | ${n.data.updated} | ${cell(n.data.description, 100)} |`);
    }
    if (recent.length > HOME_RECENT) lines.push('', t('home.more', { n: recent.length - HOME_RECENT }));
  }

  const decisions = vault.notes.filter((n) => shown(n) && n.data.type === 'decision' && n.data.status === 'active')
    .sort((a, b) => cmp(b.data.created ?? b.data.updated ?? '', a.data.created ?? a.data.updated ?? '') || cmp(a.rel, b.rel));
  if (decisions.length) {
    lines.push('', `## ${t('home.decisions')}`);
    for (const n of decisions.slice(0, HOME_DECISIONS)) {
      lines.push(`- ${mdLink(n.title || n.name, n.rel)} · ${n.sector ?? '–'} · ${isDate(n.data.created) ? n.data.created : '–'}`);
    }
    if (decisions.length > HOME_DECISIONS) lines.push(`- ${t('home.more', { n: decisions.length - HOME_DECISIONS })}`);
  }

  lines.push('', `## ${t('home.inbox', { n: ctx.counts.inbox })} · ${mdLink(`${inbox}/`, `${inbox}/`)}`);
  return finish(lines.join('\n'), ctx, '<!-- ', ' -->');
}

// ---------------------------------------------------------------------------------------------
// .gitignore block for local sectors (6.3): a second layer behind LOCAL_IN_GIT. Git then ignores
// everything in a local sector's main-root folder except its manifest and export file, also on
// phones and with --no-verify, where no hook runs.

const GITIGNORE_START = '# memory-kit:local-sectors start (maintained by the kit; edit the sectors, not this block)';
const GITIGNORE_END = '# memory-kit:local-sectors end';

/** The managed .gitignore lines for the local sectors of a vault ([] when there are none). */
export function gitignoreBlock(cfg, vault) {
  const { sectors, archive } = cfg.dirs;
  const ids = uniq(vault.sectors.filter((s) => s.privacy === 'local').map((s) => s.id)).sort(cmp);
  if (!ids.length) return [];
  const lines = [GITIGNORE_START];
  for (const id of ids) {
    for (const dir of [`${sectors}/${id}`, `${archive}/${sectors}/${id}`]) {
      lines.push(`/${dir}/*`, `!/${dir}/_${id}.md`, `!/${dir}/_${id}${cfg.exportSuffix}.md`);
    }
  }
  lines.push(GITIGNORE_END);
  return lines;
}

/** .gitignore with the managed block replaced (or appended, or removed); null when unchanged. */
export function gitignoreText(cfg, vault, current) {
  const text = String(current ?? '').replace(/\r\n/g, '\n');
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const start = lines.indexOf(GITIGNORE_START);
  const end = start >= 0 ? lines.indexOf(GITIGNORE_END, start) : -1;
  const block = gitignoreBlock(cfg, vault);
  let out;
  if (start >= 0 && end >= 0) {
    const before = lines.slice(0, start);
    const after = lines.slice(end + 1);
    if (!block.length) {
      while (before.length && before[before.length - 1] === '') before.pop();
    }
    out = [...before, ...block, ...after];
  } else {
    if (!block.length) return null;
    out = [...lines, ...(lines.length && lines[lines.length - 1] !== '' ? [''] : []), ...block];
  }
  const next = out.length ? `${out.join('\n')}\n` : '';
  return next === text ? null : next;
}

/** Writes the managed block into .gitignore; returns true when the file changed. */
export function syncGitignore(cfg, vault) {
  const abs = path.join(cfg.root, '.gitignore');
  let current = '';
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    /* no .gitignore yet */
  }
  const next = gitignoreText(cfg, vault, current);
  if (next === null) return false;
  // Atomic: a half-written .gitignore would drop the block that keeps local notes out of git.
  replaceFile(abs, next);
  return true;
}

// ---------------------------------------------------------------------------------------------
// All generated files

/** Sectors that get an _ai/index-<id>.md: privacy github, state on or sleep. */
export function indexedSectors(vault) {
  return vault.sectors.filter((s) => s.privacy === 'github' && (s.state === 'on' || s.state === 'sleep'));
}

export function expectedFiles(cfg, vault, ctx) {
  const files = new Map();
  files.set(START, renderStart(cfg, vault, ctx));
  for (const s of indexedSectors(vault)) files.set(`_ai/index-${s.id}.md`, renderSectorIndex(cfg, vault, ctx, s.id));
  files.set(CATALOG, renderCatalog(cfg, vault, ctx));
  files.set(PROFILE, renderProfile(cfg, vault, ctx));
  files.set(cfg.files.ignore, renderIgnore(cfg, vault, ctx));
  files.set(cfg.files.home, renderHome(cfg, vault, ctx));
  return files;
}

/** Nothing is deleted: a hand-written home note (older vaults) moves to the archive first. */
function keepHandWrittenHome(cfg, written) {
  const abs = path.join(cfg.root, cfg.files.home);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return;
  }
  // Only a note (frontmatter first) counts as hand-written; a generated page or one with merge
  // conflict markers is simply regenerated.
  const plain = text.replace(/^\uFEFF/, '');
  if (parseHeader(plain.split(/\r?\n/)[0]) || !/^---\r?\n/.test(plain)) return;
  const base = cfg.files.home.replace(/\.md$/, '');
  let rel = `${cfg.dirs.archive}/${base}-hand-written.md`;
  for (let i = 2; fs.existsSync(path.join(cfg.root, ...rel.split('/'))); i++) rel = `${cfg.dirs.archive}/${base}-hand-written-${i}.md`;
  fs.mkdirSync(path.join(cfg.root, cfg.dirs.archive), { recursive: true });
  renameRetry(abs, path.join(cfg.root, ...rel.split('/')));
  written.push(rel);
}

/**
 * Renders every generated file and writes those whose bytes changed; removes stale
 * _ai/index-*.md files. Nothing is written when a renderer throws.
 * Returns {written, removed, unchanged} as arrays of rel paths, plus asOf and source.
 */
export async function writeGenerated(cfg, vault, { today } = {}) {
  const ctx = await buildContext(cfg, vault, { today });
  const files = expectedFiles(cfg, vault, ctx);
  const written = [];
  const unchanged = [];
  const removed = [];
  keepHandWrittenHome(cfg, written);
  for (const [rel, text] of files) {
    const abs = path.join(cfg.root, ...rel.split('/'));
    (writeIfChanged(abs, text) ? written : unchanged).push(rel);
  }
  if (syncGitignore(cfg, vault)) written.push('.gitignore');
  const aiDir = path.join(cfg.root, cfg.dirs.ai);
  let names = [];
  try {
    names = fs.readdirSync(aiDir).sort(cmp);
  } catch {
    /* no _ai/ yet */
  }
  for (const name of names) {
    const rel = `${cfg.dirs.ai}/${name}`;
    if (/^index-.+\.md$/.test(name) && !files.has(rel)) {
      unlinkRetry(path.join(aiDir, name));
      removed.push(rel);
    }
  }
  return { written, removed, unchanged, asOf: ctx.asOf, source: ctx.source };
}
