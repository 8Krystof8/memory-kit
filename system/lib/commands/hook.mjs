// `hook <agent> <event>`: what Claude Code and Codex run through their hooks (connect --projects
// installs them). Reads the hook's JSON from stdin, never fails a session (always exit 0) and never
// writes into the code repository. Events:
//   session-start  find the project of the folder, create its dev sector on first use, print the
//                  project brief and the start view narrowed to the project and the core sector
//   stop           once per session, when the code changed and the handoff did not: ask the agent
//                  to record handoff, gotchas and dead ends (no extra model call, the agent runs anyway)
//   tool-failure   (Claude Code) look the error up in the project's gotchas and dead ends
//   session-end    commit and push the vault in the background when projects.autosync is on
//   autosync       the background part of session-end

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { identify, ensureProject, sectorFor, projectBrief, projectSettings, gitState, lookupError, noteRel } from '../projects.mjs';
import { writeAtomic } from '../fsafe.mjs';
import { todayLocal } from '../util.mjs';

export const usage = 'hook <claude-code|codex> <session-start|stop|tool-failure|session-end>';

const AGENTS = new Set(['claude-code', 'codex']);
const MAX_INPUT = 1024 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  let size = 0;
  for await (const c of process.stdin) {
    size += c.length;
    if (size > MAX_INPUT) break;
    chunks.push(c);
  }
  try {
    const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

const quote = (p) => (/[\s"'&()]/.test(p) ? `"${p}"` : p);
const stateDir = (cfg) => path.join(cfg.root, '.memory-kit', 'capture');
const safeId = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);

function coreSector(cfg) {
  const parts = String(cfg.raw?.profile ?? '').split('/');
  return parts.length >= 3 ? parts[1] : null;
}

async function sessionStart(cfg, input) {
  const { renderStartView } = await import('../startview.mjs');
  const cwd = input.cwd || process.cwd();
  const ident = identify(cwd);
  // Inside the vault itself (or outside any project): the ordinary start.
  if (!ident || path.resolve(ident.top) === path.resolve(cfg.root)) {
    const v = await renderStartView(cfg, {});
    return v.text;
  }
  const { id } = await ensureProject(cfg, ident);
  if (!id) {
    const v = await renderStartView(cfg, {});
    return v.text;
  }
  const sid = safeId(input.session_id);
  if (sid) {
    const g = gitState(ident.top);
    writeAtomic(path.join(stateDir(cfg), 'sessions', `${sid}.json`), JSON.stringify({ top: ident.top, sector: id, head: g.head, dirty: g.dirty, day: todayLocal() }));
  }
  const vaultCmd = `node ${quote(path.join(cfg.root, 'system', 'memory.mjs'))}`;
  const core = coreSector(cfg);
  const view = await renderStartView(cfg, { sectors: [id, ...(core && core !== id ? [core] : [])] });
  return `${projectBrief(cfg, id, ident, vaultCmd)}\n${view.text}`;
}

function stop(cfg, input, agent) {
  const set = projectSettings(cfg);
  if (!set.checkpoint || input.stop_hook_active !== false || input.agent_id || input.permission_mode === 'plan') return '';
  const sid = safeId(input.session_id);
  if (!sid) return '';
  const marker = path.join(stateDir(cfg), 'nudged', sid);
  if (fs.existsSync(marker)) return '';
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(stateDir(cfg), 'sessions', `${sid}.json`), 'utf8')); } catch { return ''; }
  const g = gitState(s.top);
  const changed = (g.head && g.head !== s.head) || g.dirty !== s.dirty;
  if (!changed) return '';
  // The agent already updated the handoff today: nothing to ask.
  try {
    const handoff = fs.readFileSync(path.join(cfg.root, ...noteRel(cfg, s.sector, 'handoff').split('/')), 'utf8');
    if (new RegExp(`^${cfg.keys.updated}: ${todayLocal()}$`, 'm').test(handoff) && fs.statSync(path.join(cfg.root, ...noteRel(cfg, s.sector, 'handoff').split('/'))).mtimeMs > fs.statSync(path.join(stateDir(cfg), 'sessions', `${sid}.json`)).mtimeMs) return '';
  } catch { /* no handoff note */ }
  writeAtomic(marker, todayLocal());
  const vaultCmd = `node ${quote(path.join(cfg.root, 'system', 'memory.mjs'))}`;
  const rel = (role) => path.join(cfg.root, ...noteRel(cfg, s.sector, role).split('/'));
  const reason = cfg.lang === 'cs'
    ? `Paměť projektu: v této session se změnil kód a předávka zatím ne. Než skončíš, stručně zapiš do paměti: 1) přepiš ${rel('handoff')} (hotovo, další kroky, otevřené otázky, větev); 2) opravené chyby jako pasti: ${vaultCmd} remember --type gotcha "příznak → příčina → oprava"; 3) co nefungovalo: --type dead-end; 4) nová rozhodnutí: --type decision. Nic nevymýšlej, jen co se opravdu stalo. Pak skonči.`
    : `Project memory: the code changed in this session and the handoff did not. Before you finish, record briefly: 1) rewrite ${rel('handoff')} (done, next steps, open questions, branch); 2) errors you fixed as gotchas: ${vaultCmd} remember --type gotcha "symptom → cause → fix"; 3) what did not work: --type dead-end; 4) new decisions: --type decision. Only what really happened. Then finish.`;
  return JSON.stringify({ decision: 'block', reason });
}

function toolFailure(cfg, input) {
  if (!projectSettings(cfg).error_lookup) return '';
  const ident = identify(input.cwd || process.cwd());
  const sector = sectorFor(cfg, ident);
  if (!sector) return '';
  const raw = [input.error, input.tool_response, input.tool_output].map((x) => (typeof x === 'string' ? x : x ? JSON.stringify(x) : '')).join('\n');
  const hits = lookupError(cfg, sector, raw);
  if (!hits.length) return '';
  const head = cfg.lang === 'cs' ? 'Paměť projektu: podobná chyba tu už byla:' : 'Project memory: a similar error was met before:';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: [head, ...hits.map((h) => h.line)].join('\n') } });
}

function sessionEnd(cfg) {
  if (!projectSettings(cfg).autosync) return;
  const child = spawn(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), 'hook', 'claude-code', 'autosync', '--root', cfg.root], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();
}

function autosync(cfg) {
  const git = (args) => spawnSync('git', args, { cwd: cfg.root, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (git(['rev-parse', '--show-cdup']).stdout?.trim() !== '') return;
  if (!git(['status', '--porcelain']).stdout?.trim()) return;
  spawnSync(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), 'check', '--generate', '--lenient', '--root', cfg.root], { cwd: cfg.root, windowsHide: true, stdio: 'ignore', timeout: 60000 });
  git(['add', '-A']);
  const c = git(['commit', '-q', '-m', cfg.lang === 'cs' ? `Paměť: session ${todayLocal()}` : `Memory: session ${todayLocal()}`]);
  if (c.status !== 0) return;
  spawnSync(process.execPath, [path.join(cfg.root, 'system', 'memory.mjs'), 'sync', '--root', cfg.root], { cwd: cfg.root, windowsHide: true, stdio: 'ignore', timeout: 120000 });
}

export async function run(argv, cfg) {
  try {
    const [agent, event] = argv.filter((a) => !a.startsWith('--'));
    if (!cfg || !AGENTS.has(agent)) return 0;
    const input = event === 'autosync' ? {} : await readStdin();
    let out = '';
    if (event === 'session-start') out = await sessionStart(cfg, input);
    else if (event === 'stop') out = stop(cfg, input, agent);
    else if (event === 'tool-failure') out = toolFailure(cfg, input);
    else if (event === 'session-end') sessionEnd(cfg);
    else if (event === 'autosync') autosync(cfg);
    if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
  } catch (err) {
    if (process.env.MEMORY_DEBUG) process.stderr.write(`memory hook: ${err?.stack ?? err}\n`);
  }
  return 0;
}
