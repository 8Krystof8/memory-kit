// The kit's own files: which paths the kit owns (the ownership table of docs/maintenance.md,
// "Upgrading the kit"), their hashes, the manifest system/kit.json and the history of every
// shipped hash in system/kit-history.json. Used by upgrade, doctor and the release tool.
// Nothing here writes a file or reads the clock.

import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

export const KIT_FILE = 'system/kit.json';
export const HISTORY_FILE = 'system/kit-history.json';
export const VERSION_FILE = 'system/VERSION';
export const DEFAULT_GOLDEN = 'system/tests/golden.json';
export const DEFAULT_SOURCE = 'https://github.com/8Krystof8/memory-kit.git';

/** Manifest fields other than version and files; release.mjs maintains them in kit.json. */
export const MANIFEST_DEFAULTS = Object.freeze({
  name: 'memory-kit',
  data_version: 1,
  api_version: 1,
  node: '22.5.0',
  upgrade_from: '0.1.0',
  source: DEFAULT_SOURCE,
});

const CODE_FILES = new Set(['system/memory.mjs', 'system/init.mjs', 'system/api.mjs', VERSION_FILE, KIT_FILE, HISTORY_FILE]);
const CODE_DIRS = ['system/lib/', 'system/lang/', 'system/templates/', 'system/schema/', 'system/migrations/', 'system/tools/'];

/** Config files the kit ships at fixed places; the owner may change them. */
export const CONFIG_FILES = Object.freeze([
  '.githooks/pre-commit',
  '.github/workflows/ci.yml',
  '.claude/settings.json',
  '.agents/skills/memory/SKILL.md',
  '.claude/skills/memory/SKILL.md',
  '.claude/agents/memory-searcher.md',
  '.gitattributes',
  'GEMINI.md',
]);
const CONFIG_SET = new Set(CONFIG_FILES);

/** Config files an upgrade installs even when the vault lacks them. */
export const ESSENTIAL_FILES = Object.freeze(['.githooks/pre-commit']);

// Folders never walked and file names that are never kit files (editor, OS and temp debris).
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.trash', '.memory-kit']);
const JUNK_RE = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\..+\.tmp-\d+-[a-z0-9]+|.+\.swp|.+~)$/i;

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** {major, minor, patch, pre} of 'x.y.z[-pre][+build]', or null. */
export function parseVersion(v) {
  const m = SEMVER_RE.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

function comparePre(a, b) {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) {
      const d = Number(a[i]) - Number(b[i]);
      if (d) return Math.sign(d);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Semver comparison of 'x.y.z' strings: -1, 0 or 1. Throws a TypeError on anything else. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`not a version: ${JSON.stringify(pa ? b : a)}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] < pb[key] ? -1 : 1;
  }
  return comparePre(pa.pre, pb.pre);
}

/**
 * sha256 hex of a text as every checkout sees it: BOM removed, CRLF as LF, NFC. A buffer with a
 * NUL byte or invalid UTF-8 is binary and hashed as it is.
 */
export function hashText(bufOrString) {
  let text;
  if (typeof bufOrString === 'string') {
    text = bufOrString;
  } else {
    const buf = Buffer.isBuffer(bufOrString) ? bufOrString : Buffer.from(bufOrString);
    if (buf.includes(0) || !isUtf8(buf)) return createHash('sha256').update(buf).digest('hex');
    text = buf.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').normalize('NFC');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** hashText of a file, or null when it is missing or not a file. */
export function hashFile(abs) {
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err?.code)) return null;
    throw err;
  }
  return hashText(buf);
}

/** A repo-relative path as a clean POSIX string ('./a\\b' -> 'a/b'). */
export function cleanRel(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

/** The absolute path of a POSIX rel under root. */
export function absOf(root, rel) {
  return path.join(root, ...cleanRel(rel).split('/'));
}

/**
 * The ownership group of a repo-relative path: 'code', 'tests', 'docs', 'config' or null when the
 * kit does not own it. The golden file (system/tests/golden.json and, when given, the file that
 * memory.json eval.golden names) is never kit-owned.
 */
export function groupOf(rel, { golden } = {}) {
  const r = cleanRel(rel);
  if (!r || r.split('/').some((part) => part === '..' || SKIP_DIRS.has(part))) return null;
  if (JUNK_RE.test(r.slice(r.lastIndexOf('/') + 1))) return null;
  if (r === DEFAULT_GOLDEN || (golden && r === cleanRel(golden))) return null;
  if (CODE_FILES.has(r) || CODE_DIRS.some((dir) => r.startsWith(dir))) return 'code';
  if (r.startsWith('system/tests/')) return 'tests';
  if (r.startsWith('docs/')) return 'docs';
  if (CONFIG_SET.has(r)) return 'config';
  return null;
}

function walkFiles(root, relDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, ...relDir.split('/')), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkFiles(root, rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted POSIX rels of the kit-owned files present under root (a kit checkout or a vault). */
export function listKitFiles(kitRoot, { golden } = {}) {
  const found = [];
  walkFiles(kitRoot, 'system', found);
  walkFiles(kitRoot, 'docs', found);
  for (const rel of CONFIG_FILES) {
    try {
      if (fs.statSync(absOf(kitRoot, rel)).isFile()) found.push(rel);
    } catch {
      /* not shipped here */
    }
  }
  return [...new Set(found)].filter((rel) => groupOf(rel, { golden }) !== null).sort(byCodeUnit);
}

function readJsonFile(abs) {
  try {
    const value = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The trimmed content of <root>/system/VERSION, or null. */
export function readVersion(root) {
  try {
    return fs.readFileSync(absOf(root, VERSION_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Parsed system/kit.json of root, or null when missing or not a JSON object. */
export function loadManifest(root) {
  const value = readJsonFile(absOf(root, KIT_FILE));
  if (!value || typeof value.files !== 'object' || value.files === null || Array.isArray(value.files)) return null;
  return value;
}

/** Parsed system/kit-history.json of root: { "<version>": { "<rel>": "<sha256>" } }, or {}. */
export function loadHistory(root) {
  const value = readJsonFile(absOf(root, HISTORY_FILE));
  if (!value) return {};
  const out = {};
  for (const [version, files] of Object.entries(value)) {
    if (files && typeof files === 'object' && !Array.isArray(files)) out[version] = files;
  }
  return out;
}

/** Every hash rel was ever shipped with, across all versions of a history. */
export function knownHashes(history, rel) {
  const out = new Set();
  for (const files of Object.values(history ?? {})) {
    const h = files?.[rel];
    if (typeof h === 'string') out.add(h);
  }
  return out;
}

/**
 * The manifest of a kit checkout: metadata (from its existing kit.json, else MANIFEST_DEFAULTS,
 * overridden by `meta`), version from system/VERSION and the hash and group of every kit-owned
 * file except kit.json and kit-history.json, which are always replaced and never hashed.
 */
export function buildManifest(kitRoot, { meta = {} } = {}) {
  const existing = readJsonFile(absOf(kitRoot, KIT_FILE)) ?? {};
  const pick = (key) => meta[key] ?? existing[key] ?? MANIFEST_DEFAULTS[key];
  const version = readVersion(kitRoot);
  if (!parseVersion(version)) throw new Error(`${VERSION_FILE} of ${kitRoot} holds no version`);
  const files = {};
  for (const rel of listKitFiles(kitRoot)) {
    if (rel === KIT_FILE || rel === HISTORY_FILE) continue;
    files[rel] = { sha256: hashFile(absOf(kitRoot, rel)), group: groupOf(rel) };
  }
  return {
    name: pick('name'),
    version,
    data_version: pick('data_version'),
    api_version: pick('api_version'),
    node: pick('node'),
    upgrade_from: pick('upgrade_from'),
    source: pick('source'),
    files,
  };
}

/** The golden file a vault's memory.json names (POSIX rel), or the default. */
export function goldenOf(root) {
  const raw = readJsonFile(absOf(root, 'memory.json'));
  const golden = raw?.eval?.golden;
  return typeof golden === 'string' && golden.trim() ? cleanRel(golden.trim()) : DEFAULT_GOLDEN;
}

/** Which optional groups a vault carries: tests (system/tests/helpers.mjs) and docs (docs/). */
export function optionalGroups(root) {
  let docs = false;
  try {
    docs = fs.statSync(absOf(root, 'docs')).isDirectory();
  } catch {
    docs = false;
  }
  let tests = false;
  try {
    tests = fs.statSync(absOf(root, 'system/tests/helpers.mjs')).isFile();
  } catch {
    tests = false;
  }
  return { tests, docs };
}

/**
 * Compares the kit files of a vault with its installed manifest (default: the vault's own
 * kit.json and kit-history.json). state per file: 'ok' (the shipped bytes), 'modified',
 * 'missing', or 'skipped' (tests or docs the vault does not carry, the golden file). A modified
 * file also says whether its bytes are those of another shipped version (`known`).
 * `unknown` lists files in kit-owned places that the manifest does not name. version is the
 * vault's system/VERSION (null when missing), manifestVersion that of kit.json (null without one).
 */
export function integrityReport(vaultRoot, { manifest, history } = {}) {
  const man = manifest === undefined ? loadManifest(vaultRoot) : manifest;
  const hist = history === undefined ? loadHistory(vaultRoot) : history;
  const optional = optionalGroups(vaultRoot);
  const golden = goldenOf(vaultRoot);
  const applies = (group) => (group === 'tests' ? optional.tests : group === 'docs' ? optional.docs : true);
  const files = [];
  const modified = [];
  const missing = [];
  const listed = new Set();
  for (const rel of Object.keys(man?.files ?? {}).sort(byCodeUnit)) {
    const entry = man.files[rel] ?? {};
    const group = entry.group ?? groupOf(rel);
    listed.add(rel);
    if (!applies(group) || rel === golden) {
      files.push({ rel, group, state: 'skipped' });
      continue;
    }
    const hash = hashFile(absOf(vaultRoot, rel));
    if (hash === null) {
      missing.push(rel);
      files.push({ rel, group, state: 'missing' });
    } else if (hash === entry.sha256) {
      files.push({ rel, group, state: 'ok' });
    } else {
      modified.push(rel);
      files.push({ rel, group, state: 'modified', known: knownHashes(hist, rel).has(hash) });
    }
  }
  const unknown = man
    ? listKitFiles(vaultRoot, { golden }).filter((rel) => !listed.has(rel) && rel !== KIT_FILE && rel !== HISTORY_FILE
      && applies(groupOf(rel)))
    : [];
  return {
    version: readVersion(vaultRoot),
    manifestVersion: typeof man?.version === 'string' ? man.version : null,
    files,
    modified,
    missing,
    unknown,
    optional,
  };
}
