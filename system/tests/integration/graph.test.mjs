// `graph` end to end (docs/architecture.md, 10.11): the files it writes and where, --json, --local
// (into the local root, never the main root), the Czech aliases and texts, --live (the data file
// follows a changed note and ends with live: false), and how it opens the browser (never in CI,
// never on Linux without a display, without a shell).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openInBrowser } from '../../lib/commands/graph.mjs';
import { DATA_FILE, GRAPH_DIR, PAGE_FILE } from '../../lib/graph.mjs';
import { fixtureVault, removeTmpDirs, runCli, writeFile } from '../helpers.mjs';

after(removeTmpDirs);

const dataOf = (dir) => {
  const text = fs.readFileSync(path.join(dir, DATA_FILE), 'utf8');
  return JSON.parse(text.slice(text.indexOf('memoryGraph(') + 'memoryGraph('.length, text.lastIndexOf(')')));
};
const graphFolder = (root) => path.join(root, ...GRAPH_DIR.split('/'));

describe('graph', () => {
  test('writes the page and its data into .memory-kit/graph/ and names the file', () => {
    const v = fixtureVault('en');
    const res = runCli(v.root, ['graph', '--no-open']);
    assert.equal(res.code, 0, res.stderr);
    const dir = graphFolder(v.root);
    const lines = res.stdout.trimEnd().split('\n');
    assert.match(lines[0], new RegExp(`^The graph of \\d+ notes and \\d+ links: ${path.join(dir, PAGE_FILE).replace(/[\\.]/g, '\\$&')}$`));
    assert.match(lines[1], /^Open it in a browser: file:\/\//);
    const data = dataOf(dir);
    assert.equal(data.live, false);
    assert.ok(data.nodes.length > 20);
    assert.ok(data.nodes.every((n) => !n.local), 'no local note without --local');
    assert.ok(fs.readFileSync(path.join(dir, PAGE_FILE), 'utf8').includes('Content-Security-Policy'));
  });

  test('--json prints the graph and writes nothing', () => {
    const v = fixtureVault('en');
    const res = runCli(v.root, ['graph', '--json']);
    assert.equal(res.code, 0, res.stderr);
    const g = JSON.parse(res.stdout);
    assert.equal(g.v, 1);
    assert.ok(Array.isArray(g.nodes) && Array.isArray(g.links));
    assert.ok(!fs.existsSync(graphFolder(v.root)));
  });

  test('--local writes into the local root, so no local note lands in the main root', () => {
    const v = fixtureVault('en');
    const res = runCli(v.root, ['graph', '--local', '--no-open']);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!fs.existsSync(graphFolder(v.root)), 'nothing in the main root');
    const dir = graphFolder(v.priv);
    assert.ok(res.stdout.includes(dir), res.stdout);
    assert.ok(dataOf(dir).nodes.some((n) => n.local));
  });

  test('cs: graf --neotvirat, in Czech', () => {
    const v = fixtureVault('cs');
    const res = runCli(v.root, ['graf', '--neotvirat']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Graf \d+ poznámek a \d+ vazeb: /);
    assert.match(res.stdout, /\nOtevři ho v prohlížeči: file:\/\//);
    assert.equal(dataOf(graphFolder(v.root)).labels.title, 'Graf paměti');
  });

  test('a usage error exits 2', () => {
    const v = fixtureVault('en');
    assert.equal(runCli(v.root, ['graph', 'extra']).code, 2);
    assert.equal(runCli(v.root, ['graph', '--bogus']).code, 2);
  });

  test('--live follows a changed note and ends with live: false', async () => {
    const v = fixtureVault('en');
    const child = spawn(process.execPath, [path.join(v.root, 'system', 'memory.mjs'), 'graph', '--live', '--no-open', '--root', v.root], {
      cwd: v.root, env: { ...process.env, CI: '', MEMORY_KIT_GRAPH_LIVE_MS: '4000' }, windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    const dir = graphFolder(v.root);
    const waitFor = async (ok, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          if (ok()) return true;
        } catch {
          /* the file is being written */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    assert.ok(await waitFor(() => dataOf(dir).live === true, 3000), `live data written\n${out}`);
    const before = dataOf(dir).hash;
    writeFile(v.root, 'sectors/work/live-test.md', '---\ntype: fact\nstatus: active\ndescription: "A note written while the graph is live."\nupdated: 2026-09-30\nreview_on: 2027-01-01\n---\n# Live test\n\nSee [[pricing]].\n');
    assert.ok(await waitFor(() => dataOf(dir).hash !== before, 3000), `the data follows the new note\n${out}`);
    assert.ok(dataOf(dir).nodes.some((n) => n.id === 'sectors/work/live-test.md'));
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, out);
    assert.equal(dataOf(dir).live, false);
    assert.match(out, /Live: the graph follows/);
    assert.match(out, /\d\d:\d\d:\d\d · \d+ notes · \d+ links/);
    assert.match(out, /Live view stopped/);
  });
});

describe('opening the browser', () => {
  const fake = (event = 'spawn') => {
    const calls = [];
    const start = (cmd, args, opts) => {
      calls.push({ cmd, args, shell: opts.shell, detached: opts.detached, windowsHide: opts.windowsHide });
      const handlers = {};
      setTimeout(() => handlers[event]?.(new Error('ENOENT')), 0);
      return { once: (e, fn) => (handlers[e] = fn), unref() {} };
    };
    return { calls, start };
  };

  test('the system opener, without a shell: xdg-open, open, explorer.exe', async () => {
    for (const [platform, cmd, env] of [['linux', 'xdg-open', { DISPLAY: ':0' }], ['linux', 'xdg-open', { WAYLAND_DISPLAY: 'wayland-0' }], ['darwin', 'open', {}], ['win32', 'explorer.exe', {}]]) {
      const f = fake();
      assert.equal(await openInBrowser('/v/.memory-kit/graph/index.html', { env, platform, start: f.start }), true, platform);
      assert.deepEqual(f.calls, [{ cmd, args: ['/v/.memory-kit/graph/index.html'], shell: undefined, detached: true, windowsHide: true }]);
    }
  });

  test('never in CI or on Linux without a display; a missing opener is no error', async () => {
    for (const [platform, env] of [['linux', { CI: 'true', DISPLAY: ':0' }], ['darwin', { CI: '1' }], ['linux', {}]]) {
      const f = fake();
      assert.equal(await openInBrowser('/x.html', { env, platform, start: f.start }), false);
      assert.equal(f.calls.length, 0);
    }
    const broken = fake('error');
    assert.equal(await openInBrowser('/x.html', { env: { DISPLAY: ':0' }, platform: 'linux', start: broken.start }), false);
  });
});
