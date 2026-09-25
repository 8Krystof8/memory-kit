// Memory for coding projects in one pass through every module, as a person and Claude Code use
// it: `connect claude-code --projects --autosync` writes the hooks into a fake home
// ($CLAUDE_CONFIG_DIR/settings.json), and every hook is then run from the command string it
// installed, exactly as Claude Code runs a hook (/bin/sh -c "<command>" on macOS and Linux; on
// Windows bash -c with Git Bash, else powershell -NoProfile -Command) with the JSON payload on
// stdin, in the code repository of a client. The story: a first session in the unknown repository
// gets one hint and nothing is added; `project add`; the next session gets the brief; a gotcha is
// remembered; a failed Bash command with that error gets it back, a failed Read nothing; a code
// change gets one checkpoint at Stop, then silence; the session end syncs the vault in the
// background; with a remote that refuses the push, the log holds the failed step and its fix, the
// next session start tells the user once, and doctor --json lists it. doctor --probe leaves no
// trace. Throughout, the code repository stays untouched, no file git sees in the vault names the
// client, memory.json holds no repository URL, and check --strict passes.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitBashPath } from '../../lib/hooksetup.mjs';
import { KIT_ROOT, agentHome, checkJson, describeFindings, fixtureVault, removeTmpDirs, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const IS_WIN = process.platform === 'win32';
const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
// The client: its name must never reach a file of the vault that git sees.
const CLIENT = 'quillmoor';
const GOTCHA = 'vite build fails with ENOSPC watcher limit, raise fs.inotify.max_user_watches';
const ENOSPC = 'Exit code 1\nError: ENOSPC: System limit for number of file watchers reached (inotify max_user_watches)\n    at FSWatcher.<anonymous> (node:internal/fs/watchers:247:19)';

function git(cwd, args, env) {
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** How Claude Code runs a shell-form hook here: [program, args before the command], or null. */
function hookShell(env) {
  if (!IS_WIN) return ['/bin/sh', ['-c']];
  const bash = gitBashPath({ env });
  if (bash) return [bash, ['-c']];
  return ['powershell.exe', ['-NoProfile', '-Command']];
}

/** Files git sees in a repository: tracked, plus untracked ones not ignored. */
const gitFiles = (root, env) => git(root, ['ls-files', '-co', '--exclude-standard', '-z'], env).split('\0').filter(Boolean);

/** Files of the vault that name the client in their path or text; the kit's own files, as shipped, aside. */
function leaks(root, env) {
  const out = [];
  for (const rel of gitFiles(root, env)) {
    const text = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
    const kit = path.join(KIT_ROOT, ...rel.split('/'));
    if (fs.existsSync(kit) && fs.readFileSync(kit, 'utf8') === text) continue;
    if (rel.toLowerCase().includes(CLIENT) || text.toLowerCase().includes(CLIENT)) out.push(rel);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('projects end to end: connect, then every hook as Claude Code runs it, up to a failed push in doctor', {
  skip: !HAS_GIT && 'git is missing', timeout: 600_000,
}, async () => {
  // The vault: a fixture vault (its local root is ../private) in git, pushed to a local bare remote.
  const fx = fixtureVault('en');
  const root = fx.root;
  const h = agentHome('e2e-home');
  const env = { ...h.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'MEMORY_DEBUG', 'MEMORY_SECTORS', 'CLAUDE_CODE_REMOTE']) delete env[key];
  fs.copyFileSync(path.join(KIT_ROOT, '.gitignore'), path.join(root, '.gitignore'));
  git(root, ['init', '-q'], env);
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(root, ['config', k, v], env);
  git(root, ['add', '-A'], env);
  git(root, ['commit', '-qm', 'vault'], env);
  const remote = path.join(tmpDir('e2e-remote'), 'vault.git');
  git(path.dirname(remote), ['init', '-q', '--bare', remote], env);
  git(root, ['remote', 'add', 'origin', remote], env);
  git(root, ['push', '-q', '-u', 'origin', 'HEAD'], env);

  // The client's code repository: a remote and files that name the client.
  const repo = path.join(tmpDir('e2e-code'), 'shop');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: `${CLIENT}-shop`, description: 'Quillmoor Ltd web shop', scripts: { dev: 'vite', build: 'vite build' } }));
  fs.writeFileSync(path.join(repo, 'README.md'), '# Quillmoor shop\n\nThe web shop of Quillmoor Ltd.\n');
  git(repo, ['init', '-q'], env);
  git(repo, ['remote', 'add', 'origin', `git@github.com:${CLIENT}-ltd/shop.git`], env);
  git(repo, [...ID, 'add', '-A'], env);
  git(repo, [...ID, 'commit', '-qm', 'init'], env);

  const cli = (args, cwd = root) => {
    const res = spawnSync(process.execPath, [path.join(root, 'system', 'memory.mjs'), ...args, '--root', root], {
      cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const logFile = path.join(root, '.memory-kit', 'logs', 'hooks.jsonl');
  const logOf = () => {
    try {
      return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  /** The first autosync entry after `since` that ends the run (done, or a failed step); waits up to 60 s. */
  async function autosyncAfter(since) {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const hit = logOf().find((e) => e.event === 'autosync' && e.t > since && (e.step === 'done' || e.ok === false));
      if (hit) return hit;
      await sleep(200);
    }
    assert.fail(`no autosync result after ${since}:\n${fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(no log)'}`);
  }

  // 1. connect: the hooks in the fake home, the settings in memory.json.
  const connected = cli(['connect', 'claude-code', '--projects', '--autosync']);
  assert.equal(connected.code, 0, connected.stdout + connected.stderr);
  assert.match(connected.stdout, /Claude Code: memory hooks installed in /);
  const settings = JSON.parse(fs.readFileSync(h.settings, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'Stop', 'PostToolUseFailure', 'SessionEnd']);
  for (const [event, groups] of Object.entries(settings.hooks)) {
    assert.equal(groups.length, 1, event);
    assert.equal(typeof groups[0].hooks[0].command, 'string', `${event}: the shell form`);
    assert.equal(groups[0].hooks[0].args, undefined, `${event}: no exec form`);
  }

  // Every hook as Claude Code runs it: the command string of the settings, the payload on stdin.
  const [shell, shellArgs] = hookShell(env);
  const matches = (event, value) => {
    const { matcher } = settings.hooks[event][0];
    return !matcher || new RegExp(`^(?:${matcher})$`).test(value);
  };
  const runHook = (event, payload) => {
    const { command } = settings.hooks[event][0].hooks[0];
    const res = spawnSync(shell, [...shellArgs, command], {
      cwd: payload.cwd, env: { ...env, CLAUDE_PROJECT_DIR: payload.cwd }, input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 120_000,
    });
    assert.equal(res.error, undefined, `${event}: ${res.error}`);
    assert.equal(res.status, 0, `${event} exit ${res.status}: ${res.stderr}`);
    assert.equal(res.stderr, '', `${event} wrote to stderr`);
    return res.stdout;
  };
  const base = (sid) => ({ session_id: sid, transcript_path: path.join(h.claudeDir, 'projects', 'shop', `${sid}.jsonl`), cwd: repo });
  const start = (sid) => {
    assert.ok(matches('SessionStart', 'startup'));
    return runHook('SessionStart', { ...base(sid), hook_event_name: 'SessionStart', source: 'startup' });
  };
  const toolFailure = (sid, toolName) => runHook('PostToolUseFailure', {
    ...base(sid), permission_mode: 'default', hook_event_name: 'PostToolUseFailure', tool_name: toolName,
    tool_input: { command: 'npm run build', description: 'Build the shop' }, tool_use_id: 'toolu_01', error: ENOSPC, is_interrupt: false, duration_ms: 1840,
  });
  const stop = (sid) => runHook('Stop', { ...base(sid), permission_mode: 'default', hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' });
  const sessionEnd = (sid) => runHook('SessionEnd', { ...base(sid), hook_event_name: 'SessionEnd', reason: 'other' });
  const devManifest = path.join(root, 'sectors', 'dev', '_dev.md');

  // 2. A session in the unknown repository: one hint for the user, nothing added.
  const hinted = JSON.parse(start('e2e-1'));
  assert.match(hinted.systemMessage, /^memory-kit: this repository has no project memory\. To keep notes for it, run: node ".*memory\.mjs" project add\nNot wanted here\? Run: node ".*memory\.mjs" project ignore/);
  assert.match(hinted.hookSpecificOutput.additionalContext, /only when the user asks/);
  assert.equal(start('e2e-1b'), '', 'the hint is shown once per repository');
  assert.ok(!fs.existsSync(devManifest) && !fs.existsSync(path.join(fx.priv, 'projects.json')), 'nothing was added');

  // 3. The person adds the project.
  const added = cli(['project', 'add', '--json'], repo);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout), { ok: true, action: 'add', created: true, sector: 'dev', store: 'local', key: `github.com/${CLIENT}-ltd/shop`, notes: '../private/sectors/dev' });

  // 4. The next session gets the brief of the project (plain text: nothing for the user).
  const brief = start('e2e-2');
  assert.match(brief, /^# Project shop · memory sector `dev`/);

  // 5. A gotcha is remembered in the project's local notes.
  const remembered = cli(['remember', '--type', 'gotcha', GOTCHA], repo);
  assert.equal(remembered.code, 0, remembered.stderr);
  assert.match(remembered.stdout, /\.\.\/private\/sectors\/dev\/gotchas\.md/);

  // 6. A failed Bash command with that error gets the gotcha back; a failed Read gets nothing
  // (Claude Code does not even run the hook for it: the matcher is Bash|PowerShell).
  const lookup = JSON.parse(toolFailure('e2e-2', 'Bash'));
  assert.ok(matches('PostToolUseFailure', 'Bash'));
  assert.equal(lookup.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  assert.match(lookup.hookSpecificOutput.additionalContext, /^Project memory: a similar error was met before:\n.*raise fs\.inotify\.max_user_watches/);
  assert.ok(!matches('PostToolUseFailure', 'Read'));
  assert.equal(toolFailure('e2e-2', 'Read'), '');

  // 7. Stop: silent while the code is as it was; after a code change one checkpoint, then silent.
  assert.equal(stop('e2e-2'), '');
  fs.writeFileSync(path.join(repo, 'cart.js'), 'export const cart = [];\n');
  git(repo, [...ID, 'add', '-A'], env);
  git(repo, [...ID, 'commit', '-qm', 'cart'], env);
  const checkpoint = JSON.parse(stop('e2e-2'));
  assert.equal(checkpoint.decision, 'block');
  assert.match(checkpoint.reason, /remember --project dev --type gotcha/);
  assert.ok(checkpoint.reason.includes(path.join(fx.priv, 'sectors', 'dev', 'handoff.md')), checkpoint.reason);
  assert.equal(stop('e2e-2'), '', 'asked once per session');

  // 8. The session end syncs the vault in the background: commit and push.
  const beforeEnd = new Date().toISOString();
  assert.equal(sessionEnd('e2e-2'), '');
  const synced = await autosyncAfter(beforeEnd);
  assert.deepEqual([synced.step, synced.ok], ['done', true], JSON.stringify(synced));
  assert.equal(git(root, ['status', '--porcelain'], env), '', 'everything committed');
  assert.equal(git(root, ['rev-parse', 'HEAD'], env), git(root, ['--git-dir', remote, 'rev-parse', 'HEAD'], env), 'and pushed');
  assert.match(git(root, ['log', '-1', '--format=%s'], env).trim(), /^Memory: session \d{4}-\d{2}-\d{2}$/);

  // 9. The remote stops taking pushes (its push URL leads nowhere): the failed step is logged with
  // its fix, the next session start tells the user once, doctor lists it.
  git(root, ['remote', 'set-url', '--push', 'origin', path.join(tmpDir('e2e-gone'), 'missing.git')], env);
  assert.equal(cli(['remember', 'order new labels for the shelves'], root).code, 0, 'a change in the vault to sync');
  const beforeFail = new Date().toISOString();
  assert.equal(sessionEnd('e2e-2'), '');
  const failed = await autosyncAfter(beforeFail);
  assert.deepEqual([failed.step, failed.ok], ['push', false], JSON.stringify(failed));
  assert.ok(failed.error, JSON.stringify(failed));
  assert.match(failed.fix, /^open the vault and run: node ".*memory\.mjs" sync$/);
  const told = JSON.parse(start('e2e-3'));
  assert.match(told.systemMessage, /^Warning: the last memory sync failed \(.* UTC, step push\): .+\. Fix: open the vault and run: node ".*memory\.mjs" sync$/);
  assert.match(told.hookSpecificOutput.additionalContext, /^# Project shop/);
  assert.match(start('e2e-4'), /^# Project shop/, 'told once: the next start is the brief alone');
  const doctor = cli(['doctor', '--json']);
  const hooks = JSON.parse(doctor.stdout).checks.find((c) => c.id === 'projects.hooks');
  assert.equal(hooks.status, 'warn', JSON.stringify(hooks));
  assert.match(hooks.message, /Claude Code/);
  assert.match(hooks.message, /the last automatic sync failed \(push, /);
  assert.match(hooks.fix, /memory\.mjs" sync/);

  // 10. doctor --probe runs the installed session start hook and leaves no trace of it.
  const logBefore = logOf().length;
  const probed = JSON.parse(cli(['doctor', '--probe', '--json']).stdout).checks.find((c) => c.id === 'projects.hooks');
  assert.match(probed.message, /Claude Code: the session start hook ran in \d+ ms with clean output/);
  assert.ok(!fs.existsSync(path.join(root, '.memory-kit', 'capture', 'sessions', 'doctor-probe.json')), 'no session record of the probe');
  assert.deepEqual(logOf().slice(logBefore).map((e) => e.event), ['doctor-probe'], 'only the probe mark doctor writes itself');

  // Throughout: nothing in the code repository, nothing about the client in what git sees of the
  // vault (nor in its commit messages or the hook log), no repository URL in memory.json.
  assert.equal(git(repo, ['status', '--porcelain'], env), '', 'the code repository is untouched');
  assert.deepEqual(leaks(root, env), []);
  assert.ok(!git(root, ['log', '--format=%B'], env).toLowerCase().includes(CLIENT));
  assert.ok(!fs.readFileSync(logFile, 'utf8').toLowerCase().includes(CLIENT), 'the hook log holds a hash of the repository only');
  const memoryJson = fs.readFileSync(path.join(root, 'memory.json'), 'utf8');
  assert.doesNotMatch(memoryJson, new RegExp(`${CLIENT}|github\\.com|shop\\.git|git@`, 'i'));
  assert.deepEqual(JSON.parse(memoryJson).projects, { enabled: true, auto_add: false, store: 'local', autosync: true, checkpoint: true, error_lookup: true });
  assert.match(fs.readFileSync(path.join(fx.priv, 'sectors', 'dev', 'gotchas.md'), 'utf8'), /raise fs\.inotify/, 'the notes are in the local root');
  const check = checkJson(root, ['--generate', '--strict']);
  assert.equal(check.code, 0, describeFindings(check));
});
