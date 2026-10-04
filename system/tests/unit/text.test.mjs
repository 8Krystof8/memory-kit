// text.mjs: normalization, stemmers and the query analyzer (docs/architecture.md, 7.6, 13.3, 13.5).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../lib/config.mjs';
import { analyzer, fold, lcp, nfc, stemmer, tokenize } from '../../lib/text.mjs';
import { bareRoot, removeTmpDirs } from '../helpers.mjs';

after(removeTmpDirs);

describe('normalization', () => {
  test('nfc composes', () => {
    assert.equal(nfc('pra\u0301ce'), 'práce');
    assert.equal(nfc(null), '');
  });

  test('fold: NFC, lowercase, no diacritics', () => {
    assert.equal(fold('Příliš Žluťoučký KŮŇ'), 'prilis zlutoucky kun');
    assert.equal(fold('pra\u0301ce'), 'prace');
    assert.equal(fold('Café'), 'cafe');
  });

  test('tokenize: lowercase NFC words, diacritics kept, split on anything else', () => {
    assert.deepEqual(tokenize('Maturitní práce: web-app, 2026!'), ['maturitní', 'práce', 'web', 'app', '2026']);
    assert.deepEqual(tokenize('  '), []);
  });

  test('lcp compares code points', () => {
    assert.equal(lcp('portálem', 'portál'), 'portál');
    assert.equal(lcp('práci', 'prák'), 'prá');
    assert.equal(lcp('abc', 'xyz'), '');
    assert.equal(lcp('😀a', '😀b'), '😀');
  });
});

describe('stemmers', () => {
  test('the order is law: NFC -> lowercase -> stem -> strip diacritics', async () => {
    const stem = await stemmer('cs');
    assert.equal(fold(stem('rozhodnutím')), 'rozhodnut');
    assert.equal(stem(fold('rozhodnutím')), 'rozhodnutim');
  });

  test('Czech stemmer handles inflection', async () => {
    const stem = await stemmer('cs');
    assert.equal(stem('portálem'), stem('portálu'));
    assert.equal(fold(stem('práci')), 'prak');
    assert.equal(stem('klientem'), stem('klienta'));
  });

  test('English stemmer', async () => {
    const stem = await stemmer('en');
    assert.equal(stem('invoices'), stem('invoice'));
    assert.equal(stem('running'), 'run');
  });

  test('none or an unknown language gives the identity function', async () => {
    for (const code of ['none', 'xx', '../etc']) {
      const stem = await stemmer(code);
      assert.equal(stem('Words'), 'Words', code);
    }
  });

  test('stemmers are memoized', async () => {
    assert.equal(await stemmer('cs'), await stemmer('cs'));
  });
});

describe('analyzer (cs)', async () => {
  const cfg = loadConfig(bareRoot('cs'));
  const a = await analyzer(cfg);

  test('query terms: stem and prefix per 13.3', () => {
    const [prace] = a.queryTerms('práci');
    assert.equal(prace.token, 'práci');
    assert.equal(prace.stem, 'prak');
    assert.equal(prace.prefix, 'prac', 'a stem base under 4 chars (prá) gives way to the first 4 chars');
    assert.equal(prace.hadDiacritics, true);
    assert.equal(a.queryTerms('rodina')[0].prefix, 'rodi', 'rodina → rod would match rod, rodný…');
    const [calendar] = a.queryTerms('kalendarem');
    assert.equal(calendar.stem, 'kalendar');
    assert.equal(calendar.hadDiacritics, false);
  });

  test('stopwords are removed from queries unless nothing else is left', () => {
    assert.deepEqual(a.queryTerms('kdy je ústní zkouška').map((t) => t.token), ['ústní', 'zkouška']);
    assert.deepEqual(a.queryTerms('proc').map((t) => t.token), ['proc'], 'all stopwords: keep them');
    assert.ok(a.queryTerms('co kdy kde').length > 0);
  });

  test('stems(): unique, first-occurrence order, stopwords kept, folded', () => {
    const stems = a.stems('Klientem klienta a kalendáři');
    assert.equal(new Set(stems).size, stems.length);
    assert.equal(stems[0], fold(a.stem('klientem')));
    assert.ok(stems.includes('a'), 'indexing keeps stopwords');
    for (const s of stems) assert.equal(s, fold(s));
  });

  test('rg regex with diacritic classes, anchored at a word start (13.5)', () => {
    assert.equal(a.rgRegex('kalendářem'), '\\b(k[aá]l[eéě][nň][dď][aá][rř])');
    assert.equal(a.rgRegex('pekárně'), '\\b(p[eéě]k[aá][rř][nň])');
    assert.equal(a.rgRegex('kalendarem'), '\\b(k[aá]l[eéě][nň][dď][aá][rř])');
    assert.equal(a.rgRegex('kalendářem pekárně'), '\\b(k[aá]l[eéě][nň][dď][aá][rř]|p[eéě]k[aá][rř][nň])');
    // Partly accented input ("pekarně", "skolní") still gets a class for every letter that has one.
    assert.equal(a.rgRegex('pekarně'), a.rgRegex('pekárně'));
    assert.equal(a.rgRegex('skolní'), '\\b([sš]k[oó]l[nň])');
  });

  test('ASCII base: endings typed without diacritics are cut (13.3)', () => {
    const [rozhodnuti, ceny] = a.queryTerms('rozhodnutim o cenach');
    assert.equal(rozhodnuti.prefix, 'rozhodnut');
    assert.equal(rozhodnuti.stem, 'rozhodnut');
    assert.equal(ceny.prefix, 'cen');
    assert.equal(a.queryTerms('vikendech')[0].prefix, 'vikend');
    assert.equal(a.queryTerms('rozhodnutím')[0].stem, 'rozhodnut', 'accented tokens still use the stemmer');
    assert.equal(a.rgRegex('rozhodnutim'), '\\b([rř][oó][zž]h[oó][dď][nň][uúů][tť])');
    assert.match('rozhodnutí', new RegExp(a.rgRegex('rozhodnutim'), 'i'));
  });

  test('the rg regex matches the inflected forms it was built from, not the middle of words', () => {
    const re = new RegExp(a.rgRegex('kalendářem'), 'i');
    for (const word of ['kalendář', 'kalendáře', 'kalendářem', 'KALENDÁŘI']) assert.match(word, re);
    const den = new RegExp(a.rgRegex('den'), 'i');
    assert.match('den v týdnu', den);
    assert.doesNotMatch('studena, Linden', den, '\\b keeps "den" from matching inside words');
  });
});

describe('analyzer (en)', async () => {
  const cfg = loadConfig(bareRoot('en'));
  const a = await analyzer(cfg);

  test('no diacritic classes in English', () => {
    assert.equal(a.rgRegex('invoices'), '\\b(invoic)');
  });

  test('"bakeries" reaches "bakery" through the ies ending', () => {
    assert.equal(a.queryTerms('bakeries')[0].prefix, 'baker');
  });

  test('English stopwords are dropped', () => {
    assert.deepEqual(a.queryTerms('what is the thesis deadline').map((t) => t.token), ['thesis', 'deadline']);
  });
});
