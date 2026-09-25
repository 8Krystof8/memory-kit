// The upgrade screen: `upgrade` in a terminal (stdin and stdout TTYs) draws the plan as counts,
// "What's new" from the target's CHANGELOG.md, asks before it applies (instead of "run again
// with --yes"), and ends with a box holding the backup id and the undo command. Runs the
// command in-process on a fake TTY against a vault of this kit and a synthetic next kit. The
// plain output without a terminal is covered byte for byte by upgrade.test.mjs.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from '../../lib/commands/upgrade.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createUI } from '../../lib/tui.mjs';
import { KEY, fakeTerminal, screen } from '../fake-terminal.mjs';
import { TODAY, cloneDir, copyKit, readFile, removeTmpDirs, tmpDir, writeFile } from '../helpers.mjs';

after(removeTmpDirs);

const CUR = fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
const [MAJ, MIN, PAT] = CUR.split('.').map(Number);
const NXT = `${MAJ}.${MIN}.${PAT + 1}`;
const SCRUB = ['MEMORY_KIT_UPGRADE_PARENT', 'CLAUDE_CODE_REMOTE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'];

function node(script, args, cwd) {
  const env = { ...process.env };
  for (const key of SCRUB) delete env[key];
  const res = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `${script} ${args.join(' ')}\n${res.stdout}${res.stderr}`);
  return res;
}

const release = (dir) => node(path.join(dir, 'system', 'tools', 'release.mjs'), ['--root', dir], dir);

let SRC;
let NEXT;
let VAULT;

before(() => {
  SRC = path.join(tmpDir('scr-src'), 'kit');
  copyKit(SRC);
  release(SRC);
  NEXT = path.join(tmpDir('scr-next'), 'kit');
  cloneDir(SRC, NEXT);
  writeFile(NEXT, 'system/VERSION', `${NXT}\n`);
  for (const lang of ['en', 'cs']) {
    const rel = `system/templates/${lang}/kit/agents-system.md`;
    const text = readFile(NEXT, rel);
    const nl = text.indexOf('\n');
    writeFile(NEXT, rel, text.slice(0, nl).replace(/v\d+\.\d+\.\d+/, `v${NXT}`) + text.slice(nl));
  }
  fs.appendFileSync(path.join(NEXT, 'system', 'lib', 'fingerprint.mjs'), `// ${NXT}\n`);
  writeFile(NEXT, 'system/lib/next-extra.mjs', 'export const NEXT = true;\n');
  const log = readFile(NEXT, 'CHANGELOG.md').replace('## Unreleased\n\nNothing yet.\n', [
    '## Unreleased', '', 'Nothing yet.', '',
    `## ${NXT} (2026-10-01)`, '', '### Added', '',
    '- **A setup wizard** in the terminal. It asks one question per screen.',
    '- **`upgrade`** shows what is new: the headlines of this file.', '',
    '### Kit files', '', '- New: `system/lib/next-extra.mjs`.', '',
  ].join('\n'));
  writeFile(NEXT, 'CHANGELOG.md', log);
  release(NEXT);
  VAULT = path.join(tmpDir('scr-vault'), 'vault');
  cloneDir(SRC, VAULT);
  node(path.join(VAULT, 'system', 'init.mjs'), ['--mode', 'github', '--lang', 'en', '--sectors', 'core,work', '--today', TODAY, '--yes', '--root', VAULT], VAULT);
});

const vaultCopy = (label) => cloneDir(VAULT, path.join(tmpDir(label), 'vault'));

/** upgrade in-process on a fake terminal → { code, shown, term, root }. */
async function upgrade(label, args, keys = [], { kitRoot = NEXT, root = vaultCopy(label) } = {}) {
  const term = fakeTerminal({ columns: 100, rows: 40 });
  const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env: { TERM: 'xterm-256color' }, platform: 'linux', color: false });
  term.keys(...keys);
  const code = await run(args, loadConfig(root), { root, kitRoot, ui });
  return { code, shown: screen(term.output()), term, root };
}

describe('upgrade in a terminal', { concurrency: 1 }, () => {
  test('plan as counts, what is new, a question, then the result box', async () => {
    const { code, shown, term, root } = await upgrade('scr-yes', [], [KEY.enter]);
    assert.equal(code, 0, shown);
    assert.ok(shown.startsWith(`┌  memory-kit ${CUR} → ${NXT}\n│\n◇  Plan\n`), shown);
    assert.match(shown, /│  \+ 1 new {3}~ \d+ changed {3}· \d+ unchanged\n/);
    assert.ok(shown.includes('│  ~ AGENTS.md: the kit section is updated, your text around it stays'), shown);
    assert.ok(shown.includes('│  the file lists: add --verbose'), shown);
    assert.match(shown, new RegExp(`●  What's new in ${NXT.replace(/\./g, '\\.')} ─+╮\\n│ +│\\n│  • A setup wizard in the terminal +│\\n│  • upgrade shows what is new +│`));
    assert.ok(shown.includes(`◇  Upgrade to ${NXT} now?\n│  Yes`), shown);
    assert.ok(shown.includes(`◇  Upgraded ${CUR} → ${NXT}`), shown);
    const backup = /backup: (\S+)/.exec(shown)?.[1];
    assert.ok(backup, shown);
    assert.match(shown, new RegExp(`◇  memory-kit ${NXT.replace(/\./g, '\\.')} is installed ─+╮`));
    assert.ok(shown.includes('verified with the vault\'s own commands'), shown);
    assert.ok(shown.includes(`upgrade --rollback ${backup}`), 'the undo command names the backup');
    assert.ok(shown.endsWith('└  Done.\n\n'), shown.slice(-100));
    assert.equal(readFile(root, 'system/VERSION').trim(), NXT);
    assert.equal(term.raw.at(-1), false, 'raw mode is off');
    assert.ok(!shown.includes('--yes'), 'no "run again with --yes"');
  });

  test('No at the question changes nothing', async () => {
    const { code, shown, root } = await upgrade('scr-no', [], ['n']);
    assert.equal(code, 0, shown);
    assert.ok(shown.includes(`◇  Upgrade to ${NXT} now?\n│  No\n│\n└  Nothing changed.`), shown);
    assert.equal(readFile(root, 'system/VERSION').trim(), CUR);
  });

  test('Ctrl+C at the question exits 130 and changes nothing', async () => {
    const { code, shown, root } = await upgrade('scr-cancel', [], [KEY.ctrlC]);
    assert.equal(code, 130);
    assert.ok(shown.endsWith('└  Cancelled.\n\n'), shown.slice(-200));
    assert.equal(readFile(root, 'system/VERSION').trim(), CUR);
  });

  test('--yes applies without asking; --verbose lists the files', async () => {
    const { code, shown } = await upgrade('scr-verbose', ['--yes', '--verbose']);
    assert.equal(code, 0, shown);
    assert.ok(!shown.includes('now?'), 'no question with --yes');
    assert.ok(shown.includes('│    + system/lib/next-extra.mjs'), shown);
    assert.ok(shown.includes('│    ~ system/lib/fingerprint.mjs'), shown);
    assert.ok(!shown.includes('add --verbose'), shown);
  });

  test('--dry-run shows the plan and the command, no question', async () => {
    const { code, shown, root } = await upgrade('scr-dry', ['--dry-run']);
    assert.equal(code, 0, shown);
    assert.ok(!shown.includes('now?'));
    assert.match(shown, /●  Plan only, nothing was changed\. To apply it:\n│ {4}node .*upgrade --root .* --yes\n│\n└  Nothing changed\.\n/);
    assert.equal(readFile(root, 'system/VERSION').trim(), CUR);
  });

  test('a blocked plan ends in red with the reason, exit 1', async () => {
    const root = vaultCopy('scr-blocked');
    fs.appendFileSync(path.join(root, 'system', 'lib', 'fingerprint.mjs'), '// my change\n');
    const { code, shown } = await upgrade('scr-blocked', [], [], { root });
    assert.equal(code, 1, shown);
    assert.ok(shown.startsWith(`┌  memory-kit ${CUR} → ${NXT}\n│\n■  Plan\n`), shown);
    assert.ok(shown.includes('│  ✗ system/lib/fingerprint.mjs: changed here; move your change elsewhere or use --force'), shown);
    assert.ok(shown.endsWith('└  the upgrade cannot run yet\n\n'), shown.slice(-200));
    assert.ok(!shown.includes('What\'s new'), 'no notes for a plan that cannot run');
  });

  test('up to date', async () => {
    const root = vaultCopy('scr-current');
    const { code, shown } = await upgrade('scr-current', ['--from', SRC], [], { root, kitRoot: root });
    assert.equal(code, 0, shown);
    assert.equal(shown, `┌  memory-kit ${CUR}\n│\n└  memory-kit ${CUR} is up to date (the source has ${CUR}).\n\n`);
  });

  test('--json never draws the screen', async () => {
    const root = vaultCopy('scr-json');
    const term = fakeTerminal();
    const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env: { TERM: 'xterm-256color' }, platform: 'linux' });
    const writes = [];
    const original = process.stdout.write;
    process.stdout.write = (chunk, ...rest) => {
      writes.push(String(chunk));
      return typeof rest.at(-1) === 'function' ? rest.at(-1)() || true : true;
    };
    let code;
    try {
      code = await run(['--dry-run', '--json'], loadConfig(root), { root, kitRoot: NEXT, ui });
    } finally {
      process.stdout.write = original;
    }
    assert.equal(code, 0);
    assert.equal(term.output(), '');
    assert.equal(JSON.parse(writes.join('')).result.dry_run, true);
  });
});
