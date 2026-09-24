// util.mjs: canonical tables, clock-free date arithmetic, text measures, files and git
// (docs/architecture.md, sections 1.2, 1.3 and 7.1).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as util from '../../lib/util.mjs';
import { removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

describe('canonical tables', () => {
  test('types follow table 4.4 order', () => {
    assert.deepEqual(util.CANON_TYPES, [
      'decision', 'rule', 'procedure', 'fact', 'insight', 'project', 'proposal', 'analysis',
      'text', 'list', 'person', 'organization', 'journal', 'sector', 'hub',
    ]);
  });

  test('one status list for every type', () => {
    assert.deepEqual(util.CANON_STATUSES, ['active', 'waiting', 'done', 'replaced', 'rejected']);
  });

  test('atomic types', () => {
    assert.deepEqual(util.ATOMIC_TYPES, ['decision', 'fact', 'insight']);
  });
});

describe('dates', () => {
  test('isDate accepts only real calendar days as YYYY-MM-DD', () => {
    for (const ok of ['2026-09-23', '2028-02-29', '2000-02-29', '1970-01-01', '2026-12-31']) {
      assert.equal(util.isDate(ok), true, ok);
    }
    for (const bad of ['2026-02-29', '1900-02-29', '2026-13-01', '2026-00-10', '2026-09-31', '2026-9-01',
      '26-09-01', '2026-09-01T00:00', ' 2026-09-01', '', null, undefined, 20260901]) {
      assert.equal(util.isDate(bad), false, String(bad));
    }
  });

  test('daysBetween counts whole days from a to b in UTC', () => {
    assert.equal(util.daysBetween('2026-09-01', '2026-09-20'), 19);
    assert.equal(util.daysBetween('2026-09-20', '2026-09-01'), -19);
    assert.equal(util.daysBetween('2026-09-20', '2026-09-20'), 0);
    assert.equal(util.daysBetween('2026-12-31', '2027-01-01'), 1);
    assert.equal(util.daysBetween('2028-02-28', '2028-03-01'), 2);
    // Daylight saving changes never produce fractions.
    assert.equal(util.daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(util.daysBetween('2026-10-24', '2026-10-26'), 2);
  });

  test('addDays', () => {
    assert.equal(util.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(util.addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(util.addDays('2026-09-20', 0), '2026-09-20');
    assert.equal(util.addDays('2026-09-20', -14), '2026-09-06');
  });

  test('todayLocal returns a real date', () => {
    assert.equal(util.isDate(util.todayLocal()), true);
  });
});

describe('text measures', () => {
  test('chars counts code points, bytes counts UTF-8', () => {
    assert.equal(util.chars('práce'), 5);
    assert.equal(util.bytes('práce'), 6);
    assert.equal(util.chars('a😀b'), 3);
    assert.equal(util.bytes('a😀b'), 6);
    assert.equal(util.chars(''), 0);
  });

  test('truncate cuts by code points and marks the cut with an ellipsis', () => {
    assert.equal(util.truncate('short', 10), 'short');
    assert.equal(util.truncate('exactly10!', 10), 'exactly10!');
    const cut = util.truncate('Příliš žluťoučký kůň úpěl ďábelské ódy', 12);
    assert.ok(cut.endsWith('…'), cut);
    assert.ok(util.chars(cut) <= 12, cut);
    assert.ok('Příliš žluťoučký kůň'.startsWith(cut.slice(0, -1).trimEnd()), cut);
    const emoji = util.truncate('😀😀😀😀😀😀', 4);
    assert.ok(util.chars(emoji) <= 4 && emoji.endsWith('…'));
    assert.ok(!emoji.includes('\uFFFD'), 'never splits a surrogate pair');
  });

  test('cmp compares code units, never locale', () => {
    const words = ['b', 'a', 'B', 'č', 'z', 'A', '_x', '2'];
    assert.deepEqual([...words].sort(util.cmp), ['2', 'A', 'B', '_x', 'a', 'b', 'z', 'č']);
    assert.equal(util.cmp('x', 'x'), 0);
    assert.ok(util.cmp('a', 'b') < 0 && util.cmp('b', 'a') > 0);
  });

  test('toPosix', () => {
    assert.equal(util.toPosix(['a', 'b', 'c.md'].join(path.sep)), 'a/b/c.md');
  });
});

describe('files', () => {
  test('readText normalizes CRLF and a BOM and reports both', () => {
    const dir = tmpDir('util');
    const file = path.join(dir, 'crlf.md');
    fs.writeFileSync(file, '\uFEFFline 1\r\nline 2\r\n');
    const res = util.readText(file);
    assert.equal(res.text, 'line 1\nline 2\n');
    assert.equal(res.crlf, true);
    assert.equal(res.bom, true);

    fs.writeFileSync(file, 'plain\n');
    assert.deepEqual(util.readText(file), { text: 'plain\n', crlf: false, bom: false });
  });

  test('writeIfChanged creates folders and writes only when bytes differ', () => {
    const dir = tmpDir('util');
    const file = path.join(dir, 'a', 'b', 'c.txt');
    assert.equal(util.writeIfChanged(file, 'one\n'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'one\n');
    const before = fs.statSync(file).mtimeMs;
    assert.equal(util.writeIfChanged(file, 'one\n'), false);
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.equal(util.writeIfChanged(file, 'two\n'), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'two\n');
  });
});

describe('git', { skip: !HAS_GIT && 'git is not installed' }, () => {
  test('isGitRepo is true only at the top of a work tree', () => {
    const dir = tmpDir('util-git');
    assert.equal(util.isGitRepo(dir), false);
    util.git(dir, ['init', '-q']);
    assert.equal(util.isGitRepo(dir), true);
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.equal(util.isGitRepo(path.join(dir, 'sub')), false);
  });

  test('git returns stdout, and failures only with allowFail', () => {
    const dir = tmpDir('util-git');
    util.git(dir, ['init', '-q']);
    const ok = util.git(dir, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(ok.ok, true);
    assert.equal(ok.stdout.trim(), 'true');
    const bad = util.git(dir, ['rev-parse', 'no-such-ref'], { allowFail: true });
    assert.equal(bad.ok, false);
    assert.notEqual(bad.code, 0);
    assert.throws(() => util.git(dir, ['rev-parse', 'no-such-ref']));
  });
});
