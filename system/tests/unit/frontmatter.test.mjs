// frontmatter.mjs: the YAML subset of notes, quoting, serializing and in-place updates
// (docs/architecture.md, sections 5.1 and 7.3).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, parse, serialize, updateFrontmatter } from '../../lib/frontmatter.mjs';

const doc = (...lines) => `${lines.join('\n')}\n`;

describe('parse: fences', () => {
  test('no frontmatter unless line 1 is exactly ---', () => {
    for (const text of ['# Title\n', ' ---\na: 1\n---\n', '--- \na: 1\n---\n', '\n---\na: 1\n---\n']) {
      const res = parse(text);
      assert.equal(res.has, false, JSON.stringify(text));
      assert.equal(res.body, text);
      assert.equal(res.endLine, 0);
      assert.equal(res.bodyStartLine, 1);
    }
  });

  test('closing fence, body and line numbers', () => {
    const res = parse(doc('---', 'type: decision', 'status: active', '---', '# Title', 'Body'));
    assert.equal(res.has, true);
    assert.deepEqual(res.data, { type: 'decision', status: 'active' });
    assert.equal(res.raw, 'type: decision\nstatus: active');
    assert.equal(res.endLine, 4);
    assert.equal(res.bodyStartLine, 5);
    assert.equal(res.body, '# Title\nBody\n');
    assert.deepEqual(res.keyLines, { type: 2, status: 3 });
    assert.deepEqual(res.errors, []);
  });

  test('an unclosed frontmatter is an error on line 1 and the whole text is body', () => {
    const text = doc('---', 'type: decision', '# Title');
    const res = parse(text);
    assert.equal(res.has, false);
    assert.equal(res.body, text);
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].line, 1);
    assert.match(res.errors[0].msg, /unclosed frontmatter/);
  });

  test('a BOM before the fence is tolerated', () => {
    const res = parse('\uFEFF---\ntype: fact\n---\nbody\n');
    assert.equal(res.has, true);
    assert.equal(res.data.type, 'fact');
  });

  test('empty frontmatter', () => {
    const res = parse(doc('---', '---', 'body'));
    assert.equal(res.has, true);
    assert.deepEqual(res.data, {});
    assert.equal(res.bodyStartLine, 3);
  });
});

describe('parse: scalars', () => {
  const one = (value) => parse(doc('---', `k: ${value}`, '---')).data.k;

  test('double-quoted with escapes', () => {
    assert.equal(one('"a \\"quoted\\" word"'), 'a "quoted" word');
    assert.equal(one('"back\\\\slash"'), 'back\\slash');
    assert.equal(one('"line\\nbreak\\ttab"'), 'line\nbreak\ttab');
    assert.equal(one('"a: b # not a comment"'), 'a: b # not a comment');
  });

  test("single-quoted with '' escape", () => {
    assert.equal(one("'it''s here'"), "it's here");
    assert.equal(one("'[not a list]'"), '[not a list]');
  });

  test('booleans, integers, dates and plain strings', () => {
    assert.equal(one('true'), true);
    assert.equal(one('false'), false);
    assert.equal(one('42'), 42);
    assert.equal(one('-7'), -7);
    assert.equal(one('2026-09-23'), '2026-09-23');
    assert.equal(one('3.14'), '3.14');
    assert.equal(one('  padded text  '), 'padded text');
    assert.equal(one('Příliš žluťoučký kůň'), 'Příliš žluťoučký kůň');
  });

  test('a trailing comment of a plain scalar is stripped, a # inside a word is kept', () => {
    assert.equal(one('value # comment'), 'value');
    assert.equal(one('C#sharp'), 'C#sharp');
    assert.equal(one('issue#12 # note'), 'issue#12');
  });

  test('key: with nothing after it is null', () => {
    const res = parse(doc('---', 'a:', 'b: x', '---'));
    assert.equal(res.data.a, null);
    assert.equal(res.data.b, 'x');
  });
});

describe('parse: lists', () => {
  test('flow lists keep commas inside quotes', () => {
    const res = parse(doc('---', `tags: [a, "b, c", 'd', 2026-09-23, "[[link]]"]`, 'empty: []', '---'));
    assert.deepEqual(res.data.tags, ['a', 'b, c', 'd', '2026-09-23', '[[link]]']);
    assert.deepEqual(res.data.empty, []);
  });

  test('block lists, indented or directly under the key', () => {
    const res = parse(doc('---', 'a:', '  - one', '  - "two, three"', 'b:', '- x', '- y', 'c: z', '---'));
    assert.deepEqual(res.data.a, ['one', 'two, three']);
    assert.deepEqual(res.data.b, ['x', 'y']);
    assert.equal(res.data.c, 'z');
    assert.deepEqual(res.errors, []);
  });

  test('blank lines and full-line comments are skipped', () => {
    const res = parse(doc('---', '# a comment', 'a: 1', '', '  # indented comment', 'b: 2', '---'));
    assert.deepEqual(res.data, { a: 1, b: 2 });
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.keyLines, { a: 3, b: 6 });
  });
});

describe('parse: unsupported YAML never throws', () => {
  test('nested maps and block scalars become errors with the raw text kept as a string', () => {
    const text = doc('---', 'ok: 1', 'nested:', '  child: value', 'block: |', '  text', 'anchor: &a x', '---', 'body');
    let res;
    assert.doesNotThrow(() => {
      res = parse(text);
    });
    assert.equal(res.has, true);
    assert.equal(res.data.ok, 1);
    assert.ok(res.errors.length >= 2, JSON.stringify(res.errors));
    for (const e of res.errors) {
      assert.equal(typeof e.line, 'number');
      assert.equal(typeof e.msg, 'string');
    }
    assert.equal(typeof res.data.block, 'string');
    assert.equal(typeof res.data.anchor, 'string');
    assert.equal(res.body, 'body\n');
  });

  test('a duplicate key is an error and the last value wins', () => {
    const res = parse(doc('---', 'a: first', 'a: second', '---'));
    assert.equal(res.data.a, 'second');
    assert.equal(res.errors.length, 1);
    assert.equal(res.errors[0].line, 3);
  });

  test('garbage input is survivable', () => {
    for (const text of ['', '---', '---\n', '---\n---', '---\n: no key\n---\n', '---\n[x]\n---\n']) {
      assert.doesNotThrow(() => parse(text), JSON.stringify(text));
    }
  });
});

describe('formatValue and serialize', () => {
  test('plain strings stay plain', () => {
    for (const s of ['decision', 'Harbor Bakery', 'Příliš žluťoučký', '2026-09-23', 'C#sharp', 'a-b']) {
      assert.equal(formatValue(s), s);
    }
  });

  test('strings that YAML would misread are double-quoted', () => {
    const quoted = ['', 'a: b', 'a #b', '[x]', '{x}', '-x', '? x', ':x', '#x', '@x', '`x', "'x", '"x',
      '%x', '&x', '*x', '!x', '|x', '>x', ',x', ' x', 'x ', 'true', 'False', 'null', 'yes', 'No', '~', '42', '3.14'];
    for (const s of quoted) {
      const out = formatValue(s);
      assert.ok(out.startsWith('"') && out.endsWith('"'), `${JSON.stringify(s)} -> ${out}`);
      assert.equal(parse(doc('---', `k: ${out}`, '---')).data.k, s, `round trip of ${JSON.stringify(s)}`);
    }
  });

  test('booleans, numbers and flow lists', () => {
    assert.equal(formatValue(true), 'true');
    assert.equal(formatValue(false), 'false');
    assert.equal(formatValue(7), '7');
    assert.equal(formatValue(['a', 'b, c', 'd]']), '[a, "b, c", "d]"]');
    assert.equal(formatValue([]), '[]');
  });

  test('serialize writes the fences, key order and empty values', () => {
    const text = serialize({ status: 'active', type: 'decision', pin: true, x: null, tags: ['a'] },
      { order: ['type', 'status'] });
    assert.equal(text, '---\ntype: decision\nstatus: active\npin: true\nx:\ntags: [a]\n---\n');
  });

  test('round trip: parse(serialize(d)).data equals d', () => {
    const d = {
      type: 'decision',
      description: 'Klient: "Harbor" #1, [draft]',
      updated: '2026-09-23',
      aliases: ['Pekárna U Přístavu', 'a, b', 'x]', 'true', ''],
      keywords: [],
      pin: false,
      hot_max: 3,
      spaces: '  lead',
      quote: "it's",
      backslash: 'a\\b',
    };
    assert.deepEqual(parse(serialize(d)).data, d);
  });
});

describe('updateFrontmatter', () => {
  const original = doc(
    '---',
    'type: fact',
    '# keep this comment',
    'description: Old text',
    'tags:',
    '  - a',
    '  - b',
    'custom:   spaced   # comment',
    '---',
    '# Title',
    'Body line',
  );

  test('changes only the patched lines and leaves every other byte alone', () => {
    const out = updateFrontmatter(original, { description: 'New text' });
    assert.equal(out, original.replace('description: Old text', 'description: New text'));
  });

  test('a block list is replaced whole by a flow list', () => {
    const out = updateFrontmatter(original, { tags: ['x', 'y, z'] });
    assert.equal(out, original.replace('tags:\n  - a\n  - b\n', 'tags: [x, "y, z"]\n'));
  });

  test('new keys go before the closing fence in the given order', () => {
    const out = updateFrontmatter(original, { zeta: 'z', updated: '2026-09-23' }, { order: ['type', 'updated', 'zeta'] });
    const fm = out.split('---\n')[1];
    assert.ok(fm.endsWith('updated: 2026-09-23\nzeta: z\n'), fm);
    assert.ok(out.endsWith('---\n# Title\nBody line\n'));
    assert.ok(out.includes('# keep this comment\n'));
  });

  test('undefined removes a present key; null writes an empty value', () => {
    const removed = updateFrontmatter(original, { description: undefined });
    assert.ok(!removed.includes('description'));
    assert.equal(updateFrontmatter(original, { missing: undefined }), original);
    const emptied = updateFrontmatter(original, { description: null });
    assert.ok(emptied.includes('\ndescription:\n'), emptied);
  });

  test('without frontmatter the patch is prepended', () => {
    const out = updateFrontmatter('# Title\n', { type: 'fact', status: 'active' }, { order: ['type', 'status'] });
    assert.equal(out, '---\ntype: fact\nstatus: active\n---\n# Title\n');
  });

  test('the result parses back to the patched data', () => {
    const out = updateFrontmatter(original, { description: 'a: b', tags: ['one'] });
    const res = parse(out);
    assert.equal(res.data.description, 'a: b');
    assert.deepEqual(res.data.tags, ['one']);
    assert.equal(res.data.type, 'fact');
    assert.equal(res.data.custom, 'spaced');
  });
});
