// The update check as a library (lib/updates.mjs): which tags are releases, the releases page of a
// GitHub source, the settings and their defaults, when a background check is due (never in CI, in
// a probe or with NO_UPDATE_NOTIFIER; at most once a day), that it never throws, the owner's line
// once a day, and the issue text of the nightly CI.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  UPDATES_REL, UpdateCheckError, checkDue, checkInBackground, issueText, latestAt, latestFromTags, readUpdates, releasesOf,
  updateLine, updateSettings, writeUpdates,
} from '../../lib/updates.mjs';
import { bareRoot, removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const NOW = new Date('2026-09-20T12:00:00.000Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
/** A set-up vault root (bareRoot has VERSION of this kit) with the given updates settings. */
function vault(updates) {
  const root = bareRoot('en', updates === undefined ? {} : { updates });
  const version = fs.readFileSync(path.join(root, 'system', 'VERSION'), 'utf8').trim();
  return { root, version, cfg: { root, initialized: true, updates: updateSettings(root), t: null } };
}
const bump = (version, n = 1) => version.replace(/(\d+)$/, (d) => String(Number(d) + n));

describe('what the source says', () => {
  test('the newest release among the tags; pre-releases and other tags are no releases', () => {
    const tags = ['a\trefs/tags/v0.1.2', 'b\trefs/tags/v0.1.10', 'c\trefs/tags/0.1.9', 'd\trefs/tags/v0.2.0-rc.1', 'e\trefs/tags/latest', 'f\trefs/tags/v0.1.11^{}', 'g\trefs/heads/v9.9.9'];
    assert.equal(latestFromTags(tags.join('\n')), '0.1.11');
    assert.equal(latestFromTags(''), null);
    assert.equal(latestFromTags('x\trefs/tags/v1.0.0-beta'), null);
  });

  test('latestAt: the tags of a git source, the VERSION of a folder, and a clear error', () => {
    const calls = [];
    const ok = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: 'a\trefs/tags/v0.1.3\nb\trefs/tags/v0.1.4\n', stderr: '' };
    };
    assert.equal(latestAt({ url: 'https://example.com/kit.git' }, { git: ok }), '0.1.4');
    assert.deepEqual(calls, [['git', 'ls-remote', '--tags', '--refs', 'https://example.com/kit.git']], 'one ls-remote, nothing downloaded');
    const fail = () => ({ status: 128, stdout: '', stderr: 'hint: x\nfatal: repository not found\n' });
    assert.throws(() => latestAt({ url: 'https://example.com/none.git' }, { git: fail }), (err) => err instanceof UpdateCheckError && err.detail === 'fatal: repository not found');
    assert.throws(() => latestAt({ url: 'u' }, { git: () => ({ status: 0, stdout: 'a\trefs/tags/latest\n' }) }), /no release tag/);
    assert.throws(() => latestAt({ url: 'u' }, { git: () => ({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }) }), /timed out/);
    const { root, version } = vault();
    assert.equal(latestAt({ dir: root }), version);
    assert.throws(() => latestAt({ dir: tmpDir('empty') }), UpdateCheckError);
  });

  test('the releases page of a GitHub source, in every form a clone URL takes', () => {
    const page = 'https://github.com/linden/memory-kit/releases';
    for (const source of ['https://github.com/linden/memory-kit.git', 'https://github.com/linden/memory-kit', 'git@github.com:linden/memory-kit.git', 'ssh://git@github.com/linden/memory-kit.git', 'https://github.com/linden/memory-kit/']) {
      assert.deepEqual(releasesOf(source, '0.1.4'), { page, tag: `${page}/tag/v0.1.4` }, source);
    }
    assert.equal(releasesOf('https://gitlab.com/linden/memory-kit.git', '0.1.4'), null);
    assert.equal(releasesOf('file:///tmp/kit.git', '0.1.4'), null);
    assert.equal(releasesOf('https://github.com/linden/memory-kit.git').tag, null);
  });
});

describe('settings and the cache', () => {
  test('check is off and github on by default; a byte order mark in memory.json is fine', () => {
    assert.deepEqual(updateSettings(vault().root), { check: false, github: true });
    assert.deepEqual(updateSettings(vault({ check: true, github: false }).root), { check: true, github: false });
    assert.deepEqual(updateSettings({ updates: { check: true, github: true } }), { check: true, github: true });
    assert.deepEqual(updateSettings({ raw: { updates: { github: false } } }), { check: false, github: false });
    const { root } = vault({ check: true });
    const file = path.join(root, 'memory.json');
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + fs.readFileSync(file, 'utf8'));
    assert.equal(updateSettings(root).check, true);
    assert.deepEqual(updateSettings(path.join(tmpDir('none'), 'x')), { check: false, github: true });
  });

  test('the cache lives in .memory-kit/updates.json and a broken one reads as empty', () => {
    const { root } = vault();
    assert.deepEqual(readUpdates(root), {});
    assert.equal(writeUpdates(root, { latest: '0.9.0' }), true);
    assert.deepEqual(readUpdates(root), { latest: '0.9.0' });
    fs.writeFileSync(path.join(root, ...UPDATES_REL.split('/')), '[1, 2');
    assert.deepEqual(readUpdates(root), {});
    fs.rmSync(path.join(root, '.memory-kit'), { recursive: true });
    fs.writeFileSync(path.join(root, '.memory-kit'), 'a file where the folder should be');
    assert.equal(writeUpdates(root, { latest: '0.9.0' }), false, 'never throws');
  });
});

describe('the check at a session start', () => {
  test('due only when switched on, in no CI, probe or NO_UPDATE_NOTIFIER run, and at most once a day', () => {
    const on = vault({ check: true });
    assert.equal(checkDue(on.cfg, { env: {}, now: NOW }), true, 'never checked');
    assert.equal(checkDue(vault().cfg, { env: {}, now: NOW }), false, 'off by default');
    assert.equal(checkDue({ ...on.cfg, initialized: false }, { env: {}, now: NOW }), false, 'not set up');
    for (const env of [{ CI: 'true' }, { NO_UPDATE_NOTIFIER: '1' }, { MEMORY_KIT_PROBE: '1' }]) {
      assert.equal(checkDue(on.cfg, { env, now: NOW }), false, JSON.stringify(env));
    }
    writeUpdates(on.root, { attempted: hoursAgo(2) });
    assert.equal(checkDue(on.cfg, { env: {}, now: NOW }), false, 'started two hours ago');
    writeUpdates(on.root, { checked: hoursAgo(25) });
    assert.equal(checkDue(on.cfg, { env: {}, now: NOW }), true, 'a day ago');
    writeUpdates(on.root, { attempted: new Date(NOW.getTime() + 3 * 86400000).toISOString() });
    assert.equal(checkDue(on.cfg, { env: {}, now: NOW }), true, 'a clock that was wrong');
  });

  test('checkInBackground notes the attempt, starts `upgrade --check --json` detached, and never throws', () => {
    const { root, cfg } = vault({ check: true });
    const started = [];
    const fake = (cmd, args, opts) => {
      started.push({ cmd, args, detached: opts.detached, stdio: opts.stdio });
      return { on() {}, unref() {} };
    };
    assert.equal(checkInBackground(cfg, { env: {}, now: NOW, start: fake }), true);
    assert.deepEqual(started, [{ cmd: process.execPath, args: [path.join(root, 'system', 'memory.mjs'), 'upgrade', '--check', '--json', '--root', root], detached: true, stdio: 'ignore' }]);
    assert.equal(readUpdates(root).attempted, NOW.toISOString());
    assert.equal(checkInBackground(cfg, { env: {}, now: NOW, start: fake }), false, 'once a day');
    const other = vault({ check: true });
    assert.equal(checkInBackground(other.cfg, { env: {}, now: NOW, start: () => { throw new Error('spawn EACCES'); } }), false);
  });

  test('the owner hears of a newer kit once a day, and of none that is not newer', () => {
    const { root, version, cfg } = vault();
    assert.equal(updateLine(cfg, { now: NOW }), null, 'nothing checked yet');
    writeUpdates(root, { latest: bump(version) });
    const line = updateLine(cfg, { now: NOW, command: 'node "/v/system/memory.mjs"' });
    assert.equal(line, `memory-kit: version ${bump(version)} is out (this memory has ${version}). See what is new and update: node "/v/system/memory.mjs" upgrade`);
    assert.equal(updateLine(cfg, { now: NOW }), null, 'told today');
    assert.match(updateLine(cfg, { now: new Date(NOW.getTime() + 86400000) }), /is out/, 'and again the next day');
    writeUpdates(root, { latest: version });
    assert.equal(updateLine(cfg, { now: new Date(NOW.getTime() + 3 * 86400000) }), null, 'the same version is no news');
    writeUpdates(root, { latest: 'next' });
    assert.equal(updateLine(cfg, { now: NOW }), null);
  });
});

describe('the issue of the nightly CI', () => {
  test('names the version, how to update and how to turn it off; links the release on GitHub', () => {
    const gh = issueText(null, { latest: '0.1.4', installed: '0.1.3', source: 'https://github.com/linden/memory-kit.git' });
    assert.equal(gh.title, 'memory-kit 0.1.4 is available');
    assert.match(gh.body, /^memory-kit 0\.1\.4 is out; this memory has 0\.1\.3\.\n\nWhat is new: https:\/\/github\.com\/linden\/memory-kit\/releases\/tag\/v0\.1\.4\n/);
    assert.match(gh.body, /\n {4}node system\/memory\.mjs upgrade\n/);
    assert.match(gh.body, /"updates": \{"github": false\}/);
    const other = issueText(null, { latest: '0.1.4', installed: '0.1.3', source: 'https://gitlab.com/linden/memory-kit.git' });
    assert.match(other.body, /What is new: `upgrade` shows it from the CHANGELOG\.md/);
  });
});
