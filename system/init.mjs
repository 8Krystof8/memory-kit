#!/usr/bin/env node
// memory-kit setup (docs/architecture.md, section 14). The agent asks the user the questions,
// then runs init with the answers:
//
//   node system/init.mjs --questions [--json]
//   node system/init.mjs --mode github|local|combined --lang <code> --sectors <list>
//                        [--private-root <path>] [--agents <list>] [--cleanup none]
//                        [--allow-ephemeral] [--today YYYY-MM-DD] [--dry-run] [--yes] [--json]
//                        [--root <path>]
//   node system/init.mjs [--interactive | --no-interactive]
//
// In an interactive terminal without answers, init opens the setup wizard (lib/wizard.mjs),
// which asks the same questions one screen at a time and applies them with the functions
// exported here; --interactive forces it, --no-interactive keeps the plain behaviour. Without a
// terminal nothing changes: the output below stays byte for byte.
// Without --yes init only prints its plan. Every step is idempotent, so a run that stopped half
// way can simply be repeated with the same answers. Exit codes: 0 ok, 1 refused or check errors,
// 2 usage (missing or invalid answers), 3 internal error.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODES = ['github', 'local', 'combined'];
const AGENTS = ['claude-code', 'codex', 'gemini-cli', 'cursor', 'chatgpt', 'claude-app'];
const DIR_ROLES = ['sectors', 'inbox', 'journal', 'archive', 'attachments'];
const FILE_ROLES = ['home', 'state', 'waiting'];
const HAND_FILES = ['state', 'waiting']; // home is generated (docs/architecture.md, 8.8)
const KEEP_EMPTY = ['inbox', 'journal', 'archive', 'attachments'];
const PRIVATE_ROOT_ID = 'private';
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECTOR_ID_MAX = 24;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KIT_START = '<!-- kit:start';
const KIT_END = '<!-- kit:end -->';

const OPTIONS = {
  questions: { type: 'boolean' },
  mode: { type: 'string' },
  lang: { type: 'string' },
  sectors: { type: 'string' },
  'private-root': { type: 'string' },
  agents: { type: 'string' },
  cleanup: { type: 'string' },
  'allow-ephemeral': { type: 'boolean' },
  today: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  json: { type: 'boolean' },
  root: { type: 'string' },
  interactive: { type: 'boolean' },
  'no-interactive': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const USAGE = [
  'usage:',
  '  node system/init.mjs --questions [--json]',
  '  node system/init.mjs --mode github|local|combined --lang <code> --sectors <list>',
  '                       [--private-root <path>] [--agents <list>] [--cleanup none]',
  '                       [--allow-ephemeral] [--today YYYY-MM-DD] [--dry-run] [--yes] [--json] [--root <path>]',
  '  node system/init.mjs [--interactive | --no-interactive] [--root <path>]',
  '--interactive: the setup wizard (the default in a terminal when answers are missing); --no-interactive: never.',
  '--sectors: presets or ids, each optionally :github or :local (core,work,family:local).',
  '--private-root: relative to the vault root or absolute; must be outside the repository.',
  '--allow-ephemeral: set up local content in a cloud session anyway (it is lost when the session ends).',
].join('\n');

// English texts of every init message. Packs translate them under the same keys (init.*).
const INIT_DEFAULTS = {
  'init.question.mode': 'Where should the memory live? github = a private GitHub repository (your phone and cloud agents can reach it) · local = only this computer (git without a remote) · combined = a private GitHub repository plus a private folder on this computer for sensitive sectors.',
  'init.question.lang': 'Language of folder names, note fields and messages? Choices: {choices}. Code and commands stay English. Switching later means renaming by hand.',
  'init.question.sectors': 'Which sectors (areas of life)? Presets: {presets}. core is always included. Add :local to keep a sector\'s content outside git, or :github to allow it in the repository.',
  'init.question.private_root': 'Where should the private folder for local sectors be? It must be outside this repository and is never pushed.',
  'init.question.agents': 'Which AI tools will use this memory? Choices: {choices}, or all. Every adapter is installed anyway; this only tailors the next steps.',
  'init.question.cleanup': 'Nightly cleanup by a model is not available yet (roadmap). The answer is none.',
  'init.questions.intro': 'Ask the user these questions in one message, in their language (defaults in brackets). Never guess answers. Then run:',
  'init.questions.ask_if': 'ask only if {condition}',
  'init.questions.private_condition': 'a sector is local or the mode is local or combined',
  'init.missing': 'missing {flags}: ask the user (questions below), then run init again',
  'init.refused_initialized': 'refused: memory is already set up (memory.json "initialized": true)',
  'init.plan.title': 'Plan:',
  'init.plan.language': 'language: {lang} ({name})',
  'init.plan.mode': 'mode: {mode}',
  'init.plan.sectors': 'sectors: {sectors}',
  'init.plan.private_root': 'private folder for local sectors: {path} (created if missing; never pushed)',
  'init.plan.rename': 'rename: {moves}',
  'init.plan.write': 'write: {files}',
  'init.plan.generate': 'then: generate _ai/ and .ignore, run check --strict',
  'init.plan.git_init': 'git: init a local repository (branch main), hooks path .githooks',
  'init.plan.git_hooks': 'git: hooks path .githooks',
  'init.plan.no_git': 'git: not a git repository; the pre-commit hook starts working after git init',
  'init.plan.custom': 'note: {id} is not a preset; fill in its manifest (description, when_here, not_here, keywords)',
  'init.dry_run': 'Nothing changed. Run again with --yes to apply.',
  'init.renamed': 'renamed: {moves}',
  'init.wrote': 'wrote: {files}',
  'init.sector_skipped': 'sector {id} already exists, kept',
  'init.done': 'Memory is set up · language {lang} · mode {mode} · sectors {sectors}',
  'init.check_failed': 'check --strict found errors (above). Fix them, then run node system/memory.mjs check --generate.',
  'init.next.title': 'Next steps:',
  'init.next.profile': 'Fill in your profile: {rel}. Its lead (the > lines) goes into every session start.',
  'init.next.commit_steps': 'Commit now, one command at a time:',
  'init.next.commit_message': 'Set up memory',
  'init.next.github': 'Push to a PRIVATE GitHub repository. On the phone: the GitHub app or any markdown and git app (docs/phone.md).',
  'init.next.local': 'Everything stays on this computer: no remote, no GitHub Actions.',
  'init.next.combined': 'The private folder for local sectors is {path}. Back it up; never put it in a git remote.',
  'init.private_readme': '# Private memory root\n\nLocal sectors of the memory in {root} keep their notes here, under {sectors}/<id>/.\nThis folder is not a git repository and must never be pushed anywhere. Back it up yourself.',
  'init.next.no_git': 'Not a git repository yet: run git init -b main, then git config core.hooksPath .githooks.',
  'init.next.claude-code': 'Claude Code: CLAUDE.md and the SessionStart hook load the memory; broad questions go to the memory-searcher subagent.',
  'init.next.codex': 'Codex: reads AGENTS.md, which tells it to run node system/memory.mjs start first; the skill is in .agents/skills/memory/.',
  'init.next.gemini-cli': 'Gemini CLI: reads GEMINI.md, which imports AGENTS.md (it runs node system/memory.mjs start first).',
  'init.next.cursor': 'Cursor: reads AGENTS.md, which tells it to run node system/memory.mjs start first.',
  'init.next.chatgpt': 'ChatGPT: connect the GitHub app (read-only) and paste _ai/profile.md into custom instructions.',
  'init.next.chatgpt_local': 'ChatGPT cannot see a vault that never leaves this computer; paste _ai/profile.md into custom instructions.',
  'init.refused_remote': 'refused: mode local promises that nothing leaves this computer, but this repository has a remote ({remotes}). Remove it (git remote remove <name>) or choose --mode github or combined.',
  'init.refused_cloud': 'refused: this looks like a cloud session ({signal}). A private folder or a local-only vault there is lost when the session ends. Here choose --mode github without local sectors; add local sectors later on your own computer (docs/modes.md). Pass --allow-ephemeral only for a throwaway test.',
  'init.github_local_sector': '--sectors: {id} keeps its notes outside git by default, which --mode github cannot do. Ask the user: --mode combined keeps it on this computer; {id}:github keeps it in the private GitHub repository.',
  'init.next.claude-app': 'Claude app: paste _ai/profile.md into a project\'s instructions.',
  'init.reserved': '--sectors: "{id}" is a device name Windows reserves (con, prn, aux, nul, com1 to com9, lpt1 to lpt9); choose another id',
  'init.private_root_drive': '--private-root {path} is on another drive than this repository. memory.json is shared by all your computers, so it can only hold a path relative to the repository or one inside your home folder (~/…). Choose a folder on the same drive as the repository or inside your home folder.',
  'init.move_failed': 'cannot rename {from} to {to} ({detail}). Close editors, terminals and sync apps that use it, then run init again with the same answers.',
};

class InitError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usageError = (message) => new InitError(2, message);

// ---------------------------------------------------------------------------------------------
// Small helpers (no kit imports, so --questions and --help work even with a broken install)

function interpolate(template, vars = {}) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (all, name) =>
    (Object.hasOwn(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
}

function isDate(s) {
  const m = DATE_RE.exec(String(s));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const cleanDir = (s) => String(s).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
const withMd = (s) => (String(s).endsWith('.md') ? String(s) : `${s}.md`);
const splitList = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const abs = (root, rel) => path.join(root, ...rel.split('/'));
const exists = (root, rel) => fs.existsSync(abs(root, rel));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * Writes text as UTF-8, NFC, LF with exactly one trailing newline when it differs from the file.
 * `replace` is util.replaceFile: an atomic replace that creates parent folders, so an interrupted
 * init never leaves half a memory.json or AGENTS.md.
 */
function writeText(file, text, replace) {
  const out = String(text).normalize('NFC').replace(/\r\n/g, '\n').replace(/\n+$/, '') + '\n';
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev !== out) replace(file, out);
}

const writeJson = (file, value, replace) => writeText(file, JSON.stringify(value, null, 2), replace);

let utilModule = null;

/** lib/util.mjs, imported on first use: --help and --questions work without the kit modules. */
async function kitUtil() {
  utilModule ??= await import(pathToFileURL(path.join(HERE, 'lib', 'util.mjs')).href);
  return utilModule;
}

// ---------------------------------------------------------------------------------------------
// Language packs and messages

/** Map code -> pack for every system/lang/<code>/pack.json, en first. */
function loadPacks(root) {
  const dir = path.join(root, 'system', 'lang');
  const codes = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  const packs = new Map();
  for (const code of ['en', ...codes.filter((c) => c !== 'en')]) {
    const pack = readJson(path.join(dir, code, 'pack.json'));
    if (pack && typeof pack === 'object') packs.set(code, pack);
  }
  if (!packs.has('en')) throw new InitError(3, 'system/lang/en/pack.json is missing or invalid');
  return packs;
}

/** t(key, vars) for one language: pack → en pack → English default in this file → key. */
function translator(packs, lang) {
  const pack = packs.get(lang) ?? {};
  const en = packs.get('en') ?? {};
  return (key, vars) => interpolate(pack.messages?.[key] ?? en.messages?.[key] ?? INIT_DEFAULTS[key] ?? key, vars);
}

function presetEntries(pack) {
  return Object.entries(pack.sector_presets ?? {}).filter(([, p]) => p && typeof p.id === 'string');
}

/** Canonical preset key for a preset name or an id in any pack; null for a custom id. */
function findPreset(name, packs, lang) {
  const target = packs.get(lang);
  if (target.sector_presets?.[name]) return name;
  for (const pack of [target, ...packs.values()]) {
    const hit = presetEntries(pack).find(([, p]) => p.id === name);
    if (hit) return hit[0];
  }
  return null;
}

function canonPrivacy(value, packs, lang) {
  for (const pack of [packs.get(lang), packs.get('en')]) {
    for (const canon of ['github', 'local']) {
      if (value === canon || value === pack?.privacy?.[canon]) return canon;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Questions

function defaultPrivateRoot(root) {
  return `../${path.basename(root)}-private`;
}

function presetList(packs, lang) {
  const en = packs.get('en');
  const pack = packs.get(lang);
  return presetEntries(en).map(([key]) => {
    const p = pack.sector_presets?.[key] ?? en.sector_presets[key];
    const name = p.id === key ? key : `${key} = ${p.id}`;
    const privacy = p.privacy === 'local' ? `, ${pack.privacy?.local ?? 'local'}` : '';
    return `${name} (${p.title}${privacy})`;
  }).join(', ');
}

function buildQuestions(root, packs) {
  const en = packs.get('en');
  const langs = [...packs.keys()];
  const presets = presetEntries(en).map(([key]) => key);
  const list = [
    { id: 'mode', flag: '--mode', required: true, default: 'github', choices: MODES },
    { id: 'lang', flag: '--lang', required: true, default: 'en', choices: langs },
    { id: 'sectors', flag: '--sectors', required: true, default: 'core,work', choices: presets },
    { id: 'private_root', flag: '--private-root', required: false, default: defaultPrivateRoot(root), choices: null, askIf: 'private_condition' },
    { id: 'agents', flag: '--agents', required: false, default: 'all', choices: AGENTS },
    { id: 'cleanup', flag: '--cleanup', required: false, default: 'none', choices: ['none'] },
  ];
  return list.map((q) => {
    const text = {};
    const askIf = {};
    for (const lang of langs) {
      const t = translator(packs, lang);
      const choices = (q.choices ?? []).join(', ');
      text[lang] = t(`init.question.${q.id}`, { choices, presets: presetList(packs, lang) });
      if (q.askIf) askIf[lang] = t('init.questions.ask_if', { condition: t(`init.questions.${q.askIf}`) });
    }
    const presetsInfo = q.id === 'sectors'
      ? presets.map((key) => ({
        preset: key,
        privacy: en.sector_presets[key].privacy,
        ids: Object.fromEntries(langs.map((l) => [l, packs.get(l).sector_presets?.[key]?.id ?? key])),
        titles: Object.fromEntries(langs.map((l) => [l, packs.get(l).sector_presets?.[key]?.title ?? key])),
      }))
      : undefined;
    return { ...q, askIf: q.askIf ? askIf : null, text, ...(presetsInfo ? { presets: presetsInfo } : {}) };
  });
}

const RUN_TEMPLATE = 'node system/init.mjs --mode <mode> --lang <lang> --sectors <list> [--private-root <path>] --agents <list> --cleanup none --yes';

function formatQuestions(questions, packs, only = null) {
  const t = translator(packs, 'en');
  const lines = [t('init.questions.intro'), RUN_TEMPLATE, ''];
  questions.filter((q) => !only || only.includes(q.id)).forEach((q, i) => {
    const extra = [q.flag];
    if (q.choices) extra.push(q.choices.join(', '));
    if (q.askIf) extra.push(q.askIf.en);
    lines.push(`${i + 1}. ${q.id} [${q.default}] (${extra.join('; ')})`);
    for (const [lang, text] of Object.entries(q.text)) lines.push(`   ${lang}: ${text}`);
  });
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Plan: validate the answers and work out every change before touching anything

function parseAgents(value) {
  if (value === undefined || value.trim() === 'all') return [...AGENTS];
  const list = [...new Set(splitList(value))];
  const unknown = list.filter((a) => !AGENTS.includes(a));
  if (unknown.length || !list.length) throw usageError(`--agents: unknown ${unknown.join(', ') || '(empty)'}; choices: ${AGENTS.join(', ')}, all`);
  return AGENTS.filter((a) => list.includes(a));
}

function parseSectors(value, packs, lang, mode, util) {
  const pack = packs.get(lang);
  const items = splitList(value);
  if (!items.length) throw usageError('--sectors needs at least one sector');
  const byId = new Map();
  for (const item of items) {
    const [name, priv, rest] = item.split(':').map((s) => s.trim());
    if (rest !== undefined) throw usageError(`--sectors: "${item}" has more than one ":"`);
    const key = findPreset(name, packs, lang);
    const preset = key ? (pack.sector_presets?.[key] ?? packs.get('en').sector_presets[key]) : null;
    if (!preset && (!NAME_RE.test(name) || name.length > SECTOR_ID_MAX)) {
      throw usageError(`--sectors: "${name}" is neither a preset (${presetEntries(packs.get('en')).map(([k]) => k).join(', ')}) nor a valid id (lowercase ascii with hyphens, max ${SECTOR_ID_MAX} chars)`);
    }
    if (!preset && util.isReservedName(name)) throw usageError(translator(packs, lang)('init.reserved', { id: name }));
    const privacy = priv === undefined ? (preset?.privacy === 'local' ? 'local' : 'github') : canonPrivacy(priv, packs, lang);
    if (!privacy) throw usageError(`--sectors: "${item}": privacy must be github or local`);
    // Mode github has no private folder: a local sector there must be an explicit choice, never silent.
    if (mode === 'github' && privacy === 'local') {
      const id = preset ? preset.id : name;
      throw usageError(translator(packs, lang)('init.github_local_sector', { id }));
    }
    if (key === 'core' && privacy !== 'github') throw usageError('--sectors: core holds the profile and must stay github');
    const id = preset ? preset.id : name;
    const entry = { id, preset: key, privacy, title: preset?.title ?? null, custom: !preset };
    const seen = byId.get(id);
    if (seen && seen.privacy !== privacy) throw usageError(`--sectors: ${id} is listed twice with different privacy`);
    if (!seen) byId.set(id, entry);
  }
  const coreId = pack.sector_presets?.core?.id ?? 'core';
  const core = byId.get(coreId) ?? { id: coreId, preset: 'core', privacy: 'github', title: pack.sector_presets?.core?.title ?? 'Core', custom: false };
  byId.delete(coreId);
  return [core, ...byId.values()];
}

/**
 * The private root as absolute path plus the form stored in memory.json. `util` is lib/util.mjs:
 * its expandHome is the same '~' expansion memory.json readers use, so writer and reader agree
 * (the home folder is os.homedir(): USERPROFILE on Windows, where HOME is usually unset).
 * memory.json is committed and shared by every computer, so the stored form is '~/…' for a
 * folder typed absolute (or with ~) inside the home folder, else a path relative to the vault.
 * A folder on another drive has neither form and is refused rather than stored as a path that
 * exists only on this machine. home, platform, pathMod and realpath let tests play Windows or
 * macOS; the repository checks follow symlinks and junctions (realpath) and ignore letter case
 * where the file system does.
 */
export function resolvePrivateRoot(root, given, {
  util, t = translator(new Map(), 'en'), home, platform = process.platform, pathMod = util.pathFor(platform),
  realpath = util.realpathLoose,
} = {}) {
  const raw = String(given).trim();
  if (!raw) throw usageError('--private-root must not be empty');
  const homeAbs = home ?? util.homeDir();
  const absPath = util.expandHome(raw, { home: homeAbs, pathMod }) ?? pathMod.resolve(root, raw);
  const inside = (a, b) => util.insidePath(realpath(a), realpath(b), { platform, pathMod });
  if (inside(root, absPath)) throw usageError(`--private-root must be outside this repository (${raw})`);
  if (inside(absPath, root)) throw usageError(`--private-root must not contain this repository (${raw})`);
  const slashes = (p) => p.split(pathMod.sep).join('/');
  const typedAbsolute = pathMod.isAbsolute(raw) || /^~(?:[\\/]|$)/.test(raw);
  const fromHome = homeAbs ? pathMod.relative(homeAbs, absPath) : '';
  const underHome = fromHome !== '' && fromHome !== '..' && !fromHome.startsWith(`..${pathMod.sep}`) && !pathMod.isAbsolute(fromHome);
  if (typedAbsolute && underHome) return { abs: absPath, stored: `~/${slashes(fromHome)}` };
  const fromRoot = pathMod.relative(root, absPath);
  if (pathMod.isAbsolute(fromRoot)) throw usageError(t('init.private_root_drive', { path: raw }));
  return { abs: absPath, stored: slashes(fromRoot) };
}

function dirName(pack, role) {
  return cleanDir(pack.dirs?.[role] ?? role);
}

function fileName(pack, role) {
  return withMd(pack.files?.[role] ?? role);
}

/** Renames from the current pack's names to the target pack's names, in execution order. */
function renameMoves(fromPack, toPack) {
  const moves = [];
  for (const role of DIR_ROLES) moves.push([dirName(fromPack, role), dirName(toPack, role)]);
  for (const role of FILE_ROLES) moves.push([fileName(fromPack, role), fileName(toPack, role)]);
  const archive = dirName(toPack, 'archive');
  for (const role of ['sectors', 'journal', 'inbox']) {
    moves.push([`${archive}/${dirName(fromPack, role)}`, `${archive}/${dirName(toPack, role)}`]);
  }
  const sectors = dirName(toPack, 'sectors');
  const fromCore = fromPack.sector_presets?.core?.id ?? 'core';
  const toCore = toPack.sector_presets?.core?.id ?? 'core';
  moves.push([`${sectors}/${fromCore}`, `${sectors}/${toCore}`]);
  moves.push([`${sectors}/${toCore}/_${fromCore}.md`, `${sectors}/${toCore}/_${toCore}.md`]);
  moves.push([`${sectors}/${toCore}/${fromPack.profile_note ?? 'profile'}.md`, `${sectors}/${toCore}/${toPack.profile_note ?? 'profile'}.md`]);
  return moves.filter(([a, b]) => a !== b);
}

const under = (p, base) => p === base || p.startsWith(`${base}/`);

/** Does rel exist after the already planned moves? */
function existsAfter(root, rel, planned) {
  let cur = rel;
  for (let i = planned.length - 1; i >= 0; i--) {
    const [from, to] = planned[i];
    if (under(cur, to)) cur = from + cur.slice(to.length);
    else if (under(cur, from)) return false;
  }
  return exists(root, cur);
}

/** The moves that will really happen; throws when a target already exists. */
function plannedMoves(root, moves) {
  const planned = [];
  for (const [from, to] of moves) {
    if (!existsAfter(root, from, planned)) continue;
    if (existsAfter(root, to, planned)) throw new InitError(1, `cannot rename ${from} to ${to}: ${to} already exists`);
    planned.push([from, to]);
  }
  return planned;
}

/**
 * True at the top level of a git work tree: git prints the way up (--show-cdup), empty at the
 * top. Comparing paths fails on Windows (letter case, 8.3 names, subst drives) and macOS links.
 */
function isGitTopLevel(root) {
  const res = runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-cdup']);
  const [inside, cdup = ''] = res.stdout.split(/\r?\n/);
  return res.ok && inside.trim() === 'true' && cdup.trim() === '';
}

function runGit(root, args) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: (res.stderr || res.error?.message || '').trim() };
}

function buildPlan(root, raw, opts, packs, util) {
  if (!MODES.includes(opts.mode)) throw usageError(`--mode must be one of ${MODES.join(', ')}`);
  if (!packs.has(opts.lang)) throw usageError(`--lang must be one of ${[...packs.keys()].join(', ')}`);
  const cleanup = opts.cleanup ?? 'none';
  if (cleanup !== 'none') throw usageError('--cleanup: only "none" is available in this version');
  const today = opts.today ?? localToday();
  if (!isDate(today)) throw usageError(`--today must be a real date YYYY-MM-DD, got "${today}"`);

  const lang = opts.lang;
  const fromLang = typeof raw.lang === 'string' && packs.has(raw.lang) ? raw.lang : 'en';
  const toPack = packs.get(lang);
  const fromPack = packs.get(fromLang);
  const t = translator(packs, lang);
  const sectors = parseSectors(opts.sectors, packs, lang, opts.mode, util);
  const agents = parseAgents(opts.agents);
  const needsPrivate = opts.mode !== 'github' || sectors.some((s) => s.privacy === 'local') || opts['private-root'] !== undefined;
  const privateRoot = needsPrivate ? resolvePrivateRoot(root, opts['private-root'] ?? defaultPrivateRoot(root), { util, t }) : null;
  const moves = plannedMoves(root, renameMoves(fromPack, toPack));
  const git = isGitTopLevel(root);
  if (opts.mode === 'local' && git) {
    const remotes = runGit(root, ['remote']).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    if (remotes.length) throw new InitError(1, t('init.refused_remote', { remotes: remotes.join(', ') }));
  }
  const cloud = cloudSignal();
  if (cloud && privateRoot && !opts['allow-ephemeral']) throw new InitError(1, t('init.refused_cloud', { signal: cloud }));

  const dirs = Object.fromEntries(DIR_ROLES.map((r) => [r, dirName(toPack, r)]));
  const core = sectors[0];
  const profileRel = `${dirs.sectors}/${core.id}/${toPack.profile_note ?? 'profile'}.md`;
  const writes = [
    ...HAND_FILES.map((r) => fileName(toPack, r)),
    `${dirs.sectors}/${core.id}/_${core.id}.md`,
    ...(exists(root, profileRel) || moves.some(([, to]) => to === profileRel) ? [] : [profileRel]),
    'AGENTS.md', 'memory.json',
  ];
  return {
    root, lang, fromLang, toPack, mode: opts.mode, today, agents, sectors, privateRoot, moves, git,
    gitInit: opts.mode === 'local' && !git, dirs, profileRel, writes, raw,
  };
}

function formatPlan(plan, t) {
  const sectorText = plan.sectors.map((s) => `${s.id} (${plan.toPack.privacy?.[s.privacy] ?? s.privacy})`).join(', ');
  const lines = [
    t('init.plan.title'),
    `- ${t('init.plan.language', { lang: plan.lang, name: plan.toPack.name ?? plan.lang })}`,
    `- ${t('init.plan.mode', { mode: plan.mode })}`,
    `- ${t('init.plan.sectors', { sectors: sectorText })}`,
  ];
  if (plan.privateRoot) lines.push(`- ${t('init.plan.private_root', { path: plan.privateRoot.stored })}`);
  if (plan.moves.length) lines.push(`- ${t('init.plan.rename', { moves: plan.moves.map(([a, b]) => `${a} → ${b}`).join(', ') })}`);
  lines.push(`- ${t('init.plan.write', { files: plan.writes.join(', ') })}`);
  lines.push(`- ${t('init.plan.generate')}`);
  lines.push(`- ${t(plan.gitInit ? 'init.plan.git_init' : plan.git ? 'init.plan.git_hooks' : 'init.plan.no_git')}`);
  for (const s of plan.sectors.filter((x) => x.custom)) lines.push(`- ${t('init.plan.custom', { id: s.id })}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Apply

function isTracked(root, rel) {
  const res = runGit(root, ['ls-files', '--', rel]);
  return res.ok && res.stdout.trim() !== '';
}

/**
 * Renames one planned entry: git mv for tracked content, else (or when git mv fails) a rename
 * that retries while Windows reports a file in use (util.movePath).
 */
function moveEntry(plan, util, t, from, to) {
  try {
    util.movePath(plan.root, from, to, { useGit: plan.git && isTracked(plan.root, from) });
  } catch (err) {
    throw new InitError(1, t('init.move_failed', { from, to, detail: err?.code ?? err?.message ?? err }));
  }
}

/** The target folders exist; empty ones keep a .gitkeep so git and editors see them. */
function ensureSkeleton(root, dirs) {
  for (const role of DIR_ROLES) fs.mkdirSync(abs(root, dirs[role]), { recursive: true });
  for (const role of KEEP_EMPTY) {
    const dir = abs(root, dirs[role]);
    if (fs.readdirSync(dir).length === 0) fs.writeFileSync(path.join(dir, '.gitkeep'), '');
  }
}

function kitTemplate(root, lang, name) {
  for (const l of [lang, 'en']) {
    const file = path.join(root, 'system', 'templates', l, 'kit', name);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  }
  throw new InitError(3, `template system/templates/${lang}/kit/${name} is missing`);
}

const fill = (text, vars) => text.replace(/\{\{(date|title|id|dir)\}\}/g, (all, key) => vars[key] ?? all);

function memoryJson(plan, initialized) {
  const raw = plan.raw;
  const main = { id: 'main', path: '.', privacy: 'github' };
  const extra = (Array.isArray(raw.roots) ? raw.roots.slice(1) : [])
    .filter((r) => r && r.id !== PRIVATE_ROOT_ID && (!plan.privateRoot || r.path !== plan.privateRoot.stored));
  const roots = [main, ...(plan.privateRoot ? [{ id: PRIVATE_ROOT_ID, path: plan.privateRoot.stored, privacy: 'local' }] : []), ...extra];
  const ordered = {
    version: 1,
    initialized,
    lang: plan.lang,
    mode: plan.mode,
    roots,
    profile: plan.profileRel,
    agents: plan.agents,
    budgets: raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {},
    search: raw.search && typeof raw.search === 'object' ? raw.search : { log: false, n: 5 },
    eval: raw.eval && typeof raw.eval === 'object' ? raw.eval : { golden: 'system/tests/golden.json', min: 0.9 },
    cleanup: { ...(raw.cleanup && typeof raw.cleanup === 'object' ? raw.cleanup : {}), provider: 'none' },
  };
  for (const [key, value] of Object.entries(raw)) if (!Object.hasOwn(ordered, key)) ordered[key] = value;
  return ordered;
}

/**
 * Full text of a sector manifest, the same shape `sector add` writes. `serialize` comes from
 * lib/frontmatter.mjs (passed in because init loads the kit modules lazily).
 */
export function manifestText(cfg, serialize, root, s, today) {
  const preset = s.preset ? (cfg.presets?.[s.preset] ?? {}) : {};
  const title = s.title ?? preset.title ?? s.id;
  const k = cfg.keys;
  const data = {
    [k.type]: cfg.local('type', 'sector'),
    [k.status]: cfg.local('status', 'active'),
    [k.description]: preset.description ?? cfg.t('sector.default_description', { title }),
    [k.updated]: today,
  };
  if (title.toLowerCase() !== s.id) data.aliases = [title];
  data[k.keywords] = Array.isArray(preset.keywords) ? preset.keywords : [s.id];
  data[k.state] = cfg.local('state', 'on');
  data[k.privacy] = cfg.local('privacy', s.privacy);
  data[k.when_here] = preset.when_here ?? cfg.t('sector.default_when', { title });
  data[k.not_here] = preset.not_here ?? cfg.t('sector.default_not', { title });
  const dir = `${cfg.dirs.sectors}/${s.id}`;
  const body = fill(kitTemplate(root, cfg.lang, 'sector.md'), { title, id: s.id, dir });
  return serialize(data, { order: cfg.keyOrder }) + body;
}

/** Replaces the system section of AGENTS.md; a personal section still at the en default is translated. */
function agentsText(root, lang, current) {
  const system = kitTemplate(root, lang, 'agents-system.md').replace(/\n+$/, '\n');
  const personalDefault = kitTemplate(root, lang, 'agents-personal.md').replace(/\n+$/, '\n');
  const enPersonal = kitTemplate(root, 'en', 'agents-personal.md').trim();
  if (current === null) return `${system}\n${personalDefault}`;
  const lines = current.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.includes(KIT_START));
  const end = lines.findIndex((l, i) => i >= start && l.includes(KIT_END));
  if (start < 0 || end < 0) {
    const rest = current.trim();
    return `${system}\n${rest ? `${rest}\n` : personalDefault}`;
  }
  const before = lines.slice(0, start).join('\n').trim();
  let personal = lines.slice(end + 1).join('\n').trim();
  if (personal === '' || personal === enPersonal) personal = personalDefault.trim();
  return `${before ? `${before}\n\n` : ''}${system}\n${personal}\n`;
}

/** A cloud session whose disk disappears when it ends: the reason, or null. */
function cloudSignal() {
  if (process.env.CLAUDE_CODE_REMOTE === 'true') return 'CLAUDE_CODE_REMOTE=true';
  if (process.env.CODESPACES === 'true') return 'CODESPACES=true';
  if (process.env.GITPOD_WORKSPACE_ID) return 'GITPOD_WORKSPACE_ID';
  return null;
}

async function kitModules() {
  const url = (rel) => pathToFileURL(path.join(HERE, rel)).href;
  const [config, vault, generate, check, sector, frontmatter, util] = await Promise.all([
    import(url('lib/config.mjs')), import(url('lib/vault.mjs')), import(url('lib/generate.mjs')),
    import(url('lib/check.mjs')), import(url('lib/commands/sector.mjs')), import(url('lib/frontmatter.mjs')),
    kitUtil(),
  ]);
  return { config, vault, generate, check, sector, frontmatter, util };
}

/** The private root's skeleton (sectors and inbox folders) plus a short README. */
function ensurePrivateRoot(plan, cfg, t, replace) {
  if (!plan.privateRoot) return;
  const base = plan.privateRoot.abs;
  for (const dir of [cfg.dirs.sectors, cfg.dirs.inbox]) fs.mkdirSync(path.join(base, dir), { recursive: true });
  const readme = path.join(base, 'README.md');
  if (!fs.existsSync(readme)) writeText(readme, t('init.private_readme', { root: plan.root, sectors: cfg.dirs.sectors }), replace);
}

function setupGit(plan, out) {
  if (plan.gitInit) {
    const res = runGit(plan.root, ['init', '-b', 'main']);
    if (!res.ok) {
      const fallback = runGit(plan.root, ['init']);
      if (!fallback.ok) throw new InitError(1, `git init failed: ${res.stderr || fallback.stderr}`);
      runGit(plan.root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    plan.git = true;
  }
  const hook = path.join(plan.root, '.githooks', 'pre-commit');
  try {
    if (fs.existsSync(hook)) fs.chmodSync(hook, 0o755);
  } catch {
    /* file modes are not supported everywhere */
  }
  if (plan.git) {
    const res = runGit(plan.root, ['config', 'core.hooksPath', '.githooks']);
    if (!res.ok) out.warn(`git config core.hooksPath failed: ${res.stderr}`);
  }
}

/** Applies a plan (steps of section 14) and returns the strict check result. */
async function apply(plan, packs, out) {
  const { root } = plan;
  const t = translator(packs, plan.lang);
  const m = await kitModules();
  const replace = m.util.replaceFile;

  // 1. Folder and file names of the target language.
  for (const [from, to] of plan.moves) moveEntry(plan, m.util, t, from, to);
  if (plan.moves.length) out.line(t('init.renamed', { moves: plan.moves.map(([a, b]) => `${a} → ${b}`).join(', ') }));
  ensureSkeleton(root, plan.dirs);

  // 2. memory.json first (not yet initialized), so every kit module sees the new names and roots.
  writeJson(path.join(root, 'memory.json'), memoryJson(plan, false), replace);
  let cfg = m.config.loadConfig(root);
  ensurePrivateRoot(plan, cfg, t, replace);

  // 3. Hubs, core manifest and profile from the language's kit templates.
  const written = [];
  for (const role of HAND_FILES) {
    const rel = cfg.files[role];
    writeText(abs(root, rel), fill(kitTemplate(root, plan.lang, `${role}.md`), { date: plan.today }), replace);
    written.push(rel);
  }
  const core = plan.sectors[0];
  const coreRel = `${cfg.dirs.sectors}/${core.id}/_${core.id}.md`;
  writeText(abs(root, coreRel), manifestText(cfg, m.frontmatter.serialize, root, core, plan.today), replace);
  written.push(coreRel);
  if (!exists(root, plan.profileRel)) {
    writeText(abs(root, plan.profileRel), fill(kitTemplate(root, plan.lang, 'profile.md'), { date: plan.today }), replace);
    written.push(plan.profileRel);
  }

  // 4. AGENTS.md: the system section of the language, without the setup block.
  const agentsFile = path.join(root, 'AGENTS.md');
  const current = fs.existsSync(agentsFile) ? fs.readFileSync(agentsFile, 'utf8') : null;
  writeText(agentsFile, agentsText(root, plan.lang, current), replace);
  written.push('AGENTS.md');
  out.line(t('init.wrote', { files: written.join(', ') }));

  // 5. The other sectors, with the preset texts of the language.
  const existing = new Set(m.vault.loadVault(cfg, { includeInbox: false }).sectors.map((s) => s.id));
  for (const s of plan.sectors.slice(1)) {
    if (existing.has(s.id)) {
      out.line(t('init.sector_skipped', { id: s.id }));
      continue;
    }
    const preset = s.preset ? (cfg.presets?.[s.preset] ?? {}) : {};
    const res = await m.sector.addSector(cfg, {
      id: s.id,
      privacy: s.privacy,
      title: s.title ?? undefined,
      description: preset.description,
      when_here: preset.when_here,
      not_here: preset.not_here,
      keywords: Array.isArray(preset.keywords) ? preset.keywords : [],
      today: plan.today,
    });
    out.line(cfg.t('sector.added', { id: s.id, privacy: cfg.local('privacy', s.privacy), rel: res.rel }));
  }

  // 6. memory.json, now initialized. It feeds the fingerprints, so it is final before generating.
  writeJson(path.join(root, 'memory.json'), memoryJson(plan, true), replace);
  cfg = m.config.loadConfig(root);

  out.line(t('init.wrote', { files: 'memory.json' }));

  // 7. git.
  const gitInit = plan.gitInit;
  setupGit(plan, out);
  out.line(t(gitInit ? 'init.plan.git_init' : plan.git ? 'init.plan.git_hooks' : 'init.plan.no_git'));

  // 8. Generate the views (home page, _ai/, .ignore, the .gitignore block), then the strict check.
  const gen = await m.generate.writeGenerated(cfg, m.vault.loadVault(cfg), { today: plan.today });
  out.line(cfg.t('check.generated', { written: gen.written.length, removed: gen.removed.length }));
  const result = await m.check.runChecks(cfg, m.vault.loadVault(cfg, { roots: 'all' }), { strict: true, today: plan.today });
  if (result.errors.length || result.warnings.length) out.block(m.check.formatFindings(result, cfg, { mode: 'strict' }));
  return result;
}

/** The next steps after init as [{ text, commands? }] (the wizard renders them its own way). */
function nextStepItems(plan, t) {
  const items = [{ text: t('init.next.profile', { rel: plan.profileRel }) }];
  // One command per line: `a && b` is a parse error in Windows PowerShell 5.1.
  if (plan.git) items.push({ text: t('init.next.commit_steps'), commands: ['git add -A', `git commit -m "${t('init.next.commit_message')}"`] });
  else items.push({ text: t('init.next.no_git') });
  items.push({ text: t(plan.mode === 'local' ? 'init.next.local' : 'init.next.github') });
  if (plan.privateRoot) items.push({ text: t('init.next.combined', { path: plan.privateRoot.stored }) });
  for (const agent of plan.agents) {
    const key = agent === 'chatgpt' && plan.mode === 'local' ? 'init.next.chatgpt_local' : `init.next.${agent}`;
    items.push({ text: t(key) });
  }
  return items;
}

function nextSteps(plan, t) {
  const lines = [t('init.next.title')];
  for (const item of nextStepItems(plan, t)) {
    lines.push(`- ${item.text}`);
    for (const command of item.commands ?? []) lines.push(`    ${command}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// Entry

function readMemoryJson(root) {
  const file = path.join(root, 'memory.json');
  if (!fs.existsSync(file)) throw new InitError(3, `memory.json not found in ${root}`);
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InitError(3, 'memory.json is not a valid JSON object');
  return raw;
}

function makeOutput(json) {
  const lines = [];
  const warnings = [];
  return {
    line: (s) => { lines.push(s); if (!json) process.stdout.write(`${s}\n`); },
    block: (s) => { lines.push(s.replace(/\n$/, '')); if (!json) process.stdout.write(s.endsWith('\n') ? s : `${s}\n`); },
    warn: (s) => { warnings.push(s); process.stderr.write(`init: ${s}\n`); },
    lines,
    warnings,
  };
}

function installSqliteWarningFilter() {
  const mark = Symbol.for('memory-kit.sqlite-warning-filter');
  if (process[mark]) return;
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    if (String(text ?? '').includes('SQLite')) return undefined;
    return original.call(process, warning, ...rest);
  };
  process[mark] = true;
}

/** Runs init with CLI arguments; returns the exit code. */
export async function main(argv) {
  installSqliteWarningFilter();
  let opts;
  try {
    opts = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (err) {
    process.stderr.write(`init: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    process.stderr.write(`init: memory-kit needs Node 22 or newer (this is ${process.versions.node})\n`);
    return 3;
  }
  const root = path.resolve(opts.root ?? path.join(HERE, '..'));

  try {
    const packs = loadPacks(root);
    const raw = readMemoryJson(root);
    const questions = buildQuestions(root, packs);
    if (opts.questions) {
      process.stdout.write(opts.json
        ? `${JSON.stringify({ command: RUN_TEMPLATE, initialized: raw.initialized === true, questions }, null, 2)}\n`
        : formatQuestions(questions, packs));
      return 0;
    }
    const t = translator(packs, packs.has(opts.lang) ? opts.lang : 'en');
    if (await wantsWizard(opts, raw)) {
      const { runWizard } = await import(pathToFileURL(path.join(HERE, 'lib', 'wizard.mjs')).href);
      return await runWizard({ root, opts });
    }
    if (raw.initialized === true) {
      process.stderr.write(`init: ${t('init.refused_initialized')}\n`);
      return 1;
    }
    const missing = ['mode', 'lang', 'sectors'].filter((k) => opts[k] === undefined || opts[k].trim() === '');
    if (missing.length) {
      process.stderr.write(`init: ${t('init.missing', { flags: missing.map((k) => `--${k}`).join(', ') })}\n`);
      process.stdout.write(formatQuestions(questions, packs, missing));
      return 2;
    }

    const plan = buildPlan(root, raw, opts, packs, await kitUtil());
    const tt = translator(packs, plan.lang);
    if (!opts.yes || opts['dry-run']) {
      if (opts.json) process.stdout.write(`${JSON.stringify(planJson(plan, false), null, 2)}\n`);
      else process.stdout.write(`${formatPlan(plan, tt)}${tt('init.dry_run')}\n`);
      return 0;
    }

    const out = makeOutput(opts.json);
    const result = await apply(plan, packs, out);
    const ok = result.errors.length === 0;
    const sectorsText = plan.sectors.map((s) => s.id).join(', ');
    out.line(tt('init.done', { lang: plan.lang, mode: plan.mode, sectors: sectorsText }));
    if (!ok) out.line(tt('init.check_failed'));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ...planJson(plan, true),
        ok,
        errors: result.errors,
        warnings: result.warnings,
        output: out.lines,
      }, null, 2)}\n`);
    } else {
      process.stdout.write(nextSteps(plan, tt));
    }
    return ok ? 0 : 1;
  } catch (err) {
    if (err instanceof InitError) {
      process.stderr.write(`init: ${err.message}\n`);
      if (err.exitCode === 2) process.stderr.write(`${USAGE}\n`);
      return err.exitCode;
    }
    if (err?.code === 'SECTOR' || err?.name === 'SectorError') {
      process.stderr.write(`init: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`init: internal error: ${err?.stack ?? err}\n`);
    return 3;
  }
}

/**
 * Whether main hands over to the setup wizard: --interactive, or (unless --no-interactive, --yes,
 * --json or --dry-run) a terminal where stdin and stdout are TTYs, not CI and not TERM=dumb, and
 * answers are missing (a set-up vault: no answers at all, which opens the extras menu).
 */
async function wantsWizard(opts, raw) {
  if (opts.interactive && opts['no-interactive']) throw usageError('--interactive and --no-interactive exclude each other');
  if (opts.interactive) return true;
  if (opts['no-interactive'] || opts.yes || opts.json || opts['dry-run']) return false;
  const given = ['mode', 'lang', 'sectors'].filter((k) => opts[k] !== undefined && opts[k].trim() !== '');
  if (raw.initialized === true ? given.length > 0 : given.length === 3) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const { capabilities } = await import(pathToFileURL(path.join(HERE, 'lib', 'tui.mjs')).href);
  return capabilities().interactive;
}

function planJson(plan, applied) {
  return {
    applied,
    lang: plan.lang,
    mode: plan.mode,
    sectors: plan.sectors.map(({ id, preset, privacy, custom }) => ({ id, preset, privacy, custom })),
    privateRoot: plan.privateRoot?.stored ?? null,
    renames: plan.moves.map(([from, to]) => ({ from, to })),
    writes: plan.writes,
    profile: plan.profileRel,
    agents: plan.agents,
    git: plan.gitInit ? 'init' : plan.git ? 'hooks' : 'none',
  };
}

// For the setup wizard (lib/wizard.mjs): the same questions, plan and steps as the CLI.
export {
  AGENTS, InitError, MODES, apply, buildPlan, defaultPrivateRoot, formatPlan, kitUtil, loadPacks, nextStepItems,
  planJson, presetEntries, readMemoryJson, translator,
};

/**
 * True when argv1 (the script node was started with) is selfFile. Node resolves links for the
 * module's own URL but not for argv[1], so both sides go through realpath (symlinks, junctions,
 * subst drives, 8.3 names); Windows and macOS also ignore letter case (and NFC/NFD on macOS).
 */
export function entryMatches(argv1, selfFile, { platform = process.platform, realpath = fs.realpathSync.native } = {}) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpath(p);
    } catch {
      return p;
    }
  };
  const fold = (p) => (platform === 'win32' || platform === 'darwin' ? p.normalize('NFC').toLowerCase() : p);
  const resolve = platform === 'win32' ? path.win32.resolve : path.posix.resolve;
  return fold(real(resolve(argv1))) === fold(real(selfFile));
}

// import.meta.main exists from Node 22.18; older 22.x lines compare the paths.
const IS_MAIN = typeof import.meta.main === 'boolean'
  ? import.meta.main
  : entryMatches(process.argv[1], fileURLToPath(import.meta.url));

if (IS_MAIN) {
  // A reader that stops early (| head) must not abort init half way: finish the setup silently.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err) => {
      if (err?.code !== 'EPIPE' && err?.code !== 'ERR_STREAM_DESTROYED') throw err;
    });
  }
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`init: internal error: ${err?.stack ?? err}\n`);
      process.exitCode = 3;
    },
  );
}
