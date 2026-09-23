// config.mjs: memory.json + language packs -> Cfg (docs/architecture.md, sections 3, 4 and 7.2).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigError, DEFAULT_BUDGETS, loadConfig, loadPack } from '../../lib/config.mjs';
import { bareRoot, removeTmpDirs, writeFile, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

describe('loadConfig (en)', () => {
  const cfg = loadConfig(bareRoot('en'));

  test('basic fields', () => {
    assert.equal(cfg.version, 1);
    assert.equal(cfg.lang, 'en');
    assert.equal(cfg.initialized, true);
    assert.equal(cfg.mode, 'combined');
    assert.equal(cfg.kitVersion, fs.readFileSync(path.join(cfg.root, 'system', 'VERSION'), 'utf8').trim());
    assert.equal(path.isAbsolute(cfg.root), true);
  });

  test('dirs and files follow table 2.1', () => {
    assert.equal(cfg.dirs.sectors, 'sectors');
    assert.equal(cfg.dirs.inbox, 'inbox');
    assert.equal(cfg.dirs.journal, 'journal');
    assert.equal(cfg.dirs.archive, 'archive');
    assert.equal(cfg.dirs.attachments, 'attachments');
    assert.equal(cfg.dirs.decisions, 'decisions');
    assert.equal(cfg.dirs.templates, 'system/templates/en/notes');
    assert.equal(cfg.dirs.ai, '_ai');
    assert.equal(cfg.dirs.system, 'system');
    assert.equal(cfg.files.home, 'home.md');
    assert.equal(cfg.files.state, 'state.md');
    assert.equal(cfg.files.waiting, 'waiting.md');
    assert.equal(cfg.files.config, 'memory.json');
    assert.equal(cfg.files.agents, 'AGENTS.md');
    assert.equal(cfg.files.ignore, '.ignore');
    assert.equal(cfg.files.golden, 'system/tests/golden.json');
    assert.equal(cfg.files.lastCleanup, 'system/cleanup/last.txt');
  });

  test('English values are canonical', () => {
    assert.equal(cfg.keys.description, 'description');
    assert.equal(cfg.keysRev.description, 'description');
    assert.equal(cfg.local('type', 'decision'), 'decision');
    assert.equal(cfg.canon('status', 'active'), 'active');
    assert.equal(cfg.canon('type', 'no-such-type'), null);
    assert.equal(cfg.exportSuffix, '-export');
    assert.equal(cfg.profileNote, 'profile');
  });

  test('budgets default to section 3.1', () => {
    assert.deepEqual(cfg.budgets.start_bytes, [7500, 8500]);
    assert.equal(cfg.budgets.hook_bytes, 9500);
    assert.deepEqual(cfg.budgets.description_chars, [160, 200]);
    assert.equal(cfg.budgets.hot_total, 20);
    assert.equal(cfg.budgets.hot_days, 14);
    for (const [key, value] of Object.entries(DEFAULT_BUDGETS)) assert.deepEqual(cfg.budgets[key], value, key);
  });

  test('search and eval defaults', () => {
    assert.deepEqual(cfg.search, { log: false, n: 5 });
    assert.equal(cfg.eval.min, 0.9);
    assert.equal(cfg.cleanup.provider, 'none');
    assert.deepEqual(cfg.warnings, []);
  });

  test('t() interpolates and falls back to the key', () => {
    assert.equal(cfg.t('start.summary', { notes: 3, sectors: 2, asOf: '2026-09-23' }), '3 notes · 2 sectors · as of 2026-09-23');
    assert.equal(cfg.t('no.such.message'), 'no.such.message');
    assert.equal(cfg.t('check.FM_REQUIRED', { key: 'description' }), 'missing description');
  });
});

describe('loadConfig (cs)', () => {
  const cfg = loadConfig(bareRoot('cs'));

  test('Czech names from the pack', () => {
    assert.equal(cfg.lang, 'cs');
    assert.equal(cfg.dirs.sectors, 'sektory');
    assert.equal(cfg.dirs.journal, 'denik');
    assert.equal(cfg.dirs.archive, 'archiv');
    assert.equal(cfg.dirs.attachments, 'prilohy');
    assert.equal(cfg.dirs.decisions, 'rozhodnuti');
    assert.equal(cfg.dirs.templates, 'system/templates/cs/notes');
    assert.equal(cfg.dirs.ai, '_ai', 'generated names are never localized');
    assert.equal(cfg.files.home, 'domu.md');
    assert.equal(cfg.files.state, 'stav.md');
    assert.equal(cfg.files.waiting, 'ceka.md');
    assert.equal(cfg.exportSuffix, '-export');
    assert.equal(cfg.profileNote, 'profil');
  });

  test('keys map both ways; canonical keys are accepted too', () => {
    assert.equal(cfg.keys.type, 'typ');
    assert.equal(cfg.keys.description, 'popis');
    assert.equal(cfg.keys.aliases, 'aliases');
    assert.equal(cfg.keysRev.typ, 'type');
    assert.equal(cfg.keysRev.klicova, 'keywords');
    assert.equal(cfg.keysRev.type, 'type');
  });

  test('values: local() and canon() accept localized and canonical words', () => {
    assert.equal(cfg.local('type', 'decision'), 'rozhodnuti');
    assert.equal(cfg.local('status', 'active'), 'aktivni');
    assert.equal(cfg.local('state', 'sleep'), 'uspany');
    assert.equal(cfg.local('privacy', 'local'), 'lokal');
    assert.equal(cfg.canon('type', 'rozhodnuti'), 'decision');
    assert.equal(cfg.canon('type', 'decision'), 'decision');
    assert.equal(cfg.canon('status', 'nahrazeno'), 'replaced');
    assert.equal(cfg.canon('state', 'zapnuty'), 'on');
    assert.equal(cfg.canon('privacy', 'lokal'), 'local');
    assert.equal(cfg.canon('type', 'nesmysl'), null);
  });

  test('CLI aliases', () => {
    assert.equal(cfg.commands.hledej, 'search');
    assert.equal(cfg.commands.kontrola, 'check');
    assert.equal(cfg.commands.novy, 'new');
    assert.equal(cfg.commands.sektor, 'sector');
    assert.equal(cfg.subcommands.sector.uspat, 'sleep');
    assert.equal(cfg.flags['--typ'], '--type');
    assert.equal(cfg.flags['--dnes'], '--today');
  });

  test('stopwords and diacritic classes', () => {
    assert.ok(cfg.stopwords.has('proč'));
    assert.equal(cfg.diacriticClasses.a, '[aá]');
    assert.ok(cfg.genericNames.has('poznamky'));
    assert.ok(cfg.genericNames.has('notes'), 'English generic names stay forbidden');
  });

  test('t() uses Czech labels and falls back to English defaults', () => {
    assert.equal(cfg.t('start.title'), 'Paměť: start');
    assert.equal(cfg.t('no.such.message'), 'no.such.message');
  });

  test('the lang option overrides memory.json', () => {
    const en = loadConfig(cfg.root, { lang: 'en' });
    assert.equal(en.lang, 'en');
    assert.equal(en.dirs.sectors, 'sectors');
  });
});

describe('budgets are law', () => {
  test('memory.json may lower a budget', () => {
    const cfg = loadConfig(bareRoot('en', { budgets: { hot_total: 10, start_bytes: [6000, 7000] } }));
    assert.equal(cfg.budgets.hot_total, 10);
    assert.deepEqual(cfg.budgets.start_bytes, [6000, 7000]);
    assert.deepEqual(cfg.warnings, []);
  });

  test('a larger value is clamped to the default with a warning', () => {
    const cfg = loadConfig(bareRoot('en', { budgets: { hot_total: 50, start_bytes: [9000, 20000] } }));
    assert.equal(cfg.budgets.hot_total, 20);
    assert.deepEqual(cfg.budgets.start_bytes, [7500, 8500]);
    assert.ok(cfg.warnings.length >= 2, cfg.warnings.join('\n'));
  });
});

describe('roots and modes', () => {
  test('a local root is resolved against the main root and reports whether it exists', () => {
    const root = bareRoot('en', {
      roots: [{ id: 'main', path: '.', privacy: 'github' }, { id: 'private', path: '../elsewhere', privacy: 'local' }],
    });
    const cfg = loadConfig(root);
    assert.equal(cfg.roots.length, 2);
    assert.equal(cfg.roots[0].id, 'main');
    assert.equal(cfg.roots[0].path, cfg.root);
    assert.equal(cfg.roots[1].path, path.resolve(root, '..', 'elsewhere'));
    assert.equal(cfg.roots[1].privacy, 'local');
    assert.equal(cfg.roots[1].exists, false);
    fs.mkdirSync(path.resolve(root, '..', 'elsewhere'), { recursive: true });
    assert.equal(loadConfig(root).roots[1].exists, true);
  });

  test('an unknown cleanup provider is a warning and treated as none', () => {
    const cfg = loadConfig(bareRoot('en', { cleanup: { provider: 'some-model' } }));
    assert.equal(cfg.cleanup.provider, 'none');
    assert.ok(cfg.warnings.some((w) => w.includes('some-model')));
  });
});

describe('errors', () => {
  test('missing memory.json', () => {
    const root = bareRoot('en');
    fs.rmSync(path.join(root, 'memory.json'));
    assert.throws(() => loadConfig(root), ConfigError);
  });

  test('invalid JSON', () => {
    const root = bareRoot('en');
    writeFile(root, 'memory.json', '{ "version": 1, ');
    assert.throws(() => loadConfig(root), ConfigError);
  });

  test('unknown language', () => {
    const root = bareRoot('en');
    writeJson(root, 'memory.json', { version: 1, lang: 'xx' });
    assert.throws(() => loadConfig(root), ConfigError);
  });

  test('schema version other than 1', () => {
    const root = bareRoot('en', { version: 2 });
    assert.throws(() => loadConfig(root), ConfigError);
  });

  test('loadPack reports a missing pack', () => {
    assert.throws(() => loadPack(bareRoot('en'), 'zz'), ConfigError);
  });
});
