// The activity log as a library (lib/activity.mjs): what an entry may hold (no query, no local
// note, no control characters from a client's name), when a line is written (a set-up vault with
// the log on, never in a probe run), that writing never throws, rotation, torn lines, the summary
// behind `activity`, and the agent marks of the environment.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ACTIVITY_OPS, ACTIVITY_REL, activityEntry, activityOn, agentFromEnv, localDay, logActivity, readActivity, summarizeActivity,
} from '../../lib/activity.mjs';
import { formatActivity } from '../../lib/commands/activity.mjs';
import { bareRoot, removeTmpDirs, tmpDir, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const NOW = new Date('2026-09-20T12:00:00.000Z');
const logOf = (root) => {
  try {
    return fs.readFileSync(path.join(root, ...ACTIVITY_REL.split('/')), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const minutesAgo = (n, now = NOW) => new Date(now.getTime() - n * 60000);
const at = (n, entry) => ({ ...activityEntry(entry, minutesAgo(n)) });

describe('an entry', () => {
  test('only known ways and uses; the time is added', () => {
    assert.equal(activityEntry({ via: 'web', op: 'search' }, NOW), null);
    assert.equal(activityEntry({ via: 'cli', op: 'delete' }, NOW), null);
    assert.equal(activityEntry(null, NOW), null);
    assert.deepEqual(activityEntry({ via: 'cli', op: 'start' }, NOW), { t: NOW.toISOString(), via: 'cli', op: 'start' });
    assert.deepEqual(ACTIVITY_OPS, ['start', 'search', 'read', 'recent', 'save', 'lookup']);
  });

  test('names at most 3 notes, and only vault-relative paths of the main root', () => {
    const e = activityEntry({
      via: 'mcp', op: 'search', n: 7,
      notes: ['../private/sectors/health/running-plan.md', '/etc/passwd', 'C:/x.md', 'a\\b.md', 'sectors/../x.md', './x.md', `sectors/x${String.fromCharCode(0x202e)}.md`,
        'sectors/work/pricing.md', 'inbox/2026-09-20-idea.md', 'sectors/core/profile.md', 'sectors/work/fourth.md'],
    }, NOW);
    assert.deepEqual(e.notes, ['sectors/work/pricing.md', 'inbox/2026-09-20-idea.md', 'sectors/core/profile.md']);
    assert.equal(e.n, 7);
    assert.equal(activityEntry({ via: 'cli', op: 'search', notes: ['../x.md'] }, NOW).notes, undefined, 'nothing named, no empty list');
  });

  test('a client name is one clipped line without control or bidi characters; counts are whole numbers', () => {
    const e = activityEntry({ via: 'mcp', op: 'start', agent: `evil\nclient${String.fromCharCode(0x202e)}\u0007 ${'x'.repeat(200)}`, n: -1, local: 2.5 }, NOW);
    assert.ok(!/[\u0000-\u001f\u202e]/.test(e.agent), JSON.stringify(e.agent));
    assert.ok(e.agent.startsWith('evil client'));
    assert.ok(e.agent.length <= 60);
    assert.equal(e.n, undefined);
    assert.equal(e.local, undefined);
    assert.equal(activityEntry({ via: 'cli', op: 'save', local: 0 }, NOW).local, undefined, 'zero local notes are not written');
    assert.equal(activityEntry({ via: 'cli', op: 'save', local: 1 }, NOW).local, 1);
  });

  test('a project is a sector id or nothing', () => {
    assert.equal(activityEntry({ via: 'hook', op: 'start', project: 'dev-2' }, NOW).project, 'dev-2');
    assert.equal(activityEntry({ via: 'hook', op: 'start', project: 'Harbor Shop' }, NOW).project, undefined);
    assert.equal(activityEntry({ via: 'hook', op: 'start', project: '../x' }, NOW).project, undefined);
  });
});

describe('writing', () => {
  test('a set-up vault gets one JSON line per use in .memory-kit/logs/activity.jsonl', () => {
    const root = bareRoot('en');
    assert.equal(logActivity(root, { via: 'cli', op: 'search', n: 2, notes: ['sectors/work/pricing.md'] }, { now: NOW, env: {} }), true);
    assert.equal(logActivity({ root, initialized: true, feedback: { log: true } }, { via: 'cli', op: 'start' }, { now: NOW, env: {} }), true);
    assert.deepEqual(logOf(root), [
      { t: NOW.toISOString(), via: 'cli', op: 'search', n: 2, notes: ['sectors/work/pricing.md'] },
      { t: NOW.toISOString(), via: 'cli', op: 'start' },
    ]);
  });

  test('nothing when the log is off, the vault is not set up, or the run is a probe', () => {
    const off = bareRoot('en', { feedback: { log: false } });
    assert.equal(logActivity(off, { via: 'cli', op: 'start' }, { env: {} }), false);
    const unset = bareRoot('en', { initialized: false });
    assert.equal(logActivity(unset, { via: 'cli', op: 'start' }, { env: {} }), false);
    const probed = bareRoot('en');
    assert.equal(logActivity(probed, { via: 'cli', op: 'start' }, { env: { MEMORY_KIT_PROBE: '1' } }), false);
    for (const root of [off, unset, probed]) assert.ok(!fs.existsSync(path.join(root, '.memory-kit')), root);
    assert.equal(activityOn({ initialized: true, feedback: { log: true } }), true);
    assert.equal(activityOn({ initialized: true, feedback: { log: false } }), false);
    assert.equal(activityOn({ initialized: false, feedback: { log: true } }), false);
    assert.equal(activityOn(path.join(tmpDir('none'), 'missing')), false, 'no memory.json: nothing');
  });

  test('never throws: a vault folder that cannot hold the log', () => {
    const root = bareRoot('en');
    fs.writeFileSync(path.join(root, '.memory-kit'), 'a file where the folder should be');
    assert.equal(logActivity(root, { via: 'cli', op: 'start' }, { env: {} }), false);
    assert.equal(logActivity(null, { via: 'cli', op: 'start' }, { env: {} }), false);
  });

  test('a full log becomes activity.1.jsonl; reading takes the old file first and skips torn lines', () => {
    const root = bareRoot('en');
    const file = path.join(root, ...ACTIVITY_REL.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = JSON.stringify(activityEntry({ via: 'cli', op: 'search', n: 1 }, minutesAgo(10)));
    fs.writeFileSync(file, `${old}\n${'x'.repeat(600 * 1024)}\n{"t":"torn`);
    assert.equal(logActivity(root, { via: 'cli', op: 'start' }, { now: NOW, env: {} }), true);
    assert.ok(fs.existsSync(file.replace(/\.jsonl$/, '.1.jsonl')));
    const entries = readActivity(root);
    assert.deepEqual(entries.map((e) => e.op), ['search', 'start']);
    fs.appendFileSync(file, '{"t":"2026-09-20T12:00:00.000Z","via":"cli","op":"delete"}\n{"via":"cli","op":"start"}\nnot json\n');
    assert.equal(readActivity(root).length, 2, 'unknown uses and lines without a time are skipped');
  });

  test('the first line of a vault that git does not ignore .memory-kit/ in puts it in .git/info/exclude', { skip: !HAS_GIT && 'git is missing' }, () => {
    const root = bareRoot('en');
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true }).status, 0);
    assert.equal(logActivity(root, { via: 'cli', op: 'start' }, { env: {} }), true);
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.ok(!status.stdout.includes('.memory-kit'), status.stdout);
    assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.memory-kit\/$/m);
  });
});

describe('the summary', () => {
  const entries = [
    at(60 * 24 * 9, { via: 'cli', op: 'search', agent: 'codex', n: 1, notes: ['sectors/old.md'] }),
    at(60 * 26, { via: 'mcp', op: 'read', agent: 'claude-ai', notes: ['sectors/work/pricing.md'] }),
    at(30, { via: 'hook', op: 'start', agent: 'claude-code', project: 'dev' }),
    at(20, { via: 'cli', op: 'search', agent: 'claude-code', n: 4, notes: ['sectors/work/pricing.md', 'sectors/core/profile.md'] }),
    at(10, { via: 'cli', op: 'save', agent: 'claude-code', notes: ['inbox/2026-09-20-idea.md'] }),
    at(5, { via: 'mcp', op: 'read', agent: 'claude-ai', local: 1 }),
    { ...activityEntry({ via: 'cli', op: 'start' }, new Date(NOW.getTime() + 3 * 3600000)) },
  ];

  test('today, the period, who, the notes used most and the latest uses', () => {
    const today = localDay(NOW);
    const s = summarizeActivity(entries, { now: NOW, days: 7 });
    assert.equal(s.entries, 7);
    assert.deepEqual([s.last.op, s.last.agent], ['read', 'claude-ai'], 'the newest entry that is not in the future');
    assert.equal(summarizeActivity(entries.slice(-1), { now: NOW }).last.op, 'start', 'only future entries: the newest of them');
    assert.deepEqual(s.period, { start: 1, search: 1, read: 2, recent: 0, save: 1, lookup: 0 });
    const expectedToday = entries.slice(0, 6).filter((e) => localDay(e.t) === today).length;
    assert.equal(Object.values(s.today).reduce((a, b) => a + b, 0), expectedToday, 'a use from the future is never counted');
    assert.deepEqual(s.who, [
      { agent: 'claude-ai', via: 'mcp', n: 2 },
      { agent: 'claude-code', via: 'cli', n: 2 },
      { agent: 'claude-code', via: 'hook', n: 1 },
    ], 'most first, ties by name and way');
    assert.deepEqual(s.notes, [
      { rel: 'sectors/work/pricing.md', n: 2 },
      { rel: 'inbox/2026-09-20-idea.md', n: 1 },
    ], 'reads, the first search hit and saves; never a note older than the period');
    assert.deepEqual(s.latest.map((e) => e.op), ['read', 'save', 'search', 'start', 'read']);
  });

  test('the report names each agent once: its CLI and hook uses together, an MCP app apart', () => {
    const report = {
      ...summarizeActivity(entries, { now: NOW, days: 7 }),
      log: { on: true, off: null, file: ACTIVITY_REL }, hooks: { last: null, failures: 0 },
    };
    const text = formatActivity({ t: (key) => key }, report, { now: NOW });
    assert.match(text, /^Who: Claude Code 3 · claude-ai \(MCP\) 2$/m);
    assert.match(text, /^Last use: 5 min ago · claude-ai \(MCP\) · note read · \+1 in local sectors$/m, 'never "just now" from a wrong clock');
  });

  test('the window follows --days', () => {
    assert.equal(summarizeActivity(entries, { now: NOW, days: 30 }).period.search, 2);
    assert.equal(summarizeActivity(entries, { now: NOW, days: 1 }).period.read, 1);
    assert.deepEqual(summarizeActivity([], { now: NOW }), {
      days: 7, entries: 0, last: null, today: { start: 0, search: 0, read: 0, recent: 0, save: 0, lookup: 0 },
      period: { start: 0, search: 0, read: 0, recent: 0, save: 0, lookup: 0 }, who: [], notes: [], latest: [],
    });
  });
});

describe('the agent of a CLI run', () => {
  test('from the marks agents leave in the environment of their commands', () => {
    assert.equal(agentFromEnv({ CLAUDECODE: '1' }), 'claude-code');
    assert.equal(agentFromEnv({ GEMINI_CLI: '1' }), 'gemini-cli');
    assert.equal(agentFromEnv({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
    assert.equal(agentFromEnv({ CODEX_SANDBOX_NETWORK_DISABLED: '1' }), 'codex');
    assert.equal(agentFromEnv({}), null);
    assert.equal(agentFromEnv({ CLAUDECODE: '0' }), null);
  });

  test('memory.json may carry the feedback block', () => {
    const root = bareRoot('en');
    writeJson(root, 'memory.json', { ...JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8')), feedback: { notice: false, log: true } });
    assert.equal(activityOn(root), true);
  });
});
