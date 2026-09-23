// search.mjs on the fixture vaults: engines, scope, filters, snippets, duplicates and output
// (docs/architecture.md, sections 7.7, 10.2 and 13).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildIndex, duplicates, formatDuplicates, formatResults, query, rgRegex,
} from '../../lib/search.mjs';
import { fixtureVault, loadFixture, readFile, removeTmpDirs } from '../helpers.mjs';

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
const ENGINES = HAS_FTS5 ? ['fts5', 'scan'] : ['scan'];

const RESULT_KEYS = ['rel', 'root', 'local', 'name', 'sector', 'type', 'status', 'updated', 'description',
  'snippet', 'line', 'score', 'inbox', 'archived'];

function assertQueryResult(res) {
  for (const key of ['query', 'terms', 'total', 'results', 'engine', 'notes']) assert.ok(Object.hasOwn(res, key), key);
  assert.ok(Array.isArray(res.terms));
  for (const r of res.results) {
    for (const key of RESULT_KEYS) assert.ok(Object.hasOwn(r, key), `result.${key}`);
    assert.equal(r.score, Math.round(r.score * 10000) / 10000, 'score has at most 4 decimals');
  }
  for (let i = 1; i < res.results.length; i++) {
    const [a, b] = [res.results[i - 1], res.results[i]];
    assert.ok(a.score > b.score || (a.score === b.score && a.rel < b.rel), `order at ${i}`);
  }
}

const names = (res) => res.results.map((r) => r.name);

for (const engine of ENGINES) {
  describe(`engine ${engine} (en fixtures)`, () => {
    let fx;
    let cfg;
    let index;
    before(async () => {
      fx = fixtureVault('en');
      ({ cfg } = await loadFixture(fx.root));
      const { vault } = await loadFixture(fx.root);
      index = await buildIndex(vault, cfg, { engine });
    });
    after(() => index?.close());

    test('index shape', () => {
      assert.equal(index.engine, engine);
      assert.equal(index.size, index.notes.length);
      assert.equal(typeof index.close, 'function');
      assert.ok(index.size >= 40);
    });

    test('finds the obvious note first and returns the QueryResult shape', () => {
      const res = query(index, 'invoice numbering');
      assertQueryResult(res);
      assert.equal(res.results[0].name, 'invoice-numbering');
      assert.equal(res.engine, engine);
      assert.equal(res.query, 'invoice numbering');
    });

    test('deterministic: the same query twice gives the same result', () => {
      assert.deepEqual(query(index, 'bakery calendar'), query(index, 'bakery calendar'));
    });

    test('default scope hides replaced notes, inbox, archive and sleeping sectors', () => {
      const billing = query(index, 'hourly billing', { n: 20 });
      assert.ok(!names(billing).includes('2026-03-10-hourly-billing'), 'replaced is hidden');
      const any = query(index, 'hourly billing', { n: 20, status: 'any' });
      assert.ok(names(any).includes('2026-03-10-hourly-billing'));
      const rejected = query(index, 'installments', { n: 20 });
      assert.ok(names(rejected).includes('2026-05-12-payment-in-installments'), 'only replaced is hidden by default');

      const climbing = query(index, 'climbing route', { n: 20 });
      assert.ok(!names(climbing).includes('climbing-log'), 'sleeping sector');
      const logo = query(index, 'logo brief', { n: 20 });
      assert.ok(!names(logo).includes('old-logo-brief'), 'archive');
      const loyalty = query(index, 'loyalty card', { n: 20 });
      assert.ok(!loyalty.results.some((r) => r.inbox), 'inbox');
    });

    test('--all searches everything and marks inbox and archive hits', () => {
      const loyalty = query(index, 'loyalty card', { all: true });
      const hit = loyalty.results.find((r) => r.inbox);
      assert.ok(hit, 'inbox item found with all');
      assert.equal(hit.rel, 'inbox/2026-09-17-loyalty-card-idea.md');
      const logo = query(index, 'logo brief', { all: true });
      const archived = logo.results.find((r) => r.name === 'old-logo-brief');
      assert.ok(archived && archived.archived === true);
    });

    test('--sector searches that sector in any state', () => {
      const res = query(index, 'climbing route', { sector: 'hobbies' });
      assert.equal(res.results[0].name, 'climbing-log');
      assert.ok(res.results.every((r) => r.sector === 'hobbies'));
    });

    test('local root notes are only counted by default; --local shows them with their real path', () => {
      const hidden = query(index, 'dentist appointments');
      assert.ok(!hidden.results.some((r) => r.local), 'no local note without local');
      assert.equal(hidden.localHits, 1);
      const res = query(index, 'dentist appointments', { local: true });
      const hit = res.results.find((r) => r.name === 'dentist-appointments');
      assert.ok(hit, 'local note with local');
      assert.equal(hit.local, true);
      assert.equal(hit.root, 'private');
      assert.equal(hit.path, '../private/sectors/health/dentist-appointments.md');
      assert.equal(res.localHits, 0);
    });

    test('type and status filters use canonical values', () => {
      const decisions = query(index, 'packages billing weekends topic', { type: 'decision', n: 20 });
      assert.ok(decisions.results.length >= 2);
      assert.ok(decisions.results.every((r) => r.type === 'decision'));
      const waiting = query(index, 'maintenance plan', { status: 'waiting' });
      assert.deepEqual(names(waiting), ['proposal-maintenance-plan']);
    });

    test('n limits the results but not the total', () => {
      const res = query(index, 'bakery', { n: 2 });
      assert.equal(res.results.length, 2);
      assert.ok(res.total >= res.results.length);
    });

    test('snippet line numbers are file line numbers', () => {
      const res = query(index, 'renews hosting contract');
      const hit = res.results.find((r) => r.name === 'hosting-provider');
      assert.ok(hit.line > 0);
      const line = readFile(fx.root, hit.rel).split('\n')[hit.line - 1];
      assert.ok(line.includes(hit.snippet.replace(/…/g, '').trim()), `${line} / ${hit.snippet}`);
    });

    test('no results is not an error', () => {
      const res = query(index, 'xylophone quasar');
      assert.equal(res.total, 0);
      assert.deepEqual(res.results, []);
      assert.match(formatResults(res, cfg), /^\(0 results · terms: /);
    });

    test('duplicates: an existing decision is a likely duplicate, an unrelated title is not', () => {
      const dup = duplicates(index, {
        title: 'Fixed-price packages',
        description: 'New offers use fixed-price packages instead of hourly billing',
        type: 'decision',
      });
      assert.equal(dup.verdict, 'duplicate');
      assert.equal(dup.best, 'sectors/work/decisions/2026-06-02-fixed-price-packages.md');
      assert.ok(dup.candidates[0].shared.length >= 2);
      assert.match(formatDuplicates(dup, cfg), /LIKELY DUPLICATE: extend sectors\/work\/decisions\/2026-06-02-fixed-price-packages\.md/);

      const none = duplicates(index, { title: 'Sailing trip', description: 'Mooring in the bay', type: 'decision' });
      assert.equal(none.verdict, 'none');
      assert.equal(none.best, null);
      assert.match(formatDuplicates(none, cfg), /No duplicate found\./);
    });

    test('human output: one line per result, snippet line, footer', () => {
      const res = query(index, 'onboarding checklist', { n: 2 });
      const text = formatResults(res, cfg, { secs: 0.04 });
      const lines = text.split('\n');
      assert.match(lines[0], /^1 sectors\/work\/onboarding-checklist\.md · procedure · active · 2026-06-20 · Steps to onboard/);
      assert.match(lines[1], /^ {2}L\d+: /);
      assert.match(lines[lines.length - 1], new RegExp(`^\\(${res.total} results · terms: .* · ${res.notes} notes · ${engine} · 0\\.04 s\\)$`));
    });
  });

  describe(`engine ${engine} (cs fixtures)`, () => {
    let cfg;
    let index;
    before(async () => {
      const fx = fixtureVault('cs');
      const loaded = await loadFixture(fx.root);
      cfg = loaded.cfg;
      index = await buildIndex(loaded.vault, cfg, { engine });
    });
    after(() => index?.close());

    test('"kalendářem" finds the note whose body says "kalendáře"', () => {
      const res = query(index, 'kalendářem');
      assert.ok(names(res).includes('redesign-webu-pekarny'), names(res).join(', '));
    });

    test('a note with every word of the question beats one with a short prefix in its name', () => {
      const res = query(index, 'termín odevzdání práce', { n: 3 });
      assert.equal(names(res)[0], 'maturita-rezervacni-aplikace', names(res).join(', '));
      const two = query(index, 'odevzdání práce', { n: 1 });
      assert.equal(names(two)[0], 'maturita-rezervacni-aplikace', names(two).join(', '));
    });

    test('query blocks (```base, ```dataview) are neither matched nor used as snippets', async () => {
      const fx = fixtureVault('cs');
      const rel = path.join(fx.root, 'sektory', 'prace', '_prace.md');
      fs.appendFileSync(rel, '\n## Tabulka\n```base\nviews:\n  - type: table\n    filters: file.inFolder("sektory/prace")\n```\n');
      const loaded = await loadFixture(fx.root);
      const own = await buildIndex(loaded.vault, loaded.cfg, { engine });
      try {
        assert.equal(query(own, 'inFolder', { all: true }).total, 0);
        const res = query(own, 'práce', { n: 20 });
        assert.ok(res.results.every((r) => !/inFolder|type: table/.test(r.snippet)), res.results.map((r) => r.snippet).join(' | '));
      } finally {
        own.close();
      }
    });

    test('"maturitni praci" without diacritics finds the thesis note in the top 3', () => {
      const res = query(index, 'maturitni praci', { n: 3 });
      assert.ok(names(res).includes('maturita-rezervacni-aplikace'), names(res).join(', '));
    });

    test('inflected forms find each other', () => {
      assert.ok(names(query(index, 'klientem')).length > 0);
      assert.equal(query(index, 'číslování faktur').results[0].name, 'cislovani-faktur');
      assert.equal(query(index, 'cislovani faktury').results[0].name, 'cislovani-faktur');
    });

    test('Czech labels in the human output', () => {
      const res = query(index, 'harmonogram zkoušek', { n: 1 });
      const text = formatResults(res, cfg, { secs: 0.1 });
      assert.match(text, /^1 sektory\/skola\/harmonogram-zkousek\.md · fakt · aktivni · /);
      assert.match(text, /\n {2}ř\.\d+: /);
      assert.match(text, /výsledků/);
    });

    test('display terms end with *', () => {
      const res = query(index, 'kalendářem pekárně');
      assert.ok(res.terms.length === 2 && res.terms.every((t) => t.endsWith('*')), res.terms.join(' '));
    });
  });
}

describe('rgRegex and engine choice', () => {
  test('rgRegex wrapper (cs)', async () => {
    const fx = fixtureVault('cs');
    const { cfg } = await loadFixture(fx.root);
    assert.equal(await rgRegex('kalendářem', cfg), '\\b(k[aá]l[eéě][nň][dď][aá][rř])');
  });

  test('MEMORY_SEARCH_ENGINE=scan forces the scan engine', async () => {
    const fx = fixtureVault('en');
    const { cfg, vault } = await loadFixture(fx.root);
    const saved = process.env.MEMORY_SEARCH_ENGINE;
    process.env.MEMORY_SEARCH_ENGINE = 'scan';
    try {
      const index = await buildIndex(vault, cfg);
      assert.equal(index.engine, 'scan');
      index.close();
    } finally {
      if (saved === undefined) delete process.env.MEMORY_SEARCH_ENGINE;
      else process.env.MEMORY_SEARCH_ENGINE = saved;
    }
  });

  test('both engines agree on the top result for the golden questions', { skip: !HAS_FTS5 && 'node:sqlite with FTS5 is not available' }, async () => {
    for (const lang of ['en', 'cs']) {
      const fx = fixtureVault(lang);
      const { cfg, vault } = await loadFixture(fx.root);
      const fts = await buildIndex(vault, cfg, { engine: 'fts5' });
      const scan = await buildIndex(vault, cfg, { engine: 'scan' });
      const golden = JSON.parse(fs.readFileSync(path.join(fx.root, 'system', 'tests', 'fixtures', lang, 'golden.json'), 'utf8'));
      let same = 0;
      for (const q of golden.questions) {
        const opts = { all: true, status: 'any', n: 3 };
        if (names(query(fts, q.q, opts))[0] === names(query(scan, q.q, opts))[0]) same++;
      }
      fts.close();
      scan.close();
      assert.ok(same / golden.questions.length >= 0.8, `${lang}: ${same}/${golden.questions.length} top results agree`);
    }
  });
});
