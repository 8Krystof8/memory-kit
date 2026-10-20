// The check of the 📎 line (lib/citations.mjs): parsing the line in both languages, reading
// Claude Code and Codex transcripts, and the three problems: a note that does not exist, a note
// the session did not read, a note named as saved that did not change.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCitations, citeLine, hasProblems, lastAssistantText, nameKey, noteFiles, readTranscript, toolTraces } from '../../lib/citations.mjs';
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
    assert.equal(citeLine('The rule: end with `📎 memory: [[name]]`.'), null, 'a quoted example in inline code');
    assert.equal(citeLine('```\n📎 memory: [[name]]\n```'), null, 'inside a fenced block');
    assert.equal(nameKey(' Sectors/Core/Káva.MD '), 'káva'.normalize('NFC'));
  });

  test('transcripts of Claude Code and Codex: the last answer and the tool calls', () => {
    const t = transcript([claudeTool('Read', { file_path: '/v/sectors/core/a.md' }), claudeText('done\n📎 memory: [[a]]'), { type: 'user', message: { content: 'x' } }]);
    const { entries, cut } = readTranscript(t);
    assert.equal(cut, false);
    assert.equal(lastAssistantText(entries), 'done\n📎 memory: [[a]]');
    assert.match(toolTraces(entries)[0], /a\.md/);
    const c = readTranscript(transcript([codexCall({ command: ['bash', '-lc', 'cat sectors/core/b.md'] }), codexText('📎 memory: [[b]]')])).entries;
    assert.equal(lastAssistantText(c), '📎 memory: [[b]]');
    assert.match(toolTraces(c)[0], /b\.md/);
    assert.deepEqual(readTranscript(path.join(tmpDir('none'), 'missing.jsonl')).entries, []);
    assert.equal(readTranscript(t, 40).cut, true);
  });
});

describe('checkCitations', () => {
  const cfg = vaultWith({ 'sectors/core/a.md': 'a', 'sectors/work/b-note.md': 'b', 'sectors/work/c.md': 'c', '_ai/start.md': 'generated' });

  test('noteFiles finds notes by name and skips generated folders', () => {
    const files = noteFiles(cfg);
    assert.ok(files.has('a') && files.has('b-note'));
    assert.equal(files.get('a').length, 1);
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

  test('read by a subagent, seen in a tool result, given by the session start, or cited by path and case', () => {
    const t = transcript([claudeText('📎 memory: [[a]]')]);
    const sub = path.join(t.slice(0, -'.jsonl'.length), 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), `${JSON.stringify(claudeTool('Read', { file_path: '/v/sectors/core/a.md' }))}\n`);
    assert.equal(hasProblems(checkCitations(cfg, { transcript: t })), false, 'the subagent read it');
    const r = transcript([{ type: 'user', message: { content: [{ type: 'tool_result', content: 'sectors/work/c.md:3 — price 3 €' }] } }, claudeText('x')]);
    assert.equal(hasProblems(checkCitations(cfg, { transcript: r, last: '📎 memory: [[C]], [[sectors/work/b-note.md]]', seen: [path.join(cfg.root, 'sectors/work/b-note.md')] })), false);
  });

  test('the last answer without a 📎 line checks nothing, even when an older one had one', () => {
    const t = transcript([claudeText('📎 memory: [[c]]'), { type: 'user', message: { content: 'next' } }]);
    assert.equal(checkCitations(cfg, { transcript: t, last: 'Plain answer.' }), null);
  });

  test('duplicate names (dev notes of two projects): saved looks at the newest of them', () => {
    const dup = vaultWith({ 'sectors/dev-a/gotchas.md': 'a', 'sectors/dev-b/gotchas.md': 'b' });
    const old = new Date(Date.now() - 3600000);
    fs.utimesSync(path.join(dup.root, 'sectors/dev-b/gotchas.md'), old, old);
    fs.utimesSync(path.join(dup.root, 'sectors/dev-a/gotchas.md'), new Date(), new Date());
    const t = transcript([claudeText('📎 saved: [[gotchas]]')]);
    assert.equal(hasProblems(checkCitations(dup, { transcript: t, since: Date.now() - 60000 })), false);
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
