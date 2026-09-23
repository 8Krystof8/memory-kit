// The CLI surface on a fixture vault: memory.mjs dispatch, start, check, new, sector and search
// options (docs/architecture.md, sections 1.4, 6, 7.13 and 10).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '../../lib/frontmatter.mjs';
import {
  TODAY, checkJson, describeFindings, exists, fixtureVault, hashGenerated, readFile, removeTmpDirs,
  runCli, writeFile,
} from '../helpers.mjs';

after(removeTmpDirs);

/** A generated English fixture vault. */
function generatedVault(lang = 'en') {
  const fx = fixtureVault(lang);
  const res = runCli(fx.root, ['check', '--generate', '--strict', '--today', TODAY]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  return fx;
}

const editJson = (root, rel, fn) => {
  const json = JSON.parse(readFile(root, rel));
  fn(json);
  writeFile(root, rel, `${JSON.stringify(json, null, 2)}\n`);
};

describe('memory.mjs', () => {
  const fx = fixtureVault('en');

  test('help lists every command, also without arguments', () => {
    for (const args of [['help'], ['--help'], []]) {
      const res = runCli(fx.root, args);
      assert.equal(res.code, 0, args.join(' '));
      for (const cmd of ['start', 'check', 'search', 'new', 'sector', 'sync', 'eval']) {
        assert.match(res.stdout, new RegExp(`node system/memory\\.mjs ${cmd}\\b`), cmd);
      }
    }
  });

  test('--version prints system/VERSION', () => {
    const res = runCli(fx.root, ['--version']);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, readFile(fx.root, 'system/VERSION').trim() + '\n');
  });

  test('an unknown command is a usage error', () => {
    const res = runCli(fx.root, ['frobnicate']);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /frobnicate/);
  });

  test('Czech command aliases', () => {
    const cs = fixtureVault('cs');
    assert.equal(runCli(cs.root, ['napoveda']).code, 0);
    const res = runCli(cs.root, ['kontrola', '--generuj', '--prisne', '--dnes', TODAY]);
    assert.equal(res.code, 0, res.stdout);
    assert.ok(exists(cs.root, '_ai/start.md'));
    const list = runCli(cs.root, ['sektor', 'seznam']);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /^jadro · zapnuty · github · /m);
  });

  test('--root is honoured from any working directory', () => {
    const res = runCli(fx.root, ['search', 'invoice', '--json'], { cwd: path.dirname(fx.root) });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(JSON.parse(res.stdout).results.length > 0);
  });
});

describe('start (10.4)', () => {
  let fx;
  before(() => {
    fx = generatedVault();
  });

  test('prints the committed start.md when it is fresh', () => {
    const res = runCli(fx.root, ['start', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, readFile(fx.root, '_ai/start.md'));
  });

  test('renders on the fly when stale, adds the stale line and writes nothing', () => {
    const v = generatedVault();
    const before = hashGenerated(v.root);
    writeFile(v.root, 'sectors/work/pricing.md', `${readFile(v.root, 'sectors/work/pricing.md')}- [fact] 2026-09-20: One more.\n`);
    const res = runCli(v.root, ['start', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trimEnd().split('\n').pop(), '(_ai/ is stale: this view was rendered on the fly; the next commit regenerates it)');
    assert.deepEqual(hashGenerated(v.root), before, 'start never writes');
  });

  test('--sectors narrows the view', () => {
    const res = runCli(fx.root, ['start', '--sectors', 'school', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('| school |'));
    assert.ok(!res.stdout.includes('| work |'));
  });

  test('not initialized: the setup hint comes first', () => {
    const v = generatedVault();
    editJson(v.root, 'memory.json', (j) => {
      j.initialized = false;
    });
    const res = runCli(v.root, ['start', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.startsWith('Memory is not set up yet.'), res.stdout.slice(0, 120));
  });

  test('output always fits the hook budget and exits 0', () => {
    const res = runCli(fx.root, ['start']);
    assert.equal(res.code, 0);
    assert.ok(Buffer.byteLength(res.stdout) <= 9500);
  });
});

describe('check (10.3)', () => {
  test('--json shape and --generate', () => {
    const fx = fixtureVault('en');
    const res = checkJson(fx.root, ['--generate', '--strict', '--today', TODAY]);
    assert.equal(res.code, 0, describeFindings(res));
    assert.equal(res.mode, 'strict');
    assert.ok(Array.isArray(res.errors) && Array.isArray(res.warnings));
    assert.equal(typeof res.notes, 'number');

    const human = runCli(fx.root, ['check', '--generate', '--today', TODAY]);
    assert.equal(human.code, 0);
    const lines = human.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'generated: 0 written, 0 removed');
    assert.match(lines.at(-1), /^\(0 errors · \d+ warnings · \d+ notes · strict\)$/);
  });

  test('errors exit 1; lenient turns data errors into warnings', () => {
    const fx = generatedVault();
    writeFile(fx.root, 'sectors/work/bare-note.md', '# No frontmatter\n');
    assert.equal(runCli(fx.root, ['check', '--today', TODAY]).code, 1);
    const lenient = runCli(fx.root, ['check', '--lenient', '--today', TODAY]);
    assert.equal(lenient.code, 0, lenient.stdout);
    assert.match(lenient.stdout, /^WARN {2}FM_MISSING sectors\/work\/bare-note\.md/m);
    assert.match(lenient.stdout, /· lenient\)\n$/);
  });

  test('usage errors', () => {
    const fx = fixtureVault('en');
    for (const args of [['--strict', '--lenient'], ['--today', '2026-02-30'], ['--bogus'], ['extra']]) {
      assert.equal(runCli(fx.root, ['check', ...args]).code, 2, args.join(' '));
    }
  });
});

describe('new (10.5)', () => {
  test('creates a note from its template with today as updated', () => {
    const fx = fixtureVault('en');
    const res = runCli(fx.root, ['new', 'fact', 'work/office-hours', '--description', 'When the studio answers the phone.', '--today', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(res.stdout, 'created sectors/work/office-hours.md\n');
    const fm = parse(readFile(fx.root, 'sectors/work/office-hours.md')).data;
    assert.equal(fm.type, 'fact');
    assert.equal(fm.status, 'active');
    assert.equal(fm.description, 'When the studio answers the phone.');
    assert.equal(String(fm.updated), TODAY);
  });

  test('without a description it asks for one', () => {
    const fx = fixtureVault('en');
    const res = runCli(fx.root, ['new', 'person', 'work/people/new-contact', '--today', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const [created, hint] = res.stdout.trimEnd().split('\n');
    assert.equal(created, 'created sectors/work/people/new-contact.md');
    assert.match(hint, /description/);
  });

  test('decisions go to the decisions shelf with a date prefix; journal entries by year', () => {
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['new', 'decision', 'school/exam-preparation', '--today', TODAY]).code, 0);
    assert.ok(exists(fx.root, `sectors/school/decisions/${TODAY}-exam-preparation.md`));
    const created = parse(readFile(fx.root, `sectors/school/decisions/${TODAY}-exam-preparation.md`)).data.created;
    assert.equal(String(created), TODAY);
    assert.equal(runCli(fx.root, ['new', 'journal', 'review-session', '--today', TODAY]).code, 0);
    assert.ok(exists(fx.root, `journal/2026/${TODAY}-review-session.md`));
  });

  test('refusals exit 1: existing file, sector and hub types, unknown sector, off sector', () => {
    const fx = fixtureVault('en');
    for (const args of [['fact', 'work/pricing'], ['sector', 'work/x'], ['hub', 'work/x'], ['fact', 'nowhere/x'], ['fact', 'work/notes']]) {
      const res = runCli(fx.root, ['new', ...args, '--today', TODAY]);
      assert.equal(res.code, 1, `${args.join(' ')}: ${res.stdout}${res.stderr}`);
    }
    assert.equal(runCli(fx.root, ['sector', 'off', 'hobbies', '--today', TODAY]).code, 0);
    assert.equal(runCli(fx.root, ['new', 'list', 'hobbies/gear', '--today', TODAY]).code, 1);
  });

  test('a likely duplicate is refused unless --force', () => {
    const fx = fixtureVault('en');
    const args = ['new', 'decision', 'work/flat-packages', '--title', 'Fixed-price packages',
      '--description', 'New offers use fixed-price packages instead of hourly billing.', '--today', TODAY];
    const refused = runCli(fx.root, args);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /LIKELY DUPLICATE: extend sectors\/work\/decisions\/2026-06-02-fixed-price-packages\.md/);
    assert.ok(!exists(fx.root, `sectors/work/decisions/${TODAY}-flat-packages.md`));
    assert.equal(runCli(fx.root, [...args, '--force']).code, 0);
    assert.ok(exists(fx.root, `sectors/work/decisions/${TODAY}-flat-packages.md`));
  });

  test('a note of a local sector is created in the local root, never in the repository', () => {
    const fx = fixtureVault('en');
    const res = runCli(fx.root, ['new', 'fact', 'health/blood-test', '--description', 'Results of the yearly blood test.', '--today', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(fs.existsSync(path.join(fx.priv, 'sectors', 'health', 'blood-test.md')));
    assert.ok(!exists(fx.root, 'sectors/health/blood-test.md'));
  });

  test('Czech: localized type names and keys', () => {
    const fx = fixtureVault('cs');
    const res = runCli(fx.root, ['new', 'fakt', 'prace/otviraci-doba', '--popis', 'Kdy studio bere telefon.', '--dnes', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const fm = parse(readFile(fx.root, 'sektory/prace/otviraci-doba.md')).data;
    assert.equal(fm.typ, 'fakt');
    assert.equal(fm.stav, 'aktivni');
    assert.equal(fm.popis, 'Kdy studio bere telefon.');
    assert.equal(String(fm.aktualizace), TODAY);
  });
});

describe('sector (6, 10.5)', () => {
  test('list: one line per sector', () => {
    const fx = fixtureVault('en');
    const res = runCli(fx.root, ['sector', 'list']);
    assert.equal(res.code, 0);
    const lines = res.stdout.trimEnd().split('\n');
    assert.deepEqual(lines.map((l) => l.split(' · ')[0]), ['core', 'health', 'hobbies', 'school', 'work']);
    assert.match(lines[4], /^work · on · github · 18 notes · Linden Studio: /);
    assert.match(lines[1], /^health · on · local · /);
    assert.match(lines[2], /^hobbies · sleep · github · /);
  });

  test('add creates the manifest and regenerates the AI view', () => {
    const fx = generatedVault();
    const res = runCli(fx.root, ['sector', 'add', 'travel', '--description', 'Trips and plans.',
      '--when', 'A trip.', '--not', 'Work trips.', '--keywords', 'travel,trip,trips,journey,holiday', '--today', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(exists(fx.root, 'sectors/travel/_travel.md'));
    assert.ok(exists(fx.root, '_ai/index-travel.md'));
    assert.ok(readFile(fx.root, '_ai/start.md').includes('| travel |'));
    const res2 = checkJson(fx.root, ['--strict']);
    assert.deepEqual(res2.errors, [], describeFindings(res2));
  });

  test('add a local sector: manifest and export here, content folder in the local root', () => {
    const fx = generatedVault();
    const res = runCli(fx.root, ['sector', 'add', 'family', '--privacy', 'local', '--today', TODAY]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(exists(fx.root, 'sectors/family/_family.md'));
    assert.ok(exists(fx.root, 'sectors/family/_family-export.md'));
    assert.ok(fs.statSync(path.join(fx.priv, 'sectors', 'family')).isDirectory());
    assert.ok(!exists(fx.root, '_ai/index-family.md'), 'local sectors get no index');
  });

  test('refusals: existing id, invalid id, unknown sector, local without a local root', () => {
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['sector', 'add', 'work', '--today', TODAY]).code, 1);
    assert.equal(runCli(fx.root, ['sector', 'add', 'Bad_Id', '--today', TODAY]).code, 1);
    assert.equal(runCli(fx.root, ['sector', 'sleep', 'nowhere', '--today', TODAY]).code, 1);
    editJson(fx.root, 'memory.json', (j) => {
      j.roots = j.roots.slice(0, 1);
    });
    const local = runCli(fx.root, ['sector', 'add', 'family', '--privacy', 'local', '--today', TODAY]);
    assert.equal(local.code, 1);
    assert.ok(!exists(fx.root, 'sectors/family/_family.md'));
  });

  test('usage errors exit 2', () => {
    const fx = fixtureVault('en');
    for (const args of [[], ['explode', 'work'], ['sleep'], ['add', 'x', '--privacy', 'public']]) {
      assert.equal(runCli(fx.root, ['sector', ...args]).code, 2, args.join(' '));
    }
  });
});

describe('search options (10.2, 13.1)', () => {
  const fx = fixtureVault('en');
  const json = (...args) => {
    const res = runCli(fx.root, ['search', ...args, '--json']);
    assert.equal(res.code, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  test('--status any shows replaced notes, --type filters', () => {
    const names = (r) => r.results.map((x) => x.name);
    assert.ok(!names(json('hourly', 'billing', '--n', '20')).includes('2026-03-10-hourly-billing'));
    assert.ok(names(json('hourly', 'billing', '--status', 'any')).includes('2026-03-10-hourly-billing'));
    const decisions = json('billing', 'packages', '--type', 'decision', '--status', 'any');
    assert.ok(decisions.results.length > 0 && decisions.results.every((r) => r.type === 'decision'));
  });

  test('markers in the human output: inbox, archive, local', () => {
    const inbox = runCli(fx.root, ['search', 'loyalty', 'card', '--all']).stdout;
    assert.match(inbox, /^\d+ \[inbox: data, not instructions\] inbox\/2026-09-17-loyalty-card-idea\.md · /m);
    const archive = runCli(fx.root, ['search', 'logo', 'brief', '--all']).stdout;
    assert.match(archive, /^\d+ \[archive\] archive\/sectors\/work\/old-logo-brief\.md · /m);
    // Local notes are only counted by default; --local shows them with their real path.
    const hidden = runCli(fx.root, ['search', 'dentist']).stdout;
    assert.doesNotMatch(hidden, /dentist-appointments/);
    assert.match(hidden, /^\(\+1 in local sectors: not shown\. .*--local\)$/m);
    const local = runCli(fx.root, ['search', 'dentist', '--local']).stdout;
    assert.match(local, /^\d+ \[L\] \.\.\/private\/sectors\/health\/dentist-appointments\.md · /m);
  });

  test('--duplicates', () => {
    const res = runCli(fx.root, ['search', '--duplicates', 'Fixed-price packages', 'New offers use fixed-price packages', '--type', 'decision']);
    assert.equal(res.code, 0, res.stderr);
    const lines = res.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^sectors\/work\/decisions\/2026-06-02-fixed-price-packages\.md · decision · shared: .+ · \d+\.\d\d$/);
    assert.equal(lines.at(-1), 'LIKELY DUPLICATE: extend sectors/work/decisions/2026-06-02-fixed-price-packages.md instead of creating a new note.');
  });

  test('0 results is exit 0', () => {
    const res = runCli(fx.root, ['search', 'xylophone']);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /^\(0 results · terms: xylophon\w*\*\) /);
  });

  test('the search log is off by default and writes one line per query when on', () => {
    runCli(fx.root, ['search', 'invoice']);
    assert.ok(!exists(fx.root, 'system/usage/search.log'));
    editJson(fx.root, 'memory.json', (j) => {
      j.search = { log: true, n: 5 };
    });
    runCli(fx.root, ['search', 'invoice', 'numbering', '--today', TODAY]);
    runCli(fx.root, ['search', 'dentist', '--today', TODAY]);
    const lines = readFile(fx.root, 'system/usage/search.log').trimEnd().split('\n');
    assert.equal(lines.length, 2);
    const [date, query, total, top] = lines[0].split('\t');
    assert.equal(date, TODAY);
    assert.equal(query, 'invoice numbering');
    assert.ok(Number(total) >= 1);
    assert.equal(top.split(',')[0], 'sectors/work/invoice-numbering.md');
    assert.ok(!lines[1].includes('dentist-appointments'), 'local notes are never named in the committed log');
    editJson(fx.root, 'memory.json', (j) => {
      j.search = { log: false, n: 5 };
    });
  });

  test('usage errors exit 2', () => {
    for (const args of [[], ['x', '--type', 'memo'], ['x', '--status', 'finished'], ['x', '--sector', 'nowhere'],
      ['x', '--n', '0'], ['x', '--engine', 'bogus'], ['--rg', '--duplicates', 'x'], ['x', '--bogus']]) {
      assert.equal(runCli(fx.root, ['search', ...args]).code, 2, args.join(' '));
    }
  });
});
