// The kit's own files: ownership groups, text hashes, the manifest system/kit.json, the history
// system/kit-history.json, the integrity report and the release tool that maintains them.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_FILES, DEFAULT_SOURCE, HISTORY_FILE, KIT_FILE, buildManifest, compareVersions, groupOf, hashFile,
  hashText, integrityReport, knownHashes, listKitFiles, loadHistory, loadManifest, parseVersion, readVersion,
} from '../../lib/kit.mjs';
import { loadMigrations } from '../../lib/migrations.mjs';
import { hashesAtRef } from '../../tools/release.mjs';
import { KIT_ROOT, copyKit, readFile, removeTmpDirs, tmpDir, writeFile, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const V010 = 'cf74578';
const HAS_V010 = (() => {
  const res = spawnSync('git', ['cat-file', '-e', `${V010}^{commit}`], { cwd: KIT_ROOT, stdio: 'ignore', windowsHide: true });
  return !res.error && res.status === 0;
})();

function release(root, args = []) {
  const res = spawnSync(process.execPath, [path.join(root, 'system', 'tools', 'release.mjs'), ...args, '--root', root], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (res.error) throw res.error;
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** A copy of the kit whose kit.json matches its files (other work may be in progress in the tree). */
function releasedCopy(label) {
  const root = copyKit(path.join(tmpDir(label), 'kit'));
  const res = release(root);
  assert.equal(res.code, 0, res.stderr);
  return root;
}

describe('versions', () => {
  test('compareVersions orders x.y.z numerically, pre-releases before the release', () => {
    assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
    assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
    assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
    assert.equal(compareVersions(' 0.1.1\n', '0.1.1'), 0);
  });

  test('anything else is refused, not guessed', () => {
    assert.throws(() => compareVersions('0.1', '0.1.0'), TypeError);
    assert.throws(() => compareVersions('0.1.0', 'latest'), TypeError);
    assert.equal(parseVersion(null), null);
    assert.deepEqual(parseVersion('2.3.4-beta.1'), { major: 2, minor: 3, patch: 4, pre: ['beta', '1'] });
  });
});

describe('hashText and hashFile', () => {
  test('a text hashes the same with CRLF, a BOM or decomposed accents', () => {
    const plain = hashText('Příliš žluťoučký kůň\nline two\n');
    assert.equal(hashText('Příliš žluťoučký kůň\r\nline two\r\n'), plain);
    assert.equal(hashText('﻿Příliš žluťoučký kůň\nline two\n'), plain);
    assert.equal(hashText('Příliš žluťoučký kůň\nline two\n'.normalize('NFD')), plain);
    assert.equal(hashText(Buffer.from('Příliš žluťoučký kůň\r\nline two\r\n', 'utf8')), plain);
    assert.notEqual(hashText('Příliš žluťoučký kůň\nline two'), plain, 'a missing final newline is a change');
    assert.match(plain, /^[0-9a-f]{64}$/);
  });

  test('binary content is hashed as it is', () => {
    const withNul = Buffer.from([0x61, 0x00, 0x0d, 0x0a]);
    const lf = Buffer.from([0x61, 0x00, 0x0a]);
    assert.notEqual(hashText(withNul), hashText(lf));
    const invalid = Buffer.from([0xff, 0xfe, 0x0d, 0x0a]);
    assert.notEqual(hashText(invalid), hashText(Buffer.from([0xff, 0xfe, 0x0a])));
  });

  test('hashFile: null for a missing file or a folder', () => {
    const dir = tmpDir('hash');
    assert.equal(hashFile(path.join(dir, 'nope.txt')), null);
    assert.equal(hashFile(dir), null);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\r\n');
    assert.equal(hashFile(path.join(dir, 'a.txt')), hashText('x\n'));
  });
});

describe('groupOf (the ownership table)', () => {
  test('code', () => {
    for (const rel of ['system/memory.mjs', 'system/init.mjs', 'system/api.mjs', 'system/VERSION', KIT_FILE, HISTORY_FILE,
      'system/lib/util.mjs', 'system/lib/commands/upgrade.mjs', 'system/lang/cs/pack.json', 'system/templates/en/kit/state.md',
      'system/schema/kit.schema.json', 'system/migrations/index.mjs', 'system/tools/release.mjs']) {
      assert.equal(groupOf(rel), 'code', rel);
    }
  });

  test('tests, except the golden files', () => {
    assert.equal(groupOf('system/tests/helpers.mjs'), 'tests');
    assert.equal(groupOf('system/tests/fixtures/en/golden.json'), 'tests');
    assert.equal(groupOf('system/tests/golden.json'), null);
    assert.equal(groupOf('system/tests/fixtures/en/golden.json', { golden: 'system/tests/fixtures/en/golden.json' }), null);
    assert.equal(groupOf('system/tests/unit/a.test.mjs', { golden: './testy/zlate.json' }), 'tests');
  });

  test('docs and config', () => {
    assert.equal(groupOf('docs/architecture.md'), 'docs');
    assert.equal(groupOf('docs/integrations/codex.md'), 'docs');
    for (const rel of CONFIG_FILES) assert.equal(groupOf(rel), 'config', rel);
  });

  test('never: the owner\'s files, generated files and debris', () => {
    for (const rel of ['README.md', 'README.cs.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'CLAUDE.md', 'AGENTS.md',
      'memory.json', '.gitignore', '.ignore', 'home.md', 'state.md', '_ai/start.md', 'sectors/work/pricing.md',
      'system/cleanup/last.txt', 'system/usage/search.log', '.github/workflows/other.yml', '.githooks/post-merge',
      'system/lib/.DS_Store', 'system/lib/.util.mjs.tmp-123-abc', 'docs/Thumbs.db', 'system/lib/x.mjs~',
      '.memory-kit/backups/x/files/system/lib/util.mjs', 'system/lib/../../etc/passwd', '']) {
      assert.equal(groupOf(rel), null, rel);
    }
  });

  test('paths are normalized first', () => {
    assert.equal(groupOf('system\\lib\\util.mjs'), 'code');
    assert.equal(groupOf('./docs/modes.md'), 'docs');
  });
});

describe('the committed manifest and history', () => {
  const manifest = loadManifest(KIT_ROOT);
  const history = loadHistory(KIT_ROOT);

  test('system/kit.json equals buildManifest of the working tree (run: node system/tools/release.mjs)', () => {
    assert.ok(manifest, 'system/kit.json exists');
    assert.deepEqual(manifest, buildManifest(KIT_ROOT));
    assert.equal(readFile(KIT_ROOT, KIT_FILE), `${JSON.stringify(buildManifest(KIT_ROOT), null, 2)}\n`);
  });

  test('release --check agrees', () => {
    const res = release(KIT_ROOT, ['--check']);
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  });

  test('metadata of this release', async () => {
    assert.equal(manifest.name, 'memory-kit');
    assert.equal(manifest.version, readVersion(KIT_ROOT));
    assert.equal(manifest.node, '22.5.0');
    assert.equal(manifest.upgrade_from, '0.1.0');
    assert.equal(manifest.source, DEFAULT_SOURCE);
    assert.equal(manifest.api_version, 1);
    const migrations = await loadMigrations(KIT_ROOT);
    assert.equal(manifest.data_version, Math.max(1, ...migrations.map((m) => m.to)));
    assert.equal(manifest.data_version, 1, '0.1.1 ships no migration');
    const api = path.join(KIT_ROOT, 'system', 'api.mjs');
    if (fs.existsSync(api)) {
      const m = /export\s+const\s+API_VERSION\s*=\s*(\d+)\s*;/.exec(fs.readFileSync(api, 'utf8'));
      assert.ok(m, 'system/api.mjs exports API_VERSION');
      assert.equal(manifest.api_version, Number(m[1]));
    }
  });

  test('the manifest lists every kit-owned file except itself and the history', () => {
    const listed = Object.keys(manifest.files);
    assert.deepEqual(listed, [...listed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    assert.ok(!listed.includes(KIT_FILE) && !listed.includes(HISTORY_FILE));
    assert.ok(!listed.includes('system/tests/golden.json'));
    for (const rel of ['system/memory.mjs', 'system/VERSION', 'system/lib/kit.mjs', 'system/lib/upgrade.mjs',
      'system/migrations/index.mjs', 'system/tools/release.mjs', '.githooks/pre-commit', 'GEMINI.md']) {
      assert.ok(listed.includes(rel), rel);
    }
    for (const [rel, entry] of Object.entries(manifest.files)) {
      assert.equal(entry.group, groupOf(rel), rel);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/, rel);
    }
    const all = listKitFiles(KIT_ROOT);
    assert.deepEqual(all.filter((rel) => rel !== KIT_FILE && rel !== HISTORY_FILE), listed);
  });

  test('the history holds 0.1.0 and this version', () => {
    const versions = Object.keys(history);
    assert.equal(versions[0], '0.1.0');
    assert.ok(versions.includes(manifest.version));
    assert.deepEqual(versions, [...versions].sort(compareVersions), 'versions in release order');
    const current = history[manifest.version];
    for (const [rel, entry] of Object.entries(manifest.files)) assert.equal(current[rel], entry.sha256, rel);
    assert.equal(Object.keys(current).length, Object.keys(manifest.files).length);
    const old = history['0.1.0'];
    assert.equal(old['system/VERSION'], hashText('0.1.0\n'));
    for (const rel of ['system/memory.mjs', 'system/lib/config.mjs', '.githooks/pre-commit', 'docs/architecture.md',
      'system/tests/helpers.mjs']) {
      assert.ok(old[rel], `0.1.0 shipped ${rel}`);
    }
    assert.ok(!old['system/tests/golden.json'] && !old['AGENTS.md'] && !old['memory.json']);
  });

  test('the 0.1.0 entry is what commit cf74578 shipped', { skip: !HAS_V010 && `commit ${V010} is not in this clone` }, () => {
    assert.deepEqual(hashesAtRef(KIT_ROOT, V010, '0.1.0'), history['0.1.0']);
    assert.throws(() => hashesAtRef(KIT_ROOT, V010, '0.2.0'), /is version 0\.1\.0, not 0\.2\.0/);
  });

  test('new vaults keep upgrade backups out of git (.gitignore); upgrades of older ones use .git/info/exclude', () => {
    assert.ok(readFile(KIT_ROOT, '.gitignore').split('\n').includes('.memory-kit/'));
    assert.equal(groupOf('.gitignore'), null, 'the owner\'s .gitignore is never replaced');
  });

  test('knownHashes collects every shipped hash of a path', () => {
    const h = { '0.1.0': { a: '1', b: '2' }, '0.1.1': { a: '3' }, '0.1.2': { a: '1' } };
    assert.deepEqual([...knownHashes(h, 'a')].sort(), ['1', '3']);
    assert.deepEqual([...knownHashes(h, 'c')], []);
    assert.deepEqual([...knownHashes(undefined, 'a')], []);
  });

  test('loadManifest and loadHistory tolerate missing or broken files', () => {
    const dir = tmpDir('load');
    assert.equal(loadManifest(dir), null);
    assert.deepEqual(loadHistory(dir), {});
    writeFile(dir, KIT_FILE, '{ broken');
    writeFile(dir, HISTORY_FILE, '[1, 2]');
    assert.equal(loadManifest(dir), null);
    assert.deepEqual(loadHistory(dir), {});
    writeJson(dir, KIT_FILE, { version: '1.0.0' });
    assert.equal(loadManifest(dir), null, 'a manifest needs files');
  });
});

describe('the release tool', () => {
  test('--check finds a changed, a new and a removed file; a release run fixes it', () => {
    const root = releasedCopy('release');
    assert.equal(release(root, ['--check']).code, 0);
    fs.appendFileSync(path.join(root, 'system', 'lib', 'text.mjs'), '// changed\n');
    writeFile(root, 'system/lib/brand-new.mjs', 'export const x = 1;\n');
    fs.rmSync(path.join(root, 'docs', 'phone.md'));
    const stale = release(root, ['--check']);
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /~ system\/lib\/text\.mjs/);
    assert.match(stale.stderr, /\+ system\/lib\/brand-new\.mjs/);
    assert.match(stale.stderr, /- docs\/phone\.md/);
    const run = release(root, ['--json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).kitChanged, true);
    assert.equal(release(root, ['--check']).code, 0);
    const again = release(root, ['--json']);
    assert.deepEqual(JSON.parse(again.stdout).kitChanged, false, 'a second run changes nothing');
    const history = loadHistory(root);
    const version = readVersion(root);
    assert.equal(history[version]['system/lib/brand-new.mjs'], hashText('export const x = 1;\n'));
    assert.equal(history[version]['docs/phone.md'], undefined);
    assert.ok(history['0.1.0']['docs/phone.md'], 'older versions keep their record');
  });

  test('a new version gets its own history entry; data_version follows the migrations', () => {
    const root = releasedCopy('release-next');
    const before = loadHistory(root);
    writeFile(root, 'system/VERSION', '0.9.0\n');
    writeFile(root, 'system/migrations/index.mjs', [
      'export const MIGRATIONS = [',
      '  { id: \'0002-a\', from: 1, to: 2, title: \'a\', run() {} },',
      '  { id: \'0003-b\', from: 2, to: 3, title: \'b\', run() {} },',
      '];',
      '',
    ].join('\n'));
    const res = release(root, ['--node', '22.9.0', '--source', 'https://example.org/kit.git']);
    assert.equal(res.code, 0, res.stderr);
    const man = loadManifest(root);
    assert.equal(man.version, '0.9.0');
    assert.equal(man.data_version, 3);
    assert.equal(man.node, '22.9.0');
    assert.equal(man.source, 'https://example.org/kit.git');
    assert.equal(man.upgrade_from, '0.1.0', 'kept from the existing kit.json');
    const history = loadHistory(root);
    assert.deepEqual(Object.keys(history), [...Object.keys(before), '0.9.0']);
    for (const v of Object.keys(before)) assert.deepEqual(history[v], before[v], `${v} untouched`);
    assert.equal(release(root, ['--check']).code, 0, 'the stored metadata is kept by later runs');
  });

  test('usage errors', () => {
    const root = releasedCopy('release-usage');
    assert.equal(release(root, ['--import', 'HEAD']).code, 2);
    assert.equal(release(root, ['extra']).code, 2);
    assert.equal(release(root, ['--node', 'new']).code, 1);
    assert.equal(release(root, ['--bogus']).code, 2);
  });
});

describe('integrityReport', () => {
  test('a released copy is intact', () => {
    const root = releasedCopy('integrity-ok');
    const rep = integrityReport(root);
    assert.equal(rep.version, readVersion(root));
    assert.equal(rep.manifestVersion, rep.version);
    assert.deepEqual(rep.modified, []);
    assert.deepEqual(rep.missing, []);
    assert.deepEqual(rep.unknown, []);
    assert.deepEqual(rep.optional, { tests: true, docs: true });
    assert.ok(rep.files.length > 100 && rep.files.every((f) => f.state === 'ok'));
  });

  test('modified, missing, skipped and unknown files; CRLF copies are intact', () => {
    const root = releasedCopy('integrity');
    fs.appendFileSync(path.join(root, 'system', 'lib', 'text.mjs'), '// mine\n');
    writeFile(root, 'system/VERSION', '0.1.0\n');
    fs.rmSync(path.join(root, '.claude', 'agents', 'memory-searcher.md'));
    fs.rmSync(path.join(root, 'docs'), { recursive: true });
    writeFile(root, 'system/lib/extra.mjs', 'export {};\n');
    const util = fs.readFileSync(path.join(root, 'system', 'lib', 'util.mjs'), 'utf8');
    fs.writeFileSync(path.join(root, 'system', 'lib', 'util.mjs'), util.replace(/\n/g, '\r\n'));
    const memory = JSON.parse(readFile(root, 'memory.json'));
    writeJson(root, 'memory.json', { ...memory, eval: { golden: 'system/tests/fixtures/en/golden.json', min: 0.9 } });

    const rep = integrityReport(root);
    const state = (rel) => rep.files.find((f) => f.rel === rel);
    assert.deepEqual(rep.modified, ['system/VERSION', 'system/lib/text.mjs']);
    assert.equal(state('system/lib/text.mjs').known, false, 'never shipped');
    assert.equal(state('system/VERSION').known, true, 'the bytes of 0.1.0');
    assert.deepEqual(rep.missing, ['.claude/agents/memory-searcher.md']);
    assert.equal(state('system/lib/util.mjs').state, 'ok');
    assert.equal(state('docs/architecture.md').state, 'skipped');
    assert.equal(state('system/tests/fixtures/en/golden.json').state, 'skipped');
    assert.equal(rep.optional.docs, false);
    assert.deepEqual(rep.unknown, ['system/lib/extra.mjs']);
    assert.equal(rep.version, '0.1.0');
  });

  test('a vault without system/tests skips the tests; one without kit.json has nothing to compare', () => {
    const root = releasedCopy('integrity-tests');
    fs.rmSync(path.join(root, 'system', 'tests'), { recursive: true });
    const rep = integrityReport(root);
    assert.equal(rep.optional.tests, false);
    assert.ok(rep.files.filter((f) => f.group === 'tests').every((f) => f.state === 'skipped'));
    assert.deepEqual(rep.missing, []);
    fs.rmSync(path.join(root, KIT_FILE));
    const bare = integrityReport(root);
    assert.equal(bare.manifestVersion, null);
    assert.deepEqual(bare.files, []);
    assert.deepEqual(bare.unknown, []);
  });
});
