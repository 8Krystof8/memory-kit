// `new`: creates a note from its template in the right place (docs/architecture.md, 10.5).
// Refuses (exit 1) existing files and names, invalid names/types/sectors and likely duplicates.
// Does not regenerate _ai/ (the next commit does).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, updateFrontmatter } from '../frontmatter.mjs';
import { loadVault } from '../vault.mjs';
import {
  NAME_RE, checkToday, finalText, humanize, isDate, isReservedName, parseCli, readTextIfExists,
  todayLocal, toPosix, usageError,
} from '../util.mjs';

export const usage = 'new <type> <sector>/<shelf/…>/<name> [--title "…"] [--description "…"] [--today YYYY-MM-DD] [--force]';

const SEARCH_MODULE = fileURLToPath(new URL('../search.mjs', import.meta.url));
const DATED = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

function refused(kind, detail, extra = {}) {
  return { refused: kind, detail, ...extra };
}

/** Built-in template used when system/templates/<lang>/notes/<type>.md is missing. */
function fallbackTemplate(cfg, type) {
  const k = cfg.keys;
  const lines = [
    '---',
    `${k.type}: ${cfg.local('type', type)}`,
    `${k.status}: ${cfg.local('status', type === 'journal' ? 'done' : 'active')}`,
    `${k.description}: ""`,
    `${k.updated}: {{date}}`,
  ];
  if (type === 'decision' || type === 'journal') lines.push(`${k.created}: {{date}}`);
  lines.push('---', '# {{title}}', '> ', '');
  return lines.join('\n');
}

/** The duplicate check of the search module, or null when search is not installed. */
async function findDuplicates(cfg, vault, probe) {
  let search;
  try {
    search = await import('../search.mjs');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(`'${SEARCH_MODULE}'`)) return null;
    throw err;
  }
  const index = await search.buildIndex(vault, cfg);
  try {
    const res = search.duplicates(index, probe, { n: 5, local: probe.local === true });
    return { res, text: search.formatDuplicates(res, cfg) };
  } finally {
    index.close?.();
  }
}

/** Resolves where a note goes: {rel, rootId, rootPath, name, created} or {error}. */
function placeNote(cfg, vault, type, target, today) {
  const segs = toPosix(String(target ?? '')).replace(/\.md$/i, '').split('/').filter(Boolean);
  if (!segs.length) return { error: 'missing target' };
  const main = cfg.roots[0];

  if (type === 'journal') {
    const raw = segs[segs.length - 1];
    const m = DATED.exec(raw);
    const date = m && isDate(m[1]) ? m[1] : today;
    const name = m && isDate(m[1]) ? raw : `${today}-${raw}`;
    if (!NAME_RE.test(name)) return { error: `invalid name "${raw}" (lowercase ascii with hyphens)` };
    return { rel: `${cfg.dirs.journal}/${date.slice(0, 4)}/${name}.md`, rootId: 'main', rootPath: main.path, name, created: date };
  }

  if (segs[0] === cfg.dirs.sectors) segs.shift();
  if (segs.length < 2) return { error: 'target must be <sector>/<name> (shelves optional: <sector>/<shelf>/<name>)' };
  const [sectorId, ...rest] = segs;
  const sector = vault.sectorById.get(sectorId);
  if (!sector) return { error: `no sector "${sectorId}" (see: node system/memory.mjs sector list)` };
  if (sector.state === 'off') return { error: `sector ${sectorId} is off; run: node system/memory.mjs sector wake ${sectorId}` };
  for (const seg of rest) {
    if (!NAME_RE.test(seg)) return { error: `invalid name "${seg}" (lowercase ascii with hyphens)` };
  }

  let shelf = rest.slice(0, -1);
  let name = rest[rest.length - 1];
  let created = today;
  if (type === 'decision') {
    if (!shelf.includes(cfg.dirs.decisions)) shelf = [...shelf, cfg.dirs.decisions];
    const m = DATED.exec(name);
    if (m && isDate(m[1])) created = m[1];
    else name = `${today}-${name}`;
  } else if (shelf.includes(cfg.dirs.decisions)) {
    return { error: `only decisions live in ${cfg.dirs.decisions}/` };
  }
  // Git for Windows cannot check out aux.md or a shelf named con/, on any machine's commit. The
  // names checked are the ones written: a decision's date prefix makes "aux" 2026-09-21-aux.md.
  for (const seg of [...shelf, name]) {
    if (isReservedName(seg)) return { error: cfg.t('new.reserved', { name: seg }) };
  }
  const plain = name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
  if (cfg.genericNames.has(name) || cfg.genericNames.has(plain)) return { error: `generic file name "${name}"` };

  let rootId = 'main';
  let rootPath = main.path;
  if (sector.privacy === 'local') {
    const local = cfg.roots.find((r) => r.id !== 'main');
    if (!local) return { error: cfg.t('new.no_local_root', { id: sectorId }) };
    // A path of another operating system names no folder here; resolving it would write into
    // the working directory, possibly inside the repository.
    if (local.foreign) return { error: cfg.t('new.foreign_root', { id: sectorId, path: local.path }) };
    rootId = local.id;
    rootPath = local.path;
  }
  const rel = `${cfg.dirs.sectors}/${sectorId}/${[...shelf, name].join('/')}.md`;
  return { rel, rootId, rootPath, name, created };
}

/**
 * Creates a note. Returns {rel, root, path} or {refused: 'exists'|'duplicate'|'invalid', detail}.
 * `type` may be localized or canonical. Never overwrites a file.
 */
export async function createNote(cfg, { type, target, title, description, today, force = false }) {
  const canonType = cfg.canon('type', String(type ?? ''));
  if (!canonType) return refused('invalid', `unknown type "${type}"`);
  if (canonType === 'sector') return refused('invalid', 'sectors are created with: node system/memory.mjs sector add <id>');
  if (canonType === 'hub') return refused('invalid', 'hubs are fixed files; edit them directly');
  const day = today ?? todayLocal();
  if (!isDate(day)) return refused('invalid', `bad date "${day}"`);

  const vault = loadVault(cfg, { roots: 'all' });
  const place = placeNote(cfg, vault, canonType, target, day);
  if (place.error) return refused('invalid', place.error);

  const abs = path.join(place.rootPath, ...place.rel.split('/'));
  const shown = toPosix(path.relative(cfg.root, abs));
  if (fs.existsSync(abs)) return refused('exists', cfg.t('new.exists', { rel: shown }), { rel: shown });
  const clash = vault.byName.get(place.name.toLowerCase());
  if (clash?.length) {
    return refused('exists', `${cfg.t('new.exists', { rel: clash[0].rel })} (file names are unique across the vault)`, { rel: clash[0].rel });
  }

  const displayTitle = String(title ?? '').trim() || humanize(place.name);
  if (!force && canonType !== 'journal') {
    const dup = await findDuplicates(cfg, vault, {
      title: displayTitle, description: description ?? '', type: canonType, local: place.rootId !== 'main',
    });
    if (dup && dup.res.verdict === 'duplicate') {
      return refused('duplicate', dup.text, { best: dup.res.best });
    }
  }

  const k = cfg.keys;
  const tplPath = path.join(cfg.root, ...cfg.dirs.templates.split('/'), `${cfg.local('type', canonType)}.md`);
  let text = readTextIfExists(tplPath) ?? fallbackTemplate(cfg, canonType);
  // Replacer functions: a title with "$&" or "$$" must be inserted as written.
  text = text.replace(/\{\{title\}\}/g, () => displayTitle).replace(/\{\{date(?::[^}]*)?\}\}/g, () => day);

  const existing = parse(text).data;
  const patch = { [k.updated]: day };
  if (Object.hasOwn(existing, k.created) || canonType === 'decision' || canonType === 'journal') patch[k.created] = place.created;
  if (description && String(description).trim()) patch[k.description] = String(description).trim();
  // A display name with diacritics goes into aliases (section 5.5).
  if (title && /[^\x00-\x7F]/.test(displayTitle)) {
    const aliases = Array.isArray(existing.aliases) ? existing.aliases.map(String) : [];
    if (!aliases.includes(displayTitle)) patch.aliases = [...aliases, displayTitle];
  }
  text = updateFrontmatter(text, patch, { order: cfg.keyOrder });

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, finalText(text), { flag: 'wx' });
  return { rel: place.rel, root: place.rootId, path: abs, shown };
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, {
    title: { type: 'string' },
    description: { type: 'string' },
    today: { type: 'string' },
    force: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length !== 2) {
    usageError(positionals.length < 2 ? 'missing <type> or target' : `unexpected argument "${positionals[2]}"`, usage);
    return 2;
  }
  if (!checkToday(values.today, usage)) return 2;

  const res = await createNote(cfg, {
    type: positionals[0],
    target: positionals[1],
    title: values.title,
    description: values.description,
    today: values.today,
    force: values.force === true,
  });
  if (res.refused === 'duplicate') {
    process.stdout.write(`${res.detail}\n${cfg.t('new.duplicate')}\n`);
    return 1;
  }
  if (res.refused === 'exists') {
    process.stdout.write(`${res.detail}\n`);
    return 1;
  }
  if (res.refused) {
    process.stdout.write(`${cfg.t('new.invalid', { detail: res.detail })}\n`);
    return 1;
  }
  process.stdout.write(`${cfg.t('new.created', { rel: res.shown })}\n`);
  if (!values.description || !values.description.trim()) {
    process.stdout.write(`${cfg.t('new.fill_description', { key: cfg.keys.description })}\n`);
  }
  return 0;
}
