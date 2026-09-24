// Windows and macOS correctness: the home folder, memory.json roots on another system, Windows
// device names, letter case, NFC/NFD file names, CRLF generated files, OS junk, reparse points,
// git top-level detection, retried moves, atomic rewrites, init and the pre-commit hook.
// Where a real Windows or Mac is needed, the pure functions get path.win32 or a platform name.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runChecks } from '../../lib/check.mjs';
import { normalizeNotes } from '../../lib/commands/check.mjs';
import { ConfigError, loadConfig } from '../../lib/config.mjs';
import { writeGenerated } from '../../lib/generate.mjs';
import * as util from '../../lib/util.mjs';
import { entryMatches, resolvePrivateRoot } from '../../init.mjs';
import {
  KIT_ROOT, TODAY, bareRoot, checkJson, copyKit, describeFindings, fixtureVault, hashGenerated, loadFixture,
  plantSecret, readFile, removeTmpDirs, runCli, runInit, tmpDir, writeFile, writeJson,
} from '../helpers.mjs';

after(removeTmpDirs);

const WIN = process.platform === 'win32';
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const HAS_SH = !WIN && spawnSync('sh', ['-c', 'exit 0'], { windowsHide: true }).status === 0;
const GIT_BIN = HAS_SH && HAS_GIT ? spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', windowsHide: true }).stdout.trim() : '';

// ---------------------------------------------------------------------------------------------
// Helpers of this file

/** A clean git identity and no user or system configuration. */
function gitEnv() {
  const home = tmpDir('git-home');
  const global = path.join(home, 'gitconfig');
  fs.writeFileSync(global, '');
  return {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'memory-kit test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'memory-kit test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function gitRun(cwd, env, ...args) {
  const res = spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${res.stdout}${res.stderr}`);
  return res.stdout;
}

/** A directory link (a junction on Windows, which needs no privileges); false when not allowed. */
function tryLink(target, link) {
  try {
    fs.symlinkSync(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

const note = (fm, body = '# Title\n\n> Lead.\n') => `---\n${fm.join('\n')}\n---\n${body}`;
const fact = (description = 'A test fact.') => note(['type: fact', 'status: active', `description: ${description}`,
  'updated: 2026-09-01', 'valid_until: 2027-01-01']);

function setRoot(root, rootPath) {
  const json = JSON.parse(readFile(root, 'memory.json'));
  json.roots[1].path = rootPath;
  writeJson(root, 'memory.json', json);
}

/** Every file name below dir, recursively (POSIX rels). */
function allFiles(dir) {
  return fs.readdirSync(dir, { recursive: true }).map((p) => String(p).split(path.sep).join('/'));
}

// ---------------------------------------------------------------------------------------------

describe('home folder and memory.json paths', () => {
  test('~, ~/ and ~\\ expand under the home folder; nothing else does', () => {
    assert.equal(util.expandHome('~', { home: '/home/k', pathMod: path.posix }), '/home/k');
    assert.equal(util.expandHome('~/memory-private', { home: '/home/k', pathMod: path.posix }), '/home/k/memory-private');
    assert.equal(util.expandHome('~\\memory-private', { home: '/home/k', pathMod: path.posix }), '/home/k/memory-private');
    assert.equal(util.expandHome('~\\memory-private', { home: 'C:\\Users\\k', pathMod: path.win32 }), 'C:\\Users\\k\\memory-private');
    assert.equal(util.expandHome('~/a/b', { home: 'C:\\Users\\k', pathMod: path.win32 }), 'C:\\Users\\k\\a\\b');
    for (const other of ['~foo', 'x/~/y', '../private', '/abs']) assert.equal(util.expandHome(other, { home: '/h' }), null, other);
    assert.equal(util.resolvePath('C:\\vault', '..\\private', { pathMod: path.win32 }), 'C:\\private');
    assert.equal(util.resolvePath('C:\\vault', '~/private', { home: 'C:\\Users\\k', pathMod: path.win32 }), 'C:\\Users\\k\\private');
  });

  test('a ~/ root resolves under os.homedir() even where HOME is not set (cmd, PowerShell, MCP hosts)', () => {
    const env = { ...process.env };
    delete env.HOME;
    const url = pathToFileURL(path.join(KIT_ROOT, 'system', 'lib', 'util.mjs')).href;
    const script = `import(${JSON.stringify(url)}).then((u) => process.stdout.write(JSON.stringify({ resolved: u.resolvePath(process.cwd(), '~/memory-private'), home: require('node:os').homedir() })))`;
    const res = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stderr);
    const { resolved, home } = JSON.parse(res.stdout);
    assert.ok(path.isAbsolute(home) && home.length > 1, home);
    assert.equal(resolved, path.resolve(home, 'memory-private'));
    assert.equal(util.resolvePath('/base', '~/x'), path.resolve(os.homedir(), 'x'));
  });

  test('paths absolute only on another operating system are recognized', () => {
    for (const p of ['D:/memory-private', 'D:\\memory-private', 'd:', 'D:rel', '\\\\server\\share\\x', '\\private']) {
      assert.equal(util.isForeignAbsolute(p, 'linux'), true, `linux ${p}`);
      assert.equal(util.isForeignAbsolute(p, 'darwin'), true, `darwin ${p}`);
    }
    for (const p of ['../private', '~/private', '/home/k/private', 'private', '~\\private']) {
      assert.equal(util.isForeignAbsolute(p, 'linux'), false, `linux ${p}`);
    }
    for (const p of ['/home/k/private', '\\private']) assert.equal(util.isForeignAbsolute(p, 'win32'), true, `win32 ${p}`);
    for (const p of ['D:\\private', 'D:/private', '\\\\server\\share\\x', '//server/share/x', '..\\private', '~/private']) {
      assert.equal(util.isForeignAbsolute(p, 'win32'), false, `win32 ${p}`);
    }
  });

  test('insidePath ignores letter case where the file system does', () => {
    assert.equal(util.insidePath('C:\\Users\\k\\vault', 'c:\\users\\K\\VAULT\\private', { platform: 'win32' }), true);
    assert.equal(util.insidePath('C:\\vault', 'D:\\vault\\x', { platform: 'win32' }), false);
    assert.equal(util.insidePath('/Users/k/notes', '/users/k/Notes/private', { platform: 'darwin' }), true);
    assert.equal(util.insidePath('/Users/k/Pámet'.normalize('NFC'), '/Users/k/Pámet/x'.normalize('NFD'), { platform: 'darwin' }), true);
    assert.equal(util.insidePath('/home/k/notes', '/home/k/Notes/private', { platform: 'linux' }), false);
    assert.equal(util.insidePath('/home/k/vault', '/home/k/vault-private', { platform: 'linux' }), false, 'a sibling with the same prefix');
    assert.equal(util.insidePath('/home/k/vault', '/home/k/vault/..private', { platform: 'linux' }), true, 'a folder named ..private');
    assert.equal(util.insidePath('/home/k/vault', '/home/k/vault', { platform: 'linux' }), true);
  });

  test('realpathLoose follows links for paths that do not exist yet', (t) => {
    const base = tmpDir('realpath');
    fs.mkdirSync(path.join(base, 'real'));
    if (!tryLink(path.join(base, 'real'), path.join(base, 'link'))) return t.skip('links are not allowed here');
    assert.equal(util.realpathLoose(path.join(base, 'link', 'not', 'yet')), path.join(fs.realpathSync.native(path.join(base, 'real')), 'not', 'yet'));
    assert.equal(util.realpathLoose(path.join(base, 'real')), fs.realpathSync.native(path.join(base, 'real')));
  });
});

describe('memory.json roots', () => {
  test('a drive-letter or UNC root is unavailable here, never a folder inside the vault', { skip: WIN && 'these are real paths on Windows' }, () => {
    for (const given of ['D:/memory-private', 'D:\\memory-private', '\\\\server\\share\\memory-private']) {
      const fx = fixtureVault('en');
      setRoot(fx.root, given);
      const cfg = loadConfig(fx.root);
      assert.deepEqual({ ...cfg.roots[1] }, { id: 'private', path: given, privacy: 'local', exists: false, foreign: true }, given);
      assert.ok(cfg.warnings.some((w) => w.includes(given) && w.includes('another operating system')), cfg.warnings.join('\n'));

      const created = runCli(fx.root, ['new', 'fact', 'health/blood-test', '--today', TODAY, '--force']);
      assert.equal(created.code, 1, created.stdout + created.stderr);
      assert.match(created.stdout, /another operating system/);
      const added = runCli(fx.root, ['sector', 'add', 'family', '--privacy', 'local', '--today', TODAY]);
      assert.equal(added.code, 1, added.stdout + added.stderr);
      assert.match(added.stdout, /another operating system/);
      const files = allFiles(fx.base);
      assert.ok(!files.some((f) => f.endsWith('blood-test.md') || f.includes('D:') || f.includes('\\')), files.filter((f) => /blood|D:|\\/.test(f)).join('\n'));
      assert.ok(!fs.existsSync(path.join(fx.root, 'sectors', 'family')), 'nothing half created');

      const res = checkJson(fx.root, ['--lenient', '--today', TODAY]);
      assert.ok(res.warnings.some((f) => f.code === 'CONFIG' && f.msg.includes(given)), describeFindings(res));
      assert.ok(!res.codes.has('ROOT_MISSING'), describeFindings(res));
    }
  });

  test('a relative root written with backslashes means the same folder everywhere', { skip: WIN && 'native on Windows' }, () => {
    const fx = fixtureVault('en');
    setRoot(fx.root, '..\\private');
    const cfg = loadConfig(fx.root);
    assert.equal(cfg.roots[1].path, path.resolve(fx.root, '..', 'private'));
    assert.equal(cfg.roots[1].exists, true);
  });

  test('a local root inside the repository is a config error, also through a link', (t) => {
    for (const given of ['private', './private', 'sectors/../private', '.', 'sectors']) {
      const fx = fixtureVault('en');
      setRoot(fx.root, given);
      assert.throws(() => loadConfig(fx.root), (err) => err instanceof ConfigError && /inside the repository/.test(err.message), given);
    }
    const fx = fixtureVault('en');
    setRoot(fx.root, '../vault-private');
    assert.equal(loadConfig(fx.root).roots[1].exists, false, 'a sibling that shares the name prefix is fine');
    fs.mkdirSync(path.join(fx.root, 'hidden-in-repo'));
    if (!tryLink(path.join(fx.root, 'hidden-in-repo'), path.join(fx.base, 'linked-private'))) return t.skip('links are not allowed here');
    setRoot(fx.root, '../linked-private');
    assert.throws(() => loadConfig(fx.root), /inside the repository/);
  });

  test('memory.json from a newer kit asks for an upgrade; older or missing versions stay as they were', () => {
    assert.throws(() => loadConfig(bareRoot('en', { version: 2 })),
      (err) => err instanceof ConfigError && /newer than this kit/.test(err.message) && /node system\/memory\.mjs upgrade/.test(err.message));
    assert.throws(() => loadConfig(bareRoot('en', { version: 0 })), (err) => err instanceof ConfigError && /must be 1/.test(err.message));
    assert.throws(() => loadConfig(bareRoot('en', { version: '2' })), (err) => err instanceof ConfigError && /must be 1/.test(err.message));
    assert.equal(loadConfig(bareRoot('en', { version: undefined })).version, 1);
  });
});

describe('Windows device names', () => {
  test('reserved names with or without an extension, and names Windows cannot hold', () => {
    for (const name of ['con', 'CON', 'aux.md', 'Nul.txt', 'com1', 'COM9.md', 'lpt1', 'lpt9.tar.gz', 'prn', 'conin$', 'CONOUT$', 'aux .md', 'com¹']) {
      assert.equal(util.isReservedName(name), true, name);
      assert.equal(util.windowsNameProblem(name), 'reserved', name);
    }
    for (const name of ['console', 'auxiliary.md', 'com0', 'com10', 'lpt', 'nul-notes.md', 'prn2', 'contacts', 'icon']) {
      assert.equal(util.isReservedName(name), false, name);
    }
    for (const [name, problem] of [['scan:1.png', 'char'], ['what?.md', 'char'], ['a\\b.md', 'char'], ['tab\there', 'char'],
      ['notes.', 'end'], ['notes ', 'end'], ['pricing.md', null], ['2026-09-20-kick-off.md', null]]) {
      assert.equal(util.windowsNameProblem(name), problem, name);
    }
  });

  test('new, sector add and init refuse them', { skip: !HAS_GIT && 'init needs git for its plan' }, () => {
    const fx = fixtureVault('en');
    for (const target of ['work/aux', 'work/con/pricing-copy', 'work/nul']) {
      const res = runCli(fx.root, ['new', 'fact', target, '--today', TODAY, '--force']);
      assert.equal(res.code, 1, `${target}: ${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /reserves/, target);
    }
    assert.ok(!fs.existsSync(path.join(fx.root, 'sectors', 'work', 'con')), 'no shelf created');
    const added = runCli(fx.root, ['sector', 'add', 'prn', '--today', TODAY]);
    assert.equal(added.code, 1, added.stdout + added.stderr);
    assert.match(added.stdout, /"prn" is a device name Windows reserves/);
    assert.ok(!fs.existsSync(path.join(fx.root, 'sectors', 'prn')));

    const kit = copyKit(path.join(tmpDir('init-names'), 'vault'));
    const init = runInit(kit, ['--mode', 'github', '--lang', 'en', '--sectors', 'core,com1', '--today', TODAY, '--dry-run']);
    assert.equal(init.code, 2, init.stdout + init.stderr);
    assert.match(init.stderr, /"com1" is a device name Windows reserves/);
  });

  test('new checks the names it writes: a decision gets its date prefix first, shelves still count', () => {
    const fx = fixtureVault('en');
    const made = runCli(fx.root, ['new', 'decision', 'work/aux', '--today', TODAY, '--force']);
    assert.equal(made.code, 0, made.stdout + made.stderr);
    assert.match(made.stdout, new RegExp(`created sectors/work/decisions/${TODAY}-aux\\.md`));
    assert.ok(fs.existsSync(path.join(fx.root, 'sectors', 'work', 'decisions', `${TODAY}-aux.md`)));
    assert.equal(util.windowsNameProblem(`${TODAY}-aux.md`), null);
    const shelf = runCli(fx.root, ['new', 'decision', 'work/con/pricing-rule', '--today', TODAY, '--force']);
    assert.equal(shelf.code, 1, shelf.stdout + shelf.stderr);
    assert.match(shelf.stdout, /"con" is a device name Windows reserves/);
    assert.ok(!fs.existsSync(path.join(fx.root, 'sectors', 'work', 'con')), 'no shelf created');
  });

  test('check: NAME_PORTABLE is an error in every mode, once per bad segment', { skip: WIN && 'Windows cannot create these names' }, async () => {
    const fx = fixtureVault('en');
    writeFile(fx.root, 'sectors/work/aux.md', fact());
    writeFile(fx.root, 'sectors/work/lpt1/first-shelf-note.md', fact());
    writeFile(fx.root, 'sectors/work/lpt1/second-shelf-note.md', fact());
    writeFile(fx.root, 'attachments/scan:1.png', Buffer.alloc(16));
    writeFile(fx.root, 'sectors/con/_con.md', note(['type: sector', 'status: active', 'description: Con.', 'updated: 2026-09-01',
      'keywords: [con, a, b, c, d]', 'state: on', 'privacy: github', 'when_here: Con.', 'not_here: Else.'], '# Con\n'));
    writeFile(fx.priv, 'sectors/health/nul.md', fact());
    const { cfg, vault } = await loadFixture(fx.root);
    for (const strict of [true, false]) {
      const res = await runChecks(cfg, vault, { strict, today: TODAY });
      const found = res.errors.filter((f) => f.code === 'NAME_PORTABLE');
      assert.deepEqual(found.map((f) => `${f.root ?? 'main'}:${f.rel}`).sort(), [
        'main:attachments/scan:1.png', 'main:sectors/con', 'main:sectors/work/aux.md', 'main:sectors/work/lpt1', 'private:sectors/health/nul.md',
      ], describeFindings(res));
      assert.ok(!res.warnings.some((f) => f.code === 'NAME_PORTABLE'));
      assert.match(found.find((f) => f.rel === 'sectors/work/aux.md').msg, /"aux\.md" is a device name Windows reserves/);
      assert.match(found.find((f) => f.rel === 'attachments/scan:1.png').msg, /character Windows forbids/);
    }
  });
});

describe('letter case and Unicode file names', () => {
  test('resolveExact needs the exact letter case; NFC and NFD spellings match', () => {
    const dir = tmpDir('exact');
    writeFile(dir, 'Sub/State.md', 'x\n');
    const nfd = 'káva.md'.normalize('NFD');
    writeFile(dir, `cafe/${nfd}`, 'x\n');
    assert.equal(util.resolveExact(dir, 'Sub/State.md'), 'Sub/State.md');
    assert.equal(util.resolveExact(dir, 'sub/state.md'), null);
    assert.equal(util.resolveExact(dir, 'Sub/state.md'), null);
    assert.equal(util.resolveCaseless(dir, 'sub/state.md'), 'Sub/State.md');
    assert.equal(util.resolveExact(dir, 'cafe/káva.md'.normalize('NFC'))?.normalize('NFC'), 'cafe/káva.md'.normalize('NFC'));
    assert.equal(util.resolveExact(dir, 'missing.md'), null);
    assert.equal(util.resolveExact(dir, 'Sub//State.md'), null);
    assert.equal(util.existsExact(dir, 'Sub/State.md'), true);
    assert.equal(util.existsExact(dir, 'sub/State.md'), false);
  });

  test('a manifest or hub in the wrong letter case counts as missing on every system and is reported', async () => {
    const fx = fixtureVault('en');
    fs.renameSync(path.join(fx.root, 'sectors', 'work', '_work.md'), path.join(fx.root, 'sectors', 'work', '_Work.md'));
    fs.renameSync(path.join(fx.root, 'state.md'), path.join(fx.root, 'State.md'));
    const { cfg, vault } = await loadFixture(fx.root);
    assert.ok(!vault.sectorById.has('work'), 'the sector has no manifest');
    assert.ok(!vault.byRel.has('state.md'), 'the hub is missing');
    const res = await runChecks(cfg, vault, { strict: false, today: TODAY });
    const found = res.warnings.filter((f) => f.code === 'CASE_MISMATCH');
    assert.deepEqual(found.map((f) => f.rel).sort(), ['State.md', 'sectors/work/_Work.md'], describeFindings(res));
    assert.match(found.find((f) => f.rel === 'State.md').msg, /git mv -f State\.md state\.md/);
    assert.ok([...res.errors, ...res.warnings].some((f) => f.code === 'SECTOR_NO_MANIFEST'), describeFindings(res));
  });

  test('an NFD file name generates the same bytes as its NFC twin', async () => {
    const rels = ['sectors/work/kávovar-servis.md', 'inbox/2026-09-19-nápad-na-web.md'];
    const hashes = [];
    for (const form of ['NFC', 'NFD']) {
      const fx = fixtureVault('en');
      writeFile(fx.root, rels[0].normalize(form), fact('Coffee machine service.'));
      writeFile(fx.root, rels[1].normalize(form), 'A quick idea for the web.\n');
      const { cfg, vault } = await loadFixture(fx.root);
      assert.ok(vault.byRel.has(rels[0].normalize('NFC')), form);
      await writeGenerated(cfg, vault, { today: TODAY });
      hashes.push(hashGenerated(fx.root));
      assert.ok(readFile(fx.root, '_ai/catalog.tsv').includes(`\n${rels[0].normalize('NFC')}\t`), form);
    }
    assert.deepEqual(hashes[1], hashes[0]);
  });

  test('normalizing a note with an NFD name rewrites that file, never an NFC twin', async () => {
    const fx = fixtureVault('en');
    const rel = 'sectors/work/kávovar-servis.md';
    writeFile(fx.root, rel.normalize('NFD'), fact('Coffee machine service.').replace(/\n/g, '\r\n'));
    const { vault } = await loadFixture(fx.root);
    assert.equal(vault.byRel.get(rel.normalize('NFC')).crlf, true);
    assert.ok(normalizeNotes(vault).some((n) => n.rel === rel.normalize('NFC')));
    const twins = fs.readdirSync(path.join(fx.root, 'sectors', 'work')).filter((n) => n.normalize('NFC') === 'kávovar-servis.md'.normalize('NFC'));
    assert.equal(twins.length, 1, twins.join(', '));
    assert.ok(!fs.readFileSync(path.join(fx.root, 'sectors', 'work', twins[0]), 'utf8').includes('\r'));
  });

  test('a secret in a note with an NFD name is found and reported by its NFC path', async () => {
    const fx = fixtureVault('en');
    const rel = 'sectors/work/přístupy.md';
    writeFile(fx.root, rel.normalize('NFD'), `${fact('Access notes.')}\nkey ${plantSecret().aws}\n`);
    const { cfg, vault } = await loadFixture(fx.root);
    const res = await runChecks(cfg, vault, { only: ['SECRET'], notesOnly: true, today: TODAY });
    assert.deepEqual(res.errors.map((f) => f.rel), [rel.normalize('NFC')]);
  });

  test('the pre-commit hook re-stages a normalized note whose name git keeps in NFD', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const env = gitEnv();
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['check', '--generate', '--today', TODAY], { env }).code, 0);
    gitRun(fx.root, env, 'init', '-q', '-b', 'main');
    gitRun(fx.root, env, 'add', '-A');
    gitRun(fx.root, env, 'commit', '-q', '-m', 'vault');
    const rel = 'inbox/2026-09-19-nápad-na-web.md';
    writeFile(fx.root, rel.normalize('NFD'), 'A quick idea\r\nfor the web.\r\n');
    gitRun(fx.root, env, 'add', '-A');
    const res = runCli(fx.root, ['check', '--pre-commit', '--today', TODAY], { env });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const stored = gitRun(fx.root, env, 'ls-files', '-z', '--', 'inbox').split('\0').find((n) => n.normalize('NFC') === rel.normalize('NFC'));
    assert.ok(stored, 'the note is staged');
    assert.equal(gitRun(fx.root, env, 'show', `:${stored}`), 'A quick idea\nfor the web.\n');
    assert.equal(gitRun(fx.root, env, 'diff', '--name-only').trim(), '', 'index and work tree agree');
  });
});

describe('generated files with CRLF or a BOM', () => {
  test('they are not hand edits; --generate writes the LF bytes back', async () => {
    const fx = fixtureVault('en');
    let { cfg, vault } = await loadFixture(fx.root);
    await writeGenerated(cfg, vault, { today: TODAY });
    const before = hashGenerated(fx.root);
    for (const rel of ['_ai/start.md', '_ai/catalog.tsv', 'home.md']) writeFile(fx.root, rel, readFile(fx.root, rel).replace(/\n/g, '\r\n'));
    writeFile(fx.root, '.ignore', `\uFEFF${readFile(fx.root, '.ignore')}`);
    ({ cfg, vault } = await loadFixture(fx.root));
    const res = await runChecks(cfg, vault, { strict: true, today: TODAY });
    assert.deepEqual([...res.errors, ...res.warnings].filter((f) => f.code.startsWith('GEN_')), [], describeFindings(res));
    const again = await writeGenerated(cfg, vault, { today: TODAY });
    assert.deepEqual(again.written.sort(), ['.ignore', '_ai/catalog.tsv', '_ai/start.md', 'home.md']);
    assert.deepEqual(hashGenerated(fx.root), before);
  });
});

describe('OS junk files and reparse points', () => {
  test('desktop.ini, Thumbs.db, ehthumbs.db, .DS_Store and Icon\\r are not part of the vault', async () => {
    const fx = fixtureVault('en');
    const junk = ['sectors/health/desktop.ini', 'sectors/work/Thumbs.db', 'attachments/ehthumbs.db', 'sectors/work/.DS_Store', 'journal/Desktop.ini'];
    if (!WIN) junk.push('sectors/work/Icon\r');
    for (const rel of junk) writeFile(fx.root, rel, 'x\n');
    const { cfg, vault } = await loadFixture(fx.root);
    assert.deepEqual(vault.files.filter((f) => util.isOsJunk(path.posix.basename(f.rel))), []);
    const res = await runChecks(cfg, vault, { strict: true, today: TODAY });
    assert.ok(!res.errors.some((f) => f.code === 'LOCAL_IN_GIT' || f.code === 'NAME_PORTABLE'), describeFindings(res));
  });

  test('a reparse point that is not a link (Windows) is walked like a folder or file', (t) => {
    const dir = tmpDir('reparse');
    fs.mkdirSync(path.join(dir, 'real'));
    writeFile(dir, 'note.md', 'x\n');
    const reparse = (name) => ({ name, isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false });
    assert.equal(util.direntKind(dir, reparse('real')), 'dir');
    assert.equal(util.direntKind(dir, reparse('note.md')), 'file');
    assert.equal(util.direntKind(dir, reparse('gone')), 'other');
    if (!tryLink(path.join(dir, 'real'), path.join(dir, 'link'))) return t.skip('links are not allowed here');
    const entry = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.name === 'link');
    assert.equal(util.direntKind(dir, entry), 'link', 'a real link is still skipped');
  });
});

describe('git top level, moves and sync', { skip: !HAS_GIT && 'git is not installed' }, () => {
  test('the top level comes from git itself, not from comparing paths', () => {
    const env = gitEnv();
    const dir = tmpDir('toplevel');
    assert.equal(util.gitRepoState(dir).state, 'none');
    gitRun(dir, env, 'init', '-q');
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.equal(util.gitRepoState(dir).state, 'top');
    assert.equal(util.gitRepoState(path.join(dir, 'sub')).state, 'nested');
    assert.equal(util.gitRepoState(path.join(dir, '.git')).state, 'none', 'the .git folder is not a work tree');
    const broken = tmpDir('broken-git');
    writeFile(broken, '.git', `gitdir: ${path.join(broken, 'missing')}\n`);
    const state = util.gitRepoState(broken);
    assert.equal(state.state, 'error');
    assert.ok(state.detail.length > 0);
    assert.equal(util.isGitRepo(broken), false);
  });

  test('a work tree reached through a link is still the top level', (t) => {
    const env = gitEnv();
    const dir = tmpDir('toplevel');
    gitRun(dir, env, 'init', '-q');
    const link = path.join(tmpDir('toplevel-link'), 'vault');
    if (!tryLink(dir, link)) return t.skip('links are not allowed here');
    assert.equal(util.isGitRepo(link), true);
  });

  test('git() merges env over process.env', () => {
    const dir = tmpDir('git-env');
    assert.equal(util.git(dir, ['var', 'GIT_EDITOR'], { env: { GIT_EDITOR: 'my-editor --wait' } }).stdout.trim(), 'my-editor --wait');
  });

  test('movePath: git mv when it works, else a retried rename with the move staged', () => {
    const env = gitEnv();
    const dir = tmpDir('move');
    gitRun(dir, env, 'init', '-q');
    writeFile(dir, 'sectors/a/x.md', 'x\n');
    writeFile(dir, 'sectors/a/untracked.md', 'u\n');
    gitRun(dir, env, 'add', 'sectors/a/x.md');
    gitRun(dir, env, 'commit', '-q', '-m', 'a');

    assert.equal(util.movePath(dir, 'sectors/a', 'archive/sectors/a', { useGit: true }), 'git');
    assert.match(gitRun(dir, env, 'status', '--porcelain'), /^R {2}sectors\/a\/x\.md -> archive\/sectors\/a\/x\.md$/m);
    gitRun(dir, env, 'commit', '-q', '-m', 'moved');

    // A held index lock (another git program) makes git mv fail, and git add after the rename too:
    // the folder moves, the index stays as it was, and movePath says so.
    const lock = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    assert.equal(util.movePath(dir, 'archive/sectors/a', 'sectors/a', { useGit: true }), 'unstaged');
    fs.rmSync(lock);
    assert.equal(readFile(dir, 'sectors/a/x.md'), 'x\n');
    assert.equal(readFile(dir, 'sectors/a/untracked.md'), 'u\n');
    assert.ok(!fs.existsSync(path.join(dir, 'archive', 'sectors', 'a')));
    assert.equal(gitRun(dir, env, 'diff', '--cached', '--name-only').trim(), '', 'nothing staged');
    gitRun(dir, env, 'add', '-A');
    gitRun(dir, env, 'commit', '-q', '-m', 'moved back');

    const saved = process.env.PATH;
    try {
      process.env.PATH = '';
      assert.equal(util.movePath(dir, 'sectors/a', 'sectors/b', { useGit: true }), 'rename', 'without git on PATH');
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(readFile(dir, 'sectors/b/x.md'), 'x\n');
  });

  test('after a failed git mv the rename is staged, and untracked files stay untracked', { skip: !GIT_BIN && 'uses a POSIX git wrapper' }, () => {
    const env = gitEnv();
    const dir = tmpDir('move-stage');
    gitRun(dir, env, 'init', '-q');
    writeFile(dir, 'sectors/a/x.md', 'x\n');
    writeFile(dir, 'sectors/a/untracked.md', 'u\n');
    gitRun(dir, env, 'add', 'sectors/a/x.md');
    gitRun(dir, env, 'commit', '-q', '-m', 'a');
    // A git that refuses mv (as with a file held open on Windows) and does everything else.
    const bin = tmpDir('git-wrapper');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = mv ]; then echo "fatal: renaming failed" >&2; exit 128; fi\nexec "${GIT_BIN}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    const saved = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) };
    try {
      Object.assign(process.env, env, { PATH: `${bin}${path.delimiter}${saved.PATH}` });
      assert.equal(util.movePath(dir, 'sectors/a', 'archive/sectors/a', { useGit: true }), 'rename');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const status = gitRun(dir, env, 'status', '--porcelain', '--untracked-files=all');
    assert.match(status, /^R {2}sectors\/a\/x\.md -> archive\/sectors\/a\/x\.md$/m, status);
    assert.match(status, /^\?\? archive\/sectors\/a\/untracked\.md$/m, status);
  });

  test('movePath: a tracked file deleted before the move stays a deletion, the rest are staged renames', () => {
    const env = gitEnv();
    const dir = tmpDir('move-deleted');
    gitRun(dir, env, 'init', '-q');
    for (const name of ['x.md', 'y.md', 'photo [1].png']) writeFile(dir, `sectors/a/${name}`, `${name}\n`);
    gitRun(dir, env, 'add', '-A');
    gitRun(dir, env, 'commit', '-q', '-m', 'a');
    fs.rmSync(path.join(dir, 'sectors', 'a', 'y.md'));
    // "photo [1].png" as a pattern would also match this untracked file.
    writeFile(dir, 'sectors/a/photo 1.png', 'u\n');
    // git mv refuses the whole folder (bad source: y.md), so the fallback moves and stages it.
    assert.equal(util.movePath(dir, 'sectors/a', 'archive/sectors/a', { useGit: true }), 'rename');
    const staged = gitRun(dir, env, 'diff', '--cached', '--name-status', '-M').trim().split('\n').sort();
    assert.deepEqual(staged, [
      'D\tsectors/a/y.md',
      'R100\tsectors/a/photo [1].png\tarchive/sectors/a/photo [1].png',
      'R100\tsectors/a/x.md\tarchive/sectors/a/x.md',
    ]);
    assert.equal(gitRun(dir, env, 'ls-files', '--others'), 'archive/sectors/a/photo 1.png\n', 'the untracked file stays untracked');
  });

  test('sector off after a tracked note was deleted: renames are staged, so a staged-only commit keeps the sector', () => {
    const env = gitEnv();
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['check', '--generate', '--today', TODAY], { env }).code, 0);
    gitRun(fx.root, env, 'init', '-q', '-b', 'main');
    gitRun(fx.root, env, 'add', '-A');
    gitRun(fx.root, env, 'commit', '-q', '-m', 'vault');
    fs.rmSync(path.join(fx.root, 'sectors', 'hobbies', 'camera-settings.md'));
    const res = runCli(fx.root, ['sector', 'off', 'hobbies', '--today', TODAY], { env });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /moved to archive\/sectors\/hobbies\//);
    assert.equal(res.stderr, '');
    const staged = gitRun(fx.root, env, 'diff', '--cached', '--name-status', '-M').trim().split('\n').sort();
    assert.deepEqual(staged, [
      'D\tsectors/hobbies/camera-settings.md',
      'R100\tsectors/hobbies/_hobbies.md\tarchive/sectors/hobbies/_hobbies.md',
      'R100\tsectors/hobbies/climbing-log.md\tarchive/sectors/hobbies/climbing-log.md',
    ]);
    gitRun(fx.root, env, 'commit', '-q', '--no-verify', '-m', 'archive hobbies');
    const tree = gitRun(fx.root, env, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'sectors/hobbies', 'archive/sectors/hobbies');
    assert.deepEqual(tree.trim().split('\n'), ['archive/sectors/hobbies/_hobbies.md', 'archive/sectors/hobbies/climbing-log.md']);
  });

  test('sector off while another git program holds the index: moved, nothing staged, told to run git add -A', () => {
    const env = gitEnv();
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['check', '--generate', '--today', TODAY], { env }).code, 0);
    gitRun(fx.root, env, 'init', '-q', '-b', 'main');
    gitRun(fx.root, env, 'add', '-A');
    gitRun(fx.root, env, 'commit', '-q', '-m', 'vault');
    const lock = path.join(fx.root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    const res = runCli(fx.root, ['sector', 'off', 'hobbies', '--today', TODAY], { env });
    fs.rmSync(lock);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /moved to archive\/sectors\/hobbies\//);
    assert.match(res.stderr, /git could not stage the move to archive\/sectors\/hobbies\/ .*run git add -A before you commit/);
    assert.ok(fs.existsSync(path.join(fx.root, 'archive', 'sectors', 'hobbies', '_hobbies.md')));
    assert.equal(gitRun(fx.root, env, 'diff', '--cached', '--name-only').trim(), '', 'the index is untouched');
  });

  test('sector off: when the main folder cannot move, the local folder is moved back', () => {
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['check', '--generate', '--today', TODAY]).code, 0);
    fs.rmSync(path.join(fx.root, 'archive', 'sectors'), { recursive: true });
    writeFile(fx.root, 'archive/sectors', 'not a folder\n');
    const res = runCli(fx.root, ['sector', 'off', 'health', '--today', TODAY]);
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stdout, /could not move sectors\/health \(EEXIST\)/);
    assert.match(res.stdout, /Close editors, terminals and sync apps/);
    assert.ok(fs.existsSync(path.join(fx.priv, 'sectors', 'health', 'dentist-appointments.md')), 'the local notes are back');
    assert.ok(!fs.existsSync(path.join(fx.priv, 'archive', 'sectors', 'health')), 'nothing left in the local archive');
    assert.match(readFile(fx.root, 'sectors/health/_health.md'), /^state: on$/m, 'the manifest is untouched');
  });

  test('sync: a .git entry that git cannot use is an error, not "nothing to sync"', () => {
    const fx = fixtureVault('en');
    writeFile(fx.root, '.git', `gitdir: ${path.join(fx.base, 'missing-git-dir')}\n`);
    const res = runCli(fx.root, ['sync'], { env: gitEnv() });
    assert.equal(res.code, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /git cannot use this repository/);
  });

  test('sync never waits for an editor: GIT_EDITOR from the shell cannot block a rebase', () => {
    const env = gitEnv();
    const fx = fixtureVault('en');
    const a = fx.root;
    assert.equal(runCli(a, ['check', '--generate', '--lenient', '--today', TODAY], { env }).code, 0);
    const remote = path.join(tmpDir('remote'), 'vault.git');
    gitRun(path.dirname(remote), env, 'init', '-q', '--bare', '-b', 'main', remote);
    gitRun(a, env, 'init', '-q', '-b', 'main');
    gitRun(a, env, 'add', '-A');
    gitRun(a, env, 'commit', '-q', '-m', 'vault');
    gitRun(a, env, 'remote', 'add', 'origin', remote);
    gitRun(a, env, 'push', '-q', '-u', 'origin', 'main');
    const b = path.join(tmpDir('machine-b'), 'vault');
    gitRun(path.dirname(b), env, 'clone', '-q', remote, b);
    const change = (root, rel, line) => {
      writeFile(root, rel, `${readFile(root, rel)}${line}\n`);
      assert.equal(runCli(root, ['check', '--generate', '--lenient', '--today', TODAY], { env }).code, 0);
      gitRun(root, env, 'add', '-A');
      gitRun(root, env, 'commit', '-q', '-m', `edit ${rel}`);
    };
    change(a, 'sectors/work/pricing.md', '- [fact] 2026-09-20: Machine A was here.');
    gitRun(a, env, 'push', '-q');
    change(b, 'sectors/school/exam-schedule.md', '- [fact] 2026-09-20: Machine B was here.');
    // 'false' fails as an editor: git would stop the rebase if sync let it open one.
    const res = runCli(b, ['sync', '--today', TODAY], { env: { ...env, GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false' } });
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /regenerated/);
    assert.match(res.stdout, /pushed/);
  });
});

describe('atomic rewrites keep file modes', { skip: WIN && 'no POSIX file modes on Windows' }, () => {
  test('writeIfChanged keeps the mode and leaves no temporary file', () => {
    const dir = tmpDir('atomic');
    const file = path.join(dir, 'view.md');
    fs.writeFileSync(file, 'one\n');
    fs.chmodSync(file, 0o640);
    assert.equal(util.writeIfChanged(file, 'two\n'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o640);
    assert.deepEqual(fs.readdirSync(dir), ['view.md']);
  });

  test('normalizing a note keeps its mode', async () => {
    const fx = fixtureVault('en');
    const rel = 'sectors/work/pricing.md';
    const abs = path.join(fx.root, ...rel.split('/'));
    writeFile(fx.root, rel, readFile(fx.root, rel).replace(/\n/g, '\r\n'));
    fs.chmodSync(abs, 0o600);
    const { vault } = await loadFixture(fx.root);
    assert.deepEqual(normalizeNotes(vault), [{ root: 'main', rel }]);
    assert.equal(fs.statSync(abs).mode & 0o777, 0o600);
    assert.ok(!readFile(fx.root, rel).includes('\r'));
    assert.ok(!fs.readdirSync(path.dirname(abs)).some((n) => n.includes('.tmp-')), 'no temporary file left');
  });

  test('a read-only note is left alone (check keeps reporting it)', { skip: process.getuid?.() === 0 && 'root may write anything' }, async () => {
    const fx = fixtureVault('en');
    const rel = 'sectors/work/pricing.md';
    const abs = path.join(fx.root, ...rel.split('/'));
    const crlf = readFile(fx.root, rel).replace(/\n/g, '\r\n');
    writeFile(fx.root, rel, crlf);
    fs.chmodSync(abs, 0o444);
    const { vault } = await loadFixture(fx.root);
    assert.deepEqual(normalizeNotes(vault), []);
    assert.equal(readFile(fx.root, rel), crlf);
    fs.chmodSync(abs, 0o644);
  });
});

describe('init', () => {
  const same = (p) => p;
  const win = { util, platform: 'win32', pathMod: path.win32, home: 'C:\\Users\\k', realpath: same };

  test('private root on Windows: ~\\, the home folder, letter case and another drive', () => {
    const root = 'C:\\Users\\k\\vault';
    assert.deepEqual(resolvePrivateRoot(root, '~\\memory-private', win), { abs: 'C:\\Users\\k\\memory-private', stored: '~/memory-private' });
    assert.deepEqual(resolvePrivateRoot(root, 'C:\\Users\\k\\Documents\\private', win), { abs: 'C:\\Users\\k\\Documents\\private', stored: '~/Documents/private' });
    assert.deepEqual(resolvePrivateRoot(root, '..\\private', win), { abs: 'C:\\Users\\k\\private', stored: '../private' });
    assert.deepEqual(resolvePrivateRoot('D:\\vault', 'C:\\Users\\k\\private', win), { abs: 'C:\\Users\\k\\private', stored: '~/private' });
    assert.throws(() => resolvePrivateRoot(root, 'D:\\private', win),
      (err) => err.exitCode === 2 && /another drive/.test(err.message) && /D:\\private/.test(err.message));
    assert.throws(() => resolvePrivateRoot(root, '\\\\server\\share\\private', win), /another drive/);
    assert.throws(() => resolvePrivateRoot(root, 'c:\\users\\K\\VAULT\\private', win), /must be outside this repository/);
    assert.throws(() => resolvePrivateRoot(root, 'C:\\Users', win), /must not contain this repository/);
  });

  test('private root on macOS and Linux: letter case on macOS, ~\\ everywhere', () => {
    const mac = { util, platform: 'darwin', pathMod: path.posix, home: '/Users/k', realpath: same };
    assert.throws(() => resolvePrivateRoot('/Users/k/notes', '/Users/k/Notes/private', mac), /must be outside this repository/);
    assert.deepEqual(resolvePrivateRoot('/Users/k/notes', '~/memory-private', mac), { abs: '/Users/k/memory-private', stored: '~/memory-private' });
    const linux = { util, platform: 'linux', pathMod: path.posix, home: '/home/k', realpath: same };
    assert.deepEqual(resolvePrivateRoot('/home/k/vault', '~\\private', linux), { abs: '/home/k/private', stored: '~/private' });
    assert.deepEqual(resolvePrivateRoot('/home/k/vault', '/home/k/Vault/private', linux), { abs: '/home/k/Vault/private', stored: '~/Vault/private' });
    assert.deepEqual(resolvePrivateRoot('/srv/vault', '/data/private', linux), { abs: '/data/private', stored: '../../data/private' });
  });

  test('private root inside the repository through a link is refused', (t) => {
    const base = tmpDir('init-link-root');
    const root = path.join(base, 'vault');
    fs.mkdirSync(path.join(root, 'inner'), { recursive: true });
    if (!tryLink(path.join(root, 'inner'), path.join(base, 'outside'))) return t.skip('links are not allowed here');
    assert.throws(() => resolvePrivateRoot(root, '../outside/private', { util }), /must be outside this repository/);
  });

  test('the entry guard resolves links and ignores letter case on Windows and macOS', (t) => {
    assert.equal(entryMatches('C:\\Kit\\System\\init.mjs', 'c:\\kit\\system\\init.mjs', { platform: 'win32', realpath: same }), true);
    assert.equal(entryMatches('/Users/k/Kit/system/init.mjs', '/users/k/kit/system/init.mjs', { platform: 'darwin', realpath: same }), true);
    assert.equal(entryMatches('/home/k/Kit/system/init.mjs', '/home/k/kit/system/init.mjs', { platform: 'linux', realpath: same }), false);
    const viaLink = (p) => p.replace('/link/', '/real/');
    assert.equal(entryMatches('/x/link/system/init.mjs', '/x/real/system/init.mjs', { platform: 'linux', realpath: viaLink }), true);
    assert.equal(entryMatches(undefined, '/x/real/system/init.mjs'), false);

    const base = tmpDir('init-link');
    const kit = copyKit(path.join(base, 'real'));
    const link = path.join(base, 'link');
    if (!tryLink(kit, link)) return t.skip('links are not allowed here');
    assert.equal(entryMatches(path.join(link, 'system', 'init.mjs'), path.join(kit, 'system', 'init.mjs')), true);
    const res = spawnSync(process.execPath, [path.join(link, 'system', 'init.mjs'), '--help'], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /^usage:/);
  });

  test('next steps print one git command per line', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const root = copyKit(path.join(tmpDir('init-steps'), 'vault'));
    const res = runInit(root, ['--mode', 'local', '--lang', 'en', '--sectors', 'core,work', '--today', TODAY, '--yes'], { env: gitEnv() });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(!res.stdout.includes('&&'), res.stdout);
    const lines = res.stdout.split('\n').map((l) => l.trim());
    const at = lines.indexOf('git add -A');
    assert.ok(at > 0, res.stdout);
    assert.equal(lines[at + 1], 'git commit -m "Set up memory"');
  });

  test('a language switch in git after a tracked file was deleted stages each move whole', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const env = gitEnv();
    const root = copyKit(path.join(tmpDir('init-moves'), 'vault'));
    gitRun(root, env, 'init', '-q', '-b', 'main');
    writeFile(root, 'journal/2026-09-01-old-entry.md', '---\ntype: journal\n---\n# Old\n');
    gitRun(root, env, 'add', '-A');
    gitRun(root, env, 'commit', '-q', '-m', 'kit');
    fs.rmSync(path.join(root, 'journal', '2026-09-01-old-entry.md'));
    // git mv journal denik refuses (bad source), so init falls back to a rename it stages.
    const res = runInit(root, ['--mode', 'github', '--lang', 'cs', '--sectors', 'core,work', '--today', TODAY, '--yes'], { env });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const staged = gitRun(root, env, 'diff', '--cached', '--name-only', '--no-renames', '-z').split('\0').filter(Boolean);
    for (const rel of ['journal/2026-09-01-old-entry.md', 'journal/.gitkeep', 'denik/.gitkeep']) assert.ok(staged.includes(rel), `${rel} staged`);
    assert.equal(gitRun(root, env, 'ls-files', '--others', '--', 'denik'), '', 'nothing of the moved folder left untracked');
  });
});

// ---------------------------------------------------------------------------------------------
// The pre-commit hook runs under whatever PATH a GUI git client gives it.

// A PATH with git and the POSIX tools but without node.
const BARE_PATH = [...new Set([path.dirname(GIT_BIN || '/usr/bin/git'), '/usr/bin', '/bin'])].join(':');
const NODE_ON_BARE_PATH = BARE_PATH.split(':').some((d) => fs.existsSync(path.join(d, 'node')));
const FIXED_NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => fs.existsSync(p));
/** True when bin is Node.js 22 or newer, by the same probe the hook uses. */
const newNode = (bin) => spawnSync(bin, ['-e', 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)'], { windowsHide: true }).status === 0;
// A real node 22+ the hook would find before the shims of a test in a usual place.
const NEW_NODE_OUTSIDE = GIT_BIN && [...BARE_PATH.split(':').map((d) => path.join(d, 'node')), '/opt/homebrew/bin/node', '/usr/local/bin/node']
  .find((p) => fs.existsSync(p) && newNode(p));

describe('the pre-commit hook finds node outside PATH', { skip: !GIT_BIN && 'needs sh and git' }, () => {
  const HOOK = path.join(KIT_ROOT, '.githooks', 'pre-commit');

  function setup() {
    const dir = tmpDir('hook');
    const env = { ...gitEnv(), HOME: dir };
    delete env.NVM_BIN;
    gitRun(dir, env, 'init', '-q');
    const marker = path.join(dir, 'ran.txt');
    const shim = (rel, label) => {
      const file = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\necho "${label} $*" > "${marker}"\n`);
      fs.chmodSync(file, 0o755);
      return file;
    };
    // A Node.js 20: fails the version probe, prints its version, would run anything else.
    const oldShim = (rel, label) => {
      const file = shim(rel, label);
      fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in -e) exit 1 ;; --version) echo v20.20.2; exit 0 ;; esac\necho "${label} $*" > "${marker}"\n`);
      return file;
    };
    const run = (extra) => {
      const hookEnv = { ...process.env, ...env, ...extra };
      if (!('NVM_BIN' in extra)) delete hookEnv.NVM_BIN;
      return spawnSync('sh', [HOOK], { cwd: dir, env: hookEnv, encoding: 'utf8', windowsHide: true });
    };
    const ran = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : null);
    return { dir, env, shim, oldShim, run, ran };
  }

  test('a node pinned with git config memorykit.node comes first', () => {
    const s = setup();
    const pinned = s.shim('pinned/node', 'pinned');
    const onPath = s.shim('path-bin/node', 'path');
    gitRun(s.dir, s.env, 'config', 'memorykit.node', pinned);
    const res = s.run({ PATH: `${path.dirname(onPath)}:${BARE_PATH}` });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(s.ran(), 'pinned system/memory.mjs check --pre-commit');
  });

  test('a pinned node that is gone falls back to node on PATH', () => {
    const s = setup();
    const onPath = s.shim('path-bin/node', 'path');
    gitRun(s.dir, s.env, 'config', 'memorykit.node', path.join(s.dir, 'no-such-node'));
    const res = s.run({ PATH: `${path.dirname(onPath)}:${BARE_PATH}` });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(s.ran(), 'path system/memory.mjs check --pre-commit');
  });

  test('the check result decides the commit', () => {
    const s = setup();
    const failing = path.join(s.dir, 'failing', 'node');
    fs.mkdirSync(path.dirname(failing));
    // New enough for the probe; the check itself fails.
    fs.writeFileSync(failing, '#!/bin/sh\n[ "$1" = -e ] && exit 0\nexit 1\n');
    fs.chmodSync(failing, 0o755);
    gitRun(s.dir, s.env, 'config', 'memorykit.node', failing);
    assert.equal(s.run({ PATH: BARE_PATH }).status, 1);
  });

  test('a node older than 22 is passed over for a newer one', () => {
    const s = setup();
    const pinned = s.oldShim('pinned/node', 'pinned');
    const onPath = s.shim('path-bin/node', 'path');
    gitRun(s.dir, s.env, 'config', 'memorykit.node', pinned);
    const res = s.run({ PATH: `${path.dirname(onPath)}:${BARE_PATH}` });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(s.ran(), 'path system/memory.mjs check --pre-commit');
  });

  const newOutside = NEW_NODE_OUTSIDE && `Node.js 22 or newer is installed in ${NEW_NODE_OUTSIDE} here`;

  test('a stale node in a usual place does not hide a newer one behind it', { skip: newOutside }, () => {
    const s = setup();
    s.oldShim('.volta/bin/node', 'volta');
    const nvm = s.shim('nvm/v22/bin/node', 'nvm');
    const res = s.run({ PATH: BARE_PATH, NVM_BIN: path.dirname(nvm) });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(s.ran(), 'nvm system/memory.mjs check --pre-commit');
  });

  test('a node on PATH older than 22, with none newer: the commit is refused with the fix', { skip: newOutside }, () => {
    const s = setup();
    const onPath = s.oldShim('path-bin/node', 'path');
    const res = s.run({ PATH: `${path.dirname(onPath)}:${BARE_PATH}` });
    assert.equal(res.status, 1);
    assert.equal(s.ran(), null, 'the old node never runs the check');
    assert.match(res.stderr, /commit refused: .*path-bin\/node \(v20\.20\.2\) is not Node\.js 22 or newer/);
    assert.match(res.stderr, /git config memorykit\.node \/path\/to\/node/);
  });

  test('only a node older than 22 in a usual place: the check is skipped, as when none is found', { skip: (newOutside || NODE_ON_BARE_PATH) && `node is installed in ${NEW_NODE_OUTSIDE || BARE_PATH} here` }, () => {
    const s = setup();
    s.oldShim('.volta/bin/node', 'volta');
    const res = s.run({ PATH: BARE_PATH });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(s.ran(), null);
    assert.match(res.stderr, /no Node\.js 22 or newer found \(.+ is v\d+/);
    assert.match(res.stderr, /check skipped \(set it with: git config memorykit\.node/);
  });

  const noFallback = (NODE_ON_BARE_PATH || FIXED_NODE) && `node is installed in ${FIXED_NODE ?? BARE_PATH} here`;

  test('without node on PATH: Volta, then nvm', { skip: newOutside }, () => {
    const s = setup();
    s.shim('.volta/bin/node', 'volta');
    assert.equal(s.run({ PATH: BARE_PATH }).status, 0);
    assert.equal(s.ran(), 'volta system/memory.mjs check --pre-commit');
    const t2 = setup();
    const nvm = t2.shim('nvm/v22/bin/node', 'nvm');
    assert.equal(t2.run({ PATH: BARE_PATH, NVM_BIN: path.dirname(nvm) }).status, 0);
    assert.equal(t2.ran(), 'nvm system/memory.mjs check --pre-commit');
  });

  test('when node is nowhere, the hook says how to pin it and lets the commit through', { skip: noFallback }, () => {
    const s = setup();
    const res = s.run({ PATH: BARE_PATH });
    assert.equal(res.status, 0);
    assert.match(res.stderr, /node not found, check skipped \(set it with: git config memorykit\.node/);
  });
});

// ---------------------------------------------------------------------------------------------
// The Claude Code SessionStart hook: shell form, which every Claude Code version runs. Exec form
// (`args`) came in 2.1.139; older versions drop `args` and run a bare `node` on the hook input.

describe('the Claude Code SessionStart hook', { skip: !HAS_SH && 'needs sh' }, () => {
  test('its command prints the start file under sh, with the hook input on stdin and a space in the path', () => {
    const settings = JSON.parse(readFile(KIT_ROOT, '.claude/settings.json'));
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(hook.args, undefined);
    const fx = fixtureVault('en');
    const root = path.join(tmpDir('claude hook'), 'my vault');
    fs.cpSync(fx.root, root, { recursive: true });
    const expected = runCli(root, ['start']);
    assert.equal(expected.code, 0, expected.stderr);
    assert.ok(expected.stdout.length > 0);
    const input = JSON.stringify({ session_id: 'abc', transcript_path: '/x/y.jsonl', cwd: root, hook_event_name: 'SessionStart', source: 'startup' });
    const res = spawnSync('sh', ['-c', hook.command], {
      cwd: tmpDir('claude-cwd'),
      input,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, CLAUDE_PROJECT_DIR: root },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, expected.stdout);
  });
});
