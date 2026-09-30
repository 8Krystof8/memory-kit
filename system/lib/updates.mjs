// A newer memory-kit, without sending anything about the owner: `upgrade --check` asks the kit's
// source for its newest release (one `git ls-remote --tags` of a git source, the system/VERSION of
// a folder source; nothing is downloaded) and keeps the answer in .memory-kit/updates.json. With
// memory.json "updates": {"check": true} the session start runs that check in the background, at
// most once a day and never in CI; the owner's line at a session start then names a newer version
// once a day. The workflow .github/workflows/memory-kit-updates.yml of a vault on GitHub turns the
// answer of `upgrade --check --json` into one issue ("updates": {"github": false} turns that off).
// Nothing here throws out of a session.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { localDay } from './activity.mjs';
import { writeAtomic } from './fsafe.mjs';
import { detectStyle, formatJson } from './jsonc.mjs';
import { DEFAULT_SOURCE, compareVersions, loadManifest, parseVersion, readVersion } from './kit.mjs';
import { WORK_DIR, ensureWorkDirIgnored, interpolate } from './util.mjs';

export const UPDATES_REL = '.memory-kit/updates.json';
const DAY_MS = 86400000;
const LS_REMOTE_TIMEOUT_MS = 15000;

// English defaults; packs may translate the same keys (section 4.10).
const DEFAULTS = {
  'updates.available': 'memory-kit {latest} is available (this memory has {installed}).',
  'updates.how': 'See what is new and update: {cmd} upgrade',
  'updates.subscribe': 'To hear of new versions by yourself: "updates": {"check": true} in memory.json (a check once a day in the background), or watch the releases: {releases}',
  'updates.subscribe_plain': 'To hear of new versions by yourself: "updates": {"check": true} in memory.json (a check once a day in the background)',
  'updates.failed': 'could not ask {source} for a newer memory-kit: {detail}',
  'updates.no_tags': 'no release tag (vX.Y.Z) found',
  'updates.notice': 'memory-kit: version {latest} is out (this memory has {installed}). See what is new and update: {cmd} upgrade',
  'updates.issue_title': 'memory-kit {latest} is available',
  'updates.issue_body': 'memory-kit {latest} is out; this memory has {installed}.\n\n{whatsnew}\n\nUpdate on your computer, in the folder of this memory:\n\n    node system/memory.mjs upgrade\n\nIt shows what changes, keeps a backup and asks before it changes anything. Then commit and push as it says.\n\nThis issue comes from the nightly check of this repository (.github/workflows/memory-kit-updates.yml), which only reads the version tags of the kit. Turn it off with "updates": {"github": false} in memory.json.',
  'updates.issue_link': 'What is new: {url}',
  'updates.issue_changelog': 'What is new: `upgrade` shows it from the CHANGELOG.md of the new version before it changes anything.',
  'updates.issue_closed': 'This memory has memory-kit {installed} now, so this issue is done.',
  'updates.ch_github_on': 'an issue on GitHub',
  'updates.ch_github_off': 'no issue on GitHub ("updates": {"github": false})',
  'updates.ch_github_missing': 'no issue on GitHub yet: add .github/workflows/memory-kit-updates.yml (README, "Hear of new versions")',
  'updates.ch_check_on': 'a daily check at the session start',
  'updates.ch_check_off': 'no daily check ("updates": {"check": true} turns it on)',
};

/** The workflow that opens the issue of a newer kit; the template has it, upgrade never ships it. */
export const WORKFLOW_REL = '.github/workflows/memory-kit-updates.yml';

export function say(cfg, key, vars = {}) {
  let text = null;
  try {
    text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : null;
  } catch {
    text = null;
  }
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  return interpolate(DEFAULTS[key] ?? key, vars);
}

export class UpdateCheckError extends Error {
  constructor(detail) {
    super(detail);
    this.name = 'UpdateCheckError';
    this.detail = detail;
  }
}

/**
 * The newest release in the output of `git ls-remote --tags`: tags vX.Y.Z or X.Y.Z; a pre-release
 * (v0.2.0-rc.1) or any other tag is no release. null when there is none.
 */
export function latestFromTags(text) {
  let best = null;
  for (const line of String(text ?? '').split('\n')) {
    const m = /\trefs\/tags\/v?(\d+\.\d+\.\d+)(?:\^\{\})?\s*$/.exec(line);
    if (m && (!best || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best;
}

/** The last meaningful line of a failed git run, for the owner. */
function gitProblem(res) {
  if (res.error?.code === 'ETIMEDOUT' || (res.signal && res.status === null)) return `timed out after ${Math.round(LS_REMOTE_TIMEOUT_MS / 1000)} s`;
  const lines = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /fatal|error|could not|unable|denied|not found/i.test(l)) ?? lines[0] ?? res.error?.message ?? `exit ${res.status}`;
}

/**
 * The newest version of the kit at a source of `upgrade`: {dir} (a folder: its system/VERSION) or
 * {url} (its release tags, read with git ls-remote; nothing is downloaded). Throws UpdateCheckError.
 */
export function latestAt(src, { git = spawnSync, env = process.env } = {}) {
  if (src?.dir) {
    const version = readVersion(src.dir);
    if (!parseVersion(version)) throw new UpdateCheckError(`no valid system/VERSION in ${src.dir}`);
    return version;
  }
  const res = git('git', ['ls-remote', '--tags', '--refs', src.url], {
    encoding: 'utf8', windowsHide: true, timeout: LS_REMOTE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error || res.status !== 0) throw new UpdateCheckError(gitProblem(res));
  const latest = latestFromTags(res.stdout);
  if (!latest) throw new UpdateCheckError(say(null, 'updates.no_tags'));
  return latest;
}

/** The releases page of a source on GitHub ({base}/releases, and the tag page of a version), else null. */
export function releasesOf(source, version) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(String(source ?? '').trim());
  if (!m) return null;
  const base = `https://github.com/${m[1]}/${m[2]}/releases`;
  return { page: base, tag: version ? `${base}/tag/v${version}` : null };
}

/** The updates settings of memory.json ({check: false, github: true} by default); a cfg or a vault root. */
export function updateSettings(cfgOrRoot) {
  let raw = null;
  if (cfgOrRoot && typeof cfgOrRoot === 'object') {
    if (cfgOrRoot.updates && typeof cfgOrRoot.updates === 'object') return { check: cfgOrRoot.updates.check === true, github: cfgOrRoot.updates.github !== false };
    raw = cfgOrRoot.raw;
  } else {
    try {
      const text = fs.readFileSync(path.join(cfgOrRoot, 'memory.json'), 'utf8');
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      raw = null;
    }
  }
  const u = raw && typeof raw.updates === 'object' && raw.updates ? raw.updates : {};
  return { check: u.check === true, github: u.github !== false };
}

const cacheFile = (root) => path.join(root, ...UPDATES_REL.split('/'));

/** What the last checks left: {attempted?, checked?, installed?, latest?, source?, told?}; {} when none. */
export function readUpdates(root) {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(root), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Writes the cache; the first file of .memory-kit/ keeps the folder out of git first. Never throws. */
export function writeUpdates(root, data) {
  try {
    if (!fs.existsSync(path.join(root, WORK_DIR))) {
      try {
        ensureWorkDirIgnored(root);
      } catch {
        /* doctor (git.repo) warns while git does not ignore it */
      }
    }
    fs.mkdirSync(path.dirname(cacheFile(root)), { recursive: true });
    writeAtomic(cacheFile(root), `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the session start should ask the source now: the vault is set up, memory.json has
 * "updates": {"check": true}, this is no CI run (CI), no probe (MEMORY_KIT_PROBE=1) and the owner
 * did not turn notices off for every tool (NO_UPDATE_NOTIFIER), and no check started in the last day.
 */
export function checkDue(cfg, { env = process.env, now = new Date() } = {}) {
  if (cfg?.initialized !== true || !updateSettings(cfg).check) return false;
  if (env.CI || env.NO_UPDATE_NOTIFIER || env.MEMORY_KIT_PROBE === '1') return false;
  const cache = readUpdates(cfg.root);
  const last = Date.parse(cache.attempted ?? cache.checked ?? '');
  if (!Number.isFinite(last)) return true;
  const age = now.getTime() - last;
  return age >= DAY_MS || age < -DAY_MS; // a clock that was wrong: check again
}

/**
 * Starts `upgrade --check --json` in the background when checkDue says so, and notes the attempt
 * first, so parallel sessions start one check. The session never waits for it. → true when started.
 */
export function checkInBackground(cfg, { env = process.env, now = new Date(), start = spawn } = {}) {
  try {
    if (!checkDue(cfg, { env, now })) return false;
    writeUpdates(cfg.root, { ...readUpdates(cfg.root), attempted: now.toISOString() });
    const child = start(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), 'upgrade', '--check', '--json', '--root', cfg.root], {
      cwd: cfg.root, detached: true, stdio: 'ignore', windowsHide: true, env: { ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's line about a newer kit that a check found, once a day (`mark` records the day it was
 * told), or null: no newer version known, or told today already. Never throws.
 */
export function updateLine(cfg, { command = 'node system/memory.mjs', now = new Date(), mark = true } = {}) {
  try {
    const cache = readUpdates(cfg.root);
    const installed = readVersion(cfg.root);
    if (!parseVersion(cache.latest) || !parseVersion(installed) || compareVersions(cache.latest, installed) <= 0) return null;
    const today = localDay(now);
    if (cache.told === today) return null;
    if (mark) writeUpdates(cfg.root, { ...cache, told: today });
    return say(cfg, 'updates.notice', { latest: cache.latest, installed, cmd: command });
  } catch {
    return null;
  }
}

/** memory.json as an object, or null (missing or broken). */
function rawConfigOf(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'memory.json'), 'utf8');
    const value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Where the vault's origin points, read from git's config (no network): 'github', 'other' or null. */
function originKind(root) {
  const res = spawnSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const url = res.status === 0 ? String(res.stdout).trim() : '';
  if (!url) return null;
  return /github\.com[:/]/i.test(url) ? 'github' : 'other';
}

/**
 * What the vault knows about newer versions, from files on this computer only: {installed, latest,
 * checked, available, channels: {github, check}}. github is 'on', 'off' (updates.github false),
 * 'missing' (no workflow file) or 'none' (mode local, or no origin on GitHub). Takes a cfg or a root.
 */
export function updateStatus(cfgOrRoot) {
  const root = typeof cfgOrRoot === 'string' ? cfgOrRoot : cfgOrRoot.root;
  const settings = updateSettings(cfgOrRoot);
  const cache = readUpdates(root);
  const installed = readVersion(root);
  const latest = parseVersion(cache.latest) ? cache.latest : null;
  const available = Boolean(latest && parseVersion(installed) && compareVersions(latest, installed) > 0);
  const mode = typeof cfgOrRoot === 'object' && cfgOrRoot.mode ? cfgOrRoot.mode : rawConfigOf(root)?.mode;
  let github = 'none';
  if (mode !== 'local' && originKind(root) === 'github') {
    github = !fs.existsSync(path.join(root, ...WORKFLOW_REL.split('/'))) ? 'missing' : settings.github ? 'on' : 'off';
  }
  const checked = typeof cache.checked === 'string' && Number.isFinite(Date.parse(cache.checked)) ? cache.checked : null;
  return { installed, latest, checked, available, channels: { github, check: settings.check } };
}

/** The channels of a status as the owner reads them: "an issue on GitHub · no daily check (…)". */
export function channelList(cfg, status) {
  const parts = [];
  if (status.channels.github !== 'none') parts.push(say(cfg, `updates.ch_github_${status.channels.github}`));
  parts.push(say(cfg, status.channels.check ? 'updates.ch_check_on' : 'updates.ch_check_off'));
  return parts.join(' · ');
}

/**
 * Turns the daily check on or off in memory.json ("updates": {"check": …}), keeping the file's
 * style and every other key. → true when the file changed. Throws when memory.json cannot be read.
 */
export function setUpdateCheck(root, on) {
  const file = path.join(root, 'memory.json');
  const read = fs.readFileSync(file, 'utf8');
  const text = read.charCodeAt(0) === 0xfeff ? read.slice(1) : read;
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('memory.json is not a JSON object');
  const updates = j.updates && typeof j.updates === 'object' && !Array.isArray(j.updates) ? j.updates : {};
  if (updates.check === on) return false;
  j.updates = { ...updates, check: on };
  writeAtomic(file, formatJson(j, detectStyle(text)));
  return true;
}

/** Where upgrade takes the kit from, as it decides it: memory.json kit.source, the manifest's source, the default. */
export function sourceOf(root) {
  const configured = rawConfigOf(root)?.kit?.source;
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const manifest = loadManifest(root);
  return typeof manifest?.source === 'string' && manifest.source ? manifest.source : DEFAULT_SOURCE;
}

/** The workflow file on the kit's GitHub page, to copy into an older vault; null for other sources. */
export function workflowUrlOf(source) {
  const pages = releasesOf(source);
  return pages ? `${pages.page.replace(/\/releases$/, '')}/blob/main/${WORKFLOW_REL}` : null;
}

/** The issue text for the nightly CI of a vault on GitHub: {title, body}. */
export function issueText(cfg, { latest, installed, source }) {
  const pages = releasesOf(source, latest);
  const whatsnew = pages ? say(cfg, 'updates.issue_link', { url: pages.tag }) : say(cfg, 'updates.issue_changelog');
  return {
    title: say(cfg, 'updates.issue_title', { latest }),
    body: say(cfg, 'updates.issue_body', { latest, installed, whatsnew }),
  };
}
