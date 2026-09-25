// A small terminal UI without dependencies, in the visual language of @clack/prompts: an intro
// line, a guide rail, notes, log lines, a spinner and four prompts (select, multiselect,
// confirm, text). The setup wizard and the upgrade screen use it; other commands may too.
// Capabilities are decided once in createUI from the injected streams and environment:
//   - prompts read keys only when stdin and stdout are TTYs, CI is not set and TERM is not dumb;
//   - colour: FORCE_COLOR, then NO_COLOR / NODE_DISABLE_COLORS, then a colour-capable TTY;
//   - Unicode glyphs by the rules of is-unicode-supported 2.1.0 (on Windows only in terminals
//     known to render them); ASCII fallbacks elsewhere and for Windows pipes.
// Only escape codes that the Windows console emulator of libuv understands are written: 16-colour
// SGR (gray instead of faint), carriage return, cursor up, erase down, erase to end of line and
// hide/show cursor. Without a TTY nothing is redrawn and no escape code is written: a prompt
// prints its settled form with its default (NonInteractive when there is none) and a spinner
// prints only its final line. Every byte goes through the injected stdout, so tests capture it.
// Raw mode is switched on per prompt and always switched off again (submit, cancel, Ctrl+C,
// process exit); the cursor is always shown again. Ctrl+C or Esc in a prompt rejects with
// Cancelled; the caller prints ui.cancelled() and exits with 130.

import readline from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

// English texts of the UI itself; packs translate them under the same keys (tui.*).
export const TUI_DEFAULTS = {
  'tui.yes': 'Yes',
  'tui.no': 'No',
  'tui.hint.select': '{arrows} move · Enter confirm · Esc cancel',
  'tui.hint.multiselect': '{arrows} move · Space choose · a all · Enter confirm',
  'tui.hint.confirm': '{arrows} or y/n · Enter confirm',
  'tui.hint.text': 'Enter confirm · Esc cancel',
  'tui.more_above': '{n} more above',
  'tui.more_below': '{n} more below',
  'tui.required': 'choose at least one',
  'tui.locked': 'always',
  'tui.cancelled': 'Cancelled.',
};

const CSI = '\x1b[';
const CURSOR_HIDE = `${CSI}?25l`;
const CURSOR_SHOW = `${CSI}?25h`;
const ERASE_DOWN = `${CSI}J`;

const GLYPHS = {
  unicode: {
    start: '┌', bar: '│', end: '└', active: '◆', done: '◇', cancel: '■', warn: '▲', info: '●', success: '✓',
    fail: '✗', radioOn: '●', radioOff: '○', boxOn: '◼', boxOff: '◻', pointer: '›', h: '─', tr: '╮', br: '╯',
    tee: '├', ellipsis: '…', arrow: '→', upDown: '↑/↓', leftRight: '←/→', up: '↑', down: '↓', dot: '·', bullet: '•',
    add: '+', change: '~', remove: '−', keep: '!', frames: ['◒', '◐', '◓', '◑'], interval: 80,
  },
  ascii: {
    start: '+', bar: '|', end: '+', active: '>', done: 'o', cancel: 'x', warn: '!', info: '-', success: '*',
    fail: 'x', radioOn: '(*)', radioOff: '( )', boxOn: '[x]', boxOff: '[ ]', pointer: '>', h: '-', tr: '+', br: '+',
    tee: '+', ellipsis: '...', arrow: '->', upDown: 'up/down', leftRight: 'left/right', up: '^', down: 'v', dot: '-', bullet: '-',
    add: '+', change: '~', remove: '-', keep: '!', frames: ['-', '\\', '|', '/'], interval: 120,
  },
};

/** A prompt was cancelled (Ctrl+C, Ctrl+D or Esc). */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

/** A prompt needs an answer, but there is no terminal to ask in and no default. */
export class NonInteractive extends Error {
  constructor(message) {
    super(`no terminal to answer "${message}" and no default`);
    this.name = 'NonInteractive';
  }
}

export const isCancel = (err) => err instanceof Cancelled;

// ---------------------------------------------------------------------------------------------
// Capabilities

const set = (v) => v !== undefined && v !== null && String(v) !== '';

/** CI is set to something other than '', 0 or false. */
export function isCI(env = process.env) {
  return set(env.CI) && !['0', 'false'].includes(String(env.CI).toLowerCase());
}

/** The rules of is-unicode-supported 2.1.0. */
export function unicodeSupported(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return env.TERM !== 'linux';
  return set(env.WT_SESSION) || set(env.TERMINUS_SUBLIME) || env.ConEmuTask === '{cmd::Cmder}'
    || env.TERM_PROGRAM === 'Terminus-Sublime' || env.TERM_PROGRAM === 'vscode'
    || ['xterm-256color', 'alacritty', 'rxvt-unicode', 'rxvt-unicode-256color'].includes(env.TERM)
    || env.TERMINAL_EMULATOR === 'JetBrains-JediTerm';
}

/** FORCE_COLOR (anything but 0 or false) > NO_COLOR / NODE_DISABLE_COLORS > a colour TTY. */
export function colorSupported(stdout, env = process.env) {
  if (env.FORCE_COLOR !== undefined) return !['0', 'false'].includes(String(env.FORCE_COLOR).toLowerCase());
  if (set(env.NO_COLOR) || set(env.NODE_DISABLE_COLORS)) return false;
  if (!stdout?.isTTY || env.TERM === 'dumb') return false;
  if (typeof stdout.hasColors === 'function') {
    try {
      return stdout.hasColors(16, env);
    } catch {
      return true;
    }
  }
  return true;
}

/**
 * { interactive, live, color, unicode }: live = the output can be redrawn (spinner, prompts);
 * interactive = keys can be read too.
 */
export function capabilities({ stdout = process.stdout, stdin = process.stdin, env = process.env, platform = process.platform } = {}) {
  const dumb = env.TERM === 'dumb';
  const live = Boolean(stdout?.isTTY) && !dumb && !isCI(env);
  return {
    live,
    interactive: live && Boolean(stdin?.isTTY),
    color: colorSupported(stdout, env),
    // A Windows pipe goes to a reader whose code page is unknown: ASCII only.
    unicode: unicodeSupported(env, platform) && !(platform === 'win32' && !stdout?.isTTY),
  };
}

// ---------------------------------------------------------------------------------------------
// Text width (no dependencies): ANSI stripped, NFC, zero-width marks, East Asian wide = 2

let segmenter = null; // created on first use: it costs about 10 ms
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}]+$/u;
const EMOJI = /^\p{RGI_Emoji}$/v;
const ASCII = /^[\x20-\x7e]*$/;

function isWide(c) {
  return c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a || (c >= 0x2e80 && c <= 0x303e)
    || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)
    || (c >= 0xa000 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
    || (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd));
}

const clusterWidth = (g) => (ZERO_WIDTH.test(g) ? 0 : EMOJI.test(g) || isWide(g.codePointAt(0)) ? 2 : 1);
const clusters = (s) => [...(segmenter ??= new Intl.Segmenter()).segment(s.normalize('NFC'))].map((x) => x.segment);

export const stripAnsi = (s) => stripVTControlCharacters(String(s));

/** Columns a string takes in a terminal. */
export function displayWidth(text) {
  const s = stripAnsi(text);
  if (ASCII.test(s)) return s.length;
  let w = 0;
  for (const g of clusters(s)) w += clusterWidth(g);
  return w;
}

/** The plain text cut to at most max columns, with the ellipsis when something was cut. */
export function truncate(text, max, ellipsis = '…') {
  const s = stripAnsi(text).normalize('NFC');
  if (displayWidth(s) <= max) return s;
  const room = max - displayWidth(ellipsis);
  if (room <= 0) return ellipsis.slice(0, Math.max(0, max));
  let out = '';
  let w = 0;
  for (const g of clusters(s)) {
    const cw = clusterWidth(g);
    if (w + cw > room) break;
    out += g;
    w += cw;
  }
  return out + ellipsis;
}

/** The first graphemes of s that fit into cols columns, and the rest. */
function splitAtWidth(s, cols) {
  let head = '';
  let w = 0;
  const list = clusters(s);
  let i = 0;
  for (; i < list.length; i++) {
    const cw = clusterWidth(list[i]);
    if (w + cw > cols) break;
    head += list[i];
    w += cw;
  }
  return [head, list.slice(i).join('')];
}

/**
 * Plain text wrapped at spaces to lines of at most width columns (words longer than a line are
 * broken). Line breaks are kept; a line's leading spaces indent its continuation lines too.
 */
export function wrap(text, width) {
  const max = Math.max(1, width);
  const out = [];
  for (const para of stripAnsi(text).normalize('NFC').split('\n')) {
    let indent = /^ */.exec(para)[0];
    if (indent.length >= max) indent = '';
    const words = para.slice(indent.length).split(/ +/).filter((w, i, all) => w !== '' || all.length === 1);
    let line = indent;
    let lw = indent.length;
    const fresh = () => lw === indent.length && line === indent;
    for (let word of words) {
      let w = displayWidth(word);
      if (!fresh() && lw + 1 + w > max) {
        out.push(line);
        line = indent;
        lw = indent.length;
      }
      if (!fresh()) {
        line += ' ';
        lw += 1;
      }
      // Only a fresh line gets here: a word longer than a whole line is broken.
      while (lw + w > max && w > 0) {
        let [head, rest] = splitAtWidth(word, max - lw);
        if (!head) {
          head = clusters(word)[0];
          rest = word.slice(head.length);
        }
        out.push(line + head);
        line = indent;
        lw = indent.length;
        word = rest;
        w = displayWidth(rest);
      }
      line += word;
      lw += w;
    }
    out.push(line.trim() === '' ? '' : line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The UI

const isCancelKey = (str, key) => (key?.ctrl && (key.name === 'c' || key.name === 'd')) || key?.name === 'escape' || str === '\x03';
const isPrintable = (str, key) => typeof str === 'string' && str !== '' && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(str);

function interpolate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (all, name) => (vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all));
}

/**
 * The UI on the given streams. opts: { stdout, stdin, env, platform, columns, rows, t } plus
 * overrides of the detected capabilities { interactive, live, color, unicode }. t(key, vars)
 * translates the tui.* texts (setTranslator changes it later); a key it does not know falls back
 * to the English default.
 */
export function createUI(opts = {}) {
  const stdout = opts.stdout ?? process.stdout;
  const stdin = opts.stdin ?? process.stdin;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const detected = capabilities({ stdout, stdin, env, platform });
  const caps = {
    live: opts.live ?? detected.live,
    interactive: opts.interactive ?? detected.interactive,
    color: opts.color ?? detected.color,
    unicode: opts.unicode ?? detected.unicode,
  };
  if (!caps.live) caps.interactive = false;
  const sym = caps.unicode ? GLYPHS.unicode : GLYPHS.ascii;
  const signals = caps.live && stdout === process.stdout;
  let translate = typeof opts.t === 'function' ? opts.t : null;

  const sgr = (on, off) => (s) => (caps.color ? `${CSI}${on}m${s}${CSI}${off}m` : String(s));
  const style = {
    dim: sgr(90, 39), bold: sgr(1, 22), accent: sgr(36, 39), ok: sgr(32, 39), warn: sgr(33, 39), err: sgr(31, 39), inverse: sgr(7, 27),
  };
  // The text caret is inverse video, not a colour, so it shows with NO_COLOR too.
  const caret = (s) => (caps.live ? `${CSI}7m${s}${CSI}27m` : String(s));

  const tt = (key, vars) => {
    const own = translate ? translate(key, vars) : key;
    if (typeof own === 'string' && own !== '' && own !== key) return interpolate(own, vars);
    return interpolate(TUI_DEFAULTS[key] ?? key, vars);
  };

  const columns = () => {
    const c = opts.columns ?? stdout.columns ?? (Number(env.COLUMNS) || 80);
    return Math.max(20, Math.min(Number(c) || 80, 100));
  };
  // One column less than the terminal: a legacy console wraps eagerly at the last column.
  const width = () => columns() - 1;
  const rows = () => Math.max(8, Number(opts.rows ?? stdout.rows ?? 24) || 24);
  const inner = () => Math.max(8, width() - 3);

  const write = (s) => {
    stdout.write(String(s).normalize('NFC'));
  };

  // --- cursor and the live region ---------------------------------------------------------
  let height = 0;
  let hidden = false;
  const onExit = () => {
    if (hidden) {
      try {
        stdout.write(CURSOR_SHOW);
      } catch {
        /* the stream is gone */
      }
    }
  };
  const hideCursor = () => {
    if (hidden || !caps.live) return;
    write(CURSOR_HIDE);
    hidden = true;
    process.on('exit', onExit);
  };
  const showCursor = () => {
    if (!hidden) return;
    write(CURSOR_SHOW);
    hidden = false;
    process.removeListener('exit', onExit);
  };
  const draw = (lines) => {
    let s = '';
    if (height > 0) s += `\r${height > 1 ? `${CSI}${height - 1}A` : ''}${ERASE_DOWN}`;
    write(s + lines.join('\n'));
    height = lines.length;
  };
  const settle = (lines) => {
    draw(lines);
    write('\n');
    height = 0;
    showCursor();
  };
  const print = (lines) => write(`${lines.join('\n')}\n`);

  // --- building blocks ----------------------------------------------------------------------
  const bar = (active) => (active ? style.accent(sym.bar) : style.dim(sym.bar));
  const spacer = () => style.dim(sym.bar);
  const tone = (name) => style[name] ?? ((s) => s);
  const mark = (state) => ({
    active: style.accent(sym.active),
    ok: style.ok(sym.done),
    submit: style.ok(sym.done),
    warn: style.warn(sym.warn),
    error: style.err(sym.cancel),
    cancel: style.err(sym.cancel),
    info: style.accent(sym.info),
  })[state] ?? style.ok(sym.done);

  /** Lines of at most cols columns: a line that fits stays as it is (colours, spacing), else wrapped plain. */
  const fit = (text, cols) => {
    const s = String(text);
    return !s.includes('\n') && displayWidth(s) <= cols ? [s.normalize('NFC')] : wrap(s, cols);
  };
  /** A header "◆  message", wrapped; continuation lines on the rail. */
  const header = (message, state, active = false) => fit(message, inner()).map((l, i) => (i === 0 ? `${mark(state)}  ${l}` : `${bar(active)}  ${l}`));
  /** Text on the rail, wrapped. */
  const railed = (text, { active = false, paint = (s) => s, indent = '' } = {}) => fit(text, inner() - indent.length)
    .map((l) => `${bar(active)}  ${indent}${paint(l)}`);

  function intro(title, detail = '') {
    const room = width() - 3;
    const head = truncate(title, room, sym.ellipsis);
    const rest = detail ? truncate(detail, Math.max(0, room - displayWidth(head) - 2), sym.ellipsis) : '';
    print([`${style.dim(sym.start)}  ${style.bold(head)}${rest ? `  ${style.dim(rest)}` : ''}`]);
  }

  function outro(message = '', { state = 'ok' } = {}) {
    const paint = state === 'error' || state === 'cancel' ? style.err : state === 'warn' ? style.warn : (s) => s;
    const lines = wrap(message, inner());
    print([spacer(), ...lines.map((l, i) => (i === 0 ? `${style.dim(sym.end)}  ${paint(l)}` : `   ${paint(l)}`)), '']);
  }

  /** A finished step: a spacer and "◇  message" (state ok, warn, error, info). */
  function step(message, state = 'ok') {
    print([spacer(), ...header(message, state)]);
  }

  const logLine = (glyph, paintGlyph, paintText = (s) => s) => (message) => {
    const lines = fit(message, inner() - 2);
    print(lines.map((l, i) => `${bar(false)}  ${i === 0 ? `${paintGlyph(glyph)} ` : '  '}${paintText(l)}`));
  };
  const info = (message) => logLine(sym.info, style.accent)(message);
  const success = (message) => logLine(sym.success, style.ok)(message);
  const warn = (message) => logLine(sym.warn, style.warn)(message);
  const error = (message) => logLine(sym.fail, style.err)(message);
  /** Plain text on the rail (paint: dim, bold, accent, ok, warn, err). */
  const message = (text, paint) => print(railed(text, { paint: paint ? tone(paint) : undefined }));
  /** A command to copy, indented on the rail and never wrapped (a long one wraps in the terminal). */
  const command = (text) => print([`${bar(false)}    ${style.accent(String(text).normalize('NFC'))}`]);

  /**
   * A box: body is a string or a list of strings / { text, tone, bullet, indent } items, each
   * wrapped (a bullet hangs, indent is a number of spaces). state colours the title mark (ok,
   * warn, error, info).
   */
  function note(body, title = '', { state = 'ok' } = {}) {
    const items = (Array.isArray(body) ? body : String(body).split('\n')).map((x) => (typeof x === 'string' ? { text: x } : x));
    const room = Math.max(4, width() - 6);
    const lines = [];
    for (const item of items) {
      const indent = ' '.repeat(Math.max(0, Number(item.indent) || 0));
      const lead = item.bullet ? `${item.bullet} ` : '';
      const hang = ' '.repeat(displayWidth(lead));
      wrap(item.text ?? '', Math.max(4, room - indent.length - hang.length)).forEach((l, i) => {
        lines.push({ text: `${indent}${i === 0 ? lead : hang}${l}`.replace(/ +$/, ''), tone: item.tone });
      });
    }
    const head = truncate(title, room, sym.ellipsis);
    const len = Math.max(displayWidth(head), ...lines.map((l) => displayWidth(l.text))) + 2;
    const out = [spacer(), `${mark(state)}  ${style.bold(head)} ${style.dim(sym.h.repeat(Math.max(len - displayWidth(head) - 1, 1)) + sym.tr)}`];
    for (const l of [{ text: '' }, ...lines, { text: '' }]) {
      out.push(`${spacer()}  ${tone(l.tone)(l.text)}${' '.repeat(len - displayWidth(l.text))}${spacer()}`);
    }
    out.push(style.dim(sym.tee + sym.h.repeat(len + 2) + sym.br));
    print(out);
  }

  function cancelled(text = tt('tui.cancelled')) {
    print([spacer(), `${style.dim(sym.end)}  ${style.err(text)}`, '']);
  }

  // --- spinner ------------------------------------------------------------------------------
  let turning = null; // the spinner that runs now, for close()
  /**
   * { start(msg), message(msg), stop(msg, state), clear() }: a turning frame and a message; stop
   * leaves "◇  msg" (state ok, warn, error, info), clear leaves nothing. Without a live terminal
   * only stop prints. spacer: false starts without the rail line above (before an intro).
   */
  function spinner({ spacer: withSpacer = true } = {}) {
    let timer = null;
    let frame = 0;
    let text = '';
    let running = false;
    const line = () => `${style.accent(sym.frames[frame % sym.frames.length])}  ${truncate(text, inner(), sym.ellipsis)}`;
    const onSigint = () => {
      clearInterval(timer);
      settle([`${mark('cancel')}  ${truncate(text, inner(), sym.ellipsis)}`]);
      cancelled();
      process.exitCode = 130;
      stdout.write('', () => process.exit(130));
    };
    const api = {
      start(msg = '') {
        if (running) return;
        running = true;
        turning = api;
        text = msg;
        if (!caps.live) return;
        if (withSpacer) print([spacer()]);
        hideCursor();
        draw([line()]);
        timer = setInterval(() => {
          frame += 1;
          draw([line()]);
        }, sym.interval);
        timer.unref?.();
        if (signals) process.once('SIGINT', onSigint);
      },
      message(msg) {
        text = msg;
        if (running && caps.live) draw([line()]);
      },
      stop(msg = text, state = 'ok') {
        if (!running) return;
        running = false;
        if (turning === api) turning = null;
        clearInterval(timer);
        if (signals) process.removeListener('SIGINT', onSigint);
        const done = header(msg, state);
        if (caps.live) settle(done);
        else print([...(withSpacer ? [spacer()] : []), ...done]);
      },
      clear() {
        if (!running) return;
        running = false;
        if (turning === api) turning = null;
        clearInterval(timer);
        if (signals) process.removeListener('SIGINT', onSigint);
        if (!caps.live) return;
        draw([]);
        height = 0;
        showCursor();
      },
      get running() {
        return running;
      },
    };
    return api;
  }

  /** After an unexpected error: a turning spinner ends as failed and the cursor is shown. */
  function close() {
    turning?.stop(undefined, 'error');
    showCursor();
  }

  // --- prompts ------------------------------------------------------------------------------

  /** Reads keys until the prompt settles; always restores raw mode, the stream and the cursor. */
  function runPrompt({ render, onKey, value }) {
    return new Promise((resolve, reject) => {
      print([spacer()]);
      hideCursor();
      readline.emitKeypressEvents(stdin);
      const raw = Boolean(stdin.isTTY) && typeof stdin.setRawMode === 'function';
      let open = true;
      const restoreRaw = () => {
        try {
          if (raw) stdin.setRawMode(false);
        } catch {
          /* the console is gone */
        }
      };
      const redraw = () => draw(render('active'));
      const close = () => {
        if (!open) return;
        open = false;
        stdin.removeListener('keypress', onKeypress);
        stdout.removeListener?.('resize', redraw);
        process.removeListener('exit', restoreRaw);
        restoreRaw();
        stdin.pause();
      };
      const finish = (status) => {
        close();
        settle(render(status));
        if (status === 'cancel') reject(new Cancelled());
        else resolve(value());
      };
      function onKeypress(str, key = {}) {
        if (!open) return;
        try {
          if (isCancelKey(str, key)) return finish('cancel');
          if (onKey(str, key ?? {}) === 'submit') return finish('submit');
          redraw();
        } catch (err) {
          close();
          showCursor();
          reject(err);
        }
        return undefined;
      }
      if (raw) stdin.setRawMode(true);
      process.on('exit', restoreRaw);
      stdin.on('keypress', onKeypress);
      stdout.on?.('resize', redraw);
      stdin.resume();
      redraw();
    });
  }

  /** Without a terminal: the settled form with the default, or NonInteractive. */
  function answerDefault(message, value, shown) {
    if (value === undefined) throw new NonInteractive(message);
    print([spacer(), ...header(message, 'submit'), ...railed(shown, { paint: style.dim })]);
    return Promise.resolve(value);
  }

  const optionList = (options) => options.map((o) => (typeof o === 'object' && o !== null ? { ...o, label: String(o.label ?? o.value) } : { value: o, label: String(o) }));
  const footer = (text, active = true) => `${active ? style.accent(sym.end) : style.dim(sym.end)}  ${text}`;
  const hintLine = (key) => style.dim(tt(key, { arrows: key === 'tui.hint.confirm' ? sym.leftRight : sym.upDown }));

  /** The rows of a list of options around the cursor, at most rows() - 7 of them. */
  function windowed(count, cursor) {
    const max = Math.max(3, rows() - 7);
    if (count <= max) return { from: 0, to: count };
    const from = Math.min(Math.max(0, cursor - Math.floor(max / 2)), count - max);
    return { from, to: from + max };
  }

  function optionRows(opts2, cursor, rowOf) {
    const { from, to } = windowed(opts2.length, cursor);
    const labelWidth = Math.max(...opts2.map((o) => displayWidth(o.label)));
    const out = [];
    if (from > 0) out.push(`${bar(true)}  ${style.dim(`${sym.up} ${tt('tui.more_above', { n: from })}`)}`);
    for (let i = from; i < to; i++) {
      const o = opts2[i];
      const { lead, leadWidth, current } = rowOf(o, i);
      const room = inner() - leadWidth;
      const label = truncate(o.label, room, sym.ellipsis);
      const pad = ' '.repeat(Math.max(0, Math.min(labelWidth, room) - displayWidth(label)));
      const hintRoom = room - displayWidth(label) - pad.length - 2;
      const hint = o.hint && hintRoom > 3 ? `  ${style.dim(truncate(o.hint, hintRoom, sym.ellipsis))}` : '';
      out.push(`${bar(true)}  ${lead}${current ? label : style.dim(label)}${hint ? pad + hint : ''}`);
    }
    if (to < opts2.length) out.push(`${bar(true)}  ${style.dim(`${sym.down} ${tt('tui.more_below', { n: opts2.length - to })}`)}`);
    return out;
  }

  /** One of options ([{value, label, hint}] or plain values) → its value. */
  function select({ message: msg, options, initialValue }) {
    const list = optionList(options);
    if (!caps.interactive) {
      const hit = list.find((o) => o.value === initialValue);
      return answerDefault(msg, hit ? hit.value : undefined, hit?.label ?? '');
    }
    let cursor = Math.max(0, list.findIndex((o) => o.value === initialValue && !o.disabled));
    const move = (d) => {
      for (let n = 0; n < list.length; n++) {
        cursor = (cursor + d + list.length) % list.length;
        if (!list[cursor].disabled) return;
      }
    };
    return runPrompt({
      render: (status) => {
        if (status !== 'active') return [...header(msg, status), ...railed(list[cursor].label, { paint: style.dim })];
        const radioWidth = displayWidth(sym.radioOn) + 1;
        return [
          ...header(msg, 'active', true),
          ...optionRows(list, cursor, (o, i) => ({
            lead: i === cursor ? `${style.ok(sym.radioOn)} ` : `${style.dim(sym.radioOff)} `,
            leadWidth: radioWidth,
            current: i === cursor,
          })),
          footer(hintLine('tui.hint.select')),
        ];
      },
      onKey: (str, key) => {
        if (key.name === 'up' || key.name === 'k' || (key.name === 'tab' && key.shift)) move(-1);
        else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') move(1);
        else if (key.name === 'return' || key.name === 'enter') return 'submit';
        return undefined;
      },
      value: () => list[cursor].value,
    });
  }

  /**
   * Several of options → the chosen values in option order. Options may be `locked` (always
   * chosen). required: at least one must be chosen.
   */
  function multiselect({ message: msg, options, initialValues = [], required = false }) {
    const list = optionList(options);
    const chosen = new Set([...initialValues, ...list.filter((o) => o.locked).map((o) => o.value)]);
    const values = () => list.filter((o) => chosen.has(o.value)).map((o) => o.value);
    const labels = () => list.filter((o) => chosen.has(o.value)).map((o) => o.label).join(', ');
    if (!caps.interactive) {
      const v = values();
      return answerDefault(msg, required && !v.length ? undefined : v, labels());
    }
    let cursor = 0;
    let problem = null;
    return runPrompt({
      render: (status) => {
        if (status !== 'active') return [...header(msg, status), ...railed(labels() || '–', { paint: style.dim })];
        const pointerWidth = displayWidth(sym.pointer) + 1;
        const boxWidth = displayWidth(sym.boxOn) + 1;
        return [
          ...header(msg, 'active', true),
          ...optionRows(list, cursor, (o, i) => {
            const on = chosen.has(o.value);
            const box = o.locked ? style.dim(sym.boxOn) : on ? style.ok(sym.boxOn) : style.dim(sym.boxOff);
            const pointer = i === cursor ? style.accent(sym.pointer) : ' '.repeat(displayWidth(sym.pointer));
            return { lead: `${pointer} ${box} `, leadWidth: pointerWidth + boxWidth, current: i === cursor || on };
          }),
          footer(problem ? style.warn(`${sym.warn} ${problem}`) : hintLine('tui.hint.multiselect')),
        ];
      },
      onKey: (str, key) => {
        problem = null;
        const free = list.filter((o) => !o.locked && !o.disabled);
        if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + list.length) % list.length;
        else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') cursor = (cursor + 1) % list.length;
        else if (key.name === 'space' || str === ' ') {
          const o = list[cursor];
          if (!o.locked && !o.disabled) {
            if (chosen.has(o.value)) chosen.delete(o.value);
            else chosen.add(o.value);
          }
        } else if (str === 'a' || str === 'A') {
          const all = free.every((o) => chosen.has(o.value));
          for (const o of free) {
            if (all) chosen.delete(o.value);
            else chosen.add(o.value);
          }
        } else if (key.name === 'return' || key.name === 'enter') {
          if (required && !values().length) problem = tt('tui.required');
          else return 'submit';
        }
        return undefined;
      },
      value: values,
    });
  }

  /** Yes or no → boolean. */
  function confirm({ message: msg, initialValue = true }) {
    const yes = tt('tui.yes');
    const no = tt('tui.no');
    if (!caps.interactive) return answerDefault(msg, Boolean(initialValue), initialValue ? yes : no);
    let value = Boolean(initialValue);
    return runPrompt({
      render: (status) => {
        if (status !== 'active') return [...header(msg, status), ...railed(value ? yes : no, { paint: style.dim })];
        const opt = (on, label) => (on ? `${style.ok(sym.radioOn)} ${label}` : `${style.dim(sym.radioOff)} ${style.dim(label)}`);
        return [
          ...header(msg, 'active', true),
          `${bar(true)}  ${opt(value, yes)} ${style.dim('/')} ${opt(!value, no)}`,
          footer(hintLine('tui.hint.confirm')),
        ];
      },
      onKey: (str, key) => {
        const name = key.name ?? '';
        if (['left', 'right', 'up', 'down', 'h', 'l', 'tab'].includes(name)) value = !value;
        else if (name === 'y') {
          value = true;
          return 'submit';
        } else if (name === 'n') {
          value = false;
          return 'submit';
        } else if (name === 'return' || name === 'enter') return 'submit';
        return undefined;
      },
      value: () => value,
    });
  }

  /**
   * A line of text → the string (defaultValue when left empty). validate(value) returns an error
   * text to show, or nothing when the value is fine.
   */
  function text({ message: msg, defaultValue, initialValue = '', placeholder, validate }) {
    if (!caps.interactive) {
      const v = initialValue || defaultValue;
      const problem = v !== undefined && validate ? validate(v) : undefined;
      if (problem) throw new NonInteractive(msg);
      return answerDefault(msg, v, v ?? '');
    }
    let chars = clusters(String(initialValue));
    let pos = chars.length;
    let problem = null;
    const current = () => chars.join('');
    const result = () => (current() === '' && defaultValue !== undefined ? String(defaultValue) : current());
    return runPrompt({
      render: (status) => {
        if (status !== 'active') return [...header(msg, status), ...railed(result() || '–', { paint: style.dim })];
        let body;
        if (!chars.length && (placeholder ?? defaultValue)) {
          const ph = clusters(truncate(String(placeholder ?? defaultValue), inner() - 1, sym.ellipsis));
          body = `${caret(ph[0])}${style.dim(ph.slice(1).join(''))}`;
        } else {
          // Keep the caret visible: show the part of the text around it that fits.
          const room = inner() - 1;
          let from = 0;
          while (from < pos && displayWidth(chars.slice(from, pos + 1).join('')) > room) from += 1;
          let to = chars.length;
          while (to > pos + 1 && displayWidth(chars.slice(from, to).join('')) > room) to -= 1;
          const before = chars.slice(from, pos).join('');
          const at = chars[pos] ?? ' ';
          const after = chars.slice(pos + 1, to).join('');
          body = `${before}${caret(at)}${after}`;
        }
        return [
          ...header(msg, 'active', true),
          `${bar(true)}  ${body}`,
          footer(problem ? style.warn(`${sym.warn} ${problem}`) : hintLine('tui.hint.text')),
        ];
      },
      onKey: (str, key) => {
        problem = null;
        const name = key.name ?? '';
        if (name === 'return' || name === 'enter') {
          const v = result();
          const err = validate ? validate(v) : undefined;
          if (err) {
            problem = String(err);
            return undefined;
          }
          return 'submit';
        }
        if (name === 'backspace') {
          if (pos > 0) {
            chars.splice(pos - 1, 1);
            pos -= 1;
          }
        } else if (name === 'delete') {
          chars.splice(pos, 1);
        } else if (name === 'left') {
          pos = Math.max(0, pos - 1);
        } else if (name === 'right') {
          pos = Math.min(chars.length, pos + 1);
        } else if (name === 'home' || (key.ctrl && name === 'a')) {
          pos = 0;
        } else if (name === 'end' || (key.ctrl && name === 'e')) {
          pos = chars.length;
        } else if (key.ctrl && name === 'u') {
          chars = [];
          pos = 0;
        } else if (isPrintable(str, key)) {
          const add = clusters(str);
          chars.splice(pos, 0, ...add);
          pos += add.length;
        }
        return undefined;
      },
      value: result,
    });
  }

  return {
    get tty() {
      return caps.interactive;
    },
    get live() {
      return caps.live;
    },
    color: caps.color,
    unicode: caps.unicode,
    sym,
    style,
    width,
    t: tt,
    truncate: (s, max) => truncate(s, max, sym.ellipsis),
    setTranslator(fn) {
      translate = typeof fn === 'function' ? fn : null;
    },
    intro, outro, step, note, info, warn, error, success, message, command, spinner, select, confirm, text, multiselect, cancelled,
    close,
  };
}
