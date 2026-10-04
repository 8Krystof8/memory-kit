// A newer memory-kit end to end (docs/architecture.md, 10.6 and 15.4), against a kit source that
// is a real git repository with release tags: `upgrade --check` in both languages (available, up to
// date, a folder source, an unreachable source, its JSON), the owner's line at a session start once
// a day, the daily check in the background (and never in CI), and the step of the workflow
// memory-kit-updates.yml that opens, renames and closes the issue, run with bash against a fake gh.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { groupOf, loadManifest } from '../../lib/kit.mjs';
import { KIT_ROOT, fixtureVault, removeTmpDirs, runCli, tmpDir, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const HAS_BASH_JQ = process.platform !== 'win32'
  && spawnSync('bash', ['-c', 'command -v jq'], { windowsHide: true }).status === 0;
const VERSION = fs.readFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), 'utf8').trim();
const bump = (version, n = 1) => version.replace(/(\d+)$/, (d) => String(Number(d) + n));
const NEXT = bump(VERSION);
const PREV = bump(VERSION, -1);
// No CI mark and no global opt-out, unless a test sets one.
const QUIET = { CI: '', NO_UPDATE_NOTIFIER: '' };

/** A kit source: a bare git repository with these tags, as a file:// URL. */
function kitSource(tags) {
  const work = tmpDir('kit-work');
  const git = (cwd, args) => {
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(res.status, 0, res.stderr);
  };
  git(work, ['init', '-q']);
  fs.writeFileSync(path.join(work, 'README.md'), 'kit\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', 'kit']);
  for (const tag of tags) git(work, ['tag', tag]);
  const bare = path.join(tmpDir('kit-src'), 'kit.git');
  git(path.dirname(bare), ['clone', '-q', '--bare', work, bare]);
  return `file://${bare.replace(/\\/g, '/').replace(/^([A-Za-z]:)/, '/$1')}`;
}

function vaultWith(lang, config) {
  const v = fixtureVault(lang);
  const file = path.join(v.root, 'memory.json');
  writeJson(v.root, 'memory.json', { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...config });
  return v;
}
const cache = (v) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(v.root, '.memory-kit', 'updates.json'), 'utf8'));
  } catch {
    return {};
  }
};

describe('upgrade --check', { skip: !HAS_GIT && 'git is missing' }, () => {
  test('en: a newer release; the answer is noted; how to hear of the next one', () => {
    const source = kitSource([`v${PREV}`, `v${VERSION}`, `v${NEXT}`, `v${bump(NEXT)}-rc.1`]);
    const v = vaultWith('en', { kit: { source } });
    const res = runCli(v.root, ['upgrade', '--check'], { env: QUIET });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, [
      `memory-kit ${NEXT} is available (this memory has ${VERSION}).`,
      'See what is new and update: node system/memory.mjs upgrade',
      'To hear of new versions by yourself: "updates": {"check": true} in memory.json (a check once a day in the background)',
      '',
    ].join('\n'));
    const noted = cache(v);
    assert.deepEqual([noted.installed, noted.latest, noted.source], [VERSION, NEXT, source]);
    assert.ok(Date.parse(noted.checked) > Date.now() - 60000);
  });

  test('cs: the Czech alias and messages; --json carries the issue for the nightly CI', () => {
    const source = kitSource([`v${NEXT}`]);
    const v = vaultWith('cs', { kit: { source } });
    const human = runCli(v.root, ['aktualizuj', '--check'], { env: QUIET });
    assert.match(human.stdout, new RegExp(`^Je k dispozici memory-kit ${NEXT.replace(/\./g, '\\.')} \\(tahle paměť má ${VERSION.replace(/\./g, '\\.')}\\)\\.\\nCo je nového a aktualizace: node system/memory\\.mjs upgrade\\n`));
    const j = JSON.parse(runCli(v.root, ['upgrade', '--check', '--json'], { env: QUIET }).stdout);
    assert.deepEqual(Object.keys(j), ['installed', 'latest', 'available', 'source', 'checked', 'releases', 'settings', 'issue', 'closing', 'message']);
    assert.deepEqual([j.installed, j.latest, j.available, j.releases, j.closing], [VERSION, NEXT, true, null, null]);
    assert.deepEqual(j.settings, { check: false, github: true });
    assert.equal(j.issue.title, `Je k dispozici memory-kit ${NEXT}`);
    assert.match(j.issue.body, /Aktualizuj na svém počítači/);
  });

  test('up to date: the usual line, and the JSON says how to close an open issue', () => {
    const v = vaultWith('en', { kit: { source: kitSource([`v${PREV}`, `v${VERSION}`]) } });
    const res = runCli(v.root, ['upgrade', '--check'], { env: QUIET });
    assert.equal(res.stdout, `memory-kit ${VERSION} is up to date (the source has ${VERSION}).\n`);
    const j = JSON.parse(runCli(v.root, ['upgrade', '--check', '--json'], { env: QUIET }).stdout);
    assert.deepEqual([j.available, j.issue], [false, null]);
    assert.equal(j.closing, `This memory has memory-kit ${VERSION} now, so this issue is done.`);
  });

  test('a folder source is read, nothing is fetched; an unreachable one is exit 1 with the reason', () => {
    const folder = tmpDir('kit-folder');
    fs.mkdirSync(path.join(folder, 'system'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'system', 'VERSION'), `${NEXT}\n`);
    const v = vaultWith('en', { kit: { source: folder } });
    assert.match(runCli(v.root, ['upgrade', '--check'], { env: QUIET }).stdout, new RegExp(`^memory-kit ${NEXT.replace(/\./g, '\\.')} is available`));
    const gone = vaultWith('en', { kit: { source: `file://${tmpDir('nothing').replace(/\\/g, '/')}/kit.git` } });
    const res = runCli(gone.root, ['upgrade', '--check'], { env: QUIET });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /^memory: could not ask file:\/\/.+ for a newer memory-kit: .+\n$/);
    const j = JSON.parse(runCli(gone.root, ['upgrade', '--check', '--json'], { env: QUIET }).stdout);
    assert.deepEqual([j.available, j.latest, j.checked], [false, null, null]);
    assert.deepEqual(cache(gone), {}, 'nothing noted');
  });

  test('--check takes no --yes, --force, --ref or --rollback', () => {
    const v = fixtureVault('en');
    for (const extra of [['--yes'], ['--force'], ['--ref', 'main'], ['--rollback'], ['--dry-run']]) {
      const res = runCli(v.root, ['upgrade', '--check', ...extra]);
      assert.equal(res.code, 2, extra.join(' '));
      assert.match(res.stderr, /--check only asks the source for its newest version/);
    }
  });
});

describe('a newer kit at a session start', { skip: !HAS_GIT && 'git is missing' }, () => {
  test('the owner\'s line names it once a day, also with the loaded line turned off', () => {
    const v = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) } });
    runCli(v.root, ['upgrade', '--check'], { env: QUIET });
    const first = JSON.parse(runCli(v.root, ['start', '--format', 'claude-hook'], { env: QUIET }).stdout).systemMessage.split('\n');
    assert.match(first[0], /^memory-kit: memory loaded · \d+ notes · \d+ sectors$/);
    assert.equal(first[1], `memory-kit: version ${NEXT} is out (this memory has ${VERSION}). See what is new and update: node system/memory.mjs upgrade`);
    const second = JSON.parse(runCli(v.root, ['start', '--format', 'claude-hook'], { env: QUIET }).stdout).systemMessage;
    assert.ok(!second.includes('is out'), 'once a day');
    const quiet = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) }, feedback: { notice: false } });
    runCli(quiet.root, ['upgrade', '--check'], { env: QUIET });
    assert.match(JSON.parse(runCli(quiet.root, ['start', '--format', 'claude-hook'], { env: QUIET }).stdout).systemMessage, /^memory-kit: version .+ is out/);
  });

  test('"updates": {"check": true}: the session start checks in the background, never in CI', async () => {
    const source = kitSource([`v${NEXT}`]);
    const ci = vaultWith('en', { kit: { source }, updates: { check: true } });
    runCli(ci.root, ['start', '--format', 'claude-hook'], { env: { CI: 'true' } });
    assert.deepEqual(cache(ci), {}, 'CI: no check');
    const v = vaultWith('en', { kit: { source }, updates: { check: true } });
    const res = runCli(v.root, ['start', '--format', 'claude-hook'], { env: QUIET });
    assert.equal(res.code, 0);
    assert.ok(cache(v).attempted, 'the attempt is noted at once');
    const deadline = Date.now() + 20000;
    while (!cache(v).checked && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(cache(v).latest, NEXT, 'the background check noted the newer version');
    assert.match(JSON.parse(runCli(v.root, ['start', '--format', 'claude-hook'], { env: QUIET }).stdout).systemMessage, /is out/);
  });
});

const WORKFLOW = path.join(KIT_ROOT, '.github', 'workflows', 'memory-kit-updates.yml');

/** The shell of the step of .github/workflows/memory-kit-updates.yml, as GitHub runs it. */
function updatesStep() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === '- name: Tell the owner about a newer memory-kit');
  assert.ok(at > 0, 'the step exists');
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run + 1].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

describe('the nightly issue (.github/workflows/memory-kit-updates.yml)', () => {
  test('its own workflow, which upgrade never ships (a changed workflow would need the workflow scope to push)', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(text, /\non:\n {2}workflow_dispatch:\n {2}schedule:\n {4}- cron: '[^']+'\n/);
    assert.match(text, /\npermissions:\n {2}contents: read\n {2}issues: write\n\n/, 'it may read the vault and write issues, nothing else');
    assert.match(text, /run: node system\/memory\.mjs|node system\/memory\.mjs upgrade --check --json/, 'the vault\'s own CLI, never a kit fetched in CI');
    assert.equal(groupOf('.github/workflows/memory-kit-updates.yml'), null);
    assert.equal(loadManifest(KIT_ROOT).files['.github/workflows/memory-kit-updates.yml'], undefined);
  });
});

describe('the step of memory-kit-updates.yml', { skip: (!HAS_GIT && 'git is missing') || (!HAS_BASH_JQ && 'needs bash and jq') }, () => {

  function runStep(v, { open = '' } = {}) {
    const bin = tmpDir('fake-gh');
    const log = path.join(bin, 'gh.log');
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_GH_LOG"\nif [ "$1 $2" = "issue list" ] && [ -n "$FAKE_GH_OPEN" ]; then printf \'%b\\n\' "$FAKE_GH_OPEN"; fi\nexit 0\n', { mode: 0o755 });
    const temp = tmpDir('runner-temp');
    const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', updatesStep()], {
      cwd: v.root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ...QUIET, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: temp, GH_TOKEN: 'x', FAKE_GH_LOG: log, FAKE_GH_OPEN: open },
    });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    const body = path.join(temp, 'memory-kit-update.md');
    return { calls, body: fs.existsSync(body) ? fs.readFileSync(body, 'utf8') : null, stdout: res.stdout };
  }

  test('a newer kit and no open issue: the label and one issue with the text of upgrade --check', () => {
    const v = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) } });
    const { calls, body } = runStep(v);
    assert.equal(calls.length, 3, calls.join('\n'));
    assert.match(calls[0], /^issue list --state open --label memory-kit /);
    assert.match(calls[1], /^label create memory-kit /);
    assert.match(calls[2], new RegExp(`^issue create --title memory-kit ${NEXT.replace(/\./g, '\\.')} is available --body-file .+memory-kit-update\\.md --label memory-kit$`));
    assert.match(body, new RegExp(`^memory-kit ${NEXT.replace(/\./g, '\\.')} is out; this memory has ${VERSION.replace(/\./g, '\\.')}\\.`));
  });

  test('the same issue open already: nothing; an older one: renamed and commented, which notifies', () => {
    const v = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) } });
    assert.deepEqual(runStep(v, { open: `7\\tmemory-kit ${NEXT} is available` }).calls.slice(1), []);
    const { calls } = runStep(v, { open: `7\\tmemory-kit ${VERSION} is available` });
    assert.match(calls[1], new RegExp(`^issue edit 7 --title memory-kit ${NEXT.replace(/\./g, '\\.')} is available --body-file `));
    assert.equal(calls[2], `issue comment 7 --body memory-kit ${NEXT} is available`);
  });

  test('after the upgrade the open issue is closed; off, not set up or no answer: nothing', () => {
    const upToDate = vaultWith('en', { kit: { source: kitSource([`v${VERSION}`]) } });
    const { calls } = runStep(upToDate, { open: `7\\tmemory-kit ${VERSION} is available` });
    assert.equal(calls[1], `issue close 7 --comment This memory has memory-kit ${VERSION} now, so this issue is done.`);
    assert.deepEqual(runStep(upToDate).calls.slice(1), [], 'no open issue: nothing to close');
    const off = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) }, updates: { github: false } });
    assert.deepEqual(runStep(off).calls, []);
    const kitRepo = vaultWith('en', { kit: { source: kitSource([`v${NEXT}`]) }, initialized: false });
    assert.deepEqual(runStep(kitRepo).calls, []);
    const unreachable = vaultWith('en', { kit: { source: `file://${tmpDir('none').replace(/\\/g, '/')}/kit.git` } });
    const res = runStep(unreachable);
    assert.deepEqual(res.calls, []);
    assert.match(res.stdout, /no answer from upgrade --check .*; nothing to tell/);
  });
});
