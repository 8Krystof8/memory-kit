// A fake terminal for tests of lib/tui.mjs and the screens built on it: a TTY stdout that records
// every byte, a TTY stdin with a setRawMode stub that records its calls, and a key script that
// feeds one chunk of keys to each prompt as soon as it listens. screen() replays the recorded
// bytes (CR, LF, cursor up, erase down, erase line, optionally wrapping at a width; colours and
// cursor visibility ignored) into the text a real terminal would show at the end.

import { PassThrough, Writable } from 'node:stream';

export const KEY = {
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', space: ' ', backspace: '\x7f',
  ctrlC: '\x03', ctrlD: '\x04', esc: '\x1b',
};

/**
 * { stdout, stdin, output(), raw: [calls of setRawMode], keys(...chunks) }. Each chunk of keys is
 * written when the next prompt starts listening. isTTY false plays a pipe.
 */
export function fakeTerminal({ columns = 72, rows = 30, isTTY = true } = {}) {
  const chunks = [];
  const stdout = new Writable({
    write(chunk, encoding, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const stdin = new PassThrough();
  const raw = [];
  if (isTTY) {
    stdout.isTTY = true;
    stdout.columns = columns;
    stdout.rows = rows;
    stdin.isTTY = true;
    stdin.setRawMode = (on) => {
      raw.push(on);
      return stdin;
    };
  }
  const queue = [];
  stdin.on('newListener', (event) => {
    if (event !== 'keypress') return;
    const next = queue.shift();
    if (next !== undefined) setImmediate(() => stdin.write(next));
  });
  return {
    stdout,
    stdin,
    raw,
    output: () => chunks.join(''),
    keys: (...list) => {
      queue.push(...list);
    },
    pending: () => queue.length,
  };
}

/**
 * The final screen of recorded terminal output. columns: wrap like a real terminal (a character
 * written past the last column starts the next row, one column per code point), so a redraw that
 * miscounts its rows leaves the stale lines a real terminal would show.
 */
export function screen(out, { columns = Infinity } = {}) {
  const lines = [''];
  let row = 0;
  let col = 0;
  const put = (ch) => {
    if (col >= columns) {
      row += 1;
      col = 0;
      if (lines.length <= row) lines.push('');
    }
    const l = [...lines[row]];
    while (l.length < col) l.push(' ');
    l[col] = ch;
    lines[row] = l.join('');
    col += 1;
  };
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '\x1b') {
      const m = /^\x1b\[(\??)(\d*)([A-Za-z])/.exec(out.slice(i));
      if (!m) continue;
      i += m[0].length - 1;
      const n = Number(m[2] || 1);
      if (m[3] === 'A') row = Math.max(0, row - n);
      else if (m[3] === 'J') {
        lines[row] = [...lines[row]].slice(0, col).join('');
        lines.length = row + 1;
      } else if (m[3] === 'K') lines[row] = [...lines[row]].slice(0, col).join('');
      continue;
    }
    if (c === '\r') {
      col = 0;
      continue;
    }
    if (c === '\n') {
      row += 1;
      col = 0;
      if (lines.length <= row) lines.push('');
      continue;
    }
    put(c);
  }
  return lines.join('\n');
}

/** Every escape sequence in out, e.g. ['\x1b[36m', '\x1b[?25l']. */
export const escapes = (out) => out.match(/\x1b\[[0-9;?]*[A-Za-z]/g) ?? [];
