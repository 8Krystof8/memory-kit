// `graph`: the memory as a graph in the browser, like the graph view of Obsidian (docs/architecture.md,
// 10.11). Writes .memory-kit/graph/index.html and graph-data.js (lib/graph.mjs) and opens the page
// from the disk: no server, no port, nothing online. --live keeps running and rewrites the data
// file when a note changes or an agent uses the memory, and the open page picks it up within two
// seconds. --local adds the local sectors and then writes into the local root instead. --json
// prints the data and writes nothing. Exit 0 ok, 1 when the files cannot be written, 2 usage.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildGraph, graphDir, graphHash, uiLabels, writeGraphFiles } from '../graph.mjs';
import { interpolate, parseCli, usageError } from '../util.mjs';

export const usage = 'graph [--local] [--live] [--no-open] [--out <dir>] [--json]';

// English defaults; packs may translate the same keys.
const DEFAULTS = {
  'graph.written': 'The graph of {notes} notes and {links} links: {file}',
  'graph.opened': 'Opened in the browser.',
  'graph.open_by_hand': 'Open it in a browser: {url}',
  'graph.local_dir': 'With the local sectors, so the files stay in the local root: {dir}',
  'graph.no_local_root': '--local needs a local root on this computer (memory.json "roots"), and none exists here',
  'graph.live': 'Live: the graph follows the notes and the agents\' uses of the memory. Stop it with Ctrl+C.',
  'graph.update': '{time} · {notes} notes · {links} links',
  'graph.stopped': 'Live view stopped; the page keeps the last state.',
  'graph.failed': 'The graph could not be written: {detail}',
};

// How long --live waits after a change before it rebuilds (ms), and how often it rebuilds anyway.
const DEBOUNCE_MS = 300;
const REBUILD_MS = 10000;

function say(cfg, key, vars = {}) {
  const t = cfg?.t?.(key, vars);
  if (typeof t === 'string' && t && t !== key) return t;
  return interpolate(DEFAULTS[key], vars);
}

/**
 * Opens file in the default browser: xdg-open, open or explorer.exe, without a shell. → a promise
 * of true when the opener started. Never in CI or, on Linux, without a display.
 */
export function openInBrowser(file, { env = process.env, platform = process.platform, start = spawn } = {}) {
  if (env.CI) return Promise.resolve(false);
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return Promise.resolve(false);
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return new Promise((resolve) => {
    let child;
    try {
      child = start(cmd, [file], { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once?.('error', () => resolve(false));
    child.once?.('spawn', () => {
      child.unref?.();
      resolve(true);
    });
  });
}

/** The folders a change in which can change the graph: the vault's areas in each root, and the log. */
function watchTargets(cfg, local) {
  const roots = (cfg.roots ?? [{ id: 'main', path: cfg.root, exists: true }]).filter((r) => r.id === 'main' || (local && r.exists));
  const out = [];
  for (const r of roots) {
    for (const d of [cfg.dirs.sectors, cfg.dirs.journal, cfg.dirs.inbox, cfg.dirs.archive]) {
      const abs = path.join(r.path, ...String(d).split('/'));
      if (fs.existsSync(abs)) out.push({ abs, recursive: true });
    }
    if (r.id === 'main') out.push({ abs: r.path, recursive: false }); // state.md, waiting.md
  }
  out.push({ abs: path.join(cfg.root, '.memory-kit', 'logs'), recursive: false });
  return out;
}

export async function run(argv, cfg, ctx = {}) {
  const parsed = parseCli(argv, {
    local: { type: 'boolean' },
    live: { type: 'boolean' },
    'no-open': { type: 'boolean' },
    out: { type: 'string' },
    json: { type: 'boolean' },
  }, usage);
  if (!parsed) return 2;
  const { values, positionals } = parsed;
  if (positionals.length) {
    usageError(`unexpected argument "${positionals[0]}"`, usage);
    return 2;
  }
  const local = values.local === true;
  if (values.json) {
    process.stdout.write(`${JSON.stringify(buildGraph(cfg, { local }), null, 2)}\n`);
    return 0;
  }
  const dir = values.out ? path.resolve(values.out) : graphDir(cfg, { local });
  if (!dir) {
    process.stderr.write(`memory: ${say(cfg, 'graph.no_local_root')}\n`);
    return 2;
  }
  const labels = uiLabels(cfg);
  const env = ctx.env ?? process.env;
  // Tests stop a live view after this many ms (there is no Ctrl+C to press in a test).
  const liveFor = Number(env.MEMORY_KIT_GRAPH_LIVE_MS) || 0;

  let graph;
  let files;
  try {
    graph = buildGraph(cfg, { local });
    files = writeGraphFiles(cfg, dir, graph, { labels, live: values.live === true });
  } catch (err) {
    process.stderr.write(`memory: ${say(cfg, 'graph.failed', { detail: String(err?.message ?? err).split('\n')[0] })}\n`);
    return 1;
  }
  const out = process.stdout;
  out.write(`${say(cfg, 'graph.written', { notes: graph.stats.notes, links: graph.stats.links, file: files.page })}\n`);
  if (local && !values.out) out.write(`${say(cfg, 'graph.local_dir', { dir })}\n`);
  const url = pathToFileURL(files.page).href;
  const opened = values['no-open'] ? false : await openInBrowser(files.page, { env });
  out.write(`${opened ? say(cfg, 'graph.opened') : say(cfg, 'graph.open_by_hand', { url })}\n`);
  if (!values.live) return 0;

  out.write(`${say(cfg, 'graph.live')}\n`);
  let hash = files.hash;
  let timer = null;
  let busy = false;
  const rebuild = () => {
    timer = null;
    if (busy) return;
    busy = true;
    try {
      const next = buildGraph(cfg, { local });
      const nextHash = graphHash(next);
      if (nextHash !== hash) {
        writeGraphFiles(cfg, dir, next, { labels, live: true });
        hash = nextHash;
        graph = next;
        const time = new Date().toTimeString().slice(0, 8);
        out.write(`${say(cfg, 'graph.update', { time, notes: next.stats.notes, links: next.stats.links })}\n`);
      }
    } catch (err) {
      process.stderr.write(`memory: ${say(cfg, 'graph.failed', { detail: String(err?.message ?? err).split('\n')[0] })}\n`);
    } finally {
      busy = false;
    }
  };
  const soon = (file) => {
    if (file && /(?:^|[\\/])\.memory-kit[\\/]graph(?:[\\/]|$)/.test(String(file))) return; // our own writes
    if (timer) clearTimeout(timer);
    timer = setTimeout(rebuild, DEBOUNCE_MS);
  };
  const watchers = [];
  for (const t of watchTargets(cfg, local)) {
    try {
      watchers.push(fs.watch(t.abs, { recursive: t.recursive, persistent: true }, (event, file) => soon(file)));
    } catch {
      /* a folder that cannot be watched is still read by the periodic rebuild */
    }
  }
  const periodic = setInterval(() => soon(null), REBUILD_MS);

  return new Promise((resolve) => {
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      clearInterval(periodic);
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      try {
        // The page sees that nothing follows any more.
        writeGraphFiles(cfg, dir, graph, { labels, live: false });
      } catch {
        /* the page keeps the last data either way */
      }
      out.write(`${say(cfg, 'graph.stopped')}\n`);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (liveFor > 0) setTimeout(stop, liveFor);
  });
}
