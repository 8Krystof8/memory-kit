// secrets.mjs: patterns, masking and the scanned file set (docs/architecture.md, section 12).
// Every fake credential here is assembled at runtime so this file never matches a pattern itself.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SECRET_RULES, listTextFiles, mask, scanFiles, scanText } from '../../lib/secrets.mjs';
import { KIT_ROOT, plantSecret, removeTmpDirs, tmpDir, writeFile } from '../helpers.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version']).status === 0;
const rep = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

// One sample per rule id, built from pieces.
const SAMPLES = {
  'aws-access-key': 'AK' + 'IA' + rep('Q7ZX2M4K', 16),
  'github-token': 'gh' + 'p_' + rep('aB3dE5fG7h', 36),
  'anthropic-key': 'sk-' + 'ant-' + 'api03-' + rep('Xy9_Zw8-Vu7', 40),
  'openai-key': 'sk-' + 'proj-' + rep('Ab1Cd2Ef3Gh4', 40),
  'google-api-key': 'AI' + 'za' + rep('Sy9-Kd8_Lm7N', 35),
  'slack-token': 'xox' + 'b-' + rep('1234567890-Ab', 30),
  'stripe-live': 'sk_' + 'live_' + rep('51HzQ9Rt', 24),
  'private-key': '-----BEGIN ' + 'RSA ' + 'PRIVATE KEY-----',
  jwt: 'ey' + 'J' + rep('hbGciOiJIUzI1', 20) + '.' + 'ey' + 'J' + rep('zdWIiOiIxMjM0', 20) + '.' + rep('SflKxwRJSMeK', 30),
  'generic-assignment': 'to' + 'ken: "' + rep('Tr0ub4dor3xyz', 20) + '"',
  'password-assignment': 'pass' + 'word: "' + rep('Tr0ub4dor3xyz', 20) + '"',
  'gitlab-token': 'gl' + 'pat-' + rep('Ab1_cD2-eF3', 20),
  'npm-token': 'np' + 'm_' + rep('Ab1cD2eF3gH4', 36),
  'huggingface-token': 'h' + 'f_' + rep('AbcDefGhiJkl', 34),
  'sendgrid-key': 'S' + 'G.' + rep('Ab1_cD2-eF3', 22) + '.' + rep('Gh4_iJ5-kL6', 43),
  'google-oauth-token': 'ya' + '29.' + rep('Ab1_cD2-eF3', 40),
};

describe('rules (12.1)', () => {
  test('every rule id of the contract exists', () => {
    const ids = new Set(SECRET_RULES.map((r) => r.id));
    for (const id of Object.keys(SAMPLES)) assert.ok(ids.has(id), id);
  });

  for (const [id, sample] of Object.entries(SAMPLES)) {
    test(`${id} is detected`, () => {
      const found = scanText(`some text before\nvalue ${sample} end\n`);
      const hit = found.find((f) => f.rule === id);
      assert.ok(hit, `${id} not found in ${JSON.stringify(found)}`);
      assert.equal(hit.line, 2);
      assert.equal(typeof hit.col, 'number');
    });
  }

  test('a second github token shape: fine-grained personal access token', () => {
    const token = 'github_' + 'pat_' + rep('11ABCDEFG0_abcdefghij', 60);
    assert.ok(scanText(token).some((f) => f.rule === 'github-token'));
  });

  test('an anthropic key is not reported as an openai key', () => {
    const found = scanText(SAMPLES['anthropic-key']);
    assert.ok(found.some((f) => f.rule === 'anthropic-key'));
    assert.ok(!found.some((f) => f.rule === 'openai-key'), JSON.stringify(found));
  });

  test('word boundaries: a key glued to other letters is not a match', () => {
    assert.deepEqual(scanText(`X${SAMPLES['aws-access-key']}`).filter((f) => f.rule === 'aws-access-key'), []);
    assert.deepEqual(scanText(`${SAMPLES['aws-access-key']}9`).filter((f) => f.rule === 'aws-access-key'), []);
  });

  test('generic assignment needs 16+ chars with a letter and a digit, and no placeholder', () => {
    const key = 'to' + 'ken';
    const quiet = [
      `${key}: short1`,
      `${key}: ${rep('abcdefgh', 24)}`,
      `${key}: ${rep('12345678', 24)}`,
      `${key}: \${{ secrets.DEPLOY_KEY_2026 }}`,
      `${key}: <your-key-goes-here-12345>`,
      `${key}=$DEPLOY_KEY_2026_VALUE`,
      `${key} = process.env.DEPLOY_KEY_2026`,
    ];
    for (const line of quiet) assert.deepEqual(scanText(line), [], line);
    assert.equal(scanText(`hes` + `lo = ${rep('Abc123', 18)}`).length, 1, 'Czech keyword heslo');
    assert.equal(scanText(`API_` + `KEY=${rep('Abc123', 18)}`).length, 1);
  });

  test('passwords: 8+ chars with a letter and a digit, also under DB_PASS and the like', () => {
    assert.equal(scanText('pass' + 'word: ' + 'Kocicka2026!')[0]?.rule, 'password-assignment');
    assert.equal(scanText('DB_' + 'PASS=' + 'Kocicka2026abc')[0]?.rule, 'password-assignment');
    for (const line of ['pass' + 'word: see the manager', 'passport: ' + 'Ab12345678', 'bypass: ' + 'Ab12345678', 'pass' + 'word: short1']) {
      assert.deepEqual(scanText(line), [], line);
    }
  });

  test('a line marked memory-kit:allow-secret is skipped', () => {
    const marker = 'memory-kit:' + 'allow-secret';
    assert.deepEqual(scanText(`${SAMPLES['aws-access-key']} <!-- ${marker} -->`), []);
  });
});

describe('masking', () => {
  test('mask keeps 4 chars and the length', () => {
    assert.equal(mask('abcdefghij'), 'abcd…(10)');
    assert.equal(mask('ščřžýáíéůú'), 'ščřž…(10)');
  });

  test('findings never contain the full value', () => {
    for (const sample of plantSecret().all) {
      const [hit] = scanText(`key ${sample}`);
      assert.ok(hit, sample.slice(0, 4));
      assert.equal(hit.preview, mask(sample));
      assert.ok(!JSON.stringify(hit).includes(sample));
    }
  });
});

describe('scanned files (12.2)', () => {
  function makeTree() {
    const root = tmpDir('secrets');
    writeFile(root, 'notes/a.md', 'plain\n');
    writeFile(root, 'data/b.json', '{}\n');
    writeFile(root, 'data/c.tsv', 'x\n');
    writeFile(root, 'image.png', 'not text\n');
    writeFile(root, '.githooks/pre-commit', '#!/bin/sh\n');
    writeFile(root, 'bin/tool', 'no extension\n');
    writeFile(root, 'node_modules/pkg/index.js', 'skipped\n');
    writeFile(root, '.cache/x.md', 'skipped\n');
    writeFile(root, 'big.md', 'x'.repeat(1024 * 1024 + 1));
    return root;
  }

  test('outside git: a walk over every file that skips heavy folders', () => {
    const root = makeTree();
    assert.deepEqual(listTextFiles(root),
      ['.githooks/pre-commit', 'big.md', 'bin/tool', 'data/b.json', 'data/c.tsv', 'image.png', 'notes/a.md']);
  });

  test('inside git: tracked and untracked files, ignored ones left out', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const root = makeTree();
    spawnSync('git', ['init', '-q'], { cwd: root });
    writeFile(root, '.gitignore', 'data/c.tsv\n');
    const files = listTextFiles(root);
    assert.ok(files.includes('notes/a.md'));
    assert.ok(files.includes('.githooks/pre-commit'));
    assert.ok(files.includes('big.md'), 'large files are scanned too');
    assert.ok(!files.includes('data/c.tsv'), 'ignored by .gitignore');
  });

  test('any text file is scanned whatever its name; binary files are skipped', () => {
    const root = tmpDir('secrets');
    const { github } = plantSecret();
    const line = `GITHUB_${'TO' + 'KEN'}=${github}\n`;
    for (const rel of ['.env', 'attachments/deploy.env', 'config.ini', 'notes.html', 'script.py', 'secrets', 'creds.xml']) {
      writeFile(root, rel, line);
    }
    writeFile(root, 'attachments/deploy.pem', `${'-----BEGIN '}OPENSSH ${'PRIVATE KEY-----'}\nAAAA\n`);
    writeFile(root, 'attachments/photo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from(line)]));
    const found = new Set(scanFiles(root).map((f) => f.rel));
    for (const rel of ['.env', 'attachments/deploy.env', 'config.ini', 'notes.html', 'script.py', 'secrets', 'creds.xml', 'attachments/deploy.pem']) {
      assert.ok(found.has(rel), rel);
    }
    assert.ok(!found.has('attachments/photo.png'), 'binary');
  });

  test('a note over 1 MB is scanned, not skipped', () => {
    const root = tmpDir('secrets');
    const { github } = plantSecret();
    writeFile(root, 'sectors/work/big-log.md', `${'filler line\n'.repeat(100000)}key ${github}\n`);
    const found = scanFiles(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].rel, 'sectors/work/big-log.md');
  });

  test('scanFiles reports rel paths', () => {
    const root = tmpDir('secrets');
    const { aws } = plantSecret();
    writeFile(root, 'sectors/work/api.md', `line 1\nkey ${aws}\n`);
    const found = scanFiles(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].rel, 'sectors/work/api.md');
    assert.equal(found[0].rule, 'aws-access-key');
    assert.equal(found[0].line, 2);
  });

  test('the kit itself contains no secrets', () => {
    const rels = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(KIT_ROOT, rel), { withFileTypes: true })) {
        if (['.git', 'node_modules'].includes(e.name)) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(child);
        else rels.push(child);
      }
    };
    walk('');
    const found = scanFiles(KIT_ROOT, rels);
    assert.deepEqual(found.map((f) => `${f.rel}:${f.line} ${f.rule}`), []);
  });
});
