// The capture check (lib/capture.mjs): which owner messages read like a decision or a correction,
// in both languages, which transcript lines are the owner's, and that a changed note answers it.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkCapture, ownerMessages, signalIn } from '../../lib/capture.mjs';
import { removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const owner = (content) => ({ type: 'user', message: { role: 'user', content } });

function transcript(entries) {
  const file = path.join(tmpDir('capture-t'), 't.jsonl');
  fs.writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  return file;
}

describe('capture', () => {
  test('signals in English and Czech, with or without accents; ordinary requests carry none', () => {
    assert.match(signalIn('Thanks. From now on, always use pnpm here.'), /^From now on/);
    assert.ok(signalIn("Let's go with Postgres."));
    assert.ok(signalIn("No, that's wrong: the price is 4 €."));
    assert.ok(signalIn('Rozhodli jsme se pro Apache licenci.'));
    assert.ok(signalIn('od teď piš commity česky'));
    assert.ok(signalIn('To je špatně, cena je 4 €.'));
    assert.equal(signalIn('Please fix the failing test in cart.js.'), '');
    assert.equal(signalIn('Pracuj dál a spusť testy.'), '');
  });

  test('only the owner speaks: tool results, injected tags, meta and sidechain lines are left out', () => {
    const got = ownerMessages([
      owner('from now on use tabs'),
      owner([{ type: 'tool_result', content: 'from now on X' }, { type: 'text', text: 'plain' }]),
      owner('<command-name>/clear</command-name>'),
      { ...owner('from now on Y'), isMeta: true },
      { ...owner('from now on Z'), isSidechain: true },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'od teď česky' }] } },
    ]);
    assert.deepEqual(got, ['from now on use tabs', 'plain', 'od teď česky']);
  });

  test('a decision with no note changed is asked; a note changed since the start answers it', () => {
    const root = tmpDir('capture-vault');
    const note = path.join(root, 'sectors', 'core', 'stack.md');
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(note, 'x');
    fs.writeFileSync(path.join(root, 'home.md'), 'generated');
    const cfg = { root, roots: [{ id: 'main', path: root }], dirs: { sectors: 'sectors', inbox: 'inbox', journal: 'journal' } };
    const t = transcript([owner("Let's go with Postgres.")]);
    assert.deepEqual(checkCapture(cfg, { transcript: t, since: Date.now() + 60000 }), { quote: "Let's go with Postgres." }, 'home.md does not count');
    assert.equal(checkCapture(cfg, { transcript: t, since: 0 }), null, 'stack.md changed after the start');
    assert.equal(checkCapture(cfg, { transcript: transcript([owner('fix the test')]) }), null);
    assert.equal(checkCapture(cfg, { transcript: '/nonexistent.jsonl' }), null);
  });
});
