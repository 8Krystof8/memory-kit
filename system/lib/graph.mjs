// The memory as a graph (docs/architecture.md, 10.11): every note is a node and every link between
// two notes an edge with a kind, read from the files only (lib/vault.mjs: the relations of
// `## Related`, wiki and Markdown links, replaces and replaced_by, the journal's used and changed,
// a note's sector and the links between sectors), plus how often the agents used each note on this
// computer (the activity log). `graph` writes it next to the browser page of
// system/templates/graph/ into .memory-kit/graph/ of the main root, or of the first local root when
// the local sectors are in it, so private notes never land in the main root, let alone in git.
// Nothing here goes online, and the page itself may load nothing but its data file. The same
// files, log and clock give the same output: nodes sorted by id, links by their ends and kind.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readActivity } from './activity.mjs';
import { writeAtomic } from './fsafe.mjs';
import { WORK_DIR, cmp, ensureWorkDirIgnored, interpolate } from './util.mjs';
import { loadVault, resolveLink } from './vault.mjs';

export const GRAPH_FORMAT = 1;
export const GRAPH_DIR = `${WORK_DIR}/graph`;
export const PAGE_FILE = 'index.html';
export const DATA_FILE = 'graph-data.js';
export const TEMPLATE_REL = 'system/templates/graph';
const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'graph');
const TEMPLATE_FILES = ['page.html', 'style.css', 'layout.js', 'app.js'];

/**
 * The kinds of an edge, in drawing order, with the weight the layout and the line width start
 * from: the relations of `## Related` are the strongest, a plain link in the text in between, the
 * journal and a note's sector the weakest (so a sector pulls its notes together without hiding
 * what they say about each other).
 */
export const EDGE_KINDS = Object.freeze([
  { id: 'part_of', w: 1 },
  { id: 'replaces', w: 1 },
  { id: 'concerns', w: 0.8 },
  { id: 'see_also', w: 0.6 },
  { id: 'sector', w: 0.5 },
  { id: 'link', w: 0.4 },
  { id: 'used', w: 0.3 },
  { id: 'changed', w: 0.3 },
  { id: 'in', w: 0.15 },
]);
const KIND_INDEX = new Map(EDGE_KINDS.map((k, i) => [k.id, i]));
// A relation a newer pack may know but this table does not yet: weighted like see_also.
const OTHER_RELATION = 'see_also';

// How much text of a note the page shows in its panel.
const MAX_DESCRIPTION = 240;
const MAX_LEAD = 320;
// The activity the live view shows: the last day, newest 60 uses.
const RECENT_MS = 24 * 3600 * 1000;
const RECENT_MAX = 60;
// The page asks for new data this often in live mode (ms).
export const LIVE_REFRESH_MS = 1500;

// English defaults of the page's words; packs may translate the same keys (section 4.10).
export const UI_DEFAULTS = Object.freeze({
  'graph.ui.title': 'Memory graph',
  'graph.ui.search': 'Search notes',
  'graph.ui.matches': '{n} found',
  'graph.ui.filters': 'Filters',
  'graph.ui.groups': 'Groups',
  'graph.ui.display': 'Display',
  'graph.ui.forces': 'Forces',
  'graph.ui.show_orphans': 'Notes without links',
  'graph.ui.show_journal': 'Journal',
  'graph.ui.show_inbox': 'Inbox',
  'graph.ui.show_archive': 'Archive',
  'graph.ui.show_sectors': 'Sectors as nodes',
  'graph.ui.show_missing': 'Missing notes',
  'graph.ui.color_by': 'Color by',
  'graph.ui.by_sector': 'sector',
  'graph.ui.by_type': 'type',
  'graph.ui.by_status': 'status',
  'graph.ui.node_size': 'Node size',
  'graph.ui.link_width': 'Line width',
  'graph.ui.labels': 'Labels from zoom',
  'graph.ui.center': 'Center force',
  'graph.ui.repel': 'Repel force',
  'graph.ui.link_force': 'Link force',
  'graph.ui.link_distance': 'Link distance',
  'graph.ui.reset': 'Reset',
  'graph.ui.fit': 'Fit',
  'graph.ui.settings': 'Settings',
  'graph.ui.close': 'Close',
  'graph.ui.local_graph': 'Local graph',
  'graph.ui.depth': 'Depth',
  'graph.ui.whole_graph': 'Whole graph',
  'graph.ui.links_out': 'Links from here',
  'graph.ui.links_in': 'Links here',
  'graph.ui.no_links': 'none',
  'graph.ui.copy_path': 'Copy path',
  'graph.ui.copied': 'Copied',
  'graph.ui.updated': 'updated {date}',
  'graph.ui.used': 'used {n}×',
  'graph.ui.local': 'local',
  'graph.ui.missing': 'missing note',
  'graph.ui.archived': 'archived',
  'graph.ui.none': 'none',
  'graph.ui.journal': 'journal',
  'graph.ui.inbox': 'inbox',
  'graph.ui.root': 'root',
  'graph.ui.stats': '{notes} notes · {links} links · {date}',
  'graph.ui.live': 'live',
  'graph.ui.stopped': 'live view stopped',
  'graph.ui.recent': 'Just used',
  'graph.ui.ago_s': '{n} s ago',
  'graph.ui.ago_min': '{n} min ago',
  'graph.ui.ago_h': '{n} h ago',
  'graph.ui.op_start': 'session start',
  'graph.ui.op_search': 'search',
  'graph.ui.op_read': 'read',
  'graph.ui.op_recent': 'recent notes',
  'graph.ui.op_save': 'saved',
  'graph.ui.op_lookup': 'error lookup',
  'graph.ui.no_webgl': 'This browser has no WebGL2, so the graph is drawn in a simpler mode.',
  'graph.ui.empty': 'No notes yet. They appear here as soon as the memory has some.',
  'graph.ui.waiting': 'Waiting for the data file graph-data.js next to this page.',
  'graph.ui.help': 'Drag to move · wheel to zoom · click a dot for its note · / search · F fit · Esc back',
  'graph.ui.kind_part_of': 'part of',
  'graph.ui.kind_replaces': 'replaces',
  'graph.ui.kind_concerns': 'concerns',
  'graph.ui.kind_see_also': 'see also',
  'graph.ui.kind_sector': 'linked sector',
  'graph.ui.kind_link': 'link',
  'graph.ui.kind_used': 'used in a session',
  'graph.ui.kind_changed': 'changed in a session',
  'graph.ui.kind_in': 'in the sector',
});

function say(cfg, key, vars = {}) {
  let text = null;
  try {
    text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : null;
  } catch {
    text = null;
  }
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(UI_DEFAULTS[key] ?? key, vars);
}

/** The page's words in the vault's language: {short key: text} (the part after graph.ui.). */
export function uiLabels(cfg) {
  const out = {};
  for (const key of Object.keys(UI_DEFAULTS)) {
    const text = say(cfg, key);
    out[key.slice('graph.ui.'.length)] = text;
  }
  return out;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
function clip(s, max) {
  const t = oneLine(s);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The id of a note in the graph: its vault-relative path, prefixed with the root of a local note. */
const nodeId = (note) => (note.root === 'main' ? note.rel : `${note.root}:${note.rel}`);

/** Uses per main-root note and the time of its last one, from the activity log (reads, first hits, saves). */
function usageOf(entries) {
  const used = new Map();
  for (const e of entries) {
    if (!Array.isArray(e.notes) || !e.notes.length) continue;
    const touched = e.op === 'search' || e.op === 'lookup' || e.op === 'recent' ? e.notes.slice(0, 1) : e.notes;
    for (const rel of touched) {
      if (typeof rel !== 'string') continue;
      const u = used.get(rel) ?? { n: 0, last: null };
      u.n += 1;
      if (typeof e.t === 'string' && (!u.last || e.t > u.last)) u.last = e.t;
      used.set(rel, u);
    }
  }
  return used;
}

/**
 * The graph of the vault of cfg: {v, generated, lang, vault, local, kinds, sectors, types,
 * statuses, nodes, links, recent, stats}. nodes: [{id, name, title, type, status, sector, area,
 * local, archived, missing, description, lead, updated, rel, used, last}] sorted by id; links:
 * [[from, to, kind]] (indexes into nodes and kinds), sorted, one per pair and kind. A link whose
 * target no note has becomes a node with missing: true. local adds the notes of the local roots;
 * without it they are not even read. activity (tests) replaces the activity log; now is the clock.
 */
export function buildGraph(cfg, { local = false, now = new Date(), activity } = {}) {
  const vault = loadVault(cfg, { roots: local ? 'all' : 'main' });
  const notes = vault.notes.filter((n) => !n.isExport && !n.misplacedLocal && (local || !n.local));
  const entries = activity ?? readActivity(cfg.root);
  const used = usageOf(entries);

  const nodes = [];
  const index = new Map(); // note → node
  for (const note of notes) {
    const u = note.root === 'main' ? used.get(note.rel) : null;
    const node = {
      id: nodeId(note),
      name: note.name,
      title: oneLine(note.title) || note.name,
      type: note.data.type ?? null,
      status: note.data.status ?? null,
      sector: note.sector ?? null,
      area: note.area,
      local: note.local === true,
      archived: note.archived === true,
      missing: false,
      description: clip(note.data.description, MAX_DESCRIPTION),
      lead: clip(note.lead.join(' '), MAX_LEAD),
      updated: typeof note.data.updated === 'string' ? note.data.updated : null,
      rel: note.root === 'main' ? note.rel : `${note.root}:${note.rel}`,
      used: u?.n ?? 0,
      last: u?.last ?? null,
    };
    nodes.push(node);
    index.set(note, node);
  }

  const missing = new Map(); // lowercase target → node
  const manifestOf = new Map(vault.sectors.filter((s) => s.manifest && index.has(s.manifest)).map((s) => [s.id, index.get(s.manifest)]));
  const raw = []; // [fromNode, toNode, kind]
  const targetOf = (note, target) => {
    // An attachment (an image, a PDF) is no note: it is neither a node nor missing.
    if (/\.(?!md$)[a-z0-9]{1,5}$/i.test(String(target).split('|')[0].split('#')[0].trim())) return null;
    const hit = resolveLink(vault, target, note);
    if (hit) return index.get(hit) ?? null; // a note left out (an export file, a local note) is no target
    const label = oneLine(String(target).split('|')[0].split('#')[0]).replace(/\.md$/i, '');
    if (!label) return null;
    const key = label.toLowerCase();
    if (!missing.has(key)) {
      missing.set(key, {
        id: `missing:${key}`, name: label, title: label, type: null, status: null, sector: null, area: null, local: false,
        archived: false, missing: true, description: '', lead: '', updated: null, rel: '', used: 0, last: null,
      });
    }
    return missing.get(key);
  };

  for (const note of notes) {
    const from = index.get(note);
    const typed = new Set();
    for (const r of note.relations) {
      const kind = KIND_INDEX.has(r.relation) ? r.relation : OTHER_RELATION;
      const to = targetOf(note, r.target);
      if (to) {
        raw.push([from, to, kind]);
        typed.add(to);
      }
    }
    for (const [key, kind] of [['replaces', 'replaces'], ['used', 'used'], ['changed', 'changed']]) {
      for (const target of note.data[key] ?? []) {
        const to = targetOf(note, String(target).replace(/^\[\[|\]\]$/g, ''));
        if (to) {
          raw.push([from, to, kind]);
          typed.add(to);
        }
      }
    }
    if (typeof note.data.replaced_by === 'string' && note.data.replaced_by) {
      const to = targetOf(note, note.data.replaced_by.replace(/^\[\[|\]\]$/g, ''));
      // The newer note replaces this one: the edge goes from it.
      if (to) {
        raw.push([to, from, 'replaces']);
        typed.add(to);
      }
    }
    for (const l of note.links) {
      const to = targetOf(note, l.target);
      if (to && !typed.has(to)) raw.push([from, to, 'link']);
    }
    if (note.isManifest) {
      for (const id of note.data.links ?? []) {
        const to = manifestOf.get(String(id));
        if (to) raw.push([from, to, 'sector']);
      }
    } else if (note.sector && manifestOf.has(note.sector)) {
      raw.push([from, manifestOf.get(note.sector), 'in']);
    } else if (note.area === 'journal') {
      for (const id of note.data.sectors ?? []) {
        const to = manifestOf.get(String(id));
        if (to) raw.push([from, to, 'in']);
      }
    }
  }

  for (const m of missing.values()) nodes.push(m);
  nodes.sort((a, b) => cmp(a.id, b.id));
  const pos = new Map(nodes.map((n, i) => [n, i]));
  const seen = new Set();
  const links = [];
  for (const [from, to, kind] of raw) {
    if (from === to) continue;
    const l = [pos.get(from), pos.get(to), KIND_INDEX.get(kind)];
    const key = l.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(l);
  }
  links.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  const since = now.getTime() - RECENT_MS;
  const recent = [];
  for (const e of entries) {
    const t = Date.parse(e.t ?? '');
    if (!Number.isFinite(t) || t < since || t > now.getTime() + 60000) continue;
    const ids = (Array.isArray(e.notes) ? e.notes : []).map((rel) => nodes.findIndex((n) => n.rel === rel && !n.local && !n.missing)).filter((i) => i >= 0);
    recent.push({ t: e.t, op: e.op, via: e.via ?? null, agent: typeof e.agent === 'string' ? e.agent : null, notes: ids });
  }
  recent.sort((a, b) => cmp(a.t, b.t));

  const real = nodes.filter((n) => !n.missing).length;
  return {
    v: GRAPH_FORMAT,
    generated: now.toISOString(),
    lang: cfg.lang,
    vault: path.basename(cfg.root),
    local,
    kinds: EDGE_KINDS.map((k) => ({ id: k.id, w: k.w })),
    sectors: vault.sectors.map((s) => ({ id: s.id, title: oneLine(s.title) || s.id, state: s.state, privacy: s.privacy })),
    types: { ...cfg.types },
    statuses: { ...cfg.statuses },
    nodes,
    links,
    recent: recent.slice(-RECENT_MAX),
    stats: { notes: real, missing: nodes.length - real, links: links.length },
  };
}

/** A short fingerprint of a graph without its time, so the page can tell new data from the same. */
export function graphHash(graph) {
  const { generated, ...rest } = graph;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

/** The data file the page loads: one call of memoryGraph(…) with the graph and the page's words. */
export function dataScript(graph, { labels, live = false } = {}) {
  const payload = { ...graph, hash: graphHash(graph), live, refresh: LIVE_REFRESH_MS, labels: labels ?? {} };
  return `/* memory-kit graph data (generated; every run of graph rewrites it) */\nmemoryGraph(${JSON.stringify(payload)});\n`;
}

const sha256b64 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

/**
 * The page: system/templates/graph/page.html with its style and scripts inlined. The Content
 * Security Policy allows the inline style and script by their hashes, the sibling data file
 * (file:), a worker made from the page's own layout source (blob:), and nothing else: no
 * fetch, no images or fonts from anywhere, no forms.
 */
export function pageHtml({ templateDir = TEMPLATE_DIR } = {}) {
  const read = (name) => fs.readFileSync(path.join(templateDir, name), 'utf8').replace(/\r\n/g, '\n');
  const [page, css, layout, app] = TEMPLATE_FILES.map(read);
  for (const [name, text] of [['layout.js', layout], ['app.js', app], ['style.css', css]]) {
    if (/<\/(?:script|style)/i.test(text)) throw new Error(`${TEMPLATE_REL}/${name} must not contain a closing script or style tag`);
  }
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha256b64(app)}' 'self' file:`,
    'worker-src blob:',
    `style-src 'sha256-${sha256b64(css)}'`,
    'img-src data: blob:',
    "connect-src 'none'",
    "font-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const fill = { CSP: csp, CSS: css, LAYOUT: layout, APP: app, DATA: DATA_FILE };
  return page.replace(/\{\{(CSP|CSS|LAYOUT|APP|DATA)\}\}/g, (m, key) => fill[key]);
}

/**
 * Where graph writes for cfg: the main root's .memory-kit/graph/, or with local the first local
 * root that exists here (its notes stay in it); null when local is asked and no local root exists.
 */
export function graphDir(cfg, { local = false } = {}) {
  if (!local) return path.join(cfg.root, ...GRAPH_DIR.split('/'));
  const root = (cfg.roots ?? []).find((r) => r.id !== 'main' && r.exists);
  return root ? path.join(root.path, ...GRAPH_DIR.split('/')) : null;
}

/**
 * Writes the page and the data file into dir (the page only when its bytes change): → {page,
 * data, hash}. In the main root the first file of .memory-kit/ keeps the folder out of git first.
 */
export function writeGraphFiles(cfg, dir, graph, { labels, live = false } = {}) {
  // The root whose .memory-kit/graph/ this is (none for another folder given with --out).
  const base = path.dirname(path.dirname(path.resolve(dir)));
  if (path.resolve(dir) === path.join(base, ...GRAPH_DIR.split('/')) && !fs.existsSync(path.join(base, WORK_DIR))) {
    try {
      ensureWorkDirIgnored(base);
    } catch {
      /* doctor (git.repo) warns while git does not ignore .memory-kit/ */
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const page = path.join(dir, PAGE_FILE);
  const html = pageHtml();
  let old = null;
  try {
    old = fs.readFileSync(page, 'utf8');
  } catch {
    old = null;
  }
  if (old !== html) writeAtomic(page, html);
  const data = path.join(dir, DATA_FILE);
  writeAtomic(data, dataScript(graph, { labels, live }));
  return { page, data, hash: graphHash(graph) };
}
