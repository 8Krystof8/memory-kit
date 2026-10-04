// Private content left in a local sector's main-root folder (a note written into sectors/health/
// of the main root while health is a local sector). Git ignores it and check reports it as
// LOCAL_IN_GIT until the owner moves it into the local root. Until then it never reaches a
// committed file (_ai/, .ignore, the home page, the search log), a search result or the start
// view; search only counts it as a local hit.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../lib/config.mjs';
import { buildContext, resolveAsOfInfo } from '../../lib/generate.mjs';
import { inLocalSectorFolder, loadVault, localFolderNotes, sectorIsLocal } from '../../lib/vault.mjs';
import {
  TODAY, checkJson, describeFindings, fixtureVault, hashGenerated, readFile, removeTmpDirs, runCli, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

const DIAGNOSIS = [
  '---', 'type: fact', 'status: active', 'updated: 2026-09-18',
  'description: Diagnosed with chronic migraine in March, takes sumatriptan.', '---', '# Diagnosis', '',
  '- [fact] 2026-03-02: Neurologist confirmed chronic migraine; prescribed sumatriptan 50 mg.', '',
].join('\n');
const OLD_DOSE = [
  '---', 'type: fact', 'status: done', 'updated: 2026-01-10', 'description: Old insulin dose.', '---', '# Old dose', '',
  'insulin 10 units', '',
].join('\n');
const PLANTED = ['sectors/health/diagnosis.md', 'archive/sectors/health/old-dose.md'];
// Words that only the planted notes hold.
const PRIVATE = ['igraine', 'sumatriptan', 'nsulin', 'diagnosis', 'old-dose', 'Old dose'];

function editJson(root, rel, fn) {
  const value = JSON.parse(readFile(root, rel));
  fn(value);
  writeFile(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

/** The en fixture vault with the search log on, optionally with the two stray private notes. */
function vault({ plant = true } = {}) {
  const v = fixtureVault('en');
  editJson(v.root, 'memory.json', (j) => {
    j.search = { log: true, n: 5 };
  });
  if (plant) {
    writeFile(v.root, PLANTED[0], DIAGNOSIS);
    writeFile(v.root, PLANTED[1], OLD_DOSE);
  }
  return v;
}

function assertPrivateAbsent(text, what) {
  for (const word of PRIVATE) assert.ok(!text.includes(word), `${what} holds "${word}":\n${text}`);
}

/** A generated file without its header line and without the LOCAL_IN_GIT alert lines. */
function comparable(text) {
  const body = text.slice(text.indexOf('\n') + 1);
  return body.split('\n\n')
    .map((block) => block.split('\n').filter((l) => !l.startsWith('- LOCAL_IN_GIT ')).join('\n'))
    .filter((block) => !/^## [^\n]*$/.test(block))
    .join('\n\n');
}

function jsonOf(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
}

describe('private content left in a local sector\'s main-root folder', () => {
  test('check --generate keeps it out of _ai/, .ignore and the home page, and reports it', () => {
    const clean = vault({ plant: false });
    const before = checkJson(clean.root, ['--generate', '--today', TODAY]);
    assert.deepEqual(before.errors, [], describeFindings(before));

    const v = vault();
    const res = checkJson(v.root, ['--generate', '--today', TODAY]);
    assert.equal(res.code, 1, describeFindings(res));
    assert.deepEqual(res.errors.map((f) => `${f.code} ${f.rel}`), PLANTED.map((rel) => `LOCAL_IN_GIT ${rel}`).sort());

    const files = Object.keys(hashGenerated(v.root));
    assert.deepEqual(files, Object.keys(hashGenerated(clean.root)));
    assert.ok(files.includes('_ai/start.md') && files.includes('_ai/catalog.tsv') && files.includes('home.md'), files.join(', '));
    for (const rel of files) {
      const text = readFile(v.root, rel);
      assertPrivateAbsent(text.split('\n').filter((l) => !l.startsWith('- LOCAL_IN_GIT ')).join('\n'), rel);
      // The same views as without the stray notes (the header's source hash covers them; the
      // alerts of start.md name their paths only).
      assert.equal(comparable(text), comparable(readFile(clean.root, rel)), rel);
    }
    const start = readFile(v.root, '_ai/start.md');
    for (const rel of PLANTED) assert.ok(start.includes(`- LOCAL_IN_GIT ${rel} `), start);
  });

  test('the as-of date, the counts and the hot list of the views ignore it', async () => {
    const v = vault({ plant: false });
    const cfg = loadConfig(v.root);
    const clean = loadVault(cfg);
    const asOf = resolveAsOfInfo(cfg, clean);
    const ctx = await buildContext(cfg, clean, { today: TODAY });
    // Two stray notes that confirm each other would move the vault's time and top the hot list.
    writeFile(v.root, 'sectors/health/later-a.md', DIAGNOSIS.replace('2026-09-18', '2027-03-01'));
    writeFile(v.root, 'sectors/health/later-b.md', DIAGNOSIS.replace('2026-09-18', '2027-03-02'));
    const planted = loadVault(cfg);
    assert.deepEqual(localFolderNotes(cfg, planted).map((n) => n.rel), ['sectors/health/later-a.md', 'sectors/health/later-b.md']);
    for (const n of localFolderNotes(cfg, planted)) assert.equal(n.local, true, n.rel);
    assert.deepEqual(resolveAsOfInfo(cfg, planted), asOf);
    const after = await buildContext(cfg, planted, { today: TODAY });
    assert.deepEqual(after.counts, ctx.counts);
    assert.deepEqual(after.hotList.map((n) => n.rel), ctx.hotList.map((n) => n.rel));
  });

  test('CLI search only counts it, --local leaves it out, and the search log never names it', () => {
    const v = vault();
    const plain = jsonOf(runCli(v.root, ['search', 'migraine sumatriptan', '--json', '--today', TODAY]));
    assert.deepEqual(plain.results, []);
    assert.equal(plain.localHits, 1);
    const archived = jsonOf(runCli(v.root, ['search', 'insulin', '--all', '--json', '--today', TODAY]));
    assert.deepEqual(archived.results, []);
    assert.equal(archived.localHits, 1);
    for (const args of [['migraine', '--local', '--all'], ['insulin', '--local', '--all']]) {
      const shown = jsonOf(runCli(v.root, ['search', ...args, '--json', '--today', TODAY]));
      assert.ok(!shown.results.some((r) => /diagnosis|old-dose/.test(r.rel)), JSON.stringify(shown.results));
    }
    const human = runCli(v.root, ['search', 'migraine', '--local', '--all', '--today', TODAY]);
    assert.equal(human.code, 0, human.stderr);
    assertPrivateAbsent(human.stdout.replace(/migraine/g, ''), 'search output');
    const dups = runCli(v.root, ['search', '--duplicates', 'Chronic migraine diagnosis', 'takes sumatriptan', '--local']);
    assert.equal(dups.code, 0, dups.stderr);
    assert.ok(!/diagnosis\.md|old-dose/.test(dups.stdout), dups.stdout);

    const log = readFile(v.root, 'system/usage/search.log').split('\n').filter(Boolean);
    assert.equal(log.length, 5, log.join('\n'));
    for (const line of log) assert.ok(!/diagnosis|old-dose/.test(line.split('\t')[3] ?? ''), line);
  });

  test('the start view leaves it out and its alert names the path only', () => {
    const v = vault();
    const res = runCli(v.root, ['start', '--today', TODAY]);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.includes('- LOCAL_IN_GIT sectors/health/diagnosis.md '), res.stdout);
    assertPrivateAbsent(res.stdout.split('\n').filter((l) => !l.startsWith('- LOCAL_IN_GIT ')).join('\n'), 'start');
  });

  test('which folders count: a local manifest; a github manifest wins over a local folder; no manifest, a local root decides', () => {
    const v = vault({ plant: false });
    // garden: a github sector whose id a folder of the local root also holds.
    writeFile(v.root, 'sectors/garden/_garden.md', readFile(v.root, 'sectors/hobbies/_hobbies.md')
      .replace('state: sleep', 'state: on').replace('# Hobbies', '# Garden'));
    writeFile(v.root, 'sectors/garden/tomato-beds.md', '---\ntype: fact\nstatus: active\nupdated: 2026-09-10\ndescription: Tomato beds by the fence.\n---\n# Tomato beds\n');
    fs.mkdirSync(path.join(v.priv, 'sectors', 'garden'), { recursive: true });
    // diary: no manifest in the main root, its folder is in the local root; an archived copy strayed.
    writeFile(v.root, 'archive/sectors/diary/entry.md', '---\ntype: fact\nstatus: active\nupdated: 2026-09-10\ndescription: A private diary entry.\n---\n# Entry\n');
    fs.mkdirSync(path.join(v.priv, 'sectors', 'diary'), { recursive: true });

    const cfg = loadConfig(v.root);
    assert.equal(sectorIsLocal(cfg, 'health'), true);
    assert.equal(sectorIsLocal(cfg, 'garden'), false);
    assert.equal(sectorIsLocal(cfg, 'diary'), true);
    assert.equal(sectorIsLocal(cfg, 'work'), false);
    assert.equal(inLocalSectorFolder(cfg, 'sectors/health/x.md'), true);
    assert.equal(inLocalSectorFolder(cfg, 'sectors/health/_health.md'), false);
    assert.equal(inLocalSectorFolder(cfg, 'sectors/health/_health-export.md'), false);
    assert.equal(inLocalSectorFolder(cfg, 'sectors/garden/tomato-beds.md'), false);
    assert.equal(inLocalSectorFolder(cfg, 'archive/sectors/diary/entry.md'), true);
    assert.deepEqual(localFolderNotes(cfg, loadVault(cfg)).map((n) => n.rel), ['archive/sectors/diary/entry.md']);

    const res = checkJson(v.root, ['--generate', '--today', TODAY]);
    const local = res.errors.filter((f) => f.code === 'LOCAL_IN_GIT').map((f) => f.rel);
    assert.deepEqual(local, ['archive/sectors/diary/entry.md'], describeFindings(res));
    const catalog = readFile(v.root, '_ai/catalog.tsv');
    assert.ok(catalog.includes('sectors/garden/tomato-beds.md\t'), catalog);
    assert.ok(!catalog.includes('diary'), catalog);
  });
});
