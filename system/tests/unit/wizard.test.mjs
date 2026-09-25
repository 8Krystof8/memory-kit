// The setup wizard (lib/wizard.mjs) and `setup`: scripted answers on a fresh vault give the same
// memory.json and generated files as the equivalent `init … --yes`; Ctrl+C changes nothing and
// exits 130; the extras menu (connect, coding projects, health check) with injected parts; and
// init and setup without a terminal behave as before.

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createUI } from '../../lib/tui.mjs';
import { guessLang, runSetup, runWizard } from '../../lib/wizard.mjs';
import { KEY, escapes, fakeTerminal, screen } from '../fake-terminal.mjs';
import { TODAY, copyKit, hashGenerated, readFile, removeTmpDirs, runCli, runInit, tmpDir } from '../helpers.mjs';

after(removeTmpDirs);

const down = (n) => KEY.down.repeat(n);
const freshVault = (label, parent = '') => copyKit(path.join(tmpDir(label), parent, 'vault'));

/** A UI on a fake terminal: { ui, term }. */
function terminal({ columns = 80, color = false } = {}) {
  const term = fakeTerminal({ columns, rows: 40 });
  const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env: { TERM: 'xterm-256color' }, platform: 'linux', color });
  return { ui, term };
}

/** An initialized vault (init --yes) and its config. */
async function initializedVault(label, lang = 'en') {
  const root = freshVault(label);
  const res = runInit(root, ['--mode', 'github', '--lang', lang, '--sectors', 'core,work', '--today', TODAY, '--yes']);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const { loadConfig } = await import('../../lib/config.mjs');
  return { root, cfg: loadConfig(root) };
}

describe('the wizard sets up a vault like init does', () => {
  test('en, combined, a local sector, one detected AI tool; a path with spaces and diacritics', async () => {
    const root = freshVault('wiz-en', 'Moje Paměť');
    const { ui, term } = terminal();
    term.keys(
      KEY.enter, // language: English (guessed from LANG)
      `${down(2)}${KEY.enter}`, // mode: combined
      `${down(5)}${KEY.space}${KEY.enter}`, // sectors: core, work (preselected) + health
      KEY.enter, // private folder: the default
      KEY.enter, // AI tools: the detected one
      KEY.enter, // set up now? yes
      `${down(3)}${KEY.enter}`, // extras: finish
    );
    const code = await runWizard({
      root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { today: TODAY, 'allow-ephemeral': true }, detect: () => ['claude-code'],
    });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    for (const line of ['◇  Where should the memory live?\n│  combined', '◇  Which sectors (areas of life)?\n│  Core, Work, Health',
      '◇  Private folder for local sectors (outside this repository, never pushed)\n│  ../vault-private', '◇  Memory is set up']) {
      assert.ok(shown.includes(line), `${line}\n---\n${shown}`);
    }
    assert.ok(shown.includes('◇  Next steps\n│  • Fill in your profile: sectors/core/profile.md.'), shown);
    assert.ok(shown.endsWith('└  Done. Your memory is ready.\n\n'), shown.slice(-200));
    assert.equal(term.raw.at(-1), false);

    const twin = freshVault('wiz-en-init', 'Moje Paměť');
    const res = runInit(twin, ['--mode', 'combined', '--lang', 'en', '--sectors', 'core,work,health', '--agents', 'claude-code', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(readFile(root, 'memory.json'), readFile(twin, 'memory.json'));
    assert.deepEqual(hashGenerated(root), hashGenerated(twin));
    assert.ok(fs.statSync(path.join(root, '..', 'vault-private', 'sectors', 'health')).isDirectory());
  });

  test('cs, github with a sector that is local by default kept in the repository', async () => {
    const root = freshVault('wiz-cs');
    const { ui, term } = terminal({ color: true });
    term.keys(
      KEY.enter, // language: Čeština (guessed from LANG)
      KEY.enter, // mode: github
      `${down(5)}${KEY.space}${KEY.enter}`, // sectors: + Zdraví
      `${down(1)}${KEY.enter}`, // Zdraví: keep it in the private GitHub repository
      KEY.enter, // AI tools: the detected ones
      'y', // set up now
      `${down(3)}${KEY.enter}`, // finish
    );
    const code = await runWizard({
      root, ui, env: { LANG: 'cs_CZ.UTF-8' }, opts: { today: TODAY }, detect: () => ['claude-code', 'codex'],
    });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('◇  Jazyk paměti (názvy složek, pole poznámek, hlášky)\n│  Čeština'), shown);
    assert.ok(shown.includes('│  nechat je v soukromém repu na GitHubu'), shown);
    assert.ok(!shown.includes('Soukromá složka'), 'no private folder question in mode github');
    assert.ok(shown.includes('└  Hotovo. Paměť je připravená.'), shown);
    for (const e of escapes(term.output())) assert.match(e, /^\x1b\[(?:\d+A|J|\?25[lh]|0|1|22|7|27|3\d|9\d)m?$/, JSON.stringify(e));

    const twin = freshVault('wiz-cs-init');
    const res = runInit(twin, ['--mode', 'github', '--lang', 'cs', '--sectors', 'core,work,health:github', '--agents', 'claude-code,codex', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(readFile(root, 'memory.json'), readFile(twin, 'memory.json'));
    assert.deepEqual(hashGenerated(root), hashGenerated(twin));
  });

  test('flags become the answers: custom sectors, :github, --agents all, --private-root in mode github', async () => {
    const root = freshVault('wiz-flags');
    const { ui, term } = terminal();
    // language, mode, sectors, what to do with notes, private folder, AI tools, set up now, finish
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const flags = { mode: 'github', sectors: 'core,work,projekt,health:github,notes:local', agents: 'all', 'private-root': '../elsewhere' };
    const code = await runWizard({
      root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { ...flags, today: TODAY, 'allow-ephemeral': true }, detect: () => ['claude-code'],
    });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    assert.ok(shown.includes('◇  Which sectors (areas of life)?\n│  Core, Work, Health, projekt, notes'), shown);
    // Only notes (explicitly :local) needs a decision in mode github; health:github is settled.
    assert.ok(shown.includes('◇  notes: sectors usually kept off GitHub, but mode github has no private\n│  folder\n│  switch to combined'), shown);
    assert.ok(shown.includes('◇  Private folder for local sectors (outside this repository, never pushed)\n│  ../elsewhere'), shown);
    assert.ok(shown.includes('◇  Which AI tools will use this memory?\n│  Claude Code, Codex, Gemini CLI, Cursor, ChatGPT, Claude app'), shown);
    assert.ok(shown.includes('◇  Memory is set up'), shown);

    const twin = freshVault('wiz-flags-init');
    const res = runInit(twin, ['--mode', 'combined', '--lang', 'en', '--sectors', 'core,work,health:github,projekt,notes:local', '--agents', 'all',
      '--private-root', '../elsewhere', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(readFile(root, 'memory.json'), readFile(twin, 'memory.json'));
    assert.deepEqual(hashGenerated(root), hashGenerated(twin));
  });

  test('--private-root is kept in mode github without local sectors, as init keeps it', async () => {
    const root = freshVault('wiz-private');
    const { ui, term } = terminal();
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const code = await runWizard({
      root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { 'private-root': '../elsewhere', today: TODAY, 'allow-ephemeral': true }, detect: () => ['codex'],
    });
    assert.equal(code, 0, screen(term.output()));
    const twin = freshVault('wiz-private-init');
    const res = runInit(twin, ['--mode', 'github', '--lang', 'en', '--sectors', 'core,work', '--agents', 'codex', '--private-root', '../elsewhere', '--today', TODAY, '--yes']);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.equal(readFile(root, 'memory.json'), readFile(twin, 'memory.json'));
  });

  test('next steps in a git repository: the commit commands unwrapped and outside any box', async () => {
    const root = freshVault('wiz-git');
    assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true }).status, 0);
    const { ui, term } = terminal({ columns: 40 });
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { today: TODAY }, detect: () => ['codex'] });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    const steps = shown.slice(shown.indexOf('◇  Next steps'));
    assert.ok(steps.includes('│  • Commit now, one command at a time:\n│    git add -A\n│    git commit -m "Set up memory"\n'), steps);
    assert.ok(!/[╮╯]/.test(steps), 'no box around the next steps');
  });

  test('a wrong flag stops the wizard before its first question', async () => {
    const root = freshVault('wiz-badflag');
    const before = readFile(root, 'memory.json');
    for (const opts of [{ sectors: 'core,Bad Id' }, { agents: 'claude-code,nobody' }, { mode: 'cloud' }, { sectors: 'core:local' }]) {
      const { ui, term } = terminal();
      const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts, detect: () => [] });
      const shown = screen(term.output());
      assert.equal(code, 2, shown);
      assert.ok(!shown.includes('◇'), `no question was asked: ${shown}`);
      assert.ok(shown.endsWith('└  Nothing changed.\n\n'), shown);
    }
    assert.equal(readFile(root, 'memory.json'), before);
  });

  test('--dry-run ends after the summary', async () => {
    const root = freshVault('wiz-dry');
    const before = readFile(root, 'memory.json');
    const { ui, term } = terminal();
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter);
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { 'dry-run': true, today: TODAY }, detect: () => [] });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.match(shown, /◇  Summary ─+╮/);
    assert.ok(!shown.includes('Set up the memory now?'), shown);
    assert.ok(shown.endsWith('└  Plan only (--dry-run), nothing changed.\n\n'), shown);
    assert.equal(readFile(root, 'memory.json'), before);
  });

  test('Ctrl+C before the confirmation changes nothing and exits 130', async () => {
    const root = freshVault('wiz-cancel');
    const before = readFile(root, 'memory.json');
    const { ui, term } = terminal();
    term.keys(KEY.enter, `${down(1)}${KEY.ctrlC}`);
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { today: TODAY }, detect: () => [] });
    assert.equal(code, 130);
    assert.equal(readFile(root, 'memory.json'), before);
    assert.ok(screen(term.output()).endsWith('│\n└  Cancelled, nothing changed.\n\n'), screen(term.output()));
    assert.equal(term.raw.at(-1), false, 'raw mode is off');
    assert.equal(escapes(term.output()).filter((e) => e.startsWith('\x1b[?25')).at(-1), '\x1b[?25h', 'cursor shown');
  });

  test('answering No at the confirmation changes nothing', async () => {
    const root = freshVault('wiz-no');
    const before = readFile(root, 'memory.json');
    const { ui, term } = terminal();
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, 'n');
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { today: TODAY }, detect: () => [] });
    assert.equal(code, 0);
    assert.equal(readFile(root, 'memory.json'), before);
    assert.match(screen(term.output()), /└  Nothing changed\. Run node system\/init\.mjs again when you are ready\.\n/);
  });
});

describe('the extras menu (setup in a vault that is set up)', () => {
  test('memory for coding projects: not available when hooksetup has no installProjects', async () => {
    const { root, cfg } = await initializedVault('setup-noproj');
    const { ui, term } = terminal();
    term.keys(`${down(1)}${KEY.enter}`, `${down(3)}${KEY.enter}`);
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => ({}) });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('●  memory-kit is set up here · language en · mode github'), shown);
    assert.ok(shown.includes('▲ Memory for coding projects is not available in this version of memory-kit.'), shown);
    assert.ok(shown.endsWith('└  Done.\n\n'));
  });

  test('memory for coding projects: the answers reach installProjects (defaults: no auto add, local notes, no push)', async () => {
    const { root, cfg } = await initializedVault('setup-proj');
    const calls = [];
    const hooks = {
      installProjects: async (vault, opts) => {
        calls.push({ vault, opts });
        return {
          file: '/home/test/.claude/settings.json', changed: true, backup: null, form: 'shell', warnings: ['Claude Code 2.1.100 is old'],
          settings: { enabled: true, auto_add: opts.autoAdd, store: opts.store, autosync: opts.autosync },
        };
      },
    };
    const { ui, term } = terminal();
    term.keys(`${down(1)}${KEY.enter}`, 'y', KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => true, hookOptions: { home: '/home/test' } });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].vault, root);
    assert.deepEqual(calls[0].opts, { agent: 'claude-code', autoAdd: false, store: 'local', autosync: false, home: '/home/test' });
    assert.ok(shown.includes('◇  Add every repository automatically? (No: only projects you add)\n│  No'), shown);
    assert.ok(shown.includes('◇  Commit and push the memory at the end of each session?\n│  No'), 'asked because the vault has a remote');
    assert.ok(shown.includes('◇  Hooks are in /home/test/.claude/settings.json'), shown);
    const joined = shown.replace(/\n│ {2}(?![◇▲✓●])/g, ' ');
    assert.ok(joined.includes('add repositories automatically: No · project notes: this computer only · push at session end: No'), shown);
    assert.ok(shown.includes('▲ Claude Code 2.1.100 is old'));
  });

  test('memory for coding projects stays off by default; no push question without a remote', async () => {
    const { root, cfg } = await initializedVault('setup-proj-off');
    let called = 0;
    const hooks = { installProjects: async () => { called += 1; return { file: 'x', changed: true, settings: {} }; } };
    const { ui, term } = terminal();
    term.keys(
      `${down(1)}${KEY.enter}`, KEY.enter, // projects: switch on? No (the default)
      `${down(1)}${KEY.enter}`, 'y', KEY.enter, KEY.enter, // projects again: yes, defaults, no push question
      `${down(3)}${KEY.enter}`, // finish
    );
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => false });
    assert.equal(code, 0);
    assert.equal(called, 1, 'installed only on the second, explicit yes');
    const shown = screen(term.output());
    assert.ok(shown.includes('● Memory for coding projects stays off.'), shown);
    assert.ok(!shown.includes('Commit and push the memory'), 'no remote, no autosync question');
  });

  // setup → Memory for coding projects → Yes, No, Yes (no remote) → Finish
  const PROJECTS_ON = [`${down(1)}${KEY.enter}`, 'y', KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`];
  const SNIPPET = '{\n  "hooks": {\n    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \\"/home/test/Moje paměť/system/memory.mjs\\" hook" }] }]\n  }\n}';

  test('memory for coding projects: a refused install is shown as failed, with its fix, never as installed', async () => {
    const { root, cfg } = await initializedVault('setup-proj-refused');
    const hooks = {
      installProjects: async () => ({
        agent: 'claude-code', file: '/home/test/.claude/settings.json', changed: false, backup: null, action: 'refused', ok: false, exit: 1,
        error: 'settings.json cannot be read (EISDIR)', fix: 'fix the file or its permissions, then connect again',
        settings: null, memoryChanged: false, warnings: [],
      }),
    };
    const { ui, term } = terminal({ columns: 120 });
    term.keys(...PROJECTS_ON);
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => false });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('■  The hooks could not be installed: settings.json cannot be read (EISDIR)\n'), shown);
    assert.ok(shown.includes('│  fix: fix the file or its permissions, then connect again\n'), shown);
    assert.ok(!shown.includes('are current') && !shown.includes('Hooks are in') && !shown.includes('push at session end'), shown);
  });

  test('memory for coding projects: a thrown refusal with a snippet prints the snippet whole, outside any box', async () => {
    const { root, cfg } = await initializedVault('setup-proj-snippet');
    class ProjectsRefused extends Error {
      constructor(result) {
        super(`${result.error}; fix: ${result.fix}`);
        this.name = 'ProjectsRefused';
        this.result = result;
      }
    }
    const hooks = {
      installProjects: async () => {
        throw new ProjectsRefused({
          file: '/home/test/.claude/settings.json', action: 'refused', ok: false, error: '/home/test/.claude/settings.json is not JSON', fix: 'add the hooks below by hand',
          snippet: SNIPPET, memoryChanged: true, dryRun: false, warnings: ['Claude Code 2.1.100 is old'],
        });
      },
    };
    const { ui, term } = terminal({ columns: 60 });
    term.keys(...PROJECTS_ON);
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => false });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('■  The hooks could not be installed:'), shown);
    assert.ok(shown.includes(`│  Add these hooks to /home/test/.claude/settings.json\n│  yourself:\n│\n${SNIPPET}\n│\n`), shown);
    assert.ok(shown.includes('│  ● memory.json has it switched on: it works once the\n│    hooks are in place.'), shown);
    assert.ok(shown.includes('│  ▲ Claude Code 2.1.100 is old'), shown);
    assert.ok(!shown.includes('are current'), shown);
  });

  test('memory for coding projects: a result with a snippet (file not editable) is a warning, not "current"', async () => {
    const { root, cfg } = await initializedVault('setup-proj-snippet2');
    const hooks = { installProjects: async () => ({ file: '/home/test/.claude/settings.json', changed: false, backup: null, settings: {}, warnings: [], snippet: SNIPPET }) };
    const { ui, term } = terminal({ columns: 100 });
    term.keys(...PROJECTS_ON);
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => false });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('▲  The hooks are not installed: /home/test/.claude/settings.json cannot be edited automatically\n'), shown);
    assert.ok(shown.includes(`\n${SNIPPET}\n`), shown);
    assert.ok(!shown.includes('are current') && !shown.includes('push at session end'), shown);
  });

  test('memory for coding projects when it is on: keep, change (current answers preselected) or switch off', async () => {
    const { root, cfg } = await initializedVault('setup-proj-on');
    const raw = JSON.parse(readFile(root, 'memory.json'));
    raw.projects = { enabled: true, auto_add: true, store: 'git', autosync: true, checkpoint: true, error_lookup: true, repos: {} };
    fs.writeFileSync(path.join(root, 'memory.json'), `${JSON.stringify(raw, null, 2)}\n`);
    const calls = [];
    const hooks = {
      installProjects: async (vault, opts) => {
        calls.push(opts);
        if (opts.remove) return { file: '/h/settings.json', changed: true, action: 'removed', backup: '/h/backup', warnings: [] };
        return { file: '/h/settings.json', changed: false, action: 'unchanged', backup: null, warnings: [], settings: raw.projects };
      },
    };
    const { ui, term } = terminal({ columns: 120 });
    term.keys(
      `${down(1)}${KEY.enter}`, KEY.enter, // projects: keep
      `${down(1)}${KEY.enter}`, `${down(1)}${KEY.enter}`, KEY.enter, KEY.enter, KEY.enter, // projects: change, Enter keeps each answer
      `${down(1)}${KEY.enter}`, `${down(2)}${KEY.enter}`, // projects: switch off
      `${down(3)}${KEY.enter}`, // finish
    );
    const code = await runSetup({ root, cfg, ui, loadHooks: async () => hooks, hasRemote: () => true });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.deepEqual(calls, [{ agent: 'claude-code' }, { agent: 'claude-code', autoAdd: true, store: 'git', autosync: true }, { agent: 'claude-code', remove: true }]);
    const joined = shown.replace(/\n│ {2}(?![◇▲✓●])/g, ' ');
    assert.ok(joined.includes('add repositories automatically: Yes · project notes: in the memory repository · push at session end: Yes\n│\n◇  Memory for coding projects is on. What now? Keep it'), joined);
    assert.ok(!shown.includes('stays off'), shown);
    assert.ok(shown.includes('◇  Memory for coding projects is off; the hooks are out of /h/settings.json'), shown);
  });

  test('health check: counts and at most three problems', async () => {
    const { root, cfg } = await initializedVault('setup-doctor');
    const report = {
      summary: { ok: 12, warn: 3, fail: 1 },
      checks: [
        { id: 'node.version', status: 'ok', message: 'Node.js 24' },
        { id: 'git.hooks', status: 'warn', message: 'core.hooksPath is not set' },
        { id: 'kit.integrity', status: 'fail', message: '2 kit files differ' },
        { id: 'clients', status: 'warn', message: 'no app connected' },
        { id: 'platform', status: 'warn', message: 'OneDrive folder' },
      ],
    };
    const { ui, term } = terminal();
    term.keys(`${down(2)}${KEY.enter}`, `${down(3)}${KEY.enter}`);
    const code = await runSetup({ root, cfg, ui, runDoctor: async () => report });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.ok(shown.includes('■  Health check: ✓ 12  ! 3  ✗ 1'), shown);
    const problems = shown.split('\n').filter((l) => /^│  [✗▲] /.test(l));
    assert.deepEqual(problems, ['│  ✗ kit.integrity: 2 kit files differ', '│  ▲ git.hooks: core.hooksPath is not set', '│  ▲ clients: no app connected']);
    assert.ok(shown.includes('│  1 more: node system/memory.mjs doctor'));
  });

  test('health check against the real doctor of the vault', async () => {
    const { root, cfg } = await initializedVault('setup-doctor-real');
    const { ui, term } = terminal();
    term.keys(`${down(2)}${KEY.enter}`, `${down(3)}${KEY.enter}`);
    assert.equal(await runSetup({ root, cfg, ui }), 0);
    assert.match(screen(term.output()), /[◇▲■] {2}Health check: ✓ \d+ {2}! \d+ {2}✗ \d+\n/);
  });

  test('connect AI apps: only apps found here, the not connected ones preselected', async () => {
    const { root, cfg } = await initializedVault('setup-connect');
    const rows = [
      { id: 'claude-desktop', name: 'Claude Desktop', appFound: true, state: 'connected', guide: null },
      { id: 'cursor', name: 'Cursor', appFound: true, state: 'not-connected', guide: null },
      { id: 'zed', name: 'Zed', appFound: false, state: 'app-not-found', guide: null },
      { id: 'chatgpt', name: 'ChatGPT', appFound: false, state: 'guidance', guide: 'chatgpt' },
    ];
    const calls = [];
    const connectClient = (opts) => {
      calls.push(opts);
      return { ok: true, messages: [{ key: 'connect.added', vars: { client: 'Cursor', name: 'memory-kit', path: '/x/mcp.json' } }] };
    };
    const { ui, term } = terminal();
    term.keys(KEY.enter, KEY.enter, `${down(2)}${KEY.enter}`);
    const code = await runSetup({ root, cfg, ui, inspectClients: () => rows, connectClient });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.deepEqual(calls, [{ client: 'cursor', vault: root }]);
    assert.ok(shown.includes('◇  Which apps should use this memory?\n│  Cursor'), shown);
    assert.ok(!shown.includes('Zed'), 'an app that is not installed is not offered');
    assert.match(shown, /◇ {2}Cursor: .*\/x\/mcp\.json/);
  });
});

describe('without a terminal', () => {
  test('setup explains itself and exits 2; the Czech alias nastaveni too', async () => {
    const { root } = await initializedVault('setup-pipe');
    const res = runCli(root, ['setup']);
    assert.equal(res.code, 2);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /needs|terminal/);
    const cs = await initializedVault('setup-pipe-cs', 'cs');
    const alias = runCli(cs.root, ['nastaveni']);
    assert.equal(alias.code, 2);
    assert.match(alias.stderr, /terminál/);
  });

  test('init without answers still prints the questions and exits 2; the flags exclude each other', () => {
    const root = freshVault('init-pipe');
    const res = runInit(root, []);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /^init: missing --mode, --lang, --sectors/);
    assert.match(res.stdout, /^Ask the user these questions/);
    assert.deepEqual(escapes(res.stdout + res.stderr), []);
    const both = runInit(root, ['--interactive', '--no-interactive']);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /exclude each other/);
  });

  const PIPE_ENV = { LANG: 'en_US.UTF-8', LC_ALL: '', LC_MESSAGES: '', TERM: 'dumb' };

  test('init --interactive in a pipe shows the defaults as plain text and applies nothing without --yes', () => {
    const root = freshVault('init-forced');
    const before = readFile(root, 'memory.json');
    const res = runInit(root, ['--interactive', '--today', TODAY], { env: PIPE_ENV });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.deepEqual(escapes(res.stdout), []);
    // A Windows pipe gets the ASCII glyphs (the reader's code page is unknown).
    const [start, done, bar, end] = process.platform === 'win32' ? ['+', 'o', '|', '+'] : ['┌', '◇', '│', '└'];
    assert.ok(res.stdout.startsWith(`${start}  memory-kit`), res.stdout);
    assert.ok(res.stdout.includes(`${done}  Where should the memory live?\n${bar}  github\n`), res.stdout);
    assert.ok(res.stdout.includes(`${done}  Set up the memory now?\n${bar}  No\n`), res.stdout);
    assert.ok(res.stdout.endsWith(`${end}  Nothing changed: no terminal to confirm in (add --yes to apply).\n\n`), res.stdout);
    assert.equal(readFile(root, 'memory.json'), before);
  });

  test('init --interactive --yes in a pipe applies the defaults', () => {
    const root = freshVault('init-forced-yes');
    const res = runInit(root, ['--interactive', '--yes', '--today', TODAY], { env: PIPE_ENV });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    const cfg = JSON.parse(readFile(root, 'memory.json'));
    assert.equal(cfg.initialized, true);
    assert.equal(cfg.mode, 'github');
    assert.equal(cfg.lang, 'en');
    assert.ok(cfg.agents.length >= 1);
  });

  test('setup --interactive in a pipe sets up a new vault only with --yes', () => {
    const root = freshVault('setup-forced');
    const before = readFile(root, 'memory.json');
    const res = runCli(root, ['setup', '--interactive'], { env: PIPE_ENV });
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /Nothing changed: no terminal to confirm in \(add --yes to apply\)\.\n\n$/);
    assert.equal(readFile(root, 'memory.json'), before);
    const yes = runCli(root, ['setup', '--interactive', '--yes'], { env: PIPE_ENV });
    assert.equal(yes.code, 0, yes.stdout + yes.stderr);
    assert.equal(JSON.parse(readFile(root, 'memory.json')).initialized, true);
  });

  test('init --interactive --dry-run changes nothing; --interactive --json is a usage error', () => {
    const root = freshVault('init-forced-dry');
    const before = readFile(root, 'memory.json');
    const dry = runInit(root, ['--interactive', '--dry-run', '--yes', '--today', TODAY], { env: PIPE_ENV });
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /Summary/);
    assert.ok(!dry.stdout.includes('Set up the memory now?'), 'no question after a dry run');
    assert.match(dry.stdout, /Plan only \(--dry-run\), nothing changed\.\n\n$/);
    const json = runInit(root, ['--interactive', '--json'], { env: PIPE_ENV });
    assert.equal(json.code, 2);
    assert.equal(json.stdout, '');
    assert.match(json.stderr, /^init: --interactive asks its questions on the screen and prints no JSON/);
    assert.equal(readFile(root, 'memory.json'), before);
  });
});

describe('language guess', () => {
  const packs = new Map([['en', {}], ['cs', {}]]);
  test('LC_ALL, LANG, then English', () => {
    assert.equal(guessLang({ LANG: 'cs_CZ.UTF-8' }, packs), 'cs');
    assert.equal(guessLang({ LC_ALL: 'en_GB.UTF-8', LANG: 'cs_CZ.UTF-8' }, packs), 'en');
    assert.equal(guessLang({ LANG: 'de_DE.UTF-8' }, packs), 'en', 'a language without a pack');
    assert.ok(['en', 'cs'].includes(guessLang({ LANG: 'C', LC_ALL: '' }, packs)), 'C: the system locale decides');
  });
});
