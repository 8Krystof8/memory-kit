// The setup wizard: `node system/init.mjs` in an interactive terminal without answers (or with
// --interactive), and `node system/memory.mjs setup`. It asks init's questions one screen at a
// time (language first, then the rest in that language), shows a summary, applies the plan with
// init's own functions, offers the extras and ends with init's next steps:
//   language → where the memory lives → sectors → private folder (only when needed) → AI tools →
//   summary → confirm → apply (spinner, one line per step) → extras → next steps → outro.
// The extras menu is also what `setup` opens in a vault that is set up already: connect AI apps
// (commands/connect.mjs), memory for coding projects (installProjects of lib/hooksetup.mjs, used
// only when that version of the kit exports it) and a compact health check (doctor --json).
// Everything is printed through lib/tui.mjs; tests inject the UI, the client detection, the hook
// installer and the doctor runner. Ctrl+C or Esc ends the wizard with exit code 130.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cancelled, NonInteractive, TUI_DEFAULTS, createUI } from './tui.mjs';
import { findClient, findExecutable, inspectClient } from './clients.mjs';
import * as init from '../init.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MENU = ['connect', 'projects', 'doctor'];
const MAX_PROBLEMS = 3;

// English texts of the wizard and of `setup`; packs translate them under the same keys.
export const WIZARD_DEFAULTS = {
  'wizard.tagline': 'set up your memory',
  'wizard.lang.question': 'Language of the memory (folder names, note fields, messages)',
  'wizard.mode.question': 'Where should the memory live?',
  'wizard.mode.github': 'a private GitHub repository; phone and cloud agents reach it',
  'wizard.mode.local': 'only this computer; git without a remote',
  'wizard.mode.combined': 'a private GitHub repository plus a private folder here',
  'wizard.sectors.question': 'Which sectors (areas of life)?',
  'wizard.sectors.local': 'only on this computer',
  'wizard.local.question': '{sectors}: sectors usually kept off GitHub, but mode github has no private folder',
  'wizard.local.combined': 'switch to combined: keep them on this computer',
  'wizard.local.github': 'keep them in the private GitHub repository',
  'wizard.local.drop': 'leave them out',
  'wizard.private.question': 'Private folder for local sectors (outside this repository, never pushed)',
  'wizard.agents.question': 'Which AI tools will use this memory?',
  'wizard.agents.detected': 'found on this computer',
  'wizard.summary.title': 'Summary',
  'wizard.summary.agents': 'AI tools: {agents}',
  'wizard.confirm': 'Set up the memory now?',
  'wizard.not_now': 'Nothing changed. Run node system/init.mjs again when you are ready.',
  'wizard.cancelled': 'Cancelled, nothing changed.',
  'wizard.nothing_changed': 'Nothing changed.',
  'wizard.applying': 'Setting up the memory',
  'wizard.applied': 'Memory is set up',
  'wizard.apply_failed': 'Setup stopped',
  'wizard.check_failed': 'The strict check found errors',
  'wizard.next.title': 'Next steps',
  'wizard.outro': 'Done. Your memory is ready.',
  'wizard.outro_errors': 'Set up, but the strict check found errors: fix them, then run node system/memory.mjs check --generate.',
  'setup.already': 'memory-kit is set up here · language {lang} · mode {mode}',
  'setup.no_tty': 'setup asks its questions in a terminal, and this is none. Without one use: node system/init.mjs --questions, connect <client>, connect claude-code --projects, doctor.',
  'setup.menu.question': 'Anything else?',
  'setup.menu.connect': 'Connect AI apps now',
  'setup.menu.connect_hint': 'the memory as a tool in Claude Code, Cursor, VS Code and others',
  'setup.menu.projects': 'Memory for coding projects',
  'setup.menu.projects_hint': 'notes per repository, kept outside the code',
  'setup.menu.doctor': 'Health check',
  'setup.menu.doctor_hint': 'is everything installed right?',
  'setup.menu.done': 'done',
  'setup.menu.finish': 'Finish',
  'setup.outro': 'Done.',
  'setup.connect.none': 'No AI app with a settings file was found on this computer. All apps and their state: node system/memory.mjs connect --list',
  'setup.connect.question': 'Which apps should use this memory?',
  'setup.connect.nothing': 'No app chosen; connect one later with node system/memory.mjs connect <app>.',
  'setup.connect.running': 'Connecting {client}',
  'setup.connect.failed': '{client}: {detail}',
  'setup.projects.explain_1': 'Every coding project gets its own notes in this memory (brief, handoff, gotchas); nothing is written into the code repository.',
  'setup.projects.explain_2': 'Claude Code reads them when a session starts and asks for a handoff when it ends.',
  'setup.projects.question': 'Switch on memory for coding projects?',
  'setup.projects.unavailable': 'Memory for coding projects is not available in this version of memory-kit.',
  'setup.projects.skipped': 'Memory for coding projects stays off.',
  'setup.projects.auto_add': 'Add every repository automatically? (No: only projects you add)',
  'setup.projects.store_local': 'Keep project notes only on this computer? (Yes: notes of client and work repositories never reach git)',
  'setup.projects.autosync': 'Commit and push the memory at the end of each session?',
  'setup.projects.installing': 'Installing the hooks for Claude Code',
  'setup.projects.installed': 'Hooks are in {file}',
  'setup.projects.unchanged': 'The hooks in {file} are current',
  'setup.projects.backup': 'backup of the old file: {path}',
  'setup.projects.settings': 'add repositories automatically: {auto_add} · project notes: {store} · push at session end: {autosync}',
  'setup.projects.store.local': 'this computer only',
  'setup.projects.store.git': 'in the memory repository',
  'setup.projects.snippet': 'Add these hooks to {file} yourself',
  'setup.projects.failed': 'The hooks could not be installed: {detail}',
  'setup.doctor.running': 'Checking the installation',
  'setup.doctor.summary': 'Health check: {counts}',
  'setup.doctor.more': '{n} more: node system/memory.mjs doctor',
  'setup.doctor.failed': 'doctor could not run: {detail}',
};

function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
}

/** t(key, vars) for a language: the packs (init's translator), then the English defaults here. */
export function wizardTranslator(packs, lang) {
  const base = init.translator(packs, lang);
  return (key, vars) => {
    const text = base(key, vars);
    if (text !== key) return text;
    return interpolate(WIZARD_DEFAULTS[key] ?? TUI_DEFAULTS[key] ?? key, vars);
  };
}

/** The language to ask in first: LC_ALL / LC_MESSAGES / LANG, then the system locale; en otherwise. */
export function guessLang(env, packs) {
  const pick = (value) => {
    const code = String(value ?? '').toLowerCase().match(/^[a-z]{2,3}/)?.[0];
    return code && packs.has(code) ? code : null;
  };
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const value = env?.[name];
    if (value && value !== 'C' && value !== 'POSIX') return pick(value) ?? 'en';
  }
  try {
    return pick(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en';
  } catch {
    return 'en';
  }
}

function readVersion(root) {
  try {
    return fs.readFileSync(path.join(root, 'system', 'VERSION'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const agentName = (id) => findClient(id)?.name ?? id;

/** The agents of init whose app is installed here (a settings file or the command-line tool). */
export function detectAgents(root) {
  const found = [];
  for (const id of init.AGENTS) {
    const row = findClient(id);
    if (!row || row.guide) continue;
    try {
      const cli = row.cli ? findExecutable(row.cli) : null;
      if (inspectClient(id, { vault: root, cli }).appFound) found.push(id);
    } catch {
      /* an unreadable config says nothing about the app */
    }
  }
  return found;
}

/** Does the vault have a git remote? */
function hasRemote(root) {
  try {
    const res = spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8', windowsHide: true });
    return res.status === 0 && res.stdout.trim() !== '';
  } catch {
    return false;
  }
}

/** doctor --json of the vault's own CLI, without blocking (the spinner keeps turning). */
export function runDoctorJson(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'system', 'memory.mjs'), 'doctor', '--json', '--root', root], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      try {
        const report = JSON.parse(text);
        if (!report?.summary || !Array.isArray(report.checks)) throw new Error('no report');
        resolve(report);
      } catch {
        const detail = Buffer.concat(err).toString('utf8').trim().split('\n')[0] || `exit ${code}`;
        reject(new Error(detail));
      }
    });
  });
}

const loadHooksModule = () => import(pathToFileURL(path.join(HERE, 'hooksetup.mjs')).href);

// ---------------------------------------------------------------------------------------------
// The questions

async function askLanguage(ui, t, packs, initial) {
  const options = [...packs].map(([code, pack]) => ({ value: code, label: pack.name ?? code, hint: code }));
  return ui.select({ message: t('wizard.lang.question'), options, initialValue: initial });
}

async function askMode(ui, t, initial) {
  const options = init.MODES.map((m) => ({ value: m, label: m, hint: t(`wizard.mode.${m}`) }));
  return ui.select({ message: t('wizard.mode.question'), options, initialValue: init.MODES.includes(initial) ? initial : 'github' });
}

/** Preset keys from --sectors (preset names or ids of any pack); null when none matches. */
function presetsFrom(value, packs) {
  if (!value) return null;
  const keys = new Set();
  for (const item of String(value).split(',').map((s) => s.split(':')[0].trim()).filter(Boolean)) {
    for (const pack of packs.values()) {
      for (const [key, p] of init.presetEntries(pack)) if (key === item || p.id === item) keys.add(key);
    }
  }
  return keys.size ? [...keys] : null;
}

async function askSectors(ui, t, packs, lang, opts) {
  const dot = ` ${ui.sym.dot} `;
  const en = packs.get('en');
  const pack = packs.get(lang);
  const options = init.presetEntries(en).map(([key]) => {
    const p = pack.sector_presets?.[key] ?? en.sector_presets[key];
    const tags = [p.id];
    if (key === 'core') tags.push(t('tui.locked'));
    else if (p.privacy === 'local') tags.push(t('wizard.sectors.local'));
    return { value: key, label: p.title ?? key, hint: tags.join(dot), locked: key === 'core' };
  });
  const initial = presetsFrom(opts.sectors, packs) ?? ['core', 'work'];
  return ui.multiselect({ message: t('wizard.sectors.question'), options, initialValues: initial, required: true });
}

/**
 * Mode github has no private folder, so presets that are local by default need a decision:
 * switch to combined (the default), keep them in the repository, or leave them out.
 * → { mode, sectors: [preset or preset:github] }
 */
async function settleLocalPresets(ui, t, packs, lang, mode, keys) {
  const en = packs.get('en');
  const local = keys.filter((k) => en.sector_presets[k]?.privacy === 'local');
  if (mode !== 'github' || !local.length) return { mode, sectors: keys };
  const pack = packs.get(lang);
  const titles = local.map((k) => pack.sector_presets?.[k]?.title ?? k).join(', ');
  const choice = await ui.select({
    message: t('wizard.local.question', { sectors: titles }),
    options: ['combined', 'github', 'drop'].map((v) => ({ value: v, label: t(`wizard.local.${v}`) })),
    initialValue: 'combined',
  });
  if (choice === 'combined') return { mode: 'combined', sectors: keys };
  if (choice === 'github') return { mode, sectors: keys.map((k) => (local.includes(k) ? `${k}:github` : k)) };
  return { mode, sectors: keys.filter((k) => !local.includes(k)) };
}

async function askPrivateRoot(ui, t, root, util, initial) {
  return ui.text({
    message: t('wizard.private.question'),
    defaultValue: initial ?? init.defaultPrivateRoot(root),
    validate: (value) => {
      try {
        init.resolvePrivateRoot(root, value, { util, t });
        return undefined;
      } catch (err) {
        return err.message;
      }
    },
  });
}

async function askAgents(ui, t, detected, given) {
  const fromFlag = given && given.trim() !== 'all'
    ? given.split(',').map((s) => s.trim()).filter((a) => init.AGENTS.includes(a))
    : null;
  const options = init.AGENTS.map((a) => ({ value: a, label: agentName(a), hint: detected.includes(a) ? t('wizard.agents.detected') : undefined }));
  const initial = fromFlag?.length ? fromFlag : detected.length ? detected : [...init.AGENTS];
  return ui.multiselect({ message: t('wizard.agents.question'), options, initialValues: initial, required: true });
}

function summaryLines(plan, t, bullet) {
  const sectors = plan.sectors.map((s) => `${s.id} (${plan.toPack.privacy?.[s.privacy] ?? s.privacy})`).join(', ');
  const lines = [
    t('init.plan.language', { lang: plan.lang, name: plan.toPack.name ?? plan.lang }),
    t('init.plan.mode', { mode: plan.mode }),
    t('init.plan.sectors', { sectors }),
  ];
  if (plan.privateRoot) lines.push(t('init.plan.private_root', { path: plan.privateRoot.stored }));
  lines.push(t('wizard.summary.agents', { agents: plan.agents.map(agentName).join(', ') }));
  lines.push(t(plan.gitInit ? 'init.plan.git_init' : plan.git ? 'init.plan.git_hooks' : 'init.plan.no_git'));
  for (const s of plan.sectors.filter((x) => x.custom)) lines.push(t('init.plan.custom', { id: s.id }));
  return lines.map((text) => ({ text, bullet }));
}

// ---------------------------------------------------------------------------------------------
// Apply

/** init's apply with its output collected: { result, lines, blocks, warnings }. */
async function applyPlan(plan, packs) {
  const lines = [];
  const blocks = [];
  const warnings = [];
  const out = {
    line: (s) => lines.push(s),
    block: (s) => blocks.push(s),
    warn: (s) => warnings.push(s),
    lines,
    warnings,
  };
  const result = await init.apply(plan, packs, out);
  return { result, lines, blocks, warnings };
}

function nextStepsNote(ui, plan, t) {
  const body = [];
  for (const item of init.nextStepItems(plan, t)) {
    body.push({ text: item.text, bullet: ui.sym.bullet });
    for (const command of item.commands ?? []) body.push({ text: command, indent: 4, tone: 'accent' });
  }
  ui.note(body, t('wizard.next.title'));
}

// ---------------------------------------------------------------------------------------------
// Extras

async function connectApps(ctx) {
  const { ui, t, root } = ctx;
  const connect = await import(pathToFileURL(path.join(HERE, 'commands', 'connect.mjs')).href);
  const rows = (ctx.inspectClients ?? ((vault) => connect.listClients({ vault }).clients))(root);
  const found = rows.filter((r) => !r.guide && r.appFound);
  if (!found.length) {
    ui.info(t('setup.connect.none'));
    return;
  }
  const cfg = await ctx.config();
  const options = found.map((r) => ({ value: r.id, label: r.name, hint: connect.say(cfg, `connect.state.${r.state}`) }));
  const initial = ui.tty ? found.filter((r) => r.state !== 'connected').map((r) => r.id) : [];
  const picked = await ui.multiselect({ message: t('setup.connect.question'), options, initialValues: initial });
  if (!picked.length) {
    ui.info(t('setup.connect.nothing'));
    return;
  }
  const run = ctx.connectClient ?? connect.connectClient;
  for (const id of picked) {
    const name = found.find((r) => r.id === id)?.name ?? id;
    const spin = ui.spinner();
    spin.start(t('setup.connect.running', { client: name }));
    let res;
    try {
      res = await run({ client: id, vault: root });
    } catch (err) {
      spin.stop(t('setup.connect.failed', { client: name, detail: err?.message ?? String(err) }), 'error');
      continue;
    }
    const lines = connect.renderResult(res, cfg);
    spin.stop(lines[0] ?? name, res.ok ? 'ok' : 'error');
    for (const line of lines.slice(1)) ui.message(line, 'dim');
  }
}

async function codingProjects(ctx) {
  const { ui, t, root } = ctx;
  ui.message(t('setup.projects.explain_1'), 'dim');
  ui.message(t('setup.projects.explain_2'), 'dim');
  let mod = null;
  try {
    mod = await (ctx.loadHooks ?? loadHooksModule)();
  } catch {
    mod = null;
  }
  if (typeof mod?.installProjects !== 'function') {
    ui.warn(t('setup.projects.unavailable'));
    return;
  }
  if (!await ui.confirm({ message: t('setup.projects.question'), initialValue: false })) {
    ui.info(t('setup.projects.skipped'));
    return;
  }
  const autoAdd = await ui.confirm({ message: t('setup.projects.auto_add'), initialValue: false });
  const store = await ui.confirm({ message: t('setup.projects.store_local'), initialValue: true }) ? 'local' : 'git';
  const autosync = (ctx.hasRemote ?? hasRemote)(root)
    ? await ui.confirm({ message: t('setup.projects.autosync'), initialValue: false })
    : false;
  const spin = ui.spinner();
  spin.start(t('setup.projects.installing'));
  let res;
  try {
    res = await mod.installProjects(root, { agent: 'claude-code', autoAdd, store, autosync, ...ctx.hookOptions });
  } catch (err) {
    spin.stop(t('setup.projects.failed', { detail: err?.message ?? String(err) }), 'error');
    return;
  }
  const file = res?.file ?? '';
  spin.stop(t(res?.changed === false ? 'setup.projects.unchanged' : 'setup.projects.installed', { file }));
  if (res?.backup) ui.message(t('setup.projects.backup', { path: res.backup }), 'dim');
  const s = res?.settings ?? { auto_add: autoAdd, store, autosync };
  const yesNo = (v) => t(v ? 'tui.yes' : 'tui.no');
  ui.message(t('setup.projects.settings', {
    auto_add: yesNo(s.auto_add), store: t(`setup.projects.store.${s.store === 'git' ? 'git' : 'local'}`), autosync: yesNo(s.autosync),
  }), 'dim');
  for (const w of res?.warnings ?? []) ui.warn(w);
  if (res?.snippet) ui.note(String(res.snippet).split('\n'), t('setup.projects.snippet', { file }), { state: 'warn' });
}

async function healthCheck(ctx) {
  const { ui, t, root } = ctx;
  const spin = ui.spinner();
  spin.start(t('setup.doctor.running'));
  let report;
  try {
    report = await (ctx.runDoctor ?? runDoctorJson)(root);
  } catch (err) {
    spin.stop(t('setup.doctor.failed', { detail: err?.message ?? String(err) }), 'error');
    return;
  }
  const { ok = 0, warn = 0, fail = 0 } = report.summary;
  // The marks of doctor's own report: ✓ ok, ! warning, ✗ failed.
  const counts = `${ui.sym.success} ${ok}  ! ${warn}  ${ui.sym.fail} ${fail}`;
  spin.stop(t('setup.doctor.summary', { counts }), fail ? 'error' : warn ? 'warn' : 'ok');
  const problems = [...report.checks.filter((c) => c.status === 'fail'), ...report.checks.filter((c) => c.status === 'warn')];
  for (const c of problems.slice(0, MAX_PROBLEMS)) (c.status === 'fail' ? ui.error : ui.warn)(`${c.id}: ${c.message}`);
  if (problems.length > MAX_PROBLEMS) ui.message(t('setup.doctor.more', { n: problems.length - MAX_PROBLEMS }), 'dim');
}

const ACTIONS = { connect: connectApps, projects: codingProjects, doctor: healthCheck };

/** The extras menu, until Finish. Without a terminal it finishes at once. */
async function extrasMenu(ctx) {
  const { ui, t } = ctx;
  const done = new Set();
  for (;;) {
    const options = [
      ...MENU.map((id) => ({ value: id, label: t(`setup.menu.${id}`), hint: done.has(id) ? `${ui.sym.success} ${t('setup.menu.done')}` : t(`setup.menu.${id}_hint`) })),
      { value: 'finish', label: t('setup.menu.finish') },
    ];
    const next = ui.tty ? MENU.find((id) => !done.has(id)) ?? 'finish' : 'finish';
    const choice = await ui.select({ message: t('setup.menu.question'), options, initialValue: next });
    if (choice === 'finish') return;
    await ACTIONS[choice](ctx);
    done.add(choice);
  }
}

function extrasContext(root, ui, t, inject) {
  let cfg = null;
  return {
    root, ui, t, ...inject,
    config: async () => {
      if (cfg) return cfg;
      if (inject.cfg) return (cfg = inject.cfg);
      const { loadConfig } = await import(pathToFileURL(path.join(HERE, 'config.mjs')).href);
      cfg = loadConfig(root);
      return cfg;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Entry points

/**
 * The wizard for the vault at root. opts are init's options (answers given as flags become the
 * preselected choices; today, allow-ephemeral pass through). inject (tests): ui, env, detect
 * (() => agent ids), loadHooks, hookOptions ({ env, home } for installProjects), runDoctor,
 * inspectClients, connectClient, hasRemote.
 * → exit code (0 ok, 1 refused or check errors, 2 usage, 130 cancelled).
 */
export async function runWizard({ root, opts = {}, ui: givenUi, env = process.env, detect, ...inject } = {}) {
  const ui = givenUi ?? createUI({ env });
  const packs = init.loadPacks(root);
  const raw = init.readMemoryJson(root);
  let lang = packs.has(opts.lang) ? opts.lang : packs.has(raw.lang) && raw.initialized === true ? raw.lang : guessLang(env, packs);
  let t = wizardTranslator(packs, lang);
  ui.setTranslator(t);
  let applied = false;
  try {
    ui.intro('memory-kit', [readVersion(root), t('wizard.tagline')].filter(Boolean).join(` ${ui.sym.dot} `));
    if (raw.initialized === true) {
      ui.step(t('setup.already', { lang: raw.lang ?? 'en', mode: raw.mode ?? '?' }), 'info');
      applied = true;
      await extrasMenu(extrasContext(root, ui, t, inject));
      ui.outro(t('setup.outro'));
      return 0;
    }

    lang = await askLanguage(ui, t, packs, lang);
    t = wizardTranslator(packs, lang);
    ui.setTranslator(t);
    const firstMode = await askMode(ui, t, opts.mode);
    const keys = await askSectors(ui, t, packs, lang, opts);
    const { mode, sectors } = await settleLocalPresets(ui, t, packs, lang, firstMode, keys);
    const util = await init.kitUtil();
    const en = packs.get('en');
    const needsPrivate = mode !== 'github' || sectors.some((s) => !s.endsWith(':github') && en.sector_presets[s]?.privacy === 'local');
    const privateRoot = needsPrivate ? await askPrivateRoot(ui, t, root, util, opts['private-root']) : undefined;
    const detected = (() => {
      try {
        return (detect ?? (() => detectAgents(root)))();
      } catch {
        return [];
      }
    })();
    const agents = await askAgents(ui, t, detected, opts.agents);

    const answers = {
      mode, lang, sectors: sectors.join(','), agents: agents.join(','), cleanup: 'none',
      ...(privateRoot !== undefined ? { 'private-root': privateRoot } : {}),
      ...(opts.today !== undefined ? { today: opts.today } : {}),
      ...(opts['allow-ephemeral'] ? { 'allow-ephemeral': true } : {}),
    };
    let plan;
    try {
      plan = init.buildPlan(root, raw, answers, packs, util);
    } catch (err) {
      if (!(err instanceof init.InitError)) throw err;
      ui.error(err.message);
      ui.outro(t('wizard.nothing_changed'), { state: 'error' });
      return err.exitCode;
    }
    ui.note(summaryLines(plan, t, ui.sym.bullet), t('wizard.summary.title'));
    if (!await ui.confirm({ message: t('wizard.confirm'), initialValue: true })) {
      ui.outro(t('wizard.not_now'));
      return 0;
    }

    const spin = ui.spinner();
    spin.start(t('wizard.applying'));
    let res;
    try {
      res = await applyPlan(plan, packs);
    } catch (err) {
      spin.stop(t('wizard.apply_failed'), 'error');
      if (err instanceof init.InitError || err?.code === 'SECTOR' || err?.name === 'SectorError') {
        ui.error(err.message);
        ui.outro(t('wizard.apply_failed'), { state: 'error' });
        return err.exitCode ?? 1;
      }
      throw err;
    }
    applied = true;
    const ok = res.result.errors.length === 0;
    spin.stop(t('wizard.applied'), ok ? 'ok' : 'warn');
    for (const line of res.lines) ui.success(line);
    for (const w of res.warnings) ui.warn(w);
    if (!ok) {
      ui.warn(t('wizard.check_failed'));
      for (const block of res.blocks) for (const line of block.split('\n').filter(Boolean)) ui.message(line, 'dim');
    }

    await extrasMenu(extrasContext(root, ui, t, inject));
    nextStepsNote(ui, plan, t);
    ui.outro(ok ? t('wizard.outro') : t('wizard.outro_errors'), { state: ok ? 'ok' : 'warn' });
    return ok ? 0 : 1;
  } catch (err) {
    if (err instanceof Cancelled) {
      ui.cancelled(t(applied ? 'tui.cancelled' : 'wizard.cancelled'));
      return 130;
    }
    if (err instanceof NonInteractive) {
      ui.error(err.message);
      return 2;
    }
    ui.close();
    throw err;
  }
}

/**
 * `setup`: the extras menu in a vault that is set up (cfg.initialized), else the whole wizard.
 * inject as for runWizard.
 */
export async function runSetup({ root, cfg, ui: givenUi, env = process.env, ...inject } = {}) {
  if (!cfg?.initialized) return runWizard({ root, ui: givenUi, env, ...inject });
  const ui = givenUi ?? createUI({ env });
  const packs = init.loadPacks(root);
  const t = wizardTranslator(packs, packs.has(cfg.lang) ? cfg.lang : 'en');
  ui.setTranslator(t);
  try {
    ui.intro('memory-kit', [readVersion(root), t('wizard.tagline')].filter(Boolean).join(` ${ui.sym.dot} `));
    ui.step(t('setup.already', { lang: cfg.lang, mode: cfg.mode }), 'info');
    await extrasMenu(extrasContext(root, ui, t, { cfg, ...inject }));
    ui.outro(t('setup.outro'));
    return 0;
  } catch (err) {
    if (err instanceof Cancelled) {
      ui.cancelled(t('tui.cancelled'));
      return 130;
    }
    ui.close();
    throw err;
  }
}
