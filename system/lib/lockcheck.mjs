// Is the process that holds an upgrade lock still an upgrade at work? Shared by the upgrader and
// by memory.mjs, which must not import the upgrader (after an interrupted upgrade it may be the
// broken file). Only Node built-ins here.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

/**
 * The upgrader refreshes its lock before every step, and one step (a child process) takes at most
 * five minutes, so a lock untouched for longer belongs to an upgrade that stopped.
 */
export const LOCK_FRESH_MS = 6 * 60 * 1000;

/**
 * The command line of a process: a string ('' when no such process runs), or null when this
 * system cannot tell. Linux reads /proc, macOS and other Unix systems ask ps, Windows asks
 * PowerShell (process ids come back fast there, so the id alone proves nothing).
 */
export function processCommand(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  if (platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ').trim();
    } catch (err) {
      return err?.code === 'ENOENT' ? '' : null;
    }
  }
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (platform === 'win32') {
    const res = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]);
    if (res.status === 0 && typeof res.stdout === 'string') return res.stdout.trim();
    return null;
  }
  const res = run('ps', ['-p', String(pid), '-o', 'command=']);
  if (res.error || typeof res.stdout !== 'string') return null;
  return res.status === 0 ? res.stdout.trim() : '';
}

/**
 * True when the lock's process is still an upgrade at work: the same machine, not this process,
 * a lock refreshed within LOCK_FRESH_MS, a living process id and, where the system names the
 * command, a command that runs memory.mjs. commandOf is injectable for tests.
 */
export function upgradeRunning(lock, mtimeMs, { now = Date.now(), commandOf = processCommand } = {}) {
  if (!lock || typeof lock.host !== 'string' || lock.host !== os.hostname()) return false;
  if (!Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === process.pid) return false;
  if (!(now - mtimeMs < LOCK_FRESH_MS)) return false;
  try {
    process.kill(lock.pid, 0);
  } catch (err) {
    if (err?.code !== 'EPERM') return false;
  }
  const command = commandOf(lock.pid);
  if (command === null) return true;
  return command.includes('memory.mjs');
}

/** Marks the lock as alive (the upgrader calls it before every step). */
export function touchLock(abs) {
  try {
    const t = new Date();
    fs.utimesSync(abs, t, t);
  } catch {
    /* no lock (yet): nothing to refresh */
  }
}
