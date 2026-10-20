// The check of the 📎 line (lib/citations.mjs): parsing the line in both languages, reading
// Claude Code and Codex transcripts, and the three problems: a note that does not exist, a note
// the session did not read, a note named as saved that did not change.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCitations, citeLine, hasProblems, lastAssistantText, noteFiles, readTranscript, toolInputs } from '../../lib/citations.mjs';
import { removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const claudeText = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const claudeTool = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] } });
const codexText = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const codexCall = (args) => ({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify(args) } });

function vaultWith(names) {
  const root = tmpDir('cite-vault');
  for (const [rel, body] of Object.entries(names)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return { root, roots: [{ id: 'main', path: root, privacy: 'github' }] };
}

function transcript(entries) {
  const file = path.join(tmpDir('cite-transcript'), 't.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

describe('the 📎 line', () => {
  test('citeLine: the last line, both languages, aliases and sections dropped, saved told apart', () => {
    assert.deepEqual(citeLine('Answer.\n📎 memory: [[a]], [[b|B]], [[a]]'), { kind: 'memory', names: ['a', 'b'] });
    assert.deepEqual(citeLine('📎 z paměti: [[cena-kava]]'), { kind: 'memory', names: ['cena-kava'] });
    assert.deepEqual(citeLine('📎 saved: [[c#History]]'), { kind: 'saved', names: ['c'] });
    assert.deepEqual(citeLine('📎 uloženo: [[d]]'), { kind: 'saved', names: ['d'] });
    assert.deepEqual(citeLine('first 📎 memory: [[x]]\nlast **📎 memory:** [[y]]'), { kind: 'memory', names: ['y'] });
    assert.equal(citeLine('no line here'), null);
    assert.equal(citeLine('📎 without links'), null);
  });

  test('transcripts of Claude Code and Codex: the last answer and the tool calls', () => {
    const t = transcript([claudeTool('Read', { file_path: '/v/sectors/core/a.md' }), claudeText('done\n📎 memory: [[a]]'), { type: 'user', message: { content: 'x' } }]);
    const entries = readTranscript(t);
    assert.equal(lastAssistantText(entries), 'done\n📎 memory: [[a]]');
    assert.match(toolInputs(entries)[0], /a\.md/);
    const c = readTranscript(transcript([codexCall({ command: ['bash', '-lc', 'cat sectors/core/b.md'] }), codexText('📎 memory: [[b]]')]));
    assert.equal(lastAssistantText(c), '📎 memory: [[b]]');
    assert.match(toolInputs(c)[0], /b\.md/);
    assert.deepEqual(readTranscript(path.join(tmpDir('none'), 'missing.jsonl')), []);
  });
});

describe('checkCitations', () => {
  const cfg = vaultWith({ 'sectors/core/a.md': 'a', 'sectors/work/b-note.md': 'b', 'sectors/work/c.md': 'c', '_ai/start.md': 'generated' });

  test('noteFiles finds notes by name and skips generated folders', () => {
    const files = noteFiles(cfg);
    assert.ok(files.has('a') && files.has('b-note'));
    assert.equal(files.has('start'), false);
  });

  test('a cited note must exist and be read in the session', () => {
    const t = transcript([
      claudeTool('Read', { file_path: path.join(cfg.root, 'sectors/core/a.md'), limit: 15 }),
      claudeTool('Bash', { command: 'node system/memory.mjs show b-note' }),
      claudeText('Answer.\n📎 memory: [[a]], [[b-note]], [[c]], [[ghost]]'),
    ]);
    const r = checkCitations(cfg, { transcript: t });
    assert.deepEqual(r, { kind: 'memory', missing: ['ghost'], unread: ['c'], unsaved: [] });
    assert.equal(hasProblems(r), true);
  });

  test('a name inside another name is not a read; last_assistant_message wins over the transcript', () => {
    const t = transcript([claudeTool('Read', { file_path: '/v/sectors/work/xc.md' }), claudeText('📎 memory: [[a]]')]);
    const r = checkCitations(cfg, { transcript: t, last: 'Answer\n📎 memory: [[c]]' });
    assert.deepEqual(r.unread, ['c']);
  });

  test('a saved note must have changed after the session started', () => {
    const t = transcript([claudeText('📎 saved: [[a]]')]);
    assert.deepEqual(checkCitations(cfg, { transcript: t, since: Date.now() + 60000 }).unsaved, ['a']);
    assert.equal(hasProblems(checkCitations(cfg, { transcript: t, since: 0 })), false);
  });

  test('no 📎 line, or an unreadable transcript without one: nothing to check', () => {
    assert.equal(checkCitations(cfg, { transcript: transcript([claudeText('plain answer')]) }), null);
    assert.equal(checkCitations(cfg, { transcript: '/nonexistent/t.jsonl' }), null);
    assert.equal(hasProblems(null), false);
  });
});
