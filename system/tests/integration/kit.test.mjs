// End to end: a copy of the kit is set up with init, filled with the fixture vault and driven
// through the CLI only (docs/architecture.md, section 15.3, items 1 to 10, in English and Czech).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../../lib/frontmatter.mjs';
import { extractSearchBlock } from '../../lib/generate.mjs';
import {
  FIXTURES_DIR, LANGS, TODAY, checkJson, cloneDir, copyKit, describeFindings, exists, hashGenerated,
  overlay, plantSecret, readFile, removeTmpDirs, runCli, runInit, tmpDir, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

async function fts5Loads() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(x)');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_FTS5 = await fts5Loads();

// Per-language expectations that are not simply pack lookups.
const CASES = {
  en: {
    init: { dirs: ['sectors', 'journal', 'archive', 'attachments', 'inbox'], files: ['home.md', 'state.md', 'waiting.md'], absent: [] },
    calendar: { query: 'calendars', expect: 'website-redesign' },
    thesis: { query: 'thesis deadline', expect: 'thesis-project' },
    rg: { query: 'invoices', regex: '\\b(invoic)' },
    privateNote: 'dentist-appointments',
    newDecision: { type: 'decision', target: 'work/fixed-rate', name: 'fixed-rate' },
    sleepingLabel: '(sleeping)',
  },
  cs: {
    init: {
      dirs: ['sektory', 'denik', 'archiv', 'prilohy', 'inbox'],
      files: ['domu.md', 'stav.md', 'ceka.md'],
      absent: ['sectors', 'home.md', 'state.md', 'waiting.md', 'journal', 'archive', 'attachments'],
    },
    calendar: { query: 'kalendářem', expect: 'redesign-webu-pekarny' },
    thesis: { query: 'maturitni praci', expect: 'maturita-rezervacni-aplikace' },
    rg: { query: 'kalendářem', regex: '\\b(k[aá]l[eéě][nň][dď][aá][rř])' },
    privateNote: 'zubar-terminy',
    newDecision: { type: 'rozhodnuti', target: 'prace/pevna-sazba', name: 'pevna-sazba' },
    sleepingLabel: '(uspaný)',
  },
};

const QUERY_KEYS = ['query', 'terms', 'total', 'results', 'engine', 'notes'];
const RESULT_KEYS = ['rel', 'root', 'local', 'name', 'sector', 'type', 'status', 'updated', 'description',
  'snippet', 'line', 'score', 'inbox', 'archived'];

function searchJson(root, args, env) {
  const res = runCli(root, ['search', ...args, '--json'], { env });
  assert.equal(res.code, 0, `search ${args.join(' ')}: ${res.stderr}`);
  const json = JSON.parse(res.stdout);
  for (const key of QUERY_KEYS) assert.ok(Object.hasOwn(json, key), `QueryResult.${key}`);
  for (const r of json.results) for (const key of RESULT_KEYS) assert.ok(Object.hasOwn(r, key), `Result.${key}`);
  return json;
}

function assertClean(res, what) {
  assert.equal(res.code, 0, `${what}\n${describeFindings(res)}\n${res.raw?.stderr ?? ''}`);
  assert.deepEqual(res.errors, [], what);
}

for (const lang of ['en', 'cs']) {
  const n = LANGS[lang];
  const c = CASES[lang];

  describe(`kit end to end (${lang})`, () => {
    let base;
    let root;
    let priv;
    let initRes;
    let afterInit;
    let afterFixtures;

    // A fresh copy of the vault as it is after init + fixtures (a "second machine").
    const clone = () => {
      const dest = path.join(tmpDir(`e2e-${lang}`), 'copy');
      cloneDir(base, dest);
      return { root: path.join(dest, 'vault'), priv: path.join(dest, 'private') };
    };

    before(() => {
      base = tmpDir(`e2e-${lang}`);
      root = copyKit(path.join(base, 'vault'));
      priv = path.join(base, 'private');
      initRes = runInit(root, [
        '--mode', 'combined', '--lang', lang, '--sectors', 'core,work,school,health:local',
        '--private-root', '../private', '--cleanup', 'none', '--today', TODAY, '--yes',
      ]);
      afterInit = initRes.code === 0 ? checkJson(root, ['--strict', '--today', TODAY]) : null;
      overlay(path.join(FIXTURES_DIR, lang, 'vault'), root);
      overlay(path.join(FIXTURES_DIR, lang, 'private'), priv);
      afterFixtures = checkJson(root, ['--generate', '--strict', '--today', TODAY]);
    });

    test('1. init sets up the vault in the chosen language', () => {
      assert.equal(initRes.code, 0, `${initRes.stdout}\n${initRes.stderr}`);
      for (const dir of c.init.dirs) assert.ok(fs.statSync(path.join(root, dir)).isDirectory(), dir);
      for (const file of c.init.files) assert.ok(exists(root, file), file);
      for (const gone of c.init.absent) assert.ok(!exists(root, gone), `${gone} should be renamed`);
      for (const id of [n.core, n.work, n.school, n.health]) assert.ok(exists(root, `${n.sectors}/${id}/_${id}.md`), id);
      assert.ok(exists(root, `${n.sectors}/${n.health}/_${n.health}${n.exportSuffix}.md`), 'export file of the local sector');
      assert.ok(fs.statSync(path.join(priv, n.sectors, n.health)).isDirectory(), 'local sector folder in the private root');
      const cfg = JSON.parse(readFile(root, 'memory.json'));
      assert.equal(cfg.initialized, true);
      assert.equal(cfg.lang, lang);
      assert.equal(cfg.mode, 'combined');
      assert.ok(cfg.roots.some((r) => r.privacy === 'local'), 'a local root is configured');
      const agents = readFile(root, 'AGENTS.md');
      assert.ok(!agents.includes('<!-- setup:start -->') && !agents.includes('<!-- setup:end -->'), 'no setup block');
      assert.equal(`${agents.slice(agents.indexOf('<!-- kit:start'), agents.indexOf('<!-- kit:end -->'))}<!-- kit:end -->\n`,
        readFile(root, `system/templates/${lang}/kit/agents-system.md`));
    });

    test('2. check --strict passes after init and again with the fixture vault', () => {
      assert.ok(afterInit, 'init failed');
      assertClean(afterInit, 'right after init');
      assertClean(afterFixtures, 'with the fixtures');
      assert.ok(exists(root, '_ai/start.md') && exists(root, '.ignore'));
    });

    test('3. determinism: regenerating rewrites nothing; another machine gets the same bytes', () => {
      const hashes = hashGenerated(root);
      assert.ok(Object.keys(hashes).length >= 6, Object.keys(hashes).join(' '));
      const mtimes = Object.keys(hashes).map((rel) => fs.statSync(path.join(root, rel)).mtimeMs);
      assertClean(checkJson(root, ['--generate', '--strict', '--today', TODAY]), 'second run');
      assert.deepEqual(hashGenerated(root), hashes);
      assert.deepEqual(Object.keys(hashes).map((rel) => fs.statSync(path.join(root, rel)).mtimeMs), mtimes, 'no file was rewritten');

      const other = clone();
      fs.rmSync(path.join(other.root, '_ai'), { recursive: true });
      fs.rmSync(path.join(other.root, '.ignore'));
      assertClean(checkJson(other.root, ['--generate', '--strict', '--today', TODAY]), 'fresh copy');
      assert.deepEqual(hashGenerated(other.root), hashes);
    });

    test('4. budgets: start file, hook output, search block, profile', () => {
      const start = readFile(root, '_ai/start.md');
      assert.ok(Buffer.byteLength(start) <= 8500, `start.md ${Buffer.byteLength(start)} B`);
      const out = runCli(root, ['start', '--today', TODAY]);
      assert.equal(out.code, 0);
      assert.ok(Buffer.byteLength(out.stdout) <= 9500, `start output ${Buffer.byteLength(out.stdout)} B`);
      assert.equal(out.stdout, start, 'a fresh start.md is printed as committed');
      const block = extractSearchBlock(readFile(root, 'AGENTS.md'));
      assert.ok(block && start.includes(`\n${block}\n`), 'the AGENTS.md search block, byte for byte');
      const profile = readFile(root, '_ai/profile.md');
      assert.ok([...profile.slice(profile.indexOf('\n') + 1)].length <= 1500);
    });

    for (const engine of [null, 'scan']) {
      test(`5. search${engine ? ' (MEMORY_SEARCH_ENGINE=scan)' : ''}`, () => {
        const env = engine ? { MEMORY_SEARCH_ENGINE: engine } : undefined;
        const calendar = searchJson(root, [c.calendar.query], env);
        assert.ok(calendar.results.some((r) => r.name === c.calendar.expect), JSON.stringify(calendar.results.map((r) => r.name)));
        if (engine) assert.equal(calendar.engine, 'scan');
        const thesis = searchJson(root, [...c.thesis.query.split(' '), '--n', '3'], env);
        assert.ok(thesis.results.slice(0, 3).some((r) => r.name === c.thesis.expect), JSON.stringify(thesis.results.map((r) => r.name)));
        const rg = runCli(root, ['search', '--rg', c.rg.query], { env });
        assert.equal(rg.code, 0, rg.stderr);
        assert.equal(rg.stdout, `${c.rg.regex}\n`);
        const human = runCli(root, ['search', c.calendar.query], { env });
        assert.match(human.stdout.split('\n')[0], /^1 \S+\.md · \S+ · \S+ · (\d{4}-\d{2}-\d{2}|–) · /);
      });
    }

    test('5b. localized command and flag aliases', { skip: lang !== 'cs' && 'Czech only' }, () => {
      const res = runCli(root, ['hledej', 'harmonogram', 'zkoušek', '--typ', 'fakt', '--json']);
      assert.equal(res.code, 0, res.stderr);
      assert.equal(JSON.parse(res.stdout).results[0].name, 'harmonogram-zkousek');
      assert.equal(runCli(root, ['kontrola', '--prisne', '--dnes', TODAY]).code, 0);
    });

    test('6. secrets block commits in strict and lenient mode and are never printed', () => {
      const v = clone();
      const secret = plantSecret();
      writeFile(v.root, `${n.sectors}/${n.work}/api-notes.md`, [
        '---', `${lang === 'cs' ? 'typ: fakt' : 'type: fact'}`, `${lang === 'cs' ? 'stav: aktivni' : 'status: active'}`,
        `${n.keys.description}: API notes.`, `${lang === 'cs' ? 'aktualizace' : 'updated'}: 2026-09-19`,
        `${lang === 'cs' ? 'plati_do' : 'valid_until'}: 2027-01-01`, '---', '# API', '',
        `aws ${secret.aws}`, `github ${secret.github}`, '',
      ].join('\n'));
      for (const mode of ['--strict', '--lenient']) {
        const res = runCli(v.root, ['check', mode, '--today', TODAY]);
        assert.equal(res.code, 1, `${mode}\n${res.stdout}`);
        assert.match(res.stdout, /^ERROR SECRET /m);
        for (const s of secret.all) assert.ok(!res.stdout.includes(s) && !res.stderr.includes(s), 'full key printed');
        const json = checkJson(v.root, [mode, '--today', TODAY]);
        assert.ok(json.errors.some((f) => f.code === 'SECRET'));
        for (const s of secret.all) assert.ok(!json.raw.stdout.includes(s));
      }
    });

    test('7. privacy: links into a local sector and local content in git', () => {
      const linked = clone();
      const pricing = lang === 'en' ? 'pricing' : 'rozsah-balicku';
      const rel = `${n.sectors}/${n.work}/${pricing}.md`;
      writeFile(linked.root, rel, `${readFile(linked.root, rel)}- [[${c.privateNote}]]\n`);
      for (const mode of ['--strict', '--lenient']) {
        const res = checkJson(linked.root, [mode, '--today', TODAY]);
        assert.equal(res.code, 1, mode);
        assert.ok(res.errors.some((f) => f.code === 'PRIVACY_LINK' && f.rel === rel), describeFindings(res));
      }

      const copied = clone();
      const src = path.join(copied.priv, n.sectors, n.health, `${c.privateNote}.md`);
      fs.copyFileSync(src, path.join(copied.root, n.sectors, n.health, 'leaked-copy.md'));
      const res = checkJson(copied.root, ['--lenient', '--today', TODAY]);
      assert.equal(res.code, 1);
      assert.ok(res.errors.some((f) => f.code === 'LOCAL_IN_GIT'), describeFindings(res));
    });

    test('8. sector lifecycle and a new decision', () => {
      const v = clone();
      const ignoreLine = `${n.sectors}/${n.school}/`;
      const schoolRow = () => readFile(v.root, '_ai/start.md').split('\n').find((l) => l.startsWith(`| ${n.school} |`));

      const sleep = runCli(v.root, ['sector', 'sleep', n.school, '--today', TODAY]);
      assert.equal(sleep.code, 0, sleep.stdout + sleep.stderr);
      assert.ok(readFile(v.root, '.ignore').split('\n').includes(ignoreLine));
      assert.ok(schoolRow().includes(c.sleepingLabel), schoolRow());
      assertClean(checkJson(v.root, ['--strict', '--today', TODAY]), 'after sleep');

      const wake = runCli(v.root, ['sector', 'wake', n.school, '--today', TODAY]);
      assert.equal(wake.code, 0, wake.stdout + wake.stderr);
      assert.ok(!readFile(v.root, '.ignore').split('\n').includes(ignoreLine));
      assert.ok(!schoolRow().includes(c.sleepingLabel), schoolRow());

      const off = runCli(v.root, ['sector', 'off', n.hobbies, '--today', TODAY]);
      assert.equal(off.code, 0, off.stdout + off.stderr);
      assert.ok(exists(v.root, `${n.archive}/${n.sectors}/${n.hobbies}/_${n.hobbies}.md`), 'moved into the archive');
      assert.ok(!exists(v.root, `_ai/index-${n.hobbies}.md`), 'its index is gone');
      assertClean(checkJson(v.root, ['--strict', '--today', TODAY]), 'after off');
      assert.equal(runCli(v.root, ['sector', 'wake', n.hobbies, '--today', TODAY]).code, 0);
      assert.ok(exists(v.root, `${n.sectors}/${n.hobbies}/_${n.hobbies}.md`), 'back from the archive');

      const created = runCli(v.root, ['new', c.newDecision.type, c.newDecision.target, '--today', TODAY]);
      assert.equal(created.code, 0, created.stdout + created.stderr);
      const rel = `${n.sectors}/${n.work}/${n.decisions}/${TODAY}-${c.newDecision.name}.md`;
      assert.ok(created.stdout.includes(rel), created.stdout);
      const text = readFile(v.root, rel);
      const fm = parse(text).data;
      const keys = lang === 'cs'
        ? { type: 'typ', status: 'stav', description: 'popis', updated: 'aktualizace', created: 'datum' }
        : { type: 'type', status: 'status', description: 'description', updated: 'updated', created: 'created' };
      for (const key of Object.values(keys)) assert.ok(Object.hasOwn(fm, key), `${rel}: ${key}`);
      assert.equal(fm[keys.type], n.types.decision);
      assert.equal(String(fm[keys.created]), TODAY);

      const empty = checkJson(v.root, ['--strict', '--today', TODAY]);
      assert.ok(empty.errors.some((f) => f.code === 'FM_REQUIRED' && f.rel === rel), 'the empty description blocks a commit');
      const filled = text.replace(new RegExp(`^${keys.description}:.*$`, 'm'), `${keys.description}: A fixed rate for small maintenance jobs.`);
      writeFile(v.root, rel, filled);
      assertClean(checkJson(v.root, ['--generate', '--strict', '--today', TODAY]), 'after filling the description');
    });

    test('9. a hand-edited generated file is detected', () => {
      const v = clone();
      fs.appendFileSync(path.join(v.root, '_ai', 'catalog.tsv'), 'hand\tedited\n');
      const res = checkJson(v.root, ['--lenient', '--today', TODAY]);
      assert.equal(res.code, 1);
      assert.ok(res.errors.some((f) => f.code === 'GEN_EDITED' && f.rel === '_ai/catalog.tsv'), describeFindings(res));
    });

    for (const [engine, min] of [['fts5', 0.9], ['scan', 0.8]]) {
      test(`10. eval with ${engine}: hit@3 >= ${min}`, { skip: engine === 'fts5' && !HAS_FTS5 && 'node:sqlite with FTS5 is not available' }, () => {
        const res = runCli(root, ['eval', '--file', `system/tests/fixtures/${lang}/golden.json`, '--engine', engine, '--min', String(min), '--json']);
        assert.equal(res.code, 0, res.stdout + res.stderr);
        const json = JSON.parse(res.stdout);
        assert.ok(json.hit3 >= min, `hit@3 ${json.hit3}: ${JSON.stringify(json.misses)}`);
        assert.ok(json.total >= 16);
      });
    }

    test('session narrowing with MEMORY_SECTORS', () => {
      const res = runCli(root, ['start', '--today', TODAY], { env: { MEMORY_SECTORS: n.school } });
      assert.equal(res.code, 0);
      const ids = [n.core, n.work, n.school, n.hobbies, n.health];
      const shown = ids.filter((id) => res.stdout.split('\n').some((l) => l.startsWith(`| ${id} |`)));
      assert.deepEqual(shown, [n.school]);
    });

    test('usage errors exit 2', () => {
      assert.equal(runCli(root, ['no-such-command']).code, 2);
      assert.equal(runCli(root, ['check', '--no-such-flag']).code, 2);
      assert.equal(runCli(root, ['search']).code, 2);
    });
  });
}
