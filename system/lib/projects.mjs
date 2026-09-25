// Coding projects: which project a folder belongs to (its identity from the git remotes, else the
// root commit, else the folder name), whether the vault knows it, ignores it or has never seen it,
// its dev sector (made by `project add`, or by the session start when projects.auto_add is on),
// where the notes of that sector live, and the project brief of the session start.
// Store "local" (the default) keeps the notes and the repository → sector mapping in the local root
// and gives the committed manifest and export file neutral texts, so nothing about a client's
// repository reaches git. Store "git" keeps them in the repository like any other sector.
// Nothing here writes into the code repository.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeAtomic } from './fsafe.mjs';
import { detectStyle, formatJson } from './jsonc.mjs';
import { commandNode } from './nodepath.mjs';
import { readSessionFile, safeId, sessionsDir as sessionsIn } from './hookinput.mjs';
import { NAME_RE, SECTOR_ID_MAX, WORK_DIR, ensureWorkDirIgnored, insidePath, realpathLoose, todayLocal, toPosix } from './util.mjs';

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

export const STORES = Object.freeze(['local', 'git']);
const LOCAL_MAP = 'projects.json';
const LOCK_STALE_MS = 2 * 60 * 1000;

/**
 * A problem `project add` reports: reason is 'foreign_root' | 'inside_root' | 'no_id' | 'busy' |
 * 'no_commit' | 'slow' | 'local_map' (<localRoot>/projects.json exists but is not JSON: detail is
 * its path, and it is never overwritten).
 */
export class ProjectError extends Error {
  constructor(reason, detail = '') {
    super(`${reason}${detail ? `: ${detail}` : ''}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const runRaw = (cmd, args, cwd, timeout = 5000) => spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

function run(cmd, args, cwd, timeout = 5000) {
  const res = runRaw(cmd, args, cwd, timeout);
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout.trim() : null;
}

/**
 * Before the first file of .memory-kit/ in this clone (session records, the ignore list, the hook
 * log): keeps the folder out of git (util.ensureWorkDirIgnored). Autosync and doctor check again.
 */
export function keepWorkDirOut(cfg) {
  if (fs.existsSync(path.join(cfg.root, WORK_DIR))) return;
  try {
    ensureWorkDirIgnored(cfg.root);
  } catch {
    /* autosync refuses to commit and doctor warns while it is not ignored */
  }
}

/** The first 12 hex digits of the SHA-256 of a text: how logs and marker files name a repository. */
export function repoHash(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

/**
 * The vault's CLI as a command to paste into any shell: the Node.js running now (nodepath.mjs
 * commandNode: its full path, so a repository that pins an older Node.js through nvm, fnm, volta,
 * mise or asdf cannot refuse the command; `node` only when the path cannot go into a command) and
 * the script path in double quotes with forward slashes, which sh, bash (Git Bash too), zsh,
 * PowerShell and cmd all read alike (Git Bash would drop the backslashes of an unquoted Windows
 * path). A script path with ", $, `, % or ! (which some of those shells expand inside double
 * quotes) goes into single quotes instead. In a hook, the Node.js running now is the one the hook
 * command names.
 */
export function vaultCommand(cfg, { platform = process.platform, execPath = process.execPath, realpath } = {}) {
  const root = platform === 'win32' ? String(cfg.root).replace(/\\/g, '/') : String(cfg.root);
  const script = `${root.replace(/\/+$/, '')}/system/memory.mjs`;
  const node = commandNode({ platform, execPath, realpath });
  if (!/["$`%!\r\n]/.test(script)) return `${node} "${script}"`;
  return `${node} '${script.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------------------------
// Identity

/**
 * host/owner/repo from a git remote URL (https, ssh, scp-like, git://), lowercase: userinfo,
 * ports, www. and .git are dropped, ssh.github.com is github.com, and the Azure DevOps forms
 * (dev.azure.com/org/project/_git/repo, ssh.dev.azure.com:v3/…, org@vs-ssh.visualstudio.com:v3/…,
 * org.visualstudio.com/project/_git/repo) all give dev.azure.com/org/project/repo. A local path
 * or file:// URL gives file:<folder name>@<8 hex of the whole path> (a relative path is taken from
 * `base`, the top of the repository), so two local remotes with the same folder name stay apart.
 * null when nothing usable is left.
 */
export function remoteKey(url, base) {
  const s = String(url ?? '').trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s) || /^[a-z]:[\\/]/i.test(s) || /^[\\/.~]/.test(s)) {
    let p = s.replace(/^file:\/\//i, '').replace(/^\/([a-z]:[\\/])/i, '$1');
    if (/^\.\.?([\\/]|$)/.test(p) && base) p = path.resolve(base, p);
    p = p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
    const name = p.split('/').pop();
    return name ? `file:${name}@${createHash('sha256').update(p).digest('hex').slice(0, 8)}` : null;
  }
  let host;
  let rest;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(s);
  if (scheme) {
    const slash = scheme[1].indexOf('/');
    const authority = slash < 0 ? scheme[1] : scheme[1].slice(0, slash);
    rest = slash < 0 ? '' : scheme[1].slice(slash + 1);
    host = authority.replace(/^.*@/, '').replace(/:\d*$/, '');
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(s);
    if (!scp) return null;
    [, host, rest] = scp;
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (host === 'ssh.github.com') host = 'github.com';
  let parts = rest.split(/[?#]/)[0].split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.git$/i, '');
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    host = 'dev.azure.com';
    if (parts[0] === 'v3') parts = parts.slice(1);
  }
  const vso = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);
  if (vso) {
    host = 'dev.azure.com';
    parts = [vso[1], ...parts];
  }
  if (host === 'dev.azure.com') parts = parts.filter((p, i) => p !== '_git' && !(i === 1 && p.toLowerCase() === 'defaultcollection'));
  parts = parts.filter(Boolean);
  if (!host || !parts.length) return null;
  return `${host}/${parts.join('/')}`.toLowerCase();
}

/** owner/repo of a host key ('github.com-work/linden/shop' → 'linden/shop'); null for root:, path:, file:. */
export function keyPath(key) {
  const k = String(key ?? '');
  if (/^(root|path|file):/.test(k)) return null;
  const i = k.indexOf('/');
  return i > 0 && i < k.length - 1 ? k.slice(i + 1) : null;
}

const ROOTS_CACHE_MAX = 200;

/** How roots.json names a top folder: a hash of its real path (the path itself names a client). */
const folderKey = (real) => createHash('sha256').update(String(real)).digest('hex').slice(0, 16);

/**
 * The root commit of a repository without remotes (the first by hash when there are several):
 * { sha } or { why: 'no_commit' | 'slow' }. Walking the history takes seconds in a big repository,
 * so the answer is kept per top folder (folderKey) in cacheFile and only confirmed (one cheap git
 * call) later.
 */
function rootCommit(top, cacheFile) {
  const real = folderKey(realpathLoose(top));
  const cache = cacheFile ? readJsonFile(cacheFile) : null;
  const known = isObj(cache?.roots) ? cache.roots[real] : null;
  if (typeof known === 'string' && /^[0-9a-f]{40,64}$/.test(known) && run('git', ['cat-file', '-e', `${known}^{commit}`], top) !== null) return { sha: known };
  const res = runRaw('git', ['rev-list', '--max-parents=0', 'HEAD'], top);
  if (res.error?.code === 'ETIMEDOUT' || (res.signal && res.status === null)) return { why: 'slow' };
  const roots = (res.status === 0 ? String(res.stdout ?? '') : '').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)).sort();
  if (!roots.length) return { why: 'no_commit' };
  if (cacheFile) {
    try {
      // Entries of older versions were keyed by the path itself: they go.
      const entries = Object.entries(isObj(cache?.roots) ? cache.roots : {}).filter(([k]) => k !== real && /^[0-9a-f]{16}$/.test(k));
      writeAtomic(cacheFile, `${JSON.stringify({ version: 1, roots: Object.fromEntries([...entries.slice(-(ROOTS_CACHE_MAX - 1)), [real, roots[0]]]) })}\n`);
    } catch {
      /* the cache is only a shortcut */
    }
  }
  return { sha: roots[0] };
}

/**
 * The project a folder belongs to: { top, key, name, legacy, unsettled? } or null outside a git
 * repository. key: the origin remote, else the first remote by name, else root:<12 hex of the root
 * commit>, else path:<folder name> with unsettled 'no_commit' (no commit yet) or 'slow' (git took
 * too long): such a key is not lasting, so no project is ever made under it. legacy is the
 * path:<folder name> key older versions gave a repository without a remote. Worktrees and
 * subfolders give the key of their repository. cacheFile keeps root commits (see identifyIn).
 */
export function identify(cwd, { cacheFile } = {}) {
  if (!cwd) return null;
  try {
    if (!fs.statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  const out = run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (!out) return null;
  const top = path.resolve(out);
  const folder = path.basename(top).toLowerCase();
  const urls = new Map();
  for (const line of (run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], top) ?? '').split('\n')) {
    const m = /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim());
    if (m && !urls.has(m[1])) urls.set(m[1], m[2]);
  }
  const names = [...urls.keys()].sort();
  let key = null;
  let unsettled;
  for (const name of urls.has('origin') ? ['origin', ...names] : names) {
    key = remoteKey(urls.get(name), top);
    if (key) break;
  }
  if (!key) {
    const root = rootCommit(top, cacheFile);
    key = root.sha ? `root:${root.sha.slice(0, 12)}` : `path:${folder}`;
    unsettled = root.why;
  }
  const name = /^(root|path):/.test(key) ? path.basename(top) : key.replace(/^file:/, '').replace(/@[0-9a-f]+$/, '').split('/').pop();
  return { top, key, name, legacy: `path:${folder}`, ...(unsettled ? { unsettled } : {}) };
}

/** identify() with the root-commit cache of the vault (.memory-kit/projects/roots.json). */
export function identifyIn(cfg, cwd) {
  return identify(cwd, { cacheFile: path.join(cfg.root, '.memory-kit', 'projects', 'roots.json') });
}

/** True for a key without a remote behind it (root:, path:): only these may use a legacy key. */
const remoteless = (key) => /^(root|path):/.test(String(key ?? ''));

/** True when dir is the vault or lies inside it. */
export function insideVault(cfg, dir) {
  if (!dir) return false;
  return insidePath(realpathLoose(cfg.root), realpathLoose(dir));
}

// ---------------------------------------------------------------------------------------------
// Settings, the local root and the mappings

/** memory.json "projects" with the defaults of the settings contract (a missing key is the default). */
export function projectSettings(cfg) {
  const p = isObj(cfg?.raw?.projects) ? cfg.raw.projects : {};
  return {
    enabled: p.enabled === true,
    auto_add: p.auto_add === true,
    store: p.store === 'git' ? 'git' : 'local',
    autosync: p.autosync === true,
    checkpoint: p.checkpoint !== false,
    error_lookup: p.error_lookup !== false,
    repos: isObj(p.repos) ? p.repos : {},
  };
}

/** The first local root usable on this computer, or null. */
export function localRoot(cfg) {
  return cfg.roots?.find((r) => r.id !== 'main' && r.privacy === 'local' && !r.foreign) ?? null;
}

/**
 * Makes sure the vault has a local root: when memory.json has none, appends
 * {id: 'private', path: '../<vault folder>-private', privacy: 'local'} (other keys kept) and creates
 * the folder; cfg.roots and cfg.raw are reloaded. Throws ProjectError('foreign_root') when the
 * local root is an absolute path of another operating system.
 */
export async function ensureLocalRoot(cfg) {
  const have = cfg.roots?.find((r) => r.id !== 'main' && r.privacy === 'local');
  if (have?.foreign) throw new ProjectError('foreign_root', have.path);
  if (have) {
    fs.mkdirSync(have.path, { recursive: true });
    return { root: have, created: false };
  }
  const rel = `../${path.basename(cfg.root)}-private`;
  const abs = path.resolve(cfg.root, rel);
  if (!path.basename(cfg.root) || insidePath(realpathLoose(cfg.root), realpathLoose(abs))) throw new ProjectError('inside_root', rel);
  const file = path.join(cfg.root, 'memory.json');
  const { value: j, text } = readJsonText(file);
  const roots = Array.isArray(j.roots) && j.roots.length ? j.roots : [{ id: 'main', path: '.', privacy: 'github' }];
  const ids = new Set(roots.map((r) => r?.id));
  let id = 'private';
  for (let i = 2; ids.has(id); i++) id = `private-${i}`;
  j.roots = [...roots, { id, path: rel, privacy: 'local' }];
  fs.mkdirSync(abs, { recursive: true });
  writeAtomic(file, formatJson(j, detectStyle(text)));
  const { loadConfig } = await import('./config.mjs');
  const fresh = loadConfig(cfg.root);
  cfg.roots = fresh.roots;
  cfg.raw = fresh.raw;
  return { root: localRoot(cfg), created: true, rel };
}

/**
 * A JSON file as { value, text } (a byte order mark, as Windows PowerShell 5.1 and older Notepad
 * write it, is dropped); throws when it cannot be read or parsed.
 */
function readJsonText(abs) {
  const text = fs.readFileSync(abs, 'utf8');
  return { value: JSON.parse(text.replace(/^\uFEFF/, '')), text };
}

function readJsonFile(abs) {
  try {
    const j = readJsonText(abs).value;
    return isObj(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * <localRoot>/projects.json: { version: 1, repos: {key: id}, ignored? } (kept outside git), plus
 * broken: true (and nothing in it) when the file is there but is not a JSON object: readers then
 * see no projects, and writeLocalMap refuses, so a hand edit gone wrong never loses the links.
 */
function readLocalMap(cfg) {
  const lr = localRoot(cfg);
  if (!lr) return { version: 1, repos: {} };
  const file = path.join(lr.path, LOCAL_MAP);
  let j = null;
  try {
    j = readJsonText(file).value;
  } catch (err) {
    if (err?.code === 'ENOENT') return { version: 1, repos: {} };
  }
  if (!isObj(j)) return { version: 1, repos: {}, broken: true };
  return { ...j, version: 1, repos: isObj(j.repos) ? j.repos : {} };
}

function writeLocalMap(cfg, map) {
  const lr = localRoot(cfg);
  if (!lr) throw new ProjectError('foreign_root');
  const file = path.join(lr.path, LOCAL_MAP);
  if (map.broken || readLocalMap(cfg).broken) throw new ProjectError('local_map', file);
  let style;
  try {
    style = detectStyle(fs.readFileSync(file, 'utf8'));
  } catch {
    style = detectStyle('');
  }
  const repos = Object.fromEntries(Object.entries(map.repos).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const { broken, ...rest } = map;
  writeAtomic(file, formatJson({ ...rest, version: 1, repos }, style));
}

/** Every known mapping: [{ key, id, store }] (local ones first). */
export function mappings(cfg) {
  const out = [];
  for (const [key, id] of Object.entries(readLocalMap(cfg).repos)) if (typeof id === 'string' && NAME_RE.test(id)) out.push({ key, id, store: 'local' });
  for (const [key, id] of Object.entries(projectSettings(cfg).repos)) if (typeof id === 'string' && NAME_RE.test(id)) out.push({ key, id, store: 'git' });
  return out;
}

/** True when the sector's manifest folder exists in the main root. */
export function sectorExists(cfg, id) {
  return typeof id === 'string' && NAME_RE.test(id) && fs.existsSync(path.join(cfg.root, cfg.dirs.sectors, id));
}

/** The host a git ssh alias stands for: 'github.com-work' → 'github.com'; other hosts stay. */
function aliasBase(host) {
  return /^(.*\.[^.-]+)-[^.]+$/.exec(host)?.[1] ?? host;
}

/**
 * True when two remote hosts are one server: the same host, or the same host under an ssh alias
 * that names it (github.com-work, github.com-home and github.com). Two different hosts
 * (github.com and gitlab.example) never are, and neither is an alias that does not name its host
 * ("work"): it may stand for any server, a client's own among them.
 */
export function sameServer(a, b) {
  return a === b || aliasBase(a) === aliasBase(b);
}

const hostOf = (key) => String(key).slice(0, String(key).indexOf('/'));

/**
 * The known project of an identity: { key, id, store, exact } or null. The exact key first. Then,
 * unless exactOnly or the repository is ignored, a looser match: the one sector mapped under the
 * same owner/repo on the same server under another host name (sameServer: ssh host aliases); for
 * a repository without a remote, the path:<folder> key older versions used. Mappings whose sector
 * is gone do not count.
 */
export function findProject(cfg, ident, { exactOnly = false } = {}) {
  if (!ident) return null;
  const all = mappings(cfg).filter((m) => sectorExists(cfg, m.id));
  const exact = all.find((m) => m.key === ident.key);
  if (exact) return { ...exact, exact: true };
  if (exactOnly || isIgnored(cfg, ident)) return null;
  const own = keyPath(ident.key);
  if (own) {
    const same = all.filter((m) => keyPath(m.key) === own && sameServer(hostOf(m.key), hostOf(ident.key)));
    if (same.length && new Set(same.map((m) => m.id)).size === 1) return { ...same[0], exact: false };
  }
  const legacy = remoteless(ident.key) ? all.find((m) => m.key === ident.legacy) : null;
  return legacy ? { ...legacy, exact: false } : null;
}

/** The dev sector id of a project, or null. */
export function sectorFor(cfg, ident) {
  return findProject(cfg, ident)?.id ?? null;
}

/** Links a repository key to a sector in its store. */
export function setMapping(cfg, key, id, store) {
  if (store === 'local') {
    const map = readLocalMap(cfg);
    map.repos[key] = id;
    writeLocalMap(cfg, map);
    return;
  }
  const abs = path.join(cfg.root, 'memory.json');
  const { value: j, text } = readJsonText(abs);
  j.projects = { ...(isObj(j.projects) ? j.projects : {}), repos: { ...(isObj(j.projects?.repos) ? j.projects.repos : {}), [key]: id } };
  writeAtomic(abs, formatJson(j, detectStyle(text)));
  cfg.raw.projects = j.projects;
}

/** Unlinks a repository key; true when a mapping was removed. The sector and its notes stay. */
export function unsetMapping(cfg, key, store) {
  if (store === 'local') {
    const map = readLocalMap(cfg);
    if (!Object.hasOwn(map.repos, key)) return false;
    delete map.repos[key];
    writeLocalMap(cfg, map);
    return true;
  }
  const abs = path.join(cfg.root, 'memory.json');
  const { value: j, text } = readJsonText(abs);
  if (!isObj(j.projects?.repos) || !Object.hasOwn(j.projects.repos, key)) return false;
  delete j.projects.repos[key];
  writeAtomic(abs, formatJson(j, detectStyle(text)));
  cfg.raw.projects = j.projects;
  return true;
}

const projectsDir = (cfg) => path.join(cfg.root, '.memory-kit', 'projects');
const ignoredFile = (cfg) => path.join(projectsDir(cfg), 'ignored.json');
const keyList = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []);
const HASHED = /^[0-9a-f]{12}$/;
/** The side list keeps repoHash(key) only (older versions kept the key itself). */
const hashedList = (v) => [...new Set(keyList(v).map((k) => (HASHED.test(k) ? k : repoHash(k))))].sort();

/**
 * Ignored repositories, never committed: the keys of "ignored" in <localRoot>/projects.json, plus
 * the hashes (repoHash) of .memory-kit/projects/ignored.json, where they go while the vault has
 * no local root: that folder is only compared against, so it holds no repository URL.
 */
export function ignoredKeys(cfg) {
  const local = keyList(readLocalMap(cfg).ignored);
  const known = new Set(local.map((k) => repoHash(k)));
  return [...new Set([...local, ...hashedList(readJsonFile(ignoredFile(cfg))?.ignored).filter((h) => !known.has(h))])];
}

/** True when the repository is ignored (the folder key of older versions counts without a remote). */
export function isIgnored(cfg, ident) {
  if (!ident) return false;
  const keys = new Set(ignoredKeys(cfg));
  const has = (k) => keys.has(k) || keys.has(repoHash(k));
  return has(ident.key) || (remoteless(ident.key) && has(ident.legacy));
}

/**
 * Adds (on) a key to the ignore list of the local root (or, as a hash, of .memory-kit/projects
 * while there is none), or removes it (off) from both lists; true when a list changed.
 */
export function setIgnored(cfg, key, on) {
  const lr = localRoot(cfg);
  const local = lr ? readLocalMap(cfg) : null;
  const side = readJsonFile(ignoredFile(cfg));
  const sideList = hashedList(side?.ignored);
  const inLocal = keyList(local?.ignored).includes(key);
  const inSide = sideList.includes(repoHash(key));
  const writeSide = (list) => writeAtomic(ignoredFile(cfg), `${JSON.stringify({ version: 1, ignored: list }, null, 2)}\n`);
  if (on) {
    if (inLocal || inSide) return false;
    if (local) writeLocalMap(cfg, { ...local, ignored: [...keyList(local.ignored), key].sort() });
    else writeSide([...sideList, repoHash(key)].sort());
    return true;
  }
  if (inLocal) writeLocalMap(cfg, { ...local, ignored: keyList(local.ignored).filter((k) => k !== key) });
  if (inSide) writeSide(sideList.filter((k) => k !== repoHash(key)));
  return inLocal || inSide;
}

/** The marker of the one-time hint in a repository the vault does not know. */
export function hintMarker(cfg, key) {
  return path.join(projectsDir(cfg), 'hinted', repoHash(key));
}

// ---------------------------------------------------------------------------------------------
// Notes

/** Vault-relative POSIX path of a dev note inside its root (the main root or the local root). */
export function noteRel(cfg, sector, role) {
  const n = DEV_NOTES[role];
  return `${cfg.dirs.sectors}/${sector}/${n[cfg.lang] ?? n.en}.md`;
}

/** True when the sector keeps its content in the local root (a local-store project). */
export function isLocalSector(cfg, sector) {
  const lr = localRoot(cfg);
  return Boolean(lr && sector && fs.existsSync(path.join(lr.path, cfg.dirs.sectors, sector)));
}

/** The absolute path of a dev note: in the local root for local sectors, else in the vault. */
export function noteAbs(cfg, sector, role) {
  const base = isLocalSector(cfg, sector) ? localRoot(cfg).path : cfg.root;
  return path.join(base, ...noteRel(cfg, sector, role).split('/'));
}

/** A path for messages: relative to the vault in POSIX form (../vault-private/… for the local root). */
export function shownPath(cfg, abs) {
  const rel = path.relative(cfg.root, abs);
  return rel && !path.isAbsolute(rel) ? toPosix(rel) : abs;
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16).replace(/-+$/, '') || 'app';
}

/** Sector ids in use in any root, live or archived. */
function takenIds(cfg) {
  const out = new Set();
  for (const base of [cfg.root, localRoot(cfg)?.path].filter(Boolean)) {
    for (const rel of [cfg.dirs.sectors, `${cfg.dirs.archive}/${cfg.dirs.sectors}`]) {
      try {
        for (const e of fs.readdirSync(path.join(base, ...rel.split('/')), { withFileTypes: true })) if (e.isDirectory()) out.add(e.name);
      } catch {
        /* no such folder */
      }
    }
  }
  return out;
}

/** dev, then dev-2, dev-3… for the local store (the id is committed); dev-<name> for the git store. */
function nextId(cfg, name, store) {
  const taken = takenIds(cfg);
  if (!taken.has('dev')) return 'dev';
  if (store === 'local') {
    for (let i = 2; i < 1000; i++) if (!taken.has(`dev-${i}`)) return `dev-${i}`;
    return null;
  }
  const base = `dev-${slug(name)}`.slice(0, SECTOR_ID_MAX).replace(/-+$/, '');
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base.slice(0, SECTOR_ID_MAX - 3)}-${i}`;
    if (NAME_RE.test(id) && !taken.has(id)) return id;
  }
  return null;
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
    kinds: { install: 'install dependencies', dev: 'dev server', run: 'run', build: 'build', test: 'tests', lint: 'lint', typecheck: 'type check', format: 'format', up: 'start the services', task: 'tasks' },
    gitTitle: (name) => `Dev: ${name}`,
    gitDescription: (name) => `Coding on ${name}: decisions, gotchas, dead ends, commands, conventions and the handoff between sessions.`,
    gitWhen: (name) => `Anything about the code of ${name}.`,
    localTitle: (n) => `Dev${n > 1 ? ` ${n}` : ''} (local)`,
    localDescription: 'A coding project kept on this computer; its notes are in the local root.',
    localWhen: 'Coding work in the repository this sector belongs to; the session start finds it.',
    notHere: 'Personal matters and other projects.',
    keywords: ['code', 'bug', 'error', 'build'],
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
    kinds: { install: 'instalace závislostí', dev: 'vývojový server', run: 'spuštění', build: 'build', test: 'testy', lint: 'lint', typecheck: 'kontrola typů', format: 'formátování', up: 'spuštění služeb', task: 'úlohy' },
    gitTitle: (name) => `Vývoj: ${name}`,
    gitDescription: (name) => `Programování projektu ${name}: rozhodnutí, pasti, slepé uličky, příkazy, konvence a předávka mezi sessions.`,
    gitWhen: (name) => `Cokoli o kódu projektu ${name}.`,
    localTitle: (n) => `Vývoj${n > 1 ? ` ${n}` : ''} (lokální)`,
    localDescription: 'Programovací projekt uložený na tomto počítači; jeho poznámky jsou v lokálním kořeni.',
    localWhen: 'Práce na kódu v repozitáři, ke kterému sektor patří; najde ho start session.',
    notHere: 'Osobní věci a jiné projekty.',
    keywords: ['kod', 'chyba', 'bug', 'build'],
  },
};

const texts = (cfg) => T[cfg.lang] ?? T.en;

function noteText(cfg, role, body, day, projectName) {
  const t = texts(cfg);
  const k = cfg.keys;
  const n = DEV_NOTES[role];
  const [title, desc] = t[role];
  const lines = ['---', `${k.type}: ${cfg.local('type', n.type)}`, `${k.status}: ${cfg.local('status', 'active')}`,
    `${k.description}: "${desc.replace(/"/g, "'")} (${projectName.replace(/"/g, "'")})"`, `${k.updated}: ${day}`];
  if (n.pin) lines.push(`${k.pin}: true`);
  lines.push('---', `# ${title}`, '', ...body, '');
  return lines.join('\n');
}

/** "- `cmd`: what (source)" lines of the facts' commands. */
function commandLines(cfg, facts) {
  const kinds = texts(cfg).kinds;
  return facts.commands.map((c) => {
    const what = (c.kind && kinds[c.kind]) || c.what;
    return `- \`${c.cmd}\`${what ? `: ${what}` : ''}${c.source ? ` (${c.source})` : ''}`;
  });
}

function noteBodies(cfg, facts, ident) {
  const t = texts(cfg);
  const commands = commandLines(cfg, facts);
  const stack = [...facts.stack, ...facts.languages.filter((l) => !facts.stack.some((s) => s.startsWith(l)))];
  return {
    overview: [`## ${t.what}`, facts.description || facts.readme || t.none, '', `## ${t.stack}`, stack.join(', ') || t.none, '',
      `## ${t.how}`, ...(commands.length ? commands.slice(0, 12) : [t.none]), '', `## ${t.where}`, `- repo: \`${ident.key}\``,
      ...(facts.topDirs.length ? [`- ${facts.topDirs.map((d) => `\`${d}/\``).join(', ')}`] : []), '', `## ${t.open}`, t.none],
    handoff: [`## ${t.done}`, t.none, '', `## ${t.next}`, t.none, '', `## ${t.questions}`, t.none],
    runbook: [`## ${t.commands}`, ...(commands.length ? commands : [t.none]), '', `## ${t.pins}`, t.none],
    conventions: [`## ${t.doItems}`, t.none, '', `## ${t.dontItems}`, t.none],
    gotchas: [t.none],
    deadends: [t.none],
    map: facts.topDirs.length ? facts.topDirs.map((d) => `- \`${d}/\``) : [t.none],
    log: [t.none],
  };
}

/** The manifest fields of a new dev sector: neutral for the local store, named for the git store. */
function sectorFields(cfg, id, store, name, facts) {
  const t = texts(cfg);
  if (store === 'local') {
    const n = id === 'dev' ? 1 : Number(id.slice(4));
    return {
      title: t.localTitle(n), description: t.localDescription, when_here: t.localWhen, not_here: t.notHere,
      keywords: [...new Set([id, 'dev', ...t.keywords])],
    };
  }
  return {
    title: t.gitTitle(name), description: t.gitDescription(name), when_here: t.gitWhen(name), not_here: t.notHere,
    keywords: [...new Set([id, slug(name), ...facts.languages.map((l) => l.toLowerCase()), ...t.keywords])].slice(0, 12),
  };
}

function takeLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return fs.openSync(file, 'wx');
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return null;
        fs.unlinkSync(file); // left behind by a process that stopped
      } catch {
        /* gone meanwhile: try again */
      }
    }
  }
  return null;
}

/**
 * Creates the dev sector of a project and its notes, and links the repository to it. Without
 * force it does so only when projects.auto_add is on and no project matches even loosely; with
 * force (`project add`) only the exact key counts, so a repository that merely resembles a known
 * one gets a project of its own. store defaults to projects.store; title names the project in its
 * notes (and in the manifest of a git-store project). Returns { id, store, created } ({ id: null,
 * busy: true } while another process creates it). Throws ProjectError('no_commit' | 'slow') for a
 * repository without a lasting key.
 */
export async function ensureProject(cfg, ident, { today, force = false, store, title } = {}) {
  const existing = findProject(cfg, ident, { exactOnly: force });
  if (existing) return { id: existing.id, store: existing.store, created: false };
  const set = projectSettings(cfg);
  if (!force && !set.auto_add) return { id: null, created: false };
  if (ident.unsettled || ident.key.startsWith('path:')) throw new ProjectError(ident.unsettled === 'slow' ? 'slow' : 'no_commit');
  const kind = STORES.includes(store) ? store : set.store;
  const lock = path.join(projectsDir(cfg), `${repoHash(ident.key)}.lock`);
  const fd = takeLock(lock);
  if (fd === null) return { id: null, created: false, busy: true };
  try {
    if (kind === 'local') await ensureLocalRoot(cfg);
    const again = findProject(cfg, ident, { exactOnly: force });
    if (again) return { id: again.id, store: again.store, created: false };
    const { repoFacts, clean } = await import('./repofacts.mjs');
    const facts = repoFacts(ident.top);
    const name = clean(title, 80) || facts.name;
    const id = nextId(cfg, clean(title, 80) || ident.name, kind);
    if (!id) throw new ProjectError('no_id');
    const day = today ?? todayLocal();
    const { addSector } = await import('./commands/sector.mjs');
    await addSector(cfg, { id, privacy: kind === 'local' ? 'local' : 'github', ...sectorFields(cfg, id, kind, name, facts), today: day });
    for (const [role, body] of Object.entries(noteBodies(cfg, facts, ident))) {
      const abs = noteAbs(cfg, id, role);
      if (!fs.existsSync(abs)) writeAtomic(abs, noteText(cfg, role, body, day, name));
    }
    setMapping(cfg, ident.key, id, kind);
    return { id, store: kind, created: true };
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** Appends one dated line to a dev note (secrets refused by the caller); returns its shown path. */
export function appendLine(cfg, sector, role, line, { today } = {}) {
  const abs = noteAbs(cfg, sector, role);
  let text = fs.readFileSync(abs, 'utf8');
  const none = texts(cfg).none;
  text = text.replace(new RegExp(`\\n${none.replace(/[()]/g, '\\$&')}\\n?$`), '\n');
  const day = today ?? todayLocal();
  text = text.replace(new RegExp(`^(${cfg.keys.updated}:) .*$`, 'm'), `$1 ${day}`);
  writeAtomic(abs, `${text.replace(/\s*$/, '')}\n${line}\n`);
  return shownPath(cfg, abs);
}

// ---------------------------------------------------------------------------------------------
// Sessions: what the session start saw, for stop and tool-failure (.memory-kit/capture/sessions)

export { safeId };
export const sessionsDir = (cfg) => sessionsIn(cfg.root);

/** { top, sector, store, head, dirty, day, t } of a session, or null. */
export function readSession(cfg, sid) {
  return readSessionFile(cfg.root, sid);
}

export function writeSession(cfg, sid, data) {
  if (sid) writeAtomic(path.join(sessionsDir(cfg), `${sid}.json`), `${JSON.stringify({ ...data, t: new Date().toISOString() })}\n`);
}

/**
 * Links the open sessions (the last day) of a repository to its new sector, so they need no
 * restart. The git state of now becomes their baseline: stop asks for a handoff only after the
 * code changes from here on. Returns how many sessions were linked.
 */
export function linkSessions(cfg, top, sector, store) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir(cfg)).filter((n) => n.endsWith('.json'));
  } catch {
    return 0;
  }
  const since = Date.now() - 86400000;
  let g = null;
  let linked = 0;
  for (const name of names) {
    const abs = path.join(sessionsDir(cfg), name);
    try {
      if (fs.statSync(abs).mtimeMs < since) continue;
      const s = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (s?.sector || !s?.top || path.resolve(s.top) !== path.resolve(top)) continue;
      g ??= gitState(top);
      writeAtomic(abs, `${JSON.stringify({ ...s, sector, store, head: g.head, dirty: g.dirty })}\n`);
      linked++;
    } catch {
      /* a session file of another version */
    }
  }
  return linked;
}

/** Removes session files older than 30 days (a few per session start at most). */
export function pruneSessions(cfg, { now = Date.now(), max = 50 } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir(cfg));
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= max) return;
    const abs = path.join(sessionsDir(cfg), name);
    try {
      if (now - fs.statSync(abs).mtimeMs > 30 * 86400000) {
        fs.unlinkSync(abs);
        removed++;
      }
    } catch {
      /* removed by another process */
    }
  }
}

/** The newest session start of each sector: { sector: ISO time }. */
export function lastSessions(cfg) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir(cfg)).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    const s = readJsonFile(path.join(sessionsDir(cfg), name));
    if (s?.sector && typeof s.t === 'string' && (!out[s.sector] || s.t > out[s.sector])) out[s.sector] = s.t;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The brief and the error lookup

/** The git state of the code repository: { branch, dirty, commits, head } (two git calls). */
export function gitState(top) {
  const status = run('git', ['status', '--porcelain=v2', '--branch'], top) ?? '';
  let branch = '?';
  let head = null;
  let dirty = 0;
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.oid ')) head = /^[0-9a-f]{7,}$/.test(line.slice(13).trim()) ? line.slice(13).trim() : null;
    else if (line.trim() && !line.startsWith('#')) dirty++;
  }
  const commits = head ? (run('git', ['log', '-3', '--format=%h %s (%cr)'], top) ?? '').split('\n').filter(Boolean) : [];
  return { branch, dirty, commits, head };
}

function bodyOf(cfg, sector, role, max) {
  try {
    const text = fs.readFileSync(noteAbs(cfg, sector, role), 'utf8').replace(/\r\n/g, '\n');
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^# .*\n/, '').trim();
    return body.length > max ? `${body.slice(0, max)}…` : body;
  } catch {
    return '';
  }
}

/** The project brief printed above the start view; `git` is gitState(). */
export function projectBrief(cfg, sector, ident, vaultCmd, { git } = {}) {
  const cs = cfg.lang === 'cs';
  const g = git ?? gitState(ident.top);
  const t = texts(cfg);
  const record = `${vaultCmd} remember --project ${sector} --type gotcha|dead-end|todo|run|convention|decision "…"`;
  const out = [
    cs ? `# Projekt ${ident.name} · sektor paměti \`${sector}\`` : `# Project ${ident.name} · memory sector \`${sector}\``,
    cs ? `Paměť projektu je mimo repo s kódem. Příkazy: \`${vaultCmd} <příkaz>\`. Zapsat: \`${record}\`.`
      : `The project memory lives outside the code repository. Commands: \`${vaultCmd} <command>\`. Record: \`${record}\`.`,
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

/** The recorded lines of gotchas and dead ends: [{ line, role }] (placeholders left out). */
export function devLines(cfg, sector) {
  const out = [];
  for (const role of ['gotchas', 'deadends']) {
    for (const line of bodyOf(cfg, sector, role, 100000).split('\n')) if (/^\s*-\s+\S/.test(line)) out.push({ line: line.trim(), role });
  }
  return out;
}

// Words of 4+ letters cut to 6, so watcher/watchers and build/builds meet; common words skipped.
const STOP = new Set(['error', 'errors', 'failed', 'fails', 'cannot', 'with', 'from', 'that', 'this', 'when', 'then', 'code', 'exit']);
const words = (s) => new Set((String(s).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));

/**
 * Gotcha and dead-end lines that match an error text: at least 3 shared words and at least 40 %
 * of the line's own distinct words (the "- [tag] date:" prefix aside). Best first, at most max.
 */
export function lookupError(cfg, sector, errorText, { max = 3, lines } = {}) {
  const err = words(String(errorText).slice(0, 4000));
  if (err.size < 3) return [];
  const hits = [];
  for (const { line, role } of lines ?? devLines(cfg, sector)) {
    const own = words(line.replace(/^\s*-\s*(\[[^\]]*\]\s*)?(\d{4}-\d{2}-\d{2}:?\s*)?/, ''));
    if (!own.size) continue;
    let shared = 0;
    for (const w of own) if (err.has(w)) shared++;
    if (shared >= 3 && shared / own.size >= 0.4) hits.push({ score: shared / own.size + shared / 100, line, role });
  }
  return hits.sort((a, b) => b.score - a.score || (a.line < b.line ? -1 : 1)).slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// The autosync lock (.memory-kit/capture/autosync.lock)

export const AUTOSYNC_STALE_MS = 10 * 60 * 1000;
export const autosyncLockFile = (cfg) => path.join(cfg.root, '.memory-kit', 'capture', 'autosync.lock');

/**
 * The state of the autosync lock: { state: 'free' | 'busy' | 'stale', pid?, host?, started? }.
 * Stale: started more than 10 minutes ago, or its process is gone on this computer.
 */
export function autosyncLockState(cfg, { now = Date.now() } = {}) {
  const file = autosyncLockFile(cfg);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { state: 'free' };
  }
  const j = readJsonFile(file);
  const started = Date.parse(j?.started ?? '') || stat.mtimeMs;
  const info = { pid: j?.pid ?? null, host: j?.host ?? null, started: new Date(started).toISOString() };
  if (now - started > AUTOSYNC_STALE_MS) return { state: 'stale', ...info };
  if (j && j.host === os.hostname() && Number.isInteger(j.pid) && j.pid > 0) {
    try {
      process.kill(j.pid, 0);
    } catch (err) {
      if (err?.code === 'ESRCH') return { state: 'stale', ...info };
    }
  }
  return { state: 'busy', ...info };
}

/**
 * Takes the autosync lock; returns a release function, or null while another autosync runs.
 * Throws when the lock cannot be made at all (the caller logs it). On Windows a lock file being
 * deleted, or held by an antivirus scan, refuses to open for a moment: tried again three times.
 */
export function takeAutosyncLock(cfg) {
  const file = autosyncLockFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let held = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if (['EPERM', 'EACCES', 'EBUSY'].includes(err?.code) && held < 3 && fs.existsSync(file)) {
        held++;
        attempt--;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        continue;
      }
      if (err?.code !== 'EEXIST') throw err;
      if (autosyncLockState(cfg).state !== 'stale') return null;
      try {
        fs.unlinkSync(file);
      } catch {
        /* removed by another process: try once more */
      }
    }
  }
  return null;
}
