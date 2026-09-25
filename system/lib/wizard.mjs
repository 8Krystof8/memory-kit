// The setup wizard: `node system/init.mjs` in an interactive terminal without answers (or with
// --interactive), and `node system/memory.mjs setup`. It asks init's questions one screen at a
// time (language first, then the rest in that language), shows a summary, applies the plan with
// init's own functions, offers the extras and ends with init's next steps:
//   language → where the memory lives → sectors → private folder (only when needed) → AI tools →
//   summary → confirm → apply (spinner, one line per step) → extras → next steps → outro.
// The extras menu is also what `setup` opens in a vault that is set up already: connect AI apps
// (commands/connect.mjs), memory for coding projects (installProjects of lib/hooksetup.mjs, used
// only when that version of the kit exports it) and a compact health check (doctor --json).
// A flag given to init is the answer: its question is not asked (the installers ask the mode
// themselves and pass --mode). --sectors takes presets and custom ids (a :github or :local suffix
// settles that sector's privacy); --agents all is every tool. Only a sector kept off git in mode
// github still needs a decision. Mode local is not offered while the vault has a git remote, and
// --mode local is refused then, as init refuses it. Invalid flags stop the wizard before its first
// question (exit 2; the refused --mode local exit 1). --dry-run ends it after the summary; without
// a terminal to ask in, the confirmation is No unless --yes was given. Commands to copy are
// printed outside boxes and never wrapped.
// Everything is printed through lib/tui.mjs; tests inject the UI, the client detection, the hook
// installer and the doctor runner. Ctrl+C or Esc ends the wizard with exit code 130.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cancelled, NonInteractive, TUI_DEFAULTS, createUI } from './tui.mjs';
import { findClient, findExecutable, inspectClient } from './clients.mjs';
import { vaultCommand } from './projects.mjs';
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
  'wizard.mode.local_remote': 'not here: this folder has a git remote ({remotes})',
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
  'wizard.no_terminal': 'Nothing changed: no terminal to confirm in (add --yes to apply).',
  'wizard.dry_run': 'Plan only (--dry-run), nothing changed.',
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
  'setup.projects.on_question': 'Memory for coding projects is on. What now?',
  'setup.projects.keep': 'Keep it',
  'setup.projects.keep_hint': 'check that the hooks are current',
  'setup.projects.change': 'Change the settings',
  'setup.projects.off': 'Switch it off',
  'setup.projects.off_hint': 'takes the hooks out; the notes stay',
  'setup.projects.unavailable': 'Memory for coding projects is not available in this version of memory-kit.',
  'setup.projects.skipped': 'Memory for coding projects stays off.',
  'setup.projects.auto_add': 'Add every repository automatically? (No: only projects you add)',
  'setup.projects.store_local': 'Keep project notes only on this computer? (Yes: notes of client and work repositories never reach git)',
  'setup.projects.autosync': 'Commit and push the memory at the end of each session?',
  'setup.projects.installing': 'Installing the hooks for Claude Code',
  'setup.projects.removing': 'Taking the hooks for Claude Code out',
  'setup.projects.installed': 'Hooks are in {file}',
  'setup.projects.unchanged': 'The hooks in {file} are current',
  'setup.projects.saved': 'Settings saved; the hooks in {file} are current',
  'setup.projects.removed': 'Memory for coding projects is off; the hooks are out of {file}',
  'setup.projects.absent': 'Memory for coding projects is off; {file} had no hooks of it',
  'setup.projects.kept': 'The hooks are out of {file}, but {agent} still has memory hooks for this memory, so memory for coding projects stays on',
  'setup.projects.local_root': 'Project notes stay on this computer, in {path}',
  'setup.projects.local_root_new': 'Project notes will stay on this computer, in {path} (made with the first project)',
  'setup.projects.next_session': 'Start a new Claude Code session in a code repository (in VS Code reload the window) and accept the folder trust dialog when it asks.',
  'setup.projects.next_add': 'A repository gets its memory only when you add it. Run this inside it:',
  'setup.projects.backup': 'backup of the old file: {path}',
  'setup.projects.settings': 'add repositories automatically: {auto_add} · project notes: {store} · push at session end: {autosync}',
  'setup.projects.store.local': 'this computer only',
  'setup.projects.store.git': 'in the memory repository',
  'setup.projects.not_installed': 'The hooks are not installed: {file} cannot be edited automatically',
  'setup.projects.snippet': 'Add these hooks to {file} yourself:',
  'setup.projects.failed': 'The hooks could not be installed: {detail}',
  'setup.projects.remove_failed': 'The hooks could not be taken out: {detail}',
  'setup.projects.fix': 'fix: {text}',
  'setup.projects.enabled_anyway': 'memory.json has it switched on: it works once the hooks are in place.',
  'setup.projects.disabled_anyway': 'memory.json has it switched off, so the hooks do nothing now.',
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

/** Does the vault (the top of its own git repository) have a git remote? */
const hasRemote = (root) => init.vaultRemotes(root).length > 0;

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

/** Where the memory lives. With a git remote, local is shown but cannot be chosen (init refuses it). */
async function askMode(ui, t, remotes) {
  const options = init.MODES.map((m) => (m === 'local' && remotes.length
    ? { value: m, label: m, hint: t('wizard.mode.local_remote', { remotes: remotes.join(', ') }), disabled: true }
    : { value: m, label: m, hint: t(`wizard.mode.${m}`) }));
  return ui.select({ message: t('wizard.mode.question'), options, initialValue: 'github' });
}

/**
 * The items of --sectors as { key, id, privacy }: key is the preset (a preset name or an id of any
 * pack), id a custom sector id (key null), privacy 'github' or 'local' when a suffix gave it,
 * else null. init.parseSectors has checked the flag before.
 */
function flagSectors(value, packs) {
  const items = [];
  for (const item of String(value ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, priv] = item.split(':').map((x) => x.trim());
    const key = init.findPreset(name, packs, 'en');
    const privacy = priv === undefined ? null : [...packs.keys()].map((l) => init.canonPrivacy(priv, packs, l)).find(Boolean) ?? null;
    if (!items.some((x) => (key ? x.key === key : x.id === name))) items.push({ key, id: key ? null : name, privacy });
  }
  return items;
}

/** The chosen presets as [{ key, id: null, privacy: null }] (without --sectors; with it nothing is asked). */
async function askSectors(ui, t, packs, lang) {
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
  const picked = await ui.multiselect({ message: t('wizard.sectors.question'), options, initialValues: ['core', 'work'], required: true });
  return picked.map((v) => ({ key: v, id: null, privacy: null }));
}

/** Does the sector keep its notes outside git (its suffix, else its preset's default)? */
const isLocal = (s, en) => (s.privacy ?? (s.key && en.sector_presets[s.key]?.privacy === 'local' ? 'local' : 'github')) === 'local';

/** A sector as init's --sectors item. */
const sectorItem = (s) => `${s.key ?? s.id}${s.privacy ? `:${s.privacy}` : ''}`;

/**
 * Mode github has no private folder, so sectors kept outside git (a preset that is local by
 * default and got no :github, or an explicit :local) need a decision: switch to combined (the
 * default), keep them in the repository, or leave them out. → { mode, sectors }
 */
async function settleLocalSectors(ui, t, packs, lang, mode, sectors) {
  const en = packs.get('en');
  const local = sectors.filter((s) => isLocal(s, en));
  if (mode !== 'github' || !local.length) return { mode, sectors };
  const pack = packs.get(lang);
  const titles = local.map((s) => (s.key ? pack.sector_presets?.[s.key]?.title ?? s.key : s.id)).join(', ');
  const choice = await ui.select({
    message: t('wizard.local.question', { sectors: titles }),
    options: ['combined', 'github', 'drop'].map((v) => ({ value: v, label: t(`wizard.local.${v}`) })),
    initialValue: 'combined',
  });
  if (choice === 'combined') return { mode: 'combined', sectors };
  if (choice === 'github') return { mode, sectors: sectors.map((s) => (local.includes(s) ? { ...s, privacy: 'github' } : s)) };
  return { mode, sectors: sectors.filter((s) => !local.includes(s)) };
}

async function askPrivateRoot(ui, t, root, util) {
  return ui.text({
    message: t('wizard.private.question'),
    defaultValue: init.defaultPrivateRoot(root),
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

/** The AI tools (without --agents): the ones detected here preselected, else all. */
async function askAgents(ui, t, detected) {
  const options = init.AGENTS.map((a) => ({ value: a, label: agentName(a), hint: detected.includes(a) ? t('wizard.agents.detected') : undefined }));
  const initial = detected.length ? detected : [...init.AGENTS];
  return ui.multiselect({ message: t('wizard.agents.question'), options, initialValues: initial, required: true });
}

/**
 * The flags the wizard takes as answers, checked before the first question so a wrong one is not
 * found only after all of them: an InitError (usage; --mode local with a git remote is refused,
 * as init refuses it) or null.
 */
function flagProblem(opts, packs, lang, util, { root, remotes, t }) {
  try {
    if (opts.mode !== undefined && !init.MODES.includes(opts.mode)) throw new init.InitError(2, `--mode must be one of ${init.MODES.join(', ')}`);
    if (opts.lang !== undefined && !packs.has(opts.lang)) throw new init.InitError(2, `--lang must be one of ${[...packs.keys()].join(', ')}`);
    if (opts.mode === 'local' && remotes.length) throw new init.InitError(1, t('init.refused_remote', { remotes: remotes.join(', ') }));
    // Mode combined takes every privacy; github with a local sector is asked about instead.
    if (opts.sectors !== undefined) init.parseSectors(opts.sectors, packs, lang, 'combined', util);
    if (opts.agents !== undefined) init.parseAgents(opts.agents);
    if (opts['private-root'] !== undefined) init.resolvePrivateRoot(root, opts['private-root'], { util, t });
    return null;
  } catch (err) {
    if (err instanceof init.InitError) return err;
    throw err;
  }
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

/** init's next steps on the rail; their commands unwrapped and outside any box, to copy whole. */
function nextSteps(ui, plan, t) {
  ui.step(t('wizard.next.title'));
  for (const item of init.nextStepItems(plan, t)) {
    ui.message(item.text, undefined, { bullet: true });
    for (const command of item.commands ?? []) ui.command(command);
  }
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

/** memory.json "projects" as the wizard offers it, with the safe defaults of the settings contract. */
function currentProjects(root) {
  let p = null;
  try {
    p = init.readMemoryJson(root).projects;
  } catch {
    /* no settings: everything off */
  }
  const o = p && typeof p === 'object' && !Array.isArray(p) ? p : {};
  return { enabled: o.enabled === true, auto_add: o.auto_add === true, store: o.store === 'git' ? 'git' : 'local', autosync: o.autosync === true };
}

function settingsLine(t, s) {
  const yesNo = (v) => t(v ? 'tui.yes' : 'tui.no');
  return t('setup.projects.settings', {
    auto_add: yesNo(s.auto_add), store: t(`setup.projects.store.${s.store === 'git' ? 'git' : 'local'}`), autosync: yesNo(s.autosync),
  });
}

/**
 * The questions: off → switch on? (default No); on → keep (checks the hooks), change (the current
 * answers preselected) or switch off. → null (nothing to do) or installProjects' choices: an
 * answer not asked stays undefined, so installProjects keeps the earlier one.
 */
async function projectChoices(ctx, now) {
  const { ui, t, root } = ctx;
  let choice;
  if (now.enabled) {
    ui.message(settingsLine(t, now), 'dim');
    choice = await ui.select({
      message: t('setup.projects.on_question'),
      options: [
        { value: 'keep', label: t('setup.projects.keep'), hint: t('setup.projects.keep_hint') },
        { value: 'change', label: t('setup.projects.change') },
        { value: 'off', label: t('setup.projects.off'), hint: t('setup.projects.off_hint') },
      ],
      initialValue: 'keep',
    });
  } else {
    choice = await ui.confirm({ message: t('setup.projects.question'), initialValue: false }) ? 'change' : null;
  }
  if (!choice) return null;
  if (choice === 'keep') return {};
  if (choice === 'off') return { remove: true };
  const was = now.enabled ? now : { auto_add: false, store: 'local', autosync: false };
  const choices = {
    autoAdd: await ui.confirm({ message: t('setup.projects.auto_add'), initialValue: was.auto_add }),
    store: await ui.confirm({ message: t('setup.projects.store_local'), initialValue: was.store !== 'git' }) ? 'local' : 'git',
  };
  if ((ctx.hasRemote ?? hasRemote)(root)) choices.autosync = await ui.confirm({ message: t('setup.projects.autosync'), initialValue: was.autosync });
  return choices;
}

/** What to do after an install: a new session (when the file changed) and project add (without auto add). */
function projectNextSteps(ctx, res) {
  const { ui, t, root } = ctx;
  if (res.changed) ui.message(t('setup.projects.next_session'), undefined, { bullet: true });
  if (res.settings?.auto_add !== true) {
    ui.message(t('setup.projects.next_add'), undefined, { bullet: true });
    ui.command(`${vaultCommand({ root })} project add`);
  }
}

/**
 * installProjects' outcome as it is: a refusal (thrown ProjectsRefused, or a result with ok false
 * or action refused) ends in red with its fix and is never shown as installed; a snippet (the
 * settings file cannot be edited) is printed whole, outside any box, to be copied; memory.json is
 * named when it was written anyway. A removal that another agent's hooks keep switched on says so.
 * A real install shows the file, the settings, where project notes stay, the warnings and what
 * to do next.
 */
function showProjects(ctx, spin, res, removing) {
  const { ui, t } = ctx;
  const file = res.file ?? '';
  const snippet = () => {
    if (!res.snippet) return;
    ui.message(t('setup.projects.snippet', { file }));
    ui.verbatim(String(res.snippet));
  };
  const backup = () => {
    if (res.backup) ui.message(t('setup.projects.backup', { path: res.backup }), 'dim');
  };
  if (res.ok === false || res.action === 'refused') {
    spin.stop(t(removing ? 'setup.projects.remove_failed' : 'setup.projects.failed', { detail: res.error ?? '?' }), 'error');
    if (res.fix) ui.message(t('setup.projects.fix', { text: res.fix }), 'dim');
    snippet();
    if (res.memoryChanged && !res.dryRun) ui.info(t(removing ? 'setup.projects.disabled_anyway' : 'setup.projects.enabled_anyway'));
  } else if (res.snippet) {
    spin.stop(t('setup.projects.not_installed', { file }), 'warn');
    snippet();
  } else if (removing) {
    const other = res.keptBy ? agentName(res.keptBy) : null;
    const key = other ? 'setup.projects.kept' : res.action === 'absent' || res.changed === false ? 'setup.projects.absent' : 'setup.projects.removed';
    spin.stop(t(key, { file, agent: other }), other ? 'warn' : 'ok');
    backup();
  } else {
    const key = res.changed === false ? res.memoryChanged ? 'setup.projects.saved' : 'setup.projects.unchanged' : 'setup.projects.installed';
    spin.stop(t(key, { file }));
    backup();
    if (res.settings) ui.message(settingsLine(t, res.settings), 'dim');
    if (res.settings?.store !== 'git' && res.localRoot?.path) {
      ui.message(t(res.localRoot.exists ? 'setup.projects.local_root' : 'setup.projects.local_root_new', { path: res.localRoot.path }), 'dim');
    }
  }
  for (const w of res.warnings ?? []) ui.warn(w);
  if (!removing && res.ok !== false && res.action !== 'refused' && !res.snippet) projectNextSteps(ctx, res);
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
  const choices = await projectChoices(ctx, currentProjects(root));
  if (!choices) {
    ui.info(t('setup.projects.skipped'));
    return;
  }
  const removing = choices.remove === true;
  const spin = ui.spinner();
  spin.start(t(removing ? 'setup.projects.removing' : 'setup.projects.installing'));
  let res;
  try {
    res = await mod.installProjects(root, { agent: 'claude-code', ...choices, ...ctx.hookOptions });
  } catch (err) {
    // A refusal carries its result (ProjectsRefused); anything else is a failure of its own.
    res = err?.result && typeof err.result === 'object'
      ? { ...err.result, ok: false, action: 'refused', error: err.result.error ?? err.error ?? err.message }
      : { ok: false, action: 'refused', error: err?.message ?? String(err) };
  }
  showProjects(ctx, spin, res ?? { ok: false, error: '?' }, removing);
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
 * preselected choices; today, cleanup, allow-ephemeral pass through; dry-run ends after the
 * summary; yes confirms when there is no terminal to ask in). inject (tests): ui, env, detect
 * (() => agent ids), loadHooks, hookOptions ({ env, home } for installProjects), runDoctor,
 * inspectClients, connectClient, hasRemote (for the push question), remotes ((root) => remote names).
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
  const dryRun = Boolean(opts['dry-run']);
  try {
    ui.intro('memory-kit', [readVersion(root), t('wizard.tagline')].filter(Boolean).join(` ${ui.sym.dot} `));
    if (raw.initialized === true) {
      ui.step(t('setup.already', { lang: raw.lang ?? 'en', mode: raw.mode ?? '?' }), 'info');
      applied = true;
      if (dryRun) {
        ui.outro(t('wizard.dry_run'));
        return 0;
      }
      await extrasMenu(extrasContext(root, ui, t, inject));
      ui.outro(t('setup.outro'));
      return 0;
    }
    const util = await init.kitUtil();
    const remotes = (inject.remotes ?? init.vaultRemotes)(root);
    const problem = flagProblem(opts, packs, lang, util, { root, remotes, t });
    if (problem) {
      ui.error(problem.message);
      ui.outro(t('wizard.nothing_changed'), { state: 'error' });
      return problem.exitCode;
    }

    // Only what no flag answered is asked.
    if (opts.lang === undefined) {
      lang = await askLanguage(ui, t, packs, lang);
      t = wizardTranslator(packs, lang);
      ui.setTranslator(t);
    }
    const firstMode = opts.mode ?? await askMode(ui, t, remotes);
    const chosen = opts.sectors !== undefined ? flagSectors(opts.sectors, packs) : await askSectors(ui, t, packs, lang);
    const { mode, sectors } = await settleLocalSectors(ui, t, packs, lang, firstMode, chosen);
    const en = packs.get('en');
    // As init: a private folder for mode local or combined, a local sector, or one given.
    const needsPrivate = mode !== 'github' || sectors.some((s) => isLocal(s, en)) || opts['private-root'] !== undefined;
    const privateRoot = needsPrivate ? opts['private-root'] ?? await askPrivateRoot(ui, t, root, util) : undefined;
    const detected = () => {
      try {
        return (detect ?? (() => detectAgents(root)))();
      } catch {
        return [];
      }
    };
    const agents = opts.agents !== undefined ? init.parseAgents(opts.agents) : await askAgents(ui, t, detected());

    const answers = {
      mode, lang, sectors: sectors.map(sectorItem).join(','), agents: agents.join(','), cleanup: opts.cleanup ?? 'none',
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
    if (dryRun) {
      ui.outro(t('wizard.dry_run'));
      return 0;
    }
    // Without a terminal nobody saw the answers: like init, apply them only with --yes.
    if (!await ui.confirm({ message: t('wizard.confirm'), initialValue: ui.tty ? true : Boolean(opts.yes) })) {
      ui.outro(t(ui.tty ? 'wizard.not_now' : 'wizard.no_terminal'));
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
    nextSteps(ui, plan, t);
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
 * `setup`: the extras menu in a vault that is set up (cfg.initialized), else the whole wizard
 * (opts: { yes } confirms it without a terminal). inject as for runWizard.
 */
export async function runSetup({ root, cfg, ui: givenUi, env = process.env, opts = {}, ...inject } = {}) {
  if (!cfg?.initialized) return runWizard({ root, ui: givenUi, env, opts, ...inject });
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
