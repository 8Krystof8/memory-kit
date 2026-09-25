// `upgrade` end to end on real vaults (copy of the kit + init + fixture notes), plus the library
// pieces it is built from: the AGENTS.md kit section, migrations, backups and git state.
// A 0.1.0 vault comes from `git archive cf74578` (skipped when that commit is not in the clone);
// everything else upgrades a vault of this kit to synthetic newer kits made from a copy of it.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hashFile, loadManifest, readVersion } from '../../lib/kit.mjs';
import {
  MigrationError, migrationChain, migrationContext, runMigrations, validateMigrations,
} from '../../lib/migrations.mjs';
import {
  LOCK_FILE, agentsTemplate, createBackup, gitState, isGitUrl, listBackups, lockState, planUpgrade, pruneBackups,
  replaceKitBlock, restoreBackup, rollbackUpgrade, samePath,
} from '../../lib/upgrade.mjs';
import {
  KIT_ROOT, TODAY, agentHome, cloneDir, copyKit, describeFindings, overlay, readFile, removeTmpDirs, tmpDir, writeFile, writeJson,
} from '../helpers.mjs';

// The kit's own version and the synthetic ones around it, so a release does not break the tests.
const CUR = fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
const [MAJ, MIN, PAT] = CUR.split('.').map(Number);
const NXT = `${MAJ}.${MIN}.${PAT + 1}`;
const NXT2 = `${MAJ}.${MIN}.${PAT + 2}`;
const esc = (v) => v.replace(/\./g, '\\.');

after(removeTmpDirs);

const V010 = 'cf74578';
const SCRUB = ['MEMORY_SECTORS', 'MEMORY_SEARCH_ENGINE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'CLAUDE_CODE_REMOTE',
  'CODESPACES', 'GITPOD_WORKSPACE_ID', 'MEMORY_KIT_UPGRADE_PARENT'];

// ---------------------------------------------------------------------------------------------
// Helpers of this file

const gitConfig = path.join(tmpDir('upg-gitconfig'), 'gitconfig');
fs.writeFileSync(gitConfig, '');

function gitEnv() {
  const env = { ...process.env };
  for (const key of SCRUB) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.org',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.org',
  };
}

function git(cwd, args, { input, encoding = 'utf8' } = {}) {
  const res = spawnSync('git', args, { cwd, env: gitEnv(), input, encoding, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

const HAS_GIT = (() => {
  const res = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();
const HAS_V010 = HAS_GIT && (() => {
  const res = spawnSync('git', ['cat-file', '-e', `${V010}^{commit}`], { cwd: KIT_ROOT, stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();
const NO_V010 = !HAS_V010 && `commit ${V010} (memory-kit 0.1.0) is not in this clone`;
// The first 0.1.2, merged into the public main before its review: the release is another build of it.
const DRAFT012 = 'f2c6ac3';
const NO_DRAFT012 = !(HAS_GIT && spawnSync('git', ['cat-file', '-e', `${DRAFT012}^{commit}`], { cwd: KIT_ROOT, stdio: 'ignore', windowsHide: true }).status === 0)
  && `commit ${DRAFT012} (the 0.1.2 draft) is not in this clone`;

/** Runs node <script> <args> without blocking, so independent tests run side by side. */
function runNode(script, args, { cwd, env } = {}) {
  const base = { ...process.env };
  for (const key of SCRUB) delete base[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd, env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
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
const runKit = (kitDir, vault, args) => runNode(path.join(kitDir, 'system', 'memory.mjs'), [...args, '--root', vault], { cwd: vault });
/** The vault's own CLI. */
const runCli = (vault, args) => runKit(vault, vault, args);

async function checkJson(root, args) {
  const res = await runCli(root, ['check', ...args, '--json']);
  try {
    return { code: res.code, ...JSON.parse(res.stdout) };
  } catch {
    throw new Error(`check --json printed no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}

function jsonOf(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
/** An argument as the upgrade quotes it in the commands it prints. */
const shellArg = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);
const same = (a, b) => fs.realpathSync.native(a) === fs.realpathSync.native(b);

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

function assertSameTree(before, afterSnap, what) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(afterSnap)])) {
    if (before[key] !== afterSnap[key]) changed.push(`${before[key] === undefined ? '+' : afterSnap[key] === undefined ? '-' : '~'} ${key}`);
  }
  assert.deepEqual(changed.sort(), [], what);
}

/** Minimal tar reader for `git archive` output (ustar with pax headers). */
function untar(buf, dest) {
  let off = 0;
  let paxPath = null;
  const field = (h, at, len) => {
    const s = h.subarray(at, at + len);
    const z = s.indexOf(0);
    return s.subarray(0, z < 0 ? len : z).toString('utf8');
  };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(field(h, 124, 12).trim() || '0', 8);
    const mode = parseInt(field(h, 100, 8).trim() || '0', 8);
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      for (const m of data.toString('utf8').matchAll(/\d+ path=([^\n]*)\n/g)) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    const rel = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    const abs = path.join(dest, ...rel.split('/').filter(Boolean));
    if (type === '5') {
      fs.mkdirSync(abs, { recursive: true });
    } else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      if (mode & 0o111) fs.chmodSync(abs, 0o755);
    }
  }
  return dest;
}

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

/** Sets up a vault from a kit folder: init (combined, local health sector), fixtures, golden, generate. */
async function buildVault(kitDir, lang, label) {
  const base = tmpDir(label);
  const root = path.join(base, 'vault');
  cloneDir(kitDir, root);
  const init = await runNode(path.join(root, 'system', 'init.mjs'), ['--mode', 'combined', '--lang', lang,
    '--sectors', 'core,work,school,health:local', '--private-root', '../private', '--cleanup', 'none', '--today', TODAY,
    '--yes', '--root', root], { cwd: root });
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
  const fixtures = path.join(root, 'system', 'tests', 'fixtures', lang);
  overlay(path.join(fixtures, 'vault'), root);
  overlay(path.join(fixtures, 'private'), path.join(base, 'private'));
  fs.copyFileSync(path.join(fixtures, 'golden.json'), path.join(root, 'system', 'tests', 'golden.json'));
  const check = await checkJson(root, ['--generate', '--strict', '--today', TODAY]);
  assert.deepEqual(check.errors, [], describeFindings(check));
  return { base, root };
}

/** A fresh copy of a built vault (with its private root next to it). */
function cloneVault(v, label) {
  const dest = path.join(tmpDir(label), 'copy');
  cloneDir(v.base, dest);
  return { base: dest, root: path.join(dest, 'vault'), priv: path.join(dest, 'private') };
}

function bumpMarker(dir, version) {
  for (const lang of ['en', 'cs']) {
    const rel = `system/templates/${lang}/kit/agents-system.md`;
    const text = readFile(dir, rel);
    const nl = text.indexOf('\n');
    writeFile(dir, rel, text.slice(0, nl).replace(/v\d+\.\d+\.\d+/, `v${version}`) + text.slice(nl));
  }
}

const personal = (text) => text.slice(text.indexOf('\n', text.indexOf('<!-- kit:end -->')) + 1);
const kitSection = (text) => text.slice(text.indexOf('<!-- kit:start'), text.indexOf('\n', text.indexOf('<!-- kit:end -->')) + 1);

// ---------------------------------------------------------------------------------------------
// Shared kits and vaults (built once; every test works on its own copy)

let SRC; // this kit, released
let NEXT; // a synthetic next made from SRC
let VAULT; // an en vault of SRC
let DOC_REMOVED; // the docs file NEXT no longer ships
let V010_EN; // en vault of memory-kit 0.1.0
let V010_CS; // cs vault of memory-kit 0.1.0

before(async () => {
  SRC = await releasedKit('upg-src');
  const docs = Object.keys(loadManifest(SRC).files).filter((rel) => rel.startsWith('docs/')).sort();
  DOC_REMOVED = docs[docs.length - 1];
  const next = releasedKit('upg-next', {
    from: SRC,
    mutate: (dir) => {
      writeFile(dir, 'system/VERSION', `${NXT}\n`);
      bumpMarker(dir, NXT);
      fs.appendFileSync(path.join(dir, 'system', 'lib', 'fingerprint.mjs'), `// ${NXT}\n`);
      writeFile(dir, 'system/lib/next-extra.mjs', 'export const NEXT = true;\n');
      fs.appendFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), `# ${NXT}\n`);
      fs.appendFileSync(path.join(dir, ...docs[0].split('/')), `\n${NXT}\n`);
      fs.rmSync(path.join(dir, ...DOC_REMOVED.split('/')));
    },
  });
  [NEXT, VAULT] = await Promise.all([next, buildVault(SRC, 'en', 'upg-vault')]);
});

function archive010(label, commit = V010) {
  const dir = path.join(tmpDir(label), 'kit');
  fs.mkdirSync(dir, { recursive: true });
  untar(git(KIT_ROOT, ['archive', '--format=tar', commit], { encoding: 'buffer' }), dir);
  return dir;
}

// ---------------------------------------------------------------------------------------------
// (a) and (b): memory-kit 0.1.0 to this kit

describe('a 0.1.0 vault upgrades to this kit', { skip: NO_V010, concurrency: 4 }, () => {
  before(async () => {
    const kit010 = archive010('upg-010');
    assert.equal(readVersion(kit010), '0.1.0');
    [V010_EN, V010_CS] = await Promise.all([buildVault(kit010, 'en', 'upg-010-en'), buildVault(kit010, 'cs', 'upg-010-cs')]);
  });

  test('(a) data, personal rules and a customized CI stay; kit files are replaced; the vault works', async () => {
    const v = cloneVault(V010_EN, 'upg-a');
    const ci = readFile(v.root, '.github/workflows/ci.yml').replace('  push:\n  pull_request:\n', '') + '# owner: nightly only\n';
    writeFile(v.root, '.github/workflows/ci.yml', ci);
    writeFile(v.root, 'CLAUDE.md', `${readFile(v.root, 'CLAUDE.md')}Answer briefly.\n`);
    writeFile(v.root, 'AGENTS.md', `${readFile(v.root, 'AGENTS.md')}- Prices always include VAT.\n`);
    const agentsBefore = readFile(v.root, 'AGENTS.md');
    const keep = snapshot(v.root);
    const privBefore = snapshot(v.priv);
    const data = Object.keys(keep).filter((rel) => /^(sectors|journal|inbox|archive|attachments)\//.test(rel)
      || ['state.md', 'waiting.md', 'memory.json', 'system/tests/golden.json', 'CLAUDE.md', '.github/workflows/ci.yml'].includes(rel));
    assert.ok(data.length > 40, `${data.length} data files`);

    const res = await runKit(SRC, v.root, ['upgrade', '--yes', '--json']);
    const out = jsonOf(res);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(out.plan.from, '0.1.0');
    assert.equal(out.plan.to, readVersion(SRC));
    assert.equal(out.result.applied, true);
    assert.equal(out.result.verify.ok, true);
    assert.ok(out.result.verify.eval, 'the golden questions ran before and after');

    for (const rel of data) assert.equal(snapshot(v.root)[rel], keep[rel], `untouched: ${rel}`);
    assertSameTree(privBefore, snapshot(v.priv), 'the private root is untouched');
    const agents = readFile(v.root, 'AGENTS.md');
    assert.equal(personal(agents), personal(agentsBefore), 'personal rules byte for byte');
    assert.equal(kitSection(agents), readFile(SRC, 'system/templates/en/kit/agents-system.md'));
    assert.equal(readFile(v.root, `.memory-kit/upgrade/${out.plan.to}/proposed/.github/workflows/ci.yml`), readFile(SRC, '.github/workflows/ci.yml'));
    assert.ok(out.plan.files.some((f) => f.rel === '.github/workflows/ci.yml' && f.action === 'propose'));

    const manifest = loadManifest(SRC);
    for (const [rel, entry] of Object.entries(manifest.files)) {
      if (rel === '.github/workflows/ci.yml') continue;
      if (entry.group === 'config' && keep[rel] === undefined) {
        // A config file 0.1.0 did not ship (the installers) is reported, not added.
        assert.ok(out.plan.files.some((f) => f.rel === rel && f.action === 'skip' && f.reason === 'missing'), `skipped: ${rel}`);
        assert.ok(!fs.existsSync(path.join(v.root, ...rel.split('/'))), `not added: ${rel}`);
        continue;
      }
      assert.equal(hashFile(path.join(v.root, ...rel.split('/'))), entry.sha256, `replaced: ${rel}`);
    }
    assert.equal(readVersion(v.root), readVersion(SRC));
    assert.deepEqual(loadManifest(v.root), manifest);
    assert.ok(!fs.existsSync(path.join(v.root, ...LOCK_FILE.split('/'))), 'no lock left');

    assert.deepEqual((await checkJson(v.root, ['--strict', '--today', TODAY])).errors, []);
    const start = await runCli(v.root, ['start']);
    assert.equal(start.code, 0);
    assert.ok(start.stdout.trim() && !start.stdout.includes('start failed'), start.stdout.slice(0, 300));
    const search = await runCli(v.root, ['search', 'invoice', '--json']);
    assert.equal(search.code, 0, search.stderr);
    assert.ok(JSON.parse(search.stdout).results.length > 0);
  });

  test('(b) a vault without system/tests and docs stays without them (golden file elsewhere)', async () => {
    const v = cloneVault(V010_EN, 'upg-b010');
    writeFile(v.root, 'tests/golden-questions.json', readFile(v.root, 'system/tests/golden.json'));
    fs.rmSync(path.join(v.root, 'system', 'tests'), { recursive: true });
    fs.rmSync(path.join(v.root, 'docs'), { recursive: true });
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...memory, eval: { golden: 'tests/golden-questions.json', min: 0.9 } });
    const golden = readFile(v.root, 'tests/golden-questions.json');

    const res = await runKit(SRC, v.root, ['upgrade', '--yes']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.ok(!fs.existsSync(path.join(v.root, 'system', 'tests')), 'no system/tests');
    assert.ok(!fs.existsSync(path.join(v.root, 'docs')), 'no docs');
    assert.equal(readFile(v.root, 'tests/golden-questions.json'), golden);
    assert.match(res.stdout, /tests: \d+ files skipped/);
    assert.match(res.stdout, /docs: \d+ files skipped/);
  });

  test('(i) a broken memory.json of a 0.1.0 vault names the doctor of the kit that runs (0.1.0 has none)', async () => {
    const v = cloneVault(V010_EN, 'upg-i010');
    assert.ok(!fs.existsSync(path.join(v.root, 'system', 'lib', 'commands', 'doctor.mjs')), '0.1.0 has no doctor');
    writeFile(v.root, 'memory.json', '{ "lang": "en", broken');
    const doctor = `node ${shellArg(path.join(SRC, 'system', 'memory.mjs'))} doctor --root ${shellArg(v.root)}`;
    const res = await runKit(SRC, v.root, ['upgrade']);
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /memory\.json cannot be read \(.+\); fix it first \((.+) shows how\)/);
    assert.ok(res.stdout.includes(`; fix it first (${doctor} shows how)`), res.stdout);
    const refusal = jsonOf(await runKit(SRC, v.root, ['upgrade', '--json'])).plan.refusals.find((r) => r.code === 'config');
    assert.ok(refusal.message.endsWith(`(${doctor} shows how)`), refusal.message);
    // The named command exists and shows what is wrong.
    const shown = await runKit(SRC, v.root, ['doctor', '--json']);
    assert.equal(shown.code, 1, shown.stderr);
    assert.equal(jsonOf(shown).checks.find((ch) => ch.id === 'config.memory_json').status, 'fail');
  });

  test('--rollback to a kit without the hook command takes the project hooks out first; the recovery tool refuses', async () => {
    const v = cloneVault(V010_EN, 'upg-hooks010');
    const h = agentHome('upg-hooks-home');
    const up = await runKit(SRC, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(up.code, 0, `${up.stdout}\n${up.stderr}`);
    const id = jsonOf(up).result.backup;
    const connected = await runNode(path.join(v.root, 'system', 'memory.mjs'), ['connect', 'claude-code', '--projects', '--root', v.root], { cwd: v.root, env: h.env });
    assert.equal(connected.code, 0, `${connected.stdout}\n${connected.stderr}`);
    const ours = () => JSON.stringify(JSON.parse(fs.readFileSync(h.settings, 'utf8')).hooks ?? {}).includes('memory.mjs');
    assert.ok(ours());
    // The recovery tool of the backup: refused, nothing restored, the way out named.
    const tool = await runNode(path.join(v.root, '.memory-kit', 'backups', id, 'tool', 'rollback.mjs'), [], { cwd: v.root, env: h.env });
    assert.equal(tool.code, 1, `${tool.stdout}\n${tool.stderr}`);
    assert.match(tool.stderr, /run this vault's hook command, which the kit of 0\.1\.0 does not have/);
    assert.match(tool.stderr, /connect claude-code --projects --remove/);
    assert.equal(readVersion(v.root), readVersion(SRC), 'nothing was restored');
    const dry = await runNode(path.join(v.root, 'system', 'memory.mjs'), ['upgrade', '--rollback', '--dry-run', '--root', v.root], { cwd: v.root, env: h.env });
    assert.match(dry.stdout, /the memory hooks in .*settings\.json would be taken out first/);
    assert.ok(ours(), 'a dry run changes nothing');
    // The vault's own CLI takes them out, then rolls back.
    const back = await runNode(path.join(v.root, 'system', 'memory.mjs'), ['upgrade', '--rollback', '--root', v.root], { cwd: v.root, env: h.env });
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.match(back.stdout, /the memory hooks were taken out of .*settings\.json: the kit of 0\.1\.0 has no hook command/);
    assert.match(back.stdout, /is undone/);
    assert.ok(!ours(), 'no hook runs the vault any more');
    assert.equal(readVersion(v.root), '0.1.0');
  });

  test('(h) a Czech vault keeps its personal section and gets the Czech kit section', async () => {
    const v = cloneVault(V010_CS, 'upg-h010');
    writeFile(v.root, 'AGENTS.md', `${readFile(v.root, 'AGENTS.md')}- Ceny vždy s DPH.\n`);
    const before = readFile(v.root, 'AGENTS.md');
    const res = await runKit(SRC, v.root, ['upgrade', '--yes']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const agents = readFile(v.root, 'AGENTS.md');
    assert.equal(personal(agents), personal(before));
    assert.ok(personal(agents).includes('- Ceny vždy s DPH.'));
    assert.equal(kitSection(agents), readFile(SRC, 'system/templates/cs/kit/agents-system.md'));
    assert.match(agents.split('\n')[0], new RegExp(`kit:start v${readVersion(SRC).replace(/\./g, '\\.')} · systémová část`));
  });
});

describe('a vault of the 0.1.2 draft gets this kit', { skip: NO_DRAFT012 }, () => {
  test('its kit files are replaced although the version number is the same', async () => {
    const kit = archive010('upg-draft', DRAFT012);
    assert.equal(readVersion(kit), '0.1.2');
    const v = await buildVault(kit, 'en', 'upg-draft-en');
    const res = await runKit(SRC, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    if (CUR === '0.1.2') assert.equal(out.plan.refresh, true, 'another build of 0.1.2');
    assert.equal(out.result.applied, true);
    assert.equal(readFile(v.root, 'system/lib/commands/hook.mjs'), readFile(SRC, 'system/lib/commands/hook.mjs'));
    assert.deepEqual(loadManifest(v.root), loadManifest(SRC));
    assert.equal(jsonOf(await runKit(SRC, v.root, ['upgrade', '--json'])).result.up_to_date, true);
  });
});

// ---------------------------------------------------------------------------------------------
// This kit to a newer one

describe('upgrading this kit to a newer one', { concurrency: 4 }, () => {
  test('(b) without system/tests and docs; a new file, a change and a removal', async () => {
    const v = cloneVault(VAULT, 'upg-b');
    fs.rmSync(path.join(v.root, 'system', 'tests'), { recursive: true });
    fs.rmSync(path.join(v.root, 'docs'), { recursive: true });
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.ok(!fs.existsSync(path.join(v.root, 'system', 'tests')));
    assert.ok(!fs.existsSync(path.join(v.root, 'docs')));
    assert.ok(out.plan.files.filter((f) => f.group === 'docs').every((f) => f.action === 'skip' && f.reason === 'optional'));
    assert.equal(readFile(v.root, 'system/lib/next-extra.mjs'), 'export const NEXT = true;\n');
    assert.ok(readFile(v.root, 'system/lib/fingerprint.mjs').endsWith(`// ${NXT}\n`));
    assert.equal(readVersion(v.root), NXT);
    assert.match(readFile(v.root, 'AGENTS.md').split('\n')[0], new RegExp(`kit:start v${esc(NXT)} `));
  });

  test('a vault with docs loses the docs file the kit removed and gets the changed ones', async () => {
    const v = cloneVault(VAULT, 'upg-docs');
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.ok(out.plan.files.some((f) => f.rel === DOC_REMOVED && f.action === 'remove'));
    assert.ok(!fs.existsSync(path.join(v.root, ...DOC_REMOVED.split('/'))));
    assert.equal(readFile(v.root, '.github/workflows/ci.yml'), readFile(NEXT, '.github/workflows/ci.yml'), 'an unmodified config file is replaced');
    assert.ok(out.result.pruned.length === 0);
  });

  test('a removed kit file that was changed here is kept and reported', async () => {
    const v = cloneVault(VAULT, 'upg-keep');
    fs.appendFileSync(path.join(v.root, ...DOC_REMOVED.split('/')), '\nmy notes\n');
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.ok(out.plan.files.some((f) => f.rel === DOC_REMOVED && f.action === 'keep'));
    assert.ok(readFile(v.root, DOC_REMOVED).endsWith('my notes\n'));
  });

  test('(c) a locally modified system/lib file blocks the upgrade; --force replaces it and keeps a backup', async () => {
    const v = cloneVault(VAULT, 'upg-c');
    fs.appendFileSync(path.join(v.root, 'system', 'lib', 'text.mjs'), '// my tweak\n');
    const before = snapshot(v.root);
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1, res.stdout);
    const out = jsonOf(res);
    assert.deepEqual(out.plan.blockers.map((b) => [b.code, b.rel]), [['modified', 'system/lib/text.mjs']]);
    assert.match(out.plan.blockers[0].message, /--force/);
    assertSameTree(before, snapshot(v.root), 'a blocked upgrade writes nothing');
    assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit')));

    const human = await runKit(NEXT, v.root, ['upgrade', '--yes']);
    assert.equal(human.code, 1);
    assert.match(human.stdout, /system\/lib\/text\.mjs: changed here/);

    const forced = await runKit(NEXT, v.root, ['upgrade', '--yes', '--force', '--json']);
    assert.equal(forced.code, 0, `${forced.stdout}\n${forced.stderr}`);
    const fout = jsonOf(forced);
    assert.equal(readFile(v.root, 'system/lib/text.mjs'), readFile(NEXT, 'system/lib/text.mjs'));
    const saved = path.join(v.root, '.memory-kit', 'backups', fout.result.backup, 'files', 'system', 'lib', 'text.mjs');
    assert.ok(fs.readFileSync(saved, 'utf8').endsWith('// my tweak\n'), 'the backup keeps the owner\'s version');
  });

  test('(d) uncommitted changes in paths the upgrade writes block it; after a commit it runs', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    const v = cloneVault(VAULT, 'upg-d');
    git(v.root, ['init', '-q', '-b', 'main']);
    git(v.root, ['add', '-A']);
    git(v.root, ['commit', '-q', '-m', 'vault']);
    writeFile(v.root, 'AGENTS.md', `${readFile(v.root, 'AGENTS.md')}- Uncommitted rule.\n`);
    fs.rmSync(path.join(v.root, 'system', 'lib', 'text.mjs'));
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1, res.stdout);
    const out = jsonOf(res);
    assert.deepEqual(out.plan.blockers.filter((b) => b.code === 'dirty').map((b) => b.rel).sort(), ['AGENTS.md', 'system/lib/text.mjs']);
    assert.match(out.plan.blockers[0].message, /commit/);

    git(v.root, ['add', '-A']);
    git(v.root, ['commit', '-q', '-m', 'owner changes']);
    const ok = await runKit(NEXT, v.root, ['upgrade', '--yes']);
    assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
    assert.equal(readFile(v.root, 'system/lib/text.mjs'), readFile(NEXT, 'system/lib/text.mjs'), 'a deleted kit file comes back');
    const lines = ok.stdout.split('\n').map((l) => l.trim());
    assert.ok(lines.includes('git add -A'), ok.stdout);
    assert.ok(lines.includes(`git commit -m "memory-kit ${CUR} → ${NXT}"`), ok.stdout);
    assert.ok(!ok.stdout.includes('&&'));
    const exclude = fs.readFileSync(path.join(v.root, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes('.memory-kit/'), exclude);
    assert.ok(!git(v.root, ['status', '--porcelain', '--untracked-files=all']).includes('.memory-kit'), 'backups are not offered to git');
  });

  test('(e) a failing verification rolls back automatically; every file is byte-identical', async () => {
    const broken = await releasedKit('upg-broken', {
      from: NEXT,
      mutate: (dir) => writeFile(dir, 'system/lib/commands/start.mjs', [
        'export const usage = \'start\';',
        'export async function run() {',
        '  process.stdout.write(\'# Memory: start\\nmemory: start failed: injected. Run node system/memory.mjs check.\\n\');',
        '  return 0;',
        '}',
        '',
      ].join('\n')),
    });
    const v = cloneVault(VAULT, 'upg-e');
    const before = snapshot(v.root);
    const privBefore = snapshot(v.priv);
    const res = await runKit(broken, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.equal(out.result.applied, false);
    assert.equal(out.result.failure.step, 'start');
    assert.match(out.result.failure.detail, /start failed/);
    assert.equal(out.result.rolledBack, true);
    assertSameTree(before, snapshot(v.root), 'rolled back byte for byte');
    assertSameTree(privBefore, snapshot(v.priv), 'the private root too');
    assert.equal(lockState(v.root), null);
    assert.deepEqual(listBackups(v.root), [], 'a completed automatic rollback leaves no backup behind');

    const human = await runKit(broken, v.root, ['upgrade', '--yes']);
    assert.equal(human.code, 1);
    assert.match(human.stdout, /the upgrade failed \(start\)/);
    assert.match(human.stdout, /restored from the backup/);
  });

  test('(f) --rollback restores the vault as it was; a second one has nothing to do', async () => {
    const v = cloneVault(VAULT, 'upg-f');
    const before = snapshot(v.root);
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(readVersion(v.root), NXT);
    assert.match(res.stdout, new RegExp(`to undo it: node .*upgrade --rollback \\d{8}-\\d{6}-${esc(CUR)}-to-${esc(NXT)}`));

    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.match(back.stdout, /restored/);
    assertSameTree(before, snapshot(v.root), 'as before the upgrade, generated files included');
    const again = await runCli(v.root, ['upgrade', '--rollback', '--json']);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(jsonOf(again).rollback.already, true);
  });

  test('(f) --rollback refuses to overwrite a file changed after the upgrade unless --force', async () => {
    const v = cloneVault(VAULT, 'upg-f2');
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--no-verify', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const id = jsonOf(res).result.backup;
    const edited = `${readFile(v.root, 'AGENTS.md')}- Added after the upgrade.\n`;
    writeFile(v.root, 'AGENTS.md', edited);
    const refused = await runCli(v.root, ['upgrade', '--rollback', id, '--json']);
    assert.equal(refused.code, 1, refused.stdout);
    assert.deepEqual(jsonOf(refused).rollback.conflicts, ['AGENTS.md']);
    assert.equal(readVersion(v.root), NXT, 'nothing was restored');
    const dry = await runCli(v.root, ['upgrade', '--rollback', '--dry-run']);
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /would restore/);
    const forced = await runCli(v.root, ['upgrade', `--rollback=${id}`, '--force']);
    assert.equal(forced.code, 0, `${forced.stdout}\n${forced.stderr}`);
    assert.equal(readVersion(v.root), CUR);
    assert.equal(fs.readFileSync(path.join(v.root, '.memory-kit', 'backups', id, 'conflicts', 'AGENTS.md'), 'utf8'), edited, 'the later edit is saved');
  });

  test('(g) an interrupted upgrade (its lock) is refused until --rollback', async () => {
    const v = cloneVault(VAULT, 'upg-g');
    const before = snapshot(v.root);
    // Crash simulation: the backup is written (with what the upgrade writes), the lock is set,
    // two files are already new.
    const backup = createBackup(v.root, { from: CUR, to: NXT });
    const next = (rel) => ({ rel, next: sha(fs.readFileSync(path.join(NEXT, ...rel.split('/')))) });
    backup.recordMany([next('system/lib/fingerprint.mjs'), next('system/lib/next-extra.mjs'), next('system/VERSION'), 'AGENTS.md', 'memory.json']);
    writeJson(v.root, LOCK_FILE, { backup: backup.id, from: CUR, to: NXT, started: '2026-09-24T10:00:00.000Z', pid: 1 });
    fs.copyFileSync(path.join(NEXT, 'system', 'lib', 'fingerprint.mjs'), path.join(v.root, 'system', 'lib', 'fingerprint.mjs'));
    fs.copyFileSync(path.join(NEXT, 'system', 'lib', 'next-extra.mjs'), path.join(v.root, 'system', 'lib', 'next-extra.mjs'));

    assert.deepEqual({ ...lockState(v.root), started: null }, {
      rel: LOCK_FILE, backup: backup.id, from: CUR, to: NXT, started: null, pid: 1, host: null, valid: true, running: false, recover: null,
    });
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1, res.stdout);
    assert.ok(jsonOf(res).plan.blockers.some((b) => b.code === 'locked'));
    assert.match((await runKit(NEXT, v.root, ['upgrade'])).stdout, /did not finish; run upgrade --rollback/);
    const sameVersion = await runCli(v.root, ['upgrade', '--from', SRC]);
    assert.equal(sameVersion.code, 1, 'a source of the same version is not "up to date" while the lock is there');
    assert.match(sameVersion.stdout, /did not finish/);

    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assert.match(back.stdout, /lock/);
    assertSameTree(before, snapshot(v.root), 'the half-done upgrade is undone');
    assert.equal(lockState(v.root), null);
    const ok = await runKit(NEXT, v.root, ['upgrade', '--yes']);
    assert.equal(ok.code, 0, `${ok.stdout}\n${ok.stderr}`);
  });

  test('(g) doctor reports a lock left behind', async () => {
    const v = cloneVault(VAULT, 'upg-g2');
    writeJson(v.root, LOCK_FILE, { backup: 'gone', from: CUR, to: NXT, started: '2026-09-24T10:00:00.000Z', pid: 1 });
    const doctor = await runCli(v.root, ['doctor', '--json']);
    const report = jsonOf(doctor);
    const find = (node) => {
      if (Array.isArray(node)) return node.map(find).find(Boolean);
      if (node && typeof node === 'object') return node.id === 'kit.upgrade_lock' ? node : Object.values(node).map(find).find(Boolean);
      return undefined;
    };
    const check = find(report);
    assert.ok(check, `doctor --json has a kit.upgrade_lock check:\n${doctor.stdout}`);
    assert.notEqual(check.status, 'ok');
    // The lock names a backup that is gone: only --force clears it.
    const refused = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--rollback --force/);
    const cleared = await runCli(v.root, ['upgrade', '--rollback', '--force']);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.equal(lockState(v.root), null);
  });

  test('(h) a Czech vault keeps its personal section and gets the Czech kit section', async () => {
    const cs = await buildVault(SRC, 'cs', 'upg-h');
    writeFile(cs.root, 'AGENTS.md', `${readFile(cs.root, 'AGENTS.md')}- Ceny vždy s DPH.\n`);
    const before = readFile(cs.root, 'AGENTS.md');
    const res = await runKit(NEXT, cs.root, ['upgrade', '--yes']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const agents = readFile(cs.root, 'AGENTS.md');
    assert.equal(personal(agents), personal(before));
    assert.equal(kitSection(agents), readFile(NEXT, 'system/templates/cs/kit/agents-system.md'));
    assert.match(agents.split('\n')[0], new RegExp(`kit:start v${esc(NXT)} · systémová část`));
  });

  test('(i) the plan (no --yes, or --dry-run) writes nothing', async () => {
    const v = cloneVault(VAULT, 'upg-i');
    const before = snapshot(v.root);
    const plain = await runKit(NEXT, v.root, ['upgrade']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, new RegExp(`memory-kit upgrade ${esc(CUR)} → ${esc(NXT)}`));
    assert.match(plain.stdout, /Plan only, nothing was changed/);
    const hint = plain.stdout.split('\n').find((l) => l.includes(' upgrade --root ')) ?? '';
    assert.ok(hint.includes(v.root) && hint.trim().endsWith('--yes'), plain.stdout);
    const dry = await runKit(NEXT, v.root, ['upgrade', '--yes', '--dry-run', '--json']);
    assert.equal(dry.code, 0);
    const out = jsonOf(dry);
    assert.equal(out.result.dry_run, true);
    assert.ok(out.plan.counts.add >= 1 && out.plan.counts.replace >= 1 && out.plan.counts.remove >= 1, JSON.stringify(out.plan.counts));
    assert.equal(out.plan.agents.action, 'replace');
    assertSameTree(before, snapshot(v.root), 'nothing written');
    assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit')), 'not even .memory-kit/');
  });

  test('(j) a damaged source is refused', async () => {
    const damaged = path.join(tmpDir('upg-damaged'), 'kit');
    cloneDir(NEXT, damaged);
    fs.appendFileSync(path.join(damaged, 'system', 'lib', 'text.mjs'), '// tampered\n');
    const v = cloneVault(VAULT, 'upg-j');
    const before = snapshot(v.root);
    const res = await runKit(damaged, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1);
    const refusal = jsonOf(res).plan.refusals.find((r) => r.code === 'source_damaged');
    assert.ok(refusal, res.stdout);
    assert.match(refusal.message, /system\/lib\/text\.mjs/);
    assertSameTree(before, snapshot(v.root), 'nothing written');
  });

  test('another build of the same version (a draft published under the number) is an upgrade, not "up to date"', async () => {
    const other = await releasedKit('upg-otherbuild', { from: SRC, mutate: (dir) => fs.appendFileSync(path.join(dir, 'system', 'lib', 'fingerprint.mjs'), '// the release build\n') });
    assert.equal(readVersion(other), CUR);
    const v = cloneVault(VAULT, 'upg-otherbuild-vault');
    const plan = await planUpgrade({ vault: v.root, source: other });
    assert.deepEqual([plan.upToDate, plan.refresh, plan.ok], [false, true, true]);
    assert.ok(plan.files.some((f) => f.rel === 'system/lib/fingerprint.mjs' && f.action === 'replace'));
    assert.deepEqual([(await planUpgrade({ vault: v.root, source: SRC })).upToDate, (await planUpgrade({ vault: v.root, source: SRC })).refresh], [true, false], 'the same build: up to date');
    // The vault's own upgrade hands over to the other build's upgrader, which says what it does.
    const shown = await runCli(v.root, ['upgrade', '--from', other]);
    assert.equal(shown.code, 0, `${shown.stdout}\n${shown.stderr}`);
    assert.match(shown.stdout, new RegExp(`this vault has another build of ${esc(CUR)}`));
    const res = await runCli(v.root, ['upgrade', '--from', other, '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.equal(out.delegated_from, CUR);
    assert.equal(out.result.applied, true);
    assert.equal(readFile(v.root, 'system/lib/fingerprint.mjs'), readFile(other, 'system/lib/fingerprint.mjs'));
    assert.equal(jsonOf(await runCli(v.root, ['upgrade', '--from', other, '--json'])).result.up_to_date, true, 'now it is');
  });

  test('a downgrade and an equal version', async () => {
    const v = cloneVault(VAULT, 'upg-down');
    assert.equal((await runKit(NEXT, v.root, ['upgrade', '--yes', '--no-verify'])).code, 0);
    const down = await runKit(SRC, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(down.code, 1);
    assert.ok(jsonOf(down).plan.refusals.some((r) => r.code === 'downgrade'));
    const equal = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(equal.code, 0);
    assert.equal(jsonOf(equal).result.up_to_date, true);
    const other = await runKit(SRC, v.root, ['upgrade', '--yes', '--force', '--no-verify']);
    assert.equal(other.code, 0, `${other.stdout}\n${other.stderr}`);
    assert.equal(readVersion(v.root), readVersion(SRC), '--force goes back');
  });
});

// ---------------------------------------------------------------------------------------------
// (k) the newest upgrader runs

describe('what the plan refuses or leaves alone', { concurrency: 4 }, () => {
  test('a broken memory.json of a vault with its own doctor: "doctor shows how"', async () => {
    const v = cloneVault(VAULT, 'upg-cfgdoc');
    writeFile(v.root, 'memory.json', '{ "lang": "en", broken');
    const res = await runKit(NEXT, v.root, ['upgrade']);
    assert.equal(res.code, 1, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /memory\.json cannot be read \(.+\); fix it first \(doctor shows how\)/);
  });

  const codes = (plan) => plan.refusals.map((r) => r.code);

  test('too old a vault, too old a Node.js, a broken memory.json, a source without a manifest', async () => {
    const v = cloneVault(VAULT, 'upg-refuse');
    assert.deepEqual(codes(await planUpgrade({ vault: v.root, source: NEXT, nodeVersion: '22.4.9' })), ['node']);
    writeFile(v.root, 'system/VERSION', '0.0.9\n');
    assert.deepEqual(codes(await planUpgrade({ vault: v.root, source: NEXT })), ['too_old']);
    writeFile(v.root, 'system/VERSION', 'next\n');
    assert.deepEqual(codes(await planUpgrade({ vault: v.root, source: NEXT })), ['vault_version']);
    writeFile(v.root, 'system/VERSION', `${CUR}\n`);
    writeFile(v.root, 'memory.json', '{ "version": 1, ');
    const broken = await planUpgrade({ vault: v.root, source: NEXT });
    assert.deepEqual(codes(broken), ['config']);
    assert.equal(broken.ok, false);
    writeJson(v.root, 'memory.json', { version: 'one' });
    assert.deepEqual(codes(await planUpgrade({ vault: v.root, source: NEXT })), ['data_invalid']);

    const bare = path.join(tmpDir('upg-bare'), 'kit');
    cloneDir(NEXT, bare);
    fs.rmSync(path.join(bare, 'system', 'kit.json'));
    assert.deepEqual(codes(await planUpgrade({ vault: VAULT.root, source: bare })), ['source_no_manifest']);
    writeFile(bare, 'system/kit.json', readFile(NEXT, 'system/kit.json'));
    writeFile(bare, 'system/VERSION', `${NXT2}\n`);
    assert.deepEqual(codes(await planUpgrade({ vault: VAULT.root, source: bare })), ['source_version', 'source_damaged']);
  });

  test('a migration chain with a gap is refused before anything runs', async () => {
    const v = cloneVault(VAULT, 'upg-gap');
    const mig = path.join(tmpDir('upg-gapkit'), 'kit');
    cloneDir(NEXT, mig);
    const manifest = JSON.parse(readFile(mig, 'system/kit.json'));
    writeJson(mig, 'system/kit.json', { ...manifest, data_version: 3 });
    const list = [{ id: 'a', from: 1, to: 2, title: 'a', run() {} }];
    const plan = await planUpgrade({ vault: v.root, source: mig, migrations: list });
    assert.deepEqual(codes(plan), ['no_migration']);
  });

  test('AGENTS.md without kit markers is left alone and reported; the upgrade still runs', async () => {
    const v = cloneVault(VAULT, 'upg-markers');
    const agents = readFile(v.root, 'AGENTS.md').replace(/<!-- kit:start[^\n]*\n/, '');
    writeFile(v.root, 'AGENTS.md', agents);
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--no-verify']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /AGENTS\.md: the kit markers are missing/);
    assert.equal(readFile(v.root, 'AGENTS.md'), agents);
  });

  test('a missing optional config file stays missing; the missing pre-commit hook is installed', async () => {
    const v = cloneVault(VAULT, 'upg-config');
    fs.rmSync(path.join(v.root, '.claude', 'agents', 'memory-searcher.md'));
    fs.rmSync(path.join(v.root, '.githooks', 'pre-commit'));
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const files = jsonOf(res).plan.files;
    assert.deepEqual(files.find((f) => f.rel === '.claude/agents/memory-searcher.md'), { rel: '.claude/agents/memory-searcher.md', group: 'config', action: 'skip', reason: 'missing' });
    assert.equal(files.find((f) => f.rel === '.githooks/pre-commit').action, 'add');
    assert.ok(!fs.existsSync(path.join(v.root, '.claude', 'agents', 'memory-searcher.md')));
    assert.equal(readFile(v.root, '.githooks/pre-commit'), readFile(NEXT, '.githooks/pre-commit'));
    if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(v.root, '.githooks', 'pre-commit')).mode & 0o111, 'executable');
    const human = await runKit(SRC, v.root, ['upgrade', '--force', '--no-verify']);
    assert.match(human.stdout, /not in this vault, so not added: \.claude\/agents\/memory-searcher\.md/);
  });
});

describe('hand-over to a newer upgrader', { concurrency: 4 }, () => {
  test('(k) the vault\'s own upgrade with --from <newer kit> runs that kit\'s upgrader', async () => {
    const v = cloneVault(VAULT, 'upg-k');
    const plan = await runCli(v.root, ['upgrade', '--from', NEXT]);
    assert.equal(plan.code, 0, plan.stderr);
    const hint = plan.stdout.split('\n').find((l) => l.includes('node system/memory.mjs upgrade --from ')) ?? '';
    assert.ok(hint.includes(NEXT) && hint.trim().endsWith('--yes'), `the vault's own command, not the temporary one:\n${plan.stdout}`);
    assert.match(plan.stderr, new RegExp(`memory-kit ${esc(NXT)} found`));

    const res = await runCli(v.root, ['upgrade', '--from', NEXT, '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.ok(same(out.runner.root, NEXT), out.runner.root);
    assert.equal(out.runner.version, NXT);
    assert.equal(out.delegated_from, CUR);
    assert.equal(out.result.applied, true);
    assert.equal(readVersion(v.root), NXT);

    const again = await runCli(v.root, ['upgrade', '--from', NEXT]);
    assert.equal(again.code, 0);
    assert.match(again.stdout, new RegExp(`${esc(NXT)} is up to date`));
    const older = await runCli(v.root, ['upgrade', '--from', SRC, '--json']);
    assert.equal(older.code, 0);
    assert.equal(jsonOf(older).result.up_to_date, true);
  });

  test('a git source is cloned (--from <repo> --ref, and memory.json kit.source by default)', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    const repo = path.join(tmpDir('upg-repo'), 'memory-kit');
    cloneDir(NEXT, repo);
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', `memory-kit ${NXT}`]);

    const v = cloneVault(VAULT, 'upg-git');
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...memory, kit: { source: pathToFileURL(repo).href } });
    const plan = await runCli(v.root, ['upgrade', '--json']);
    assert.equal(plan.code, 0, `${plan.stdout}\n${plan.stderr}`);
    const planned = jsonOf(plan);
    assert.equal(planned.runner.version, NXT);
    assert.equal(planned.result.dry_run, true);
    assert.ok(!fs.existsSync(planned.runner.root), 'the temporary clone is removed');
    assert.ok(same(path.dirname(path.dirname(planned.runner.root)), os.tmpdir()), planned.runner.root);

    const res = await runCli(v.root, ['upgrade', '--from', repo, '--ref', 'main', '--yes', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.equal(jsonOf(res).result.applied, true);
    assert.equal(readVersion(v.root), NXT);

    const missing = await runCli(v.root, ['upgrade', '--from', repo, '--ref', 'no-such-branch']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /could not be downloaded/);
  });

  test('usage errors', async () => {
    const v = cloneVault(VAULT, 'upg-usage');
    assert.equal((await runCli(v.root, ['upgrade', '--from', path.join(v.root, 'no-such-dir')])).code, 2);
    assert.equal((await runKit(NEXT, v.root, ['upgrade', '--ref', 'main'])).code, 2);
    assert.equal((await runCli(v.root, ['upgrade', '--rollback', 'a', 'b'])).code, 2);
    assert.equal((await runCli(v.root, ['upgrade', '--rollback', '--from', NEXT])).code, 2);
    assert.equal((await runCli(v.root, ['upgrade', 'extra'])).code, 2);
    const self = await runKit(v.root, v.root, ['upgrade', '--from', v.root, '--force', '--json']);
    assert.equal(self.code, 1);
    assert.ok(jsonOf(self).plan.refusals.some((r) => r.code === 'same_dir'));
  });
});

// ---------------------------------------------------------------------------------------------
// (l) migrations

describe('data migrations', { concurrency: 4 }, () => {
  let MIG;
  before(async () => {
    MIG = await releasedKit('upg-mig', {
      from: NEXT,
      mutate: (dir) => writeFile(dir, 'system/migrations/index.mjs', [
        'export const MIGRATIONS = [',
        '  {',
        '    id: \'0002-test\', from: 1, to: 2, title: \'marks the state hub, archives an inbox note\',',
        '    async run(ctx) {',
        '      const hub = ctx.lang === \'cs\' ? \'stav.md\' : \'state.md\';',
        '      ctx.writeText(hub, `${ctx.readText(hub)}<!-- migrated -->\\n`);',
        '      ctx.move(\'inbox/2026-09-17-loyalty-card-idea.md\', \'archive/inbox/2026-09-17-loyalty-card-idea.md\');',
        '      ctx.writeJson(\'system/usage/migrated.json\', { from: 1 });',
        '      ctx.log(\'done\');',
        '    },',
        '  },',
        '];',
        '',
      ].join('\n')),
    });
  });

  test('(l) a migration runs inside the upgrade, everything it touches is backed up, memory.json gets the new version', async () => {
    assert.equal(loadManifest(MIG).data_version, 2, 'release derives data_version from the migrations');
    const v = cloneVault(VAULT, 'upg-l');
    const before = snapshot(v.root);
    const memoryBefore = JSON.parse(readFile(v.root, 'memory.json'));
    const plan = await runKit(MIG, v.root, ['upgrade', '--json']);
    assert.deepEqual(jsonOf(plan).plan.migrations, [{ id: '0002-test', from: 1, to: 2, title: 'marks the state hub, archives an inbox note' }]);
    assert.match((await runKit(MIG, v.root, ['upgrade'])).stdout, /data: version 1 → 2 \(0002-test/);

    // The code of this release reads data version 1 only, so the vault's check cannot verify version 2.
    const res = await runKit(MIG, v.root, ['upgrade', '--yes', '--no-verify', '--json']);
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const out = jsonOf(res);
    assert.deepEqual(out.result.migrations, [{ id: '0002-test', from: 1, to: 2, title: 'marks the state hub, archives an inbox note', log: ['done'] }]);
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    assert.deepEqual(memory, { ...memoryBefore, version: 2 });
    assert.deepEqual(Object.keys(memory), Object.keys(memoryBefore), 'key order kept');
    assert.ok(readFile(v.root, 'state.md').endsWith('<!-- migrated -->\n'));
    assert.ok(fs.existsSync(path.join(v.root, 'archive', 'inbox', '2026-09-17-loyalty-card-idea.md')));
    assert.ok(!fs.existsSync(path.join(v.root, 'inbox', '2026-09-17-loyalty-card-idea.md')));

    const backup = JSON.parse(readFile(v.root, `.memory-kit/backups/${out.result.backup}/backup.json`));
    const entry = (rel) => backup.files.find((f) => f.rel === rel);
    assert.equal(entry('state.md').existed, true);
    assert.equal(entry('memory.json').existed, true);
    assert.equal(entry('inbox/2026-09-17-loyalty-card-idea.md').existed, true);
    assert.equal(entry('archive/inbox/2026-09-17-loyalty-card-idea.md').existed, false);
    assert.equal(entry('system/usage/migrated.json').existed, false);

    // The vault's CLI cannot load memory.json version 2 now; upgrade still runs without a config.
    const back = await runCli(v.root, ['upgrade', '--rollback']);
    assert.equal(back.code, 0, `${back.stdout}\n${back.stderr}`);
    assertSameTree(before, snapshot(v.root), 'the migration is undone too');
  });

  test('(l) a vault whose data is newer than the kit reads is refused', async () => {
    const v = cloneVault(VAULT, 'upg-l2');
    const memory = JSON.parse(readFile(v.root, 'memory.json'));
    writeJson(v.root, 'memory.json', { ...memory, version: 3 });
    const res = await runKit(NEXT, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(res.code, 1, res.stdout);
    const refusal = jsonOf(res).plan.refusals.find((r) => r.code === 'data_newer');
    assert.ok(refusal, res.stdout);
    assert.deepEqual([refusal.vault, refusal.kit], [3, 1]);
    const gap = await runKit(MIG, v.root, ['upgrade', '--yes', '--json']);
    assert.equal(gap.code, 1);
    assert.ok(jsonOf(gap).plan.refusals.some((r) => r.code === 'data_newer'));
  });

  test('migrationChain', async () => {
    const m = (id, from, to) => ({ id, from, to, title: id, run() {} });
    const list = [m('a', 1, 2), m('b', 2, 3), m('c', 3, 4), m('skip', 2, 4)];
    assert.deepEqual(migrationChain(list, 2, 2), []);
    assert.deepEqual(migrationChain(list, 1, 3).map((x) => x.id), ['a', 'b']);
    assert.deepEqual(migrationChain(list, 1, 4).map((x) => x.id), ['a', 'skip']);
    assert.equal(migrationChain(list, 4, 5), null);
    assert.equal(migrationChain(list, 3, 1), null);
    assert.equal(migrationChain([m('a', 1, 2), m('c', 3, 4)], 1, 4), null);
  });

  test('validateMigrations', async () => {
    const ok = { id: 'x', from: 1, to: 2, title: 't', run() {} };
    assert.equal(validateMigrations([ok]).length, 1);
    for (const bad of [{ ...ok, id: '' }, { ...ok, to: 1 }, { ...ok, from: 0 }, { ...ok, title: '' }, { ...ok, run: 'no' }]) {
      assert.throws(() => validateMigrations([bad]), MigrationError);
    }
    assert.throws(() => validateMigrations([ok, ok]), /duplicate/);
    assert.throws(() => validateMigrations({}), MigrationError);
  });

  test('the migration ctx stays inside the vault, never overwrites and records before writing', async () => {
    const root = tmpDir('upg-ctx');
    writeFile(root, 'a.md', 'a\n');
    writeFile(root, 'b.md', 'b\n');
    writeFile(root, 'dir/x.md', 'x\n');
    writeFile(root, 'dir/sub/y.md', 'y\n');
    writeJson(root, 'memory.json', { lang: 'en', version: 1, other: true });
    const recorded = [];
    const record = (rel) => {
      recorded.push([rel, fs.existsSync(path.join(root, ...rel.split('/'))) ? fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8') : null]);
    };
    const ctx = migrationContext({ root, lang: 'en', record, log: () => {} });
    for (const bad of ['../x.md', '/etc/passwd', 'C:\\x.md', '.git/config', '.memory-kit/x', 'a/../../x', '']) {
      assert.throws(() => ctx.writeText(bad, 'x'), MigrationError, bad);
    }
    assert.throws(() => ctx.move('a.md', 'b.md'), /exists already/);
    ctx.writeText('a.md', 'A\n');
    assert.deepEqual(recorded[0], ['a.md', 'a\n'], 'the old bytes are recorded first');
    ctx.move('dir', 'moved');
    assert.equal(readFile(root, 'moved/sub/y.md'), 'y\n');
    assert.ok(!fs.existsSync(path.join(root, 'dir')), 'the emptied folder is gone');
    assert.equal(ctx.readText('nope.md'), null);
    assert.equal(ctx.readJson('nope.json'), null);

    const chain = [{ id: 't', from: 1, to: 2, title: 't', run: (c) => c.writeText('b.md', 'B\n') }];
    const done = await runMigrations(chain, { root, lang: 'en', record });
    assert.deepEqual(done.map((d) => d.id), ['t']);
    assert.deepEqual(JSON.parse(readFile(root, 'memory.json')), { lang: 'en', version: 2, other: true });
    await assert.rejects(runMigrations([{ id: 'boom', from: 2, to: 3, title: 'b', run() { throw new Error('nope'); } }], { root, lang: 'en', record }), /migration boom failed: nope/);
  });
});

// ---------------------------------------------------------------------------------------------
// Library pieces

describe('the AGENTS.md kit section', () => {
  const block = '<!-- kit:start v9 · x -->\nnew rules\n<!-- kit:end -->\n';

  test('text before and after stays byte for byte', async () => {
    const text = 'my header\n\n<!-- kit:start v1 · x -->\nold\n<!-- kit:end -->\n## Personal rules\n- mine\n';
    const res = replaceKitBlock(text, block);
    assert.equal(res.state, 'replaced');
    assert.equal(res.text, `my header\n\n${block}## Personal rules\n- mine\n`);
    assert.equal(replaceKitBlock(res.text, block).state, 'unchanged');
  });

  test('CRLF files keep CRLF; a BOM stays; a final line without newline', async () => {
    const crlf = '<!-- kit:start v1 -->\r\nold\r\n<!-- kit:end -->\r\nmine\r\n';
    assert.equal(replaceKitBlock(crlf, block).text, `${block.replace(/\n/g, '\r\n')}mine\r\n`);
    assert.equal(replaceKitBlock('\uFEFF<!-- kit:start v1 -->\n<!-- kit:end -->\nmine\n', block).text, `\uFEFF${block}mine\n`);
    assert.equal(replaceKitBlock('<!-- kit:start v1 -->\n<!-- kit:end -->', block).text, block);
  });

  test('missing, duplicated or misordered markers are left alone', async () => {
    assert.deepEqual(replaceKitBlock('no markers\n', block), { state: 'missing', text: null });
    assert.equal(replaceKitBlock('<!-- kit:start -->\n', block).state, 'missing');
    assert.equal(replaceKitBlock('<!-- kit:start -->\n<!-- kit:end -->\n<!-- kit:start -->\n<!-- kit:end -->\n', block).state, 'duplicate');
    assert.equal(replaceKitBlock('<!-- kit:end -->\n<!-- kit:start -->\n', block).state, 'broken');
  });

  test('the template falls back to English', async () => {
    assert.equal(agentsTemplate(SRC, 'cs').rel, 'system/templates/cs/kit/agents-system.md');
    assert.equal(agentsTemplate(SRC, 'xx').rel, 'system/templates/en/kit/agents-system.md');
    assert.equal(agentsTemplate(tmpDir('upg-none'), 'en'), null);
  });
});

describe('backups', () => {
  test('record, restore (files, removals, created folders) and conflicts', async () => {
    const root = tmpDir('upg-backup');
    writeFile(root, 'a.txt', 'a\n');
    writeFile(root, 'keep/b.txt', 'b\n');
    const before = snapshot(root);
    const b = createBackup(root, { from: '1.0.0', to: '1.1.0', now: new Date(Date.UTC(2026, 8, 24, 10, 5, 7)) });
    assert.equal(b.id, '20260924-100507-1.0.0-to-1.1.0', 'the id is UTC');
    b.recordMany(['a.txt', { rel: 'new/deep/c.txt', next: sha('c\n') }, 'keep/b.txt']);
    writeFile(root, 'a.txt', 'A\n');
    writeFile(root, 'new/deep/c.txt', 'c\n');
    fs.rmSync(path.join(root, 'keep', 'b.txt'));
    const data = JSON.parse(fs.readFileSync(path.join(b.dir, 'backup.json'), 'utf8'));
    assert.deepEqual(data.dirs, ['new/deep', 'new']);
    assert.deepEqual(data.files.map((f) => [f.rel, f.existed]), [['a.txt', true], ['new/deep/c.txt', false], ['keep/b.txt', true]]);
    b.finish();

    writeFile(root, 'a.txt', 'edited later\n');
    const refused = restoreBackup(root, b.dir);
    assert.deepEqual(refused.conflicts, ['a.txt']);
    assert.equal(refused.applied, false);
    assert.equal(readFile(root, 'a.txt'), 'edited later\n');
    const done = restoreBackup(root, b.dir, { force: true });
    assert.equal(done.applied, true);
    assertSameTree(before, snapshot(root), 'restored, the created folders removed');
    assert.equal(fs.readFileSync(path.join(b.dir, 'conflicts', 'a.txt'), 'utf8'), 'edited later\n');
    const second = createBackup(root, { from: '1.0.0', to: '1.1.0', now: new Date(Date.UTC(2026, 8, 24, 10, 5, 7)) });
    assert.equal(second.id, '20260924-100507-1.0.0-to-1.1.0-2', 'ids never collide');
  });

  test('--rollback of another backup leaves the lock of an interrupted upgrade in place', async () => {
    const root = tmpDir('upg-lockother');
    writeFile(root, 'a.txt', 'a\n');
    const older = createBackup(root, { from: '1.0.0', to: '1.1.0', now: new Date(Date.UTC(2026, 0, 1, 9, 0, 0)) });
    older.recordMany([{ rel: 'a.txt', next: sha('b\n') }]);
    writeFile(root, 'a.txt', 'b\n');
    older.finish();
    const newer = createBackup(root, { from: '1.1.0', to: '1.2.0', now: new Date(Date.UTC(2026, 0, 2, 9, 0, 0)) });
    newer.recordMany([{ rel: 'a.txt', next: sha('half\n') }]);
    writeJson(root, LOCK_FILE, { backup: newer.id, from: '1.1.0', to: '1.2.0' });
    writeFile(root, 'a.txt', 'half\n');
    const res = rollbackUpgrade(root, { id: older.id, force: true });
    assert.equal(res.applied, true);
    assert.equal(res.lockRemoved, false);
    assert.deepEqual(res.conflicts, ['a.txt'], 'the half-written file is not what the older upgrade left');
    assert.equal(lockState(root)?.backup, newer.id);
    // The older rollback changed a.txt after the newer upgrade wrote it: a conflict for the newer one.
    assert.deepEqual(rollbackUpgrade(root, {}).conflicts, ['a.txt']);
    const res2 = rollbackUpgrade(root, { force: true });
    assert.equal(res2.id, newer.id, 'without an id the interrupted upgrade is the one undone');
    assert.equal(res2.lockRemoved, true);
    assert.equal(readFile(root, 'a.txt'), 'b\n', 'the state before the newer upgrade');
    assert.throws(() => rollbackUpgrade(root, { id: 'nope' }), (err) => err.code === 'rollback_not_found');
  });

  test('a rollback that takes the hook command away is refused while the agents\' hooks run this vault', async () => {
    const root = path.join(tmpDir('upg-hookguard'), 'my vault');
    writeFile(root, 'system/memory.mjs', '// the CLI\n');
    const b = createBackup(root, { from: '0.1.1', to: '0.1.2', now: new Date(Date.UTC(2026, 8, 24, 9, 0, 0)) });
    b.recordMany([{ rel: 'system/lib/commands/hook.mjs', next: sha('hook\n') }]);
    writeFile(root, 'system/lib/commands/hook.mjs', 'hook\n');
    b.finish();
    const home = tmpDir('upg-hookguard-home');
    const env = { CLAUDE_CONFIG_DIR: path.join(home, 'claude cfg') };
    const script = path.join(root, 'system', 'memory.mjs');
    const settings = (command) => writeJson(home, 'claude cfg/settings.json', { hooks: { Stop: [{ hooks: [{ type: 'command', ...command }] }] } });
    // Another vault's hooks do not count.
    settings({ command: `"/usr/bin/node" "${path.join(tmpDir('upg-other'), 'system', 'memory.mjs')}" hook claude-code stop` });
    assert.deepEqual(rollbackUpgrade(root, { dryRun: true, env, home }).hooks, []);
    // This vault's, in the shell form and in the exec form: refused, nothing restored.
    for (const command of [{ command: `"/usr/bin/node" "${script}" hook claude-code stop` }, { command: '/usr/bin/node', args: [script, 'hook', 'claude-code', 'stop'] }]) {
      settings(command);
      assert.deepEqual(rollbackUpgrade(root, { dryRun: true, env, home }).hooks, [path.join(home, 'claude cfg', 'settings.json')]);
      assert.throws(() => rollbackUpgrade(root, { env, home }), (err) => err.code === 'rollback_hooks' && /connect claude-code --projects --remove/.test(err.message));
      assert.equal(readFile(root, 'system/lib/commands/hook.mjs'), 'hook\n');
    }
    // Codex hooks count the same; without any, the rollback runs.
    writeJson(home, 'claude cfg/settings.json', {});
    writeJson(home, 'codex/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node '${script}' hook codex stop` }] }] } });
    assert.throws(() => rollbackUpgrade(root, { env: { ...env, CODEX_HOME: path.join(home, 'codex') }, home }), (err) => err.code === 'rollback_hooks');
    const done = rollbackUpgrade(root, { env, home });
    assert.equal(done.applied, true);
    assert.ok(!fs.existsSync(path.join(root, 'system', 'lib', 'commands', 'hook.mjs')));
  });

  test('pruning keeps the five newest and never touches other folders', async () => {
    const root = tmpDir('upg-prune');
    for (let i = 1; i <= 7; i++) {
      const b = createBackup(root, { from: '0.1.0', to: `0.1.${i}`, now: new Date(Date.UTC(2026, 0, i, 12, 0, 0)) });
      b.recordMany([]);
    }
    writeFile(root, '.memory-kit/backups/connect/cursor-20260101.json', '{}\n');
    const removed = pruneBackups(root);
    assert.deepEqual(removed.sort(), ['20260101-120000-0.1.0-to-0.1.1', '20260102-120000-0.1.0-to-0.1.2']);
    assert.equal(listBackups(root).length, 5);
    assert.equal(listBackups(root)[0].id, '20260107-120000-0.1.0-to-0.1.7');
    assert.ok(fs.existsSync(path.join(root, '.memory-kit', 'backups', 'connect', 'cursor-20260101.json')));
  });
});

describe('git and sources', () => {
  test('gitState lists changed, deleted, renamed and untracked paths of the vault folder only', { skip: !HAS_GIT && 'git is not installed' }, async () => {
    const repo = tmpDir('upg-gitstate');
    const vault = path.join(repo, 'my vault');
    writeFile(vault, 'a.md', 'a\n');
    writeFile(vault, 'b.md', 'b\n');
    writeFile(vault, 'c.md', 'c\n');
    writeFile(repo, 'outside.md', 'o\n');
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'x']);
    writeFile(vault, 'a.md', 'A\n');
    fs.rmSync(path.join(vault, 'b.md'));
    git(repo, ['mv', 'my vault/c.md', 'my vault/d é.md']);
    writeFile(vault, 'new/e.md', 'e\n');
    writeFile(repo, 'outside.md', 'O\n');
    const state = gitState(vault);
    assert.equal(state.repo, true);
    assert.deepEqual([...state.dirty].sort(), ['a.md', 'b.md', 'c.md', 'd é.md', 'new/e.md']);
    assert.deepEqual(gitState(tmpDir('upg-nogit')), { repo: false, dirty: new Set() });
  });

  test('samePath follows links and ignores trailing separators', async () => {
    const dir = tmpDir('upg-same');
    fs.mkdirSync(path.join(dir, 'a'));
    assert.ok(samePath(path.join(dir, 'a'), `${path.join(dir, 'a')}${path.sep}`));
    assert.ok(samePath(path.join(dir, 'a'), path.join(dir, 'a', '..', 'a')));
    assert.ok(!samePath(path.join(dir, 'a'), dir));
    try {
      fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'link'), 'junction');
    } catch {
      return; // no permission for links here
    }
    assert.ok(samePath(path.join(dir, 'link'), path.join(dir, 'a')));
  });

  test('isGitUrl', async () => {
    for (const url of ['https://github.com/8Krystof8/memory-kit.git', 'git@github.com:8Krystof8/memory-kit.git', 'ssh://host/x', 'file:///tmp/kit']) {
      assert.ok(isGitUrl(url), url);
    }
    for (const s of ['./kit', 'C:\\kit', 'kit', '']) assert.ok(!isGitUrl(s), s);
  });
});
