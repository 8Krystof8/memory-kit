// The merge of a note both sides only added to (lib/appendmerge.mjs).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdditions } from '../../lib/appendmerge.mjs';

const note = (updated, body) => `---\ntype: list\nupdated: ${updated}\n---\n# Gotchas\n\n${body}`;

describe('mergeAdditions', () => {
  test('lines added at the end, in the middle and under a heading by both sides', () => {
    const base = note('2026-09-01', '## Build\n- a\n\n## Deploy\n- d\n');
    const up = note('2026-09-03', '## Build\n- a\n- b (up)\n\n## Deploy\n- d\n');
    const re = note('2026-09-02', '## Build\n- a\n\n## Deploy\n- d\n- e (re)\n');
    assert.equal(mergeAdditions(base, up, re), note('2026-09-03', '## Build\n- a\n- b (up)\n\n## Deploy\n- d\n- e (re)\n'));
  });

  test('both sides add at the same place: upstream first; the same line added twice is kept once', () => {
    const base = '# L\n- a\n';
    assert.equal(mergeAdditions(base, '# L\n- a\n- up\n', '# L\n- a\n- re\n'), '# L\n- a\n- up\n- re\n');
    assert.equal(mergeAdditions(base, '# L\n- a\n- same\n', '# L\n- a\n- same\n'), '# L\n- a\n- same\n');
  });

  test('a changed or removed line on either side is not merged', () => {
    const base = '# L\n- a\n- b\n';
    assert.equal(mergeAdditions(base, '# L\n- a\n- B\n', '# L\n- a\n- b\n- c\n'), null);
    assert.equal(mergeAdditions(base, '# L\n- a\n- b\n- c\n', '# L\n- b\n'), null);
    assert.equal(mergeAdditions(null, 'x', 'y'), null, 'a file added on both sides has no base');
  });

  test('a key added by one side is kept as a line, not mistaken for the common date', () => {
    assert.equal(mergeAdditions('---\ntype: list\n---\n- a\n', '---\ntype: list\nupdated: 2026-09-02\n---\n- a\n', '---\ntype: list\n---\n- a\n- b\n'),
      '---\ntype: list\nupdated: 2026-09-02\n---\n- a\n- b\n');
  });

  test('CRLF stays CRLF', () => {
    assert.equal(mergeAdditions('a\r\n', 'a\r\nb\r\n', 'a\r\nc\r\n'), 'a\r\nb\r\nc\r\n');
  });
});
