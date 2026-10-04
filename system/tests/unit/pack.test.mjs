// Language packs: schema, key parity and the owner's binding Czech naming
// (docs/architecture.md, section 4).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../helpers.mjs';

const packText = (code) => fs.readFileSync(path.join(KIT_ROOT, 'system', 'lang', code, 'pack.json'), 'utf8');
const en = JSON.parse(packText('en'));
const cs = JSON.parse(packText('cs'));

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

  test('CLI aliases of doctor, upgrade, connect and mcp (0.1.1)', () => {
    const commands = { doktor: 'doctor', aktualizuj: 'upgrade', pripoj: 'connect' };
    for (const [alias, canon] of Object.entries(commands)) assert.equal(cs.commands[alias], canon, alias);
    assert.ok(!Object.values(cs.commands).includes('mcp'), 'mcp keeps its one name: clients store it in their configs');
    const flags = {
      '--ano': '--yes', '--nanecisto': '--dry-run', '--vratit': '--rollback', '--odkud': '--from',
      '--bez-overeni': '--no-verify', '--rozsah': '--scope', '--jmeno': '--name', '--odebrat': '--remove',
      '--seznam': '--list', '--jen-cteni': '--read-only', '--lokalni': '--local',
    };
    for (const [alias, canon] of Object.entries(flags)) assert.equal(cs.flags[alias], canon, alias);
    assert.ok(!Object.values(cs.flags).includes('--format'), '--format stays English: its values are English too');
    assert.equal(cs.flags['--nazev'], '--title', '--nazev keeps meaning --title; --name has its own alias');
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

// ---------------------------------------------------------------------------------------------
// What the code defines, read from the source (so these tests need no command to run)

const SYSTEM = path.join(KIT_ROOT, 'system');
const COMMANDS_DIR = path.join(SYSTEM, 'lib', 'commands');
const COMMANDS = fs.readdirSync(COMMANDS_DIR).filter((n) => n.endsWith('.mjs')).map((n) => n.slice(0, -4)).sort();
// memory.mjs itself takes these on every command.
const GLOBAL_FLAGS = ['--root', '--help', '--version'];

/** A source file as LF text (a checkout may hold CRLF). */
const readSource = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

/** Every --flag the usage line of a command module names (the usage may be concatenated). */
function usageFlags(name) {
  const src = readSource(path.join(COMMANDS_DIR, `${name}.mjs`));
  const at = src.indexOf('export const usage');
  const end = src.indexOf(';\n', at);
  assert.ok(at >= 0 && end > at, `${name}.mjs exports no usage`);
  const usage = src.slice(at, end);
  return [...usage.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]);
}

/** Flags that some command documents (and therefore accepts), with the commands naming each. */
function acceptedFlags() {
  const out = new Map(GLOBAL_FLAGS.map((f) => [f, ['memory.mjs']]));
  for (const name of COMMANDS) {
    for (const flag of usageFlags(name)) out.set(flag, [...(out.get(flag) ?? []), name]);
  }
  return out;
}

const unescapeJs = (s) => s.replace(/\\(.)/g, (all, c) => ({ n: '\n', t: '\t' })[c] ?? c);
const ENTRY_RE = /^[ \t]*'([a-z][a-z_]*(?:\.[A-Za-z0-9_-]+)+)':[ \t]*(?:'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)")[ \t]*,?[ \t]*$/gm;

/**
 * The English default of every label and message: the `'key': 'text'` entries of each
 * `…DEFAULTS` table in the kit code (section 4.10). Map key → {text, file}.
 */
function codeTexts() {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'tests') walk(abs);
        continue;
      }
      if (!e.name.endsWith('.mjs')) continue;
      const src = readSource(abs);
      for (const decl of src.matchAll(/^(?:export )?const \w*DEFAULTS = (?:Object\.freeze\()?\{$/gm)) {
        const end = src.indexOf('\n}', decl.index);
        const table = src.slice(decl.index, end < 0 ? undefined : end);
        for (const m of table.matchAll(ENTRY_RE)) {
          const text = unescapeJs(m[2] ?? m[3]);
          const file = path.relative(KIT_ROOT, abs).split(path.sep).join('/');
          const seen = out.get(m[1]);
          assert.ok(!seen || seen.text === text, `${m[1]} has two different English texts (${seen?.file}, ${file})`);
          out.set(m[1], { text, file });
        }
      }
    }
  };
  walk(SYSTEM);
  return out;
}

/** Paths of keys that occur twice in one object of a JSON text (JSON.parse keeps only the last). */
function duplicateKeys(text) {
  const dups = [];
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? '')) i++;
  };
  const string = () => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const value = (where) => {
    space();
    if (text[i] === '{') {
      i++;
      const seen = new Set();
      space();
      if (text[i] === '}') return void i++;
      for (;;) {
        space();
        const key = string();
        if (seen.has(key)) dups.push(`${where}${where ? '.' : ''}${key}`);
        seen.add(key);
        space();
        i++; // the colon
        value(`${where}${where ? '.' : ''}${key}`);
        space();
        if (text[i++] === '}') return undefined;
      }
    }
    if (text[i] === '[') {
      i++;
      space();
      if (text[i] === ']') return void i++;
      for (let n = 0; ; n++) {
        value(`${where}[${n}]`);
        space();
        if (text[i++] === ']') return undefined;
      }
    }
    if (text[i] === '"') return void string();
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
    return undefined;
  };
  value('');
  return dups;
}

/** Every string value of a JSON value, with its path. */
function* strings(value, where = '') {
  if (typeof value === 'string') yield [where, value];
  else if (Array.isArray(value)) for (const [n, v] of value.entries()) yield* strings(v, `${where}[${n}]`);
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) yield* strings(v, where ? `${where}.${k}` : k);
}

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('aliases stay unambiguous (4.6)', () => {
  const accepted = acceptedFlags();

  test('the duplicate-key finder works', () => {
    assert.deepEqual(duplicateKeys('{"a": {"b": 1, "c": [{"d": 1, "d": 2}], "b": "x\\"y"}, "e": []}'), ['a.c[0].d', 'a.b']);
    assert.deepEqual(duplicateKeys('{"a": 1, "b": {"a": 2}}'), []);
  });

  for (const code of ['en', 'cs']) {
    test(`${code}: no key appears twice in one object of pack.json`, () => {
      assert.deepEqual(duplicateKeys(packText(code)), []);
    });
  }

  test('every command alias names a command, and no alias is itself a command name', () => {
    for (const [alias, canon] of Object.entries(cs.commands)) {
      assert.match(alias, NAME_RE, alias);
      assert.ok(canon === 'help' || COMMANDS.includes(canon), `${alias} → ${canon}: no such command`);
      assert.ok(!COMMANDS.includes(alias) && alias !== 'help', `${alias} would hide the command of that name`);
    }
    const targets = Object.values(cs.commands);
    assert.equal(new Set(targets).size, targets.length, `one alias per command: ${targets.join(', ')}`);
  });

  test('flag aliases map globally, so none is a flag of any command and each names a documented flag', () => {
    for (const [alias, canon] of Object.entries(cs.flags)) {
      assert.match(alias, /^--[a-z0-9]+(-[a-z0-9]+)*$/, alias);
      assert.ok(!accepted.has(alias), `${alias} is a flag of ${accepted.get(alias)?.join(', ')}; as an alias it would change it`);
      assert.ok(accepted.has(canon), `${alias} → ${canon}: no command documents ${canon}`);
      assert.ok(!GLOBAL_FLAGS.includes(canon), `${canon} is read by memory.mjs before aliases apply`);
    }
    const targets = Object.values(cs.flags);
    assert.equal(new Set(targets).size, targets.length, `one alias per flag: ${targets.join(', ')}`);
  });

  test('the 0.1.1 flags with Czech aliases are documented by the commands they belong to', () => {
    const owners = {
      '--dry-run': ['connect', 'upgrade'], '--read-only': ['connect', 'mcp'], '--local': ['mcp', 'search'],
      '--yes': ['upgrade'], '--rollback': ['upgrade'], '--from': ['upgrade'], '--no-verify': ['upgrade'],
      '--scope': ['connect'], '--name': ['connect'], '--remove': ['connect'], '--list': ['connect'],
      '--fix': ['doctor'],
    };
    for (const [flag, commands] of Object.entries(owners)) {
      for (const command of commands) assert.ok(accepted.get(flag)?.includes(command), `${command} documents ${flag}`);
    }
  });

  test('sector subcommand aliases name sector subcommands', () => {
    for (const [alias, canon] of Object.entries(cs.subcommands.sector)) {
      assert.match(alias, NAME_RE, alias);
      assert.ok(['add', 'sleep', 'wake', 'off', 'list'].includes(canon), `${alias} → ${canon}`);
    }
  });
});

describe('messages (4.10)', () => {
  const code = codeTexts();

  test('the source scan finds the message tables of every area', () => {
    const prefixes = new Set([...code.keys()].map((k) => k.split('.')[0]));
    for (const p of ['start', 'check', 'new', 'sector', 'sync', 'init', 'eval', 'upgrade', 'connect', 'api', 'mcp', 'schema', 'doctor']) {
      assert.ok(prefixes.has(p), `no ${p}.* defaults found`);
    }
    assert.ok(code.size > 400, `only ${code.size} defaults found`);
    assert.equal(code.get('init.next.commit_message')?.text, 'Set up memory');
  });

  test('the English labels are the code defaults', () => {
    for (const [key, text] of Object.entries(en.labels)) {
      assert.ok(code.has(key), `labels.${key}: the code prints no such label`);
      assert.equal(text, code.get(key).text, `labels.${key}`);
    }
  });

  test('every Czech label and message is one the code prints, with the same placeholders', () => {
    for (const table of ['labels', 'messages']) {
      for (const [key, text] of Object.entries(cs[table])) {
        assert.ok(code.has(key), `${table}.${key}: the code prints no such text (renamed or removed?)`);
        assert.deepEqual(placeholders(text), placeholders(code.get(key).text), `${table}.${key} (${code.get(key).file})`);
      }
    }
  });

  test('the Czech pack translates every label and message the code prints', () => {
    const missing = [...code.keys()].filter((key) => !Object.hasOwn(cs.messages, key) && !Object.hasOwn(cs.labels, key));
    assert.deepEqual(missing, [], `add Czech texts to system/lang/cs/pack.json for: ${missing.join(', ')}`);
  });

  test('no pack text joins shell commands with && (a parse error in Windows PowerShell 5.1)', () => {
    for (const [codeName, pack] of [['en', en], ['cs', cs]]) {
      for (const [where, text] of strings(pack)) assert.ok(!text.includes('&&'), `${codeName}: ${where}`);
    }
    assert.ok(!Object.hasOwn(cs.messages, 'init.next.commit'), 'the joined commit line is gone');
    assert.equal(cs.messages['init.next.commit_message'], 'Nastavení paměti');
  });

  test('Czech texts of 0.1.1 use no dash as punctuation', () => {
    const areas = /^(?:upgrade|connect|api|mcp|schema|eval|doctor)\.|^(?:check\.NAME_PORTABLE|check\.CASE_MISMATCH|start\.bad_format)/;
    for (const [key, text] of Object.entries(cs.messages)) {
      if (areas.test(key)) assert.doesNotMatch(text, /\s[–—-]\s/, key);
    }
  });
});
