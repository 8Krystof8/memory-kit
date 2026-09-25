// `hook <agent> <event>`: what Claude Code and Codex run through their hooks (connect --projects
// installs them). Reads the hook's JSON from stdin, never fails a session (always exit 0), never
// writes into the code repository, and does nothing at all while memory.json projects.enabled is
// not true. Every run is logged (lib/hooklog.mjs; a local-store repository only as a hash).
// Events:
//   session-start  inside the vault or outside any git repository: nothing (the vault has its own
//                  start hook). In a known project: the brief (warnings about a failed sync or
//                  hook errors first) and the start view narrowed to the project and the core
//                  sector. In a new repository: a one-time hint naming `project add` and
//                  `project ignore` (or the sector is created when projects.auto_add is on).
//   stop           once per session in a known project, when the code changed and the handoff did
//                  not: ask the agent to record handoff, gotchas and dead ends (JSON or nothing)
//   tool-failure   (Claude Code) a failed Bash or PowerShell command is looked up in the
//                  project's gotchas and dead ends, after cheap filters, deduplicated, at most 5
//                  lookups per session
//   session-end    starts the autosync in the background when projects.autosync is on
//   autosync       check, add, commit and sync the vault under a lock; each failing step is logged
//                  with the error and the fix, and the next session start shows it

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  identify, insideVault, findProject, ensureProject, isIgnored, projectSettings, projectBrief, gitState, lookupError,
  devLines, noteAbs, sectorExists, hintMarker, repoHash, readSession, writeSession, pruneSessions, sessionsDir, safeId,
  takeAutosyncLock,
} from '../projects.mjs';
import { hookSummary, logHook } from '../hooklog.mjs';
import { readHookInput, lookupCandidate } from '../hookinput.mjs';
import { writeAtomic } from '../fsafe.mjs';
import { todayLocal } from '../util.mjs';

export const usage = 'hook <claude-code|codex> <session-start|stop|tool-failure|session-end>';

const DEFAULTS = {
  'hook.hint': 'memory-kit: this repository has no project memory. To keep notes for it, run: {cmd} project add',
  'hook.hint_ignore': 'Not wanted here? Run: {cmd} project ignore (this hint is shown once per repository)',
  'hook.sync_failed': 'Warning: the last memory sync failed ({when}, step {step}): {error}. Fix: {fix}',
  'hook.errors': 'Warning: failed memory hook runs in the last 7 days: {n}; run: {cmd} doctor',
  'hook.checkpoint': 'Project memory: the code changed in this session and the handoff did not. Before you finish, record briefly: 1) rewrite {handoff} (done, next steps, open questions, branch); 2) errors you fixed as gotchas: {cmd} remember --type gotcha "symptom → cause → fix"; 3) what did not work: --type dead-end; 4) new decisions: --type decision. Only what really happened. Then finish.',
  'hook.lookup': 'Project memory: a similar error was met before:',
  'hook.commit_message': 'Memory: session {day}',
  'hook.fix_check': 'open the vault and run: {cmd} check',
  'hook.fix_git': 'open the vault, run git status and fix what it reports, then run: {cmd} sync',
  'hook.fix_identity': 'git does not know your name and e-mail yet: set user.name and user.email with git config --global, then run: {cmd} sync',
  'hook.fix_sync': 'open the vault and run: {cmd} sync',
  'hook.timeout': 'timed out after {s} s',
};

const AGENTS = new Set(['claude-code', 'codex']);
const EVENTS = new Set(['session-start', 'stop', 'tool-failure', 'session-end', 'autosync']);
const MAX_LOOKUPS = 5;
const MAX_CONTEXT_CHARS = 600;
const MAX_CONTEXT_LINES = 3;

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return DEFAULTS[key].replace(/\{(\w+)\}/g, (a, n) => (n in vars ? String(vars[n]) : a));
}

const quote = (p) => (/[\s"'&()]/.test(p) ? `"${p}"` : p);
const vaultCommand = (cfg) => `node ${quote(path.join(cfg.root, 'system', 'memory.mjs'))}`;
const cwdOf = (input) => (typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());

function coreSector(cfg) {
  const parts = String(cfg.raw?.profile ?? '').split('/');
  return parts.length >= 3 ? parts[1] : null;
}

/** Warning lines for the top of the brief: a failed last sync, hook errors of the last 7 days. */
function briefWarnings(cfg) {
  const s = hookSummary(cfg.root);
  const out = [];
  const cmd = vaultCommand(cfg);
  if (s.lastSync && s.lastSync.ok === false) {
    const when = typeof s.lastSync.t === 'string' ? `${s.lastSync.t.slice(0, 16).replace('T', ' ')} UTC` : '?';
    out.push(say(cfg, 'hook.sync_failed', {
      when, step: s.lastSync.step ?? '?', error: s.lastSync.error || '?', fix: s.lastSync.fix || say(cfg, 'hook.fix_sync', { cmd }),
    }));
  }
  const errors = s.failures.filter((e) => e.event !== 'autosync').length;
  if (errors) out.push(say(cfg, 'hook.errors', { n: errors, cmd }));
  return out;
}

function hintOnce(cfg, ident) {
  const marker = hintMarker(cfg, ident.key);
  if (fs.existsSync(marker)) return '';
  writeAtomic(marker, `${todayLocal()}\n`);
  const cmd = vaultCommand(cfg);
  return `${say(cfg, 'hook.hint', { cmd })}\n${say(cfg, 'hook.hint_ignore', { cmd })}\n`;
}

async function sessionStart(cfg, input, entry) {
  const cwd = cwdOf(input);
  const sid = safeId(input.session_id);
  // The vault's own start hook prints the start view there; outside git there is no project.
  if (insideVault(cfg, cwd)) return '';
  const ident = identify(cwd);
  if (!ident || insideVault(cfg, ident.top)) {
    writeSession(cfg, sid, { top: ident?.top ?? null, sector: null });
    return '';
  }
  entry.repo = repoHash(ident.key);
  let found = findProject(cfg, ident);
  if (!found) {
    const stay = () => {
      writeSession(cfg, sid, { top: ident.top, sector: null });
      return '';
    };
    if (isIgnored(cfg, ident)) return stay();
    if (!projectSettings(cfg).auto_add) {
      stay();
      return hintOnce(cfg, ident);
    }
    const made = await ensureProject(cfg, ident, { force: true });
    if (!made.id) return stay();
    found = { id: made.id, store: made.store, key: ident.key };
  }
  if (found.store === 'git') entry.repo = found.key;
  const g = gitState(ident.top);
  writeSession(cfg, sid, { top: ident.top, sector: found.id, store: found.store, head: g.head, dirty: g.dirty, day: todayLocal() });
  pruneSessions(cfg);
  const { renderStartView } = await import('../startview.mjs');
  const core = coreSector(cfg);
  const view = await renderStartView(cfg, { sectors: [found.id, ...(core && core !== found.id ? [core] : [])] });
  const brief = projectBrief(cfg, found.id, ident, vaultCommand(cfg), { warnings: briefWarnings(cfg), git: g });
  return `${brief}\n${view.text}`;
}

function stop(cfg, input) {
  if (!projectSettings(cfg).checkpoint || input.stop_hook_active === true || input.agent_id || input.permission_mode === 'plan') return '';
  const sid = safeId(input.session_id);
  const s = readSession(cfg, sid);
  if (!s?.sector || !s.top || !sectorExists(cfg, s.sector)) return '';
  const marker = path.join(cfg.root, '.memory-kit', 'capture', 'nudged', sid);
  if (fs.existsSync(marker)) return '';
  const g = gitState(s.top);
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
  return JSON.stringify({ decision: 'block', reason: say(cfg, 'hook.checkpoint', { handoff, cmd: vaultCommand(cfg) }) });
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
    const ident = identify(cwdOf(input));
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

function autosync(cfg, agent) {
  const t0 = performance.now();
  const cmd = vaultCommand(cfg);
  const log = (e) => logHook(cfg.root, { agent, event: 'autosync', ms: Math.round(performance.now() - t0), ...e });
  const release = takeAutosyncLock(cfg);
  if (!release) {
    log({ step: 'lock', ok: true, detail: 'another autosync is running; skipped' });
    return;
  }
  const opts = (timeout) => ({ cwd: cfg.root, encoding: 'utf8', windowsHide: true, timeout, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const git = (args) => spawnSync('git', args, opts(GIT_TIMEOUT_MS));
  const memory = (args, timeout) => spawnSync(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), ...args, '--root', cfg.root], opts(timeout));
  const fail = (step, res, fix) => log({ step, ok: false, error: lastLine(res) ?? say(cfg, 'hook.timeout', { s: Math.round((res.timeout ?? 0) / 1000) }), fix });
  try {
    const top = git(['rev-parse', '--show-cdup']);
    if (top.status !== 0 || top.stdout.trim() !== '') {
      log({ step: 'done', ok: true, detail: 'the vault is not a git repository' });
      return;
    }
    const status = git(['status', '--porcelain']);
    if (status.status !== 0) return fail('check', status, say(cfg, 'hook.fix_git', { cmd }));
    if (status.stdout.trim()) {
      const check = memory(['check', '--generate', '--lenient'], CHECK_TIMEOUT_MS);
      if (check.status !== 0) return fail('check', { ...check, timeout: CHECK_TIMEOUT_MS }, say(cfg, 'hook.fix_check', { cmd }));
      const add = git(['add', '-A']);
      if (add.status !== 0) return fail('add', { ...add, timeout: GIT_TIMEOUT_MS }, say(cfg, 'hook.fix_git', { cmd }));
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
    const sync = memory(['sync'], SYNC_TIMEOUT_MS);
    if (sync.status !== 0) {
      const pulled = String(sync.stdout ?? '').split('\n').includes(cfg.t('sync.pulled'));
      return fail(pulled ? 'push' : 'pull', { ...sync, timeout: SYNC_TIMEOUT_MS }, say(cfg, 'hook.fix_sync', { cmd }));
    }
    log({ step: 'done', ok: true });
  } catch (err) {
    log({ step: 'internal', ok: false, error: err?.message ?? String(err), fix: say(cfg, 'hook.fix_sync', { cmd }) });
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------

export async function run(argv, cfg, ctx = {}) {
  const t0 = ctx.hookStarted ?? performance.now();
  const [agent, event] = argv.filter((a) => !a.startsWith('--'));
  if (!cfg || !AGENTS.has(agent) || !EVENTS.has(event)) return 0;
  if (!projectSettings(cfg).enabled) return 0;
  if (event === 'autosync') {
    autosync(cfg, agent);
    return 0;
  }
  const entry = { agent, event, ok: true };
  try {
    const input = ctx.hookInput ?? await readHookInput();
    let out = '';
    if (event === 'session-start') out = await sessionStart(cfg, input, entry);
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
