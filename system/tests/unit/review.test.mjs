// Regressions from the review of phase 1: code fences, table links, headings, YAML scalars, line
// ends, as-of, sleeping sectors, the pre-commit hook, the .gitignore block, init guards and sync.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../../lib/frontmatter.mjs';
import { buildContext, renderStart, resolveAsOfInfo, writeGenerated } from '../../lib/generate.mjs';
import { parseNote } from '../../lib/vault.mjs';
import {
  TODAY, bareRoot, checkJson, copyKit, fixtureVault, loadFixture, plantSecret, readFile, removeTmpDirs,
  runCli, runInit, tmpDir, writeFile,
} from '../helpers.mjs';
import { loadConfig } from '../../lib/config.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

function gitEnv() {
  const home = tmpDir('git-home');
  const global = path.join(home, 'gitconfig');
  fs.writeFileSync(global, '');
  return {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'memory-kit test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'memory-kit test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
}

function git(cwd, env, ...args) {
  return spawnSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
}

const note = (fm, body) => `---\n${fm.join('\n')}\n---\n${body}`;

describe('note parsing', () => {
  const cfg = loadConfig(bareRoot('en'));
  const parseBody = (body) => parseNote(cfg, { rel: 'sectors/work/x.md', text: note(['type: fact'], body) });

  test('a ~~~ block that contains ``` closes only on ~~~', () => {
    const n = parseBody('# T\n~~~\n```\n~~~\n## After\nSee [[target-note]].\n\n## Related\n- see_also [[other-note]]\n');
    assert.deepEqual(n.headings.map((h) => h.text), ['After', 'Related']);
    assert.deepEqual(n.links.map((l) => l.target), ['target-note', 'other-note']);
    assert.equal(n.relations.length, 1);
  });

  test('a ````md block keeps an inner ``` example as code', () => {
    const n = parseBody('# T\n````md\n```js\n[[example-target]]\n```\n````\nAfter [[real-target]].\n');
    assert.deepEqual(n.links.map((l) => l.target), ['real-target']);
  });

  test('[[note\\|alias]] in a table links to note', () => {
    const n = parseBody('# T\n| a | [[pricing\\|price list]] | ![[profile\\|small]] |\n');
    assert.deepEqual(n.links.map((l) => [l.target, l.alias]), [['pricing', 'price list'], ['profile', 'small']]);
  });

  test('a # that is part of the heading text stays', () => {
    const n = parseBody('# C#\n\n## Why F#\n## Closed ##\n');
    assert.equal(n.title, 'C#');
    assert.deepEqual(n.headings.map((h) => h.text), ['Why F#', 'Closed']);
  });
});

describe('frontmatter: only valid YAML passes', () => {
  test('plain values that YAML rejects are errors', () => {
    for (const line of ['description: Rule: always X', 'title: @home', 'x: `code`', 'status: active: yes', 'x: Note:']) {
      const fm = parse(`---\n${line}\n---\n`);
      assert.equal(fm.errors.length, 1, line);
    }
    assert.deepEqual(parse('---\ndescription: "Rule: always X"\nurl: https://example.invalid/a\n---\n').errors, []);
  });

  test('keys with spaces or diacritics are accepted', () => {
    const fm = parse('---\ndue date: 2026-10-01\npoznámka: text\n---\n');
    assert.deepEqual(fm.errors, []);
    assert.equal(fm.data['due date'], '2026-10-01');
    assert.equal(fm.data['poznámka'], 'text');
  });
});

describe('time and budgets', () => {
  test('one mistyped future date does not move as-of', async () => {
    const fx = fixtureVault('en');
    writeFile(fx.root, 'sectors/work/typo-date.md', note(['type: insight', 'status: active', 'description: Typo.', 'updated: 2206-09-10'], '# Typo\n'));
    const { cfg, vault } = await loadFixture(fx.root);
    const info = resolveAsOfInfo(cfg, vault);
    assert.equal(info.source, 'notes');
    assert.ok(info.asOf < '2027-01-01', info.asOf);
    const res = checkJson(fx.root, ['--generate', '--strict']);
    assert.ok(res.codes.has('FM_DATE_FUTURE'), [...res.codes].join(' '));
    assert.ok(!res.codes.has('EXPIRED'), 'valid facts stay valid');
  });

  test('many sleeping sectors fold into one line instead of breaking start.md', async () => {
    const fx = fixtureVault('en');
    for (let i = 0; i < 60; i++) {
      const id = `sleepy-${String(i).padStart(2, '0')}`;
      writeFile(fx.root, `sectors/${id}/_${id}.md`, note([
        'type: sector', 'status: active', `description: A sleeping sector number ${i} with a description of about seventy characters.`,
        'updated: 2026-09-01', `keywords: [${id}, a, b, c, d]`, 'state: sleep', 'privacy: github',
        'when_here: Questions about this sleeping sector.', 'not_here: Everything else.',
      ], `# ${id}\n`));
    }
    const { cfg, vault } = await loadFixture(fx.root);
    const ctx = await buildContext(cfg, vault, { today: TODAY });
    const text = renderStart(cfg, vault, ctx);
    assert.ok(Buffer.byteLength(text) <= cfg.budgets.start_bytes[1]);
    assert.match(text, /^Sleeping \(\d+\): /m);
    assert.ok(text.includes('## How to search'), 'the search protocol stays');
    const res = checkJson(fx.root, ['--generate', '--strict', '--today', TODAY]);
    assert.ok(!res.codes.has('GEN_BUDGET'), [...res.codes].join(' '));
  });

  test('start still prints the search protocol when rendering fails', () => {
    const fx = fixtureVault('en');
    writeFile(fx.root, 'memory.json', JSON.stringify({ ...JSON.parse(readFile(fx.root, 'memory.json')), budgets: { start_bytes: [100, 200] } }));
    const res = runCli(fx.root, ['start', '--today', TODAY]);
    assert.equal(res.code, 0);
    assert.match(res.stdout, /start failed/);
    assert.match(res.stdout, /## How to search\n1\. /);
  });
});

describe('line ends and Unicode', () => {
  test('CRLF and NFD notes give the same fingerprint as LF and NFC; check --generate normalizes them', async () => {
    const fx = fixtureVault('cs');
    const { cfg, vault } = await loadFixture(fx.root);
    const first = await writeGenerated(cfg, vault, { today: TODAY });
    const rel = 'sektory/skola/osnova-prace.md';
    const lf = readFile(fx.root, rel);
    writeFile(fx.root, rel, lf.replace(/\n/g, '\r\n').normalize('NFD'));
    const again = await loadFixture(fx.root);
    const ctx = await buildContext(again.cfg, again.vault, { today: TODAY });
    assert.equal(ctx.source, first.source, 'same source fingerprint');
    const res = runCli(fx.root, ['check', '--generate', '--today', TODAY]);
    assert.match(res.stdout, /osnova-prace\.md/);
    assert.equal(readFile(fx.root, rel), lf.normalize('NFC'));
  });
});

describe('new', () => {
  test('a title with $& and $$ is written as typed', () => {
    const fx = fixtureVault('en');
    const res = runCli(fx.root, ['new', 'insight', 'work/cost-notes', '--title', 'Costs in $& and $$ terms', '--today', TODAY, '--force']);
    assert.equal(res.code, 0, res.stderr + res.stdout);
    assert.match(readFile(fx.root, 'sectors/work/cost-notes.md'), /^# Costs in \$& and \$\$ terms$/m);
  });
});

describe('git', { skip: !HAS_GIT && 'git is not installed' }, () => {
  function repo() {
    const env = gitEnv();
    const fx = fixtureVault('en');
    assert.equal(runCli(fx.root, ['check', '--generate', '--today', TODAY]).code, 0);
    fs.mkdirSync(path.join(fx.root, '.githooks'), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, '..', '..', '..', '.githooks', 'pre-commit'), path.join(fx.root, '.githooks', 'pre-commit'));
    fs.chmodSync(path.join(fx.root, '.githooks', 'pre-commit'), 0o755);
    git(fx.root, env, 'init', '-q', '-b', 'main');
    git(fx.root, env, 'config', 'core.hooksPath', '.githooks');
    git(fx.root, env, 'add', '-A');
    const first = git(fx.root, env, 'commit', '-q', '-m', 'vault');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    return { env, root: fx.root };
  }

  test('the hook refuses a commit whose staged file differs from the work tree', () => {
    const { env, root } = repo();
    const rel = 'sectors/work/server-notes.md';
    writeFile(root, rel, note(['type: insight', 'status: active', 'description: Server notes.', 'updated: 2026-09-20'],
      `# Server notes\n\n- deploy key ${plantSecret().github}\n`));
    git(root, env, 'add', rel);
    writeFile(root, rel, readFile(root, rel).split('\n').slice(0, -2).join('\n') + '\n');
    const res = git(root, env, 'commit', '-q', '-m', 'add server notes');
    assert.notEqual(res.status, 0, 'refused');
    assert.match(res.stderr, /commit refused/);
    assert.equal(git(root, env, 'log', '--oneline').stdout.trim().split('\n').length, 1);
  });

  test('the hook stages the regenerated views', () => {
    const { env, root } = repo();
    writeFile(root, 'sectors/work/pricing.md', `${readFile(root, 'sectors/work/pricing.md')}- [fact] 2026-09-20: One more.\n`);
    git(root, env, 'add', 'sectors/work/pricing.md');
    const res = git(root, env, 'commit', '-q', '-m', 'edit');
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.equal(git(root, env, 'status', '--porcelain').stdout.trim(), '');
  });

  test('a note dropped into a local sector folder is ignored by git', () => {
    const { env, root } = repo();
    writeFile(root, 'sectors/health/from-phone.md', '# From the phone\n');
    assert.equal(git(root, env, 'check-ignore', '-q', 'sectors/health/from-phone.md').status, 0);
    assert.notEqual(git(root, env, 'check-ignore', '-q', 'sectors/health/_health.md').status, 0, 'the manifest stays');
    assert.notEqual(git(root, env, 'check-ignore', '-q', 'sectors/health/_health-export.md').status, 0, 'the export stays');
  });

  test('sync does nothing in mode local, even with a remote', () => {
    const { env, root } = repo();
    const remote = path.join(tmpDir('remote'), 'r.git');
    git(path.dirname(remote), env, 'init', '-q', '--bare', remote);
    git(root, env, 'remote', 'add', 'origin', remote);
    const cfg = JSON.parse(readFile(root, 'memory.json'));
    writeFile(root, 'memory.json', `${JSON.stringify({ ...cfg, mode: 'local' }, null, 2)}\n`);
    const res = runCli(root, ['sync'], { env });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /mode local/);
    assert.equal(git(remote, env, 'rev-parse', '--verify', '-q', 'main').status === 0, false, 'nothing pushed');
  });
});

describe('init guards', () => {
  const kit = () => copyKit(path.join(tmpDir('init'), 'vault'));

  test('no editor folder and a plain home page', () => {
    const root = kit();
    const res = runInit(root, ['--mode', 'github', '--lang', 'en', '--sectors', 'core,work', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(!fs.existsSync(path.join(root, '.obsidian')));
    assert.ok(!/obsidian/i.test(res.stdout), res.stdout);
    const home = readFile(root, 'home.md');
    assert.match(home, /^<!-- memory-kit v1 /);
    assert.ok(home.includes('](sectors/work/_work.md)'));
  });

  test('mode github refuses a sector that is local by default, unless written as :github', () => {
    const root = kit();
    const res = runInit(root, ['--mode', 'github', '--lang', 'en', '--sectors', 'core,family', '--today', TODAY, '--yes']);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /family.*--mode combined/s);
    const ok = runInit(root, ['--mode', 'github', '--lang', 'en', '--sectors', 'core,family:github', '--today', TODAY, '--dry-run', '--yes']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.ok(!/private folder/.test(ok.stdout), ok.stdout);
  });

  test('mode local refuses a repository with a remote', { skip: !HAS_GIT && 'git is not installed' }, () => {
    const root = kit();
    const env = gitEnv();
    git(root, env, 'init', '-q', '-b', 'main');
    git(root, env, 'remote', 'add', 'origin', 'https://example.invalid/me/memory.git');
    const res = runInit(root, ['--mode', 'local', '--lang', 'en', '--sectors', 'core,work', '--today', TODAY, '--yes'], { env });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /remote \(origin\)/);
  });

  test('a cloud session refuses local content unless --allow-ephemeral', () => {
    const root = kit();
    const args = ['--mode', 'combined', '--lang', 'en', '--sectors', 'core,work,health', '--today', TODAY, '--yes'];
    const res = runInit(root, args, { env: { CLAUDE_CODE_REMOTE: 'true' } });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /cloud session/);
    assert.equal(runInit(root, [...args, '--allow-ephemeral'], { env: { CLAUDE_CODE_REMOTE: 'true' } }).code, 0);
  });

  test('an absolute private root under the home folder is stored as ~/…', () => {
    const root = kit();
    const home = tmpDir('home');
    const res = runInit(root, ['--mode', 'combined', '--lang', 'en', '--sectors', 'core,work,health',
      '--private-root', path.join(home, 'alice-private'), '--today', TODAY, '--yes'], { env: { HOME: home, USERPROFILE: home } });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const cfg = JSON.parse(readFile(root, 'memory.json'));
    assert.equal(cfg.roots[1].path, '~/alice-private');
    assert.ok(!readFile(root, 'memory.json').includes(os.tmpdir()), 'no absolute path');
  });

  test('mode local: no GitHub app advice for ChatGPT', () => {
    const root = kit();
    const res = runInit(root, ['--mode', 'local', '--lang', 'en', '--sectors', 'core,work', '--agents', 'all', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.ok(!/GitHub app/.test(res.stdout), res.stdout);
  });
});

describe('CI', () => {
  test('a set-up vault in a public repository fails CI', () => {
    const ci = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /public-guard:\n\s+if: \$\{\{ github\.event_name != 'schedule' && github\.event\.repository\.private == false \}\}/);
    assert.match(ci, /cfg\.initialized === true/);
  });
});
