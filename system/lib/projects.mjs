// Coding projects: which project a folder belongs to, its dev sector in the vault (created on first
// use), the facts read from the code repository without any model, and the project brief the
// session start shows. Nothing here writes into the code repository.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeAtomic } from './fsafe.mjs';
import { scanText } from './secrets.mjs';
import { NAME_RE, SECTOR_ID_MAX, todayLocal } from './util.mjs';

/** The notes of a dev sector: role → file name per language, canonical type, pinned. */
export const DEV_NOTES = Object.freeze({
  overview: { en: 'overview', cs: 'prehled', type: 'fact', pin: true },
  handoff: { en: 'handoff', cs: 'predavka', type: 'list', pin: true },
  runbook: { en: 'runbook', cs: 'prikazy', type: 'procedure' },
  conventions: { en: 'conventions', cs: 'konvence', type: 'rule' },
  gotchas: { en: 'gotchas', cs: 'pasti', type: 'list' },
  deadends: { en: 'dead-ends', cs: 'slepe-ulicky', type: 'list' },
  map: { en: 'map', cs: 'mapa', type: 'fact' },
  log: { en: 'log', cs: 'zapisnik', type: 'list' },
});

/** remember --type → the note it goes to. */
export const REMEMBER_TYPES = Object.freeze({
  gotcha: 'gotchas', 'dead-end': 'deadends', todo: 'handoff', run: 'runbook', convention: 'conventions', fact: 'log', decision: 'log',
});

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'vendor', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.cache']);
const LANGS = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.cs': 'C#', '.cpp': 'C++',
  '.c': 'C', '.rb': 'Ruby', '.php': 'PHP', '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart', '.sql': 'SQL', '.sh': 'Shell',
  '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML',
};

function run(cmd, args, cwd, timeout = 3000) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : null;
}

/** github.com/owner/repo from any git remote form (https, ssh, scp-like), or null. */
export function remoteKey(url) {
  if (!url) return null;
  let s = String(url).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:\d+\//, '/');
  const [host, ...rest] = s.split('/').filter(Boolean);
  if (!host || rest.length < 1) return null;
  return `${host.toLowerCase()}/${rest.join('/')}`.toLowerCase();
}

/** The project a folder belongs to: { top, key, name } or null outside a git repository. */
export function identify(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const top = run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!top) return null;
  const topAbs = path.resolve(top);
  const remote = run('git', ['remote', 'get-url', 'origin'], topAbs);
  const key = remoteKey(remote) ?? `path:${path.basename(topAbs).toLowerCase()}`;
  const name = key.startsWith('path:') ? key.slice(5) : key.split('/').pop();
  return { top: topAbs, key, name };
}

/** The vault's project settings (memory.json "projects"), with defaults. */
export function projectSettings(cfg) {
  const p = cfg?.raw?.projects ?? {};
  return {
    auto_add: p.auto_add !== false,
    checkpoint: p.checkpoint !== false,
    autosync: p.autosync === true,
    error_lookup: p.error_lookup !== false,
    repos: p.repos && typeof p.repos === 'object' ? p.repos : {},
  };
}

/** The dev sector id of a project, or null. */
export function sectorFor(cfg, ident) {
  if (!ident) return null;
  const id = projectSettings(cfg).repos[ident.key];
  return typeof id === 'string' && fs.existsSync(path.join(cfg.root, cfg.dirs.sectors, id)) ? id : null;
}

/** Repository-relative POSIX path of a dev note in the vault. */
export function noteRel(cfg, sector, role) {
  const n = DEV_NOTES[role];
  return `${cfg.dirs.sectors}/${sector}/${n[cfg.lang] ?? n.en}.md`;
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'app';
}

function nextId(cfg, name) {
  const taken = (id) => fs.existsSync(path.join(cfg.root, cfg.dirs.sectors, id));
  if (!taken('dev')) return 'dev';
  const base = `dev-${slug(name)}`.slice(0, SECTOR_ID_MAX).replace(/-+$/, '');
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base.slice(0, SECTOR_ID_MAX - 3)}-${i}`;
    if (NAME_RE.test(id) && !taken(id)) return id;
  }
  return null;
}

const clean = (s) => (scanText(String(s ?? '')).length ? '' : String(s ?? '').replace(/\s+/g, ' ').trim());

/** Facts read from the code repository, without any model. */
export function repoFacts(top) {
  const facts = { name: path.basename(top), description: '', scripts: {}, stack: [], languages: [], readme: '' };
  const read = (rel) => { try { return fs.readFileSync(path.join(top, rel), 'utf8'); } catch { return null; } };
  const pkg = read('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      if (j.name) facts.name = clean(j.name);
      facts.description = clean(j.description).slice(0, 300);
      for (const k of ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'format']) if (j.scripts?.[k]) facts.scripts[k] = clean(j.scripts[k]).slice(0, 160);
      const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      const known = ['react', 'next', 'vue', 'nuxt', 'svelte', 'astro', 'express', 'fastify', 'nestjs', 'vite', 'typescript', 'tailwindcss', 'prisma', 'drizzle-orm', 'jest', 'vitest', 'playwright', 'electron'];
      facts.stack.push(...known.filter((d) => deps.includes(d) || deps.includes(`@${d}/core`)));
      const pm = fs.existsSync(path.join(top, 'pnpm-lock.yaml')) ? 'pnpm' : fs.existsSync(path.join(top, 'yarn.lock')) ? 'yarn' : fs.existsSync(path.join(top, 'bun.lockb')) ? 'bun' : 'npm';
      facts.stack.unshift(`Node.js (${pm})`);
      facts.runner = pm === 'npm' ? 'npm run' : pm;
    } catch { /* not JSON */ }
  }
  for (const [file, label] of [['pyproject.toml', 'Python'], ['requirements.txt', 'Python'], ['Cargo.toml', 'Rust'], ['go.mod', 'Go'], ['composer.json', 'PHP'], ['Gemfile', 'Ruby'], ['pom.xml', 'Java (Maven)'], ['build.gradle', 'Gradle'], ['Dockerfile', 'Docker']]) {
    if (read(file) !== null && !facts.stack.includes(label)) facts.stack.push(label);
  }
  const readme = read('README.md') ?? read('readme.md') ?? '';
  const para = readme.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).find((p) => p && !/^(#|!\[|<|\[!\[|---)/.test(p));
  facts.readme = clean(para ?? '').slice(0, 400);
  // Languages by file count (bounded walk).
  const counts = new Map();
  let seen = 0;
  const walk = (dir, depth) => {
    if (seen > 5000 || depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen > 5000) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), depth + 1); continue; }
      seen++;
      const lang = LANGS[path.extname(e.name).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  };
  walk(top, 0);
  facts.languages = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 4).map(([l]) => l);
  facts.topDirs = (() => { try { return fs.readdirSync(top, { withFileTypes: true }).filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')).map((e) => e.name).sort().slice(0, 15); } catch { return []; } })();
  return facts;
}

const T = {
  en: {
    overview: ['Project overview', 'What the project is, its stack and how to run it.'],
    handoff: ['Handoff', 'Where the last session stopped: done, next steps, open questions, branch.'],
    runbook: ['Runbook', 'Commands that are known to work: dev, test, build, lint, deploy; dependency pins and why.'],
    conventions: ['Conventions', 'How code is written in this project: do and do not, libraries, naming.'],
    gotchas: ['Gotchas', 'Errors met before: symptom, cause and the fix that worked.'],
    deadends: ['Dead ends', 'Approaches that were tried and failed, and why, so nobody tries them again.'],
    map: ['Code map', 'Where things are: main folders and entry points.'],
    log: ['Log', 'Short facts and decisions recorded during work, newest last.'],
    what: 'What it is', stack: 'Stack', how: 'How to run and test', where: 'Where things are', open: 'Open work',
    done: 'Done', next: 'Next', questions: 'Open questions', commands: 'Commands', pins: 'Dependency pins',
    doItems: 'Do', dontItems: 'Do not', none: '(nothing yet)',
  },
  cs: {
    overview: ['Přehled projektu', 'Co projekt je, na čem stojí a jak ho spustit.'],
    handoff: ['Předávka', 'Kde skončila poslední session: hotovo, další kroky, otevřené otázky, větev.'],
    runbook: ['Příkazy', 'Ověřené příkazy: vývoj, testy, build, lint, nasazení; zamčené verze závislostí a proč.'],
    conventions: ['Konvence', 'Jak se v projektu píše kód: dělej a nedělej, knihovny, pojmenování.'],
    gotchas: ['Pasti', 'Chyby, které už tu byly: příznak, příčina a oprava, která zabrala.'],
    deadends: ['Slepé uličky', 'Co se zkusilo a nefungovalo, a proč, aby to nikdo nezkoušel znovu.'],
    map: ['Mapa kódu', 'Kde co je: hlavní složky a vstupní body.'],
    log: ['Zápisník', 'Krátké fakty a rozhodnutí zapsané během práce, nejnovější dole.'],
    what: 'Co to je', stack: 'Technologie', how: 'Jak spustit a testovat', where: 'Kde co je', open: 'Rozdělané',
    done: 'Hotovo', next: 'Další kroky', questions: 'Otevřené otázky', commands: 'Příkazy', pins: 'Zamčené verze',
    doItems: 'Dělej', dontItems: 'Nedělej', none: '(zatím nic)',
  },
};

function noteText(cfg, role, body, day, projectName) {
  const t = T[cfg.lang] ?? T.en;
  const k = cfg.keys;
  const n = DEV_NOTES[role];
  const [title, desc] = t[role];
  const lines = ['---', `${k.type}: ${cfg.local('type', n.type)}`, `${k.status}: ${cfg.local('status', 'active')}`,
    `${k.description}: "${desc.replace(/"/g, "'")} (${projectName.replace(/"/g, "'")})"`, `${k.updated}: ${day}`];
  if (n.pin) lines.push(`${k.pin}: true`);
  lines.push('---', `# ${title}`, '', ...body, '');
  return lines.join('\n');
}

/** Creates the dev sector of a project and its notes; returns its id. Idempotent under a lock. */
export async function ensureProject(cfg, ident, { today, force = false } = {}) {
  const existing = sectorFor(cfg, ident);
  if (existing) return { id: existing, created: false };
  if (!force && !projectSettings(cfg).auto_add) return { id: null, created: false };
  const lockDir = path.join(cfg.root, '.memory-kit', 'projects');
  fs.mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, `${createHash('sha256').update(ident.key).digest('hex').slice(0, 12)}.lock`);
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return { id: null, created: false, busy: true }; }
  try {
    const id = nextId(cfg, ident.name);
    if (!id) return { id: null, created: false };
    const facts = repoFacts(ident.top);
    const t = T[cfg.lang] ?? T.en;
    const day = today ?? todayLocal();
    const { addSector } = await import('./commands/sector.mjs');
    const title = `${cfg.lang === 'cs' ? 'Vývoj' : 'Dev'}: ${facts.name}`;
    await addSector(cfg, {
      id, title,
      description: cfg.lang === 'cs'
        ? `Programování projektu ${facts.name}: rozhodnutí, pasti, slepé uličky, příkazy, konvence a předávka mezi sessions.`
        : `Coding on ${facts.name}: decisions, gotchas, dead ends, commands, conventions and the handoff between sessions.`,
      when_here: cfg.lang === 'cs' ? `Cokoli o kódu projektu ${facts.name}.` : `Anything about the code of ${facts.name}.`,
      not_here: cfg.lang === 'cs' ? 'Osobní věci a jiné projekty.' : 'Personal matters and other projects.',
      keywords: [...new Set([id, slug(facts.name), ...facts.languages.map((l) => l.toLowerCase()), 'code', 'bug', 'error', cfg.lang === 'cs' ? 'chyba' : 'build'])].slice(0, 12),
      today: day,
    });
    const scripts = Object.entries(facts.scripts).map(([k, v]) => `- \`${facts.runner ?? 'npm run'} ${k}\`: ${v}`);
    const notes = {
      overview: [`## ${t.what}`, facts.description || facts.readme || t.none, '', `## ${t.stack}`,
        [...facts.stack, ...facts.languages.filter((l) => !facts.stack.includes(l))].join(', ') || t.none, '',
        `## ${t.how}`, ...(scripts.length ? scripts : [t.none]), '', `## ${t.where}`, `- repo: \`${ident.key}\``,
        ...(facts.topDirs.length ? [`- ${facts.topDirs.map((d) => `\`${d}/\``).join(', ')}`] : []), '', `## ${t.open}`, t.none],
      handoff: [`## ${t.done}`, t.none, '', `## ${t.next}`, t.none, '', `## ${t.questions}`, t.none],
      runbook: [`## ${t.commands}`, ...(scripts.length ? scripts : [t.none]), '', `## ${t.pins}`, t.none],
      conventions: [`## ${t.doItems}`, t.none, '', `## ${t.dontItems}`, t.none],
      gotchas: [t.none], deadends: [t.none],
      map: facts.topDirs.length ? facts.topDirs.map((d) => `- \`${d}/\``) : [t.none],
      log: [t.none],
    };
    for (const [role, body] of Object.entries(notes)) {
      const abs = path.join(cfg.root, ...noteRel(cfg, id, role).split('/'));
      if (!fs.existsSync(abs)) writeAtomic(abs, noteText(cfg, role, body, day, facts.name));
    }
    setRepo(cfg, ident.key, id);
    return { id, created: true };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Records repo key → sector in memory.json "projects.repos" (other keys untouched). */
export function setRepo(cfg, key, id) {
  const abs = path.join(cfg.root, 'memory.json');
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
  j.projects = { ...(j.projects ?? {}), repos: { ...(j.projects?.repos ?? {}), [key]: id } };
  writeAtomic(abs, `${JSON.stringify(j, null, 2)}\n`);
  cfg.raw.projects = j.projects;
}

/** Appends one dated line to a dev note (secrets refused by the caller). */
export function appendLine(cfg, sector, role, line, { today } = {}) {
  const rel = noteRel(cfg, sector, role);
  const abs = path.join(cfg.root, ...rel.split('/'));
  let text = fs.readFileSync(abs, 'utf8');
  const none = (T[cfg.lang] ?? T.en).none;
  text = text.replace(new RegExp(`\\n${none.replace(/[()]/g, '\\$&')}\\n?$`), '\n');
  const day = today ?? todayLocal();
  text = text.replace(new RegExp(`^(${cfg.keys.updated}:) .*$`, 'm'), `$1 ${day}`);
  writeAtomic(abs, `${text.replace(/\s*$/, '')}\n${line}\n`);
  return rel;
}

/** The git state of the code repository for the start brief. */
export function gitState(top) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], top) ?? '?';
  const dirty = (run('git', ['status', '--porcelain'], top) ?? '').split('\n').filter(Boolean).length;
  const commits = (run('git', ['log', '-3', '--format=%h %s (%cr)'], top) ?? '').split('\n').filter(Boolean);
  const head = run('git', ['rev-parse', 'HEAD'], top);
  return { branch, dirty, commits, head };
}

function bodyOf(cfg, sector, role, max) {
  try {
    const text = fs.readFileSync(path.join(cfg.root, ...noteRel(cfg, sector, role).split('/')), 'utf8').replace(/\r\n/g, '\n');
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^# .*\n/, '').trim();
    return body.length > max ? `${body.slice(0, max)}…` : body;
  } catch {
    return '';
  }
}

/** The project brief printed above the start view. */
export function projectBrief(cfg, sector, ident, vaultCmd) {
  const cs = cfg.lang === 'cs';
  const g = gitState(ident.top);
  const t = T[cfg.lang] ?? T.en;
  const out = [
    cs ? `# Projekt ${ident.name} · sektor paměti \`${sector}\`` : `# Project ${ident.name} · memory sector \`${sector}\``,
    cs ? `Paměť projektu je mimo repo s kódem. Příkazy: \`${vaultCmd} <příkaz>\`. Zapsat: \`${vaultCmd} remember --type gotcha|dead-end|todo|run|convention|decision "…"\` (z repa projektu sám pozná projekt).`
      : `The project memory lives outside the code repository. Commands: \`${vaultCmd} <command>\`. Record: \`${vaultCmd} remember --type gotcha|dead-end|todo|run|convention|decision "…"\` (run inside the repo, it finds the project).`,
    '',
    cs ? `## Git: větev ${g.branch}, necommitnuté soubory ${g.dirty}` : `## Git: branch ${g.branch}, uncommitted files ${g.dirty}`,
    ...g.commits.map((c) => `- ${c}`),
  ];
  for (const [role, max] of [['handoff', 1200], ['conventions', 700], ['gotchas', 700], ['deadends', 400]]) {
    // Placeholders and headings with nothing under them cost tokens and say nothing.
    const lines = (bodyOf(cfg, sector, role, max) || '').split('\n').filter((l) => l.trim() && l.trim() !== t.none);
    const kept = lines.filter((l, i) => !/^#/.test(l) || (lines[i + 1] && !/^#/.test(lines[i + 1])));
    if (kept.some((l) => !/^#/.test(l))) out.push('', `## ${t[role][0]}`, ...kept);
  }
  return `${out.join('\n')}\n`;
}

/** Lines of gotchas / dead ends that share enough words with an error text. */
export function lookupError(cfg, sector, errorText, { max = 3 } = {}) {
  // Words of 4+ letters cut to 6, so watcher/watchers and build/builds meet; common words skipped.
  const STOP = new Set(['error', 'errors', 'failed', 'fails', 'cannot', 'with', 'from', 'that', 'this', 'when', 'then', 'code']);
  const words = (s) => new Set((String(s).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));
  const err = words(String(errorText).slice(0, 4000));
  if (err.size < 2) return [];
  const hits = [];
  for (const role of ['gotchas', 'deadends']) {
    const body = bodyOf(cfg, sector, role, 100000);
    for (const line of body.split('\n')) {
      if (!/^\s*-\s/.test(line)) continue;
      let shared = 0;
      for (const w of words(line)) if (err.has(w)) shared++;
      if (shared >= 3) hits.push({ score: shared, line: line.trim(), role });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, max);
}
