// The report of one answer (lib/report.mjs): the notes read and saved since the owner's last
// message, only notes in the notes folders, nothing when the answer did not touch the memory.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shortList, turnReport } from '../../lib/report.mjs';
import { removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const owner = (content, timestamp) => ({ type: 'user', timestamp, message: { role: 'user', content } });
const tool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });

function transcript(entries) {
  const file = path.join(tmpDir('report-t'), 't.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

describe('turnReport', () => {
  const root = tmpDir('report-vault');
  for (const rel of ['sectors/core/price.md', 'sectors/core/stack.md', 'README.md', 'inbox/idea.md']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  const old = new Date(Date.now() - 3600000);
  for (const rel of ['sectors/core/price.md', 'sectors/core/stack.md', 'README.md']) fs.utimesSync(path.join(root, rel), old, old);
  const cfg = { root, roots: [{ id: 'main', path: root }], dirs: { sectors: 'sectors', inbox: 'inbox', journal: 'journal' } };
  const asked = new Date(Date.now() - 60000).toISOString();

  test('reads since the last owner message, notes only; a note changed since then is saved', () => {
    const t = transcript([
      owner('first', new Date(Date.now() - 7200000).toISOString()),
      tool('Read', { file_path: `${root}/sectors/core/stack.md` }),
      owner('what does coffee cost?', asked),
      tool('Read', { file_path: `${root}/sectors/core/price.md` }),
      tool('Read', { file_path: '/code/shop/README.md' }),
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'saved to the inbox: inbox/idea.md' }] } },
    ]);
    assert.deepEqual(turnReport(cfg, { transcript: t }), { read: ['price'], saved: ['idea'] });
    const quiet = transcript([owner('hi', asked), tool('Read', { file_path: `${root}/sectors/core/price.md` })]);
    assert.deepEqual(turnReport(cfg, { transcript: quiet }), { read: ['price'], saved: [] }, 'idea.md changed but was not named: a pull, not a save');
    const listed = transcript([owner('hi', asked), { type: 'user', message: { content: [{ type: 'tool_result', content: 'sectors/core/stack.md · fact' }] } }]);
    assert.equal(turnReport(cfg, { transcript: listed }), null, 'a search that only listed a note did not use it');
  });

  test('exact files: two notes of one name, a code file through a folder named inbox, JSON escapes, subagents', () => {
    for (const rel of ['sectors/dev-a/gotchas.md', 'sectors/dev-b/gotchas.md']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'x');
      fs.utimesSync(path.join(root, rel), old, old);
    }
    const t = transcript([
      owner('check both', asked),
      tool('Bash', { command: `cat ${root}/sectors/dev-a/gotchas.md\ncat ${root}/sectors/dev-b/gotchas.md` }),
      tool('Read', { file_path: '/code/shop/inbox/README.md' }),
    ]);
    assert.deepEqual(turnReport(cfg, { transcript: t }), { read: ['dev-a/gotchas', 'dev-b/gotchas'], saved: [] });
    const sub = path.join(t.slice(0, -'.jsonl'.length), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), `${JSON.stringify({ ...tool('Read', { file_path: `${root}/sectors/core/stack.md` }), timestamp: new Date().toISOString() })}\n`);
    assert.ok(turnReport(cfg, { transcript: t }).read.includes('stack'), 'read by a subagent');
  });

  test('an answer that did not touch the memory reports nothing', () => {
    fs.utimesSync(path.join(root, 'inbox/idea.md'), old, old);
    const t = transcript([owner('hi', asked), tool('Bash', { command: 'ls' })]);
    assert.equal(turnReport(cfg, { transcript: t }), null);
    assert.equal(turnReport(cfg, { transcript: '/nonexistent.jsonl' }), null);
  });

  test('shortList keeps the line short', () => {
    assert.equal(shortList(['a', 'b']), 'a, b');
    assert.equal(shortList(['a', 'b', 'c', 'd', 'e']), 'a, b, c +2');
  });
});
