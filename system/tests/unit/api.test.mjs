// The JS API (system/api.mjs) on fixture vaults: openMemory, info, start, search, read, recent,
// inbox, check and close; errors are MemoryError with a stable code. Also the pure start view
// (lib/startview.mjs) and `start --format`. Outputs are compared with the CLI where both exist.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { API_VERSION, INBOX_MAX_CHARS, MemoryError, openMemory } from '../../api.mjs';
import { asciiJson, capBytes, formatStartView } from '../../lib/startview.mjs';
import {
  KIT_ROOT, TODAY, exists, fixtureVault, plantSecret, readFile, removeTmpDirs, runCli, tmpDir, writeFile, writeJson,
} from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const VERSION = fs.readFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), 'utf8').trim();

/** Asserts that fn rejects with a MemoryError of this code; returns the error. */
async function rejectsWith(fn, code) {
  let caught = null;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `expected MemoryError ${code}, nothing was thrown`);
  assert.ok(caught instanceof MemoryError, `expected MemoryError ${code}, got ${caught?.stack ?? caught}`);
  assert.equal(caught.name, 'MemoryError');
  assert.equal(caught.code, code, caught.message);
  assert.ok(caught.message.length > 0);
  return caught;
}

const editJson = (root, rel, fn) => {
  const json = JSON.parse(readFile(root, rel));
  fn(json);
  writeJson(root, rel, json);
};

const inboxFiles = (root, dir = 'inbox') => fs.readdirSync(path.join(root, dir)).sort();

// ---------------------------------------------------------------------------------------------

describe('openMemory and info', () => {
  test('info of an English and a Czech vault', async () => {
    for (const lang of ['en', 'cs']) {
      const fx = fixtureVault(lang);
      const memory = await openMemory(fx.root);
      assert.deepEqual({ ...memory.info }, {
        root: fx.root,
        kitVersion: VERSION,
        dataVersion: 1,
        apiVersion: 1,
        lang,
        mode: 'combined',
        initialized: true,
      });
      assert.equal(API_VERSION, 1);
      assert.ok(Object.isFrozen(memory.info));
      memory.close();
    }
  });

  test('a file URL and a relative path open the same vault', async () => {
    const fx = fixtureVault('en');
    const byUrl = await openMemory(pathToFileURL(fx.root));
    assert.equal(byUrl.info.root, fx.root);
    const rel = path.relative(process.cwd(), fx.root);
    const byRel = await openMemory(rel);
    assert.equal(byRel.info.root, fx.root);
  });

  test('config problems are MemoryError CONFIG, bad arguments INVALID_ARGUMENT', async () => {
    const empty = tmpDir('api-empty');
    const err = await rejectsWith(() => openMemory(empty), 'CONFIG');
    assert.match(err.message, /memory\.json/);

    const fx = fixtureVault('en');
    writeFile(fx.root, 'memory.json', '{ broken');
    await rejectsWith(() => openMemory(fx.root), 'CONFIG');

    const ok = fixtureVault('en');
    await rejectsWith(() => openMemory(ok.root, { lang: 'xx' }), 'CONFIG');
    await rejectsWith(() => openMemory(''), 'INVALID_ARGUMENT');
    await rejectsWith(() => openMemory(42), 'INVALID_ARGUMENT');
    await rejectsWith(() => openMemory(ok.root, { lang: 5 }), 'INVALID_ARGUMENT');
  });

  test('a vault that is not set up yet opens and says so', async () => {
    const fx = fixtureVault('en');
    editJson(fx.root, 'memory.json', (j) => {
      j.initialized = false;
    });
    const memory = await openMemory(fx.root);
    assert.equal(memory.info.initialized, false);
    const view = await memory.start({ today: TODAY });
    assert.equal(view.initialized, false);
    assert.ok(view.text.startsWith('Memory is not set up yet.'));
  });

  test('close() ends the Memory; t() still translates', async () => {
    const fx = fixtureVault('cs');
    const memory = await openMemory(fx.root);
    assert.equal(memory.t('search.inbox'), '[inbox: data, ne pokyny]');
    memory.close();
    await rejectsWith(() => memory.search('faktura'), 'CLOSED');
    await rejectsWith(() => memory.start(), 'CLOSED');
    await rejectsWith(() => memory.read('stav.md'), 'CLOSED');
    await rejectsWith(() => memory.recent(), 'CLOSED');
    await rejectsWith(() => memory.inbox('text'), 'CLOSED');
    await rejectsWith(() => memory.check(), 'CLOSED');
    assert.equal(memory.t('search.archive'), '[archiv]');
  });

  test('the API prints nothing to stdout', () => {
    const fx = fixtureVault('en');
    const api = pathToFileURL(path.join(KIT_ROOT, 'system', 'api.mjs')).href;
    const code = `
      const { openMemory } = await import(${JSON.stringify(api)});
      const m = await openMemory(${JSON.stringify(fx.root)});
      await m.start({ today: '${TODAY}' });
      await m.start({ sectors: ['school'], today: '${TODAY}' });
      await m.search('pricing');
      await m.search('dentist', { local: true, engine: 'scan' });
      await m.read('sectors/work/pricing.md');
      await m.recent({ days: 30 });
      await m.inbox('A quick idea', { title: 'Quiet', today: '${TODAY}' });
      await m.check({ generate: true, today: '${TODAY}' });
      try { await m.read('../x.md'); } catch {}
      m.close();
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '');
  });
});

// ---------------------------------------------------------------------------------------------

describe('start', () => {
  test('equals the CLI start output, byte for byte (en and cs, stale)', async () => {
    for (const lang of ['en', 'cs']) {
      const fx = fixtureVault(lang);
      const memory = await openMemory(fx.root);
      const view = await memory.start({ today: TODAY });
      const cli = runCli(fx.root, ['start', '--today', TODAY]);
      assert.equal(cli.code, 0);
      assert.equal(view.text, cli.stdout);
      assert.equal(view.stale, true, 'no _ai/ yet: rendered in memory');
      assert.equal(view.failed, false);
      assert.equal(view.initialized, true);
      assert.ok(view.text.trimEnd().endsWith('(_ai/ is stale: this view was rendered on the fly; the next commit regenerates it)') || lang === 'cs');
    }
  });

  test('a fresh _ai/start.md is returned as committed', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const res = await memory.check({ generate: true, today: TODAY });
    assert.ok(res.generated.written > 0);
    const view = await memory.start({ today: TODAY });
    assert.equal(view.stale, false);
    assert.equal(view.text, readFile(fx.root, '_ai/start.md'));
    assert.ok(Buffer.byteLength(view.text) <= 9500);
  });

  test('sectors narrow the view and render in memory (array or a,b text)', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    for (const sectors of [['school'], 'school']) {
      const view = await memory.start({ sectors, today: TODAY });
      assert.ok(view.text.includes('| school |'));
      assert.ok(!view.text.includes('| work |'));
      assert.equal(view.stale, false);
    }
    const cli = runCli(fx.root, ['start', '--sectors', 'school,work', '--today', TODAY]);
    assert.equal((await memory.start({ sectors: ['school', 'work'], today: TODAY })).text, cli.stdout);
  });

  test('bad options are INVALID_ARGUMENT', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    await rejectsWith(() => memory.start({ today: '2026-02-30' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.start({ sectors: 5 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.start({ sectors: ['a', 2] }), 'INVALID_ARGUMENT');
    const err = await rejectsWith(() => memory.start({ surface: 'web' }), 'INVALID_ARGUMENT');
    assert.equal(err.message, 'surface must be cli or mcp, got "web"');
    await rejectsWith(() => memory.start({ surface: 1 }), 'INVALID_ARGUMENT');
  });

  test('surface mcp: the search rules of the tools replace the shell commands, even over a fresh _ai/start.md', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    await memory.check({ generate: true, today: TODAY });
    const cli = await memory.start({ today: TODAY });
    assert.equal(cli.text, readFile(fx.root, '_ai/start.md'));
    assert.deepEqual(await memory.start({ today: TODAY, surface: 'cli' }), cli);
    const mcp = await memory.start({ today: TODAY, surface: 'mcp' });
    assert.equal(mcp.stale, false, '_ai/ is fresh; the view is only rendered differently');
    assert.equal(mcp.failed, false);
    assert.ok(cli.text.includes('node system/memory.mjs search'));
    assert.ok(!mcp.text.includes('node system/memory.mjs search') && !mcp.text.includes('rg -i'), mcp.text);
    assert.ok(mcp.text.includes('## How to search\n1. First `memory_search` with the key words'), mcp.text);
    assert.ok(mcp.text.includes('4. Valid = status active and the newer `updated`. Follow `replaced_by` to the valid version.'));
    assert.ok(mcp.text.includes('with `all: true`'));
    // Everything but the search rules is the same view.
    const cut = (text) => text.split('\n').slice(1).join('\n').replace(/## How to search\n[\s\S]*?\n\n/, '');
    assert.equal(cut(mcp.text), cut(cli.text));
    // The fallback of a broken view keeps the tool rules too.
    editJson(fx.root, 'memory.json', (j) => {
      j.budgets = { start_bytes: [10, 10] };
    });
    const broken = await (await openMemory(fx.root)).start({ today: TODAY, surface: 'mcp' });
    assert.equal(broken.failed, true);
    assert.ok(broken.text.includes('1. First `memory_search`') && !broken.text.includes('rg -i'), broken.text);
  });

  test('a view that cannot be built becomes the fallback, like the CLI', async () => {
    const fx = fixtureVault('en');
    editJson(fx.root, 'memory.json', (j) => {
      j.budgets = { start_bytes: [10, 10] };
    });
    const memory = await openMemory(fx.root);
    const view = await memory.start({ today: TODAY });
    assert.equal(view.failed, true);
    assert.match(view.text, /^# Memory: start\nmemory: start failed: /);
    assert.ok(view.text.includes('## How to search'));
    assert.equal(view.text, runCli(fx.root, ['start', '--today', TODAY]).stdout);
  });

  test('never touches git settings (the CLI start sets core.hooksPath)', { skip: !HAS_GIT }, async () => {
    const fx = fixtureVault('en');
    const home = tmpDir('api-git-home');
    fs.writeFileSync(path.join(home, 'gitconfig'), '');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => spawnSync('git', args, { cwd: fx.root, env, encoding: 'utf8', windowsHide: true });
    assert.equal(git('init', '-q').status, 0);
    writeFile(fx.root, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
    const memory = await openMemory(fx.root);
    await memory.start({ today: TODAY });
    assert.equal(git('config', '--get', 'core.hooksPath').stdout.trim(), '');
    const cli = runCli(fx.root, ['start', '--today', TODAY], { env: { GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(cli.code, 0);
    assert.equal(git('config', '--get', 'core.hooksPath').stdout.trim(), '.githooks');
  });
});

describe('start --format and the start view helpers', () => {
  let fx;
  before(() => {
    fx = fixtureVault('cs');
  });

  test('text is the default and equals --format text', () => {
    const plain = runCli(fx.root, ['start', '--today', TODAY]);
    const text = runCli(fx.root, ['start', '--format', 'text', '--today', TODAY]);
    assert.equal(text.code, 0);
    assert.equal(text.stdout, plain.stdout);
  });

  test('gemini-hook: one ASCII line with the view as additionalContext', () => {
    const plain = runCli(fx.root, ['start', '--today', TODAY]);
    const hook = runCli(fx.root, ['start', '--format', 'gemini-hook', '--today', TODAY]);
    assert.equal(hook.code, 0);
    assert.ok(hook.stdout.endsWith('}\n'));
    assert.equal(hook.stdout.trimEnd().split('\n').length, 1);
    assert.ok(/^[\x00-\x7f]*$/.test(hook.stdout), 'every non-ASCII character is escaped');
    assert.match(hook.stdout, /\\u00e1|\\u00ed|\\u011b/, 'Czech letters appear as \\uXXXX');
    const parsed = JSON.parse(hook.stdout);
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(parsed.hookSpecificOutput.additionalContext, plain.stdout);
  });

  test('json: {text, stale, initialized, failed}, pretty like every --json', async () => {
    const res = runCli(fx.root, ['start', '--format', 'json', '--today', TODAY]);
    assert.equal(res.code, 0);
    const parsed = JSON.parse(res.stdout);
    const memory = await openMemory(fx.root);
    assert.deepEqual(parsed, await memory.start({ today: TODAY }));
    assert.equal(res.stdout, `${JSON.stringify(parsed, null, 2)}\n`);
  });

  test('a failing view keeps the chosen format', () => {
    const v = fixtureVault('en');
    editJson(v.root, 'memory.json', (j) => {
      j.budgets = { start_bytes: [10, 10] };
    });
    const res = runCli(v.root, ['start', '--format', 'gemini-hook', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /memory: start failed: /);
  });

  test('an unknown format prints a usage error, nothing on stdout, and still exits 0', () => {
    const res = runCli(fx.root, ['start', '--format', 'yaml']);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /--format musí být text, gemini-hook nebo json, zadáno "yaml"/);
    assert.match(res.stderr, /usage: node system\/memory\.mjs start /);
  });

  test('asciiJson, formatStartView and capBytes', () => {
    const accents = `${String.fromCodePoint(0x10d)}${String.fromCodePoint(0x1f600)}`;
    const line = asciiJson({ a: accents, b: '"\n' });
    assert.ok(/^[\x00-\x7f]*$/.test(line));
    assert.equal(line, '{"a":"\\u010d\\ud83d\\ude00","b":"\\"\\n"}');
    assert.deepEqual(JSON.parse(line), { a: accents, b: '"\n' });
    const view = { text: 'x\n', stale: false, initialized: true, failed: false };
    assert.equal(formatStartView(view), 'x\n');
    assert.equal(formatStartView(view, 'text'), 'x\n');
    assert.deepEqual(JSON.parse(formatStartView(view, 'json')), view);
    assert.equal(capBytes('ab\ncd\nef\n', 6), 'ab\ncd\n');
    assert.equal(capBytes('ab\n', 100), 'ab\n');
  });
});

// ---------------------------------------------------------------------------------------------

describe('search', () => {
  let fx;
  let memory;
  before(async () => {
    fx = fixtureVault('en');
    memory = await openMemory(fx.root);
  });

  test('returns the QueryResult of search --json', async () => {
    for (const q of ['pricing', 'thesis supervisor', 'invoice numbering']) {
      const res = await memory.search(q, { n: 5, engine: 'scan' });
      const cli = runCli(fx.root, ['search', q, '--n', '5', '--engine', 'scan', '--json']);
      assert.equal(cli.code, 0, cli.stderr);
      assert.deepEqual(res, JSON.parse(cli.stdout), q);
    }
    const res = await memory.search('pricing');
    assert.ok(res.results.length > 0 && res.results.length <= 8);
    for (const key of ['query', 'terms', 'total', 'results', 'engine', 'notes', 'localHits']) assert.ok(key in res, key);
  });

  test('local notes are only counted unless local is true', async () => {
    const hidden = await memory.search('dentist', { engine: 'scan' });
    assert.ok(hidden.localHits >= 1);
    assert.ok(hidden.results.every((r) => !r.local));
    const shown = await memory.search('dentist', { local: true, engine: 'scan' });
    const local = shown.results.find((r) => r.local);
    assert.ok(local, JSON.stringify(shown.results));
    assert.equal(local.root, 'private');
    assert.equal(local.path, '../private/sectors/health/dentist-appointments.md');
    assert.equal(shown.localHits, 0);
  });

  test('filters: sector, type, status, all; sectors narrows the default scope', async () => {
    const work = await memory.search('pricing', { sector: 'work' });
    assert.ok(work.results.length > 0 && work.results.every((r) => r.sector === 'work'));
    const decisions = await memory.search('pricing', { type: 'decision' });
    assert.ok(decisions.results.length > 0 && decisions.results.every((r) => r.type === 'decision'));
    const any = await memory.search('pricing', { status: 'any', all: true, n: 50 });
    assert.ok(any.total >= work.total);
    const narrowed = await memory.search('thesis', { sectors: ['school'] });
    assert.ok(narrowed.results.length > 0 && narrowed.results.every((r) => r.sector === 'school'));
    const ignored = await memory.search('thesis', { sectors: ['nope'] });
    assert.deepEqual(ignored, await memory.search('thesis'));
    const text = await memory.search('thesis', { sectors: 'school' });
    assert.deepEqual(text, narrowed);
  });

  test('localized type and status values are accepted', async () => {
    const cs = fixtureVault('cs');
    const m = await openMemory(cs.root);
    const res = await m.search('balíčky', { type: 'rozhodnuti', status: 'aktivni' });
    assert.ok(res.results.length > 0, JSON.stringify(res));
    assert.ok(res.results.every((r) => r.type === 'decision' && r.status === 'active'));
  });

  test('bad options are INVALID_ARGUMENT, a missing engine ENGINE', async () => {
    await rejectsWith(() => memory.search(''), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('   '), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search(42), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { n: 0 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { n: 2.5 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { type: 'poem' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { status: 'maybe' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { sector: 'nope' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { engine: 'bogus' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.search('x', { all: 'yes' }), 'INVALID_ARGUMENT');
    const err = await rejectsWith(() => memory.search('x', { sector: 'nope' }), 'INVALID_ARGUMENT');
    assert.match(err.message, /school/);
  });

  test('a sector that only a local root holds is named only with local', async () => {
    const v = fixtureVault('en');
    writeFile(v.priv, 'sectors/divorce-lawyer/filing.md', '---\ntype: fact\nstatus: active\nupdated: 2026-09-10\ndescription: Court hearing date.\n---\n# Filing\n\nThe hearing is in October.\n');
    const m = await openMemory(v.root);
    const hidden = await rejectsWith(() => m.search('hearing', { sector: 'x' }), 'INVALID_ARGUMENT');
    assert.equal(hidden.message, 'unknown sector "x"; sectors: core, health, hobbies, school, work');
    await rejectsWith(() => m.search('hearing', { sector: 'divorce-lawyer' }), 'INVALID_ARGUMENT');
    assert.deepEqual(await m.search('hearing', { sectors: ['divorce-lawyer'] }), await m.search('hearing'), 'an unknown id narrows nothing');
    assert.equal((await m.search('hearing')).localHits, 1);
    const shown = await rejectsWith(() => m.search('hearing', { sector: 'x', local: true }), 'INVALID_ARGUMENT');
    assert.equal(shown.message, 'unknown sector "x"; sectors: core, divorce-lawyer, health, hobbies, school, work');
    const found = await m.search('hearing', { sector: 'divorce-lawyer', local: true });
    assert.deepEqual(found.results.map((r) => r.rel), ['sectors/divorce-lawyer/filing.md']);
  });

  test('private content left in a local sector\'s main-root folder is only counted, never listed or logged', async () => {
    const v = fixtureVault('en');
    editJson(v.root, 'memory.json', (j) => {
      j.search = { log: true, n: 5 };
    });
    writeFile(v.root, 'sectors/health/leaked-notes.md', '---\ntype: fact\nstatus: active\nupdated: 2026-09-18\ndescription: Diagnosed with chronic migraine.\n---\n# Leaked\n\nNeurologist confirmed the migraine.\n');
    writeFile(v.root, 'archive/sectors/health/old-leak.md', '---\ntype: fact\nstatus: done\nupdated: 2026-01-10\ndescription: Old insulin dose.\n---\n# Old leak\n\ninsulin 10 units\n');
    const m = await openMemory(v.root);
    const hidden = await m.search('migraine', { log: true, today: TODAY });
    assert.deepEqual(hidden.results, []);
    assert.equal(hidden.localHits, 1);
    const archived = await m.search('insulin', { all: true });
    assert.deepEqual(archived.results, []);
    assert.equal(archived.localHits, 1);
    // With local they are still not listed: read() never opens them, so a result could not be read.
    for (const q of ['migraine', 'insulin']) {
      const shown = await m.search(q, { all: true, local: true, log: true, today: TODAY });
      assert.ok(!shown.results.some((r) => /leak/.test(r.rel)), JSON.stringify(shown.results));
    }
    await rejectsWith(() => m.read('sectors/health/leaked-notes.md', { local: true }), 'NOT_FOUND');
    const log = readFile(v.root, 'system/usage/search.log');
    assert.equal(log.split('\n').filter(Boolean).length, 3);
    assert.ok(!log.includes('leak'), log);
    // The start view leaves them out (the LOCAL_IN_GIT alert names the path only), also when a
    // fresh _ai/start.md exists.
    for (const generate of [false, true]) {
      if (generate) await m.check({ generate: true });
      for (const opts of [{}, { sectors: ['health'] }, { surface: 'mcp' }]) {
        const view = await m.start(opts);
        assert.equal(view.failed, false);
        for (const text of ['Diagnosed with chronic', 'Old insulin dose', '- sectors/health/leaked-notes.md']) {
          assert.ok(!view.text.includes(text), `${generate} ${JSON.stringify(opts)}: ${text}`);
        }
      }
    }
    assert.ok((await m.start()).text.includes('- LOCAL_IN_GIT sectors/health/leaked-notes.md'));
    assert.equal((await m.start()).text, runCli(v.root, ['start']).stdout, 'the CLI start is the same view');
  });

  test('localValue: the vault language\'s words for canonical values', async () => {
    const cs = await openMemory(fixtureVault('cs').root);
    assert.equal(cs.localValue('type', 'decision'), 'rozhodnuti');
    assert.equal(cs.localValue('status', 'active'), 'aktivni');
    assert.equal(cs.localValue('privacy', 'local'), 'lokal');
    assert.equal(cs.localValue('type', 'poem'), 'poem');
    assert.equal(cs.localValue('type', 'constructor'), 'constructor');
    assert.equal(cs.localValue('status', null), null);
    assert.equal(cs.localValue('nope', 'active'), 'active');
    assert.equal(memory.localValue('type', 'decision'), 'decision');
  });

  test('log appends to the search log only when memory.json turns it on', async () => {
    const v = fixtureVault('en');
    const m = await openMemory(v.root);
    await m.search('dentist', { log: true, today: TODAY });
    assert.equal(exists(v.root, 'system/usage/search.log'), false, 'search.log is off');
    editJson(v.root, 'memory.json', (j) => {
      j.search = { log: true, n: 5 };
    });
    const on = await openMemory(v.root);
    await on.search('pricing');
    assert.equal(exists(v.root, 'system/usage/search.log'), false, 'no log without log: true');
    const res = await on.search('dentist', { log: true, local: true, today: TODAY });
    const line = readFile(v.root, 'system/usage/search.log');
    assert.ok(line.startsWith(`${TODAY}\tdentist\t${res.total}\t`), line);
    assert.ok(!line.includes('dentist-appointments'), 'local notes are never named in the log');
  });

  test('a long-lived Memory sees notes written after it was opened', async () => {
    const v = fixtureVault('en');
    const m = await openMemory(v.root);
    assert.equal((await m.search('zeppelin')).total, 0);
    writeFile(v.root, 'sectors/work/zeppelin-tour.md', [
      '---', 'type: fact', 'status: active', 'description: A zeppelin tour for the team.', `updated: ${TODAY}`, '---',
      '# Zeppelin tour', '', 'Booked a zeppelin tour.', '',
    ].join('\n'));
    assert.equal((await m.search('zeppelin')).results[0].rel, 'sectors/work/zeppelin-tour.md');
  });
});

// ---------------------------------------------------------------------------------------------

describe('read', () => {
  let fx;
  let memory;
  before(async () => {
    fx = fixtureVault('en');
    memory = await openMemory(fx.root);
  });

  test('a whole note, a page of it and the continuation offset', async () => {
    const text = readFile(fx.root, 'sectors/work/pricing.md');
    const whole = await memory.read('sectors/work/pricing.md');
    assert.deepEqual(whole, {
      path: 'sectors/work/pricing.md', root: 'main', from: 1, to: 16, total: 16,
      text: text.replace(/\n$/, ''), truncated: false, next: null, nextColumn: null, inbox: false,
    });
    const page = await memory.read('sectors/work/pricing.md', { offset: 3, lines: 2 });
    assert.equal(page.from, 3);
    assert.equal(page.to, 4);
    assert.equal(page.next, 5);
    assert.equal(page.text, text.split('\n').slice(2, 4).join('\n'));
    const tail = await memory.read('sectors/work/pricing.md', { offset: 16, lines: 50 });
    assert.equal(tail.to, 16);
    assert.equal(tail.next, null);
  });

  test('maxChars cuts at a line boundary; a single long line is cut too and continues with column', async () => {
    const cut = await memory.read('sectors/work/pricing.md', { maxChars: 60 });
    assert.equal(cut.truncated, true);
    assert.ok(cut.text.length <= 60);
    assert.equal(cut.next, cut.to + 1);
    assert.equal(cut.nextColumn, null, 'cut at a line boundary');
    assert.equal(cut.text, readFile(fx.root, 'sectors/work/pricing.md').split('\n').slice(0, cut.to).join('\n'));
    const line = 'word '.repeat(100).trim();
    writeFile(fx.root, 'sectors/work/long-line-note.md', `${line}\nsecond\n`);
    const long = await memory.read('sectors/work/long-line-note.md', { maxChars: 50 });
    assert.equal(long.text.length, 50);
    assert.equal(long.from, 1);
    assert.equal(long.to, 1);
    assert.equal(long.truncated, true);
    assert.equal(long.next, 2);
    assert.equal(long.nextColumn, 51);
    // Paging with column returns the whole line, then the following lines.
    const parts = [long.text];
    let page = long;
    while (page.nextColumn !== null) {
      page = await memory.read('sectors/work/long-line-note.md', { offset: page.to, column: page.nextColumn, maxChars: 50 });
      parts.push(page.text);
    }
    assert.equal(parts.join(''), line);
    assert.equal(page.nextColumn, null);
    assert.equal(page.next, 2);
    const rest = await memory.read('sectors/work/long-line-note.md', { column: 496 });
    assert.deepEqual([rest.text, rest.from, rest.to, rest.nextColumn], ['word\nsecond', 1, 2, null]);
    // Characters are code points, never half a surrogate pair.
    writeFile(fx.root, 'sectors/work/emoji-note.md', `${'\u{1F600}'.repeat(5)}\n`);
    const emoji = await memory.read('sectors/work/emoji-note.md', { column: 3, maxChars: 2 });
    assert.deepEqual([emoji.text, emoji.nextColumn], ['\u{1F600}\u{1F600}', 5]);
    assert.equal((await memory.read('sectors/work/emoji-note.md', { column: 6 })).text, '', 'the column after the end is empty');
    const past = await rejectsWith(() => memory.read('sectors/work/emoji-note.md', { column: 7 }), 'INVALID_ARGUMENT');
    assert.equal(past.message, 'column 7 is past the end of line 1 of sectors/work/emoji-note.md (5 characters)');
    await rejectsWith(() => memory.read('sectors/work/emoji-note.md', { column: 0 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.read('sectors/work/emoji-note.md', { column: '2' }), 'INVALID_ARGUMENT');
  });

  test('CRLF, BOM, an empty file, the inbox flag, root files', async () => {
    writeFile(fx.root, 'sectors/work/crlf-note.md', '\uFEFFline one\r\nline two\r\n');
    const crlf = await memory.read('sectors/work/crlf-note.md');
    assert.equal(crlf.text, 'line one\nline two');
    assert.equal(crlf.total, 2);
    writeFile(fx.root, 'sectors/work/empty-note.md', '');
    assert.deepEqual(await memory.read('sectors/work/empty-note.md'), {
      path: 'sectors/work/empty-note.md', root: 'main', from: 1, to: 0, total: 0, text: '', truncated: false, next: null, nextColumn: null, inbox: false,
    });
    assert.equal((await memory.read('inbox/2026-09-19-pasted-email.md')).inbox, true);
    assert.ok((await memory.read('AGENTS.md')).total > 10);
    assert.equal((await memory.read('state.md')).path, 'state.md');
    assert.equal((await memory.read('sectors/health/_health.md')).root, 'main', 'a local sector\'s manifest is public');
    assert.equal((await memory.read('sectors/health/_health-export.md')).root, 'main');
  });

  test('path forms that are refused (INVALID_PATH)', async () => {
    const absolute = `${fx.root.split(path.sep).join('/')}/sectors/work/pricing.md`;
    const refused = [
      '', '   ', '/etc/passwd', absolute, 'C:/Windows/win.ini', 'c:notes.md', 'D:\\notes\\x.md',
      'sectors\\work\\pricing.md', './sectors/work/pricing.md', 'sectors//work/pricing.md', 'sectors/work/',
      '../private/sectors/health/running-plan.md', 'sectors/work/../work/pricing.md', 'sectors/../../x.md',
      '.git/config', '.git/HEAD.md', '.github/workflows/ci.md', '.memory-kit/upgrade/x.md',
      'system/tests/fixtures/en/vault/state.md', 'System/lib/x.md', 'SYSTEM/x.md', 'node_modules/x/readme.md',
      'memory.json', 'sectors/work/pricing', 'sectors/work/pricing.MD', 'con.md', 'sectors/work/a:b.md',
      `sectors/work/pri${String.fromCharCode(0)}cing.md`, `sectors/work/pri${String.fromCharCode(10)}cing.md`,
      'sectors/work/pricing.md.', 'file:///etc/passwd.md', '//server/share/x.md',
    ];
    for (const rel of refused) {
      await rejectsWith(() => memory.read(rel), 'INVALID_PATH').catch((err) => {
        throw new Error(`${JSON.stringify(rel)}: ${err.message}`);
      });
    }
    await rejectsWith(() => memory.read(42), 'INVALID_ARGUMENT');
  });

  test('missing, wrong letter case, local and linked-away notes are NOT_FOUND', async () => {
    await rejectsWith(() => memory.read('sectors/work/nope.md'), 'NOT_FOUND');
    await rejectsWith(() => memory.read('Sectors/work/pricing.md'), 'NOT_FOUND');
    await rejectsWith(() => memory.read('sectors/work/Pricing.md'), 'NOT_FOUND');
    // Only in the local root: hidden unless local.
    await rejectsWith(() => memory.read('sectors/health/running-plan.md'), 'NOT_FOUND');
    const local = await memory.read('sectors/health/running-plan.md', { local: true });
    assert.equal(local.root, 'private');
    assert.ok(local.text.length > 0);
    // The path search gives a local hit reads that note (with local only).
    const hit = (await memory.search('dentist appointments', { local: true })).results.find((r) => r.local);
    assert.equal(hit.path, '../private/sectors/health/dentist-appointments.md');
    const byPath = await memory.read(hit.path, { local: true });
    assert.equal(byPath.root, 'private');
    assert.equal(byPath.path, hit.path);
    assert.equal(byPath.text, (await memory.read(hit.rel, { local: true })).text);
    await rejectsWith(() => memory.read(hit.path), 'INVALID_PATH');
    await rejectsWith(() => memory.read('../private/sectors/health/nope.md', { local: true }), 'NOT_FOUND');
    for (const rel of ['../private/../private/sectors/health/running-plan.md', '../private/sectors/../../x.md', '../private/.git/x.md', '../privat/sectors/health/running-plan.md']) {
      await rejectsWith(() => memory.read(rel, { local: true }), 'INVALID_PATH');
    }
    // Private content left in the main root's folder of a local sector stays closed.
    writeFile(fx.root, 'sectors/health/leaked-notes.md', '# Leaked\n');
    writeFile(fx.root, 'archive/sectors/health/old-leak.md', '# Old leak\n');
    await rejectsWith(() => memory.read('sectors/health/leaked-notes.md'), 'NOT_FOUND');
    await rejectsWith(() => memory.read('sectors/health/leaked-notes.md', { local: true }), 'NOT_FOUND');
    await rejectsWith(() => memory.read('archive/sectors/health/old-leak.md'), 'NOT_FOUND');
    // A folder name is not a note.
    fs.mkdirSync(path.join(fx.root, 'sectors', 'work', 'folder.md'), { recursive: true });
    await rejectsWith(() => memory.read('sectors/work/folder.md'), 'NOT_FOUND');
  });

  test('links that lead out of the vault or into system/ are NOT_FOUND', async (t) => {
    const outside = path.join(fx.priv, 'sectors', 'health', 'running-plan.md');
    const inside = path.join(fx.root, 'system', 'templates', 'en', 'notes', 'fact.md');
    try {
      fs.symlinkSync(outside, path.join(fx.root, 'sectors', 'work', 'link-out.md'));
      fs.symlinkSync(inside, path.join(fx.root, 'sectors', 'work', 'link-system.md'));
      fs.symlinkSync(path.join(fx.root, 'sectors', 'work', 'pricing.md'), path.join(fx.root, 'sectors', 'work', 'link-in.md'));
    } catch (err) {
      t.skip(`symlinks are not available here: ${err.code}`);
      return;
    }
    await rejectsWith(() => memory.read('sectors/work/link-out.md'), 'NOT_FOUND');
    await rejectsWith(() => memory.read('sectors/work/link-out.md', { local: true }), 'NOT_FOUND');
    await rejectsWith(() => memory.read('sectors/work/link-system.md'), 'NOT_FOUND');
    assert.equal((await memory.read('sectors/work/link-in.md')).total, 16, 'a link inside the vault is fine');
  });

  test('bad offsets and page sizes', async () => {
    await rejectsWith(() => memory.read('sectors/work/pricing.md', { offset: 17 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.read('sectors/work/pricing.md', { offset: 0 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.read('sectors/work/pricing.md', { lines: 0 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.read('sectors/work/pricing.md', { lines: '5' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.read('sectors/work/pricing.md', { local: 1 }), 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------

describe('recent', () => {
  let fx;
  let memory;
  before(async () => {
    fx = fixtureVault('en');
    memory = await openMemory(fx.root);
  });

  test('newest first, within the days before the as-of date, notes only', async () => {
    const notes = await memory.recent({ today: TODAY });
    assert.ok(notes.length > 0);
    for (const n of notes) {
      assert.deepEqual(Object.keys(n), ['path', 'type', 'status', 'updated', 'description', 'sector']);
      assert.ok(n.updated >= '2026-09-13', `${n.path} ${n.updated}`);
      assert.ok(!n.path.startsWith('inbox/') && !n.path.startsWith('archive/'), n.path);
      assert.ok(!path.posix.basename(n.path).startsWith('_'), n.path);
      assert.ok(!['state.md', 'waiting.md'].includes(n.path));
      assert.ok(!['replaced', 'rejected'].includes(n.status), n.path);
    }
    const sorted = [...notes].sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.path < b.path ? -1 : 1));
    assert.deepEqual(notes, sorted);
    assert.ok(notes.some((n) => n.path === 'sectors/work/website-redesign.md'));
    assert.ok(notes.some((n) => n.path.startsWith('journal/')));
  });

  test('days, limit, sector; without today the vault\'s own as-of date is used', async () => {
    const week = await memory.recent({ today: TODAY });
    const wide = await memory.recent({ days: 365, limit: 500, today: TODAY });
    assert.ok(wide.length > week.length);
    assert.equal((await memory.recent({ days: 365, limit: 3, today: TODAY })).length, 3);
    const none = await memory.recent({ days: 0, today: '2030-01-01' });
    assert.deepEqual(none, []);
    const school = await memory.recent({ sector: 'school', days: 365, today: TODAY });
    assert.ok(school.length > 0 && school.every((n) => n.path.startsWith('sectors/school/') && n.sector === 'school'));
    assert.deepEqual(await memory.recent({ sector: 'health', days: 365 }), [], 'a local sector has nothing in the main root');
    const asOf = await memory.recent({ days: 3 });
    assert.ok(asOf.every((n) => n.updated >= '2026-09-16'), 'as-of 2026-09-19 comes from the notes');
  });

  test('bad options are INVALID_ARGUMENT', async () => {
    await rejectsWith(() => memory.recent({ days: -1 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.recent({ days: 1.5 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.recent({ limit: 0 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.recent({ sector: 'nope' }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.recent({ today: 'yesterday' }), 'INVALID_ARGUMENT');
  });
});

// ---------------------------------------------------------------------------------------------

describe('inbox', () => {
  test('writes one new file with the date, a slug, created and source', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const before = inboxFiles(fx.root);
    const res = await memory.inbox('Idea: a loyalty card for bakery customers.\n\nStamps in the calendar.', {
      title: 'Loyalty card', source: 'a phone call', today: TODAY,
    });
    assert.deepEqual(res, { path: `inbox/${TODAY}-loyalty-card.md` });
    assert.deepEqual(inboxFiles(fx.root), [...before, `${TODAY}-loyalty-card.md`].sort());
    assert.equal(readFile(fx.root, res.path), [
      '---', `created: ${TODAY}`, 'source: a phone call', '---', '# Loyalty card', '',
      'Idea: a loyalty card for bakery customers.', '', 'Stamps in the calendar.', '',
    ].join('\n'));
    // Without a title the first words name the file; without a source there is no source key.
    const plain = await memory.inbox('Call the printer about the new menu cards and the price', { today: TODAY });
    assert.equal(plain.path, `inbox/${TODAY}-call-the-printer-about-the-new.md`);
    assert.equal(readFile(fx.root, plain.path), `---\ncreated: ${TODAY}\n---\nCall the printer about the new menu cards and the price\n`);
  });

  test('a Czech vault: localized keys, diacritics folded in the name', async () => {
    const fx = fixtureVault('cs');
    const memory = await openMemory(fx.root);
    const res = await memory.inbox('Razítka sbírat v kalendáři.', { title: 'Nápad: věrnostní karta', source: 'hovor', today: TODAY });
    assert.equal(res.path, `inbox/${TODAY}-napad-vernostni-karta.md`);
    assert.equal(readFile(fx.root, res.path), `---\ndatum: ${TODAY}\nzdroj: hovor\n---\n# Nápad: věrnostní karta\n\nRazítka sbírat v kalendáři.\n`);
  });

  test('never overwrites: an existing name gets -2, -3', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    writeFile(fx.root, `inbox/${TODAY}-same-title.md`, 'the owner\'s own text\n');
    const second = await memory.inbox('First copy', { title: 'Same title', today: TODAY });
    const third = await memory.inbox('Second copy', { title: 'Same title', today: TODAY });
    assert.equal(second.path, `inbox/${TODAY}-same-title-2.md`);
    assert.equal(third.path, `inbox/${TODAY}-same-title-3.md`);
    assert.equal(readFile(fx.root, `inbox/${TODAY}-same-title.md`), 'the owner\'s own text\n');
    assert.ok(readFile(fx.root, second.path).includes('First copy'));
    assert.ok(readFile(fx.root, third.path).includes('Second copy'));
  });

  test('refuses secrets (also next to the allow marker), writes nothing', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const before = inboxFiles(fx.root);
    const { github, aws } = plantSecret();
    const allow = `memory-kit:${'allow-secret'}`;
    for (const text of [`token ${github}`, `key ${aws} ${allow}`]) {
      const err = await rejectsWith(() => memory.inbox(text, { today: TODAY }), 'SECRET');
      assert.ok(!err.message.includes(github) && !err.message.includes(aws), 'the secret is never echoed');
    }
    await rejectsWith(() => memory.inbox('fine text', { title: `x ${github}`, today: TODAY }), 'SECRET');
    await rejectsWith(() => memory.inbox('fine text', { source: github, today: TODAY }), 'SECRET');
    assert.deepEqual(inboxFiles(fx.root), before);
  });

  test('limits, empty text and control characters', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const before = inboxFiles(fx.root);
    await rejectsWith(() => memory.inbox('x'.repeat(INBOX_MAX_CHARS + 1), { today: TODAY }), 'TOO_LARGE');
    await rejectsWith(() => memory.inbox('ok', { title: 't'.repeat(201), today: TODAY }), 'TOO_LARGE');
    await rejectsWith(() => memory.inbox('ok', { source: 's'.repeat(501), today: TODAY }), 'TOO_LARGE');
    await rejectsWith(() => memory.inbox('  \n\t ', { today: TODAY }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.inbox(42), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.inbox('ok', { title: 5 }), 'INVALID_ARGUMENT');
    await rejectsWith(() => memory.inbox('ok', { today: '2026-9-1' }), 'INVALID_ARGUMENT');
    assert.deepEqual(inboxFiles(fx.root), before);

    const max = await memory.inbox('y'.repeat(INBOX_MAX_CHARS), { today: TODAY });
    assert.ok(readFile(fx.root, max.path).includes('y'.repeat(INBOX_MAX_CHARS)));

    const c = (code) => String.fromCodePoint(code);
    const dirty = `a${c(0)}b${c(7)}c${c(0x1b)}d${c(0x202e)}e${c(0x2066)}f${c(0xfeff)}g\r\nnext\rline${c(0x2028)}end\t!`;
    const res = await memory.inbox(dirty, { title: `Two${c(10)}lines${c(0)}`, source: `a${c(13)}${c(10)}b`, today: TODAY });
    assert.equal(res.path, `inbox/${TODAY}-two-lines.md`);
    assert.equal(readFile(fx.root, res.path), `---\ncreated: ${TODAY}\nsource: a b\n---\n# Two lines\n\nabcdefg\nnext\nline\nend\t!\n`);
    const symbols = await memory.inbox('*** !!! ***', { today: TODAY });
    assert.equal(symbols.path, `inbox/${TODAY}-capture.md`);
  });

  test('a capture keeps the vault clean for check', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const before = await memory.check({ today: TODAY });
    const res = await memory.inbox('--- not frontmatter\n# heading\n[[missing-link]] text', { title: 'Odd text', source: 'test: "quotes"', today: TODAY });
    const after = await memory.check({ today: TODAY });
    const about = [...after.errors, ...after.warnings].filter((f) => f.rel === res.path);
    assert.deepEqual(about, []);
    assert.equal(after.errors.length, before.errors.length);
    const page = await memory.read(res.path);
    assert.equal(page.inbox, true);
    assert.match(page.text, /^---\ncreated: 2026-09-20\nsource: "test: \\"quotes\\""\n---\n# Odd text\n/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('check', () => {
  test('equals check --json, and generate works like check --generate', async () => {
    const fx = fixtureVault('en');
    const memory = await openMemory(fx.root);
    const cli = runCli(fx.root, ['check', '--json', '--today', TODAY]);
    assert.deepEqual(await memory.check({ today: TODAY }), JSON.parse(cli.stdout));
    const lenient = await memory.check({ strict: false, today: TODAY });
    assert.equal(lenient.mode, 'lenient');
    const gen = await memory.check({ generate: true, today: TODAY });
    assert.equal(gen.mode, 'strict');
    assert.ok(gen.generated.written > 0);
    assert.deepEqual(gen.errors, [], JSON.stringify(gen.errors));
    const again = JSON.parse(runCli(fx.root, ['check', '--json', '--today', TODAY]).stdout);
    assert.ok(![...again.errors, ...again.warnings].some((f) => f.code.startsWith('GEN_')));
    await rejectsWith(() => memory.check({ strict: 'no' }), 'INVALID_ARGUMENT');
  });

  test('generate normalizes CRLF notes and reports them', async () => {
    const fx = fixtureVault('en');
    const text = readFile(fx.root, 'sectors/work/pricing.md');
    writeFile(fx.root, 'sectors/work/pricing.md', text.replace(/\n/g, '\r\n'));
    const memory = await openMemory(fx.root);
    const res = await memory.check({ generate: true, today: TODAY });
    assert.deepEqual(res.normalized, [{ root: 'main', rel: 'sectors/work/pricing.md' }]);
    assert.equal(readFile(fx.root, 'sectors/work/pricing.md'), text);
  });
});
