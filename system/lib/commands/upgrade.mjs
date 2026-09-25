// `upgrade`: moves a vault to a newer memory-kit without touching the owner's data. The newest
// upgrader always runs: a vault's own CLI fetches the kit (--from or the default source) and hands
// over to the fetched kit's upgrader when that one is newer; `node <new-kit>/system/memory.mjs
// upgrade --root <vault>` uses that kit as the source. Without --yes it only prints the plan.
// Runs without a loadable config too (cfg is then null and messages are English).
// In a terminal (stdin and stdout TTYs, not --json) the same steps run as a screen of lib/tui.mjs:
// the plan as counts, "What's new" from the target's CHANGELOG.md, a question instead of "run
// again with --yes", spinners, and a box with the result. Everywhere else the output is plain
// text as before; when lib/tui.mjs cannot be loaded the plain text is used too.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_SOURCE, absOf, compareVersions, loadManifest, parseVersion, readVersion } from '../kit.mjs';
import {
  UpgradeError, applyUpgrade, cloneKit, isGitUrl, lockState, planUpgrade, readVaultConfig, recoveryTool, rollbackUpgrade,
  samePath,
} from '../upgrade.mjs';
import { isDir, isFile, parseCli, usageError } from '../util.mjs';

export const usage = 'upgrade [--from <dir|git-url>] [--ref <branch|tag>] [--yes] [--dry-run] [--force] [--rollback [backup-id]] [--no-verify] [--json] [--verbose]';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARENT_ENV = 'MEMORY_KIT_UPGRADE_PARENT';
const PASS_FLAGS = ['yes', 'dry-run', 'force', 'no-verify', 'json', 'verbose'];
const NOTES_MAX = 6;

// English defaults; packs may translate the same keys (section 4.10).
const DEFAULTS = {
  'upgrade.title': 'memory-kit upgrade {from} → {to}',
  'upgrade.source': 'source: {source}',
  'upgrade.counts': 'kit files: {add} new, {replace} updated, {remove} removed, {unchanged} unchanged',
  'upgrade.agents.replace': 'AGENTS.md: the kit section is replaced with {template}; your text around it stays as it is',
  'upgrade.agents.unchanged': 'AGENTS.md: the kit section is current',
  'upgrade.agents.no_file': 'AGENTS.md is missing, so its kit section cannot be updated',
  'upgrade.agents.no_template': 'AGENTS.md: the new kit has no kit section for this language; left as it is',
  'upgrade.agents.missing': 'AGENTS.md: the kit markers are missing, so the kit section was not updated; copy it from {template} by hand',
  'upgrade.agents.duplicate': 'AGENTS.md: a kit marker appears more than once, so the kit section was not updated; keep one pair and upgrade again',
  'upgrade.agents.broken': 'AGENTS.md: the kit end marker comes before the start marker, so the kit section was not updated',
  'upgrade.agents.encoding': 'AGENTS.md is saved as UTF-16, so the kit section was not updated; save it as UTF-8 and upgrade again',
  'upgrade.migrations': 'data: version {from} → {to} ({list})',
  'upgrade.skip.optional': '{group}: {n} files skipped, this vault does not carry them',
  'upgrade.skip.missing': 'not in this vault, so not added: {files}',
  'upgrade.skip.golden': 'your golden questions stay as they are: {files}',
  'upgrade.propose': 'changed here, so kept; the new version goes to {dir} for comparison:',
  'upgrade.keep': 'no longer part of the kit but changed here, so kept:',
  'upgrade.forced': 'changed here and replaced because of --force (the backup keeps your version):',
  'upgrade.refused': 'the upgrade is refused:',
  'upgrade.blocked': 'the upgrade cannot run yet:',
  'upgrade.blocker.modified': '{rel}: changed here; move your change elsewhere or use --force (the backup keeps your version)',
  'upgrade.blocker.dirty': '{rel}: uncommitted changes; commit them first (or use --force)',
  'upgrade.blocker.locked': 'an earlier upgrade {from} → {to} did not finish; run upgrade --rollback first (or use --force)',
  'upgrade.refuse.same_dir': 'the source is the vault itself ({path}); pass --from with another copy of the kit',
  'upgrade.refuse.source_no_manifest': '{source} is not memory-kit 0.1.1 or newer (system/kit.json is missing)',
  'upgrade.refuse.source_manifest': 'system/kit.json of the source is invalid ({fields})',
  'upgrade.refuse.source_version': 'the source is inconsistent: system/VERSION says {version}, system/kit.json says {manifest}',
  'upgrade.refuse.source_damaged': 'the source is damaged: {n} files differ from its manifest ({files}); download it again',
  'upgrade.refuse.config': 'memory.json cannot be read ({error}); fix it first (doctor shows how)',
  'upgrade.refuse.config_runner': 'memory.json cannot be read ({error}); fix it first ({command} shows how)',
  'upgrade.refuse.vault_version': 'system/VERSION of the vault is not a version ("{version}")',
  'upgrade.refuse.downgrade': 'the vault has {from} and the source is older ({to}); --force goes back anyway',
  'upgrade.refuse.too_old': 'this kit upgrades vaults from version {min} on, this vault has {from}; upgrade to {min} first',
  'upgrade.refuse.node': 'the new kit needs Node.js {need} or newer, this is {have}',
  'upgrade.refuse.data_newer': 'the data of this vault (version {vault}) is newer than this kit reads ({kit}); use a newer kit',
  'upgrade.refuse.data_invalid': 'memory.json "version" is not a whole number of 1 or more',
  'upgrade.refuse.no_migration': 'the kit has no migration from data version {from} to {to}',
  'upgrade.refuse.migrations_invalid': 'the migrations of the source cannot be loaded: {error}',
  'upgrade.refuse.locked': 'another upgrade is running or did not finish ({from} → {to}); run upgrade --rollback first (or use --force)',
  'upgrade.refuse.running': 'an upgrade {from} → {to} is running right now (process {pid}); wait for it to finish, then run the command again',
  'upgrade.dry_run': 'Plan only, nothing was changed. To apply it:',
  'upgrade.up_to_date': 'memory-kit {version} is up to date (the source has {source}).',
  'upgrade.fetching': 'fetching memory-kit from {url}',
  'upgrade.fetch_failed': 'memory-kit could not be downloaded from {url}: {detail}',
  'upgrade.fetch_hint': 'download the kit another way and run: node <kit>/system/memory.mjs upgrade --root <vault>',
  'upgrade.source_missing': 'kit.source is neither a git URL nor a folder: {source}',
  'upgrade.tmp_left': 'the temporary folder {dir} could not be removed ({detail}); you can delete it by hand',
  'upgrade.source_invalid': 'the source has no valid system/VERSION: {source}',
  'upgrade.delegate': 'memory-kit {version} found in {source}; its upgrader takes over',
  'upgrade.applied': 'upgraded {from} → {to} · backup {backup}',
  'upgrade.verified': 'verified with the vault\'s own commands: check, start and search work',
  'upgrade.verified_eval': 'golden questions: hit@3 {before} before, {after} after',
  'upgrade.verify_skipped': 'not verified (--no-verify); run node system/memory.mjs check --generate now',
  'upgrade.new_findings': 'new check findings (not failures), look at them when you can:',
  'upgrade.migrated': 'data migrated to version {to}: {list}',
  'upgrade.failed': 'the upgrade failed ({step}): {detail}',
  'upgrade.rolled_back': 'every file was restored from the backup; the vault is as it was',
  'upgrade.unrecorded': 'the checks also changed files the backup did not hold, so they stay changed: {files}',
  'upgrade.saved': 'these files changed while the upgrade ran; your version of each is saved under {dir}: {files}',
  'upgrade.foreign': 'files that other programs created while the checks ran were left as they are: {files}',
  'upgrade.restore_failed': 'restoring the backup failed as well ({detail}); run: {command}',
  'upgrade.undone_meanwhile': 'another command undid this upgrade while it ran, so it is not finished; run the upgrade again',
  'upgrade.recover': 'the upgrade stopped before it finished; undo it with: {command}',
  'upgrade.proposed_next': 'the kit\'s new versions of files you changed are in {dir}; compare them with yours and take over what you want',
  'upgrade.next': 'next steps:',
  'upgrade.undo': 'to undo it: {command}',
  'upgrade.rollback.done': 'backup {id} restored, the upgrade {from} → {to} is undone: {restored} files restored, {removed} removed',
  'upgrade.rollback.plan': 'backup {id} would restore {restored} files and remove {removed}; nothing was changed',
  'upgrade.rollback.already': 'backup {id} is restored already; nothing to do',
  'upgrade.rollback.none': 'there is no upgrade backup to restore',
  'upgrade.rollback.not_found': 'backup "{id}" not found; available: {ids}',
  'upgrade.rollback.orphan_lock': 'an interrupted upgrade left its lock, but its backup {id} is gone; upgrade --rollback --force removes the lock',
  'upgrade.rollback.lock_removed': 'the lock of the interrupted upgrade was removed',
  'upgrade.rollback.lock_would_remove': 'dry run: the lock of the interrupted upgrade would be removed; nothing was changed',
  'upgrade.rollback.conflicts': 'these files changed after the upgrade, so nothing was restored; --force restores them anyway (their current version is saved in the backup):',
  'upgrade.rollback.saved': 'these files had changed after the upgrade; your version of each is saved under {dir}:',
  'upgrade.rollback.running': 'an upgrade {from} → {to} is running right now (process {pid}); wait for it to finish',
  'upgrade.error.backup_invalid': 'the backup in {dir} cannot be read',
  'upgrade.error.restore_failed': 'restoring {rel} failed',
  'upgrade.ui.plan': 'Plan',
  'upgrade.ui.new': 'new',
  'upgrade.ui.changed': 'changed',
  'upgrade.ui.removed': 'removed',
  'upgrade.ui.unchanged': 'unchanged',
  'upgrade.ui.agents': 'AGENTS.md: the kit section is updated, your text around it stays',
  'upgrade.ui.skip_missing': '{n} kit files this vault does not carry stay out',
  'upgrade.ui.propose': '{n} changed here, so kept; the new versions go to {dir}',
  'upgrade.ui.keep': '{n} no longer part of the kit but changed here, so kept',
  'upgrade.ui.forced': '{n} changed here and replaced because of --force (the backup keeps yours)',
  'upgrade.ui.details': 'the file lists: add --verbose',
  'upgrade.ui.whats_new': 'What\'s new in {version}',
  'upgrade.ui.more_notes': '{n} more in CHANGELOG.md',
  'upgrade.ui.confirm': 'Upgrade to {to} now?',
  'upgrade.ui.not_now': 'Nothing changed.',
  'upgrade.ui.stopped': 'Nothing changed.',
  'upgrade.ui.applying': 'Backing up, upgrading and verifying',
  'upgrade.ui.applied': 'Upgraded {from} → {to}',
  'upgrade.ui.failed': 'The upgrade did not go through',
  'upgrade.ui.what_happened': 'What happened',
  'upgrade.ui.done_title': 'memory-kit {to} is installed',
  'upgrade.ui.backup': 'backup: {backup}',
  'upgrade.ui.findings': '{n} new check findings (not failures): node system/memory.mjs check',
  'upgrade.ui.done': 'Done.',
};

function say(cfg, key, vars = {}) {
  const text = typeof cfg?.t === 'function' ? cfg.t(key, vars) : key;
  if (typeof text === 'string' && text !== '' && text !== key) return text;
  const template = DEFAULTS[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
}

/** A path or argument as a shell user would type it (display only). */
function quote(s) {
  const t = String(s);
  return /^[\w@%+=:,./\\-]+$/.test(t) ? t : `"${t.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** What the upgrader that handed over to this one passed on, or null. */
function parentInfo() {
  const raw = process.env[PARENT_ENV];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * The message of a refusal. doctor: the doctor command of the kit that runs, given when the vault's
 * own kit has none (0.1.0), so a broken memory.json refers to a doctor that exists.
 */
function refusalMessage(cfg, r, { doctor } = {}) {
  if (r.code === 'config' && doctor) return say(cfg, 'upgrade.refuse.config_runner', { ...r, command: doctor });
  return say(cfg, DEFAULTS[`upgrade.refuse.${r.code}`] ? `upgrade.refuse.${r.code}` : 'upgrade.refused', r);
}
const blockerMessage = (cfg, b) => say(cfg, `upgrade.blocker.${b.code}`, b);

function errorMessage(cfg, err) {
  if (!(err instanceof UpgradeError)) return err?.message ?? String(err);
  for (const key of [`upgrade.error.${err.code}`, `upgrade.rollback.${err.code.replace(/^rollback_/, '')}`, `upgrade.refuse.${err.code}`]) {
    if (DEFAULTS[key]) return say(cfg, key, err.vars);
  }
  return err.message;
}

// ---------------------------------------------------------------------------------------------
// Output

function makeOut(json) {
  const lines = [];
  return {
    line: (s = '') => {
      if (!json) lines.push(s);
    },
    flush: () => {
      if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
      lines.length = 0;
    },
    err: (s) => process.stderr.write(`memory: ${s}\n`),
  };
}

function printPlan(out, cfg, plan, hints = {}) {
  const t = (key, vars) => say(cfg, key, vars);
  out.line(t('upgrade.title', { from: plan.from, to: plan.to ?? '?' }));
  out.line(t('upgrade.source', { source: plan.source }));
  if (plan.files.length) {
    out.line(t('upgrade.counts', plan.counts));
    const a = plan.agents;
    const key = a.action === 'replace' ? 'upgrade.agents.replace' : a.action === 'unchanged' ? 'upgrade.agents.unchanged' : `upgrade.agents.${a.state}`;
    if (DEFAULTS[key]) out.line(t(key, { template: a.template ?? 'system/templates/<lang>/kit/agents-system.md' }));
  }
  if (plan.migrations.length) {
    const list = plan.migrations.map((m) => `${m.id}: ${m.title}`).join('; ');
    out.line(t('upgrade.migrations', { from: plan.dataVersion.from, to: plan.dataVersion.to, list }));
  }
  const of = (action, reason) => plan.files.filter((f) => f.action === action && (!reason || f.reason === reason));
  for (const group of ['tests', 'docs']) {
    const n = of('skip', 'optional').filter((f) => f.group === group).length;
    if (n) out.line(t('upgrade.skip.optional', { group, n }));
  }
  for (const [reason, key] of [['missing', 'upgrade.skip.missing'], ['golden', 'upgrade.skip.golden']]) {
    const list = of('skip', reason);
    if (list.length) out.line(t(key, { files: list.map((f) => f.rel).join(', ') }));
  }
  for (const [action, key] of [['propose', 'upgrade.propose'], ['keep', 'upgrade.keep'], ['force', 'upgrade.forced']]) {
    const list = of(action);
    if (!list.length) continue;
    out.line(t(key, { dir: plan.proposedDir }));
    for (const f of list) out.line(`  ${f.rel}`);
  }
  if (plan.refusals.length) {
    out.line(t('upgrade.refused'));
    for (const r of plan.refusals) out.line(`  ${refusalMessage(cfg, r, hints)}`);
  }
  if (plan.blockers.length) {
    out.line(t('upgrade.blocked'));
    for (const b of plan.blockers) out.line(`  ${blockerMessage(cfg, b)}`);
  }
}

function printResult(out, cfg, plan, result, hints) {
  const t = (key, vars) => say(cfg, key, vars);
  if (!result.applied) {
    const failure = result.failure ?? {};
    if (failure.undone) {
      out.line(t('upgrade.undone_meanwhile'));
      return;
    }
    out.line(t('upgrade.failed', { step: failure.step ?? '?', detail: failure.detail ?? '' }));
    if (result.rolledBack) out.line(t('upgrade.rolled_back'));
    else out.line(t('upgrade.restore_failed', { detail: failure.restore ?? '', command: hints.recover(result.backup) }));
    if (failure.saved?.length) out.line(t('upgrade.saved', { dir: failure.savedIn, files: failure.saved.join(', ') }));
    if (failure.unrecorded?.length) out.line(t('upgrade.unrecorded', { files: failure.unrecorded.join(', ') }));
    if (failure.foreign?.length) out.line(t('upgrade.foreign', { files: failure.foreign.join(', ') }));
    return;
  }
  out.line(t('upgrade.applied', { from: plan.from, to: plan.to, backup: result.backup }));
  if (result.migrations.length) {
    out.line(t('upgrade.migrated', { to: plan.dataVersion.to, list: result.migrations.map((m) => m.id).join(', ') }));
  }
  if (result.verify) {
    out.line(t('upgrade.verified'));
    if (result.verify.eval) {
      out.line(t('upgrade.verified_eval', { before: result.verify.eval.before.toFixed(2), after: result.verify.eval.after.toFixed(2) }));
    }
    if (result.verify.newFindings.length) {
      out.line(t('upgrade.new_findings'));
      for (const f of result.verify.newFindings) {
        out.line(`  ${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.code} ${f.root === 'main' ? '' : `${f.root}:`}${f.rel ?? ''}`);
      }
    }
    if (result.verify.foreign?.length) out.line(t('upgrade.foreign', { files: result.verify.foreign.join(', ') }));
  } else {
    out.line(t('upgrade.verify_skipped'));
  }
  if (result.proposed.length) out.line(t('upgrade.proposed_next', { dir: plan.proposedDir }));
  if (plan.git.repo) {
    out.line(t('upgrade.next'));
    out.line('  git add -A');
    out.line(`  git commit -m "memory-kit ${plan.from} → ${plan.to}"`);
  }
  out.line(t('upgrade.undo', { command: hints.rollback(result.backup) }));
}

/** The plan for --json: refusals and blockers carry their message. */
function planJson(cfg, plan, hints = {}) {
  return {
    ...plan,
    refusals: plan.refusals.map((r) => ({ ...r, message: refusalMessage(cfg, r, hints) })),
    blockers: plan.blockers.map((b) => ({ ...b, message: blockerMessage(cfg, b) })),
    forced: plan.forced.map((b) => ({ ...b, message: blockerMessage(cfg, b) })),
  };
}

const writeJson = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------------------------------------
// Rollback

function runRollback(cfg, context, values, id, out, hints) {
  let res;
  try {
    res = rollbackUpgrade(context.root, { id, force: Boolean(values.force), dryRun: Boolean(values['dry-run']) });
  } catch (err) {
    if (!(err instanceof UpgradeError)) throw err;
    const message = errorMessage(cfg, err);
    const nothing = err.code === 'rollback_none';
    if (values.json) {
      writeJson({ runner: hints.runner, rollback: { ok: nothing, code: err.code, ...err.vars, message } });
    } else if (nothing) {
      out.line(message);
      out.flush();
    } else {
      out.err(message);
    }
    return nothing ? 0 : 1;
  }
  const vars = { id: res.id, from: res.from, to: res.to, restored: res.restored.length, removed: res.removed.length };
  let code = 0;
  if (res.already) {
    out.line(say(cfg, 'upgrade.rollback.already', vars));
  } else if (res.conflicts.length && !res.applied && !values['dry-run']) {
    out.line(say(cfg, 'upgrade.rollback.conflicts'));
    for (const rel of res.conflicts) out.line(`  ${rel}`);
    code = 1;
  } else if (!res.id) {
    out.line(say(cfg, res.lockRemoved ? 'upgrade.rollback.lock_removed' : 'upgrade.rollback.lock_would_remove'));
  } else if (!res.applied) {
    out.line(say(cfg, 'upgrade.rollback.plan', vars));
    if (res.conflicts.length) {
      out.line(say(cfg, 'upgrade.rollback.conflicts'));
      for (const rel of res.conflicts) out.line(`  ${rel}`);
    }
  } else {
    out.line(say(cfg, 'upgrade.rollback.done', vars));
    if (res.conflicts.length) {
      out.line(say(cfg, 'upgrade.rollback.saved', { dir: res.savedIn }));
      for (const rel of res.conflicts) out.line(`  ${rel}`);
    }
    if (res.lockRemoved) out.line(say(cfg, 'upgrade.rollback.lock_removed'));
  }
  if (values.json) writeJson({ runner: hints.runner, rollback: { ok: code === 0, ...res } });
  out.flush();
  return code;
}

// ---------------------------------------------------------------------------------------------
// Source and hand-over

function resolveSource(values, context, runnerIsVault) {
  if (values.from !== undefined) {
    const abs = path.resolve(values.from);
    if (isDir(abs) && values.ref === undefined) return { dir: abs, label: abs };
    if (isDir(abs)) return { url: pathToFileURL(abs).href, ref: values.ref, label: `${abs} (${values.ref})` };
    if (isGitUrl(values.from)) return { url: values.from, ref: values.ref, label: values.from + (values.ref ? ` (${values.ref})` : '') };
    return { usage: `--from must be a memory-kit folder or a git URL, got "${values.from}"` };
  }
  if (!runnerIsVault) {
    if (values.ref !== undefined) return { usage: '--ref needs --from <git-url>, or the vault\'s own upgrade command' };
    return { dir: context.kitRoot, label: context.kitRoot };
  }
  const source = readVaultConfig(context.root).source ?? loadManifest(context.root)?.source ?? DEFAULT_SOURCE;
  if (isGitUrl(source)) return { url: source, ref: values.ref, label: source + (values.ref ? ` (${values.ref})` : '') };
  // A folder (an unzipped download of the kit), relative to the vault.
  const abs = path.resolve(context.root, source);
  if (!isDir(abs)) return { missing: source };
  if (values.ref === undefined) return { dir: abs, label: abs };
  return { url: pathToFileURL(abs).href, ref: values.ref, label: `${abs} (${values.ref})` };
}

/**
 * Runs the source kit's own upgrader on the same vault with the same flags → { code, keep }. When
 * it failed and left a lock of its own (killed half way, a crash), says how to undo that upgrade;
 * keep: the source folder is the only upgrader that can (no recovery tool in the backup).
 */
function handOver(sourceDir, context, values, info, cfg, { terminal = false } = {}) {
  const lockBefore = lockState(context.root);
  const args = [absOf(sourceDir, 'system/memory.mjs'), 'upgrade', '--root', context.root, '--from', sourceDir];
  for (const flag of PASS_FLAGS) if (values[flag]) args.push(`--${flag}`);
  const res = spawnSync(process.execPath, args, {
    cwd: context.root,
    encoding: 'utf8',
    windowsHide: true,
    // In a terminal the newer upgrader shows its own screen and asks its own question.
    stdio: terminal ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, [PARENT_ENV]: JSON.stringify(info) },
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) process.stderr.write(`memory: ${res.error.message}\n`);
  const code = !res.error && Number.isInteger(res.status) ? res.status : 3;
  const lock = code !== 0 ? lockState(context.root) : null;
  if (!lock || (lockBefore && lockBefore.backup === lock.backup)) return { code, keep: false };
  const command = lock.recover
    ? `node ${lock.recover}`
    : `node ${quote(absOf(sourceDir, 'system/memory.mjs'))} upgrade --rollback --root ${quote(context.root)}`;
  process.stderr.write(`memory: ${say(cfg, 'upgrade.recover', { command })}\n`);
  return { code, keep: !lock.recover };
}

function newerThan(a, b) {
  if (!parseVersion(a)) return false;
  if (!parseVersion(b)) return true;
  return compareVersions(a, b) > 0;
}

// ---------------------------------------------------------------------------------------------

export async function run(argv, cfg, ctx = {}) {
  const args = [];
  for (const a of argv) {
    if (a.startsWith('--rollback=')) args.push('--rollback', a.slice('--rollback='.length));
    else args.push(a);
  }
  const parsed = parseCli(args, {
    from: { type: 'string' },
    ref: { type: 'string' },
    yes: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
    rollback: { type: 'boolean' },
    'no-verify': { type: 'boolean' },
    json: { type: 'boolean' },
    verbose: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length > (values.rollback ? 1 : 0)) {
    usageError(`unexpected argument "${positionals[values.rollback ? 1 : 0]}"`, usage);
    return 2;
  }
  if (values.rollback && (values.from !== undefined || values.ref !== undefined)) {
    usageError('--rollback restores a backup of this vault; it takes no --from or --ref', usage);
    return 2;
  }

  const root = path.resolve(ctx?.root ?? cfg?.root ?? process.cwd());
  const kitRoot = path.resolve(ctx?.kitRoot ?? path.join(HERE, '..', '..', '..'));
  const context = { root, kitRoot };
  const parent = parentInfo();
  const runnerIsVault = samePath(kitRoot, root);
  const vaultCli = parent ? Boolean(parent.vaultCli) : runnerIsVault;
  const runner = { root: kitRoot, version: readVersion(kitRoot) };
  const out = makeOut(Boolean(values.json));
  const hints = {
    runner,
    // A vault of 0.1.0 has no doctor of its own; this kit's doctor examines it with --root.
    doctor: !runnerIsVault && !isFile(absOf(root, 'system/lib/commands/doctor.mjs'))
      ? `node ${quote(path.join(kitRoot, 'system', 'memory.mjs'))} doctor --root ${quote(root)}`
      : null,
    apply: () => {
      if (typeof parent?.apply === 'string') return parent.apply;
      const parts = runnerIsVault
        ? ['node', 'system/memory.mjs', 'upgrade']
        : ['node', quote(path.join(kitRoot, 'system', 'memory.mjs')), 'upgrade', '--root', quote(root)];
      if (values.from !== undefined) parts.push('--from', quote(values.from));
      if (values.ref !== undefined) parts.push('--ref', quote(values.ref));
      if (values.force) parts.push('--force');
      if (values['no-verify']) parts.push('--no-verify');
      parts.push('--yes');
      return parts.join(' ');
    },
    rollback: (id) => {
      const cli = vaultCli ? 'node system/memory.mjs' : `node ${quote(path.join(root, 'system', 'memory.mjs'))}`;
      return `${cli} upgrade --rollback${id ? ` ${id}` : ''}`;
    },
    // After a failed restore the vault's code may be half replaced: the backup's own tool (or this
    // upgrader, never the vault's CLI) undoes the upgrade.
    recover: (id) => {
      const tool = recoveryTool(id);
      if (isFile(absOf(root, tool))) return vaultCli ? `node ${tool}` : `node ${quote(absOf(root, tool))}`;
      return `node ${quote(path.join(kitRoot, 'system', 'memory.mjs'))} upgrade --rollback ${id} --root ${quote(root)}`;
    },
  };

  if (values.rollback) return runRollback(cfg, context, values, positionals[0], out, hints);

  const src = resolveSource(values, context, runnerIsVault);
  if (src.usage) {
    usageError(src.usage, usage);
    return 2;
  }
  const ui = await terminalUI(ctx, values);
  if (ui) return runScreen(ui, { cfg, values, context, hints, parent, runner, src, runnerIsVault });
  if (src.missing !== undefined) {
    const message = say(cfg, 'upgrade.source_missing', { source: src.missing });
    if (values.json) writeJson({ runner, delegated_from: parent?.version ?? null, plan: null, result: { applied: false, code: 'source_missing', message } });
    else out.err(message);
    return 1;
  }
  let sourceDir = src.dir;
  let cleanup = null;
  let tmpBase = null;
  try {
    if (!sourceDir) {
      if (!values.json) process.stderr.write(`${say(cfg, 'upgrade.fetching', { url: src.label })}\n`);
      try {
        const fetched = cloneKit(src.url, { ref: src.ref });
        sourceDir = fetched.dir;
        cleanup = fetched.cleanup;
        tmpBase = fetched.base;
      } catch (err) {
        if (!(err instanceof UpgradeError)) throw err;
        const message = say(cfg, 'upgrade.fetch_failed', { url: src.label, detail: err.vars.detail });
        if (values.json) {
          writeJson({ runner, delegated_from: parent?.version ?? null, plan: null, result: { applied: false, code: err.code, message } });
        } else {
          out.err(message);
          out.err(say(cfg, 'upgrade.fetch_hint'));
        }
        return 1;
      }
    }

    // The newest upgrader runs: a newer source takes over (once; the child never hands over again).
    if (!samePath(sourceDir, kitRoot)) {
      const sourceVersion = readVersion(sourceDir);
      if (!parseVersion(sourceVersion)) {
        const message = say(cfg, 'upgrade.source_invalid', { source: sourceDir });
        if (values.json) writeJson({ runner, delegated_from: parent?.version ?? null, plan: null, result: { applied: false, code: 'source_invalid', message } });
        else out.err(message);
        return 1;
      }
      if (newerThan(sourceVersion, runner.version) && !parent) {
        if (!values.json) process.stderr.write(`${say(cfg, 'upgrade.delegate', { version: sourceVersion, source: src.label })}\n`);
        const res = handOver(sourceDir, context, values, { version: runner.version, vaultCli: runnerIsVault, apply: hints.apply() }, cfg);
        if (res.keep) cleanup = null;
        return res.code;
      }
      if (runnerIsVault && !values.force && !lockState(root)) {
        const installed = readVersion(root) ?? '0.0.0';
        const message = say(cfg, 'upgrade.up_to_date', { version: installed, source: sourceVersion });
        if (values.json) {
          writeJson({ runner, delegated_from: parent?.version ?? null, plan: null, result: { applied: false, up_to_date: true, installed, source_version: sourceVersion, message } });
        } else {
          out.line(message);
          out.flush();
        }
        return 0;
      }
    }

    const plan = await planUpgrade({ vault: root, source: sourceDir, force: Boolean(values.force) });
    const report = { runner, delegated_from: parent?.version ?? null, plan: planJson(cfg, plan, hints), result: null };
    const finish = (code) => {
      if (values.json) writeJson(report);
      out.flush();
      return code;
    };

    if (plan.upToDate && !values.force && plan.refusals.length === 0 && !plan.lock) {
      const message = say(cfg, 'upgrade.up_to_date', { version: plan.from, source: plan.to });
      report.result = { applied: false, up_to_date: true, installed: plan.from, source_version: plan.to, message };
      out.line(message);
      return finish(0);
    }
    printPlan(out, cfg, plan, hints);
    if (!plan.ok) {
      report.result = { applied: false, refused: plan.refusals.length > 0, blocked: plan.blockers.length > 0 };
      return finish(1);
    }
    if (!values.yes || values['dry-run']) {
      report.result = { applied: false, dry_run: true, apply: hints.apply() };
      out.line(say(cfg, 'upgrade.dry_run'));
      out.line(`  ${hints.apply()}`);
      return finish(0);
    }

    let result;
    try {
      result = await applyUpgrade(plan, { verify: !values['no-verify'] });
    } catch (err) {
      if (!(err instanceof UpgradeError)) throw err;
      const message = errorMessage(cfg, err);
      report.result = { applied: false, code: err.code, message };
      out.line(message);
      return finish(1);
    }
    report.result = result;
    out.line('');
    printResult(out, cfg, plan, result, hints);
    return finish(result.applied ? 0 : 1);
  } finally {
    // Removing the temporary clone is best effort: the upgrade's own result stands.
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        process.stderr.write(`memory: ${say(cfg, 'upgrade.tmp_left', { dir: tmpBase, detail: err?.message ?? String(err) })}\n`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The terminal screen (stdin and stdout are TTYs): the same steps as run, drawn with lib/tui.mjs

/** The UI when both ends are a terminal and --json is off; null otherwise or when lib/tui.mjs cannot load. */
async function terminalUI(ctx, values) {
  if (values.json) return null;
  try {
    if (ctx?.ui) return ctx.ui.tty ? ctx.ui : null;
    if (!process.stdout.isTTY || !process.stdin.isTTY) return null;
    const { createUI } = await import('../tui.mjs');
    const ui = createUI();
    return ui.tty ? ui : null;
  } catch {
    return null;
  }
}

/** Release notes of the kit in dir from its CHANGELOG.md; null when there are none. */
async function whatsNew(dir, from, to) {
  try {
    const { readReleaseNotes } = await import('../changelog.mjs');
    return readReleaseNotes(dir, to, { from, max: NOTES_MAX });
  } catch {
    return null;
  }
}

/** The plan as a few symbol lines (file lists only with --verbose). */
function showPlan(ui, cfg, plan, hints, verbose) {
  const t = (key, vars) => say(cfg, key, vars);
  const { sym, style } = ui;
  const of = (action, reason) => plan.files.filter((f) => f.action === action && (!reason || f.reason === reason));
  const list = (files, glyph, paint) => {
    if (verbose) for (const f of files) ui.message(`  ${glyph} ${f.rel}`, paint);
  };
  ui.step(t('upgrade.ui.plan'), plan.ok ? 'ok' : 'error');
  ui.message(t('upgrade.source', { source: plan.source }), 'dim');
  if (plan.files.length) {
    const c = plan.counts;
    const parts = [[sym.add, c.add, 'upgrade.ui.new', style.ok], [sym.change, c.replace, 'upgrade.ui.changed', style.warn],
      [sym.remove, c.remove, 'upgrade.ui.removed', style.err], [sym.dot, c.unchanged, 'upgrade.ui.unchanged', style.dim]]
      .filter(([, n]) => n > 0).map(([glyph, n, key, paint]) => `${paint(glyph)} ${n} ${t(key)}`);
    if (parts.length) ui.message(parts.join('   '));
    list(of('add'), sym.add, 'ok');
    list(of('replace'), sym.change, 'warn');
    list(of('remove'), sym.remove, 'err');
    const a = plan.agents;
    if (a.action === 'replace') ui.message(`${style.warn(sym.change)} ${t('upgrade.ui.agents')}`);
    else if (a.action !== 'unchanged') {
      const key = `upgrade.agents.${a.state}`;
      if (DEFAULTS[key]) ui.warn(t(key, { template: a.template ?? 'system/templates/<lang>/kit/agents-system.md' }));
    }
  }
  if (plan.migrations.length) {
    const names = plan.migrations.map((m) => `${m.id}: ${m.title}`).join('; ');
    ui.message(`${style.warn(sym.change)} ${t('upgrade.migrations', { from: plan.dataVersion.from, to: plan.dataVersion.to, list: names })}`);
  }
  for (const group of ['tests', 'docs']) {
    const n = of('skip', 'optional').filter((f) => f.group === group).length;
    if (n) ui.message(`${sym.dot} ${t('upgrade.skip.optional', { group, n })}`, 'dim');
  }
  const missing = of('skip', 'missing');
  if (missing.length) ui.message(`${sym.dot} ${t('upgrade.ui.skip_missing', { n: missing.length })}`, 'dim');
  list(missing, sym.dot, 'dim');
  const golden = of('skip', 'golden');
  if (golden.length) ui.message(`${sym.dot} ${t('upgrade.skip.golden', { files: golden.map((f) => f.rel).join(', ') })}`, 'dim');
  let hidden = false;
  for (const [action, key] of [['propose', 'upgrade.ui.propose'], ['keep', 'upgrade.ui.keep'], ['force', 'upgrade.ui.forced']]) {
    const files = of(action);
    if (!files.length) continue;
    ui.warn(t(key, { n: files.length, dir: plan.proposedDir }));
    list(files, sym.keep, 'warn');
    hidden = hidden || !verbose;
  }
  for (const r of plan.refusals) ui.error(refusalMessage(cfg, r, hints));
  for (const b of plan.blockers) ui.error(blockerMessage(cfg, b));
  if (hidden || (!verbose && (of('add').length || of('replace').length || of('remove').length || missing.length))) {
    ui.message(t('upgrade.ui.details'), 'dim');
  }
}

async function showNotes(ui, cfg, dir, plan) {
  const notes = await whatsNew(dir, plan.from, plan.to);
  if (!notes?.headlines.length) return;
  const room = Math.max(12, ui.width() - 8);
  const body = notes.headlines.map((h) => ({ text: ui.truncate(h, room), bullet: ui.sym.bullet }));
  if (notes.more) body.push({ text: say(cfg, 'upgrade.ui.more_notes', { n: notes.more }), tone: 'dim' });
  ui.note(body, say(cfg, 'upgrade.ui.whats_new', { version: plan.to }), { state: 'info' });
}

function showResult(ui, cfg, plan, result, hints) {
  const t = (key, vars) => say(cfg, key, vars);
  if (!result.applied) {
    const failure = result.failure ?? {};
    const body = [];
    if (failure.undone) {
      body.push(t('upgrade.undone_meanwhile'));
    } else {
      body.push(t('upgrade.failed', { step: failure.step ?? '?', detail: failure.detail ?? '' }));
      if (result.rolledBack) body.push({ text: t('upgrade.rolled_back'), tone: 'ok' });
      else body.push({ text: t('upgrade.restore_failed', { detail: failure.restore ?? '', command: hints.recover(result.backup) }), tone: 'err' });
      if (failure.saved?.length) body.push(t('upgrade.saved', { dir: failure.savedIn, files: failure.saved.join(', ') }));
      if (failure.unrecorded?.length) body.push(t('upgrade.unrecorded', { files: failure.unrecorded.join(', ') }));
      if (failure.foreign?.length) body.push(t('upgrade.foreign', { files: failure.foreign.join(', ') }));
    }
    ui.note(body, t('upgrade.ui.what_happened'), { state: 'error' });
    return;
  }
  const body = [{ text: t('upgrade.ui.backup', { backup: result.backup }) }];
  if (result.migrations.length) body.push(t('upgrade.migrated', { to: plan.dataVersion.to, list: result.migrations.map((m) => m.id).join(', ') }));
  if (result.verify) {
    body.push({ text: t('upgrade.verified'), tone: 'ok' });
    if (result.verify.eval) {
      body.push(t('upgrade.verified_eval', { before: result.verify.eval.before.toFixed(2), after: result.verify.eval.after.toFixed(2) }));
    }
    if (result.verify.newFindings.length) body.push({ text: t('upgrade.ui.findings', { n: result.verify.newFindings.length }), tone: 'warn' });
    if (result.verify.foreign?.length) body.push(t('upgrade.foreign', { files: result.verify.foreign.join(', ') }));
  } else {
    body.push({ text: t('upgrade.verify_skipped'), tone: 'warn' });
  }
  if (result.proposed.length) body.push(t('upgrade.proposed_next', { dir: plan.proposedDir }));
  ui.note(body, t('upgrade.ui.done_title', { to: plan.to }), { state: 'ok' });
  // Commands stay outside the box and unwrapped, so they can be copied whole.
  if (plan.git.repo) {
    ui.message(t('upgrade.next'));
    ui.command('git add -A');
    ui.command(`git commit -m "memory-kit ${plan.from} → ${plan.to}"`);
  }
  ui.message(t('upgrade.undo', { command: '' }).trim());
  ui.command(hints.rollback(result.backup));
}

/** run() in a terminal: same decisions and exit codes, drawn as a screen. */
async function runScreen(ui, { cfg, values, context, hints, parent, runner, src, runnerIsVault }) {
  const t = (key, vars) => say(cfg, key, vars);
  const { root } = context;
  ui.setTranslator((key, vars) => (typeof cfg?.t === 'function' ? cfg.t(key, vars) : key));
  const stop = (message) => {
    ui.error(message);
    ui.outro(t('upgrade.ui.stopped'), { state: 'error' });
    return 1;
  };
  try {
    if (src.missing !== undefined) {
      ui.intro('memory-kit', readVersion(root) ?? '');
      return stop(t('upgrade.source_missing', { source: src.missing }));
    }
    let sourceDir = src.dir;
    let cleanup = null;
    let tmpBase = null;
    try {
      if (!sourceDir) {
        const spin = ui.spinner({ spacer: false });
        spin.start(t('upgrade.fetching', { url: src.label }));
        try {
          const fetched = cloneKit(src.url, { ref: src.ref });
          sourceDir = fetched.dir;
          cleanup = fetched.cleanup;
          tmpBase = fetched.base;
          spin.clear();
        } catch (err) {
          if (!(err instanceof UpgradeError)) throw err;
          spin.clear();
          ui.intro('memory-kit', readVersion(root) ?? '');
          ui.error(t('upgrade.fetch_failed', { url: src.label, detail: err.vars.detail }));
          ui.message(t('upgrade.fetch_hint'), 'dim');
          ui.outro(t('upgrade.ui.stopped'), { state: 'error' });
          return 1;
        }
      }

      if (!samePath(sourceDir, context.kitRoot)) {
        const sourceVersion = readVersion(sourceDir);
        if (!parseVersion(sourceVersion)) {
          ui.intro('memory-kit', readVersion(root) ?? '');
          return stop(t('upgrade.source_invalid', { source: sourceDir }));
        }
        if (newerThan(sourceVersion, runner.version) && !parent) {
          // The newer upgrader draws its own screen on the same terminal.
          const res = handOver(sourceDir, context, values, { version: runner.version, vaultCli: runnerIsVault, apply: hints.apply() }, cfg, { terminal: true });
          if (res.keep) cleanup = null;
          return res.code;
        }
        if (runnerIsVault && !values.force && !lockState(root)) {
          const installed = readVersion(root) ?? '0.0.0';
          ui.intro(`memory-kit ${installed}`);
          ui.outro(t('upgrade.up_to_date', { version: installed, source: sourceVersion }));
          return 0;
        }
      }

      const spin = ui.spinner({ spacer: false });
      spin.start(t('upgrade.ui.plan'));
      const plan = await planUpgrade({ vault: root, source: sourceDir, force: Boolean(values.force) });
      spin.clear();
      ui.intro(`memory-kit ${plan.from} ${ui.sym.arrow} ${plan.to ?? '?'}`);
      if (plan.upToDate && !values.force && plan.refusals.length === 0 && !plan.lock) {
        ui.outro(t('upgrade.up_to_date', { version: plan.from, source: plan.to }));
        return 0;
      }
      showPlan(ui, cfg, plan, hints, Boolean(values.verbose));
      if (!plan.ok) {
        ui.outro(t(plan.refusals.length ? 'upgrade.refused' : 'upgrade.blocked').replace(/:$/, ''), { state: 'error' });
        return 1;
      }
      await showNotes(ui, cfg, sourceDir, plan);
      if (values['dry-run']) {
        ui.step(t('upgrade.dry_run'), 'info');
        ui.command(hints.apply());
        ui.outro(t('upgrade.ui.not_now'));
        return 0;
      }
      if (!values.yes && !await ui.confirm({ message: t('upgrade.ui.confirm', { from: plan.from, to: plan.to }), initialValue: true })) {
        ui.outro(t('upgrade.ui.not_now'));
        return 0;
      }

      const work = ui.spinner();
      work.start(t('upgrade.ui.applying'));
      let result;
      try {
        result = await applyUpgrade(plan, { verify: !values['no-verify'] });
      } catch (err) {
        if (!(err instanceof UpgradeError)) throw err;
        work.stop(t('upgrade.ui.applying'), 'error');
        return stop(errorMessage(cfg, err));
      }
      work.stop(result.applied ? t('upgrade.ui.applied', { from: plan.from, to: plan.to }) : t('upgrade.ui.applying'), result.applied ? 'ok' : 'error');
      showResult(ui, cfg, plan, result, hints);
      ui.outro(result.applied ? t('upgrade.ui.done') : t('upgrade.ui.failed'), { state: result.applied ? 'ok' : 'error' });
      return result.applied ? 0 : 1;
    } finally {
      if (cleanup) {
        try {
          cleanup();
        } catch (err) {
          ui.warn(t('upgrade.tmp_left', { dir: tmpBase, detail: err?.message ?? String(err) }));
        }
      }
    }
  } catch (err) {
    if (err?.name === 'Cancelled') {
      ui.cancelled();
      return 130;
    }
    ui.close?.();
    throw err;
  }
}
