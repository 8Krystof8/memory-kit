// Visible feedback end to end, in both languages (docs/architecture.md, 10.4 and 10.10): the
// owner's line of `start --format claude-hook` (loaded, not set up, failed, turned off), a hook
// object that fits hook_bytes, the activity log lines of start, search, new and remember (no
// query, local notes only counted, the agent from the environment), and the `activity` report
// with its Czech aliases, its JSON and its switches.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACTIVITY_REL } from '../../lib/activity.mjs';
import { TODAY, fixtureVault, removeTmpDirs, runCli, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const LOADED = {
  en: /^memory-kit: memory loaded · (\d+) notes · (\d+) sectors$/,
  cs: /^memory-kit: paměť načtena · poznámky: (\d+) · sektory: (\d+)$/,
};
const ACTIVITY = { en: 'activity', cs: 'aktivita' };

const logOf = (root) => {
  try {
    return fs.readFileSync(path.join(root, ...ACTIVITY_REL.split('/')), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const logText = (root) => {
  try {
    return fs.readFileSync(path.join(root, ...ACTIVITY_REL.split('/')), 'utf8');
  } catch {
    return '';
  }
};
function editConfig(root, edit) {
  const file = path.join(root, 'memory.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(j);
  writeJson(root, 'memory.json', j);
}

describe('the owner\'s line at a session start (start --format claude-hook)', () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: the memory loaded, with its size; the view is the plain start view`, () => {
      const v = fixtureVault(lang);
      const plain = runCli(v.root, ['start', '--today', TODAY]);
      const hook = runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]);
      assert.equal(hook.code, 0, hook.stderr);
      assert.equal(hook.stdout.trimEnd().split('\n').length, 1, 'one line');
      const out = JSON.parse(hook.stdout);
      assert.deepEqual(Object.keys(out), ['systemMessage', 'hookSpecificOutput']);
      const m = LOADED[lang].exec(out.systemMessage);
      assert.ok(m, out.systemMessage);
      assert.match(plain.stdout, new RegExp(`\\n${m[1]} [^\\n]* ${m[2]} `), 'the same numbers as the view\'s summary line');
      assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'SessionStart', additionalContext: plain.stdout });
    });
  }

  test('feedback.notice false: the plain view, as before 0.1.3', () => {
    const v = fixtureVault('en');
    editConfig(v.root, (j) => { j.feedback = { notice: false }; });
    const plain = runCli(v.root, ['start', '--today', TODAY]);
    const hook = runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]);
    assert.equal(hook.stdout, plain.stdout);
  });

  test('a view that failed: the error and doctor, and the fallback still reaches the agent', () => {
    const v = fixtureVault('en');
    editConfig(v.root, (j) => { j.budgets = { start_bytes: [10, 10] }; });
    const out = JSON.parse(runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]).stdout);
    assert.match(out.systemMessage, /^memory-kit: the memory did not load \(.*budget.*\); the agent got only the search rules\. Run: node system\/memory\.mjs doctor$/);
    assert.match(out.hookSpecificOutput.additionalContext, /memory: start failed: /);
  });

  test('a memory not set up yet says so and records nothing', () => {
    const v = fixtureVault('en');
    editConfig(v.root, (j) => { j.initialized = false; });
    const out = JSON.parse(runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]).stdout);
    assert.equal(out.systemMessage, 'memory-kit: this memory is not set up yet; to use it, ask the agent to "set up memory"');
    runCli(v.root, ['search', 'pricing']);
    assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit')), 'nothing recorded');
  });

  test('the whole hook object fits hook_bytes, the view cut at a line boundary', () => {
    const v = fixtureVault('cs');
    editConfig(v.root, (j) => { j.budgets = { hook_bytes: 2500 }; });
    const plain = runCli(v.root, ['start', '--today', TODAY]).stdout;
    const hook = runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]).stdout;
    assert.ok(Buffer.byteLength(hook) <= 2500, `${Buffer.byteLength(hook)} bytes`);
    const context = JSON.parse(hook).hookSpecificOutput.additionalContext;
    assert.ok(context.length > 500 && plain.startsWith(context) && context.endsWith('\n'), context);
  });
});

describe('the activity log of the CLI', () => {
  test('start and search: one line each, the agent from the environment, never the query', () => {
    const v = fixtureVault('en');
    runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]);
    runCli(v.root, ['search', 'harbor', 'pricing'], { env: { CLAUDECODE: '1' } });
    runCli(v.root, ['search', 'zzzqqq xxyyww']);
    const [start, search, none] = logOf(v.root);
    assert.deepEqual([start.via, start.op, start.agent], ['cli', 'start', 'claude-code']);
    assert.deepEqual([search.via, search.op, search.agent], ['cli', 'search', 'claude-code']);
    assert.ok(search.n >= 1 && search.notes.length >= 1 && search.notes.length <= 3, JSON.stringify(search));
    assert.ok(search.notes.every((rel) => fs.existsSync(path.join(v.root, ...rel.split('/')))), 'vault-relative paths');
    assert.deepEqual(none, { t: none.t, via: 'cli', op: 'search', n: 0 }, 'no agent without its mark');
    assert.ok(!/harbor|zzzqqq/i.test(logText(v.root).replace(/"notes":\[[^\]]*\]/g, '')), 'the query is never written');
  });

  test('a local note is counted, never named, even with --local', () => {
    const v = fixtureVault('en');
    runCli(v.root, ['search', 'running', 'plan', '--local']);
    runCli(v.root, ['search', 'running', 'plan']);
    const [shown, hidden] = logOf(v.root);
    assert.ok(shown.local >= 1 && hidden.local >= 1, JSON.stringify([shown, hidden]));
    assert.ok(!logText(v.root).includes('running-plan'), logText(v.root));
  });

  test('new and remember: a save with the note they wrote', () => {
    const v = fixtureVault('en');
    const made0 = runCli(v.root, ['new', 'fact', 'work/harbor-delivery-days', '--description', 'Delivery days of Harbor Bakery.', '--force']);
    assert.equal(made0.code, 0, made0.stdout);
    assert.equal(runCli(v.root, ['remember', 'ask Harbor Bakery about Sunday deliveries']).code, 0);
    const [made, remembered] = logOf(v.root);
    assert.deepEqual([made.op, made.notes], ['save', ['sectors/work/harbor-delivery-days.md']]);
    assert.equal(remembered.op, 'save');
    assert.match(remembered.notes[0], /^inbox\/\d{4}-\d{2}-\d{2}-ask-harbor-bakery-about-sunday-deliveries\.md$/);
  });

  test('feedback.log false: nothing is recorded, and activity says the log is off', () => {
    const v = fixtureVault('en');
    editConfig(v.root, (j) => { j.feedback = { log: false }; });
    runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]);
    runCli(v.root, ['search', 'pricing']);
    assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit')));
    const res = runCli(v.root, ['activity']);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /The activity log is off/);
    assert.doesNotMatch(res.stdout, /doctor|The log stays on this computer/);
  });

  test('git never sees the log, also in a vault whose .gitignore lacks the line', { skip: !HAS_GIT && 'git is missing' }, () => {
    const v = fixtureVault('en');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: v.root, windowsHide: true }).status, 0);
    runCli(v.root, ['search', 'pricing']);
    assert.equal(logOf(v.root).length, 1);
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: v.root, encoding: 'utf8', windowsHide: true });
    assert.ok(!status.stdout.includes('.memory-kit'), status.stdout);
  });
});

describe('activity', () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: the last use, the counts, who, the notes used most and the latest uses`, () => {
      const v = fixtureVault(lang);
      const empty = runCli(v.root, [ACTIVITY[lang]]);
      assert.equal(empty.code, 0, empty.stderr);
      assert.match(empty.stdout, lang === 'cs' ? /zatím není zaznamenané žádné použití/ : /No use of the memory is recorded on this computer yet\./);
      assert.match(empty.stdout, /node system\/memory\.mjs doctor/, 'where to look when nothing shows up');

      runCli(v.root, ['start', '--format', 'claude-hook', '--today', TODAY]);
      runCli(v.root, ['search', lang === 'cs' ? 'ceník' : 'pricing'], { env: { CLAUDECODE: '1' } });
      runCli(v.root, ['search', lang === 'cs' ? 'ceník' : 'pricing']);
      const top = logOf(v.root)[1].notes[0];
      const res = runCli(v.root, [ACTIVITY[lang], lang === 'cs' ? '--dny' : '--days', '3']);
      assert.equal(res.code, 0, res.stderr);
      const lines = res.stdout.trimEnd().split('\n');
      if (lang === 'en') {
        assert.equal(lines[0], 'Memory activity on this computer · last 3 days');
        assert.match(lines[1], /^Last use: (just now|\d+ min ago) · CLI · search · \d+ results · /);
        assert.equal(lines[2], 'Today: session starts 1 · searches 2');
        assert.equal(lines[3], 'Last 3 days: session starts 1 · searches 2');
        assert.equal(lines[4], 'Who: Claude Code 2 · CLI 1');
        assert.equal(lines[5], `Notes used most: ${top} 2`);
        assert.equal(lines[6], 'Latest:');
        assert.match(lines[9], /^- (just now|\d+ min ago) · Claude Code · session start$/);
        assert.match(lines.at(-3), /^Kit: \d+\.\d+\.\d+ · not checked for a newer one yet: node system\/memory\.mjs upgrade --check$/);
        assert.equal(lines.at(-2), 'New versions: no daily check ("updates": {"check": true} turns it on)');
        assert.match(lines.at(-1), /^The log stays on this computer \(\.memory-kit\/logs\/activity\.jsonl; never committed, no query text\)/);
      } else {
        assert.equal(lines[0], 'Aktivita paměti na tomto počítači · posledních 3 dní');
        assert.match(lines[1], /^Naposledy: (právě teď|před \d+ min) · CLI · hledání · výsledky: \d+ · /);
        assert.equal(lines[2], 'Dnes: starty relací 1 · hledání 2');
        assert.equal(lines[4], 'Kdo: Claude Code 2 · CLI 1');
        assert.equal(lines[5], `Nejpoužívanější poznámky: ${top} 2`);
        assert.equal(lines.at(-2), 'Nové verze: bez denní kontroly (zapne ji "updates": {"check": true})');
        assert.match(lines.at(-1), /^Záznam zůstává na tomto počítači/);
      }
    });
  }

  test('--json: the summary as data; a bad --days is a usage error', () => {
    const v = fixtureVault('en');
    runCli(v.root, ['search', 'pricing']);
    const res = runCli(v.root, ['activity', '--json']);
    assert.equal(res.code, 0, res.stderr);
    const j = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(j), ['days', 'entries', 'last', 'today', 'period', 'who', 'notes', 'latest', 'log', 'hooks', 'updates']);
    assert.deepEqual(Object.keys(j.updates), ['installed', 'latest', 'checked', 'available', 'channels']);
    assert.deepEqual(j.updates.channels, { github: 'none', check: false });
    assert.equal(j.days, 7);
    assert.equal(j.period.search, 1);
    assert.deepEqual(j.log, { on: true, off: null, file: '.memory-kit/logs/activity.jsonl' });
    assert.deepEqual(j.hooks, { last: null, failures: 0 });
    for (const bad of ['0', '366', 'week']) {
      const r = runCli(v.root, ['activity', '--days', bad]);
      assert.equal(r.code, 2, bad);
      assert.match(r.stderr, /--days must be a whole number from 1 to 365/);
    }
  });

  test('a vault that is not set up records nothing and says why', () => {
    const v = fixtureVault('en');
    editConfig(v.root, (j) => { j.initialized = false; });
    const res = runCli(v.root, ['activity']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /This memory is not set up yet \(memory\.json "initialized": false\), so nothing is recorded\./);
  });
});
