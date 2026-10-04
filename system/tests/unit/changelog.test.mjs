// lib/changelog.mjs: the "## x.y.z (…)" sections of CHANGELOG.md, their groups and the one-line
// headlines the upgrade screen shows under "What's new"; also the kit's own CHANGELOG.md.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, headline, parseChangelog, plainText, readReleaseNotes, releaseNotes } from '../../lib/changelog.mjs';
import { KIT_ROOT, tmpDir } from '../helpers.mjs';

const SAMPLE = [
  '# Changelog',
  '',
  'Intro text.',
  '',
  '## Unreleased',
  '',
  '- Not released: never shown.',
  '',
  '## 0.2.0 (2026-10-01)',
  '',
  'A short summary of the release.',
  '',
  '### Added',
  '',
  '- **A setup wizard** in the terminal. It asks one question per screen.',
  '- **`upgrade`**: shows what is new',
  '  and asks before it applies anything.',
  '- **What keeps it safe**',
  '  ([docs/upgrading.md](docs/upgrading.md#safe)):',
  '  - a backup of every file',
  '  - a lock',
  '',
  '### Changed',
  '',
  '- `connect --projects` installs hooks in the shell form, which every Claude Code version runs; details follow.',
  '',
  '### Kit files',
  '',
  '- New: `system/lib/tui.mjs`.',
  '',
  '### Testing',
  '',
  '- 40 new tests.',
  '',
  '## 0.1.9 (2026-09-30)',
  '',
  '### Fixed',
  '',
  '- Search finds [notes](docs/search.md) with *emphasis* again.',
  '',
  '## 0.1.8',
  '',
  '- A bullet without a group.',
].join('\n');

describe('changelog', () => {
  test('sections, groups and bullets', () => {
    const sections = parseChangelog(SAMPLE);
    assert.deepEqual(sections.map((s) => s.version), ['0.2.0', '0.1.9', '0.1.8']);
    assert.equal(sections[0].title, '(2026-10-01)');
    assert.deepEqual(sections[0].groups.map((g) => g.title), ['Added', 'Changed', 'Kit files', 'Testing']);
    assert.deepEqual(sections[0].groups[0].items.map((i) => i.headline), [
      'A setup wizard in the terminal',
      'upgrade: shows what is new and asks before it applies anything',
      'What keeps it safe',
    ]);
    assert.equal(sections[0].groups[0].items[2].text, 'What keeps it safe:', 'nested bullets are left out, the docs link dropped');
    assert.deepEqual(sections[2].groups, [{ title: '', items: [{ headline: 'A bullet without a group', text: 'A bullet without a group.' }] }]);
  });

  test('a headline is the first sentence, cut at a late colon or semicolon', () => {
    assert.equal(headline('**`hook <agent> <event>`**, what the hooks run: on session start a sector; on stop a request.'), 'hook <agent> <event>, what the hooks run');
    assert.equal(headline('**`upgrade`**: updates the kit in one command. It fetches the newest kit.'), 'upgrade: updates the kit in one command');
    assert.equal(headline('Version 0.1.0 is supported, e.g. from a zip. More.'), 'Version 0.1.0 is supported, e.g. from a zip');
    assert.equal(plainText('See [the docs](docs/x.md), `code` and **bold** and _this_.'), 'See the docs, code and bold and this.');
  });

  test('release notes: the groups for users, at most max, optionally since a version', () => {
    const notes = releaseNotes(SAMPLE, '0.2.0', { max: 3 });
    assert.deepEqual(notes.headlines, ['A setup wizard in the terminal', 'upgrade: shows what is new and asks before it applies anything', 'What keeps it safe']);
    assert.equal(notes.more, 1, 'the Changed bullet; Kit files and Testing never count');
    const since = releaseNotes(SAMPLE, '0.2.0', { from: '0.1.8', max: 10 });
    assert.equal(since.headlines.at(-1), 'Search finds notes with emphasis again', 'a skipped release is included');
    assert.equal(since.headlines.length, 5);
    assert.equal(releaseNotes(SAMPLE, '9.9.9'), null);
    assert.equal(releaseNotes(SAMPLE, 'v0.1.9').headlines.length, 1);
    assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
    assert.equal(compareVersions('x', '0.1.9'), null);
  });

  test('readReleaseNotes: a missing file or section is null; CRLF is fine', () => {
    const dir = tmpDir('changelog');
    assert.equal(readReleaseNotes(dir, '0.2.0'), null);
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), SAMPLE.replace(/\n/g, '\r\n'));
    assert.equal(readReleaseNotes(dir, '0.2.0').headlines[0], 'A setup wizard in the terminal');
    assert.equal(readReleaseNotes(dir, '0.0.1'), null);
  });

  test('the kit\'s own changelog has headlines for its version', () => {
    const version = fs.readFileSync(path.join(KIT_ROOT, 'system', 'VERSION'), 'utf8').trim();
    const notes = readReleaseNotes(KIT_ROOT, version);
    assert.ok(notes && notes.headlines.length >= 1, `CHANGELOG.md has a "## ${version}" section with bullets`);
    for (const h of notes.headlines) assert.ok(!/\*\*|`|\]\(/.test(h), `no markdown left: ${h}`);
  });
});
