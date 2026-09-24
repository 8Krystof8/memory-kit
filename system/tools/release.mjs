#!/usr/bin/env node
// Release tool for maintainers of the kit (not needed in a vault). It keeps the upgrade data in
// step with the code:
//
//   node system/tools/release.mjs            rewrite system/kit.json from the working tree and
//                                            record this version's hashes in system/kit-history.json
//   node system/tools/release.mjs --check    exit 1 when kit.json or the history entry is out of date
//   node system/tools/release.mjs --import <git-ref> <version>
//                                            record the hashes a past release shipped (read from git)
//
// Options: --root <kit> (default: this checkout), --node x.y.z, --upgrade-from x.y.z, --source <url>
// (stored in kit.json), --json. data_version follows system/migrations (the highest `to`, at least 1)
// and api_version follows API_VERSION in system/api.mjs. Exit codes: 0 ok, 1 out of date or refused,
// 2 usage, 3 internal error.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAtomic } from '../lib/fsafe.mjs';
import {
  HISTORY_FILE, KIT_FILE, VERSION_FILE, absOf, buildManifest, compareVersions, groupOf, hashText,
  loadHistory, parseVersion,
} from '../lib/kit.mjs';
import { loadMigrations } from '../lib/migrations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: node system/tools/release.mjs [--check] [--import <git-ref> <version>] [--root <kit>]\n'
  + '       [--node x.y.z] [--upgrade-from x.y.z] [--source <url>] [--json]';

class ReleaseError extends Error {}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function readText(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/** The version keys of a history in release order, each with its files sorted. */
export function sortHistory(history) {
  const out = {};
  const versions = Object.keys(history).filter((v) => parseVersion(v)).sort(compareVersions);
  for (const v of versions) {
    out[v] = {};
    for (const rel of Object.keys(history[v]).sort(byCodeUnit)) out[v][rel] = history[v][rel];
  }
  return out;
}

/** Metadata the code decides: data_version from the migrations, api_version from system/api.mjs. */
export async function derivedMeta(root, flags = {}) {
  const meta = {};
  const migrations = await loadMigrations(root);
  meta.data_version = Math.max(1, ...migrations.map((m) => m.to));
  const api = readText(absOf(root, 'system/api.mjs'));
  const m = api && /export\s+const\s+API_VERSION\s*=\s*(\d+)\s*;/.exec(api);
  if (m) meta.api_version = Number(m[1]);
  for (const [flag, key] of [['node', 'node'], ['upgrade-from', 'upgrade_from'], ['source', 'source']]) {
    if (flags[flag] === undefined) continue;
    if (key !== 'source' && !parseVersion(flags[flag])) throw new ReleaseError(`--${flag} must be a version x.y.z, got "${flags[flag]}"`);
    meta[key] = flags[flag];
  }
  return meta;
}

/** What kit.json and the history entry of this version should hold. */
export async function expected(root, flags = {}) {
  const manifest = buildManifest(root, { meta: await derivedMeta(root, flags) });
  const history = loadHistory(root);
  const entry = {};
  for (const rel of Object.keys(manifest.files)) entry[rel] = manifest.files[rel].sha256;
  return { manifest, history: sortHistory({ ...history, [manifest.version]: entry }) };
}

function runGit(root, args, input) {
  const res = spawnSync('git', args, {
    cwd: root,
    input,
    windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  if (res.error || res.status !== 0) {
    const detail = String(res.stderr ?? '').trim() || res.error?.message || `exit ${res.status}`;
    throw new ReleaseError(`git ${args[0]} failed: ${detail}`);
  }
  return res.stdout;
}

/** Parses `git cat-file --batch` output into [Buffer] in request order. */
function parseBatch(buf, n) {
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = buf.indexOf(0x0a, at);
    const header = buf.subarray(at, nl).toString('utf8');
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) throw new ReleaseError(`unexpected git cat-file output: ${header}`);
    const size = Number(m[2]);
    out.push(buf.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return out;
}

/** { rel: sha256 } of the kit-owned files at a git ref, as hashText sees them. */
export function hashesAtRef(root, ref, version) {
  const listing = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', ref]).toString('utf8');
  const blobs = [];
  for (const entry of listing.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!m || m[2] !== 'blob' || m[1] === '120000') continue;
    const rel = m[4];
    if (rel === KIT_FILE || rel === HISTORY_FILE || groupOf(rel) === null) continue;
    blobs.push({ rel, sha: m[3] });
  }
  if (!blobs.length) throw new ReleaseError(`no kit files at ${ref}`);
  const contents = parseBatch(runGit(root, ['cat-file', '--batch'], blobs.map((b) => `${b.sha}\n`).join('')), blobs.length);
  const out = {};
  blobs.forEach((b, i) => {
    out[b.rel] = hashText(contents[i]);
  });
  const shipped = blobs.findIndex((b) => b.rel === VERSION_FILE);
  const refVersion = shipped >= 0 ? contents[shipped].toString('utf8').trim() : null;
  if (refVersion !== null && refVersion !== version) {
    throw new ReleaseError(`${ref} is version ${refVersion}, not ${version}`);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => byCodeUnit(a, b)));
}

function diffFiles(before, after) {
  const changed = [];
  for (const rel of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const a = before?.[rel];
    const b = after?.[rel];
    const ha = typeof a === 'string' ? a : a?.sha256;
    const hb = typeof b === 'string' ? b : b?.sha256;
    if (ha !== hb) changed.push(`${ha === undefined ? '+' : hb === undefined ? '-' : '~'} ${rel}`);
  }
  return changed.sort((x, y) => byCodeUnit(x.slice(2), y.slice(2)));
}

/** Runs the tool; returns the exit code. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        check: { type: 'boolean' },
        import: { type: 'string' },
        root: { type: 'string' },
        node: { type: 'string' },
        'upgrade-from': { type: 'string' },
        source: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    stderr.write(`release: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const importing = values.import !== undefined;
  if ((importing && positionals.length !== 1) || (!importing && positionals.length) || (importing && values.check)) {
    stderr.write(`release: --import needs <git-ref> <version>; nothing else takes arguments\n${USAGE}\n`);
    return 2;
  }
  const root = path.resolve(values.root ?? path.join(HERE, '..', '..'));
  const say = (text, data) => {
    if (values.json) stdout.write(json(data));
    else stdout.write(`${text}\n`);
  };

  try {
    if (importing) {
      const version = positionals[0];
      if (!parseVersion(version)) throw new ReleaseError(`not a version: "${version}"`);
      const files = hashesAtRef(root, values.import, version);
      const history = sortHistory({ ...loadHistory(root), [version]: files });
      const text = json(history);
      const changed = text !== readText(absOf(root, HISTORY_FILE));
      if (changed) writeAtomic(absOf(root, HISTORY_FILE), text);
      say(`${HISTORY_FILE}: ${version} from ${values.import}, ${Object.keys(files).length} files${changed ? '' : ' (unchanged)'}`,
        { import: values.import, version, files: Object.keys(files).length, changed, versions: Object.keys(history) });
      return 0;
    }

    const want = await expected(root, values);
    const kitText = json(want.manifest);
    const historyText = json(want.history);
    const currentKit = readText(absOf(root, KIT_FILE));
    const currentHistory = readText(absOf(root, HISTORY_FILE));
    const version = want.manifest.version;

    if (values.check) {
      const problems = [];
      if (currentKit !== kitText) {
        let old = null;
        try {
          old = JSON.parse(currentKit ?? 'null');
        } catch {
          old = null;
        }
        const diff = diffFiles(old?.files, want.manifest.files);
        const meta = Object.keys(want.manifest).filter((k) => k !== 'files' && JSON.stringify(old?.[k]) !== JSON.stringify(want.manifest[k]));
        problems.push(`${KIT_FILE} is out of date${meta.length ? ` (${meta.join(', ')})` : ''}${diff.length ? `:\n  ${diff.join('\n  ')}` : ''}`);
      }
      if (currentHistory !== historyText) {
        const old = loadHistory(root)[version];
        const diff = diffFiles(old, want.history[version]);
        problems.push(`${HISTORY_FILE} does not record ${version} as built${diff.length ? `:\n  ${diff.join('\n  ')}` : ''}`);
      }
      if (values.json) {
        stdout.write(json({ ok: problems.length === 0, version, problems }));
      } else if (problems.length) {
        stderr.write(`${problems.join('\n')}\nrun: node system/tools/release.mjs\n`);
      } else {
        stdout.write(`${KIT_FILE} and ${HISTORY_FILE} are up to date (${version}, ${Object.keys(want.manifest.files).length} files)\n`);
      }
      return problems.length ? 1 : 0;
    }

    const kitChanged = currentKit !== kitText;
    const historyChanged = currentHistory !== historyText;
    if (kitChanged) writeAtomic(absOf(root, KIT_FILE), kitText);
    if (historyChanged) writeAtomic(absOf(root, HISTORY_FILE), historyText);
    const versions = Object.keys(want.history);
    say([
      `${KIT_FILE}: ${version}, ${Object.keys(want.manifest.files).length} files${kitChanged ? '' : ' (unchanged)'}`,
      `${HISTORY_FILE}: ${versions.join(', ')}${historyChanged ? '' : ' (unchanged)'}`,
    ].join('\n'), { version, files: Object.keys(want.manifest.files).length, kitChanged, historyChanged, versions });
    return 0;
  } catch (err) {
    if (err instanceof ReleaseError) {
      stderr.write(`release: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`release: internal error: ${err?.stack ?? err}\n`);
      process.exitCode = 3;
    },
  );
}
