// `project add|remove|ignore|unignore|list|status`: the coding projects of the vault, run inside
// the code repository (docs/projects.md). add links the repository to a new dev sector (store
// local keeps its notes and the link in the local root, store git in the repository; only its own
// key counts, and a repository without a commit is refused); remove unlinks it and keeps the
// notes; ignore silences the one-time hint of the session start (and a loose match to another
// repository's project); list shows every project; status shows this repository, the settings,
// the last hook runs, recent failures and the autosync lock. Every subcommand takes --json.

import path from 'node:path';
import fs from 'node:fs';
import {
  STORES, ProjectError, identifyIn, insideVault, findProject, ensureProject, projectSettings, mappings, noteAbs, shownPath,
  isIgnored, setIgnored, ignoredKeys, unsetMapping, hintMarker, lastSessions, linkSessions, autosyncLockState, sectorExists,
  vaultCommand, keepWorkDirOut,
} from '../projects.mjs';
import { parseCli, usageError } from '../util.mjs';

export const usage = 'project add [--store local|git] [--title "…"] [--json] | project remove|ignore|unignore|list|status [--json]';

const DEFAULTS = {
  'project.not_repo': 'not inside a git repository: run this in the folder of a code project',
  'project.in_vault': 'this is the memory vault itself, not a code project',
  'project.store': 'unknown --store "{store}"; use local or git',
  'project.subcommand': 'unknown subcommand "{sub}"; use add, remove, ignore, unignore, list or status',
  'project.added': 'added: this repository is project sector {id} (store {store}); its notes are in {notes}',
  'project.exists': 'this repository is already project sector {id} (store {store}); its notes are in {notes}',
  'project.busy': 'another process is adding this project right now; try again in a moment',
  'project.foreign_root': 'the local root "{path}" is a path of another operating system; fix memory.json "roots", or add the project with --store git',
  'project.inside_root': 'no local root could be made next to the vault ({path}); add one to memory.json "roots", or add the project with --store git',
  'project.no_id': 'no free sector id for the project; turn off old dev sectors first',
  'project.no_commit': 'this repository has no commit yet, so nothing identifies it for good; make the first commit, then run project add again',
  'project.slow': 'git took too long to find the first commit of this repository; try again in a moment',
  'project.off': 'the project hooks are off, so sessions do not see this project yet; turn them on with: {cmd} connect claude-code --projects',
  'project.removed': 'removed: this repository is no longer linked to sector {id}; its notes stay in {notes} (to archive them: {cmd} sector off {id})',
  'project.unknown': 'this repository is not a project; add it with: {cmd} project add',
  'project.borrowed': 'this repository has no link of its own: it uses the project of {key} (sector {id}), found under another host name; nothing was removed. To stop that, run: {cmd} project ignore',
  'project.ignored': 'ignored: session starts in this repository stay silent',
  'project.already_ignored': 'this repository is already ignored',
  'project.ignore_known': 'this repository is project sector {id}; unlink it first with: {cmd} project remove',
  'project.unignored': 'no longer ignored: the next session start here shows the hint again',
  'project.not_ignored': 'this repository was not ignored',
  'project.none': 'no projects yet; add one inside its repository with: {cmd} project add',
  'project.row': '{id} · {store} · {key} · last session {last}',
  'project.never': 'never',
  'project.ignored_count': 'ignored repositories: {n}',
  'project.status_repo': 'repository: {key} ({top})',
  'project.status_no_repo': 'repository: none (not inside a git repository)',
  'project.status_known': 'project: sector {id}, store {store}, notes in {notes}',
  'project.status_via': 'found through the link of {key} (another host name or an older key); {cmd} project add gives this repository a project of its own',
  'project.status_unknown': 'project: not added (add it with: {cmd} project add)',
  'project.status_ignored': 'project: ignored (undo it with: {cmd} project unignore)',
  'project.status_vault': 'project: none, this is the memory vault itself',
  'project.status_settings': 'settings: enabled {enabled}, auto_add {auto_add}, store {store}, autosync {autosync}, checkpoint {checkpoint}, error_lookup {error_lookup}',
  'project.status_runs': 'last hook runs: {runs}',
  'project.status_no_runs': 'last hook runs: none logged yet',
  'project.run_ok': '{event} ok {when}',
  'project.run_failed': '{event} failed {when}',
  'project.status_sync_ok': 'last autosync: ok ({when})',
  'project.status_sync_failed': 'last autosync: failed at step {step} ({when}): {error}; fix: {fix}',
  'project.status_failures': 'failures in the last 7 days: {n}',
  'project.status_failure': '- {when} {event} {step}: {error}',
  'project.lock_free': 'autosync lock: free',
  'project.lock_busy': 'autosync lock: held by process {pid} since {since}',
  'project.lock_stale': 'autosync lock: stale (process {pid}, since {since}); the next autosync removes it',
};

const SUBCOMMANDS = ['add', 'remove', 'ignore', 'unignore', 'list', 'status'];

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (a, n) => (n in vars ? String(vars[n]) : a));
}

const notesOf = (cfg, id) => shownPath(cfg, path.dirname(noteAbs(cfg, id, 'overview')));

/** Prints a result: the JSON object with --json, else the lines. Returns the exit code. */
function report(values, json, lines, code = 0) {
  if (values.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else if (lines.length) (code === 0 ? process.stdout : process.stderr).write(`${lines.map((l) => (code === 0 ? l : `memory: ${l}`)).join('\n')}\n`);
  return code;
}

/** The repository of the current folder, or a printed refusal (null). */
function here(cfg, values) {
  const cwd = process.cwd();
  if (insideVault(cfg, cwd)) return { refused: report(values, { ok: false, reason: 'in_vault' }, [say(cfg, 'project.in_vault')], 1) };
  const ident = identifyIn(cfg, cwd);
  if (!ident) return { refused: report(values, { ok: false, reason: 'not_repo' }, [say(cfg, 'project.not_repo')], 1) };
  if (insideVault(cfg, ident.top)) return { refused: report(values, { ok: false, reason: 'in_vault' }, [say(cfg, 'project.in_vault')], 1) };
  return { ident };
}

async function add(cfg, values) {
  if (values.store !== undefined && !STORES.includes(values.store)) {
    usageError(say(cfg, 'project.store', { store: values.store }), usage);
    return 2;
  }
  const { ident, refused } = here(cfg, values);
  if (!ident) return refused;
  const set = projectSettings(cfg);
  const off = set.enabled ? [] : [say(cfg, 'project.off', { cmd: vaultCommand(cfg) })];
  // Only this repository's own key counts: one that merely resembles a project gets its own.
  const found = findProject(cfg, ident, { exactOnly: true });
  if (found) {
    return report(values, { ok: true, action: 'add', created: false, sector: found.id, store: found.store, key: ident.key, notes: notesOf(cfg, found.id) },
      [say(cfg, 'project.exists', { id: found.id, store: found.store, notes: notesOf(cfg, found.id) }), ...off]);
  }
  let made;
  try {
    made = await ensureProject(cfg, ident, { force: true, store: values.store, title: values.title });
  } catch (err) {
    if (err?.code === 'SECTOR') return report(values, { ok: false, reason: err.reason, detail: err.message }, [err.message], 1);
    if (!(err instanceof ProjectError)) throw err;
    return report(values, { ok: false, reason: err.reason }, [say(cfg, `project.${err.reason}`, { path: err.detail, cmd: vaultCommand(cfg) })], 1);
  }
  if (!made.id) return report(values, { ok: false, reason: 'busy' }, [say(cfg, 'project.busy')], 1);
  setIgnored(cfg, ident.key, false);
  linkSessions(cfg, ident.top, made.id, made.store);
  const notes = notesOf(cfg, made.id);
  return report(values, { ok: true, action: 'add', created: made.created, sector: made.id, store: made.store, key: ident.key, notes },
    [say(cfg, made.created ? 'project.added' : 'project.exists', { id: made.id, store: made.store, notes }), ...off]);
}

function remove(cfg, values) {
  const { ident, refused } = here(cfg, values);
  if (!ident) return refused;
  const cmd = vaultCommand(cfg);
  const found = findProject(cfg, ident);
  if (!found) return report(values, { ok: false, reason: 'unknown', key: ident.key }, [say(cfg, 'project.unknown', { cmd })], 1);
  if (!found.exact) {
    return report(values, { ok: false, reason: 'borrowed', key: ident.key, via: found.key, sector: found.id },
      [say(cfg, 'project.borrowed', { key: found.key, id: found.id, cmd })], 1);
  }
  unsetMapping(cfg, found.key, found.store);
  const notes = notesOf(cfg, found.id);
  return report(values, { ok: true, action: 'remove', sector: found.id, store: found.store, key: found.key, notes },
    [say(cfg, 'project.removed', { id: found.id, notes, cmd })]);
}

function ignore(cfg, values, on) {
  const { ident, refused } = here(cfg, values);
  if (!ident) return refused;
  const found = findProject(cfg, ident, { exactOnly: true });
  if (on && found) {
    return report(values, { ok: false, reason: 'known', sector: found.id }, [say(cfg, 'project.ignore_known', { id: found.id, cmd: vaultCommand(cfg) })], 1);
  }
  const changed = setIgnored(cfg, ident.key, on);
  if (!on) {
    try {
      fs.unlinkSync(hintMarker(cfg, ident.key));
    } catch {
      /* the hint was never shown */
    }
  }
  const key = on ? (changed ? 'project.ignored' : 'project.already_ignored') : (changed ? 'project.unignored' : 'project.not_ignored');
  return report(values, { ok: true, action: on ? 'ignore' : 'unignore', key: ident.key, changed }, [say(cfg, key)]);
}

function list(cfg, values) {
  const last = lastSessions(cfg);
  const projects = mappings(cfg).filter((m) => sectorExists(cfg, m.id)).map((m) => ({
    sector: m.id, store: m.store, key: m.key, notes: notesOf(cfg, m.id), last_session: last[m.id] ?? null,
  })).sort((a, b) => (a.sector < b.sector ? -1 : a.sector > b.sector ? 1 : a.key < b.key ? -1 : 1));
  const ignored = ignoredKeys(cfg).length;
  const lines = projects.length
    ? projects.map((p) => say(cfg, 'project.row', { id: p.sector, store: p.store, key: p.key, last: p.last_session ? p.last_session.slice(0, 10) : say(cfg, 'project.never') }))
    : [say(cfg, 'project.none', { cmd: vaultCommand(cfg) })];
  if (ignored) lines.push(say(cfg, 'project.ignored_count', { n: ignored }));
  return report(values, { projects, ignored }, lines);
}

async function status(cfg, values) {
  const cmd = vaultCommand(cfg);
  const set = projectSettings(cfg);
  const cwd = process.cwd();
  const vault = insideVault(cfg, cwd);
  const ident = vault ? null : identifyIn(cfg, cwd);
  const inVault = vault || (ident && insideVault(cfg, ident.top));
  const found = ident && !inVault ? findProject(cfg, ident) : null;
  const ignored = Boolean(ident && !found && isIgnored(cfg, ident));
  const { hookSummary } = await import('../hooklog.mjs');
  const summary = hookSummary(cfg.root);
  const lock = autosyncLockState(cfg);
  const settings = { enabled: set.enabled, auto_add: set.auto_add, store: set.store, autosync: set.autosync, checkpoint: set.checkpoint, error_lookup: set.error_lookup };
  const json = {
    repo: ident && !inVault ? { key: ident.key, top: ident.top, unsettled: ident.unsettled ?? null } : null,
    vault: Boolean(inVault),
    project: found ? { sector: found.id, store: found.store, notes: notesOf(cfg, found.id), via: found.exact ? null : found.key } : null,
    ignored,
    settings,
    hooks: {
      last_runs: Object.fromEntries(Object.entries(summary.lastRun).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, e]) => [k, { t: e.t, ok: e.ok, ms: e.ms ?? null, step: e.step ?? null }])),
      failures: summary.failures.map((e) => ({ t: e.t, event: e.event, step: e.step ?? null, error: e.error ?? null, fix: e.fix ?? null })),
      last_sync: summary.lastSync ? { t: summary.lastSync.t, ok: summary.lastSync.ok, step: summary.lastSync.step ?? null, error: summary.lastSync.error ?? null, fix: summary.lastSync.fix ?? null } : null,
    },
    lock,
  };
  const lines = [];
  if (inVault) lines.push(say(cfg, 'project.status_vault'));
  else if (!ident) lines.push(say(cfg, 'project.status_no_repo'));
  else {
    lines.push(say(cfg, 'project.status_repo', { key: ident.key, top: ident.top }));
    if (found) lines.push(say(cfg, 'project.status_known', { id: found.id, store: found.store, notes: notesOf(cfg, found.id) }));
    if (found && !found.exact) lines.push(say(cfg, 'project.status_via', { key: found.key, cmd }));
    else if (ident.unsettled && !ignored) lines.push(say(cfg, `project.${ident.unsettled}`));
    else lines.push(say(cfg, ignored ? 'project.status_ignored' : 'project.status_unknown', { cmd }));
  }
  lines.push(say(cfg, 'project.status_settings', settings));
  if (!set.enabled) lines.push(say(cfg, 'project.off', { cmd }));
  const when = (t) => String(t ?? '?').slice(0, 16).replace('T', ' ');
  const runs = Object.entries(json.hooks.last_runs).map(([event, e]) => say(cfg, e.ok === false ? 'project.run_failed' : 'project.run_ok', { event, when: when(e.t) }));
  lines.push(runs.length ? say(cfg, 'project.status_runs', { runs: runs.join(', ') }) : say(cfg, 'project.status_no_runs'));
  const sync = summary.lastSync;
  if (sync?.ok === false) lines.push(say(cfg, 'project.status_sync_failed', { step: sync.step ?? '?', when: when(sync.t), error: sync.error ?? '?', fix: sync.fix ?? '?' }));
  else if (sync) lines.push(say(cfg, 'project.status_sync_ok', { when: when(sync.t) }));
  lines.push(say(cfg, 'project.status_failures', { n: summary.failures.length }));
  for (const e of summary.failures.slice(-5)) {
    lines.push(say(cfg, 'project.status_failure', { when: when(e.t), event: e.event ?? '?', step: e.step ?? '', error: e.error ?? '?' }));
  }
  lines.push(say(cfg, `project.lock_${lock.state}`, { pid: lock.pid ?? '?', since: when(lock.started) }));
  return report(values, json, lines);
}

export async function run(argv, cfg) {
  const parsed = parseCli(argv, { store: { type: 'string' }, title: { type: 'string' }, json: { type: 'boolean' } }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  const [sub, extra] = positionals;
  if (!SUBCOMMANDS.includes(sub) || extra !== undefined) {
    usageError(say(cfg, 'project.subcommand', { sub: extra ?? sub ?? '' }), usage);
    return 2;
  }
  keepWorkDirOut(cfg);
  if (sub === 'add') return add(cfg, values);
  if (sub === 'remove') return remove(cfg, values);
  if (sub === 'ignore' || sub === 'unignore') return ignore(cfg, values, sub === 'ignore');
  if (sub === 'list') return list(cfg, values);
  return status(cfg, values);
}
