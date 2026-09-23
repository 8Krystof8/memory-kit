// Language packs: schema, key parity and the owner's binding Czech naming
// (docs/architecture.md, section 4).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../helpers.mjs';

const readPack = (code) => JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'system', 'lang', code, 'pack.json'), 'utf8'));
const en = readPack('en');
const cs = readPack('cs');

const TOP_KEYS = [
  'code', 'name', 'stemmer', 'dirs', 'files', 'profile_note', 'export_suffix', 'keys', 'types', 'statuses',
  'sector_states', 'privacy', 'tiers', 'sections', 'markers', 'relations', 'waiting', 'commands',
  'subcommands', 'flags', 'stopwords', 'diacritic_classes', 'generic_names', 'sector_presets',
  'start_safety', 'labels', 'messages',
];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Paths of every key in `a` (recursing into objects) that `b` lacks. */
function missingKeys(a, b, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(a)) {
    const here = prefix ? `${prefix}.${key}` : key;
    if (!isObject(b) || !Object.hasOwn(b, key)) out.push(here);
    else if (isObject(value)) out.push(...missingKeys(value, b[key], here));
  }
  return out;
}

describe('schema (4.2)', () => {
  for (const [code, pack] of [['en', en], ['cs', cs]]) {
    test(`${code}: every top-level key is present`, () => {
      for (const key of TOP_KEYS) assert.ok(Object.hasOwn(pack, key), `${code} pack lacks "${key}"`);
      assert.equal(pack.code, code);
      assert.equal(pack.stemmer, code);
    });

    test(`${code}: localized values are unique within their table`, () => {
      for (const table of ['keys', 'types', 'statuses', 'sector_states', 'privacy', 'tiers', 'sections', 'markers', 'relations']) {
        const values = Object.values(pack[table]);
        assert.equal(new Set(values).size, values.length, `${code}.${table} has duplicate values: ${values.join(', ')}`);
      }
    });

    test(`${code}: folder and file names are lowercase ascii with hyphens`, () => {
      for (const [role, name] of Object.entries(pack.dirs)) {
        if (role === 'templates') continue;
        assert.match(name, NAME_RE, `dirs.${role}`);
      }
      for (const [role, name] of Object.entries(pack.files)) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*\.md$/, `files.${role}`);
      assert.match(pack.profile_note, NAME_RE);
      assert.match(pack.export_suffix, /^-[a-z0-9]+(-[a-z0-9]+)*$/);
    });

    test(`${code}: three start safety lines`, () => {
      assert.equal(pack.start_safety.length, 3);
      for (const line of pack.start_safety) assert.ok(line.startsWith('- '), line);
    });

    test(`${code}: stopwords are lowercase NFC`, () => {
      for (const w of pack.stopwords) assert.equal(w, w.normalize('NFC').toLowerCase(), w);
    });

    test(`${code}: sector presets (4.8)`, () => {
      const expected = {
        en: { core: 'core', work: 'work', school: 'school', personal: 'personal', family: 'family', health: 'health', finances: 'finances', hobbies: 'hobbies' },
        cs: { core: 'jadro', work: 'prace', school: 'skola', personal: 'osobni', family: 'rodina', health: 'zdravi', finances: 'finance', hobbies: 'konicky' },
      }[code];
      const local = new Set(['family', 'health', 'finances']);
      assert.deepEqual(Object.keys(pack.sector_presets).sort(), Object.keys(expected).sort());
      for (const [preset, p] of Object.entries(pack.sector_presets)) {
        assert.equal(p.id, expected[preset], `${preset}.id`);
        assert.match(p.id, NAME_RE);
        assert.equal(p.privacy, local.has(preset) ? 'local' : 'github', `${preset}.privacy`);
        for (const field of ['title', 'description', 'when_here', 'not_here']) {
          assert.ok(typeof p[field] === 'string' && p[field].trim(), `${preset}.${field}`);
        }
        assert.ok(p.keywords.length >= 5, `${preset} needs at least 5 keywords`);
      }
    });
  }
});

describe('key parity (4.1)', () => {
  test('cs defines every key the en pack defines', () => {
    assert.deepEqual(missingKeys(en, cs), []);
  });

  test('labels of table 4.9 exist in both packs', () => {
    const required = [
      'start.title', 'start.summary', 'start.alerts', 'start.search', 'start.safety', 'start.sectors',
      'start.col_sector', 'start.col_what', 'start.col_when', 'start.col_notes', 'start.col_updated',
      'start.sleeping', 'start.local', 'start.profile', 'start.hot', 'start.now', 'start.counts', 'start.stale',
      'start.not_initialized', 'index.title', 'index.rules', 'index.linked', 'index.search', 'index.cross',
      'index.outside', 'index.more', 'index.verify', 'index.hot', 'profile.title', 'profile.sectors',
      'profile.memory', 'ignore.comment', 'search.line', 'search.footer', 'search.none', 'search.local',
      'search.inbox', 'search.dup_likely', 'search.dup_none', 'check.summary', 'search.local_hidden',
      'start.sleeping_list', 'home.title', 'home.lead', 'home.summary', 'home.now', 'home.waiting', 'home.sectors',
      'home.overview', 'home.local_row', 'home.recent', 'home.decisions', 'home.more', 'home.inbox',
      'home.col_sector', 'home.col_state', 'home.col_privacy', 'home.col_what', 'home.col_notes', 'home.col_updated',
      'home.col_note', 'home.col_type', 'home.col_status',
    ];
    for (const pack of [en, cs]) {
      for (const key of required) assert.ok(typeof pack.labels[key] === 'string' && pack.labels[key], `${pack.code} labels.${key}`);
    }
  });

  test('placeholders of every translated label and message match the English ones', () => {
    const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const table of ['labels', 'messages']) {
      for (const [key, text] of Object.entries(cs[table])) {
        if (!Object.hasOwn(en[table], key)) continue;
        assert.deepEqual(vars(text), vars(en[table][key]), `${table}.${key}`);
      }
    }
  });
});

describe('English pack', () => {
  test('keys, types and statuses are canonical', () => {
    for (const table of ['keys', 'types', 'statuses']) {
      for (const [canon, local] of Object.entries(en[table])) assert.equal(local, canon, `${table}.${canon}`);
    }
  });

  test('no command, subcommand or flag aliases', () => {
    assert.deepEqual(en.commands, {});
    assert.deepEqual(en.subcommands.sector ?? {}, {});
    assert.deepEqual(en.flags, {});
    assert.deepEqual(en.diacritic_classes, {});
  });

  test('minimum stopwords and generic names (4.7)', () => {
    const stop = 'a an the of to in on at for and or is are was were be do does did we i you it this that what when where which who how why my our about'.split(' ');
    for (const w of stop) assert.ok(en.stopwords.includes(w), w);
    for (const w of 'notes note new untitled misc stuff temp test todo'.split(' ')) assert.ok(en.generic_names.includes(w), w);
  });
});

describe('Czech pack reproduces the owner naming (binding)', () => {
  test('folders and files', () => {
    assert.equal(cs.dirs.sectors, 'sektory');
    assert.equal(cs.dirs.inbox, 'inbox');
    assert.equal(cs.dirs.journal, 'denik');
    assert.equal(cs.dirs.archive, 'archiv');
    assert.equal(cs.dirs.attachments, 'prilohy');
    assert.equal(cs.dirs.decisions, 'rozhodnuti');
    assert.equal(cs.files.home, 'domu.md');
    assert.equal(cs.files.state, 'stav.md');
    assert.equal(cs.files.waiting, 'ceka.md');
    assert.equal(cs.profile_note, 'profil');
    assert.equal(cs.export_suffix, '-export');
  });

  test('frontmatter keys (4.3)', () => {
    assert.deepEqual(cs.keys, {
      type: 'typ', status: 'stav', description: 'popis', updated: 'aktualizace', created: 'datum',
      aliases: 'aliases', keywords: 'klicova', replaces: 'nahrazuje', replaced_by: 'nahrazeno',
      valid_until: 'plati_do', review_on: 'zkontrolovat', pin: 'pin', source: 'zdroj', questions: 'otazky',
      state: 'zapnuti', privacy: 'soukromi', when_here: 'kdy_sem', not_here: 'nepatri_sem', links: 'napojeni',
      hot_max: 'horke_max', cleanup: 'urovnavac', sectors: 'sektory', used: 'pouzite', changed: 'zmeneno',
      search_missed: 'hledani_minuly',
    });
  });

  test('types and statuses (4.4)', () => {
    assert.deepEqual(cs.types, {
      decision: 'rozhodnuti', rule: 'pravidlo', procedure: 'postup', fact: 'fakt', insight: 'poznatek',
      project: 'projekt', proposal: 'navrh', analysis: 'rozbor', text: 'text', list: 'seznam',
      person: 'clovek', organization: 'organizace', journal: 'denik', sector: 'sektor', hub: 'rozcestnik',
    });
    assert.deepEqual(cs.statuses, {
      active: 'aktivni', waiting: 'ceka', done: 'hotovo', replaced: 'nahrazeno', rejected: 'zamitnuto',
    });
  });

  test('other value tables (4.5)', () => {
    assert.deepEqual(cs.sector_states, { on: 'zapnuty', sleep: 'uspany', off: 'vypnuty' });
    assert.deepEqual(cs.privacy, { github: 'github', local: 'lokal' });
    assert.deepEqual(cs.tiers, { hot: 'horka', warm: 'tepla', cold: 'studena', archive: 'archiv' });
    assert.equal(cs.sections.now, 'Teď');
    assert.equal(cs.sections.history, 'Historie');
    assert.equal(cs.sections.related, 'Souvislosti');
    assert.equal(cs.waiting.answer, 'Odpověď');
  });

  test('CLI aliases (4.6)', () => {
    const commands = { kontrola: 'check', hledej: 'search', novy: 'new', sektor: 'sector', synchronizuj: 'sync', napoveda: 'help' };
    for (const [alias, canon] of Object.entries(commands)) assert.equal(cs.commands[alias], canon, alias);
    const sub = { pridat: 'add', uspat: 'sleep', probudit: 'wake', vypnout: 'off', seznam: 'list' };
    for (const [alias, canon] of Object.entries(sub)) assert.equal(cs.subcommands.sector[alias], canon, alias);
    const flags = {
      '--sektor': '--sector', '--typ': '--type', '--stav': '--status', '--vse': '--all', '--duplicity': '--duplicates',
      '--generuj': '--generate', '--prisne': '--strict', '--tolerantne': '--lenient', '--dnes': '--today',
      '--popis': '--description', '--nazev': '--title', '--soukromi': '--privacy', '--klicova': '--keywords',
      '--kdy': '--when', '--nepatri': '--not', '--soubor': '--file', '--vynutit': '--force',
    };
    for (const [alias, canon] of Object.entries(flags)) assert.equal(cs.flags[alias], canon, alias);
  });

  test('diacritic classes, stopwords and generic names (4.7)', () => {
    assert.deepEqual(cs.diacritic_classes, {
      a: '[aá]', e: '[eéě]', i: '[ií]', o: '[oó]', u: '[uúů]', y: '[yý]', c: '[cč]', d: '[dď]',
      n: '[nň]', r: '[rř]', s: '[sš]', t: '[tť]', z: '[zž]',
    });
    const stop = 'a i k o s u v z ve na se je jsem jsme to ten ta co kdy kde jak proč kdo který která které jaký jaká jaké mám máme má do od po pro při za ze že nebo ale jsou byl byla bylo'.split(' ');
    for (const w of stop) assert.ok(cs.stopwords.includes(w), w);
    for (const w of 'poznamky poznamka nove nova ruzne test'.split(' ')) assert.ok(cs.generic_names.includes(w), w);
  });
});
