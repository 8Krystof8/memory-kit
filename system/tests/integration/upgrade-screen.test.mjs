// The upgrade screen: `upgrade` in a terminal (stdin and stdout TTYs) draws the plan as counts,
// "What's new" from the target's CHANGELOG.md, asks before it applies (instead of "run again
// with --yes"), and ends with a box holding the backup id and the undo command. Runs the
// command in-process on a fake TTY against a vault of this kit and a synthetic next kit, and
// (on Linux, with util-linux script) as a process in a real pseudo-terminal: the vault's own CLI
// hands over to the newer upgrader on the same terminal, an Enter typed while it plans does not
// answer its question, and the exit code passes through. The plain output without a terminal is
// covered byte for byte by upgrade.test.mjs.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { run, showResult } from '../../lib/commands/upgrade.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { createUI } from '../../lib/tui.mjs';
import { KEY, fakeTerminal, screen } from '../fake-terminal.mjs';
import { TODAY, cloneDir, copyKit, readFile, removeTmpDirs, tmpDir, writeFile } from '../helpers.mjs';

after(removeTmpDirs);

const CUR = fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
const [MAJ, MIN, PAT] = CUR.split('.').map(Number);
const NXT = `${MAJ}.${MIN}.${PAT + 1}`;
const SCRUB = ['MEMORY_KIT_UPGRADE_PARENT', 'CLAUDE_CODE_REMOTE', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT'];
// A pseudo-terminal without dependencies: util-linux `script -qec <command> /dev/null` (its exit
// code is the command's). BSD script on macOS takes other arguments; Windows has none.
const PTY = process.platform === 'linux' && spawnSync('script', ['-qec', 'true', '/dev/null'], { stdio: 'ignore' }).status === 0;

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

  test('a failed restore: the recovery command after the box, whole and unwrapped', () => {
    const term = fakeTerminal({ columns: 80, rows: 40 });
    const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env: { TERM: 'xterm-256color' }, platform: 'linux', color: false });
    const command = 'node "C:\\Users\\Jan Novák\\Downloads\\memory-kit-0.1.3\\system\\memory.mjs" upgrade --rollback 20260925-164749-0.1.2-to-0.1.3 --root "C:\\Users\\Jan Novák\\Documents\\Moje paměť"';
    const result = { applied: false, rolledBack: false, backup: '20260925-164749-0.1.2-to-0.1.3', failure: { step: 'verify', detail: 'check exited 1', restore: 'EBUSY' } };
    showResult(ui, null, { from: '0.1.2', to: '0.1.3' }, result, { recover: () => command });
    const shown = screen(term.output());
    assert.ok(shown.includes('restoring the backup failed as well (EBUSY); the command below this box'), shown);
    assert.ok(shown.endsWith(`╯\n│    ${command}\n`), shown);
    const box = shown.slice(0, shown.lastIndexOf('╯'));
    assert.ok(!box.includes('--rollback'), 'the command is not inside the box');
  });

  test('in a real terminal: the hand-over draws the newer screen, a typed-ahead Enter does not answer', { skip: !PTY && 'needs util-linux script' }, async () => {
    const root = vaultCopy('scr-pty');
    const env = { ...process.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };
    for (const key of [...SCRUB, 'CI', 'NO_COLOR', 'FORCE_COLOR']) delete env[key];
    const quoted = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const command = [process.execPath, path.join(root, 'system', 'memory.mjs'), 'upgrade', '--from', NEXT].map(quoted).join(' ');
    const child = spawn('script', ['-qec', command, '/dev/null'], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = setTimeout(() => child.kill('SIGKILL'), 90000);
    let out = '';
    let answered = false;
    child.stdin.write('\r'); // typed while the upgrade starts: before any question is on the screen
    child.stdout.on('data', (d) => {
      out += d;
      if (!answered && out.includes('now?')) {
        answered = true;
        setTimeout(() => child.stdin.write('n'), 400);
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(kill);
    child.stdin.destroy();
    const shown = screen(out.replace(/\r\n/g, '\n'));
    assert.equal(code, 0, shown);
    assert.ok(shown.includes(`┌  memory-kit ${CUR} → ${NXT}`), shown);
    assert.ok(shown.includes(`◇  Upgrade to ${NXT} now?\n│  No\n│\n└  Nothing changed.`), shown);
    assert.equal(readFile(root, 'system/VERSION').trim(), CUR);
    assert.ok(out.lastIndexOf('\x1b[?25h') > out.lastIndexOf('\x1b[?25l'), 'the cursor is shown at the end');
  });

  test('in a real terminal: the newer upgrader\'s exit code passes through the hand-over', { skip: !PTY && 'needs util-linux script' }, async () => {
    const root = vaultCopy('scr-pty-blocked');
    fs.appendFileSync(path.join(root, 'system', 'lib', 'fingerprint.mjs'), '// my change\n');
    const env = { ...process.env, TERM: 'xterm-256color' };
    for (const key of [...SCRUB, 'CI']) delete env[key];
    const res = spawnSync('script', ['-qec', `'${process.execPath}' '${path.join(root, 'system', 'memory.mjs')}' upgrade --from '${NEXT}'`, '/dev/null'], {
      cwd: root, env, encoding: 'utf8', input: '', timeout: 90000,
    });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.ok(screen(res.stdout.replace(/\r\n/g, '\n')).includes('└  the upgrade cannot run yet'), res.stdout);
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
