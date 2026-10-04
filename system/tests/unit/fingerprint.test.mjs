// fingerprint.mjs: header line and the two fingerprints (docs/architecture.md, 7.5 and 8.1).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  FORMAT_VERSION, contentFingerprint, headerLine, parseHeader, sha256hex, sourceFingerprint, stamp,
} from '../../lib/fingerprint.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const HEADER_RE = /^(?:# )?memory-kit v(\d+) · source ([0-9a-f]{12}) · content ([0-9a-f]{12}) · as-of (\d{4}-\d{2}-\d{2}) · DO NOT EDIT$/;

describe('hashes', () => {
  test('sha256hex of strings and buffers', () => {
    assert.equal(sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(sha256hex(Buffer.from('abc')), sha256hex('abc'));
  });

  test('content = first 12 hex of SHA-256 of the text after the header', () => {
    const body = '# Memory: start\nPaměť\n';
    assert.equal(contentFingerprint(body), sha(Buffer.from(body, 'utf8')).slice(0, 12));
    assert.match(contentFingerprint(''), /^[0-9a-f]{12}$/);
  });
});

describe('source fingerprint (8.1)', () => {
  const inputs = [
    { rel: 'sectors/work/b.md', sha256: sha('b') },
    { rel: 'AGENTS.md', sha256: sha('agents') },
    { rel: 'sectors/work/a.md', sha256: sha('a') },
  ];
  const vault = { inputs };

  test('follows the exact formula', () => {
    const sorted = [...inputs].sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
    let s = '';
    for (const i of sorted) s += `${i.rel}\n${i.sha256}\n`;
    s += 'as-of 2026-09-23\nkit 0.1.0\n';
    assert.equal(sourceFingerprint(vault, '2026-09-23', '0.1.0'), sha(Buffer.from(s, 'utf8')).slice(0, 12));
  });

  test('independent of input order, dependent on content, as-of and kit version', () => {
    const base = sourceFingerprint(vault, '2026-09-23', '0.1.0');
    assert.equal(sourceFingerprint({ inputs: [...inputs].reverse() }, '2026-09-23', '0.1.0'), base);
    assert.notEqual(sourceFingerprint(vault, '2026-09-24', '0.1.0'), base);
    assert.notEqual(sourceFingerprint(vault, '2026-09-23', '0.1.1'), base);
    const changed = inputs.map((i) => (i.rel === 'AGENTS.md' ? { ...i, sha256: sha('edited') } : i));
    assert.notEqual(sourceFingerprint({ inputs: changed }, '2026-09-23', '0.1.0'), base);
    assert.match(base, /^[0-9a-f]{12}$/);
  });
});

describe('header line', () => {
  test('format, with and without the # prefix', () => {
    const line = headerLine({ source: '3f9a2c1b7d0e', content: '8b7e0d4a91c2', asOf: '2026-09-23' });
    assert.equal(line, 'memory-kit v1 · source 3f9a2c1b7d0e · content 8b7e0d4a91c2 · as-of 2026-09-23 · DO NOT EDIT');
    assert.match(line, HEADER_RE);
    const tsv = headerLine({ source: '3f9a2c1b7d0e', content: '8b7e0d4a91c2', asOf: '2026-09-23', prefix: '# ' });
    assert.ok(tsv.startsWith('# memory-kit v1 · '));
    assert.equal(FORMAT_VERSION, 1);
  });

  test('parseHeader round trip and rejection', () => {
    const line = headerLine({ source: 'aaaaaaaaaaaa', content: 'bbbbbbbbbbbb', asOf: '2026-01-02', prefix: '# ' });
    assert.deepEqual(parseHeader(line), { version: 1, source: 'aaaaaaaaaaaa', content: 'bbbbbbbbbbbb', asOf: '2026-01-02' });
    for (const bad of [
      '', 'memory-kit v1', line.replace('DO NOT EDIT', 'do not edit'), line.replace('aaaaaaaaaaaa', 'aaaaaaaaaaa'),
      line.replace('bbbbbbbbbbbb', 'BBBBBBBBBBBB'), `${line} `, `x${line}`,
    ]) {
      assert.equal(parseHeader(bad), null, bad);
    }
  });

  test('stamp puts a verifiable header on top of the body', () => {
    const body = 'line 1\nline 2\n';
    const text = stamp(body, { source: '0123456789ab', asOf: '2026-09-23' });
    const [first, ...rest] = text.split('\n');
    assert.equal(rest.join('\n'), body);
    const h = parseHeader(first);
    assert.equal(h.source, '0123456789ab');
    assert.equal(h.asOf, '2026-09-23');
    assert.equal(h.content, contentFingerprint(body));
    const tsv = stamp(body, { source: '0123456789ab', asOf: '2026-09-23', prefix: '# ' });
    assert.ok(tsv.startsWith('# memory-kit v1 · source 0123456789ab'));
  });
});
