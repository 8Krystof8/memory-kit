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
import { TODAY, agentHome, copyKit, hashGenerated, readFile, removeTmpDirs, runCli, runInit, tmpDir } from '../helpers.mjs';

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

  test('a flag is the answer, its question is not asked: custom sectors, :github, --agents all, --private-root', async () => {
    const root = freshVault('wiz-flags');
    const { ui, term } = terminal();
    // language, what to do with notes (the only decision the flags leave open), set up now, finish
    term.keys(KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const flags = { mode: 'github', sectors: 'core,work,projekt,health:github,notes:local', agents: 'all', 'private-root': '../elsewhere' };
    const code = await runWizard({
      root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { ...flags, today: TODAY, 'allow-ephemeral': true }, detect: () => ['claude-code'],
    });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    for (const question of ['Where should the memory live?', 'Which sectors', 'Private folder', 'Which AI tools']) {
      assert.ok(!shown.includes(question), `not asked: ${question}\n${shown}`);
    }
    // Only notes (explicitly :local) needs a decision in mode github; health:github is settled.
    assert.ok(shown.includes('◇  notes: sectors usually kept off GitHub, but mode github has no private\n│  folder\n│  switch to combined'), shown);
    // The summary shows what the flags said (the sectors in their order), and the result equals init's.
    const summary = shown.slice(shown.indexOf('Summary'), shown.indexOf('Set up the memory now?'));
    for (const text of ['mode: combined', 'sectors: core (github), work (github), projekt (github), health', 'private folder for local sectors: ../elsewhere',
      'AI tools: Claude Code, Codex, Gemini CLI, Cursor, ChatGPT, Claude app']) {
      assert.ok(summary.includes(text), `${text}\n${summary}`);
    }
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
    // language, mode, sectors, AI tools, set up now, finish: the private folder was given
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`);
    const code = await runWizard({
      root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { 'private-root': '../elsewhere', today: TODAY, 'allow-ephemeral': true }, detect: () => ['codex'],
    });
    assert.equal(code, 0, screen(term.output()));
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    assert.ok(!screen(term.output()).includes('Private folder'), 'the given folder is not asked for');
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
    for (const opts of [{ sectors: 'core,Bad Id' }, { agents: 'claude-code,nobody' }, { mode: 'cloud' }, { sectors: 'core:local' }, { 'private-root': '.' }, { lang: 'xx' }]) {
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

  // install.sh and install.ps1 ask the mode themselves (before offering GitHub) and then run
  // `init --root <dir> --mode <mode>`, adding --lang and --sectors only when those were given.
  test('as the installers call it (--mode given): the mode is never asked again', async () => {
    const root = freshVault('wiz-installer');
    const { ui, term } = terminal();
    term.keys(KEY.enter, KEY.enter, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`); // language, sectors, AI tools, set up now, finish
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { mode: 'github', today: TODAY }, detect: () => ['codex'] });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    assert.ok(!term.output().includes('Where should the memory live?'), shown);
    assert.ok(shown.indexOf('◇  Language of the memory') < shown.indexOf('◇  Which sectors'), shown);
    assert.equal(JSON.parse(readFile(root, 'memory.json')).mode, 'github');
  });

  test('with a git remote, local is shown but cannot be chosen; --mode local is refused before any question', async () => {
    const root = freshVault('wiz-remote');
    for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'https://github.com/me/memory.git']]) {
      assert.equal(spawnSync('git', args, { cwd: root, windowsHide: true }).status, 0, args.join(' '));
    }
    const before = readFile(root, 'memory.json');
    const { ui, term } = terminal({ columns: 100 });
    // language; mode: one step down from github skips local and lands on combined; sectors;
    // private folder; AI tools; set up now? no
    term.keys(KEY.enter, `${down(1)}${KEY.enter}`, KEY.enter, KEY.enter, KEY.enter, 'n');
    const code = await runWizard({ root, ui, env: { LANG: 'en_US.UTF-8' }, opts: { today: TODAY, 'allow-ephemeral': true }, detect: () => ['codex'] });
    const shown = screen(term.output());
    assert.equal(code, 0, shown);
    assert.equal(term.pending(), 0, 'every scripted answer was used');
    assert.match(term.output(), /○ local +not here: this folder has a git remote \(origin\)/);
    assert.ok(shown.includes('◇  Where should the memory live?\n│  combined'), shown);
    assert.equal(readFile(root, 'memory.json'), before);

    const refused = terminal();
    const refusedCode = await runWizard({ root, ui: refused.ui, env: { LANG: 'en_US.UTF-8' }, opts: { mode: 'local', today: TODAY }, detect: () => [] });
    const said = screen(refused.term.output());
    assert.equal(refusedCode, 1, said);
    assert.ok(!said.includes('◇'), `no question was asked: ${said}`);
    assert.match(said.replace(/\s*\n│\s+/g, ' '), /refused: mode local promises that nothing leaves this computer, but this repository has a remote \(origin\)\. Remove it/);
    assert.ok(said.endsWith('└  Nothing changed.\n\n'), said);
    assert.equal(readFile(root, 'memory.json'), before);
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

  // The same step against the real lib/hooksetup.mjs, in a home that is never the real one.
  describe('memory for coding projects against the real installProjects', () => {
    const settingsOf = (h) => JSON.parse(fs.readFileSync(h.settings, 'utf8'));
    const projectsOf = (root) => JSON.parse(readFile(root, 'memory.json')).projects;
    /** Runs setup: { code, shown (the screen), text (its lines on the rail joined, so wrapping does not matter), term }. */
    const run = async (root, cfg, h, keys) => {
      const { ui, term } = terminal({ columns: 400 });
      term.keys(...keys);
      const code = await runSetup({ root, cfg, ui, hookOptions: { env: h.env, home: h.home } });
      const shown = screen(term.output());
      return { code, shown, text: shown.replace(/\s*\n│\s*/g, ' '), term };
    };

    test('installed: the file, the settings, where the notes stay and what to do next; then switched off', async () => {
      const { root, cfg } = await initializedVault('setup-real');
      const h = agentHome('setup-real-home');
      const on = await run(root, cfg, h, PROJECTS_ON);
      assert.equal(on.code, 0, on.shown);
      assert.equal(on.term.pending(), 0, 'no push question: the vault has no remote');
      const hooks = settingsOf(h).hooks;
      assert.deepEqual(Object.keys(hooks), ['SessionStart', 'Stop', 'PostToolUseFailure'], 'no SessionEnd without autosync');
      assert.ok(hooks.SessionStart[0].hooks[0].command.endsWith(`"${path.join(root, 'system', 'memory.mjs').split(path.sep).join(process.platform === 'win32' ? '/' : path.sep)}" hook claude-code session-start`),
        hooks.SessionStart[0].hooks[0].command);
      assert.deepEqual(projectsOf(root), { enabled: true, auto_add: false, store: 'local', autosync: false, checkpoint: true, error_lookup: true });
      const script = `${root.split(path.sep).join('/')}/system/memory.mjs`;
      assert.ok(on.text.includes([
        `◇  Hooks are in ${h.settings}`,
        'add repositories automatically: No · project notes: this computer only · push at session end: No',
        `Project notes will stay on this computer, in ${path.resolve(root, '..', 'vault-private')} (made with the first project)`,
        '• Start a new Claude Code session in a code repository (in VS Code reload the window) and accept the folder trust dialog when it asks.',
        `• A repository gets its memory only when you add it. Run this inside it: node "${script}" project add`,
      ].join(' ')), on.shown);
      assert.ok(on.shown.includes(`\n│    node "${script}" project add\n`), 'the command on a line of its own');
      assert.ok(!/failed|could not|not installed/i.test(on.shown), on.shown);

      // Keep it: the hooks are current, nothing is written.
      const text = fs.readFileSync(h.settings, 'utf8');
      const kept = await run(root, cfg, h, [`${down(1)}${KEY.enter}`, KEY.enter, `${down(3)}${KEY.enter}`]);
      assert.ok(kept.text.includes(`◇  The hooks in ${h.settings} are current`), kept.shown);
      assert.ok(!kept.shown.includes('Start a new Claude Code session'), 'nothing changed, so no new session is needed');
      assert.equal(fs.readFileSync(h.settings, 'utf8'), text);

      const off = await run(root, cfg, h, [`${down(1)}${KEY.enter}`, `${down(2)}${KEY.enter}`, `${down(3)}${KEY.enter}`]);
      assert.equal(off.code, 0, off.shown);
      assert.ok(off.text.includes(`◇  Memory for coding projects is off; the hooks are out of ${h.settings} backup of the old file: `), off.shown);
      assert.equal(settingsOf(h).hooks, undefined);
      assert.equal(projectsOf(root).enabled, false);
    });

    test('switched off while Codex hooks serve the same memory: it says that it stays on', async () => {
      const { root, cfg } = await initializedVault('setup-real-kept');
      const h = agentHome('setup-real-kept-home');
      const { installProjects } = await import('../../lib/hooksetup.mjs');
      await installProjects(root, { agent: 'codex', env: h.env, home: h.home });
      // On already (through Codex): change, keep both answers.
      const on = await run(root, cfg, h, [`${down(1)}${KEY.enter}`, `${down(1)}${KEY.enter}`, KEY.enter, KEY.enter, `${down(3)}${KEY.enter}`]);
      assert.ok(on.text.includes(`◇  Hooks are in ${h.settings}`), on.shown);
      const off = await run(root, cfg, h, [`${down(1)}${KEY.enter}`, `${down(2)}${KEY.enter}`, `${down(3)}${KEY.enter}`]);
      assert.ok(off.text.includes(`▲  The hooks are out of ${h.settings}, but Codex still has memory hooks for this memory, so memory for coding projects stays on`), off.shown);
      assert.ok(!off.text.includes('Memory for coding projects is off'), off.shown);
      assert.equal(projectsOf(root).enabled, true);
    });

    test('refused: shown in red with its fix, never as installed, and nothing is written', async () => {
      // A settings "file" that is a folder cannot be read.
      const { root, cfg } = await initializedVault('setup-real-refused');
      const h = agentHome('setup-real-refused-home');
      fs.mkdirSync(h.settings, { recursive: true });
      const before = readFile(root, 'memory.json');
      const res = await run(root, cfg, h, PROJECTS_ON);
      assert.equal(res.code, 0, res.shown);
      assert.ok(res.text.includes(`■  The hooks could not be installed: ${h.settings} cannot be read (EISDIR), so nothing was changed fix: fix the file or its permissions, then connect again ◇`), res.shown);
      assert.ok(!/Hooks are in|are current|push at session end|Run this inside it|switched on/.test(res.text), res.shown);
      assert.equal(readFile(root, 'memory.json'), before);

      // A memory that stays on this computer (mode local) got a remote later: the push question is
      // asked, and yes is refused with its fix.
      const local = freshVault('setup-real-local');
      assert.equal(runInit(local, ['--mode', 'local', '--lang', 'en', '--sectors', 'core,work', '--today', TODAY, '--yes', '--allow-ephemeral']).code, 0);
      assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/me/memory.git'], { cwd: local, windowsHide: true }).status, 0);
      const { loadConfig } = await import('../../lib/config.mjs');
      const h2 = agentHome('setup-real-local-home');
      const push = await run(local, loadConfig(local), h2, [`${down(1)}${KEY.enter}`, 'y', KEY.enter, KEY.enter, 'y', `${down(3)}${KEY.enter}`]);
      assert.equal(push.term.pending(), 0, 'the push question was asked');
      assert.ok(push.text.includes('■  The hooks could not be installed: --autosync needs a memory that syncs through git, but memory.json "mode" is local, so nothing was changed fix: connect without --autosync; the memory stays on this computer ◇'), push.shown);
      assert.ok(!fs.existsSync(h2.settings));
      assert.equal(JSON.parse(readFile(local, 'memory.json')).projects, undefined);
    });

    test('a settings file with comments: the hooks to paste, printed whole, and memory.json is switched on', async () => {
      const { root, cfg } = await initializedVault('setup-real-jsonc');
      const h = agentHome('setup-real-jsonc-home');
      fs.mkdirSync(h.claudeDir, { recursive: true });
      const own = '// my settings\n{ "theme": "dark" }\n';
      fs.writeFileSync(h.settings, own);
      const res = await run(root, cfg, h, PROJECTS_ON);
      assert.ok(res.text.includes(`■  The hooks could not be installed: ${h.settings} is not plain JSON (comments or a syntax error), so the hooks were not written into it fix: make it plain JSON and connect again`), res.shown);
      // The snippet, whole and outside any box, is what the file needs: each event a list of groups.
      const snippet = res.shown.slice(res.shown.indexOf('\n{\n') + 1, res.shown.indexOf('\n}\n') + 2);
      assert.deepEqual(Object.keys(JSON.parse(snippet).hooks), ['SessionStart', 'Stop', 'PostToolUseFailure']);
      assert.ok(Array.isArray(JSON.parse(snippet).hooks.SessionStart), snippet);
      assert.ok(res.text.includes('● memory.json has it switched on: it works once the hooks are in place.'), res.shown);
      assert.equal(fs.readFileSync(h.settings, 'utf8'), own, 'the file is left alone');
      assert.equal(projectsOf(root).enabled, true);
    });
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
