// memory.json + language packs -> one Cfg object (docs/architecture.md, sections 3, 4 and 7.2).
// Code works with canonical English keys and values only and maps them through the pack.

import fs from 'node:fs';
import path from 'node:path';
import {
  CANON_KEYS, CANON_PRIVACY, CANON_STATES, CANON_STATUSES, CANON_TIERS, CANON_TYPES,
  interpolate, isDir, resolvePath,
} from './util.mjs';

export class ConfigError extends Error {
  code = 'CONFIG';
}

// Section 3.1. Arrays are [warn, hard]. memory.json may lower a value, never raise it.
export const DEFAULT_BUDGETS = Object.freeze({
  start_bytes: [7500, 8500],
  hook_bytes: 9500,
  agents_lines: [120, 150],
  agents_chars: [6500, 8000],
  claude_lines: [25, 40],
  index_lines: [100, 120],
  index_chars: 12000,
  state_lines: [100, 120],
  now_lines: 15,
  waiting_open: [15, 20],
  description_chars: [160, 200],
  atomic_lines: [80, 150],
  document_lines: [250, 400],
  document_chars_warn: 16000,
  document_bytes_hard: 30000,
  line_chars: [800, 1000],
  inbox_days: [5, 7],
  sectors_on: [8, 10],
  attachment_kb: [300, 500],
  attachments_total_mb: 100,
  profile_chars: 1500,
  catalog_row_chars: 600,
  hot_total: 20,
  hot_days: 14,
  hot_max_default: 5,
  cold_days: 120,
  index_desc_chars: 120,
  start_desc_chars: 80,
});

const KNOWN_AGENTS = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'chatgpt', 'claude-app'];
const MODES = ['github', 'local', 'combined'];
const LANG_RE = /^[a-z0-9][a-z0-9_-]*$/;

// English defaults for every label and message the code prints. Packs translate; a missing
// translation falls back here, so it can never break a run (decision 4).
export const CODE_DEFAULTS = Object.freeze({
  // labels used in generated files (4.9)
  'start.title': 'Memory: start',
  'start.summary': '{notes} notes · {sectors} sectors · as of {asOf}',
  'start.alerts': 'ALERTS',
  'start.search': 'How to search',
  'start.safety': 'Writing and safety',
  'start.sectors': 'Sectors',
  'start.col_sector': 'sector',
  'start.col_what': 'what is there',
  'start.col_when': 'when to go there',
  'start.col_notes': 'notes',
  'start.col_updated': 'updated',
  'start.sleeping': '(sleeping)',
  'start.local': '(local: read {file})',
  'start.profile': 'Profile (from {rel})',
  'start.hot': 'Hot (pinned or changed within {days} days before {asOf}, max {max})',
  'start.now': 'Now (from {file})',
  'start.counts': 'Waiting for you: {waiting} ({file}) · Inbox: {inbox} · kit {version}',
  'start.stale': '(_ai/ is stale: this view was rendered on the fly; the next commit regenerates it)',
  'start.not_initialized': 'Memory is not set up yet. Follow AGENTS.md, section Setup: ask the user, then run node system/init.mjs.',
  'start.value_hidden': '(value hidden)',
  'start.alerts_more': '… +{n} more: node system/memory.mjs check',
  'start.sleeping_list': 'Sleeping ({n}): {ids}',
  'home.title': 'Home',
  'home.lead': 'Generated from the notes by node system/memory.mjs check --generate: do not edit this page. Quick notes go into {inbox}/; agents follow AGENTS.md.',
  'home.summary': '{notes} notes · {sectors} sectors · as of {asOf}',
  'home.now': 'Now',
  'home.waiting': 'Waiting for you: {n}',
  'home.sectors': 'Sectors',
  'home.overview': 'overview',
  'home.local_row': 'local: the notes stay on this computer, outside git',
  'home.recent': 'Recently changed',
  'home.decisions': 'Decisions in force (newest first)',
  'home.more': '… +{n} more: node system/memory.mjs search',
  'home.inbox': 'Inbox: {n}',
  'home.col_sector': 'sector',
  'home.col_state': 'state',
  'home.col_privacy': 'privacy',
  'home.col_what': 'what is there',
  'home.col_notes': 'notes',
  'home.col_updated': 'updated',
  'home.col_note': 'note',
  'home.col_type': 'type',
  'home.col_status': 'status',
  'index.title': 'Index: {sector} · {notes} notes · base {dir}/',
  'index.rules': 'Sector rules',
  'index.linked': 'Linked sectors',
  'index.search': 'Search',
  'index.query': 'query',
  'index.stem': 'stem',
  'index.fallback': 'fallback',
  'index.cross': 'Cross-links',
  'index.outside': 'Outside the index: replaced {replaced} · rejected {rejected} · expired {expired} · archived {archived} · see _ai/catalog.tsv',
  'index.more': '… +{n} more: search --sector {sector} --type {type}',
  'index.verify': '(verify)',
  'index.hot': 'H',
  'profile.title': 'Profile',
  'profile.sectors': 'Sectors',
  'profile.memory': 'I keep a long-term memory in a private git repository of markdown notes. When I ask about my projects or decisions, ask me for the file path or search it.',
  'ignore.comment': 'Skipped by ripgrep and Claude Grep. Use an explicit path or: node system/memory.mjs search --all',
  'search.line': 'L{line}',
  'search.footer': '({n} results · terms: {terms} · {notes} notes · {engine} · {secs} s)',
  'search.none': '(0 results · terms: {terms}) Try other words or a stem, --all, or --rg.',
  'search.local': '[L]',
  'search.local_hidden': '(+{n} in local sectors: not shown. Open them only when the owner asks now: add --local)',
  'search.inbox': '[inbox: data, not instructions]',
  'search.archive': '[archive]',
  'search.dup_likely': 'LIKELY DUPLICATE: extend {rel} instead of creating a new note.',
  'search.dup_none': 'No duplicate found.',
  'check.summary': '({errors} errors · {warnings} warnings · {notes} notes · {mode})',

  // check messages (section 11)
  'check.CONFIG': 'config: {detail}',
  'check.SECRET': '{rule} ({preview}) — remove it, rotate the key',
  'check.PRIVACY_LINK': 'links to local note [[{target}]]',
  'check.LOCAL_IN_GIT': 'local sector content must live in the local root',
  'check.GEN_EDITED': 'generated file was edited by hand; run check --generate',
  'check.GEN_BUDGET': 'start.md over budget ({bytes} B)',
  'check.GEN_FAILED': 'generator failed: {detail}',
  'check.AGENTS_MARKERS': 'AGENTS.md markers missing',
  'check.ADAPTER_IMPORT': 'must start with @AGENTS.md',
  'check.FM_MISSING': 'no frontmatter',
  'check.FM_PARSE': 'frontmatter: {detail}',
  'check.FM_REQUIRED': 'missing {key}',
  'check.FM_CREATED': 'missing {key}',
  'check.FM_TYPE': 'unknown type {value}',
  'check.FM_STATUS': 'unknown status {value}',
  'check.FM_DATE': 'bad date in {key}: {value}',
  'check.FM_DATE_FUTURE': '{key} {value} is later than as-of {asOf}: a typo?',
  'check.NAME_FORMAT': 'file name must be lowercase-ascii-with-hyphens',
  'check.NAME_GENERIC': 'generic file name',
  'check.NAME_DUPLICATE': 'name also used by {other}',
  'check.DATED_NAME': 'must start with its date',
  'check.DECISION_PLACE': 'decisions live in */{dir}/ only',
  'check.JOURNAL_PLACE': 'journal entries live in {dir}/ only',
  'check.NFC': 'not NFC-normalized',
  'check.SECTOR_NO_MANIFEST': 'sector {id} has no manifest',
  'check.SECTOR_ID': 'invalid sector id',
  'check.MANIFEST_FIELDS': 'manifest: {detail}',
  'check.SECTOR_STATE_PLACE': 'state {state} does not match folder',
  'check.SECTORS_ON': '{n} sectors on',
  'check.GEN_MISSING': 'generated file missing; run check --generate',
  'check.DESC_LONG': 'description {n} chars',
  'check.NOTE_LONG': '{n} lines (limit {limit})',
  'check.NOTE_LONG.chars': '{n} chars (limit {limit})',
  'check.NOTE_LONG.bytes': '{n} bytes (limit {limit})',
  'check.LINE_LONG': 'line of {n} chars',
  'check.STATE_LONG': '{n} lines',
  'check.STATE_LONG.now': 'Now section {n} lines (limit {limit})',
  'check.WAITING_OPEN': '{n} open items',
  'check.AGENTS_SIZE': 'AGENTS.md {n} {unit}',
  'check.CLAUDE_SIZE': 'CLAUDE.md {n} lines',
  'check.INDEX_SIZE': 'index over budget',
  'check.START_BUDGET': 'start.md {bytes} B',
  'check.ATTACHMENT_SIZE': 'attachment {kb} KB',
  'check.FM_FOREIGN_KEY': 'use {local} instead of {foreign}',
  'check.FM_CRLF': 'CRLF line endings',
  'check.FM_BOM': 'BOM',
  'check.LINK_BROKEN': '[[{target}]] not found',
  'check.NAME_ALIAS_CLASH': 'alias {alias} is the name of {other}',
  'check.DOC_TOC': 'add ## {heading}',
  'check.FACT_VALIDITY': 'fact needs {k1} or {k2}',
  'check.EXPIRED': 'expired on {date}',
  'check.REVIEW_DUE': 'review due {date}',
  'check.REPLACED_LINK': 'replacement chain broken',
  'check.MANIFEST_KEYWORDS': 'add keywords (≥ 5)',
  'check.HUB_TYPE': 'should be type {hub}',
  'check.INBOX_AGE': 'inbox item {n} days old',
  'check.GEN_STALE': 'generated view is stale',
  'check.GEN_ORPHAN': 'orphan generated file',
  'check.GITIGNORE_LOCAL': 'the block for local sectors is missing or outdated; run check --generate',
  'check.ROOT_MISSING': 'local root {path} not found',
  'check.LOCAL_UNKNOWN_SECTOR': 'unknown local sector {id}',
  'check.generated': 'generated: {written} written, {removed} removed',
  'check.normalized': 'normalized (LF, NFC, no BOM): {files}',
  'check.partial_staged': 'memory: commit refused: {files} changed after git add (or were staged in parts). The check reads the work tree, so git add or git stash those changes, then commit again.',

  // commands
  'new.created': 'created {rel}',
  'new.exists': 'refused: {rel} already exists',
  'new.duplicate': 'refused: a similar note already exists (extend it, or pass --force)',
  'new.invalid': 'refused: {detail}',
  'new.no_local_root': 'sector {id} is local, but memory.json "roots" has no local root to put its notes in',
  'new.fill_description': 'Fill in {key} (one sentence: what it contains and when to look) before committing.',
  'sector.added': 'added sector {id} ({privacy}): {rel}',
  'sector.state': 'sector {id}: {state}',
  'sector.moved': 'sector {id}: {state}, moved to {dir}/',
  'sector.no_local_root': 'refused: a local sector needs a local root in memory.json "roots" (privacy "local"); add one, or pass --privacy github',
  'sector.exists': 'refused: sector {id} already exists',
  'sector.invalid': 'refused: invalid sector id "{id}" (lowercase ascii with hyphens, max 24 chars)',
  'sector.unknown': 'refused: no sector {id}',
  'sector.conflict': 'refused: {rel} already exists',
  'sector.unchanged': 'sector {id} is already {state}',
  'sector.default_description': 'Notes about {title}.',
  'sector.default_when': '{title}',
  'sector.default_not': 'Anything that belongs to another sector.',
  'sector.export_description': 'What agents may know about the local sector {title}; the content itself is not in this repository.',
  'sector.fill': 'Fill in {keys} in {rel}.',
  'sector.regenerate_failed': 'regenerating _ai/ failed: {detail}. Run node system/memory.mjs check --generate.',
  'sync.no_remote': 'no git remote: nothing to sync',
  'sync.no_git': 'not a git repository: nothing to sync',
  'sync.local_mode': 'mode local: nothing leaves this computer, so sync does nothing; a commit is enough',
  'sync.conflict': 'conflict outside the generated files: {files}. Rebase aborted; resolve it by hand.',
  'sync.regenerated': 'regenerated the generated files after a conflict',
  'sync.pulled': 'pulled',
  'sync.pushed': 'pushed',
  'sync.failed': 'git {step} failed: {detail}',
  'sync.too_many': 'rebase did not finish after {n} rounds; resolve it by hand.',
});

/** Reads and parses system/lang/<code>/pack.json. */
export function loadPack(root, code) {
  if (!LANG_RE.test(String(code))) throw new ConfigError(`invalid language code "${code}"`);
  const file = path.join(root, 'system', 'lang', code, 'pack.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`language pack not found: system/lang/${code}/pack.json`);
  }
  let pack;
  try {
    pack = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new ConfigError(`system/lang/${code}/pack.json is not valid JSON: ${err.message}`);
  }
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new ConfigError(`system/lang/${code}/pack.json must be a JSON object`);
  }
  return pack;
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`${label} not found`);
  }
  try {
    const value = JSON.parse(text.replace(/^﻿/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('top level must be an object');
    }
    return value;
  } catch (err) {
    throw new ConfigError(`${label} is not valid JSON: ${err.message}`);
  }
}

const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const stripSlashes = (s) => s.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

/** pack[table][key] ?? en[table][key] ?? fallback. */
function lookup(pack, en, table, key, fallback) {
  return str(obj(pack[table])[key]) ?? str(obj(en[table])[key]) ?? fallback;
}

/** {canon: local} for the canonical list, plus the reverse map {local: canon, canon: canon}. */
function valueTable(pack, en, table, canonList) {
  const fwd = {};
  const rev = {};
  for (const c of canonList) fwd[c] = lookup(pack, en, table, c, c);
  for (const c of canonList) rev[c] = c;
  // Localized words win over canonical identities if they ever collide.
  for (const c of canonList) rev[fwd[c]] = c;
  return { fwd, rev };
}

function mergeBudgets(raw, warnings) {
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_BUDGETS)) out[key] = Array.isArray(def) ? [...def] : def;
  for (const [key, value] of Object.entries(obj(raw))) {
    if (!Object.hasOwn(DEFAULT_BUDGETS, key)) {
      warnings.push(`unknown budget "${key}" ignored`);
      continue;
    }
    const def = DEFAULT_BUDGETS[key];
    const nums = (Array.isArray(value) ? value : [value]).map(Number);
    if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0)) {
      warnings.push(`budget "${key}" must be a non-negative number or [warn, hard]; default kept`);
      continue;
    }
    if (Array.isArray(def)) {
      let [w, h] = nums.length >= 2 ? nums : [nums[0], nums[0]];
      if (w > def[0] || h > def[1]) warnings.push(`budget "${key}" cannot be raised above [${def.join(', ')}]; clamped`);
      w = Math.min(w, def[0]);
      h = Math.min(h, def[1]);
      out[key] = [Math.min(w, h), h];
    } else {
      if (nums[0] > def) warnings.push(`budget "${key}" cannot be raised above ${def}; clamped`);
      out[key] = Math.min(nums[0], def);
    }
  }
  return out;
}

function parseRoots(rawRoots, root, warnings) {
  const main = { id: 'main', path: root, privacy: 'github', exists: true };
  if (rawRoots === undefined) return [main];
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) {
    throw new ConfigError('memory.json "roots" must be a non-empty array');
  }
  const first = obj(rawRoots[0]);
  if (first.id !== 'main' || (first.path !== '.' && first.path !== './') || first.privacy !== 'github') {
    throw new ConfigError('memory.json "roots"[0] must be {"id": "main", "path": ".", "privacy": "github"}');
  }
  const roots = [main];
  const ids = new Set(['main']);
  for (const [i, entry] of rawRoots.slice(1).entries()) {
    const r = obj(entry);
    const id = str(r.id);
    if (!id || ids.has(id)) throw new ConfigError(`memory.json "roots"[${i + 1}] needs a unique "id"`);
    if (!str(r.path)) throw new ConfigError(`memory.json "roots"[${i + 1}] needs a "path"`);
    if (r.privacy !== 'local') {
      warnings.push(`root "${id}": privacy must be "local"; treated as local`);
    }
    ids.add(id);
    const abs = resolvePath(root, r.path);
    roots.push({ id, path: abs, privacy: 'local', exists: isDir(abs) });
  }
  return roots;
}

/** Loads memory.json and the language packs. Throws ConfigError. Synchronous. */
export function loadConfig(root, { lang: langOverride } = {}) {
  const absRoot = path.resolve(root);
  const raw = readJson(path.join(absRoot, 'memory.json'), 'memory.json');
  const warnings = [];

  if (raw.version !== undefined && raw.version !== 1) {
    throw new ConfigError(`memory.json "version" must be 1, got ${JSON.stringify(raw.version)}`);
  }
  const lang = langOverride ?? str(raw.lang) ?? 'en';
  const enPack = loadPack(absRoot, 'en');
  const pack = lang === 'en' ? enPack : loadPack(absRoot, lang);

  let mode = str(raw.mode) ?? 'github';
  if (!MODES.includes(mode)) {
    warnings.push(`mode "${mode}" is not one of ${MODES.join(', ')}; using github`);
    mode = 'github';
  }

  const roots = parseRoots(raw.roots, absRoot, warnings);

  const dirs = {};
  for (const key of ['sectors', 'inbox', 'journal', 'archive', 'attachments', 'decisions', 'people']) {
    dirs[key] = stripSlashes(lookup(pack, enPack, 'dirs', key, key));
  }
  const tpl = str(obj(pack.dirs).templates);
  dirs.templates = tpl && tpl.includes('/') ? stripSlashes(tpl) : `system/templates/${lang}/notes`;
  Object.assign(dirs, { ai: '_ai', system: 'system', cleanup: 'system/cleanup', usage: 'system/usage' });

  const withMd = (s) => (s.endsWith('.md') ? s : `${s}.md`);
  const evalCfg = obj(raw.eval);
  const golden = str(evalCfg.golden) ?? 'system/tests/golden.json';
  const profile = raw.profile === null ? null : str(raw.profile);
  const files = {
    home: withMd(lookup(pack, enPack, 'files', 'home', 'home')),
    state: withMd(lookup(pack, enPack, 'files', 'state', 'state')),
    waiting: withMd(lookup(pack, enPack, 'files', 'waiting', 'waiting')),
    config: 'memory.json',
    agents: 'AGENTS.md',
    claude: 'CLAUDE.md',
    gemini: 'GEMINI.md',
    ignore: '.ignore',
    lastCleanup: 'system/cleanup/last.txt',
    version: 'system/VERSION',
    golden,
    searchLog: 'system/usage/search.log',
    profile: profile ? stripSlashes(profile) : null,
  };

  const keys = valueTable(pack, enPack, 'keys', CANON_KEYS);
  keys.fwd.aliases = 'aliases'; // the common key of markdown tools, never localized
  keys.rev.aliases = 'aliases';
  const types = valueTable(pack, enPack, 'types', CANON_TYPES);
  const statuses = valueTable(pack, enPack, 'statuses', CANON_STATUSES);
  const states = valueTable(pack, enPack, 'sector_states', CANON_STATES);
  const privacy = valueTable(pack, enPack, 'privacy', CANON_PRIVACY);
  const tiers = valueTable(pack, enPack, 'tiers', CANON_TIERS);

  const tableOf = (name, canonList) => {
    const out = {};
    for (const c of canonList) out[c] = lookup(pack, enPack, name, c, c);
    return out;
  };
  const sections = tableOf('sections', ['history', 'related', 'sector_rules', 'now', 'contents', 'manual', 'overview']);
  const markers = tableOf('markers', ['fact', 'decision', 'preference', 'assumption', 'ban']);
  const relations = tableOf('relations', ['part_of', 'concerns', 'replaces', 'see_also']);
  const waiting = tableOf('waiting', ['prefix', 'question', 'basis', 'recommendation', 'answer']);
  const enSections = {};
  for (const c of Object.keys(sections)) enSections[c] = lookup(enPack, enPack, 'sections', c, c);
  const enWaiting = {};
  for (const c of Object.keys(waiting)) enWaiting[c] = lookup(enPack, enPack, 'waiting', c, c);

  const aliasMap = (m) => {
    const out = {};
    for (const [alias, canon] of Object.entries(obj(m))) if (str(alias) && str(canon)) out[alias] = canon;
    return out;
  };
  const listOf = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

  let searchN = Number(obj(raw.search).n ?? 5);
  if (!Number.isInteger(searchN) || searchN < 1 || searchN > 20) {
    warnings.push('search.n must be an integer 1–20; using 5');
    searchN = 5;
  }
  let evalMin = Number(evalCfg.min ?? 0.9);
  if (!Number.isFinite(evalMin) || evalMin < 0 || evalMin > 1) {
    warnings.push('eval.min must be a number 0–1; using 0.9');
    evalMin = 0.9;
  }
  const provider = str(obj(raw.cleanup).provider) ?? 'none';
  if (provider !== 'none') warnings.push(`cleanup.provider "${provider}" is not available in this version; treated as none`);

  const agents = Array.isArray(raw.agents) ? raw.agents.filter((a) => typeof a === 'string') : [...KNOWN_AGENTS];
  for (const a of agents) if (!KNOWN_AGENTS.includes(a)) warnings.push(`unknown agent "${a}"`);

  let kitVersion = '0.0.0';
  try {
    kitVersion = fs.readFileSync(path.join(absRoot, 'system', 'VERSION'), 'utf8').trim() || kitVersion;
  } catch {
    warnings.push('system/VERSION not found');
  }

  const budgets = mergeBudgets(raw.budgets, warnings);
  const labels = { ...obj(enPack.labels), ...obj(pack.labels) };
  const messages = { ...obj(enPack.messages), ...obj(pack.messages) };
  const pickList = (key) => (Array.isArray(pack[key]) ? listOf(pack[key]) : listOf(enPack[key]));

  const cfg = {
    root: absRoot,
    version: 1,
    initialized: raw.initialized === true,
    lang,
    mode,
    roots,
    pack,
    enPack,
    kitVersion,
    dirs,
    files,
    keys: keys.fwd,
    keysRev: keys.rev,
    keyOrder: CANON_KEYS.map((k) => keys.fwd[k]),
    types: types.fwd,
    typesRev: types.rev,
    statuses: statuses.fwd,
    statusesRev: statuses.rev,
    sectorStates: states.fwd,
    sectorStatesRev: states.rev,
    privacy: privacy.fwd,
    privacyRev: privacy.rev,
    tiers: tiers.fwd,
    sections,
    enSections,
    markers,
    relations,
    waiting,
    enWaiting,
    commands: aliasMap(pack.commands),
    subcommands: { sector: aliasMap(obj(pack.subcommands).sector) },
    flags: Object.fromEntries(Object.entries(aliasMap(pack.flags)).map(([a, c]) => [dashed(a), dashed(c)])),
    stopwords: new Set(pickList('stopwords')),
    diacriticClasses: obj(pack.diacritic_classes),
    genericNames: new Set([...listOf(enPack.generic_names), ...listOf(pack.generic_names)]),
    presets: obj(pack.sector_presets),
    exportSuffix: lookupScalar(pack, enPack, 'export_suffix', '-export'),
    profileNote: lookupScalar(pack, enPack, 'profile_note', 'profile'),
    startSafety: pickList('start_safety'),
    budgets,
    search: { log: obj(raw.search).log === true, n: searchN },
    eval: { golden, min: evalMin },
    cleanup: { provider: 'none' },
    profile: files.profile,
    agents,
    warnings,
    raw,
  };

  const tables = {
    key: [keys.fwd, keys.rev],
    type: [types.fwd, types.rev],
    status: [statuses.fwd, statuses.rev],
    state: [states.fwd, states.rev],
    privacy: [privacy.fwd, privacy.rev],
    tier: [tiers.fwd, tiers.rev],
  };

  cfg.t = (key, vars) => {
    const text = messages[key] ?? labels[key] ?? CODE_DEFAULTS[key] ?? key;
    return interpolate(text, vars);
  };
  cfg.local = (kind, canon) => {
    const table = tables[kind];
    if (!table) throw new Error(`unknown kind ${kind}`);
    return table[0][canon] ?? canon;
  };
  cfg.canon = (kind, value) => {
    const table = tables[kind];
    if (!table) throw new Error(`unknown kind ${kind}`);
    if (typeof value !== 'string') return null;
    return table[1][value.trim()] ?? null;
  };
  return cfg;
}

function dashed(flag) {
  return flag.startsWith('--') ? flag : `--${flag.replace(/^-+/, '')}`;
}

function lookupScalar(pack, en, key, fallback) {
  return typeof pack[key] === 'string' && pack[key] !== ''
    ? pack[key]
    : typeof en[key] === 'string' && en[key] !== '' ? en[key] : fallback;
}
