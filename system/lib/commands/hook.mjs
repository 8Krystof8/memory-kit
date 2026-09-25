// `hook <agent> <event>`: what Claude Code and Codex run through their hooks (connect --projects
// installs them). Reads the hook's JSON from stdin, never fails a session (always exit 0), never
// writes into the code repository, and does nothing at all while memory.json projects.enabled is
// not true. Every run is logged (lib/hooklog.mjs; a local-store repository only as a hash), except
// the runs of doctor --probe (MEMORY_KIT_PROBE=1 or "probe": true in the input), which leave no
// trace at all: no session record, no hint, no project, no log entry, nothing reported as read.
// Events:
//   session-start  first, news for the user: a failed sync or failed hook runs since the last
//                  session start (Claude Code shows them as a systemMessage, which reaches the
//                  user; Codex has none, so the agent is asked to pass them on). Inside the vault:
//                  nothing more for Claude Code (the vault has its own start hook), the start
//                  view for Codex. Outside any git repository: nothing more. In a known project:
//                  the brief and the start view narrowed to the project and the core sector. In a
//                  new repository: a one-time hint for the user naming `project add` and
//                  `project ignore` (or the sector is made when projects.auto_add is on).
//   stop           once per session in a known project, when the code changed and the handoff did
//                  not: ask the agent to record handoff, gotchas and dead ends (JSON or nothing)
//   tool-failure   (Claude Code) a failed Bash or PowerShell command is looked up in the
//                  project's gotchas and dead ends, after cheap filters, deduplicated, at most 5
//                  lookups per session
//   session-end    starts the autosync in the background when projects.autosync is on
//   autosync       check, commit and sync the vault under a lock (never while a merge or rebase is
//                  unfinished); each failing step is logged with the error and the fix, and the
//                  next session start shows it

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  identifyIn, insideVault, findProject, ensureProject, isIgnored, projectSettings, projectBrief, gitState, lookupError,
  devLines, noteAbs, sectorExists, hintMarker, repoHash, readSession, writeSession, pruneSessions, sessionsDir, safeId,
  takeAutosyncLock, autosyncLockFile, vaultCommand, keepWorkDirOut,
} from '../projects.mjs';
import { hookSummary, logHook } from '../hooklog.mjs';
import { readHookInput, lookupCandidate, isProbe } from '../hookinput.mjs';
import { writeAtomic } from '../fsafe.mjs';
import { WORK_DIR, ensureWorkDirIgnored, todayLocal, workDirGit } from '../util.mjs';

export const usage = 'hook claude-code|codex session-start|stop|tool-failure|session-end (run by the agent hooks; JSON on stdin)';

const DEFAULTS = {
  'hook.hint': 'memory-kit: this repository has no project memory. To keep notes for it, run: {cmd} project add',
  'hook.hint_ignore': 'Not wanted here? Run: {cmd} project ignore (this hint is shown once per repository)',
  'hook.hint_agent': 'memory-kit showed the user a one-time hint: this repository has no project memory. Run {cmd} project add or project ignore only when the user asks for it.',
  'hook.hint_relay': 'memory-kit: this repository has no project memory. Tell the user once, in one sentence, that they can keep notes for it with {cmd} project add, or silence this hint with {cmd} project ignore; do not run either yourself.',
  'hook.relay': 'memory-kit asks you to pass this on to the user: {text}',
  'hook.sync_failed': 'Warning: the last memory sync failed ({when}, step {step}): {error}. Fix: {fix}',
  'hook.errors': 'Warning: failed memory hook runs since the last warning: {n}; see: {cmd} doctor',
  'hook.checkpoint': 'Project memory: the code changed in this session and the handoff did not. Before you finish, record briefly: 1) rewrite {handoff} (done, next steps, open questions, branch); 2) errors you fixed as gotchas: {cmd} remember --project {id} --type gotcha "symptom → cause → fix"; 3) what did not work: --type dead-end; 4) new decisions: --type decision. Only what really happened. Then finish.',
  'hook.lookup': 'Project memory: a similar error was met before:',
  'hook.commit_message': 'Memory: session {day}',
  'hook.merge_busy': 'a merge, rebase, cherry-pick or revert is not finished in the vault',
  'hook.fix_merge': 'open the vault, finish or abort it (git status says how), then run: {cmd} sync',
  'hook.fix_check': 'open the vault and run: {cmd} check',
  'hook.fix_git': 'open the vault, run git status and fix what it reports, then run: {cmd} sync',
  'hook.fix_identity': 'git does not know your name and e-mail yet: set user.name and user.email with git config --global, then run: {cmd} sync',
  'hook.fix_lock': 'make sure {dir} is a folder you can write to, then run: {cmd} sync',
  'hook.fix_sync': 'open the vault and run: {cmd} sync',
  'hook.timeout': 'timed out after {s} s',
  'hook.workdir_tracked': 'git tracks {n} files of .memory-kit/ in the vault (per-computer logs, session records and backups, which can name code repositories), so nothing was committed',
  'hook.fix_workdir_tracked': 'open the vault, run git rm -r --cached .memory-kit, add the line .memory-kit/ to .gitignore and commit, then run: {cmd} sync',
  'hook.workdir_ignored': 'git does not ignore .memory-kit/ in the vault and it could not be added to .git/info/exclude, so nothing was committed',
  'hook.fix_workdir_ignored': 'add the line .memory-kit/ to the vault\'s .gitignore and commit it, then run: {cmd} sync',
};

const AGENTS = new Set(['claude-code', 'codex']);
const EVENTS = new Set(['session-start', 'stop', 'tool-failure', 'session-end', 'autosync']);
const MAX_LOOKUPS = 5;
const MAX_CONTEXT_CHARS = 600;
const MAX_CONTEXT_LINES = 3;
// Conflict states of `git status --porcelain` (both sides changed, added or deleted a path).
const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (a, n) => (n in vars ? String(vars[n]) : a));
}

const cwdOf = (input) => (typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
const reportedFile = (cfg) => path.join(cfg.root, '.memory-kit', 'logs', 'reported');

function coreSector(cfg) {
  const parts = String(cfg.raw?.profile ?? '').split('/');
  return parts.length >= 3 ? parts[1] : null;
}

/**
 * Lines for the user about failures logged since the last session start that reported some: a
 * failed last sync (when, step, error and fix) and failed hook runs (how many; see doctor). Each
 * failure is reported once; `project status` and doctor keep showing the log.
 */
function freshWarnings(cfg) {
  const s = hookSummary(cfg.root);
  let since = '';
  try {
    since = fs.readFileSync(reportedFile(cfg), 'utf8').trim();
  } catch {
    /* nothing reported yet */
  }
  const fresh = (e) => typeof e?.t === 'string' && e.t > since;
  const cmd = vaultCommand(cfg);
  const out = [];
  let newest = since;
  if (s.lastSync?.ok === false && fresh(s.lastSync)) {
    out.push(say(cfg, 'hook.sync_failed', {
      when: `${s.lastSync.t.slice(0, 16).replace('T', ' ')} UTC`, step: s.lastSync.step ?? '?', error: s.lastSync.error || '?',
      fix: s.lastSync.fix || say(cfg, 'hook.fix_sync', { cmd }),
    }));
    newest = s.lastSync.t;
  }
  const errors = s.failures.filter((e) => e.event !== 'autosync' && fresh(e));
  if (errors.length) out.push(say(cfg, 'hook.errors', { n: errors.length, cmd }));
  for (const e of errors) if (e.t > newest) newest = e.t;
  if (newest !== since) writeAtomic(reportedFile(cfg), `${newest}\n`);
  return out;
}

/**
 * The session start output. Claude Code: lines for the user go into systemMessage (JSON), the
 * rest into the agent's context (plain text when there is nothing for the user). Codex shows no
 * systemMessage, so the agent is asked to pass those lines on.
 */
function emit(cfg, agent, { notices = [], context = '' }) {
  if (agent === 'codex') return [...notices.map((text) => say(cfg, 'hook.relay', { text })), context].filter(Boolean).join('\n');
  if (!notices.length) return context;
  return JSON.stringify({
    systemMessage: notices.join('\n'),
    ...(context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {}),
  });
}

/** The one-time hint of a new repository: { notices, context } (empty once it was shown). */
function hintOnce(cfg, agent, ident) {
  const marker = hintMarker(cfg, ident.key);
  if (fs.existsSync(marker)) return {};
  writeAtomic(marker, `${todayLocal()}\n`);
  const cmd = vaultCommand(cfg);
  if (agent === 'codex') return { context: say(cfg, 'hook.hint_relay', { cmd }) };
  return { notices: [say(cfg, 'hook.hint', { cmd }), say(cfg, 'hook.hint_ignore', { cmd })], context: say(cfg, 'hook.hint_agent', { cmd }) };
}

async function sessionStart(cfg, agent, input, entry) {
  pruneSessions(cfg);
  const notices = freshWarnings(cfg);
  try {
    return await sessionView(cfg, agent, input, entry, notices);
  } catch (err) {
    // The warnings are marked as reported: they must still reach the user.
    entry.ok = false;
    entry.error = err?.message ?? String(err);
    if (process.env.MEMORY_DEBUG) process.stderr.write(`memory hook: ${err?.stack ?? err}\n`);
    return emit(cfg, agent, { notices });
  }
}

async function sessionView(cfg, agent, input, entry, notices) {
  const cwd = cwdOf(input);
  const sid = safeId(input.session_id);
  const vault = insideVault(cfg, cwd);
  const ident = vault ? null : identifyIn(cfg, cwd);
  if (vault || !ident || insideVault(cfg, ident.top)) {
    writeSession(cfg, sid, { top: ident?.top ?? null, sector: null });
    // Claude Code runs the vault's own start hook there; Codex has none, so the view comes from here.
    if (agent === 'codex' && (vault || ident)) {
      const { renderStartView } = await import('../startview.mjs');
      return emit(cfg, agent, { notices, context: (await renderStartView(cfg, {})).text });
    }
    return emit(cfg, agent, { notices });
  }
  entry.repo = repoHash(ident.key);
  let found = findProject(cfg, ident);
  if (!found) {
    writeSession(cfg, sid, { top: ident.top, sector: null });
    // No lasting key yet (no commit): nothing to offer until there is one.
    if (ident.unsettled || isIgnored(cfg, ident)) return emit(cfg, agent, { notices });
    if (!projectSettings(cfg).auto_add) {
      const hint = hintOnce(cfg, agent, ident);
      return emit(cfg, agent, { notices: [...(hint.notices ?? []), ...notices], context: hint.context });
    }
    const made = await ensureProject(cfg, ident, { force: false });
    if (!made.id) return emit(cfg, agent, { notices });
    found = { id: made.id, store: made.store, key: ident.key };
  }
  if (found.store === 'git') entry.repo = found.key;
  const g = gitState(ident.top);
  writeSession(cfg, sid, { top: ident.top, sector: found.id, store: found.store, head: g.head, dirty: g.dirty, day: todayLocal() });
  const { renderStartView } = await import('../startview.mjs');
  const core = coreSector(cfg);
  const view = await renderStartView(cfg, { sectors: [found.id, ...(core && core !== found.id ? [core] : [])] });
  const brief = projectBrief(cfg, found.id, ident, vaultCommand(cfg), { git: g });
  return emit(cfg, agent, { notices, context: `${brief}\n${view.text}` });
}

function stop(cfg, input) {
  if (!projectSettings(cfg).checkpoint || input.stop_hook_active === true || input.agent_id || input.permission_mode === 'plan') return '';
  const sid = safeId(input.session_id);
  const s = readSession(cfg, sid);
  if (!s?.sector || !s.top || !sectorExists(cfg, s.sector)) return '';
  const marker = path.join(cfg.root, '.memory-kit', 'capture', 'nudged', sid);
  if (fs.existsSync(marker)) return '';
  const g = gitState(s.top);
  // A session linked without a baseline (by an older version): the state of now becomes it.
  if (!Object.hasOwn(s, 'head')) {
    writeSession(cfg, sid, { ...s, head: g.head, dirty: g.dirty });
    return '';
  }
  const changed = (g.head && g.head !== s.head) || g.dirty !== s.dirty;
  if (!changed) return '';
  const handoff = noteAbs(cfg, s.sector, 'handoff');
  // The agent already rewrote the handoff during this session: nothing to ask.
  try {
    const started = fs.statSync(path.join(sessionsDir(cfg), `${sid}.json`)).mtimeMs;
    if (fs.statSync(handoff).mtimeMs > started) return '';
  } catch {
    /* no handoff note or no session file */
  }
  writeAtomic(marker, `${todayLocal()}\n`);
  return JSON.stringify({ decision: 'block', reason: say(cfg, 'hook.checkpoint', { handoff, cmd: vaultCommand(cfg), id: s.sector }) });
}

/** The first line with some letters in it, digits folded, for deduplication. */
function firstMeaningfulLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => /[A-Za-z]{3}/.test(l)) ?? '';
  return line.replace(/\d+/g, '#').slice(0, 200);
}

/** True when this (tool, error) was not looked up yet in this session and the budget allows one more. */
function firstLookup(cfg, sid, tool, text) {
  if (!sid) return true;
  const file = path.join(sessionsDir(cfg), `${sid}.seen`);
  let seen = [];
  try {
    seen = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    /* first lookup of the session */
  }
  const sig = createHash('sha256').update(`${tool}\n${firstMeaningfulLine(text)}`).digest('hex').slice(0, 16);
  if (seen.includes(sig) || seen.length >= MAX_LOOKUPS) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${sig}\n`);
  return true;
}

function toolFailure(cfg, input, entry) {
  // Cheap filters first: most failures (grep without a match, failing tests) end here.
  if (!projectSettings(cfg).error_lookup) return '';
  const candidate = lookupCandidate(input);
  if (!candidate) return '';
  const { text } = candidate;
  const sid = safeId(input.session_id);
  const s = readSession(cfg, sid);
  let sector = s ? s.sector : undefined;
  if (sector === undefined) {
    const ident = identifyIn(cfg, cwdOf(input));
    const found = ident && !insideVault(cfg, ident.top) ? findProject(cfg, ident) : null;
    sector = found?.id ?? null;
  }
  if (!sector || !sectorExists(cfg, sector)) return '';
  const lines = devLines(cfg, sector);
  if (!lines.length) return '';
  if (!firstLookup(cfg, sid, input.tool_name, text)) return '';
  entry.lookup = true;
  const hits = lookupError(cfg, sector, text, { lines, max: MAX_CONTEXT_LINES - 1 });
  if (!hits.length) return '';
  const out = [say(cfg, 'hook.lookup')];
  let size = out[0].length;
  for (const h of hits) {
    const room = MAX_CONTEXT_CHARS - size - 1;
    if (room < 40) break;
    const line = h.line.length > room ? `${h.line.slice(0, room - 1)}…` : h.line;
    out.push(line);
    size += line.length + 1;
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: out.join('\n') } });
}

function sessionEnd(cfg, agent) {
  if (!projectSettings(cfg).autosync) return;
  const child = spawn(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), 'hook', agent, 'autosync', '--root', cfg.root], {
    cwd: cfg.root, detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

// ---------------------------------------------------------------------------------------------
// autosync

const GIT_TIMEOUT_MS = 60000;
const CHECK_TIMEOUT_MS = 120000;
const SYNC_TIMEOUT_MS = 180000;

function lastLine(res) {
  if (res.error?.code === 'ETIMEDOUT' || (res.signal && res.status === null)) return null;
  const text = `${res.stderr ?? ''}\n${res.stdout ?? ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  return text.find((l) => /error|fatal|failed|refused|conflict|selhal|chyb/i.test(l)) ?? text[0] ?? (res.error?.message || `exit ${res.status}`);
}

/** True while git has a merge, rebase, cherry-pick or revert of the vault waiting to be finished. */
function unfinished(cfg, git, porcelain) {
  if (porcelain.split('\n').some((l) => UNMERGED.has(l.slice(0, 2)))) return true;
  const names = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];
  const res = git(['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  if (res.status !== 0) return false;
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean).some((rel) => fs.existsSync(path.resolve(cfg.root, rel)));
}

/**
 * .memory-kit/ holds per-computer files that can name code repositories (session records, the
 * hook log, the ignore list, copies of agent settings): it is never committed. A clone of a vault
 * made by 0.1.0 has no .gitignore line for it, so this clone's .git/info/exclude gets one first.
 * → null when git keeps it out, else { error, fix } (files under it tracked already, or no rule).
 */
function workDirProblem(cfg, cmd) {
  try {
    ensureWorkDirIgnored(cfg.root);
  } catch {
    /* checked below */
  }
  const state = workDirGit(cfg.root);
  if (state?.tracked.length) return { error: say(cfg, 'hook.workdir_tracked', { n: state.tracked.length }), fix: say(cfg, 'hook.fix_workdir_tracked', { cmd }) };
  if (!state?.ignored) return { error: say(cfg, 'hook.workdir_ignored'), fix: say(cfg, 'hook.fix_workdir_ignored', { cmd }) };
  return null;
}

/**
 * Check, commit and sync the vault. The steps logged are the contract's: lock, check, commit,
 * pull, push, and done for success. Nothing throws out of here: any error is logged at the step
 * it happened in, with a fix.
 */
function autosync(cfg, agent) {
  const t0 = performance.now();
  const cmd = vaultCommand(cfg);
  const log = (e) => logHook(cfg.root, { agent, event: 'autosync', ms: Math.round(performance.now() - t0), ...e });
  const opts = (timeout) => ({ cwd: cfg.root, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const git = (args) => spawnSync('git', args, opts(GIT_TIMEOUT_MS));
  const memory = (args, timeout) => spawnSync(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), ...args, '--root', cfg.root], opts(timeout));
  const fail = (step, res, fix) => log({ step, ok: false, error: lastLine(res) ?? say(cfg, 'hook.timeout', { s: Math.round((res.timeout ?? 0) / 1000) }), fix });
  let step = 'lock';
  let release = null;
  try {
    release = takeAutosyncLock(cfg);
    if (!release) {
      log({ step: 'lock', ok: true, detail: 'another autosync is running; skipped' });
      return;
    }
    step = 'check';
    const top = git(['rev-parse', '--show-cdup']);
    if (top.status !== 0 || top.stdout.trim() !== '') {
      log({ step: 'done', ok: true, detail: 'the vault is not a git repository' });
      return;
    }
    const work = workDirProblem(cfg, cmd);
    if (work) return log({ step: 'check', ok: false, ...work });
    const status = git(['status', '--porcelain']);
    if (status.status !== 0) return fail('check', status, say(cfg, 'hook.fix_git', { cmd }));
    // Never conclude a merge the user has not finished: add -A would commit its conflict markers.
    if (unfinished(cfg, git, status.stdout)) return log({ step: 'check', ok: false, error: say(cfg, 'hook.merge_busy'), fix: say(cfg, 'hook.fix_merge', { cmd }) });
    if (status.stdout.trim()) {
      const check = memory(['check', '--generate', '--lenient'], CHECK_TIMEOUT_MS);
      if (check.status !== 0) return fail('check', { ...check, timeout: CHECK_TIMEOUT_MS }, say(cfg, 'hook.fix_check', { cmd }));
      step = 'commit';
      const add = git(['add', '-A']);
      if (add.status !== 0) return fail('commit', { ...add, timeout: GIT_TIMEOUT_MS }, say(cfg, 'hook.fix_git', { cmd }));
      // The folder is ignored by now; should a rule change meanwhile, what got staged of it goes.
      const out = git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', WORK_DIR]);
      if (out.status !== 0) return fail('commit', { ...out, timeout: GIT_TIMEOUT_MS }, say(cfg, 'hook.fix_git', { cmd }));
      const commit = git(['commit', '-q', '-m', say(cfg, 'hook.commit_message', { day: todayLocal() })]);
      if (commit.status !== 0) {
        const identity = /user\.email|user\.name|tell me who you are|identity/i.test(`${commit.stderr}${commit.stdout}`);
        if (!/nothing (added )?to commit|nothing to commit/i.test(`${commit.stdout}${commit.stderr}`)) {
          return fail('commit', { ...commit, timeout: GIT_TIMEOUT_MS }, say(cfg, identity ? 'hook.fix_identity' : 'hook.fix_git', { cmd }));
        }
      }
    } else {
      const ahead = git(['rev-list', '--count', '@{u}..HEAD']);
      if (ahead.status === 0 && ahead.stdout.trim() === '0') {
        log({ step: 'done', ok: true, detail: 'nothing to sync' });
        return;
      }
    }
    step = 'pull';
    const sync = memory(['sync'], SYNC_TIMEOUT_MS);
    if (sync.status !== 0) {
      const pulled = String(sync.stdout ?? '').split('\n').includes(cfg.t('sync.pulled'));
      return fail(pulled ? 'push' : 'pull', { ...sync, timeout: SYNC_TIMEOUT_MS }, say(cfg, 'hook.fix_sync', { cmd }));
    }
    log({ step: 'done', ok: true });
  } catch (err) {
    const fix = step === 'lock' ? say(cfg, 'hook.fix_lock', { dir: path.dirname(autosyncLockFile(cfg)), cmd }) : say(cfg, 'hook.fix_sync', { cmd });
    log({ step, ok: false, error: err?.message ?? String(err), fix });
  } finally {
    release?.();
  }
}

// ---------------------------------------------------------------------------------------------

export async function run(argv, cfg, ctx = {}) {
  const t0 = ctx.hookStarted ?? performance.now();
  const [agent, event] = argv.filter((a) => !a.startsWith('--'));
  if (!AGENTS.has(agent) || !EVENTS.has(event)) return 0;
  // doctor --probe only needs to see the hook start and end cleanly: it must leave no trace.
  if (isProbe(ctx.env ?? process.env)) return 0;
  if (!cfg) {
    // memory.json cannot be read: whether the hooks are on is unknown, but the failure is logged.
    if (ctx.root && ctx.configError) logHook(ctx.root, { agent, event, ok: false, error: `memory.json: ${ctx.configError.message ?? ctx.configError}` });
    return 0;
  }
  if (!projectSettings(cfg).enabled) return 0;
  // The first run in this clone makes .memory-kit/: keep it out of git before anything is in it.
  keepWorkDirOut(cfg);
  if (event === 'autosync') {
    try {
      autosync(cfg, agent);
    } catch {
      /* autosync logs its own errors; a hook never fails */
    }
    return 0;
  }
  const entry = { agent, event, ok: true };
  try {
    const input = ctx.hookInput ?? await readHookInput();
    if (isProbe(null, input)) return 0;
    let out = '';
    if (event === 'session-start') out = await sessionStart(cfg, agent, input, entry);
    else if (event === 'stop') out = stop(cfg, input);
    else if (event === 'tool-failure') out = toolFailure(cfg, input, entry);
    else if (event === 'session-end') sessionEnd(cfg, agent);
    if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  } catch (err) {
    entry.ok = false;
    entry.error = err?.message ?? String(err);
    if (process.env.MEMORY_DEBUG) process.stderr.write(`memory hook: ${err?.stack ?? err}\n`);
  }
  logHook(cfg.root, { ...entry, ms: Math.round(performance.now() - t0) });
  return 0;
}
