// `sector add|sleep|wake|off|list` (docs/architecture.md, 6 and 10.5). Manifests are the only
// source of truth about sectors. State changes rewrite only the state and updated lines of the
// manifest and move the folder into or out of the archive. Nothing is ever deleted.

import fs from 'node:fs';
import path from 'node:path';
import { serialize, updateFrontmatter } from '../frontmatter.mjs';
import { writeGenerated } from '../generate.mjs';
import { loadVault } from '../vault.mjs';
import {
  NAME_RE, SECTOR_ID_MAX, checkToday, finalText, git, isDate, isGitRepo, isReservedName, movePath,
  parseCli, readTextIfExists, replaceFile, splitList, todayLocal, toPosix, uniq, usageError,
} from '../util.mjs';

export const usage = 'sector add <id> [--privacy github|local] [--title …] [--description …] [--when …] [--not …] [--keywords a,b,c] | sector sleep|wake|off <id> | sector list';

export class SectorError extends Error {
  code = 'SECTOR';
  constructor(reason, message) {
    super(message);
    this.reason = reason; // 'invalid' | 'exists' | 'no_local_root' | 'unknown' | 'conflict' | 'locked'
  }
}

// ---------------------------------------------------------------------------------------------
// Bodies

function kitTemplate(cfg, name) {
  return readTextIfExists(path.join(cfg.root, 'system', 'templates', cfg.lang, 'kit', name))
    ?? readTextIfExists(path.join(cfg.root, 'system', 'templates', 'en', 'kit', name));
}

function fill(template, vars) {
  return template.replace(/\{\{(title|id|dir)\}\}/g, (all, key) => vars[key] ?? all);
}

function fallbackSectorBody(cfg) {
  const s = cfg.sections;
  return [
    '# {{title}}',
    '',
    `## ${s.sector_rules}`,
    '<!-- Numbered rules for agents working in this sector. Change them only with the owner\'s consent. -->',
    '',
    `## ${s.manual}`,
    '',
  ].join('\n');
}

function fallbackExportBody() {
  return [
    '# {{title}}',
    '> The content of this sector lives only in the local root, outside git.',
    '> This file holds only what agents may know about it.',
    '',
  ].join('\n');
}

function presetFor(cfg, id) {
  if (cfg.presets[id]) return cfg.presets[id];
  return Object.values(cfg.presets).find((p) => p && p.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------
// add

/** Creates a sector manifest (and for local sectors the export file and the local folder). */
export async function addSector(cfg, {
  id, privacy = 'github', title, description, when_here, not_here, keywords = [], links = [], today,
}) {
  const sid = String(id ?? '').trim();
  if (!NAME_RE.test(sid) || sid.length > SECTOR_ID_MAX) throw new SectorError('invalid', cfg.t('sector.invalid', { id: sid }));
  if (isReservedName(sid)) throw new SectorError('invalid', cfg.t('sector.reserved', { id: sid }));
  const canonPrivacy = cfg.canon('privacy', String(privacy ?? 'github'));
  if (!canonPrivacy) throw new SectorError('invalid', `refused: unknown privacy "${privacy}" (github or local)`);
  const day = today ?? todayLocal();
  if (!isDate(day)) throw new SectorError('invalid', `refused: bad date "${day}"`);

  const vault = loadVault(cfg);
  if (vault.sectorById.has(sid)) throw new SectorError('exists', cfg.t('sector.exists', { id: sid }));
  const localRoot = cfg.roots.find((r) => r.id !== 'main' && r.privacy === 'local');
  if (canonPrivacy === 'local' && !localRoot) throw new SectorError('no_local_root', cfg.t('sector.no_local_root'));
  if (canonPrivacy === 'local' && localRoot.foreign) {
    throw new SectorError('no_local_root', cfg.t('sector.foreign_root', { path: localRoot.path }));
  }

  const { sectors, inbox } = cfg.dirs;
  const dir = `${sectors}/${sid}`;
  const manifestRel = `${dir}/_${sid}.md`;
  const exportRel = `${dir}/_${sid}${cfg.exportSuffix}.md`;
  const abs = (rel, base = cfg.root) => path.join(base, ...rel.split('/'));
  for (const rel of canonPrivacy === 'local' ? [manifestRel, exportRel] : [manifestRel]) {
    if (fs.existsSync(abs(rel))) throw new SectorError('conflict', cfg.t('sector.conflict', { rel }));
  }

  const displayTitle = String(title ?? '').trim() || sid.charAt(0).toUpperCase() + sid.slice(1).replace(/-/g, ' ');
  const k = cfg.keys;
  const kw = uniq((keywords.length ? keywords : [sid, displayTitle.toLowerCase()]).map((s) => String(s).trim()).filter(Boolean));
  const data = {
    [k.type]: cfg.local('type', 'sector'),
    [k.status]: cfg.local('status', 'active'),
    [k.description]: String(description ?? '').trim() || cfg.t('sector.default_description', { title: displayTitle }),
    [k.updated]: day,
  };
  if (displayTitle.toLowerCase() !== sid) data.aliases = [displayTitle];
  data[k.keywords] = kw;
  data[k.state] = cfg.local('state', 'on');
  data[k.privacy] = cfg.local('privacy', canonPrivacy);
  data[k.when_here] = String(when_here ?? '').trim() || cfg.t('sector.default_when', { title: displayTitle });
  data[k.not_here] = String(not_here ?? '').trim() || cfg.t('sector.default_not', { title: displayTitle });
  if (links.length) data[k.links] = links;

  const vars = { title: displayTitle, id: sid, dir };
  const body = fill(kitTemplate(cfg, 'sector.md') ?? fallbackSectorBody(cfg), vars);
  fs.mkdirSync(abs(dir), { recursive: true });
  fs.writeFileSync(abs(manifestRel), finalText(serialize(data, { order: cfg.keyOrder }) + body), { flag: 'wx' });
  const created = [manifestRel];

  if (canonPrivacy === 'local') {
    const exportData = {
      [k.type]: cfg.local('type', 'hub'),
      [k.status]: cfg.local('status', 'active'),
      [k.description]: cfg.t('sector.export_description', { title: displayTitle }),
      [k.updated]: day,
    };
    const exportBody = fill(kitTemplate(cfg, 'export.md') ?? fallbackExportBody(), vars);
    fs.writeFileSync(abs(exportRel), finalText(serialize(exportData, { order: cfg.keyOrder }) + exportBody), { flag: 'wx' });
    created.push(exportRel);
    for (const rel of [dir, inbox]) {
      const target = abs(rel, localRoot.path);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
        created.push(`${toPosix(path.relative(cfg.root, target))}/`);
      }
    }
  }
  return { rel: manifestRel, created };
}

// ---------------------------------------------------------------------------------------------
// sleep / wake / off

function isTracked(root, rel) {
  if (!isGitRepo(root)) return false;
  const res = git(root, ['ls-files', '--', rel], { allowFail: true });
  return res.ok && res.stdout.trim() !== '';
}

/**
 * Moves the sector folder fromRel to toRel in each root that has it: the local roots first, the
 * main root (git mv for tracked content, see movePath) last. Renames retry while Windows reports
 * a file in use; when a move still fails, the moves already done are undone, so the manifest and
 * the local notes never end up split, and SectorError('locked') says what to close.
 * The caller has checked that toRel exists in none of the roots. Returns { main: true when the
 * main root's folder moved, unstaged: the moved folders git could not stage }.
 */
function moveSectorDirs(cfg, roots, fromRel, toRel) {
  const shown = (root, rel) => (root === cfg.root ? rel : toPosix(path.relative(cfg.root, path.join(root, ...rel.split('/')))));
  const done = [];
  const unstaged = [];
  for (const root of [...roots.slice(1), roots[0]]) {
    if (!fs.existsSync(path.join(root, ...fromRel.split('/')))) continue;
    const useGit = isTracked(root, fromRel);
    try {
      if (movePath(root, fromRel, toRel, { useGit }) === 'unstaged') unstaged.push(shown(root, toRel));
      done.push({ root, useGit });
    } catch (err) {
      const lines = [cfg.t('sector.move_failed', { dir: shown(root, fromRel), detail: err?.code ?? err?.message ?? err })];
      for (const prev of done.reverse()) {
        try {
          movePath(prev.root, toRel, fromRel, { useGit: prev.useGit });
        } catch (back) {
          lines.push(cfg.t('sector.move_back_failed', {
            from: shown(prev.root, toRel), to: shown(prev.root, fromRel), detail: back?.code ?? back?.message ?? back,
          }));
        }
      }
      throw new SectorError('locked', lines.join('\n'));
    }
  }
  return { main: done.some((d) => d.root === roots[0]), unstaged };
}

/** Sets a sector state; off moves the folder into the archive, on/sleep move it back. */
export async function setSectorState(cfg, id, state, { today } = {}) {
  const target = cfg.canon('state', String(state ?? ''));
  if (!target) throw new SectorError('invalid', `refused: unknown state "${state}" (on, sleep, off)`);
  const day = today ?? todayLocal();
  if (!isDate(day)) throw new SectorError('invalid', `refused: bad date "${day}"`);
  const vault = loadVault(cfg, { includeInbox: false });
  const sector = vault.sectorById.get(String(id ?? ''));
  if (!sector) throw new SectorError('unknown', cfg.t('sector.unknown', { id }));

  const { sectors, archive } = cfg.dirs;
  const liveDir = `${sectors}/${sector.id}`;
  const archiveDir = `${archive}/${sectors}/${sector.id}`;
  const inArchive = sector.dir === archiveDir;
  const wantArchive = target === 'off';
  let moved = false;
  let unstaged = [];
  if (inArchive !== wantArchive) {
    const [from, to] = wantArchive ? [liveDir, archiveDir] : [archiveDir, liveDir];
    // The local content follows the manifest into or out of the local root's archive.
    const roots = [cfg.root, ...cfg.roots.slice(1).filter((r) => r.exists).map((r) => r.path)]
      .filter((root, i) => i === 0 || fs.existsSync(path.join(root, ...from.split('/'))));
    for (const root of roots) {
      if (fs.existsSync(path.join(root, ...to.split('/')))) {
        throw new SectorError('conflict', cfg.t('sector.conflict', { rel: to }));
      }
    }
    ({ main: moved, unstaged } = moveSectorDirs(cfg, roots, from, to));
  }
  const dir = wantArchive ? archiveDir : liveDir;
  const rel = `${dir}/_${sector.id}.md`;
  // unstaged: folders that moved while git could not stage the move (git add -A stages them).
  const extra = unstaged.length ? { unstaged } : {};
  if (sector.state === target && !moved) return { rel, moved: false, unchanged: true, ...extra };

  const abs = path.join(cfg.root, ...rel.split('/'));
  const text = fs.readFileSync(abs, 'utf8');
  const k = cfg.keys;
  const next = updateFrontmatter(text, { [k.state]: cfg.local('state', target), [k.updated]: day }, { order: cfg.keyOrder });
  if (next !== text) replaceFile(abs, next);
  return { rel, moved, ...extra };
}

// ---------------------------------------------------------------------------------------------
// CLI

async function regenerate(cfg) {
  try {
    await writeGenerated(cfg, loadVault(cfg));
    return true;
  } catch (err) {
    process.stderr.write(`${cfg.t('sector.regenerate_failed', { detail: err?.message ?? err })}\n`);
    return false;
  }
}

function listSectors(cfg) {
  const vault = loadVault(cfg, { includeInbox: false });
  const lines = vault.sectors.map((s) => [
    s.id, cfg.local('state', s.state), cfg.local('privacy', s.privacy), `${s.notes} ${cfg.t('start.col_notes')}`, s.description || '–',
  ].join(' · '));
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, {
    privacy: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    when: { type: 'string' },
    not: { type: 'string' },
    keywords: { type: 'string' },
    today: { type: 'string' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  const [sub, id, extra] = positionals;
  if (!checkToday(values.today, usage)) return 2;
  if (sub === 'list') return listSectors(cfg);
  if (!['add', 'sleep', 'wake', 'off'].includes(sub)) {
    usageError(sub ? `unknown sector subcommand "${sub}"` : 'missing subcommand', usage);
    return 2;
  }
  if (!id || extra !== undefined) {
    usageError(!id ? 'missing sector id' : `unexpected argument "${extra}"`, usage);
    return 2;
  }
  if (values.privacy !== undefined && !cfg.canon('privacy', values.privacy)) {
    usageError(`--privacy must be github or local, got "${values.privacy}"`, usage);
    return 2;
  }

  try {
    if (sub === 'add') {
      const preset = presetFor(cfg, id) ?? {};
      const res = await addSector(cfg, {
        id,
        privacy: values.privacy ?? preset.privacy ?? 'github',
        title: values.title ?? preset.title,
        description: values.description ?? preset.description,
        when_here: values.when ?? preset.when_here,
        not_here: values.not ?? preset.not_here,
        keywords: values.keywords !== undefined ? splitList(values.keywords) : Array.isArray(preset.keywords) ? preset.keywords : [],
        today: values.today,
      });
      const privacy = cfg.canon('privacy', values.privacy ?? preset.privacy ?? 'github');
      process.stdout.write(`${cfg.t('sector.added', { id, privacy: cfg.local('privacy', privacy), rel: res.rel })}\n`);
      const missing = [];
      const k = cfg.keys;
      if (!(values.description ?? preset.description)) missing.push(k.description);
      if (!(values.when ?? preset.when_here)) missing.push(k.when_here);
      if (!(values.not ?? preset.not_here)) missing.push(k.not_here);
      if (values.keywords === undefined && !preset.keywords) missing.push(k.keywords);
      if (missing.length) process.stdout.write(`${cfg.t('sector.fill', { keys: missing.join(', '), rel: res.rel })}\n`);
    } else {
      const state = sub === 'sleep' ? 'sleep' : sub === 'off' ? 'off' : 'on';
      const res = await setSectorState(cfg, id, state, { today: values.today });
      const vars = { id, state: cfg.local('state', state), dir: path.posix.dirname(res.rel) };
      const key = res.unchanged ? 'sector.unchanged' : res.moved ? 'sector.moved' : 'sector.state';
      process.stdout.write(`${cfg.t(key, vars)}\n`);
      for (const dir of res.unstaged ?? []) process.stderr.write(`${cfg.t('sector.unstaged', { dir })}\n`);
      if (res.unchanged) return 0;
    }
  } catch (err) {
    if (err instanceof SectorError) {
      process.stdout.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  return (await regenerate(cfg)) ? 0 : 1;
}
