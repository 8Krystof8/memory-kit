// lib/tui.mjs: capability detection (TTY, CI, colour, Unicode per platform), display width of
// Czech and CJK text, render snapshots in every glyph and colour tier, the prompts driven by a
// fake TTY (arrows, space, enter, Ctrl+C) with raw mode and the cursor restored every time, and
// the plain behaviour without a terminal.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Cancelled, NonInteractive, capabilities, createUI, displayWidth, isCI, stripAnsi, truncate, unicodeSupported, wrap,
} from '../../lib/tui.mjs';
import { KEY, escapes, fakeTerminal, screen } from '../fake-terminal.mjs';

const XTERM = { TERM: 'xterm-256color' };

/** A UI on a fake terminal: { ui, term }. */
function setup({ env = XTERM, platform = 'linux', isTTY = true, columns = 60, ...overrides } = {}) {
  const term = fakeTerminal({ isTTY, columns });
  const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env, platform, ...overrides });
  return { ui, term };
}

/** Every cursor hide is matched by a show, and the last cursor code shows it. */
function assertCursorShown(out) {
  const codes = escapes(out).filter((e) => e === '\x1b[?25l' || e === '\x1b[?25h');
  assert.equal(codes.filter((e) => e === '\x1b[?25l').length, codes.filter((e) => e === '\x1b[?25h').length, 'hide and show pair up');
  if (codes.length) assert.equal(codes.at(-1), '\x1b[?25h', 'the cursor is shown at the end');
}

/** Raw mode was switched on and off in pairs and is off now; stdin is paused. */
function assertRestored(term) {
  assert.ok(term.raw.length >= 2, `raw mode calls: ${term.raw.join(',')}`);
  assert.equal(term.raw.at(-1), false, 'raw mode is off');
  assert.equal(term.raw.filter(Boolean).length, term.raw.filter((x) => !x).length, 'every on has its off');
  assert.equal(term.stdin.isPaused(), true, 'stdin is paused');
  assertCursorShown(term.output());
}

describe('capabilities', () => {
  test('Unicode: is-unicode-supported 2.1.0 rules', () => {
    assert.equal(unicodeSupported({}, 'linux'), true);
    assert.equal(unicodeSupported({ TERM: 'linux' }, 'linux'), false, 'the Linux console');
    assert.equal(unicodeSupported({}, 'darwin'), true);
    assert.equal(unicodeSupported({}, 'win32'), false, 'conhost with cmd or PowerShell');
    for (const env of [{ WT_SESSION: 'x' }, { TERM_PROGRAM: 'vscode' }, { TERM: 'xterm-256color' }, { TERM: 'alacritty' },
      { TERM: 'rxvt-unicode-256color' }, { TERMINAL_EMULATOR: 'JetBrains-JediTerm' }, { ConEmuTask: '{cmd::Cmder}' },
      { TERMINUS_SUBLIME: '1' }]) {
      assert.equal(unicodeSupported(env, 'win32'), true, JSON.stringify(env));
    }
    assert.equal(unicodeSupported({ CI: 'true' }, 'win32'), false, 'CI on Windows is not assumed to render Unicode');
  });

  test('a Windows pipe gets ASCII, a Windows Terminal gets Unicode', () => {
    const pipe = fakeTerminal({ isTTY: false });
    assert.equal(capabilities({ stdout: pipe.stdout, stdin: pipe.stdin, env: { WT_SESSION: '1' }, platform: 'win32' }).unicode, false);
    const tty = fakeTerminal();
    assert.equal(capabilities({ stdout: tty.stdout, stdin: tty.stdin, env: { WT_SESSION: '1' }, platform: 'win32' }).unicode, true);
  });

  test('interactive only with both ends a TTY, not in CI, not with TERM=dumb', () => {
    const tty = fakeTerminal();
    const caps = (env, streams = tty) => capabilities({ stdout: streams.stdout, stdin: streams.stdin, env, platform: 'linux' });
    assert.equal(caps(XTERM).interactive, true);
    assert.equal(caps({ ...XTERM, CI: 'true' }).interactive, false);
    assert.equal(caps({ ...XTERM, CI: 'true' }).live, false);
    assert.equal(caps({ ...XTERM, CI: '0' }).interactive, true, 'CI=0 is not CI');
    assert.equal(caps({ TERM: 'dumb' }).interactive, false);
    const halfPipe = { stdout: tty.stdout, stdin: fakeTerminal({ isTTY: false }).stdin };
    assert.deepEqual([caps(XTERM, halfPipe).live, caps(XTERM, halfPipe).interactive], [true, false]);
    assert.equal(isCI({ CI: 'false' }), false);
    assert.equal(isCI({ CI: '1' }), true);
  });

  test('colour: FORCE_COLOR > NO_COLOR > TTY', () => {
    const tty = fakeTerminal();
    const pipe = fakeTerminal({ isTTY: false });
    const color = (env, t = tty) => capabilities({ stdout: t.stdout, stdin: t.stdin, env, platform: 'linux' }).color;
    assert.equal(color(XTERM), true);
    assert.equal(color({ ...XTERM, NO_COLOR: '1' }), false);
    assert.equal(color({ ...XTERM, NO_COLOR: '' }), true, 'an empty NO_COLOR does not count');
    assert.equal(color({ ...XTERM, NODE_DISABLE_COLORS: '1' }), false);
    assert.equal(color({ TERM: 'dumb' }), false);
    assert.equal(color(XTERM, pipe), false);
    assert.equal(color({ FORCE_COLOR: '1' }, pipe), true);
    assert.equal(color({ FORCE_COLOR: '1', NO_COLOR: '1' }, pipe), true, 'FORCE_COLOR wins');
    assert.equal(color({ ...XTERM, FORCE_COLOR: '0' }), false);
    assert.equal(color({ ...XTERM, FORCE_COLOR: 'false' }), false);
  });
});

describe('display width', () => {
  test('Czech diacritics are one column each, NFC or NFD', () => {
    const text = 'Příliš žluťoučký kůň';
    assert.equal(displayWidth(text), 20);
    assert.equal(displayWidth(text.normalize('NFD')), 20);
    assert.equal(displayWidth('úpěl ďábelské ódy'), 17);
  });

  test('CJK and emoji take two columns; ANSI codes and zero-width characters none', () => {
    assert.equal(displayWidth('漢字'), 4);
    assert.equal(displayWidth('かな漢字abc'), 11);
    assert.equal(displayWidth('한국어'), 6);
    assert.equal(displayWidth('👍'), 2);
    assert.equal(displayWidth('\x1b[36mcyan\x1b[39m'), 4);
    assert.equal(displayWidth('a​b'), 2);
    assert.equal(displayWidth('┌─│◆'), 4);
  });

  test('truncate and wrap count columns, not code units', () => {
    assert.equal(truncate('Příliš žluťoučký kůň', 10), 'Příliš žl…');
    assert.equal(truncate('Příliš žluťoučký kůň', 10, '...'), 'Příliš ...');
    assert.equal(truncate('漢字漢字', 5), '漢字…');
    assert.equal(truncate('short', 10), 'short');
    assert.deepEqual(wrap('Příliš žluťoučký kůň úpěl ďábelské ódy', 12), ['Příliš', 'žluťoučký', 'kůň úpěl', 'ďábelské ódy']);
    assert.deepEqual(wrap('a verylongwordthatbreaks here', 10), ['a', 'verylongwo', 'rdthatbrea', 'ks here']);
    assert.deepEqual(wrap('  indented text wraps', 10), ['  indented', '  text', '  wraps']);
    assert.deepEqual(wrap('one\n\ntwo', 10), ['one', '', 'two']);
    for (const line of wrap('Příliš žluťoučký kůň úpěl ďábelské ódy '.repeat(5), 23)) assert.ok(displayWidth(line) <= 23, line);
    assert.equal(stripAnsi('\x1b[1mbold\x1b[22m'), 'bold');
  });
});

// ---------------------------------------------------------------------------------------------
// Rendering

function sample(ui) {
  ui.intro('memory-kit', '0.1.2');
  ui.step('Language');
  ui.message('Čeština', 'dim');
  ui.success('wrote: memory.json');
  ui.warn('Příliš žluťoučký kůň');
  ui.error('broken');
  ui.info('a line');
  ui.note(['jazyk: cs (Čeština)', { text: 'git add -A', indent: 2, tone: 'accent' }], 'Shrnutí');
  ui.outro('Done.');
}

const UNICODE_SCREEN = [
  '┌  memory-kit  0.1.2',
  '│',
  '◇  Language',
  '│  Čeština',
  '│  ✓ wrote: memory.json',
  '│  ▲ Příliš žluťoučký kůň',
  '│  ✗ broken',
  '│  ● a line',
  '│',
  '◇  Shrnutí ─────────────╮',
  '│                       │',
  '│  jazyk: cs (Čeština)  │',
  '│    git add -A         │',
  '│                       │',
  '├───────────────────────╯',
  '│',
  '└  Done.',
  '',
  '',
].join('\n');

const ASCII_SCREEN = [
  '+  memory-kit  0.1.2',
  '|',
  'o  Language',
  '|  Čeština',
  '|  * wrote: memory.json',
  '|  ! Příliš žluťoučký kůň',
  '|  x broken',
  '|  - a line',
  '|',
  'o  Shrnutí -------------+',
  '|                       |',
  '|  jazyk: cs (Čeština)  |',
  '|    git add -A         |',
  '|                       |',
  '+-----------------------+',
  '|',
  '+  Done.',
  '',
  '',
].join('\n');

// Only 16-colour SGR, bold and inverse: what the Windows console emulator of libuv understands.
const ALLOWED_SGR = /^\x1b\[(?:0|1|22|7|27|3[0-9]|9[0-7])m$/;

describe('render snapshots', () => {
  test('Unicode with colour', () => {
    const { ui, term } = setup();
    sample(ui);
    const out = term.output();
    assert.equal(stripAnsi(out), UNICODE_SCREEN);
    assert.ok(out.startsWith('\x1b[90m┌\x1b[39m  \x1b[1mmemory-kit\x1b[22m  \x1b[90m0.1.2\x1b[39m\n'), JSON.stringify(out.slice(0, 80)));
    assert.ok(out.includes('\x1b[32m◇\x1b[39m  Language'), 'a finished step is green');
    assert.ok(out.includes('\x1b[32m✓\x1b[39m wrote'), 'success mark is green');
    assert.ok(out.includes('\x1b[33m▲\x1b[39m'), 'warning mark is yellow');
    assert.ok(out.includes('\x1b[31m✗\x1b[39m'), 'error mark is red');
    assert.ok(out.includes('\x1b[36m  git add -A\x1b[39m'), 'accent tone is cyan');
    for (const e of escapes(out)) assert.match(e, ALLOWED_SGR);
  });

  test('ASCII without colour (Windows conhost)', () => {
    const { ui, term } = setup({ env: {}, platform: 'win32', color: false });
    sample(ui);
    assert.equal(term.output(), ASCII_SCREEN);
    assert.equal(ui.unicode, false);
  });

  test('NO_COLOR: the same text, no colour codes', () => {
    const { ui, term } = setup({ env: { ...XTERM, NO_COLOR: '1' } });
    sample(ui);
    assert.equal(term.output(), UNICODE_SCREEN);
  });

  test('FORCE_COLOR in a pipe: colours, but no cursor or erase codes', () => {
    const { ui, term } = setup({ env: { FORCE_COLOR: '1' }, isTTY: false });
    sample(ui);
    const spin = ui.spinner();
    spin.start('working');
    spin.stop('worked');
    const out = term.output();
    assert.equal(stripAnsi(out), `${UNICODE_SCREEN}│\n◇  worked\n`);
    assert.ok(escapes(out).length > 10);
    for (const e of escapes(out)) assert.match(e, ALLOWED_SGR);
  });

  test('a long line wraps on the rail and stays inside the width', () => {
    const { ui, term } = setup({ columns: 30, color: false });
    ui.info('Příliš žluťoučký kůň úpěl ďábelské ódy a ještě o kus víc');
    ui.note(['Příliš žluťoučký kůň úpěl ďábelské ódy'], 'Title');
    const lines = term.output().split('\n');
    for (const line of lines) assert.ok(displayWidth(line) <= 29, `${displayWidth(line)}: ${line}`);
    assert.deepEqual(lines.slice(0, 3), ['│  ● Příliš žluťoučký kůň', '│    úpěl ďábelské ódy a', '│    ještě o kus víc']);
  });
});

// ---------------------------------------------------------------------------------------------
// Prompts on a fake TTY

describe('prompts', () => {
  test('select: arrows move, Enter chooses; raw mode and cursor restored', async () => {
    const { ui, term } = setup();
    term.keys(`${KEY.down}${KEY.down}${KEY.up}${KEY.enter}`);
    const value = await ui.select({
      message: 'Where should the memory live?',
      options: [{ value: 'github', label: 'github', hint: 'a private repository' }, { value: 'local', label: 'local' }, 'combined'],
      initialValue: 'github',
    });
    assert.equal(value, 'local');
    assertRestored(term);
    assert.ok(screen(term.output()).endsWith('│\n◇  Where should the memory live?\n│  local\n'), screen(term.output()));
    assert.match(term.output(), /\x1b\[\d+A\x1b\[J/, 'redraws in place');
  });

  test('select: the active frame shows options, hints and the key help', async () => {
    const { ui, term } = setup({ color: false });
    term.keys(KEY.enter);
    await ui.select({ message: 'Mode', options: [{ value: 'a', label: 'alpha', hint: 'first' }, { value: 'b', label: 'beta' }], initialValue: 'b' });
    const first = term.output().split('\x1b[?25l')[1].split('\r')[0];
    assert.equal(first, '◆  Mode\n│  ○ alpha  first\n│  ● beta\n└  ↑/↓ move · Enter confirm · Esc cancel');
  });

  test('multiselect: space toggles, a toggles all, locked stays; required', async () => {
    const { ui, term } = setup();
    term.keys(`${KEY.enter}`, `${KEY.space}${KEY.down}${KEY.space}${KEY.down}${KEY.space}${KEY.enter}`);
    const options = [{ value: 'core', label: 'Core', locked: true }, { value: 'work', label: 'Work' }, { value: 'health', label: 'Health' }];
    const first = await ui.multiselect({ message: 'Sectors', options, initialValues: ['work'] });
    assert.deepEqual(first, ['core', 'work']);
    const second = await ui.multiselect({ message: 'Sectors', options, initialValues: ['work'] });
    assert.deepEqual(second, ['core', 'health'], 'core cannot be unchosen; work off, health on');
    assertRestored(term);

    const t2 = setup();
    t2.term.keys(`a${KEY.enter}`, `a${KEY.enter}${KEY.space}${KEY.enter}`);
    const plain = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }];
    assert.deepEqual(await t2.ui.multiselect({ message: 'All', options: plain }), ['x', 'y']);
    assert.deepEqual(await t2.ui.multiselect({ message: 'Required', options: plain, initialValues: ['x', 'y'], required: true }), ['x']);
    assert.match(stripAnsi(t2.term.output()), /choose at least one/, 'an empty answer is refused first');
  });

  test('confirm: y, n, arrows and Enter', async () => {
    const { ui, term } = setup();
    term.keys('y', 'n', `${KEY.right}${KEY.enter}`, KEY.enter);
    assert.equal(await ui.confirm({ message: 'Apply?', initialValue: false }), true);
    assert.equal(await ui.confirm({ message: 'Apply?' }), false);
    assert.equal(await ui.confirm({ message: 'Apply?', initialValue: true }), false);
    assert.equal(await ui.confirm({ message: 'Apply?', initialValue: true }), true);
    assertRestored(term);
    assert.ok(screen(term.output()).endsWith('◇  Apply?\n│  Yes\n'));
  });

  test('text: typing Czech, backspace, the default when empty, validation', async () => {
    const { ui, term } = setup();
    // A refused value keeps the same prompt listening, so its retry is in the same chunk.
    term.keys(`kůň${KEY.backspace}ň${KEY.enter}`, KEY.enter, `bad${KEY.enter}${KEY.backspace.repeat(3)}ok${KEY.enter}`);
    assert.equal(await ui.text({ message: 'Name' }), 'kůň');
    assert.equal(await ui.text({ message: 'Folder', defaultValue: '../vault-private' }), '../vault-private');
    const value = await ui.text({ message: 'Word', validate: (v) => (v === 'bad' ? 'not that one' : undefined) });
    assert.equal(value, 'ok');
    assert.match(stripAnsi(term.output()), /not that one/);
    assertRestored(term);
  });

  test('Ctrl+C cancels a prompt: Cancelled, raw mode off, stdin paused, cursor shown', async () => {
    const { ui, term } = setup();
    term.keys(`${KEY.down}${KEY.ctrlC}`);
    await assert.rejects(ui.select({ message: 'Pick', options: ['a', 'b'], initialValue: 'a' }), Cancelled);
    assertRestored(term);
    assert.ok(screen(term.output()).endsWith('■  Pick\n'), screen(term.output()));
    ui.cancelled();
    assert.ok(screen(term.output()).endsWith('│\n└  Cancelled.\n\n'));
  });

  test('Ctrl+D and Esc cancel too', async () => {
    const { ui, term } = setup();
    term.keys(KEY.ctrlD, KEY.esc);
    await assert.rejects(ui.confirm({ message: 'Sure?' }), Cancelled);
    await assert.rejects(ui.text({ message: 'Name' }), Cancelled);
    assertRestored(term);
  });

  test('a long list scrolls inside the terminal height', async () => {
    const term = fakeTerminal({ rows: 10 });
    const ui = createUI({ stdout: term.stdout, stdin: term.stdin, env: XTERM, platform: 'linux', color: false });
    const options = Array.from({ length: 20 }, (_, i) => ({ value: i, label: `option ${i}` }));
    term.keys(`${KEY.down.repeat(12)}${KEY.enter}`);
    assert.equal(await ui.select({ message: 'Many', options, initialValue: 0 }), 12);
    const frames = term.output().split('\x1b[J');
    const last = frames[frames.length - 2];
    assert.ok(last.split('\n').length <= 10, last);
    assert.match(last, /↑ \d+ more above/);
    assert.match(last, /↓ \d+ more below/);
  });

  test('translated key help', async () => {
    const { ui, term } = setup({ color: false, t: (key) => (key === 'tui.hint.confirm' ? '{arrows} nebo y/n · Enter potvrdit' : key === 'tui.yes' ? 'Ano' : key) });
    term.keys(KEY.enter);
    assert.equal(await ui.confirm({ message: 'Dál?' }), true);
    assert.match(term.output(), /←\/→ nebo y\/n · Enter potvrdit/);
    assert.match(term.output(), /● Ano \/ ○ No/);
  });
});

describe('redraws never wrap', () => {
  /** Every line written (settled or redrawn) fits into the width of the terminal. */
  function assertFits(out, width) {
    for (const line of stripAnsi(out).split(/[\r\n]/)) assert.ok(displayWidth(line) <= width, `${displayWidth(line)} > ${width}: ${line}`);
  }

  test('a multiselect at 44 columns: the key help is cut, no stale question lines', async () => {
    const { ui, term } = setup({ columns: 44, color: true });
    term.keys(`${KEY.down.repeat(3)}${KEY.space}${KEY.enter}`);
    const options = ['Core', 'Work', 'School', 'Family', 'Health', 'Finances'].map((label) => ({ value: label.toLowerCase(), label, hint: label.toLowerCase() }));
    assert.deepEqual(await ui.multiselect({ message: 'Which sectors (areas of life)?', options, initialValues: ['core'] }), ['core', 'family']);
    assertFits(term.output(), 43);
    const shown = screen(term.output(), { columns: 44 });
    assert.equal(shown.split('Which sectors').length - 1, 1, shown);
    assert.ok(shown.endsWith('◇  Which sectors (areas of life)?\n│  Core, Family\n'), shown);
    assert.match(term.output(), /└\x1b\[39m {2}\x1b\[90m↑\/↓ move · Space choose · a all · Enter…\x1b\[39m/, 'cut with an ellipsis, still dim');
  });

  test('a long validation message wraps below the prompt and is cleared by the next frame', async () => {
    const { ui, term } = setup({ columns: 100, color: false });
    const problem = 'init.private_root_drive: --private-root D:\\Paměť is on another drive than this repository. memory.json is shared by all your computers, so it can only hold a path relative to the repository or one inside your home folder (~/…). Choose a folder on the same drive as the repository or inside your home folder.';
    term.keys(`D:\\Paměť${KEY.enter}${KEY.backspace.repeat(8)}../ok${KEY.enter}`);
    const value = await ui.text({ message: 'Private folder for local sectors', validate: (v) => (v.startsWith('D:') ? problem : undefined) });
    assert.equal(value, '../ok');
    assertFits(term.output(), 99);
    const withProblem = term.output().split('\x1b[J').find((frame) => frame.includes('another drive'));
    assert.ok(withProblem.split('\n').length >= 5, 'the message takes several rows of its own');
    const shown = screen(term.output(), { columns: 100 });
    assert.equal(shown, '│\n◇  Private folder for local sectors\n│  ../ok\n');
  });

  test('at 20 columns every frame still fits', async () => {
    const { ui, term } = setup({ columns: 20, color: false });
    term.keys(`${KEY.down}${KEY.enter}`, `${KEY.right}${KEY.enter}`);
    await ui.select({ message: 'Where should the memory live?', options: [{ value: 'github', label: 'github', hint: 'a private GitHub repository' }, 'local'], initialValue: 'github' });
    await ui.confirm({ message: 'Set up the memory now?' });
    assertFits(term.output(), 19);
    assert.ok(screen(term.output(), { columns: 20 }).endsWith('◇  Set up the\n│  memory now?\n│  No\n'), screen(term.output(), { columns: 20 }));
  });
});

describe('keys typed before a prompt was drawn', () => {
  test('are dropped: an Enter pressed during a spinner does not answer the question', async () => {
    const { ui, term } = setup({ keyGuard: 100 });
    term.keys(KEY.enter); // arrives right after the prompt starts listening: typed ahead
    const answer = ui.confirm({ message: 'Upgrade now?', initialValue: true });
    setTimeout(() => term.stdin.write('n'), 250);
    assert.equal(await answer, false);
    assert.ok(screen(term.output()).endsWith('◇  Upgrade now?\n│  No\n'), screen(term.output()));
    assertRestored(term);
  });

  test('Ctrl+C still cancels at once', async () => {
    const { ui, term } = setup({ keyGuard: 10000 });
    term.keys(KEY.ctrlC);
    await assert.rejects(ui.select({ message: 'Pick', options: ['a', 'b'], initialValue: 'a' }), Cancelled);
    assertRestored(term);
  });

  test('without a guard (an injected stdin) keys count at once', async () => {
    const { ui, term } = setup();
    term.keys(KEY.enter);
    assert.equal(await ui.confirm({ message: 'Now?', initialValue: false }), false);
  });
});

describe('text to copy', () => {
  test('bulleted rail text hangs; commands and snippets are never boxed or wrapped', () => {
    const { ui, term } = setup({ columns: 30, color: false });
    ui.message('Commit now, one command at a time:', undefined, { bullet: true });
    ui.command('git commit -m "Set up memory with a long message"');
    ui.verbatim('{\n  "hooks": { "SessionStart": [] }\n}');
    assert.equal(term.output(), [
      '│  • Commit now, one command',
      '│    at a time:',
      '│    git commit -m "Set up memory with a long message"',
      '│',
      '{',
      '  "hooks": { "SessionStart": [] }',
      '}',
      '│',
      '',
    ].join('\n'));
  });
});

describe('without a terminal', () => {
  test('prompts take their default and print the settled form only', async () => {
    const { ui, term } = setup({ isTTY: false, env: {} });
    assert.equal(ui.tty, false);
    assert.equal(await ui.select({ message: 'Mode', options: ['github', 'local'], initialValue: 'local' }), 'local');
    assert.deepEqual(await ui.multiselect({ message: 'Sectors', options: [{ value: 'core', label: 'Core', locked: true }, 'work'], initialValues: ['work'] }), ['core', 'work']);
    assert.equal(await ui.confirm({ message: 'Apply?', initialValue: true }), true);
    assert.equal(await ui.text({ message: 'Folder', defaultValue: '../x' }), '../x');
    assert.equal(term.output(), '│\n◇  Mode\n│  local\n│\n◇  Sectors\n│  Core, work\n│\n◇  Apply?\n│  Yes\n│\n◇  Folder\n│  ../x\n');
    assert.deepEqual(escapes(term.output()), []);
  });

  test('a question without a default throws NonInteractive', async () => {
    const { ui } = setup({ isTTY: false, env: {} });
    await assert.rejects(async () => ui.select({ message: 'Mode', options: ['a', 'b'] }), NonInteractive);
    await assert.rejects(async () => ui.text({ message: 'Name' }), NonInteractive);
    await assert.rejects(async () => ui.multiselect({ message: 'Some', options: ['a'], required: true }), NonInteractive);
  });

  test('a spinner prints only its final line', () => {
    const { ui, term } = setup({ isTTY: false, env: {} });
    const spin = ui.spinner();
    spin.start('Fetching');
    spin.message('still fetching');
    spin.stop('Fetched');
    const quiet = ui.spinner();
    quiet.start('Planning');
    quiet.clear();
    assert.equal(term.output(), '│\n◇  Fetched\n');
  });
});

describe('spinner in a terminal', () => {
  test('hides the cursor while it turns and shows it again; clear leaves nothing', async () => {
    const { ui, term } = setup({ color: false });
    const spin = ui.spinner();
    spin.start('Setting up');
    await new Promise((resolve) => setTimeout(resolve, 200));
    spin.stop('Set up');
    const quiet = ui.spinner({ spacer: false });
    quiet.start('Planning');
    quiet.clear();
    ui.intro('memory-kit 0.1.1 → 0.1.2');
    assertCursorShown(term.output());
    assert.equal(screen(term.output()), '│\n◇  Set up\n┌  memory-kit 0.1.1 → 0.1.2\n');
    assert.ok(term.output().split('◒').length > 1 && term.output().split('◐').length > 1, 'the frame turns');
    const failed = ui.spinner();
    failed.start('Upgrading');
    failed.stop('Upgrading', 'error');
    assert.ok(screen(term.output()).endsWith('│\n■  Upgrading\n'));
  });

  test('Ctrl+C while it turns: a cancel line, the cursor back, exit 130', async () => {
    const codes = [];
    const { ui, term } = setup({ color: false, signals: true, exit: (code) => codes.push(code) });
    const listeners = process.listenerCount('SIGINT');
    const spin = ui.spinner();
    spin.start('Backing up, upgrading and verifying');
    assert.equal(process.listenerCount('SIGINT'), listeners + 1, 'the spinner listens for SIGINT');
    try {
      process.emit('SIGINT', 'SIGINT');
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(codes, [130]);
      assert.equal(process.exitCode, 130);
    } finally {
      process.exitCode = undefined;
    }
    assert.equal(process.listenerCount('SIGINT'), listeners, 'the listener is gone');
    assert.equal(spin.running, false);
    assert.equal(screen(term.output()), '│\n■  Backing up, upgrading and verifying\n│\n└  Cancelled.\n\n');
    assertCursorShown(term.output());
  });

  test('ASCII frames on a legacy Windows console', () => {
    const { ui, term } = setup({ env: {}, platform: 'win32', color: false });
    const spin = ui.spinner();
    spin.start('Working');
    spin.stop('Done');
    assert.ok(term.output().includes('-  Working'), JSON.stringify(term.output()));
    assert.equal(screen(term.output()), '|\no  Done\n');
  });
});

describe('close', () => {
  test('ends a turning spinner as failed and shows the cursor', () => {
    const { ui, term } = setup({ color: false });
    ui.spinner().start('Planning');
    ui.close();
    assert.equal(screen(term.output()), '│\n■  Planning\n');
    assertCursorShown(term.output());
    ui.close();
  });
});
