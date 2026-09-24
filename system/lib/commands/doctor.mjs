// `doctor`: checks the installation (Node.js, memory.json, kit files, AGENTS.md and the agent
// files, git and its pre-commit hook, the roots, the generated views, the platform, the MCP
// clients) and prints one line per check with the fix under each problem. Runs also when
// memory.json or a pack cannot be loaded (cfg is then null; messages come from the packs when
// they load, else English). --fix repairs only what is mechanical and loses nothing: it sets
// core.hooksPath when it is unset, and removes a BOM and CR bytes from .githooks/pre-commit and
// makes it executable, byte by byte (the old file goes to .memory-kit/backups/doctor/ first).
// Exit 0 without a failed check, 1 with one, 2 on a usage error.

import fs from 'node:fs';
import path from 'node:path';
import { HOOK_REL, diagnose, formatReport, hookFile, say } from '../doctor.mjs';
import { writeAtomic } from '../fsafe.mjs';
import { git, interpolate, parseCli, usageError } from '../util.mjs';

export const usage = 'doctor [--json] [--fix]';

export const BACKUP_DIR = '.memory-kit/backups/doctor';

const LANG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * A translator from the language packs when memory.json cannot be loaded as a whole: the
 * messages of the en pack and of memory.json "lang" (when that file still parses), else null.
 */
async function packTranslator(root) {
  let loadPack;
  try {
    ({ loadPack } = await import('../config.mjs'));
  } catch {
    return null;
  }
  let lang = 'en';
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8').replace(/^﻿/, ''));
    if (typeof raw?.lang === 'string' && LANG_RE.test(raw.lang.trim())) lang = raw.lang.trim();
  } catch {
    /* English */
  }
  const messages = {};
  for (const code of lang === 'en' ? ['en'] : ['en', lang]) {
    try {
      const m = loadPack(root, code).messages;
      if (m && typeof m === 'object') Object.assign(messages, m);
    } catch {
      /* a missing or broken pack falls back to English */
    }
  }
  return (key, vars) => (typeof messages[key] === 'string' && messages[key] !== '' ? interpolate(messages[key], vars) : key);
}

/**
 * The bytes of a shell script without a leading UTF-8 BOM and with LF line endings (CR LF and a
 * lone CR become LF). Works on bytes, so text in any encoding keeps every other byte.
 */
export function hookBytes(buf) {
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const out = Buffer.alloc(buf.length - start);
  let n = 0;
  for (let i = start; i < buf.length; i++) {
    if (buf[i] !== 0x0d) {
      out[n++] = buf[i];
      continue;
    }
    out[n++] = 0x0a;
    if (buf[i + 1] === 0x0a) i++;
  }
  return out.subarray(0, n);
}

/** YYYYMMDD-HHMMSS in local time, as connect names its backups. */
function stamp(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Copies file into <vault>/.memory-kit/backups/doctor/ (never over an older backup) and returns the copy's path. */
function backupFile(root, file, now) {
  const dir = path.join(root, ...BACKUP_DIR.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(file);
  const label = path.basename(file, ext);
  for (let n = 1; ; n++) {
    const dest = path.join(dir, `${label}-${stamp(now)}${n > 1 ? `-${n}` : ''}${ext || '.bak'}`);
    try {
      fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }
}

/** Adds .memory-kit/ to .git/info/exclude unless git ignores the backups already (a nicety). */
function ensureIgnored(root) {
  const probe = git(root, ['check-ignore', '-q', '--no-index', `${BACKUP_DIR}/probe`], { allowFail: true });
  if (probe.ok || probe.code !== 1) return; // ignored already, or no repository
  const where = git(root, ['rev-parse', '--git-path', 'info/exclude'], { allowFail: true });
  if (!where.ok || !where.stdout.trim()) return;
  const abs = path.resolve(root, where.stdout.trim());
  let last = null;
  try {
    const buf = fs.readFileSync(abs);
    last = buf.length ? buf[buf.length - 1] : null;
  } catch {
    /* no exclude file yet */
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Appended, so the lines already there keep their bytes.
  fs.appendFileSync(abs, `${last !== null && last !== 0x0a ? '\n' : ''}.memory-kit/\n`);
}

/**
 * Repairs the hook's bytes and mode and nothing else: see hookBytes, plus the executable bits.
 * A symbolic link stays a link and the file it leads to is repaired, but only inside the vault.
 * When the bytes change, the old file is copied to .memory-kit/backups/doctor/ first and the new
 * bytes replace it atomically; when only the mode is wrong, only the mode changes.
 * Returns the backup's path or null.
 */
function repairHookFile(root, { t, now }) {
  const hook = hookFile(root);
  if (!hook.inside) throw new Error(say(t, 'doctor.fix_outside', { target: hook.file }));
  const st = fs.statSync(hook.file);
  const mode = (st.mode & 0o777) | 0o111;
  const before = fs.readFileSync(hook.file);
  const after = hookBytes(before);
  if (after.equals(before)) {
    if (process.platform !== 'win32') fs.chmodSync(hook.file, mode);
    return null;
  }
  const backup = backupFile(root, hook.file, now);
  try {
    ensureIgnored(root);
  } catch {
    /* a nicety: the backup works without it */
  }
  writeAtomic(hook.file, after, { mode });
  return backup;
}

/**
 * Applies the repairs diagnose() offered: 'hooks_path' (git config core.hooksPath .githooks)
 * and 'hook_file' (see repairHookFile). opts: { t, now } (the clock for backup names).
 * Returns [{ name, ok, detail, backup }] (backup: the path of the old file's copy, or null).
 */
export function applyRepairs(root, repairs, { t = null, now = new Date() } = {}) {
  const done = [];
  for (const name of repairs) {
    try {
      let backup = null;
      if (name === 'hooks_path') {
        const res = git(root, ['config', 'core.hooksPath', '.githooks'], { allowFail: true });
        if (!res.ok) throw new Error(res.stderr.trim() || `git exit ${res.code}`);
      } else if (name === 'hook_file') {
        backup = repairHookFile(root, { t, now });
      } else {
        continue;
      }
      done.push({ name, ok: true, detail: '', backup });
    } catch (err) {
      done.push({ name, ok: false, detail: String(err?.message ?? err).split('\n')[0], backup: null });
    }
  }
  return done;
}

const WHAT = { hooks_path: 'core.hooksPath', hook_file: HOOK_REL };

export async function run(argv, cfg, ctx = {}) {
  const parsed = parseCli(argv, {
    json: { type: 'boolean' },
    fix: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length) {
    usageError(`unexpected argument "${positionals[0]}"`, usage);
    return 2;
  }
  const root = path.resolve(ctx.root ?? cfg?.root ?? '.');
  const t = cfg?.t ?? await packTranslator(root);
  const opts = { kitRoot: ctx.kitRoot, cfg, configError: ctx.configError ?? null, t };
  let result = await diagnose(root, opts);

  if (values.fix && result.repairs.length) {
    const done = applyRepairs(root, result.repairs, { t });
    // With --json, stdout carries only the report.
    const out = values.json ? process.stderr : process.stdout;
    for (const d of done) {
      out.write(`${d.ok ? say(t, `doctor.fixed.${d.name}`) : say(t, 'doctor.fix_failed', { what: WHAT[d.name], detail: d.detail })}\n`);
      if (d.backup) out.write(`${say(t, 'doctor.backup', { path: d.backup })}\n`);
    }
    if (done.some((d) => d.ok)) result = await diagnose(root, opts);
  }

  const { report, skipped } = result;
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(formatReport(report, { skipped, t }));
  return report.summary.fail ? 1 : 0;
}
