// eval.mjs and the eval command: golden-file format, scoring and hit@3 on the fixtures
// (docs/architecture.md, sections 7.11, 10.5 and 15.1).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EvalError, runEval, score, validateGolden } from '../../lib/eval.mjs';
import { KIT_ROOT, fixtureVault, loadFixture, removeTmpDirs, runCli, writeJson } from '../helpers.mjs';

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

const q = (id, category, expect, extra = {}) => ({ id, q: `question ${id}`, expect, category, sector: null, ...extra });
const golden = (questions) => ({ version: 1, questions });

describe('golden file format', () => {
  test('a valid file is normalized: names lowercased, .md and folders dropped', () => {
    const out = validateGolden(golden([q('a1', 'extraction', ['sectors/work/Pricing.md', 'other'])]));
    assert.deepEqual(out[0].expect, ['pricing', 'other']);
    assert.equal(out[0].sector, null);
  });

  const bad = [
    ['not an object', []],
    ['wrong version', { version: 2, questions: [] }],
    ['questions missing', { version: 1 }],
    ['unknown category', golden([q('a1', 'trivia', ['x'])])],
    ['duplicate id', golden([q('a1', 'extraction', ['x']), q('a1', 'temporal', ['y'])])],
    ['missing id', golden([{ q: 'x', expect: ['x'], category: 'extraction' }])],
    ['empty question', golden([{ ...q('a1', 'extraction', ['x']), q: '  ' }])],
    ['absent with expectations', golden([q('a1', 'absent', ['x'])])],
    ['answerable without expectations', golden([q('a1', 'temporal', [])])],
    ['expect not a list', golden([{ ...q('a1', 'extraction', []), expect: 'x' }])],
    ['bad sector', golden([q('a1', 'extraction', ['x'], { sector: 5 })])],
  ];
  for (const [name, data] of bad) {
    test(`rejects: ${name}`, () => {
      assert.throws(() => validateGolden(data, 'golden.json'), EvalError);
    });
  }

  test('the owner golden file of the kit is valid', () => {
    const data = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'system', 'tests', 'golden.json'), 'utf8'));
    assert.equal(data.version, 1);
    assert.doesNotThrow(() => validateGolden(data));
  });

  for (const lang of ['en', 'cs']) {
    test(`fixture golden file (${lang}): at least 20 questions, 3 per category`, () => {
      const data = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'system', 'tests', 'fixtures', lang, 'golden.json'), 'utf8'));
      const questions = validateGolden(data);
      assert.ok(questions.length >= 20);
      for (const cat of ['extraction', 'multi-session', 'temporal', 'knowledge-update', 'absent']) {
        assert.ok(questions.filter((x) => x.category === cat).length >= 3, cat);
      }
    });
  }

  test('several Czech questions are typed without diacritics', () => {
    const data = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'system', 'tests', 'fixtures', 'cs', 'golden.json'), 'utf8'));
    const ascii = data.questions.filter((x) => x.category !== 'absent' && /^[\x20-\x7e]+$/.test(x.q));
    assert.ok(ascii.length >= 3, `${ascii.length} ASCII-only questions`);
  });
});

describe('score()', () => {
  const answered = (id, category, hit, top, got = []) => ({ ...q(id, category, category === 'absent' ? [] : ['x']), hit, top, got });

  test('hit@3 over answerable questions, per category, rounded to 4 decimals', () => {
    const res = score([
      answered('a', 'extraction', true, 10),
      answered('b', 'extraction', false, 8, ['p', 'q']),
      answered('c', 'temporal', true, 6),
    ]);
    assert.equal(res.total, 3);
    assert.equal(res.hits, 2);
    assert.equal(res.hit3, 0.6667);
    assert.deepEqual(res.byCategory, {
      extraction: { n: 2, hits: 1, hit3: 0.5 },
      temporal: { n: 1, hits: 1, hit3: 1 },
    });
    assert.deepEqual(res.misses, [{ id: 'b', q: 'question b', expect: ['x'], got: ['p', 'q'] }]);
    assert.deepEqual(res.absent, { n: 0, ok: 0 });
  });

  test('absent: ok without results or below the median top score of the others', () => {
    const res = score([
      answered('a', 'extraction', true, 10),
      answered('b', 'extraction', true, 20),
      answered('c', 'temporal', true, 30),
      answered('d', 'temporal', true, 40),
      answered('e', 'absent', false, null),
      answered('f', 'absent', false, 24.9, ['near']),
      answered('g', 'absent', false, 25, ['tie']),
      answered('h', 'absent', false, 90, ['strong']),
    ]);
    assert.equal(res.threshold, 25, 'median of 10, 20, 30, 40');
    assert.deepEqual(res.absent, { n: 4, ok: 2 });
    assert.equal(res.total, 4, 'absent questions do not count toward hit@3');
    assert.equal(res.hit3, 1);
    assert.deepEqual(res.misses.map((m) => m.id), ['g', 'h']);
    assert.deepEqual(res.misses[1].expect, []);
  });

  test('only absent questions: no yardstick, only "no results" is ok', () => {
    const res = score([answered('e', 'absent', false, null), answered('f', 'absent', false, 3)]);
    assert.deepEqual(res.absent, { n: 2, ok: 1 });
    assert.equal(res.total, 0);
  });
});

describe('runEval on the fixture vaults', () => {
  for (const lang of ['en', 'cs']) {
    for (const engine of HAS_FTS5 ? ['fts5', 'scan'] : ['scan']) {
      test(`${lang} with ${engine}: hit@3 >= ${engine === 'fts5' ? '0.9' : '0.8'}`, async () => {
        const fx = fixtureVault(lang);
        const { cfg } = await loadFixture(fx.root);
        const res = await runEval(cfg, `system/tests/fixtures/${lang}/golden.json`, { engine });
        const min = engine === 'fts5' ? 0.9 : 0.8;
        assert.ok(res.hit3 >= min, `hit@3 ${res.hit3}; misses: ${JSON.stringify(res.misses, null, 1)}`);
        assert.equal(res.engine, engine);
        assert.deepEqual(Object.keys(res.byCategory), ['extraction', 'multi-session', 'temporal', 'knowledge-update']);
        assert.ok(res.absent.n >= 3);
        assert.equal(res.absent.ok, res.absent.n, JSON.stringify(res.details.filter((d) => d.category === 'absent')));
        for (const m of res.misses) assert.ok(m.got.length <= 3);
      });
    }
  }

  test('names, not paths: moving a note into the archive keeps its question answered', async () => {
    const fx = fixtureVault('en');
    const from = path.join(fx.root, 'sectors', 'work', 'invoice-numbering.md');
    const to = path.join(fx.root, 'archive', 'sectors', 'work', 'invoice-numbering.md');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    writeJson(fx.root, 'one.json', golden([{ id: 'x1', q: 'invoice number format', expect: ['invoice-numbering'], category: 'extraction' }]));
    const { cfg } = await loadFixture(fx.root);
    const res = await runEval(cfg, 'one.json');
    assert.equal(res.hit3, 1);
  });

  test('an empty golden file', async () => {
    const fx = fixtureVault('en');
    writeJson(fx.root, 'empty.json', golden([]));
    const { cfg } = await loadFixture(fx.root);
    const res = await runEval(cfg, path.join(fx.root, 'empty.json'));
    assert.equal(res.total, 0);
    assert.deepEqual(res.misses, []);
  });

  test('a missing golden file is an EvalError', async () => {
    const fx = fixtureVault('en');
    const { cfg } = await loadFixture(fx.root);
    await assert.rejects(runEval(cfg, 'nope.json'), EvalError);
  });
});

describe('eval command', () => {
  const fx = fixtureVault('en');
  const file = 'system/tests/fixtures/en/golden.json';

  test('summary line, exit 0', () => {
    const res = runCli(fx.root, ['eval', '--file', file]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^hit@3 1\.00 \(21\/21\) · extraction 9\/9 · multi-session 4\/4 · temporal 4\/4 · knowledge-update 4\/4 · absent 4\/4\n$/);
  });

  test('a miss prints a miss line and exits 1 below the minimum', () => {
    writeJson(fx.root, 'miss.json', golden([
      { id: 'm1', q: 'invoice number format', expect: ['invoice-numbering'], category: 'extraction' },
      { id: 'm2', q: 'invoice number format', expect: ['camera-settings'], category: 'extraction' },
    ]));
    const res = runCli(fx.root, ['eval', '--file', 'miss.json']);
    assert.equal(res.code, 1);
    const lines = res.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^hit@3 0\.50 \(1\/2\) · extraction 1\/2$/);
    assert.match(lines[1], /^miss m2 "invoice number format" expected camera-settings got invoice-numbering(, [a-z0-9-_]+)*$/);
    assert.match(res.stderr, /below the minimum 0\.90/);
    assert.equal(runCli(fx.root, ['eval', '--file', 'miss.json', '--min', '0.5']).code, 0);
  });

  test('--json prints the result', () => {
    const res = runCli(fx.root, ['eval', '--file', file, '--json']);
    assert.equal(res.code, 0);
    const json = JSON.parse(res.stdout);
    for (const key of ['hit3', 'total', 'hits', 'byCategory', 'misses', 'absent']) assert.ok(Object.hasOwn(json, key), key);
    assert.equal(json.hit3, 1);
  });

  test('empty golden file prints "no questions"', () => {
    writeJson(fx.root, 'empty.json', golden([]));
    const res = runCli(fx.root, ['eval', '--file', 'empty.json']);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, 'no questions\n');
  });

  test('the default golden file comes from memory.json', () => {
    writeJson(fx.root, 'system/tests/golden.json', golden([]));
    const res = runCli(fx.root, ['eval']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, 'no questions\n');
  });

  test('usage errors exit 2', () => {
    for (const args of [['--min', '1.5'], ['--min', 'x'], ['--engine', 'bogus'], ['--file', 'missing.json'], ['extra'], ['--bogus']]) {
      const res = runCli(fx.root, ['eval', ...args]);
      assert.equal(res.code, 2, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
      assert.ok(res.stderr.length > 0);
    }
  });

  test('the Czech alias --soubor works', () => {
    const cs = fixtureVault('cs');
    const res = runCli(cs.root, ['eval', '--soubor', 'system/tests/fixtures/cs/golden.json']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^hit@3 /);
  });
});
