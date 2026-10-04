// The upgrade lock liveness test (system/lib/lockcheck.mjs): a stopped upgrade must never block
// its own rollback, also where process ids come back fast (Windows).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { LOCK_FRESH_MS, processCommand, upgradeRunning } from '../../lib/lockcheck.mjs';

const NOW = 1_800_000_000_000;
const lock = (pid, host = os.hostname()) => ({ pid, host });
const upgrader = () => 'node /vault/system/memory.mjs upgrade --yes --root /vault';

describe('lockcheck', () => {
  test('processCommand names this process and nothing for a free id', () => {
    const own = processCommand(process.pid);
    if (own !== null) assert.match(own, /node/i);
    const none = processCommand(2 ** 30);
    assert.ok(none === '' || none === null, `got ${JSON.stringify(none)}`);
    assert.equal(processCommand(-1), '');
  });

  test('a living upgrade process holds the lock', () => {
    assert.equal(upgradeRunning(lock(process.ppid), NOW - 1000, { now: NOW, commandOf: upgrader }), true);
    assert.equal(upgradeRunning(lock(process.ppid), NOW - 1000, { now: NOW, commandOf: () => null }), true, 'unknown command: stay careful');
  });

  test('a reused process id, another machine, this process or a stale lock never do', () => {
    assert.equal(upgradeRunning(lock(process.ppid), NOW - 1000, { now: NOW, commandOf: () => 'C:\\Windows\\notepad.exe' }), false);
    assert.equal(upgradeRunning(lock(process.ppid, 'another-machine'), NOW - 1000, { now: NOW, commandOf: upgrader }), false);
    assert.equal(upgradeRunning(lock(process.pid), NOW - 1000, { now: NOW, commandOf: upgrader }), false);
    assert.equal(upgradeRunning(lock(process.ppid), NOW - LOCK_FRESH_MS - 1, { now: NOW, commandOf: upgrader }), false);
    assert.equal(upgradeRunning(lock(2 ** 30), NOW - 1000, { now: NOW, commandOf: upgrader }), false, 'no such process');
    assert.equal(upgradeRunning({ pid: 'x', host: os.hostname() }, NOW, { now: NOW, commandOf: upgrader }), false);
    assert.equal(upgradeRunning(null, NOW, { now: NOW, commandOf: upgrader }), false);
  });
});
