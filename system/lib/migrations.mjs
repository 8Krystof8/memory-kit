// Data migrations (system/migrations/index.mjs): finding the chain from a vault's data version
// (memory.json "version") to a kit's data_version and running it. Every write goes through a
// `record(rel)` callback first, so the upgrade backup holds the old bytes before anything changes,
// and a `wrote(rel)` callback after, so a rollback knows the new bytes as the migration's own.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renameRetry, writeAtomic } from './fsafe.mjs';
import { absOf, cleanRel } from './kit.mjs';

export const MIGRATIONS_FILE = 'system/migrations/index.mjs';

export class MigrationError extends Error {
  code = 'MIGRATION';
}

/** The data version of a parsed memory.json: 1 when absent, null when not a positive integer. */
export function dataVersionOf(raw) {
  const v = raw?.version;
  if (v === undefined) return 1;
  return Number.isInteger(v) && v >= 1 ? v : null;
}

/** Throws a MigrationError unless every entry is { id, from, to, title, run } with to > from. */
export function validateMigrations(list) {
  if (!Array.isArray(list)) throw new MigrationError('MIGRATIONS must be an array');
  const ids = new Set();
  for (const [i, m] of list.entries()) {
    const where = `MIGRATIONS[${i}]`;
    if (!m || typeof m !== 'object') throw new MigrationError(`${where} is not an object`);
    if (typeof m.id !== 'string' || !m.id.trim()) throw new MigrationError(`${where} needs an id`);
    if (ids.has(m.id)) throw new MigrationError(`${where}: duplicate id "${m.id}"`);
    ids.add(m.id);
    if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || m.from < 1 || m.to <= m.from) {
      throw new MigrationError(`${where} (${m.id}): from and to must be integers with to > from >= 1`);
    }
    if (typeof m.title !== 'string' || !m.title.trim()) throw new MigrationError(`${where} (${m.id}) needs a title`);
    if (typeof m.run !== 'function') throw new MigrationError(`${where} (${m.id}) needs a run(ctx) function`);
  }
  return list;
}

/** The validated MIGRATIONS of a kit checkout ([] when it has no migrations file). */
export async function loadMigrations(kitRoot) {
  const file = absOf(kitRoot, MIGRATIONS_FILE);
  if (!fs.existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href);
  return validateMigrations(mod.MIGRATIONS ?? []);
}

/**
 * The ordered steps from data version `from` to `to`: [] when equal, null when there is no path
 * (or `from` is newer). At each step the migration that gets furthest without passing `to` wins.
 */
export function migrationChain(list, from, to) {
  if (from === to) return [];
  if (!(from < to)) return null;
  const chain = [];
  let current = from;
  while (current < to) {
    const next = list
      .filter((m) => m.from === current && m.to <= to)
      .sort((a, b) => b.to - a.to || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
    if (!next) return null;
    chain.push(next);
    current = next.to;
  }
  return chain;
}

/** A vault-relative POSIX path a migration may touch; throws on anything else. */
export function migrationPath(rel) {
  const raw = String(rel ?? '');
  const r = cleanRel(raw);
  if (!r || path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
    throw new MigrationError(`not a vault-relative path: "${raw}"`);
  }
  const parts = r.split('/');
  if (parts.some((p) => p === '..' || p === '.')) throw new MigrationError(`path leaves the vault: "${raw}"`);
  if (parts[0] === '.git' || parts[0] === '.memory-kit') throw new MigrationError(`path is off limits: "${raw}"`);
  return r;
}

function filesUnder(abs, rel, out) {
  const st = fs.lstatSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) filesUnder(path.join(abs, name), `${rel}/${name}`, out);
  } else if (st.isFile()) {
    out.push(rel);
  }
  return out;
}

function removeEmptyDirs(root, rel) {
  let dir = rel;
  while (dir) {
    const abs = absOf(root, dir);
    try {
      if (fs.readdirSync(abs).length) return;
      fs.rmdirSync(abs);
    } catch {
      return;
    }
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

/**
 * The ctx a migration's run(ctx) gets. record(rel) must save the current bytes of rel (or note
 * that it is missing) before the first change; wrote(rel) (optional) hears of every change once it
 * is on disk; log(text) collects lines for the report.
 */
export function migrationContext({ root, lang, record, wrote = () => {}, log }) {
  const readText = (rel) => {
    try {
      return fs.readFileSync(absOf(root, migrationPath(rel)), 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
      throw err;
    }
  };
  const writeText = (rel, text) => {
    const r = migrationPath(rel);
    record(r);
    writeAtomic(absOf(root, r), String(text));
    wrote(r);
  };
  const moveFile = (from, to) => {
    if (fs.existsSync(absOf(root, to))) throw new MigrationError(`move: "${to}" exists already`);
    record(from);
    record(to);
    fs.mkdirSync(path.dirname(absOf(root, to)), { recursive: true });
    renameRetry(absOf(root, from), absOf(root, to));
    wrote(from);
    wrote(to);
  };
  return {
    root,
    lang,
    readText,
    writeText,
    readJson(rel) {
      const text = readText(rel);
      if (text === null) return null;
      try {
        return JSON.parse(text.replace(/^﻿/, ''));
      } catch (err) {
        throw new MigrationError(`${rel} is not valid JSON: ${err.message}`);
      }
    },
    writeJson(rel, value) {
      writeText(rel, `${JSON.stringify(value, null, 2)}\n`);
    },
    /** Moves a file or a whole folder (file by file); never overwrites. */
    move(fromRel, toRel) {
      const from = migrationPath(fromRel);
      const to = migrationPath(toRel);
      const abs = absOf(root, from);
      if (!fs.existsSync(abs)) throw new MigrationError(`move: "${from}" does not exist`);
      if (fs.lstatSync(abs).isDirectory()) {
        const files = filesUnder(abs, from, []);
        for (const rel of files) {
          if (fs.existsSync(absOf(root, `${to}${rel.slice(from.length)}`))) {
            throw new MigrationError(`move: "${to}${rel.slice(from.length)}" exists already`);
          }
        }
        for (const rel of files) {
          moveFile(rel, `${to}${rel.slice(from.length)}`);
          removeEmptyDirs(root, rel.slice(0, rel.lastIndexOf('/')));
        }
        removeEmptyDirs(root, from);
      } else {
        moveFile(from, to);
      }
    },
    log(text) {
      log(String(text));
    },
  };
}

/** Sets memory.json "version" (first key when it was missing), keeping every other key. */
export function setDataVersion(root, version, record, wrote = () => {}) {
  const abs = absOf(root, 'memory.json');
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8').replace(/^﻿/, ''));
  if (raw.version === version) return false;
  const next = Object.hasOwn(raw, 'version') ? { ...raw, version } : { version, ...raw };
  record('memory.json');
  writeAtomic(abs, `${JSON.stringify(next, null, 2)}\n`);
  wrote('memory.json');
  return true;
}

/**
 * Runs a chain in order. After each step memory.json "version" becomes that step's `to`.
 * Returns [{ id, from, to, title, log }]; a failing step throws (the caller rolls back).
 */
export async function runMigrations(chain, { root, lang, record, wrote = () => {} }) {
  const done = [];
  for (const m of chain) {
    const lines = [];
    const ctx = migrationContext({ root, lang, record, wrote, log: (text) => lines.push(text) });
    try {
      await m.run(ctx);
    } catch (err) {
      const wrapped = new MigrationError(`migration ${m.id} failed: ${err?.message ?? err}`);
      wrapped.cause = err;
      throw wrapped;
    }
    setDataVersion(root, m.to, record, wrote);
    done.push({ id: m.id, from: m.from, to: m.to, title: m.title, log: lines });
  }
  return done;
}
