// Memory for coding projects end to end, in both languages and both stores: the hook events
// (session start: nothing inside the vault or outside git, a one-time hint for the user in a new
// repository, the brief in a known one, failures reported once to the user; stop, also after a
// project added mid-session; the error lookup and its filters; autosync against a local bare
// remote, never over an unfinished merge), the project command, remember, two clients' look-alike
// repositories kept apart, and the proof that a local-store project or a note taken in an unknown
// repository leaves nothing about it in the files git sees. The project settings are written into
// memory.json directly; everything runs against a fake home.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KIT_ROOT, checkJson, copyKit, describeFindings, fixtureVault, plantSecret, removeTmpDirs, tmpDir } from '../helpers.mjs';
import { logHook } from '../../lib/hooklog.mjs';

after(removeTmpDirs);

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
const SECTORS = { en: 'sectors', cs: 'sektory' };
// The Czech runs use the Czech command and subcommand aliases.
const PROJECT = {
  en: { cmd: 'project', add: 'add', remove: 'remove', ignore: 'ignore', unignore: 'unignore', list: 'list', status: 'status' },
  cs: { cmd: 'projekt', add: 'pridat', remove: 'odebrat', ignore: 'ignorovat', unignore: 'neignorovat', list: 'seznam', status: 'stav' },
};

function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function cli(v, args, { cwd, input = '', env: extra = {} } = {}) {
  const home = v.home;
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
  for (const k of ['MEMORY_SECTORS', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'MEMORY_DEBUG', 'MEMORY_KIT_PROBE']) delete env[k];
  Object.assign(env, extra);
  const res = spawnSync(process.execPath, [path.join(v.root, 'system', 'memory.mjs'), ...args, '--root', v.root], {
    cwd: cwd ?? v.root, env, input, encoding: 'utf8', windowsHide: true, timeout: 120000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

const project = (v, sub, repo, extra = []) => cli(v, [PROJECT[v.lang].cmd, PROJECT[v.lang][sub], ...extra], { cwd: repo });
const projectJson = (v, sub, repo, extra = []) => {
  const res = project(v, sub, repo, [...extra, '--json']);
  try {
    return { code: res.code, ...JSON.parse(res.stdout) };
  } catch {
    throw new Error(`${sub} --json printed no JSON (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
  }
};
const hook = (v, event, input, { agent = 'claude-code', cwd, env } = {}) => cli(v, ['hook', agent, event], { cwd: cwd ?? input.cwd, input: JSON.stringify(input), env });
const start = (v, repo, sid, agent) => hook(v, 'session-start', { cwd: repo, session_id: sid, hook_event_name: 'SessionStart', source: 'startup' }, { agent });
/** Claude Code session start output: { user (systemMessage), context }. */
function startOut(res) {
  const out = res.stdout.trim();
  if (!out.startsWith('{')) return { user: '', context: out };
  const j = JSON.parse(out);
  return { user: j.systemMessage ?? '', context: j.hookSpecificOutput?.additionalContext ?? '' };
}
const vaultCmd = (v) => `node "${v.root.replace(/\\/g, '/')}/system/memory.mjs"`;
const failure = (v, repo, sid, extra) => hook(v, 'tool-failure', { cwd: repo, session_id: sid, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', is_interrupt: false, ...extra });
const logOf = (v) => {
  try {
    return fs.readFileSync(path.join(v.root, '.memory-kit', 'logs', 'hooks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

function setProjects(root, projects) {
  const file = path.join(root, 'memory.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (projects === undefined) delete j.projects;
  else j.projects = projects;
  fs.writeFileSync(file, `${JSON.stringify(j, null, 2)}\n`);
}

/** A fixture vault with the kit's .gitignore, projects settings and (withGit) a first commit. */
function vault(lang, { projects = { enabled: true }, withGit = false, root } = {}) {
  const fx = root ? { root, names: { lang } } : fixtureVault(lang);
  fs.copyFileSync(path.join(KIT_ROOT, '.gitignore'), path.join(fx.root, '.gitignore'));
  setProjects(fx.root, projects);
  if (withGit) {
    git(fx.root, ['init', '-q']);
    for (const [k, val] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(fx.root, ['config', k, val]);
    git(fx.root, ['add', '-A']);
    git(fx.root, ['commit', '-qm', 'vault']);
  }
  return { ...fx, lang, home: tmpDir('home') };
}

/** A code repository with one commit; the folder name has a space (and accents in Czech). */
function codeRepo({ remote = 'git@github.com:linden/shop.git', name = 'harbor shop', files } = {}) {
  const dir = path.join(tmpDir('code'), name);
  fs.mkdirSync(dir, { recursive: true });
  const all = files ?? {
    'package.json': JSON.stringify({ name: 'harbor-shop', description: 'Pre-orders for Harbor Bakery', scripts: { dev: 'vite', test: 'vitest' } }),
    'index.js': 'console.log(1);\n',
  };
  for (const [rel, text] of Object.entries(all)) fs.writeFileSync(path.join(dir, rel), text);
  git(dir, ['init', '-q']);
  if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  git(dir, [...ID, 'add', '-A']);
  git(dir, [...ID, 'commit', '-qm', 'init']);
  return dir;
}

const clean = (repo) => assert.equal(git(repo, ['status', '--porcelain']), '', 'nothing written into the code repository');
const ENOSPC = 'Exit code 1\nError: ENOSPC: System limit for number of file watchers reached (inotify max_user_watches)\n    at FSWatcher.<anonymous> (node:internal/fs/watchers:247:19)';
const GOTCHA = 'vite build fails with ENOSPC watcher limit, raise fs.inotify.max_user_watches';

/** Files git sees in a repository: tracked, plus untracked ones not ignored. */
const gitFiles = (root) => git(root, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);

/** Files of the vault that name the client (the kit's own files, identical to the kit, aside). */
function leaks(root, word) {
  const re = new RegExp(word, 'i');
  const out = [];
  for (const rel of gitFiles(root)) {
    const abs = path.join(root, ...rel.split('/'));
    const text = fs.readFileSync(abs, 'utf8');
    const kit = path.join(KIT_ROOT, ...rel.split('/'));
    if (fs.existsSync(kit) && fs.readFileSync(kit, 'utf8') === text) continue;
    if (re.test(rel) || re.test(text)) out.push(rel);
  }
  return out;
}

describe('projects end to end', { skip: !HAS_GIT && 'git is missing' }, () => {
  for (const lang of ['en', 'cs']) {
    test(`${lang}: a new repository gets one short hint; ignore silences it; the vault and plain folders stay silent`, () => {
      const v = vault(lang);
      const repo = codeRepo({ name: lang === 'cs' ? 'Pekárna obchod' : 'harbor shop' });
      const first = start(v, repo, 's1');
      assert.equal(first.code, 0, first.stderr);
      // The hint is for the user (systemMessage); the agent only learns not to act on it by itself.
      const { user, context } = startOut(first);
      assert.ok(user.split('\n').length <= 2, user);
      assert.match(user, / project add\b/);
      assert.match(user, / project ignore\b/);
      assert.ok(user.includes(`${vaultCmd(v)} project add`), 'the full vault command, quoted, forward slashes');
      assert.match(context, lang === 'cs' ? /jen tehdy, když o to uživatel požádá/ : /only when the user asks/);
      assert.equal(start(v, repo, 's2').stdout, '', 'the hint is shown once per repository');
      const codexRepo = codeRepo({ remote: 'https://github.com/linden/codex.git', name: 'codex' });
      const relay = start(v, codexRepo, 'c1', 'codex').stdout.trim();
      assert.equal(relay.split('\n').length, 1, relay);
      assert.match(relay, lang === 'cs' ? /Řekni to uživateli.*sám nespouštěj/ : /Tell the user once.*do not run either yourself/, 'Codex: plain text, the agent passes it on');
      assert.equal(start(v, v.root, 's3').stdout, '', 'the vault prints its own start view through its own hook');
      assert.equal(start(v, path.join(v.root, SECTORS[lang]), 's4').stdout, '', 'also in a subfolder of the vault');
      assert.equal(start(v, tmpDir('plain'), 's5').stdout, '', 'outside git: no personal memory in random folders');

      const other = codeRepo({ remote: 'https://gitlab.com/linden/tools.git', name: 'tools' });
      const ign = projectJson(v, 'ignore', other);
      assert.deepEqual([ign.code, ign.action, ign.changed, ign.key], [0, 'ignore', true, 'gitlab.com/linden/tools']);
      assert.equal(start(v, other, 's6').stdout, '', 'an ignored repository is silent');
      assert.equal(projectJson(v, 'ignore', other).changed, false);
      assert.equal(projectJson(v, 'unignore', other).changed, true);
      assert.match(startOut(start(v, other, 's7')).user, / project add\b/, 'after unignore the hint comes once more');
      assert.equal(start(v, other, 's8').stdout, '');

      assert.ok(!fs.existsSync(path.join(v.root, SECTORS[lang], 'dev')), 'auto_add is off: no sector by itself');
      assert.equal(JSON.parse(fs.readFileSync(path.join(v.root, 'memory.json'), 'utf8')).projects.repos, undefined);
      clean(repo);
      clean(other);
      const refused = project(v, 'add', tmpDir('plain'));
      assert.equal(refused.code, 1);
      assert.equal(project(v, 'add', v.root).code, 1, 'the vault is not a project');

      // An ignore written where the settings contract puts it (the local root) is undone too.
      const third = codeRepo({ remote: 'https://github.com/linden/third.git', name: 'third' });
      fs.mkdirSync(path.join(v.root, '..', 'private'), { recursive: true });
      fs.writeFileSync(path.join(v.root, '..', 'private', 'projects.json'), JSON.stringify({ version: 1, repos: {}, ignored: ['github.com/linden/third'] }));
      assert.equal(projectJson(v, 'status', third).ignored, true);
      assert.equal(projectJson(v, 'unignore', third).changed, true);
      assert.equal(projectJson(v, 'status', third).ignored, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(v.root, '..', 'private', 'projects.json'), 'utf8')).ignored, []);
    });

    for (const store of ['local', 'git']) {
      test(`${lang}, store ${store}: project add, list, status, remove; the brief, remember and stop`, () => {
        const v = vault(lang, { projects: { enabled: true, store } });
        const repo = codeRepo({ name: lang === 'cs' ? 'Pekárna obchod' : 'harbor shop' });
        const dev = `${SECTORS[lang]}/dev`;
        const notesDir = store === 'local' ? `../private/${dev}` : dev;

        const added = projectJson(v, 'add', repo);
        assert.equal(added.code, 0);
        assert.deepEqual({ ...added, code: undefined }, { code: undefined, ok: true, action: 'add', created: true, sector: 'dev', store, key: 'github.com/linden/shop', notes: notesDir });
        const again = projectJson(v, 'add', repo);
        assert.deepEqual([again.created, again.sector], [false, 'dev']);
        const mem = JSON.parse(fs.readFileSync(path.join(v.root, 'memory.json'), 'utf8'));
        if (store === 'git') assert.deepEqual(mem.projects.repos, { 'github.com/linden/shop': 'dev' });
        else {
          assert.equal(mem.projects.repos, undefined, 'a local-store mapping stays out of memory.json');
          assert.deepEqual(JSON.parse(fs.readFileSync(path.join(v.root, '..', 'private', 'projects.json'), 'utf8')).repos, { 'github.com/linden/shop': 'dev' });
        }
        const handoff = path.join(v.root, ...notesDir.split('/'), `${lang === 'cs' ? 'predavka' : 'handoff'}.md`);
        assert.ok(fs.existsSync(handoff), handoff);
        const overview = fs.readFileSync(path.join(path.dirname(handoff), `${lang === 'cs' ? 'prehled' : 'overview'}.md`), 'utf8');
        assert.match(overview, /`npm run dev`/);

        let list = projectJson(v, 'list', repo);
        assert.deepEqual(list.projects, [{ sector: 'dev', store, key: 'github.com/linden/shop', notes: notesDir, last_session: null }]);

        const brief = start(v, repo, 's1');
        assert.equal(brief.code, 0, brief.stderr);
        assert.match(brief.stdout, lang === 'cs' ? /^# Projekt shop · sektor paměti `dev`/ : /^# Project shop · memory sector `dev`/);
        assert.ok(!/Warning|Pozor/.test(brief.stdout), 'no warnings without failures');
        list = projectJson(v, 'list', repo);
        assert.match(list.projects[0].last_session, /^\d{4}-\d{2}-\d{2}T/);

        const status = projectJson(v, 'status', repo);
        assert.deepEqual(status.project, { sector: 'dev', store, notes: notesDir, via: null });
        assert.deepEqual(status.settings, { enabled: true, auto_add: false, store, autosync: false, checkpoint: true, error_lookup: true });
        assert.equal(status.hooks.last_runs['session-start'].ok, true);
        assert.deepEqual(status.hooks.failures, []);
        assert.equal(status.lock.state, 'free');
        assert.equal(status.ignored, false);

        const rem = cli(v, ['remember', '--type', 'gotcha', GOTCHA], { cwd: path.join(repo) });
        assert.equal(rem.code, 0, rem.stderr);
        assert.ok(rem.stdout.includes(`${notesDir}/${lang === 'cs' ? 'pasti' : 'gotchas'}.md`), rem.stdout);
        const secret = cli(v, ['remember', `token ${plantSecret().github}`], { cwd: repo });
        assert.equal(secret.code, 1);
        const stray = cli(v, ['remember', 'the release checklist lives in the wiki', '--json'], { cwd: codeRepo({ remote: 'https://github.com/linden/other.git', name: 'other' }) });
        assert.equal(stray.code, 0, stray.stderr);
        const kept = JSON.parse(stray.stdout);
        assert.deepEqual([kept.project, kept.local], [false, store === 'local'], 'an unknown repository: the local inbox while the store is local');
        assert.ok(kept.rel.startsWith(store === 'local' ? '../private/inbox/' : 'inbox/'), kept.rel);
        assert.match(cli(v, ['remember', 'the wiki moved'], { cwd: codeRepo({ remote: 'https://github.com/linden/wiki.git', name: 'wiki' }) }).stdout, / project add\b/,
          'and how to add the project');

        // Stop: silent without code changes, asks once after a change, then silent again; Codex too.
        const stopIn = { cwd: repo, session_id: 's1', stop_hook_active: false };
        assert.equal(hook(v, 'stop', stopIn).stdout, '');
        fs.appendFileSync(path.join(repo, 'index.js'), 'console.log(2);\n');
        const ask = hook(v, 'stop', stopIn);
        assert.equal(JSON.parse(ask.stdout).decision, 'block');
        assert.ok(JSON.parse(ask.stdout).reason.includes(handoff));
        assert.equal(hook(v, 'stop', stopIn).stdout, '');
        start(v, repo, 's2');
        fs.writeFileSync(path.join(repo, 'cart.js'), 'export {};\n');
        const codex = hook(v, 'stop', { cwd: repo, session_id: 's2' }, { agent: 'codex' });
        assert.equal(JSON.parse(codex.stdout).decision, 'block', 'Codex: JSON on stdout');
        assert.equal(hook(v, 'stop', { cwd: repo, session_id: 's9-unknown' }).stdout, '', 'a session the start did not see');
        git(repo, ['checkout', '--', 'index.js']);
        fs.rmSync(path.join(repo, 'cart.js'));

        const res = checkJson(v.root, ['--generate', '--strict']);
        assert.equal(res.code, 0, describeFindings(res));

        const removed = projectJson(v, 'remove', repo);
        assert.deepEqual([removed.code, removed.sector, removed.notes], [0, 'dev', notesDir]);
        assert.ok(fs.existsSync(handoff), 'remove keeps the notes');
        assert.equal(projectJson(v, 'list', repo).projects.length, 0);
        assert.equal(projectJson(v, 'remove', repo).code, 1, 'not a project any more');
        assert.match(start(v, repo, 's3').stdout, / project add\b/);
        clean(repo);
      });
    }

    test(`${lang}: a local-store project leaves nothing about the repository in the files git sees`, () => {
      const v = vault(lang, { withGit: true });
      const repo = codeRepo({
        remote: 'git@github.com:acme-secret-client/shop.git',
        name: 'shop',
        files: {
          'package.json': JSON.stringify({ name: 'acme-shop', description: 'Acme Corp web shop', scripts: { dev: 'vite', 'deploy-acme': 'node deploy.js' } }),
          'README.md': '# Acme shop\n\nThe web shop of Acme Corp.\n',
          'acme.config.js': 'export default {};\n',
        },
      });
      assert.equal(start(v, repo, 's0').code, 0);
      assert.equal(projectJson(v, 'add', repo).store, 'local');
      assert.equal(start(v, repo, 's1').code, 0);
      assert.equal(cli(v, ['remember', '--type', 'gotcha', `Acme checkout: ${GOTCHA}`], { cwd: repo }).code, 0);
      assert.equal(cli(v, ['remember', '--type', 'decision', 'Acme wants invoices in PDF'], { cwd: repo }).code, 0);
      assert.equal(failure(v, repo, 's1', { error: ENOSPC }).code, 0);
      fs.appendFileSync(path.join(repo, 'README.md'), 'more\n');
      hook(v, 'stop', { cwd: repo, session_id: 's1', stop_hook_active: false });
      const res = checkJson(v.root, ['--generate', '--strict']);
      assert.equal(res.code, 0, describeFindings(res));
      const local = fs.readFileSync(path.join(v.root, '..', 'private', SECTORS[lang], 'dev', `${lang === 'cs' ? 'prehled' : 'overview'}.md`), 'utf8');
      assert.match(local, /Acme/, 'the notes themselves do name the client (in the local root)');
      assert.deepEqual(leaks(v.root, 'acme'), []);
      assert.ok(gitFiles(v.root).some((rel) => rel === `${SECTORS[lang]}/dev/_dev.md`), 'the neutral manifest is committed');
      for (const e of logOf(v)) assert.ok(!/acme/i.test(JSON.stringify(e)), 'the hook log holds only a hash of the repository');
    });
  }

  test('without a local root, project add makes ../<vault>-private and check stays clean', () => {
    const root = copyKit(path.join(tmpDir('bare'), 'my vault'));
    const v = vault('en', { root, withGit: true });
    const repo = codeRepo({ remote: 'https://github.com/acme-secret-client/shop.git', name: 'shop', files: { 'README.md': '# Acme\n\nAcme Corp shop.\n' } });
    const added = projectJson(v, 'add', repo);
    assert.deepEqual([added.code, added.sector, added.store, added.notes], [0, 'dev', 'local', '../my vault-private/sectors/dev']);
    const mem = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf8'));
    assert.deepEqual(mem.roots.at(-1), { id: 'private', path: '../my vault-private', privacy: 'local' });
    assert.equal(mem.mode, 'github', 'the mode stays as it is');
    assert.ok(fs.existsSync(path.join(root, '..', 'my vault-private', 'sectors', 'dev', 'overview.md')));
    assert.equal(cli(v, ['remember', '--type', 'gotcha', `Acme: ${GOTCHA}`], { cwd: repo }).code, 0);
    const res = checkJson(root, ['--generate', '--strict']);
    assert.equal(res.errors.length, 0, describeFindings(res));
    assert.deepEqual(leaks(root, 'acme'), []);
    const second = codeRepo({ remote: 'https://github.com/linden/tools.git', name: 'tools' });
    assert.equal(projectJson(v, 'add', second).sector, 'dev-2', 'local-store ids never name the repository');
    const third = codeRepo({ remote: 'https://github.com/linden/booking.git', name: 'booking' });
    assert.equal(projectJson(v, 'add', third, ['--store', 'git']).sector, 'dev-booking');
    assert.equal(project(v, 'add', third, ['--store', 'cloud']).code, 2);
  });

  test('hooks exit 0 and print nothing on garbage input, and do nothing while the project hooks are off', () => {
    const v = vault('en');
    const repo = codeRepo();
    for (const event of ['stop', 'tool-failure', 'session-end']) {
      for (const input of ['{not json', '[1,2]', '"text"', '']) {
        const res = cli(v, ['hook', 'claude-code', event], { cwd: repo, input });
        assert.deepEqual([res.code, res.stdout], [0, ''], `${event} ${input}`);
      }
    }
    assert.equal(cli(v, ['hook', 'claude-code', 'session-start'], { input: '{not json' }).code, 0);
    assert.equal(cli(v, ['hook', 'nobody', 'stop']).code, 0);
    assert.equal(cli(v, ['hook', 'claude-code', 'no-such-event']).code, 0);
    assert.equal(projectJson(v, 'add', repo).sector, 'dev');
    fs.rmSync(path.join(v.root, '.memory-kit'), { recursive: true, force: true });
    for (const projects of [{ enabled: false, auto_add: true, autosync: true }, undefined]) {
      setProjects(v.root, projects);
      const other = codeRepo({ remote: 'https://github.com/linden/other.git', name: 'other' });
      for (const [event, input] of [
        ['session-start', { cwd: repo, session_id: 'x1' }], ['session-start', { cwd: other, session_id: 'x2' }],
        ['stop', { cwd: repo, session_id: 'x1', stop_hook_active: false }], ['tool-failure', { cwd: repo, session_id: 'x1', tool_name: 'Bash', error: ENOSPC }],
        ['session-end', { cwd: repo, session_id: 'x1' }],
      ]) {
        const res = hook(v, event, input);
        assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], `${event} with projects ${JSON.stringify(projects)}`);
      }
      assert.ok(!fs.existsSync(path.join(v.root, '.memory-kit')), 'nothing written, not even the log');
      assert.ok(!fs.existsSync(path.join(v.root, 'sectors', 'dev-other')));
    }
    const status = projectJson(v, 'status', repo);
    assert.equal(status.settings.enabled, false);
    assert.equal(project(v, 'status', repo).stdout.includes('connect claude-code --projects'), true, 'status says how to turn them on');
  });

  test('a doctor --probe run leaves no trace, whether the environment or the input marks it', () => {
    // Every setting that makes a hook write is on: the new repository would become a project, the
    // session end would start the autosync, and a failed sync waits to be reported.
    const v = vault('en', { projects: { enabled: true, auto_add: true, autosync: true } });
    const repo = codeRepo();
    logHook(v.root, { agent: 'claude-code', event: 'autosync', step: 'push', ok: false, error: 'rejected', fix: 'run sync' });
    const logFile = path.join(v.root, '.memory-kit', 'logs', 'hooks.jsonl');
    const before = fs.readFileSync(logFile, 'utf8');
    const traces = () => {
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(dir, e.name));
          else files.push(path.relative(v.root, path.join(dir, e.name)).split(path.sep).join('/'));
        }
      };
      walk(path.join(v.root, '.memory-kit'));
      return files.sort();
    };
    const events = (extra) => [
      ['session-start', { cwd: repo, session_id: 'doctor-probe', hook_event_name: 'SessionStart', source: 'startup', ...extra }],
      ['stop', { cwd: repo, session_id: 'doctor-probe', stop_hook_active: false, ...extra }],
      ['tool-failure', { cwd: repo, session_id: 'doctor-probe', tool_name: 'Bash', is_interrupt: false, error: ENOSPC, ...extra }],
      ['session-end', { cwd: repo, session_id: 'doctor-probe', reason: 'other', ...extra }],
    ];
    for (const [label, env, extra] of [['MEMORY_KIT_PROBE=1', { MEMORY_KIT_PROBE: '1' }, {}], ['"probe": true', {}, { probe: true }]]) {
      for (const [event, input] of events(extra)) {
        const res = hook(v, event, input, { env });
        assert.deepEqual([res.code, res.stdout, res.stderr], [0, '', ''], `${label}: ${event}`);
      }
      // A session end that started the autosync would log its run within moments.
      const until = Date.now() + 1500;
      while (Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 250)']);
      assert.deepEqual(traces(), ['.memory-kit/logs/hooks.jsonl'], `${label}: no session record, hint, report mark or lock`);
      assert.equal(fs.readFileSync(logFile, 'utf8'), before, `${label}: no log entry`);
      assert.ok(!fs.existsSync(path.join(v.root, 'sectors', 'dev')) && !fs.existsSync(path.join(v.root, '..', 'private', 'projects.json')), `${label}: no project`);
    }
    // The same session start without the mark does all of that.
    const real = startOut(start(v, repo, 's1'));
    assert.match(real.user, /the last memory sync failed/);
    assert.ok(fs.existsSync(path.join(v.root, 'sectors', 'dev')), 'auto_add made the project');
    assert.ok(traces().includes('.memory-kit/capture/sessions/s1.json'));
    assert.notEqual(fs.readFileSync(logFile, 'utf8'), before);
    clean(repo);
  });

  test('the error lookup: only Bash and PowerShell, no interrupts or short errors, deduplicated, 5 per session', () => {
    const v = vault('en');
    const repo = codeRepo();
    assert.equal(projectJson(v, 'add', repo).code, 0);
    start(v, repo, 's1');
    const seen = path.join(v.root, '.memory-kit', 'capture', 'sessions', 's1.seen');
    assert.equal(failure(v, repo, 's1', { error: ENOSPC }).stdout, '', 'no gotchas recorded yet');
    assert.ok(!fs.existsSync(seen), 'a project without gotchas spends no lookup');
    assert.equal(cli(v, ['remember', '--type', 'gotcha', GOTCHA], { cwd: repo }).code, 0);
    assert.equal(failure(v, repo, 's1', { tool_name: 'Read', error: ENOSPC }).stdout, '');
    assert.equal(failure(v, repo, 's1', { error: ENOSPC, is_interrupt: true }).stdout, '');
    assert.equal(failure(v, repo, 's1', { error: 'Exit code 1\nno such file' }).stdout, '');
    assert.equal(failure(v, repo, 's1', { error: 'Exit code 1' }).stdout, '');
    const hit = failure(v, repo, 's1', { error: ENOSPC });
    assert.equal(hit.code, 0, hit.stderr);
    const context = JSON.parse(hit.stdout).hookSpecificOutput;
    assert.equal(context.hookEventName, 'PostToolUseFailure');
    assert.match(context.additionalContext, /ENOSPC watcher limit/);
    assert.ok(context.additionalContext.split('\n').length <= 3 && context.additionalContext.length <= 600);
    assert.equal(failure(v, repo, 's1', { error: ENOSPC.replace('247:19', '251:3') }).stdout, '', 'the same error again: deduplicated');
    assert.match(failure(v, repo, 's1', { tool_name: 'PowerShell', error: ENOSPC }).stdout, /ENOSPC/, 'another tool is another error');
    for (const error of ['TypeError: cart.total is not a function in checkout', 'ReferenceError: basket is not defined in pricing', 'SyntaxError: unexpected token in the orders module']) {
      assert.equal(failure(v, repo, 's1', { error: `Exit code 2\n${error}` }).stdout, '');
    }
    assert.equal(fs.readFileSync(seen, 'utf8').trim().split('\n').length, 5);
    assert.equal(failure(v, repo, 's1', { error: ENOSPC.replace('ENOSPC:', 'ENOSPC (again):') }).stdout, '', 'at most 5 lookups per session');
    assert.match(failure(v, repo, 's2-no-start', { error: ENOSPC }).stdout, /ENOSPC/, 'a session without a start record finds the project itself');
    const other = codeRepo({ remote: 'https://github.com/linden/other.git', name: 'other' });
    start(v, other, 's3');
    assert.equal(failure(v, other, 's3', { error: ENOSPC }).stdout, '', 'a session outside any known project');
    setProjects(v.root, { enabled: true, error_lookup: false });
    assert.equal(failure(v, repo, 's4', { error: ENOSPC }).stdout, '');
    const runs = logOf(v).filter((e) => e.event === 'tool-failure');
    assert.ok(runs.length >= 12 && runs.every((e) => e.ok === true && e.agent === 'claude-code' && Number.isInteger(e.ms)), JSON.stringify(runs));

    // A hook run that failed is told to the user once, at the next session start wherever it is.
    const failedRun = () => fs.appendFileSync(path.join(v.root, '.memory-kit', 'logs', 'hooks.jsonl'),
      `${JSON.stringify({ t: new Date().toISOString(), agent: 'claude-code', event: 'stop', ok: false, error: 'EACCES' })}\n`);
    failedRun();
    const told = startOut(start(v, repo, 's5'));
    assert.match(told.user, /^Warning: failed memory hook runs since the last warning: 1; see: node ".*memory\.mjs" doctor$/);
    assert.match(told.context, /^# Project shop/, 'the brief still reaches the agent');
    assert.equal(startOut(start(v, repo, 's6')).user, '', 'once');
    failedRun();
    assert.match(startOut(start(v, v.root, 's7')).user, /^Warning: failed memory hook runs since the last warning: 1;/, 'in the vault too');
    failedRun();
    assert.match(startOut(start(v, tmpDir('plain'), 's8')).user, /^Warning: failed memory hook runs since the last warning: 1;/, 'and outside any repository');
    failedRun();
    assert.match(start(v, other, 's9', 'codex').stdout, /^memory-kit asks you to pass this on to the user: Warning: failed memory hook runs since the last warning: 1;/, 'Codex: the agent passes it on');
  });

  test('a memory.json with a byte order mark: the error lookup still works and is logged', () => {
    const v = vault('en');
    const repo = codeRepo();
    assert.equal(projectJson(v, 'add', repo).code, 0);
    assert.equal(cli(v, ['remember', '--type', 'gotcha', GOTCHA], { cwd: repo }).code, 0);
    start(v, repo, 'b1');
    const file = path.join(v.root, 'memory.json');
    fs.writeFileSync(file, `\uFEFF${fs.readFileSync(file, 'utf8')}`);
    const before = logOf(v).filter((e) => e.event === 'tool-failure').length;
    assert.match(failure(v, repo, 'b1', { error: ENOSPC }).stdout, /ENOSPC watcher limit/);
    assert.equal(logOf(v).filter((e) => e.event === 'tool-failure').length, before + 1);
    // memory.json that cannot be read at all: nothing printed, exit 0, and the failure is logged.
    fs.writeFileSync(file, '{ broken');
    const broken = failure(v, repo, 'b1', { error: ENOSPC });
    assert.deepEqual([broken.code, broken.stdout], [0, '']);
    const last = logOf(v).at(-1);
    assert.deepEqual([last.event, last.ok], ['tool-failure', false]);
    assert.match(last.error, /memory\.json/);
  });

  test('autosync: commits and pushes, logs a failed push with its fix and the next session start shows it; a busy lock is skipped', () => {
    const v = vault('en', { withGit: true, projects: { enabled: true, autosync: true } });
    const remote = path.join(tmpDir('remote'), 'vault.git');
    git(path.dirname(remote), ['init', '-q', '--bare', remote]);
    git(v.root, ['remote', 'add', 'origin', remote]);
    git(v.root, ['push', '-q', '-u', 'origin', 'HEAD']);
    const repo = codeRepo();
    assert.equal(projectJson(v, 'add', repo).code, 0);
    assert.notEqual(git(v.root, ['status', '--porcelain']), '', 'the new manifest waits for a commit');
    const synced = cli(v, ['hook', 'claude-code', 'autosync']);
    assert.deepEqual([synced.code, synced.stdout], [0, '']);
    const done = logOf(v).at(-1);
    assert.deepEqual([done.event, done.step, done.ok], ['autosync', 'done', true], JSON.stringify(done));
    assert.equal(git(v.root, ['status', '--porcelain']), '');
    assert.match(git(v.root, ['--git-dir', remote, 'log', '-1', '--format=%s']).trim(), /^Memory: session \d{4}-\d{2}-\d{2}$/);
    assert.equal(cli(v, ['hook', 'claude-code', 'autosync']).code, 0);
    assert.equal(logOf(v).at(-1).detail, 'nothing to sync');

    // A busy lock: skipped and logged as such, not as a failure.
    const lock = path.join(v.root, '.memory-kit', 'capture', 'autosync.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }));
    assert.equal(cli(v, ['remember', 'buy flour for the bakery demo'], { cwd: v.root }).code, 0);
    cli(v, ['hook', 'claude-code', 'autosync']);
    const busy = logOf(v).at(-1);
    assert.deepEqual([busy.step, busy.ok], ['lock', true]);
    assert.notEqual(git(v.root, ['status', '--porcelain']), '', 'nothing committed while the lock is held');
    assert.equal(projectJson(v, 'status', repo).lock.state, 'busy');
    fs.rmSync(lock);

    // The push fails: logged with the step, the error and the fix; the next session start tells the user.
    git(v.root, ['remote', 'set-url', '--push', 'origin', path.join(tmpDir('gone'), 'missing.git')]);
    cli(v, ['hook', 'claude-code', 'autosync']);
    const failed = logOf(v).at(-1);
    assert.deepEqual([failed.event, failed.step, failed.ok], ['autosync', 'push', false], JSON.stringify(failed));
    assert.ok(failed.error && failed.fix.includes('memory.mjs') && failed.fix.includes('sync'), JSON.stringify(failed));
    const told = startOut(start(v, repo, 's1'));
    assert.match(told.user, /^Warning: the last memory sync failed \(.* UTC, step push\): .+\. Fix: open the vault and run: node ".*memory\.mjs" sync$/);
    assert.match(told.context, /^# Project shop/);
    const status = projectJson(v, 'status', repo);
    assert.deepEqual([status.hooks.last_sync.ok, status.hooks.last_sync.step], [false, 'push']);
    assert.equal(status.hooks.failures.length, 1);

    // The remote folder is gone: the pull fails first, logged the same way, and told in a repository
    // the vault does not know as well.
    git(v.root, ['remote', 'set-url', '--delete', '--push', 'origin', '.*']);
    fs.rmSync(remote, { recursive: true, force: true });
    cli(v, ['hook', 'claude-code', 'autosync']);
    const gone = logOf(v).at(-1);
    assert.ok(['pull', 'push'].includes(gone.step) && gone.ok === false && gone.fix.includes('sync'), JSON.stringify(gone));
    const stranger = startOut(start(v, codeRepo({ remote: 'https://github.com/linden/stranger.git', name: 'stranger' }), 's1b'));
    assert.match(stranger.user, /Warning: the last memory sync failed/);
    assert.match(stranger.user, / project add\b/, 'next to the hint of the new repository');

    // A working remote again: session end starts the autosync in the background, the warning goes.
    git(path.dirname(remote), ['init', '-q', '--bare', remote]);
    git(v.root, ['push', '-q', '-u', 'origin', 'HEAD']);
    assert.equal(cli(v, ['remember', 'a second note for the inbox'], { cwd: v.root }).code, 0);
    const end = hook(v, 'session-end', { cwd: repo, session_id: 's1', reason: 'other' });
    assert.deepEqual([end.code, end.stdout], [0, '']);
    const deadline = Date.now() + 30000;
    while (logOf(v).at(-1)?.step !== 'done' && Date.now() < deadline) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    assert.equal(logOf(v).at(-1)?.step, 'done', JSON.stringify(logOf(v).at(-1)));
    assert.equal(startOut(start(v, repo, 's2')).user, '', 'a successful sync: nothing to tell');
  });

  test('autosync never concludes an unfinished merge, and a lock it cannot make is logged', () => {
    const v = vault('en', { withGit: true, projects: { enabled: true, autosync: true } });
    const waiting = path.join(v.root, 'waiting.md');
    const base = fs.existsSync(waiting) ? fs.readFileSync(waiting, 'utf8') : '# Waiting\n';
    fs.writeFileSync(waiting, base);
    git(v.root, ['add', '-A']);
    git(v.root, ['commit', '-q', '--allow-empty', '-m', 'base']);
    const main = git(v.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    git(v.root, ['checkout', '-qb', 'side']);
    fs.writeFileSync(waiting, `${base}\n- the side line\n`);
    git(v.root, ['commit', '-qam', 'side']);
    git(v.root, ['checkout', '-q', main]);
    fs.writeFileSync(waiting, `${base}\n- the main line\n`);
    git(v.root, ['commit', '-qam', 'main']);
    const merge = spawnSync('git', ['merge', 'side'], { cwd: v.root, encoding: 'utf8', windowsHide: true });
    assert.notEqual(merge.status, 0, 'a conflict');
    assert.match(git(v.root, ['status', '--porcelain']), /^UU waiting\.md/m);
    const head = git(v.root, ['rev-parse', 'HEAD']);
    const res = cli(v, ['hook', 'claude-code', 'autosync']);
    assert.deepEqual([res.code, res.stdout], [0, '']);
    const logged = logOf(v).at(-1);
    assert.deepEqual([logged.event, logged.step, logged.ok], ['autosync', 'check', false], JSON.stringify(logged));
    assert.match(logged.error, /merge/);
    assert.match(logged.fix, /abort.*sync/);
    assert.equal(git(v.root, ['rev-parse', 'HEAD']), head, 'nothing committed');
    assert.match(fs.readFileSync(waiting, 'utf8'), /^<<<<<<< /m, 'the conflict is left to the user');
    // Resolved in the files but the merge not committed yet: still left alone.
    fs.writeFileSync(waiting, `${base}\n- the main line\n- the side line\n`);
    git(v.root, ['add', 'waiting.md']);
    cli(v, ['hook', 'claude-code', 'autosync']);
    assert.deepEqual([logOf(v).at(-1).step, logOf(v).at(-1).ok], ['check', false]);
    assert.equal(git(v.root, ['rev-parse', 'HEAD']), head);
    git(v.root, ['merge', '--abort']);

    // The lock folder is a file: the failure is logged with a fix, the hook still exits 0.
    fs.rmSync(path.join(v.root, '.memory-kit', 'capture'), { recursive: true, force: true });
    fs.mkdirSync(path.join(v.root, '.memory-kit'), { recursive: true });
    fs.writeFileSync(path.join(v.root, '.memory-kit', 'capture'), 'not a folder');
    const locked = cli(v, ['hook', 'claude-code', 'autosync']);
    assert.deepEqual([locked.code, locked.stdout, locked.stderr], [0, '', '']);
    const lockLog = logOf(v).at(-1);
    assert.deepEqual([lockLog.event, lockLog.step, lockLog.ok], ['autosync', 'lock', false], JSON.stringify(lockLog));
    assert.ok(lockLog.error && lockLog.fix.includes('capture'), JSON.stringify(lockLog));
    for (const e of logOf(v).filter((x) => x.event === 'autosync')) assert.ok(['lock', 'check', 'commit', 'pull', 'push', 'done'].includes(e.step), e.step);
  });

  test("two clients' look-alike repositories stay apart", () => {
    const v = vault('en', { withGit: true });
    const a = codeRepo({ remote: 'git@github.com:team/website.git', name: 'website' });
    const b = codeRepo({ remote: 'https://gitlab.clientb.example/team/website.git', name: 'website' });
    assert.equal(projectJson(v, 'add', a).sector, 'dev');
    assert.equal(cli(v, ['remember', '--type', 'gotcha', 'ClientA payment gateway rejects amounts with three decimals'], { cwd: a }).code, 0);
    const bStart = startOut(start(v, b, 'b1'));
    assert.ok(!/ClientA|# Project/.test(`${bStart.user}${bStart.context}`), 'B gets the hint, not the notes of A');
    assert.match(bStart.user, / project add\b/);
    assert.equal(projectJson(v, 'status', b).project, null);
    const kept = JSON.parse(cli(v, ['remember', '--type', 'decision', 'ClientB wants invoices monthly', '--json'], { cwd: b }).stdout);
    assert.equal(kept.sector, null, 'nothing goes into the notes of A');
    assert.equal(projectJson(v, 'remove', b).code, 1, 'B cannot unlink A');
    const bAdd = projectJson(v, 'add', b);
    assert.deepEqual([bAdd.created, bAdd.sector], [true, 'dev-2'], 'B gets a project of its own');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(v.root, '..', 'private', 'projects.json'), 'utf8')).repos,
      { 'github.com/team/website': 'dev', 'gitlab.clientb.example/team/website': 'dev-2' });
    assert.equal(projectJson(v, 'remove', b).sector, 'dev-2');
    assert.equal(projectJson(v, 'status', a).project.sector, 'dev', 'A keeps its project');

    // The same repository through an ssh host alias still finds its project, marked as such; remove
    // there unlinks nothing, and ignore stops the loose match.
    const alias = codeRepo({ remote: 'git@github.com-work:team/website.git', name: 'website-work' });
    const via = projectJson(v, 'status', alias);
    assert.deepEqual(via.project && [via.project.sector, via.project.via], ['dev', 'github.com/team/website']);
    const refused = projectJson(v, 'remove', alias);
    assert.deepEqual([refused.code, refused.reason, refused.via], [1, 'borrowed', 'github.com/team/website']);
    const own = codeRepo({ remote: 'git@github.com-home:team/website.git', name: 'website-home' });
    assert.deepEqual([projectJson(v, 'add', own).created, projectJson(v, 'status', own).project.via], [true, null], 'add there makes a project of its own');
    assert.equal(projectJson(v, 'ignore', alias).changed, true);
    assert.equal(projectJson(v, 'status', alias).project, null);
    assert.equal(projectJson(v, 'status', a).project.sector, 'dev');

    // A repository without a commit has no lasting key: project add refuses, and a repository
    // elsewhere with the same folder name is not taken for it.
    const empty = path.join(tmpDir('empty'), 'api');
    fs.mkdirSync(empty, { recursive: true });
    git(empty, ['init', '-q']);
    const noCommit = projectJson(v, 'add', empty);
    assert.deepEqual([noCommit.code, noCommit.reason], [1, 'no_commit']);
    assert.equal(start(v, empty, 'e1').stdout, '', 'no hint either until the first commit');
    assert.equal(projectJson(v, 'status', empty).repo.unsettled, 'no_commit');
    assert.match(project(v, 'status', empty).stdout, /no commit yet/);
    const api = codeRepo({ remote: 'https://github.com/otherclient/billing-api.git', name: 'api' });
    assert.equal(projectJson(v, 'status', api).project, null);

    // Two local remotes with the same folder name are two projects.
    const bare1 = path.join(tmpDir('bare1'), 'shop.git');
    const bare2 = path.join(tmpDir('bare2'), 'shop.git');
    const s1 = codeRepo({ remote: bare1, name: 's1' });
    const s2 = codeRepo({ remote: bare2, name: 's2' });
    assert.equal(projectJson(v, 'add', s1).created, true);
    assert.equal(projectJson(v, 'status', s2).project, null);

    // Nothing about either client reached the files git sees.
    assert.deepEqual(leaks(v.root, 'clienta|clientb|team/website'), []);
    clean(a);
    clean(b);
  });

  test('a note in a repository that is not a project stays on this computer', () => {
    const v = vault('en', { withGit: true });
    const repo = codeRepo({ remote: 'git@github.com:acme-corp/portal.git', name: 'portal' });
    const res = cli(v, ['remember', '--type', 'gotcha', 'Acme portal: SSO callback breaks when tenant id has uppercase'], { cwd: repo });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /local inbox.*\.\.\/private\/inbox\/.*\.md.* project add/);
    const [file] = fs.readdirSync(path.join(v.root, '..', 'private', 'inbox'));
    assert.match(fs.readFileSync(path.join(v.root, '..', 'private', 'inbox', file), 'utf8'), /SSO callback breaks/);
    assert.deepEqual(leaks(v.root, 'acme'), []);
    const check = checkJson(v.root, ['--generate', '--strict']);
    assert.equal(check.code, 0, describeFindings(check));
    // In the vault itself, or outside any repository, a note goes into the vault's inbox as before.
    const own = JSON.parse(cli(v, ['remember', 'buy flour', '--json'], { cwd: v.root }).stdout);
    assert.match(own.rel, /^inbox\//);
    assert.match(JSON.parse(cli(v, ['remember', 'call the baker', '--json'], { cwd: tmpDir('plain') }).stdout).rel, /^inbox\//);
    clean(repo);
  });

  test('stop after a project added mid-session asks only when the code changes from then on', () => {
    const v = vault('en');
    const repo = codeRepo();
    assert.match(start(v, repo, 'm1').stdout, / project add\b/, 'a new repository: the hint');
    assert.equal(projectJson(v, 'add', repo).created, true);
    const stopIn = { cwd: repo, session_id: 'm1', stop_hook_active: false };
    assert.equal(hook(v, 'stop', stopIn).stdout, '', 'a clean tree: nothing to ask');
    fs.appendFileSync(path.join(repo, 'index.js'), 'console.log(3);\n');
    const ask = JSON.parse(hook(v, 'stop', stopIn).stdout);
    assert.equal(ask.decision, 'block');
    assert.match(ask.reason, /remember --project dev --type gotcha/, 'the command names the project, whatever the cwd');
    git(repo, ['checkout', '--', 'index.js']);
    // A record linked by an older version (no baseline): the first stop only records it.
    const sessions = path.join(v.root, '.memory-kit', 'capture', 'sessions');
    fs.writeFileSync(path.join(sessions, 'old.json'), JSON.stringify({ top: repo, sector: 'dev', store: 'local' }));
    fs.appendFileSync(path.join(repo, 'index.js'), 'console.log(4);\n');
    assert.equal(hook(v, 'stop', { ...stopIn, session_id: 'old' }).stdout, '');
    assert.equal(hook(v, 'stop', { ...stopIn, session_id: 'old' }).stdout, '', 'no change since the baseline');
    git(repo, ['checkout', '--', 'index.js']);
  });

  test('session records: also in the vault and outside projects, old ones pruned; Codex in the vault gets the start view', () => {
    const v = vault('en');
    const sessions = path.join(v.root, '.memory-kit', 'capture', 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const old = path.join(sessions, 'old1.json');
    fs.writeFileSync(old, JSON.stringify({ top: null, sector: null }));
    const past = new Date(Date.now() - 60 * 86400000);
    fs.utimesSync(old, past, past);
    assert.equal(start(v, v.root, 'v1').stdout, '');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessions, 'v1.json'), 'utf8')).sector, null, 'a vault session is recorded');
    assert.ok(!fs.existsSync(old), 'records older than 30 days are pruned on any session start');
    assert.equal(failure(v, v.root, 'v1', { error: ENOSPC }).stdout, '');
    const codex = start(v, v.root, 'v2', 'codex');
    assert.equal(codex.code, 0, codex.stderr);
    assert.ok(codex.stdout.trim().length > 0 && !codex.stdout.trim().startsWith('{'), 'Codex: the start view as plain text');
  });
});
