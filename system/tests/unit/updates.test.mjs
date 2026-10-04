// The update check as a library (lib/updates.mjs): which tags are releases, the releases page of a
// GitHub source, the settings and their defaults, when a background check is due (never in CI, in
// a probe or with NO_UPDATE_NOTIFIER; at most once a day), that it never throws, the owner's line
// once a day, the issue text of the nightly CI, the channels, and the link that adds the workflow
// of the issue to an older memory on GitHub.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  UPDATES_REL, UpdateCheckError, WORKFLOW_COPY_REL, WORKFLOW_REL, channelList, checkDue, checkInBackground, githubRepo, issueText,
  latestAt, latestFromTags, readUpdates, releasesOf, updateLine, updateSettings, updateStatus, workflowLinkOf, writeUpdates,
} from '../../lib/updates.mjs';
import { hashText, loadManifest } from '../../lib/kit.mjs';
import { KIT_ROOT, bareRoot, removeTmpDirs, tmpDir } from '../helpers.mjs';

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
const HAS_GIT = spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
const gitIn = (root, args) => {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, res.stderr);
};

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
    assert.deepEqual(githubRepo('git@github.com:linden/memory.git'), { owner: 'linden', repo: 'memory' });
    assert.equal(githubRepo('https://example.org/linden/memory.git'), null);
    assert.equal(githubRepo(''), null);
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

describe('the workflow of the issue in an older memory', { skip: !HAS_GIT && 'git is missing' }, () => {
  /** A set-up vault in git with this origin, without the workflow, on this branch. */
  function onGitHub(origin, { branch = 'main', updates } = {}) {
    const { root } = vault(updates);
    gitIn(root, ['init', '-q', '-b', branch]);
    if (origin) gitIn(root, ['remote', 'add', 'origin', origin]);
    fs.rmSync(path.join(root, ...WORKFLOW_REL.split('/')), { force: true });
    return root;
  }

  test('the channels: missing only on GitHub with the issue on; "github": false is off with or without the file', () => {
    const root = onGitHub('https://github.com/linden/memory.git');
    assert.deepEqual(updateStatus(root).channels, { github: 'missing', check: false });
    assert.equal(channelList(null, updateStatus(root)), 'no issue on GitHub yet: the workflow is missing (node system/memory.mjs doctor prints the link that adds it) · no daily check ("updates": {"check": true} turns it on)');
    assert.equal(channelList(null, updateStatus(root), { short: true }), 'no issue on GitHub yet: the workflow is missing · no daily check ("updates": {"check": true} turns it on)');
    assert.equal(updateStatus(onGitHub('https://github.com/linden/memory.git', { updates: { github: false } })).channels.github, 'off');
    assert.equal(updateStatus(onGitHub('https://example.org/linden/memory.git')).channels.github, 'none');
    assert.equal(updateStatus(onGitHub(null)).channels.github, 'none');
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.copyFileSync(path.join(KIT_ROOT, ...WORKFLOW_REL.split('/')), path.join(root, ...WORKFLOW_REL.split('/')));
    assert.equal(updateStatus(root).channels.github, 'on');
  });

  test('the link opens GitHub\'s new-file page of the vault\'s repository with the path and the text of the workflow', () => {
    const text = fs.readFileSync(path.join(KIT_ROOT, ...WORKFLOW_COPY_REL.split('/')), 'utf8');
    for (const origin of ['https://github.com/linden/memory.git', 'git@github.com:linden/memory.git', 'ssh://git@github.com/linden/memory']) {
      const url = new URL(workflowLinkOf(onGitHub(origin)));
      assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/linden/memory/new/main', origin);
      assert.equal(url.searchParams.get('filename'), WORKFLOW_REL);
      assert.equal(url.searchParams.get('value'), text);
    }
    // Without origin/HEAD or origin/main: the current branch, also one with a slash; GitHub refuses links of 9 KB (414).
    const link = workflowLinkOf(onGitHub('https://github.com/linden/memory.git', { branch: 'notes/main' }));
    assert.ok(link.startsWith('https://github.com/linden/memory/new/notes/main?filename=.github/workflows/memory-kit-updates.yml&value='), link.slice(0, 120));
    assert.ok(link.length < 8000, String(link.length));
    // Only characters every terminal takes into a link: a raw ' ( ) * ! would cut it short.
    assert.match(link, /^https:\/\/[A-Za-z0-9%/?=&:._~-]+$/);
    // GitHub runs a scheduled workflow only from the default branch: origin/HEAD when a clone set it,
    // else main when origin has one (a cloud session on a branch of its own), never the current branch.
    const branched = onGitHub('https://github.com/linden/memory.git', { branch: 'diary/plans' });
    gitIn(branched, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 't']);
    for (const name of ['main', 'trunk']) gitIn(branched, ['update-ref', `refs/remotes/origin/${name}`, 'HEAD']);
    const pathOf = (root) => new URL(workflowLinkOf(root)).pathname;
    assert.equal(pathOf(branched), '/linden/memory/new/main');
    gitIn(branched, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    assert.equal(pathOf(branched), '/linden/memory/new/trunk');
    // No link: an origin elsewhere, none at all, no copy of the workflow, or a copy too long for a link.
    assert.equal(workflowLinkOf(onGitHub('https://example.org/linden/memory.git')), null);
    assert.equal(workflowLinkOf(onGitHub(null)), null);
    const root = onGitHub('https://github.com/linden/memory.git');
    const code = tmpDir('workflow-copy');
    assert.equal(workflowLinkOf(root, { codeRoot: code }), null);
    const long = `${text}${'# ...\n'.repeat(600)}`;
    writeCopy(code, long, hashText(long));
    assert.equal(workflowLinkOf(root, { codeRoot: code }), null);
  });

  /** A kit at code with this copy of the workflow and this sha256 for it in kit.json. */
  function writeCopy(code, text, sha256) {
    const copy = path.join(code, ...WORKFLOW_COPY_REL.split('/'));
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, text);
    fs.writeFileSync(path.join(code, 'system', 'kit.json'), `${JSON.stringify({ files: sha256 ? { [WORKFLOW_COPY_REL]: { sha256, group: 'code' } } : {} })}\n`);
  }

  test('the link carries only the copy the kit shipped: one changed here, or without its hash in kit.json, gets none', () => {
    const text = fs.readFileSync(path.join(KIT_ROOT, ...WORKFLOW_COPY_REL.split('/')), 'utf8');
    const shipped = loadManifest(KIT_ROOT).files[WORKFLOW_COPY_REL].sha256;
    assert.equal(hashText(text), shipped, 'kit.json holds the hash of the copy');
    const root = onGitHub('https://github.com/linden/memory.git');
    const code = tmpDir('workflow-shipped');
    writeCopy(code, text, shipped);
    assert.equal(new URL(workflowLinkOf(root, { codeRoot: code })).searchParams.get('value'), text);
    // CRLF, as a Windows checkout may have it, is the same file.
    writeCopy(code, text.replace(/\n/g, '\r\n'), shipped);
    assert.ok(workflowLinkOf(root, { codeRoot: code }));
    writeCopy(code, `${text}      - run: echo planted\n`, shipped);
    assert.equal(workflowLinkOf(root, { codeRoot: code }), null);
    writeCopy(code, text, null);
    assert.equal(workflowLinkOf(root, { codeRoot: code }), null);
    fs.rmSync(path.join(code, 'system', 'kit.json'));
    assert.equal(workflowLinkOf(root, { codeRoot: code }), null);
  });
});
