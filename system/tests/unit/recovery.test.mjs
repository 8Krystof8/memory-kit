// What is left when something stops half way. An upgrade killed while it replaces the kit files
// leaves its lock, and the vault's own code may then crash on import: the CLI says how to undo the
// upgrade with the tool the upgrade keeps in its backup, which needs none of the vault's code (an
// upgrade still at work is left alone). And a failed atomic write never leaves its temporary file.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeAtomic } from '../../lib/fsafe.mjs';
import { fixtureVault, removeTmpDirs, runCli, tmpDir, writeFile, writeJson } from '../helpers.mjs';

after(removeTmpDirs);

const ID = '20260924-100000-0.1.1-to-0.1.2';
const TOOL = `.memory-kit/backups/${ID}/tool/rollback.mjs`;
const HINT = 'memory: the upgrade stopped before it finished; undo it with: node ';

/** The process id of a process that has ended. */
function deadPid() {
  const res = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  return res.pid;
}

/** A fixture vault whose start command cannot load (a half replaced kit), with the lock of an interrupted upgrade. */
function interrupted({ pid = deadPid(), recover = TOOL } = {}) {
  const v = fixtureVault('en');
  writeFile(v.root, 'system/lib/commands/start.mjs', "import { NOT_THERE } from '../util.mjs';\nexport const usage = 'start';\nexport function run() {\n  return NOT_THERE;\n}\n");
  writeFile(v.root, TOOL, '// the recovery tool of this backup\n');
  writeJson(v.root, '.memory-kit/upgrade.lock', {
    backup: ID, from: '0.1.1', to: '0.1.2', started: new Date().toISOString(), pid, host: os.hostname(), recover,
  });
  return v;
}

describe('the CLI after an interrupted upgrade', () => {
  test('an internal error names the recovery tool of the backup', () => {
    const v = interrupted();
    let res = runCli(v.root, ['start']);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /^memory: internal error: .*NOT_THERE/m);
    assert.ok(res.stderr.includes(`${HINT}${TOOL}\n`), res.stderr);
    // From another folder the path leads there as well.
    res = runCli(v.root, ['start'], { cwd: tmpDir('recovery-cwd') });
    assert.equal(res.code, 3);
    assert.ok(res.stderr.includes(`${HINT}${path.join(v.root, ...TOOL.split('/'))}\n`), res.stderr);
  });

  test('a command whose module is gone says the same', () => {
    const v = interrupted();
    fs.rmSync(path.join(v.root, 'system', 'lib', 'commands', 'search.mjs'));
    const res = runCli(v.root, ['search', 'invoice']);
    assert.equal(res.code, 3);
    assert.match(res.stderr, /command "search" is not installed/);
    assert.ok(res.stderr.includes(`${HINT}${TOOL}\n`), res.stderr);
  });

  test('no hint without a lock, without the tool, or for a lock that names another file', () => {
    const v = interrupted();
    fs.rmSync(path.join(v.root, ...TOOL.split('/')));
    assert.ok(!runCli(v.root, ['start']).stderr.includes('undo it'));
    const w = interrupted({ recover: '../outside/rollback.mjs' });
    writeFile(w.base, 'outside/rollback.mjs', '// not a backup of this vault\n');
    assert.ok(!runCli(w.root, ['start']).stderr.includes('undo it'));
    const x = interrupted();
    fs.rmSync(path.join(x.root, '.memory-kit', 'upgrade.lock'));
    const res = runCli(x.root, ['start']);
    assert.equal(res.code, 3);
    assert.ok(!res.stderr.includes('undo it'), res.stderr);
  });

  test('an upgrade still at work is not to be undone: wait for it', async () => {
    // A process whose command line names memory.mjs, like an upgrade does.
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'memory.mjs', 'upgrade'], { stdio: 'ignore', windowsHide: true });
    try {
      const v = interrupted({ pid: sleeper.pid });
      const res = runCli(v.root, ['start']);
      assert.equal(res.code, 3);
      assert.ok(res.stderr.includes(`memory: an upgrade is running right now (process ${sleeper.pid}); wait for it to finish, then run the command again\n`), res.stderr);
      assert.ok(!res.stderr.includes('undo it'), res.stderr);
    } finally {
      sleeper.kill();
    }
    await new Promise((resolve) => sleeper.once('exit', resolve));
  });
});

describe('writeAtomic', () => {
  for (const step of ['writeSync', 'fsyncSync', 'closeSync']) {
    test(`a failed ${step} (a full disk) leaves the file as it was and no temporary file`, () => {
      const dir = tmpDir('fsafe');
      const file = path.join(dir, 'kit.json');
      fs.writeFileSync(file, 'old\n');
      const original = fs[step];
      fs[step] = (...args) => {
        if (step === 'closeSync') original(...args);
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      };
      try {
        assert.throws(() => writeAtomic(file, 'new\n'), (err) => err.code === 'ENOSPC');
      } finally {
        fs[step] = original;
      }
      assert.equal(fs.readFileSync(file, 'utf8'), 'old\n');
      assert.deepEqual(fs.readdirSync(dir), ['kit.json']);
    });
  }

  test('a successful write leaves only the file', () => {
    const dir = tmpDir('fsafe-ok');
    const file = path.join(dir, 'a', 'b.txt');
    writeAtomic(file, 'text\n');
    assert.equal(fs.readFileSync(file, 'utf8'), 'text\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['b.txt']);
  });
});
