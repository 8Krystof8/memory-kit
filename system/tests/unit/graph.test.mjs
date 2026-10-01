// The graph of the memory (docs/architecture.md, 10.11): the data built from the fixture vault in
// both languages (nodes, typed links, missing notes, the activity, privacy of the local sectors,
// determinism), the page (its Content Security Policy pins the inline code and allows no
// connection, no network API in its code, no text of a note through innerHTML) and the layout
// worker run in Node (it settles, no dot overlaps another, the same input gives the same output).

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../../lib/config.mjs';
import {
  DATA_FILE, EDGE_KINDS, GRAPH_DIR, PAGE_FILE, UI_DEFAULTS, buildGraph, dataScript, graphDir, graphHash, pageHtml, uiLabels, writeGraphFiles,
} from '../../lib/graph.mjs';
import { KIT_ROOT, fixtureVault, removeTmpDirs, tmpDir, writeFile } from '../helpers.mjs';

after(removeTmpDirs);

const NOW = new Date('2026-09-30T12:00:00.000Z');
const TEMPLATES = path.join(KIT_ROOT, 'system', 'templates', 'graph');
const kindIds = EDGE_KINDS.map((k) => k.id);
const byId = (g) => new Map(g.nodes.map((n, i) => [n.id, i]));
/** The links of a graph as "from → to (kind)" with ids, for readable assertions. */
const linkSet = (g) => new Set(g.links.map(([a, b, k]) => `${g.nodes[a].id} → ${g.nodes[b].id} (${kindIds[k]})`));

describe('the data (buildGraph)', () => {
  test('every main-root note is a node; local notes, export files and attachments are not', () => {
    const v = fixtureVault('en');
    const cfg = loadConfig(v.root);
    const g = buildGraph(cfg, { now: NOW, activity: [] });
    const ids = g.nodes.map((n) => n.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'sorted by id');
    assert.ok(ids.includes('sectors/work/pricing.md'));
    assert.ok(ids.includes('journal/2026/2026-09-15-pricing-session.md'));
    assert.ok(ids.includes('inbox/2026-09-17-loyalty-card-idea.md'));
    assert.ok(!ids.some((id) => id.endsWith('-export.md')), 'no export file');
    assert.ok(!ids.some((id) => id.includes('dentist') || id.includes('running-plan')), 'no local note');
    assert.ok(g.nodes.every((n) => n.local === false));
    assert.ok(!ids.some((id) => /\.(png|jpe?g|webp|pdf)$/i.test(id) || /\.(png|jpe?g|webp|pdf)$/i.test(id.replace(/^missing:/, ''))), 'no attachment');
    assert.equal(g.stats.notes + g.stats.missing, g.nodes.length);
    assert.equal(g.stats.links, g.links.length);
    for (const [a, b, k] of g.links) {
      assert.ok(g.nodes[a] && g.nodes[b] && kindIds[k], 'indexes in range');
      assert.notEqual(a, b, 'no loop');
    }
    assert.equal(new Set(g.links.map((l) => l.join(','))).size, g.links.length, 'one link per pair and kind');
  });

  test('the kinds of links: relations, replaces, the journal, a note\'s sector, plain links', () => {
    const v = fixtureVault('en');
    const g = buildGraph(loadConfig(v.root), { now: NOW, activity: [] });
    const links = linkSet(g);
    assert.ok(links.has('sectors/school/thesis-project.md → sectors/school/northfield-school.md (part_of)'), [...links].join('\n'));
    assert.ok(links.has('sectors/work/website-redesign.md → sectors/work/clients/harbor-bakery.md (concerns)'));
    assert.ok([...links].some((l) => l.startsWith('sectors/work/decisions/2026-06-02-fixed-price-packages.md → ') && l.endsWith('(replaces)')));
    assert.ok(links.has('sectors/work/pricing.md → sectors/work/_work.md (in)'), 'a note to its sector');
    assert.ok([...links].some((l) => l.startsWith('journal/2026/2026-09-15-pricing-session.md → ') && l.endsWith('(used)')));
    assert.ok([...links].some((l) => l.endsWith('(link)')));
    // A typed relation is not drawn again as a plain link of the same pair.
    assert.ok(!links.has('sectors/school/thesis-project.md → sectors/school/northfield-school.md (link)'));
  });

  test('a missing target becomes a missing node; an attachment does not', () => {
    const v = fixtureVault('en');
    writeFile(v.root, 'sectors/work/linking-test.md', '---\ntype: fact\nstatus: active\ndescription: "A test note with links."\nupdated: 2026-09-30\nreview_on: 2027-01-01\n---\n# Linking test\n\nSee [[no-such-note]] and ![[photo.webp]] and [[pricing]].\n');
    const g = buildGraph(loadConfig(v.root), { now: NOW, activity: [] });
    const missing = g.nodes.find((n) => n.id === 'missing:no-such-note');
    assert.ok(missing && missing.missing && missing.title === 'no-such-note');
    assert.ok(!g.nodes.some((n) => /photo/.test(n.id)));
    assert.ok(linkSet(g).has('sectors/work/linking-test.md → sectors/work/pricing.md (link)'));
  });

  test('--local adds the local notes, marked and with the root in their id', () => {
    const v = fixtureVault('en');
    const g = buildGraph(loadConfig(v.root), { local: true, now: NOW, activity: [] });
    const local = g.nodes.filter((n) => n.local);
    assert.ok(local.length >= 2, 'the private notes are in');
    for (const n of local) assert.match(n.id, /^[a-z0-9_-]+:sectors\/health\//);
  });

  test('the activity: uses per note, the last use, and the recent uses as node indexes', () => {
    const v = fixtureVault('en');
    const activity = [
      { t: '2026-09-30T11:50:00.000Z', via: 'cli', op: 'search', agent: 'claude-code', n: 3, notes: ['sectors/work/pricing.md', 'sectors/work/clients/harbor-bakery.md'] },
      { t: '2026-09-30T11:55:00.000Z', via: 'mcp', op: 'read', agent: 'claude-ai', notes: ['sectors/work/pricing.md'] },
      { t: '2026-09-20T09:00:00.000Z', via: 'cli', op: 'save', notes: ['sectors/core/toolbox.md'] },
    ];
    const g = buildGraph(loadConfig(v.root), { now: NOW, activity });
    const ids = byId(g);
    const pricing = g.nodes[ids.get('sectors/work/pricing.md')];
    assert.equal(pricing.used, 2, 'the first hit of a search and a read');
    assert.equal(pricing.last, '2026-09-30T11:55:00.000Z');
    assert.equal(g.nodes[ids.get('sectors/work/clients/harbor-bakery.md')].used, 0, 'only the first hit of a search counts');
    assert.equal(g.nodes[ids.get('sectors/core/toolbox.md')].used, 1);
    assert.deepEqual(g.recent.map((r) => [r.op, r.notes.map((i) => g.nodes[i].id)]), [
      ['search', ['sectors/work/pricing.md', 'sectors/work/clients/harbor-bakery.md']],
      ['read', ['sectors/work/pricing.md']],
    ], 'the last day only, oldest first');
  });

  test('the same files, log and clock give the same graph; the hash ignores the time', () => {
    const v = fixtureVault('en');
    const cfg = loadConfig(v.root);
    const a = buildGraph(cfg, { now: NOW, activity: [] });
    const b = buildGraph(cfg, { now: NOW, activity: [] });
    assert.deepEqual(a, b);
    const later = buildGraph(cfg, { now: new Date(NOW.getTime() + 60000), activity: [] });
    assert.equal(graphHash(later), graphHash(a));
    writeFile(v.root, 'sectors/work/pricing.md', `${fs.readFileSync(path.join(v.root, 'sectors', 'work', 'pricing.md'), 'utf8')}\nSee also [[toolbox]].\n`);
    assert.notEqual(graphHash(buildGraph(loadConfig(v.root), { now: NOW, activity: [] })), graphHash(a), 'a new link changes it');
  });

  test('the page\'s words come from the pack: Czech in a Czech vault, English otherwise', () => {
    const en = uiLabels(loadConfig(fixtureVault('en').root));
    const cs = uiLabels(loadConfig(fixtureVault('cs').root));
    assert.deepEqual(Object.keys(en), Object.keys(UI_DEFAULTS).map((k) => k.slice('graph.ui.'.length)));
    assert.equal(en.title, 'Memory graph');
    assert.equal(cs.title, 'Graf paměti');
    assert.equal(cs.kind_part_of, 'patří k');
    for (const key of Object.keys(cs)) assert.ok(cs[key] && cs[key] !== `graph.ui.${key}`, key);
  });
});

describe('the files and the page', () => {
  test('graph-data.js is one call of memoryGraph with the graph, its hash, the live flag and the words', () => {
    const cfg = loadConfig(fixtureVault('en').root);
    const g = buildGraph(cfg, { now: NOW, activity: [] });
    const text = dataScript(g, { labels: uiLabels(cfg), live: true });
    assert.match(text, /^\/\* memory-kit graph data .*\*\/\nmemoryGraph\(\{/);
    assert.ok(text.endsWith(');\n'));
    const payload = JSON.parse(text.slice(text.indexOf('memoryGraph(') + 'memoryGraph('.length, text.lastIndexOf(')')));
    assert.equal(payload.hash, graphHash(g));
    assert.equal(payload.live, true);
    assert.equal(payload.refresh, 1500);
    assert.equal(payload.labels.title, 'Memory graph');
    assert.deepEqual(payload.nodes, g.nodes);
  });

  test('the Content Security Policy pins the inline script and style by hash and allows no connection', () => {
    const html = pageHtml();
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1];
    assert.ok(csp, 'a CSP meta tag');
    const read = (name) => fs.readFileSync(path.join(TEMPLATES, name), 'utf8').replace(/\r\n/g, '\n');
    const hash = (text) => createHash('sha256').update(text, 'utf8').digest('base64');
    assert.ok(csp.includes(`'sha256-${hash(read('app.js'))}'`), 'the app script');
    assert.ok(csp.includes(`style-src 'sha256-${hash(read('style.css'))}'`), 'the style');
    for (const part of ["default-src 'none'", "connect-src 'none'", "font-src 'none'", "base-uri 'none'", "form-action 'none'", 'worker-src blob:']) {
      assert.ok(csp.includes(part), part);
    }
    // The inline code is exactly what was hashed.
    assert.ok(html.includes(`<script>${read('app.js')}</script>`));
    assert.ok(html.includes(`<style>${read('style.css')}</style>`));
    assert.ok(html.includes(`<script src="${DATA_FILE}"></script>`));
    assert.ok(!/https?:\/\//.test(html.replace(/http-equiv/g, '')), 'no URL of any site');
  });

  test('the page\'s code calls no network API and never puts note text into HTML', () => {
    for (const name of ['app.js', 'layout.js']) {
      const code = fs.readFileSync(path.join(TEMPLATES, name), 'utf8');
      for (const re of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bEventSource\b/, /sendBeacon/, /importScripts/, /\beval\s*\(/, /new Function/]) {
        assert.doesNotMatch(code, re, `${name}: ${re}`);
      }
      assert.doesNotMatch(code, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write/, `${name} builds HTML only with DOM methods`);
    }
  });

  test('graphDir and writeGraphFiles: the main root, or the local root with --local; the page is rewritten only when it changes', () => {
    const v = fixtureVault('en');
    const cfg = loadConfig(v.root);
    const main = graphDir(cfg);
    assert.equal(main, path.join(v.root, ...GRAPH_DIR.split('/')));
    const local = graphDir(cfg, { local: true });
    assert.ok(local.startsWith(path.join(v.priv) + path.sep) || local.startsWith(path.resolve(v.priv) + path.sep), local);
    const g = buildGraph(cfg, { now: NOW, activity: [] });
    const first = writeGraphFiles(cfg, main, g, { labels: uiLabels(cfg) });
    assert.equal(first.page, path.join(main, PAGE_FILE));
    const mtime = fs.statSync(first.page).mtimeMs;
    const again = writeGraphFiles(cfg, main, g, { labels: uiLabels(cfg), live: true });
    assert.equal(fs.statSync(again.page).mtimeMs, mtime, 'the same page is not written again');
    assert.match(fs.readFileSync(again.data, 'utf8'), /"live":true/);
    const bare = loadConfig(fixtureVault('en').root);
    bare.roots = bare.roots.filter((r) => r.id === 'main');
    assert.equal(graphDir(bare, { local: true }), null, 'no local root');
    const elsewhere = tmpDir('graph-out');
    writeGraphFiles(cfg, elsewhere, g, {});
    assert.ok(fs.existsSync(path.join(elsewhere, PAGE_FILE)) && fs.existsSync(path.join(elsewhere, DATA_FILE)));
  });
});

describe('the layout worker, run in Node', () => {
  /** layout.js with a fake worker scope: {L, posts}. */
  function loadLayout() {
    const posts = [];
    const self = { postMessage: (m) => posts.push(m) };
    // eslint-disable-next-line no-new-func
    new Function('self', fs.readFileSync(path.join(TEMPLATES, 'layout.js'), 'utf8'))(self);
    return { L: self.memoryKitLayout, posts, self };
  }
  /** A clustered random graph with a fixed seed. */
  function graphOf(n, seed = 5) {
    let s = seed;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const src = [], dst = [], w = [];
    for (let e = 0; e < n * 2; e++) {
      const a = Math.floor(rnd() * n), c = Math.floor(a / 20) * 20;
      let b = rnd() < 0.85 ? c + Math.floor(rnd() * 20) : Math.floor(rnd() * n);
      if (b >= n) b = n - 1;
      if (a === b) continue;
      src.push(a);
      dst.push(b);
      w.push(0.4 + rnd());
    }
    const r = Array.from({ length: n }, (_, i) => 8 + (i % 5) * 4);
    return { n, src: Int32Array.from(src), dst: Int32Array.from(dst), w: Float32Array.from(w), r: Float32Array.from(r) };
  }
  const settle = (L, g, pos = null) => {
    L.init({ type: 'init', gen: 1, ...g, pos, alpha: 1, params: { charge: -1030, distance: 250, link: 1, gravity: 0.05 } });
    let ticks = 0;
    while (L.state().alpha >= 0.001 && ticks < 2000) {
      L.tick();
      ticks++;
    }
    return ticks;
  };

  test('it settles within about 300 ticks, with finite positions and no dot over another', () => {
    const { L } = loadLayout();
    const g = graphOf(300);
    const ticks = settle(L, g);
    assert.ok(ticks <= 320, `${ticks} ticks`);
    const { x, y, r } = L.state();
    for (let i = 0; i < g.n; i++) assert.ok(Number.isFinite(x[i]) && Number.isFinite(y[i]), `node ${i}`);
    let overlaps = 0;
    for (let a = 0; a < g.n; a++) {
      for (let b = a + 1; b < g.n; b++) if (Math.hypot(x[a] - x[b], y[a] - y[b]) < r[a] + r[b] - 1) overlaps++;
    }
    assert.equal(overlaps, 0);
  });

  test('linked dots end up closer than unlinked ones, and the same input gives the same layout', () => {
    const one = loadLayout();
    const g = graphOf(200);
    settle(one.L, g);
    const s1 = one.L.state();
    let linked = 0;
    for (let e = 0; e < g.src.length; e++) linked += Math.hypot(s1.x[g.src[e]] - s1.x[g.dst[e]], s1.y[g.src[e]] - s1.y[g.dst[e]]);
    linked /= g.src.length;
    let any = 0;
    for (let i = 0; i < 199; i++) any += Math.hypot(s1.x[i] - s1.x[(i * 37 + 11) % 200], s1.y[i] - s1.y[(i * 37 + 11) % 200]);
    any /= 199;
    assert.ok(linked < any, `linked ${linked.toFixed(0)} < random pairs ${any.toFixed(0)}`);
    const two = loadLayout();
    settle(two.L, graphOf(200));
    assert.deepEqual(Array.from(two.L.state().x), Array.from(s1.x));
  });

  test('known positions stay where they were (a warm start), and the messages carry the page\'s generation', async () => {
    const { L, self, posts } = loadLayout();
    const g = graphOf(50);
    settle(L, g);
    const before = Float32Array.from(L.state().x);
    const pos = new Float32Array(2 * g.n);
    for (let i = 0; i < g.n; i++) {
      pos[2 * i] = L.state().x[i];
      pos[2 * i + 1] = L.state().y[i];
    }
    posts.length = 0;
    self.onmessage({ data: { type: 'init', gen: 7, ...graphOf(50), pos, alpha: 0.3, params: {} } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    self.onmessage({ data: { type: 'stop' } });
    const first = posts.find((m) => m.type === 'pos');
    assert.equal(first.gen, 7);
    let moved = 0;
    for (let i = 0; i < g.n; i++) moved = Math.max(moved, Math.abs(first.pos[2 * i] - before[i]));
    assert.ok(moved < 1, `the first message keeps the known places (moved ${moved})`);
  });
});
