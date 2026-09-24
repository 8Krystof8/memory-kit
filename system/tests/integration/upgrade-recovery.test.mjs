// `upgrade` when things go wrong: other programs writing during the checks, an upgrade killed half
// way, a restore that fails, a second command while one runs, odd files (a code-page AGENTS.md,
// CRLF notes in a local root), a parent git repository, a clone that cannot be removed. Every test
// works on a copy of a vault of this kit, upgraded to a synthetic newer kit (HOOK) whose start,
// search and eval run a test hook (UPG_HOOK) around the real command; faults come from a preload
// (UPG_FAULTS) that fails or kills a chosen file operation of the upgrader.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readVersion } from '../../lib/kit.mjs';
import { runMigrations } from '../../lib/migrations.mjs';
import {
  LOCK_FILE, createBackup, ensureExcluded, gitState, listBackups, lockState, planUpgrade, replaceKitBlockBytes,
  restoreBackup, rollbackUpgrade,
} from '../../lib/upgrade.mjs';
import { TODAY, cloneDir, copyKit, overlay, readFile, removeTmpDirs, tmpDir, writeFile, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const SCRUB = ['MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CODE_REMOTE',
  'CODESPACES', 'GITPOD_WORKSPACE_ID', 'MEMORY_KIT_UPGRADE_PARENT', 'UPG_HOOK', 'UPG_FAULTS'];

// ---------------------------------------------------------------------------------------------
// Helpers of this file

const gitConfig = path.join(tmpDir('rec-gitconfig'), 'gitconfig');
fs.writeFileSync(gitConfig, '');

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of SCRUB) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org',
    ...extra,
  };
}

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

const HAS_GIT = (() => {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();

/** Runs node <script> <args> without blocking; env adds to a scrubbed environment. */
function runNode(script, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: cleanEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

/** node <kit>/system/memory.mjs <args> --root <vault>. */
const runKit = (kitDir, vault, args, env) => runNode(path.join(kitDir, 'system', 'memory.mjs'), [...args, '--root', vault], { cwd: vault, env });
/** The vault's own CLI. */
const runCli = (vault, args, env) => runKit(vault, vault, args, env);
/** A command as the upgrade prints it ("node <script> [args]", paths maybe quoted), run in the vault folder. */
function runPrinted(vault, command) {
  const words = [...command.trim().matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map((m) => (m[1] === undefined ? m[2] : m[1].replace(/\\(.)/g, '$1')));
  const [node, script, ...args] = words;
  assert.equal(node, 'node', command);
  return runNode(path.isAbsolute(script) ? script : path.join(vault, script), args, { cwd: vault });
}

/** A process killed by the fault preload (Windows reports no signal, only a failure). */
const killed = (res) => res.signal === 'SIGKILL' || (process.platform === 'win32' && res.code !== 0);

function jsonOf(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** { rel: sha256, 'dir/': 'dir' } of every file and folder under dir (not .git, not .memory-kit). */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(rel ? path.join(dir, ...rel.split('/')) : dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (r === '.git' || r === '.memory-kit') continue;
        out[`${r}/`] = 'dir';
        walk(r);
      } else if (e.isFile()) {
        out[r] = sha(fs.readFileSync(path.join(dir, ...r.split('/'))));
      }
    }
  };
  walk('');
  return out;
}

function assertSameTree(beforeSnap, afterSnap, what) {
  const changed = [];
  for (const key of new Set([...Object.keys(beforeSnap), ...Object.keys(afterSnap)])) {
    if (beforeSnap[key] !== afterSnap[key]) changed.push(`${beforeSnap[key] === undefined ? '+' : afterSnap[key] === undefined ? '-' : '~'} ${key}`);
  }
  assert.deepEqual(changed.sort(), [], what);
}

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const exists = (root, rel) => fs.existsSync(abs(root, rel));
const backupJson = (root, id) => JSON.parse(readFile(root, `.memory-kit/backups/${id}/backup.json`));

/** A copy of the kit (or of a kit dir) whose kit.json is rebuilt by its own release tool. */
async function releasedKit(label, { from, mutate } = {}) {
  const dir = path.join(tmpDir(label), 'kit');
  if (from) cloneDir(from, dir);
  else copyKit(dir);
  if (mutate) mutate(dir);
  const res = await runNode(path.join(dir, 'system', 'tools', 'release.mjs'), ['--root', dir], { cwd: dir });
  assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  return dir;
}

/** A vault of a kit folder: init (combined, local health sector), fixtures, golden, generate. */
async function buildVault(kitDir, label) {
  const base = tmpDir(label);
  const root = path.join(base, 'vault');
  cloneDir(kitDir, root);
  const init = await runNode(path.join(root, 'system', 'init.mjs'), ['--mode', 'combined', '--lang', 'en',
    '--sectors', 'core,work,school,health:local', '--private-root', '../private', '--cleanup', 'none', '--today', TODAY,
    '--yes', '--root', root], { cwd: root });
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
  const fixtures = path.join(root, 'system', 'tests', 'fixtures', 'en');
  overlay(path.join(fixtures, 'vault'), root);
  overlay(path.join(fixtures, 'private'), path.join(base, 'private'));
  fs.copyFileSync(path.join(fixtures, 'golden.json'), path.join(root, 'system', 'tests', 'golden.json'));
  const check = await runCli(root, ['check', '--generate', '--strict', '--today', TODAY, '--json']);
  assert.deepEqual(JSON.parse(check.stdout).errors, [], check.stdout);
  return { base, root };
}

/** A fresh copy of the built vault (with its private root next to it). */
function cloneVault(label) {
  const dest = path.join(tmpDir(label), 'copy');
  cloneDir(VAULT.base, dest);
  return { base: dest, root: path.join(dest, 'vault'), priv: path.join(dest, 'private') };
}

/** Writes a test hook module; UPG_HOOK=<its path> makes HOOK's start, search and eval call it. */
function hookFile(label, body) {
  const file = path.join(tmpDir(label), 'hook.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs';\nimport path from 'node:path';\nexport default async function hook({ command, phase, root }) {\n${body}\n}\n`);
  return file;
}

/**
 * A preload that fails (ENOSPC) or kills the process at the n-th rename onto a path ending in
 * suffix, or fails fs.rmSync on a temporary clone: UPG_FAULTS = "mode|suffix|n,...".
 */
function faultsPreload() {
  const file = path.join(tmpDir('rec-faults'), 'faults.mjs');
  fs.writeFileSync(file, [
    'import fs from \'node:fs\';',
    'const rules = (process.env.UPG_FAULTS ?? \'\').split(\',\').filter(Boolean).map((r) => {',
    '  const [mode, suffix, n] = r.split(\'|\');',
    '  return { mode, suffix, n: Number(n), seen: 0 };',
    '});',
    'const rename = fs.renameSync;',
    'fs.renameSync = function renameSync(from, to) {',
    '  for (const r of rules) {',
    '    if (r.mode === \'rmfail\' || !String(to).endsWith(r.suffix) || ++r.seen !== r.n) continue;',
    '    if (r.mode === \'kill\') process.kill(process.pid, \'SIGKILL\');',
    '    const err = new Error(`ENOSPC: no space left on device, rename -> ${to}`);',
    '    err.code = \'ENOSPC\';',
    '    throw err;',
    '  }',
    '  return rename.call(this, from, to);',
    '};',
    'const rm = fs.rmSync;',
    'fs.rmSync = function rmSync(p, opts) {',
    '  if (rules.some((r) => r.mode === \'rmfail\') && /memory-kit-upgrade-[^/\\\\]+$/.test(String(p))) {',
    '    const err = new Error(`EPERM: operation not permitted, rmdir ${p}`);',
    '    err.code = \'EPERM\';',
    '    throw err;',
    '  }',
    '  return rm.call(this, p, opts);',
    '};',
    '',
  ].join('\n'));
  return file;
}

const faultEnv = (faults) => ({ NODE_OPTIONS: `--import ${pathToFileURL(FAULTS).href}`, UPG_FAULTS: faults });
const vaultSuffix = (rel) => `${path.sep}vault${path.sep}${rel.split('/').join(path.sep)}`;

// ---------------------------------------------------------------------------------------------
// Shared kits and vault (built once; every test works on its own copy)

let SRC; // this kit, released
let HOOK; // a synthetic 0.1.2 whose start, search and eval call the UPG_HOOK module
let VAULT; // an en vault of SRC
let FAULTS; // the fault preload

const WRAPPED = ['start', 'search', 'eval'];

before(async () => {
  FAULTS = faultsPreload();
  SRC = await releasedKit('rec-src');
  const hook = releasedKit('rec-hook', {
    from: SRC,
    mutate: (dir) => {
      writeFile(dir, 'system/VERSION', '0.1.2\n');
      for (const lang of ['en', 'cs']) {
        const rel = `system/templates/${lang}/kit/agents-system.md`;
        const text = readFile(dir, rel);
        const nl = text.indexOf('\n');
        writeFile(dir, rel, text.slice(0, nl).replace(/v\d+\.\d+\.\d+/, 'v0.1.2') + text.slice(nl));
      }
      fs.appendFileSync(path.join(dir, 'system', 'lib', 'fingerprint.mjs'), '// 0.1.2\n');
      writeFile(dir, 'system/lib/next-extra.mjs', 'export const NEXT = true;\n');
      for (const name of WRAPPED) {
        const commands = path.join(dir, 'system', 'lib', 'commands');
        fs.renameSync(path.join(commands, `${name}.mjs`), path.join(commands, `${name}-real.mjs`));
        fs.writeFileSync(path.join(commands, `${name}.mjs`), [
          'import { pathToFileURL } from \'node:url\';',
          `import * as real from './${name}-real.mjs';`,
          '',
          `export * from './${name}-real.mjs';`,
          '',
          'export async function run(argv, cfg, ctx) {',
          '  const hook = process.env.UPG_HOOK ? (await import(pathToFileURL(process.env.UPG_HOOK).href)).default : null;',
          '  const root = cfg?.root ?? ctx?.root;',
          `  const early = hook ? await hook({ command: '${name}', phase: 'before', root }) : undefined;`,
          '  if (early !== undefined) return early;',
          '  const code = await real.run(argv, cfg, ctx);',
          `  if (hook) await hook({ command: '${name}', phase: 'after', root });`,
          '  return code;',
          '}',
          '',
        ].join('\n'));
      }
    },
  });
  [HOOK, VAULT] = await Promise.all([hook, buildVault(SRC, 'rec-vault')]);
});

// ---------------------------------------------------------------------------------------------
// Other programs writing while the checks run

describe('a note another program saves while the checks run', { concurrency: 4 }, () => {
  test('survives the automatic rollback of a failed verification and is reported', async () => {
    const v = cloneVault('rec-foreign-auto');
    const beforeSnap = snapshot(v.root);
    const hook = hookFile('rec-foreign-auto-hook', [
      '  if (command !== \'start\') return undefined;',
      '  fs.writeFileSync(path.join(root, \'inbox\', \'from-phone.md\'), \'# From the phone\\n\\nCall the dentist.\\n\');',
      '  process.stderr.write(\'boom\\n\');',
      '  return 3;',
    ].join('\n'));
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json'], { UPG_HOOK: hook });
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.equal(out.result.failure.step, 'start');
    assert.equal(out.result.rolledBack, true);
    assert.deepEqual(out.result.failure.foreign, ['inbox/from-phone.md']);
    assert.equal(readFile(v.root, 'inbox/from-phone.md'), '# From the phone\n\nCall the dentist.\n', 'the note is kept');
    const afterSnap = snapshot(v.root);
    delete afterSnap['inbox/from-phone.md'];
    assertSameTree(beforeSnap, afterSnap, 'everything else is as it was');
    assert.deepEqual(listBackups(v.root), []);

    fs.rmSync(abs(v.root, 'inbox/from-phone.md'));
    const human = await runKit(HOOK, v.root, ['upgrade', '--yes'], { UPG_HOOK: hook });
    assert.match(human.stdout, /other programs created while the checks ran were left as they are: inbox\/from-phone\.md/);
    assert.ok(exists(v.root, 'inbox/from-phone.md'));
  });

  test('is not recorded as created by the upgrade, so a later --rollback keeps it', async () => {
    const v = cloneVault('rec-foreign-manual');
    const beforeSnap = snapshot(v.root);
    const hook = hookFile('rec-foreign-manual-hook', [
      '  if (command !== \'eval\' || phase !== \'after\') return undefined;',
      '  fs.writeFileSync(path.join(root, \'inbox\', \'from-phone.md\'), \'# From the phone\\n\');',
      '  return undefined;',
    ].join('\n'));
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json'], { UPG_HOOK: hook });
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const id = jsonOf(res).result.backup;
    assert.ok(exists(v.root, 'inbox/from-phone.md'), 'the hook ran during the verification');
    assert.deepEqual(jsonOf(res).result.verify.foreign, ['inbox/from-phone.md'], 'reported after a success too');
    assert.ok(!backupJson(v.root, id).files.some((f) => f.rel === 'inbox/from-phone.md'), 'not in the backup');

    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.equal(readFile(v.root, 'inbox/from-phone.md'), '# From the phone\n');
    const afterSnap = snapshot(v.root);
    delete afterSnap['inbox/from-phone.md'];
    assertSameTree(beforeSnap, afterSnap, 'the upgrade is undone, the note stays');
  });

  test('a created file the upgrade cannot prove it wrote is never removed without a copy', () => {
    const root = tmpDir('rec-created');
    const b = createBackup(root, { from: '1.0.0', to: '1.1.0' });
    b.recordCreated([{ rel: '_ai/new.md', kind: 'generated' }, 'notes/x.md'], new Set());
    writeFile(root, '_ai/new.md', 'generated\n');
    writeFile(root, 'notes/x.md', 'mine\n');
    b.finish();
    const refused = restoreBackup(root, b.dir);
    assert.deepEqual(refused.conflicts, ['notes/x.md']);
    assert.equal(refused.applied, false);
    assert.ok(exists(root, 'notes/x.md') && exists(root, '_ai/new.md'), 'nothing removed');
    const forced = restoreBackup(root, b.dir, { force: true });
    assert.equal(forced.applied, true);
    assert.ok(!exists(root, '_ai/new.md'), 'the generated file goes');
    assert.equal(fs.readFileSync(path.join(b.dir, 'conflicts', 'notes', 'x.md'), 'utf8'), 'mine\n', 'the other one is kept in the backup');
  });
});

// ---------------------------------------------------------------------------------------------
// Interrupted upgrades and their recovery

describe('an interrupted upgrade', { concurrency: 4 }, () => {
  test('--rollback never overwrites edits made after the interruption without saving them', async () => {
    const v = cloneVault('rec-interrupted');
    const note = 'sectors/work/client-feedback-lessons.md';
    writeFile(v.root, note, readFile(v.root, note).replace(/\n/g, '\r\n'));
    const beforeSnap = snapshot(v.root);
    // Killed right after the checks ran: the lock stays, the backup never reaches 'applied'.
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes'], faultEnv(`kill|${path.sep}backup.json|4`));
    assert.ok(killed(res), `${res.code} ${res.signal}\n${res.stdout}\n${res.stderr}`);
    const lock = lockState(v.root);
    assert.ok(lock && !lock.running, 'an interrupted upgrade left its lock');
    assert.equal(backupJson(v.root, lock.backup).state, 'started');
    assert.equal(readVersion(v.root), '0.1.2');
    assert.ok(!readFile(v.root, note).includes('\r\n'), 'the checks normalized the note');

    // The vault keeps working; the owner adds a decision and a rule.
    writeFile(v.root, note, `${readFile(v.root, note)}- [decision] Invoices go out on Fridays.\n`);
    const agents = `${readFile(v.root, 'AGENTS.md')}- A rule added after the interruption.\n`;
    writeFile(v.root, 'AGENTS.md', agents);
    const noted = readFile(v.root, note);

    const dry = await runCli(v.root, ['upgrade', '--rollback', '--dry-run', '--json']);
    assert.deepEqual(jsonOf(dry).rollback.conflicts, ['AGENTS.md', note]);
    const refused = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /changed after the upgrade, so nothing was restored/);
    assert.equal(readFile(v.root, 'AGENTS.md'), agents, 'nothing restored');

    // The backup's own tool undoes it; --force keeps the later edits in the backup.
    const tool = await runPrinted(v.root, `node ${lock.recover} --force`);
    assert.equal(tool.code, 0, `${tool.stdout}\n${tool.stderr}`);
    assert.match(tool.stdout, /saved under \.memory-kit\/backups\//);
    assertSameTree(beforeSnap, snapshot(v.root), 'as before the upgrade, the CRLF note included');
    const saved = path.join(v.root, '.memory-kit', 'backups', lock.backup, 'conflicts');
    assert.equal(fs.readFileSync(path.join(saved, 'AGENTS.md'), 'utf8'), agents);
    assert.equal(fs.readFileSync(path.join(saved, ...note.split('/')), 'utf8'), noted);
    assert.equal(lockState(v.root), null);
  });

  test('a file the interrupted upgrade left alone keeps a later edit: memory.json', async () => {
    const v = cloneVault('rec-interrupted-config');
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes'], faultEnv(`kill|${path.sep}backup.json|4`));
    assert.ok(killed(res), `${res.code} ${res.signal}\n${res.stdout}\n${res.stderr}`);
    const lock = lockState(v.root);
    assert.ok(lock && !lock.running, 'an interrupted upgrade left its lock');
    const entry = backupJson(v.root, lock.backup).files.find((f) => f.rel === 'memory.json');
    assert.equal(entry.next, entry.sha256, 'planned to stay as it was');

    const config = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...config, search: { ...config.search, n: 8 } });
    const edited = readFile(v.root, 'memory.json');
    const back = await runCli(v.root, ['upgrade', '--rollback', '--json']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.deepEqual(jsonOf(back).rollback.conflicts, []);
    assert.equal(readFile(v.root, 'memory.json'), edited, 'the owner\'s edit stays');
    assert.equal(readVersion(v.root), '0.1.1');
    assert.equal(lockState(v.root), null);
  });

  test('a restore that fails too names a command that works (the backup\'s tool), and it does', async () => {
    const v = cloneVault('rec-restore-failed');
    const beforeSnap = snapshot(v.root);
    const faults = `enospc|${vaultSuffix('system/kit.json')}|1,enospc|${vaultSuffix('system/lib/fingerprint.mjs')}|2`;
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes'], faultEnv(faults));
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /the upgrade failed \(apply\): ENOSPC/);
    const m = /restoring the backup failed as well \(.*\); run: (node .+)$/m.exec(res.stdout);
    assert.ok(m, res.stdout);
    assert.match(m[1], /\.memory-kit[\\/]+backups[\\/]+\d{8}-\d{6}-0\.1\.1-to-0\.1\.2[\\/]+tool[\\/]+rollback\.mjs"?$/);
    const back = await runPrinted(v.root, m[1]);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assertSameTree(beforeSnap, snapshot(v.root), 'restored byte for byte');
    assert.equal(lockState(v.root), null);
  });

  test('a hand-over child killed half way: the parent says how to undo it; no temporary file stays', async () => {
    const v = cloneVault('rec-handover-kill');
    const beforeSnap = snapshot(v.root);
    const res = await runCli(v.root, ['upgrade', '--from', HOOK, '--yes'], faultEnv(`kill|${vaultSuffix('system/kit.json')}|1`));
    assert.notEqual(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const m = /the upgrade stopped before it finished; undo it with: (node \S+)/.exec(res.stderr);
    assert.ok(m, res.stderr);
    assert.match(m[1], /^node \.memory-kit\/backups\/.+\/tool\/rollback\.mjs$/);
    assert.ok(fs.readdirSync(abs(v.root, 'system')).some((n) => /^\.kit\.json\.tmp-\d+-/.test(n)), 'the killed write left its temporary file');
    const back = await runPrinted(v.root, m[1]);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assertSameTree(beforeSnap, snapshot(v.root), 'restored, and the temporary file is gone');
  });

  test('what a migration wrote before the interruption is undone without conflicts; a later edit is one', async () => {
    const root = tmpDir('rec-migration');
    writeFile(root, 'state.md', 'state\n');
    writeFile(root, 'inbox/idea.md', 'idea\n');
    writeJson(root, 'memory.json', { version: 1, lang: 'en' });
    const beforeSnap = snapshot(root);
    const b = createBackup(root, { from: '0.1.1', to: '0.2.0' });
    const chain = [{
      id: 't', from: 1, to: 2, title: 't',
      run(ctx) {
        ctx.writeText('state.md', 'state, migrated\n');
        ctx.move('inbox/idea.md', 'archive/inbox/idea.md');
      },
    }];
    await runMigrations(chain, { root, lang: 'en', record: (rel) => b.record(rel), wrote: (rel) => b.wrote(rel) });
    const next = Object.fromEntries(b.data.files.map((f) => [f.rel, f.next]));
    assert.equal(next['state.md'], sha('state, migrated\n'));
    assert.equal(next['inbox/idea.md'], null, 'moved away');
    assert.equal(next['archive/inbox/idea.md'], sha('idea\n'));
    assert.equal(next['memory.json'], sha(readFile(root, 'memory.json')));
    // Killed here (never 'applied'): a plain restore needs no --force.
    assert.deepEqual(restoreBackup(root, b.dir, { dryRun: true }).conflicts, []);
    writeFile(root, 'archive/inbox/idea.md', 'idea, edited later\n');
    assert.deepEqual(restoreBackup(root, b.dir, { dryRun: true }).conflicts, ['archive/inbox/idea.md']);
    writeFile(root, 'archive/inbox/idea.md', 'idea\n');
    assert.equal(restoreBackup(root, b.dir).applied, true);
    assertSameTree(beforeSnap, snapshot(root), 'the migration is undone');
  });

  test('restoreBackup removes only the temporary files of the upgrade\'s own process', () => {
    const root = tmpDir('rec-temp');
    writeFile(root, 'dir/a.txt', 'a\n');
    const b = createBackup(root, { from: '1.0.0', to: '1.1.0' });
    b.recordMany([{ rel: 'dir/a.txt', next: sha('A\n') }]);
    writeFile(root, 'dir/a.txt', 'A\n');
    writeFile(root, `dir/.a.txt.tmp-${process.pid}-abc123`, 'half');
    writeFile(root, 'dir/.a.txt.tmp-1-abc123', 'someone else');
    writeFile(root, `dir/.b.txt.tmp-${process.pid}-abc123`, 'not ours to judge');
    const res = restoreBackup(root, b.dir);
    assert.deepEqual(res.temp, [`dir/.a.txt.tmp-${process.pid}-abc123`]);
    assert.equal(readFile(root, 'dir/a.txt'), 'a\n');
    assert.ok(exists(root, 'dir/.a.txt.tmp-1-abc123') && exists(root, `dir/.b.txt.tmp-${process.pid}-abc123`));
  });
});

// ---------------------------------------------------------------------------------------------
// A second command while an upgrade runs

describe('an upgrade that is still running', { concurrency: 4 }, () => {
  test('is neither undone nor overridden by a second command', async () => {
    const v = cloneVault('rec-running');
    // A live process that looks like an upgrader holds the lock.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'memory.mjs', 'upgrade'], { stdio: 'ignore', windowsHide: true });
    try {
      writeJson(v.root, LOCK_FILE, { backup: '20260924-100000-0.1.1-to-0.1.2', from: '0.1.1', to: '0.1.2', started: new Date().toISOString(), pid: sleeper.pid, host: os.hostname() });
      assert.equal(lockState(v.root).running, true);
      const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--force', '--json']);
      assert.equal(res.code, 1, res.stdout);
      const refusal = jsonOf(res).plan.refusals.find((r) => r.code === 'running');
      assert.ok(refusal, res.stdout);
      assert.match(refusal.message, new RegExp(`is running right now \\(process ${sleeper.pid}\\)`));
      assert.doesNotMatch(refusal.message, /--rollback/);
      for (const args of [['upgrade', '--rollback'], ['upgrade', '--rollback', '--force']]) {
        const back = await runCli(v.root, args);
        assert.equal(back.code, 1, back.stdout);
        assert.match(back.stderr, /is running right now/);
      }
      assert.throws(() => rollbackUpgrade(v.root, { force: true }), (err) => err.code === 'rollback_running');
    } finally {
      sleeper.kill();
    }
    await new Promise((resolve) => sleeper.once('exit', resolve));
    assert.equal(lockState(v.root).running, false, 'a dead process no longer counts');
    const cleared = await runCli(v.root, ['upgrade', '--rollback', '--force']);
    assert.equal(cleared.code, 0, cleared.stderr);
  });

  test('an upgrade whose lock another command removed does not report success', async () => {
    const v = cloneVault('rec-undone');
    const hook = hookFile('rec-undone-hook', [
      '  if (command !== \'eval\' || phase !== \'after\') return undefined;',
      '  fs.rmSync(path.join(root, \'.memory-kit\', \'upgrade.lock\'));',
      '  return undefined;',
    ].join('\n'));
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json'], { UPG_HOOK: hook });
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.equal(out.result.applied, false);
    assert.equal(out.result.failure.undone, true);
    assert.equal(backupJson(v.root, out.result.backup).state, 'started', 'the backup does not claim the upgrade finished');
    const human = await runKit(HOOK, cloneVault('rec-undone-2').root, ['upgrade', '--yes'], { UPG_HOOK: hook });
    assert.match(human.stdout, /another command undid this upgrade while it ran/);
  });
});

// ---------------------------------------------------------------------------------------------
// Files the upgrade must leave as they are

describe('files the upgrade must keep byte for byte', { concurrency: 4 }, () => {
  // "## Moje / Příliš žluťoučký" in Windows-1250, after the kit section.
  const CP1250 = Buffer.from([0x0a, 0x23, 0x23, 0x20, 0x4d, 0x6f, 0x6a, 0x65, 0x0a, 0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a, 0x20,
    0x9e, 0x6c, 0x75, 0x9d, 0x6f, 0x75, 0xe8, 0x6b, 0xfd, 0x0a]);

  test('personal text in a code page other than UTF-8 stays in AGENTS.md byte for byte', async () => {
    const v = cloneVault('rec-cp1250');
    fs.appendFileSync(abs(v.root, 'AGENTS.md'), CP1250);
    const tail = (buf) => buf.subarray(buf.indexOf('<!-- kit:end -->'));
    const beforeBuf = fs.readFileSync(abs(v.root, 'AGENTS.md'));
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(jsonOf(res).plan.agents.action, 'replace');
    const afterBuf = fs.readFileSync(abs(v.root, 'AGENTS.md'));
    assert.ok(tail(afterBuf).equals(tail(beforeBuf)), 'the bytes after the kit section');
    assert.match(afterBuf.toString('latin1').split('\n')[0], /kit:start v0\.1\.2 /);
  });

  test('replaceKitBlockBytes: UTF-8 as text, other bytes spliced, UTF-16 left alone', () => {
    const block = '<!-- kit:start v2 · nové -->\nrules\n<!-- kit:end -->\n';
    const utf8 = Buffer.from('﻿<!-- kit:start v1 -->\nold\n<!-- kit:end -->\nmoje\n', 'utf8');
    assert.equal(replaceKitBlockBytes(utf8, block).bytes.toString('utf8'), `﻿${block}moje\n`);
    const mixed = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!-- kit:start v1 -->\r\nold\r\n<!-- kit:end -->\r\n'), CP1250]);
    const res = replaceKitBlockBytes(mixed, block);
    assert.equal(res.state, 'replaced');
    assert.ok(res.bytes.equals(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(block.replace(/\n/g, '\r\n'), 'utf8'), CP1250])));
    assert.equal(replaceKitBlockBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<!-- kit:start -->\n', 'utf16le')]), block).state, 'encoding');
  });

  test('a UTF-16 AGENTS.md is left alone and reported', async () => {
    const v = cloneVault('rec-utf16');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(readFile(v.root, 'AGENTS.md'), 'utf16le')]);
    fs.writeFileSync(abs(v.root, 'AGENTS.md'), utf16);
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--no-verify']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /AGENTS\.md is saved as UTF-16, so the kit section was not updated/);
    assert.ok(fs.readFileSync(abs(v.root, 'AGENTS.md')).equals(utf16));
  });

  test('a CRLF note in a local root is restored by the automatic rollback, and by --rollback', async () => {
    const v = cloneVault('rec-local');
    const rel = 'sectors/health/running-plan.md';
    writeFile(v.priv, rel, readFile(v.priv, rel).replace(/\n/g, '\r\n'));
    const privBefore = snapshot(v.priv);
    const fail = hookFile('rec-local-hook', '  return command === \'start\' ? 3 : undefined;');
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json'], { UPG_HOOK: fail });
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.equal(out.result.rolledBack, true);
    assert.deepEqual(out.result.failure.unrecorded, []);
    assertSameTree(privBefore, snapshot(v.priv), 'the local root as it was, CRLF included');
    assert.ok(!exists(v.priv, '.memory-kit'), 'the copy inside the local root is gone with the backup');

    const ok = await runKit(HOOK, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
    const id = jsonOf(ok).result.backup;
    assert.ok(!readFile(v.priv, rel).includes('\r\n'), 'the checks normalized it');
    const inVault = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).filter((n) => n.endsWith('running-plan.md'));
    assert.deepEqual(inVault(path.join(v.root, '.memory-kit')), [], 'a private note is never copied into the vault');
    assert.ok(exists(v.priv, `.memory-kit/backups/${id}/files/${rel}`), 'its copy stays inside its own root');
    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assertSameTree(privBefore, snapshot(v.priv), 'restored by --rollback too');

    // A local note edited after the upgrade keeps the edit; only its line ends would have changed.
    const again = await runKit(HOOK, v.root, ['upgrade', '--yes']);
    assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
    const edited = `${readFile(v.priv, rel)}- one more run\n`;
    writeFile(v.priv, rel, edited);
    const back2 = await runCli(v.root, ['upgrade', '--rollback', '--json']);
    assert.equal(back2.code, 0, `${back2.stdout}\n${back2.stderr}`);
    assert.deepEqual(jsonOf(back2).rollback.skipped, [`private:${rel}`]);
    assert.equal(readFile(v.priv, rel), edited);
  });

  test('the .gitignore block the checks maintain is theirs; any other line is the owner\'s', async () => {
    const { gitignoreText } = await import('../../lib/generate.mjs');
    const cfg = { dirs: { sectors: 'sectors', archive: 'archive' }, exportSuffix: '-export' };
    const withBlock = gitignoreText(cfg, { sectors: [{ id: 'health', privacy: 'local' }] }, 'node_modules/\n');
    assert.match(withBlock, /memory-kit:local-sectors start/);
    for (const [now, expected] of [[withBlock, []], [`${withBlock}my-secrets/\n`, ['.gitignore']]]) {
      const root = tmpDir('rec-gitignore');
      writeFile(root, '.gitignore', 'node_modules/\n');
      const b = createBackup(root, { from: '1.0.0', to: '1.1.0' });
      b.recordMany([{ rel: '.gitignore', kind: 'gitignore' }]);
      writeFile(root, '.gitignore', now); // what the checks (and maybe the owner) wrote, then killed
      assert.deepEqual(restoreBackup(root, b.dir, { dryRun: true }).conflicts, expected);
    }
  });

  test('later searches do not block --rollback, and their log lines stay', async () => {
    const v = cloneVault('rec-searchlog');
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...memory, search: { ...memory.search, log: true } });
    assert.equal((await runCli(v.root, ['search', 'memory'])).code, 0);
    const res = await runKit(HOOK, v.root, ['upgrade', '--yes']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const log = 'system/usage/search.log';
    assert.equal(readFile(v.root, log).trim().split('\n').length, 1, 'the verification\'s own search is not logged');
    for (const q of ['invoice', 'budget']) assert.equal((await runCli(v.root, ['search', q])).code, 0);
    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.equal(readVersion(v.root), '0.1.1');
    assert.equal(readFile(v.root, log).trim().split('\n').length, 3, 'every search is still logged');
  });
});

// ---------------------------------------------------------------------------------------------
// Backups, sources, git

describe('backup order, sources and git', { concurrency: 4 }, () => {
  test('backup ids are UTC and the newest backup is the newest created, across the DST fall-back', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Europe/Prague';
    try {
      const root = tmpDir('rec-dst');
      writeFile(root, 'a.txt', 'a\n');
      const first = createBackup(root, { from: '0.1.1', to: '0.1.2', now: new Date('2026-10-25T00:50:00Z') }); // 02:50 CEST
      first.recordMany([{ rel: 'a.txt', next: sha('b\n') }]);
      writeFile(root, 'a.txt', 'b\n');
      first.finish();
      const second = createBackup(root, { from: '0.1.2', to: '0.1.3', now: new Date('2026-10-25T01:10:00Z') }); // 02:10 CET
      second.recordMany([{ rel: 'a.txt', next: sha('c\n') }]);
      writeFile(root, 'a.txt', 'c\n');
      second.finish();
      assert.equal(first.id, '20261025-005000-0.1.1-to-0.1.2');
      assert.equal(second.id, '20261025-011000-0.1.2-to-0.1.3');
      assert.deepEqual(listBackups(root).map((b) => b.id), [second.id, first.id]);
      const res = rollbackUpgrade(root, {});
      assert.equal(res.id, second.id);
      assert.deepEqual(res.conflicts, []);
      assert.equal(readFile(root, 'a.txt'), 'b\n');

      // Backups named in local time (older builds): creation time decides, not the name.
      const legacy = tmpDir('rec-dst-legacy');
      for (const [id, created] of [['20261025-025000-1.0.0-to-1.0.1', '2026-10-25T00:50:00.000Z'], ['20261025-021000-1.0.1-to-1.0.2', '2026-10-25T01:10:00.000Z']]) {
        writeJson(legacy, `.memory-kit/backups/${id}/backup.json`, { id, from: 'x', to: 'y', created, state: 'applied', files: [] });
      }
      assert.deepEqual(listBackups(legacy).map((b) => b.id), ['20261025-021000-1.0.1-to-1.0.2', '20261025-025000-1.0.0-to-1.0.1']);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  test('memory.json kit.source may name a folder, absolute or relative to the vault', async () => {
    const v = cloneVault('rec-source-dir');
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    for (const source of [HOOK, path.relative(v.root, HOOK)]) {
      writeJson(v.root, 'memory.json', { ...memory, kit: { source } });
      const res = await runCli(v.root, ['upgrade', '--json']);
      assert.equal(res.code, 0, `${source}:\n${res.stdout}\n${res.stderr}`);
      const out = jsonOf(res);
      assert.equal(out.runner.version, '0.1.2', source);
      assert.equal(out.result.dry_run, true);
    }
    writeJson(v.root, 'memory.json', { ...memory, kit: { source: 'no-such-folder' } });
    const missing = await runCli(v.root, ['upgrade']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /kit\.source is neither a git URL nor a folder: no-such-folder/);
  });

  test('a vault in an untracked folder of another repository is not under git', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    const v = cloneVault('rec-parent-repo');
    const home = v.base; // the folder that holds vault/ and private/
    fs.writeFileSync(path.join(home, '.bashrc'), 'alias ll="ls -l"\n');
    git(home, ['init', '-q', '-b', 'main']);
    git(home, ['add', '.bashrc']);
    git(home, ['commit', '-q', '-m', 'dotfiles']);
    assert.deepEqual(gitState(v.root), { repo: false, dirty: new Set() });
    assert.equal(ensureExcluded(v.root), false);
    const exclude = path.join(home, '.git', 'info', 'exclude');
    assert.ok(!(fs.existsSync(exclude) && fs.readFileSync(exclude, 'utf8').includes('.memory-kit')), 'the parent repository is not touched');
    const plan = await planUpgrade({ vault: v.root, source: HOOK });
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.git.repo, false);

    // Once the parent repository tracks the vault, its changes count again.
    git(home, ['add', 'vault']);
    git(home, ['commit', '-q', '-m', 'vault']);
    writeFile(v.root, 'AGENTS.md', `${readFile(v.root, 'AGENTS.md')}- uncommitted\n`);
    const tracked = gitState(v.root);
    assert.equal(tracked.repo, true);
    assert.deepEqual([...tracked.dirty], ['AGENTS.md']);
  });

  test('a temporary clone that cannot be removed does not turn a verified upgrade into a failure', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    const repo = path.join(tmpDir('rec-clone-repo'), 'memory-kit');
    cloneDir(HOOK, repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'memory-kit 0.1.2']);
    // The clones go to a temporary folder of this test (removed with the others), so the clones of
    // tests running at the same time in other files are never touched.
    const temp = tmpDir('rec-clone-tmp');
    const env = { ...faultEnv('rmfail||0'), TMPDIR: temp, TEMP: temp, TMP: temp };
    const v = cloneVault('rec-clone-left');
    const res = await runCli(v.root, ['upgrade', '--from', pathToFileURL(repo).href, '--yes', '--json'], env);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(jsonOf(res).result.applied, true);
    assert.match(res.stderr, /the temporary folder .*memory-kit-upgrade-.* could not be removed/);
    assert.ok(fs.readdirSync(temp).some((n) => n.startsWith('memory-kit-upgrade-')), 'the clone stays where it was made');
    const bad = await runCli(v.root, ['upgrade', '--from', pathToFileURL(`${repo}-missing`).href], env);
    assert.equal(bad.code, 1, `${bad.stdout}\n${bad.stderr}`);
    assert.match(bad.stderr, /could not be downloaded/);
    assert.doesNotMatch(bad.stderr, /and the repository exists/, 'git\'s first error line, not its closing advice');
  });

  test('--rollback --force --dry-run of a lock left alone says what it would do', async () => {
    const v = cloneVault('rec-dry-lock');
    writeFile(v.root, LOCK_FILE, 'garbage\n');
    const dry = await runCli(v.root, ['upgrade', '--rollback', '--force', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /dry run: the lock of the interrupted upgrade would be removed; nothing was changed/);
    assert.doesNotMatch(dry.stdout, /was removed/);
    assert.ok(exists(v.root, LOCK_FILE));
    const real = await runCli(v.root, ['upgrade', '--rollback', '--force']);
    assert.match(real.stdout, /the lock of the interrupted upgrade was removed/);
    assert.ok(!exists(v.root, LOCK_FILE));
  });
});
