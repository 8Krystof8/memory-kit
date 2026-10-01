/* memory-kit graph page: draws the graph of graph-data.js (lib/graph.mjs) the way the graph view
   of Obsidian does. A layout worker (the text of #layout-src) moves the dots; WebGL2 draws lines and
   dots (Canvas 2D when WebGL2 is missing); a second canvas draws the labels; panels filter, colour
   and explain. In live mode it loads the data file again every few seconds. It never reads
   anything else and never sends anything: the page's Content Security Policy forbids both. Text
   from the notes only ever goes into textContent or onto a canvas. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const STORE = 'memory-kit-graph';
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(`${STORE}:${key}`);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`${STORE}:${key}`, JSON.stringify(value));
      } catch {
        /* storage off (private window): settings last for this visit */
      }
    },
  };
  const motion = !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // Diagnostics in the address: #2d draws without WebGL2, #keep keeps WebGL frames for screenshots.
  const flags = new Set(String(location.hash || '').replace(/^#/, '').split(/[,+]/).filter(Boolean));

  const DEFAULT_SETTINGS = Object.freeze({
    orphans: true, journal: true, inbox: true, archive: false, sectors: true, missing: false,
    colorBy: 'sector', nodeSize: 1, linkWidth: 1, labels: 0.5,
    center: 0.5, repel: 0.5, linkForce: 0.5, linkDistance: 0.5, open: false,
  });
  let settings = Object.assign({}, DEFAULT_SETTINGS, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // The page's words come with the data; these few cover the time before it arrives.
  let L = {
    waiting: 'Waiting for the data file graph-data.js next to this page.',
    no_webgl: 'This browser has no WebGL2, so the graph is drawn in a simpler mode.',
  };
  const t = (key, vars) => String(L[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
  const AGENTS = { 'claude-code': 'Claude Code', codex: 'Codex', 'gemini-cli': 'Gemini CLI' };
  const TYPE_ORDER = ['decision', 'rule', 'procedure', 'fact', 'insight', 'project', 'proposal', 'analysis', 'text', 'list', 'person', 'organization', 'journal', 'sector', 'hub', 'inbox'];
  const STATUS_VAR = { active: '--s-active', waiting: '--s-waiting', done: '--s-done', replaced: '--s-replaced', rejected: '--s-rejected' };
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---------------------------------------------------------------------------------------------
  // Theme: colours from the CSS tokens, as [r, g, b] in 0..1

  let theme = null;
  function cssColor(name) {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = rgb.match(/[\d.]+/g) || ['128', '128', '128', '1'];
    return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255, m[3] === undefined ? 1 : Number(m[3])];
  }
  function readTheme() {
    const palette = [];
    for (let i = 0; i < 12; i++) palette.push(cssColor(`--g${i}`));
    const status = {};
    for (const [k, v] of Object.entries(STATUS_VAR)) status[k] = cssColor(v);
    theme = {
      bg: cssColor('--bg'), edge: cssColor('--edge'), edgeHi: cssColor('--edge-hi'), glow: cssColor('--glow'),
      missing: cssColor('--missing'), muted: cssColor('--muted'), label: getComputedStyle(document.body).getPropertyValue('--label').trim() || '#ddd',
      halo: getComputedStyle(document.body).getPropertyValue('--halo').trim() || 'rgba(0,0,0,0.8)', palette, status,
    };
  }
  const css = (c, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;

  // ---------------------------------------------------------------------------------------------
  // The data and the view (what the filters leave), with their positions

  let data = null;
  let nodes = [];            // data.nodes
  let kinds = [];            // data.kinds: [{id, w}]
  let kindOf = new Map();    // kind id → index
  let out = [];              // per node: [[to, kind], ...]
  let inc = [];              // per node: [[from, kind], ...]
  let vis = new Int32Array(0);     // node indexes in the view
  let viewOf = new Int32Array(0);  // node index → view index, or -1
  let edgeS = new Int32Array(0), edgeT = new Int32Array(0), edgeW = new Float32Array(0);
  let nbrs = [];                   // view index → view indexes of its neighbours
  let pos = new Float32Array(0);   // view positions [x0, y0, x1, y1, ...]
  let radius = new Float32Array(0);
  let groupOf = [];                // view index → group key
  let groups = new Map();          // group key → {label, color, count}
  const posCache = new Map();      // node id → [x, y]
  let localView = null;            // {id, depth} while the local graph is shown
  let gen = 0;
  let layoutAlpha = 0;

  function groupKey(node) {
    if (node.missing) return 'missing';
    if (settings.colorBy === 'type') return node.type ? `type:${node.type}` : 'none';
    if (settings.colorBy === 'status') return node.status ? `status:${node.status}` : 'none';
    if (node.sector) return `sector:${node.sector}`;
    return `area:${node.area || 'root'}`;
  }
  function groupInfo(key) {
    if (key === 'missing') return { label: L.missing, color: theme.missing, order: 1e6 };
    if (key === 'none') return { label: L.none, color: theme.muted, order: 1e6 - 1 };
    const [kind, value] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'status') {
      return { label: (data.statuses || {})[value] || value, color: theme.status[value] || theme.muted, order: Object.keys(STATUS_VAR).indexOf(value) };
    }
    if (kind === 'type') {
      const i = TYPE_ORDER.indexOf(value);
      return { label: value === 'inbox' ? L.inbox : (data.types || {})[value] || value, color: theme.palette[(i < 0 ? 11 : i) % 12], order: i < 0 ? 99 : i };
    }
    if (kind === 'sector') {
      const i = (data.sectors || []).findIndex((s) => s.id === value);
      const s = data.sectors[i];
      return { label: s ? s.title : value, color: theme.palette[(i < 0 ? 11 : i) % 12], order: i < 0 ? 99 : i };
    }
    const area = { journal: [L.journal, 11, 200], inbox: [L.inbox, 8, 201], root: [L.root, 3, 202] }[value] || [value, 11, 203];
    return { label: area[0], color: theme.palette[area[1]], order: area[2] };
  }

  function prepare(d) {
    data = d;
    nodes = d.nodes || [];
    kinds = d.kinds || [];
    kindOf = new Map(kinds.map((k, i) => [k.id, i]));
    out = nodes.map(() => []);
    inc = nodes.map(() => []);
    for (const [a, b, k] of d.links || []) {
      if (!nodes[a] || !nodes[b]) continue;
      out[a].push([b, k]);
      inc[b].push([a, k]);
    }
  }

  /** Which nodes and links the view shows now: filters, the local graph, and their edges. */
  function rebuildView({ refit = true } = {}) {
    if (!data) return;
    const n = nodes.length;
    const inKind = kindOf.get('in');
    const shown = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = nodes[i];
      shown[i] = (v.missing && !settings.missing) || (v.archived && !settings.archive) || (v.area === 'journal' && !settings.journal)
        || (v.area === 'inbox' && !settings.inbox) || (v.type === 'sector' && !settings.sectors) ? 0 : 1;
    }
    const usable = (k) => k !== inKind || settings.sectors;
    if (localView) {
      const root = nodes.findIndex((v) => v.id === localView.id);
      const keep = new Uint8Array(n);
      if (root >= 0) {
        let frontier = [root];
        keep[root] = 1;
        for (let depth = 0; depth < localView.depth; depth++) {
          const next = [];
          for (const i of frontier) {
            for (const [j, k] of out[i].concat(inc[i])) {
              if (!keep[j] && shown[j] && usable(k)) {
                keep[j] = 1;
                next.push(j);
              }
            }
          }
          frontier = next;
        }
      }
      for (let i = 0; i < n; i++) shown[i] = shown[i] && keep[i];
    }
    if (!settings.orphans) {
      const deg = new Int32Array(n);
      for (let a = 0; a < n; a++) {
        for (const [b, k] of out[a]) {
          if (k !== inKind && shown[a] && shown[b]) {
            deg[a]++;
            deg[b]++;
          }
        }
      }
      for (let i = 0; i < n; i++) if (!deg[i] && nodes[i].type !== 'sector') shown[i] = 0;
    }

    const list = [];
    viewOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      if (shown[i]) {
        viewOf[i] = list.length;
        list.push(i);
      }
    }
    vis = Int32Array.from(list);
    const m = vis.length;

    // One undirected edge per pair; its weight sums the kinds (a typed relation and a link: stronger).
    const pairs = new Map();
    for (let a = 0; a < n; a++) {
      if (viewOf[a] < 0) continue;
      for (const [b, k] of out[a]) {
        if (viewOf[b] < 0 || !usable(k) || a === b) continue;
        const s = Math.min(viewOf[a], viewOf[b]), e = Math.max(viewOf[a], viewOf[b]);
        const key = s * m + e;
        pairs.set(key, Math.min(2.5, (pairs.get(key) || 0) + (kinds[k] ? kinds[k].w : 0.4)));
      }
    }
    edgeS = new Int32Array(pairs.size);
    edgeT = new Int32Array(pairs.size);
    edgeW = new Float32Array(pairs.size);
    nbrs = Array.from({ length: m }, () => []);
    let e = 0;
    for (const [key, w] of pairs) {
      const s = Math.floor(key / m), d = key - s * m;
      edgeS[e] = s;
      edgeT[e] = d;
      edgeW[e] = w;
      nbrs[s].push(d);
      nbrs[d].push(s);
      e++;
    }

    radius = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const v = nodes[vis[i]];
      const deg = nbrs[i].length;
      const base = v.missing ? 6 : clamp(3 * Math.sqrt(deg + 1), 8, 30) * (1 + 0.12 * Math.log2(1 + (v.used || 0)));
      radius[i] = base * settings.nodeSize;
    }
    restyleGroups();

    const start = new Float32Array(2 * m);
    let known = 0;
    for (let i = 0; i < m; i++) {
      const p = posCache.get(nodes[vis[i]].id);
      if (p) {
        start[2 * i] = p[0];
        start[2 * i + 1] = p[1];
        known++;
      } else {
        start[2 * i] = NaN;
        start[2 * i + 1] = NaN;
      }
    }
    pos = new Float32Array(2 * m);
    for (let i = 0; i < 2 * m; i++) pos[i] = Number.isNaN(start[i]) ? 0 : start[i];
    hover = -1;
    if (selected >= 0 && viewOf[selected] < 0) closeInfo();
    const warm = m > 0 && known / m > 0.8;
    startLayout(start, warm ? 0.3 : 1);
    if (refit) {
      autoFit = true;
      // Known places: show them at once instead of flying in from the middle.
      if (warm) fit(null, true);
    }
    updateMatches();
    renderLegend();
    renderStatus();
    dirty.pos = dirty.style = true;
    request();
  }

  function restyleGroups() {
    groups = new Map();
    groupOf = new Array(vis.length);
    for (let i = 0; i < vis.length; i++) {
      const key = groupKey(nodes[vis[i]]);
      groupOf[i] = key;
      if (!groups.has(key)) groups.set(key, Object.assign(groupInfo(key), { count: 0 }));
      groups.get(key).count++;
    }
    if (legendPick && !groups.has(legendPick)) legendPick = null;
  }

  // ---------------------------------------------------------------------------------------------
  // The layout worker

  let worker = null;
  let workerUrl = null;
  function physics() {
    return {
      charge: -(40 + 3960 * settings.repel * settings.repel),
      distance: 30 + 440 * settings.linkDistance,
      link: 2 * settings.linkForce,
      gravity: 0.2 * settings.center * settings.center,
    };
  }
  function startLayout(start, alpha) {
    gen++;
    if (!worker) {
      try {
        workerUrl = URL.createObjectURL(new Blob([$('layout-src').textContent], { type: 'text/javascript' }));
        worker = new Worker(workerUrl);
        worker.onmessage = onWorker;
        worker.onerror = () => {
          worker = null;
          spiral();
        };
      } catch {
        worker = null;
      }
    }
    if (!worker) {
      spiral();
      return;
    }
    const src = Int32Array.from(edgeS), dst = Int32Array.from(edgeT), w = Float32Array.from(edgeW), r = Float32Array.from(radius);
    worker.postMessage({ type: 'init', gen, n: vis.length, src, dst, w, r, pos: start, alpha, params: physics() }, [src.buffer, dst.buffer, w.buffer, r.buffer, start.buffer]);
    layoutAlpha = alpha;
  }
  /** Without a worker the dots get a fixed spiral, so the page still shows the notes. */
  function spiral() {
    for (let i = 0; i < vis.length; i++) {
      const r = 60 * Math.sqrt(0.5 + i), a = i * Math.PI * (3 - Math.sqrt(5));
      pos[2 * i] = r * Math.cos(a);
      pos[2 * i + 1] = r * Math.sin(a);
    }
    dirty.pos = true;
    autoFit = true;
    request();
  }
  let lastSave = 0;
  function onWorker(ev) {
    const m = ev.data || {};
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
    if (m.gen !== gen) return;
    if (m.type === 'pos' && m.pos && m.pos.length === pos.length) {
      pos = m.pos;
      layoutAlpha = m.alpha;
      if (dragging >= 0 && dragAt) {
        pos[2 * dragging] = dragAt[0];
        pos[2 * dragging + 1] = dragAt[1];
      }
      dirty.pos = true;
      if (Date.now() - lastSave > 3000) rememberPositions(false);
      request();
    } else if (m.type === 'idle') {
      layoutAlpha = 0;
      rememberPositions(true);
    }
  }
  function rememberPositions(persist) {
    lastSave = Date.now();
    for (let i = 0; i < vis.length; i++) posCache.set(nodes[vis[i]].id, [pos[2 * i], pos[2 * i + 1]]);
    if (!persist || !data || posCache.size > 20000) return;
    const saved = {};
    for (const [id, p] of posCache) saved[id] = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
    store.set(`pos:${data.vault}:${data.local ? 1 : 0}`, saved);
  }

  // ---------------------------------------------------------------------------------------------
  // Camera: world units to CSS pixels

  const glCanvas = $('gl');
  const labelCanvas = $('labels');
  const lctx = labelCanvas.getContext('2d');
  let W = 1, H = 1, dpr = 1;
  const cam = { x: 0, y: 0, k: 0.5 };
  const goal = { x: 0, y: 0, k: 0.5, on: false };
  let autoFit = true;
  const sx = (x) => (x - cam.x) * cam.k + W / 2;
  const sy = (y) => (y - cam.y) * cam.k + H / 2;
  const wx = (x) => (x - W / 2) / cam.k + cam.x;
  const wy = (y) => (y - H / 2) / cam.k + cam.y;

  function bounds(only) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const list = only || vis.map((_, i) => i);
    for (const i of list) {
      const r = radius[i] || 8;
      x0 = Math.min(x0, pos[2 * i] - r);
      x1 = Math.max(x1, pos[2 * i] + r);
      y0 = Math.min(y0, pos[2 * i + 1] - r);
      y1 = Math.max(y1, pos[2 * i + 1] + r);
    }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }
  function fit(only, instant) {
    const b = bounds(only);
    if (!b) return;
    const pad = 60;
    const k = clamp(Math.min((W - 2 * pad) / Math.max(b.x1 - b.x0, 1), (H - 2 * pad) / Math.max(b.y1 - b.y0, 1)), 0.005, 4);
    Object.assign(goal, { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, k, on: true });
    if (instant || !motion) Object.assign(cam, { x: goal.x, y: goal.y, k: goal.k }), (goal.on = false);
    request();
  }
  function zoomAt(px, py, factor) {
    const x = wx(px), y = wy(py);
    cam.k = clamp(cam.k * factor, 0.003, 12);
    cam.x = x - (px - W / 2) / cam.k;
    cam.y = y - (py - H / 2) / cam.k;
    goal.on = false;
    autoFit = false;
    request();
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    for (const c of [glCanvas, labelCanvas]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    dirty.pos = true;
    request();
  }

  // ---------------------------------------------------------------------------------------------
  // Focus: what hover, selection, search or a legend pick bring forward

  let hover = -1;          // view index
  let selected = -1;       // node index
  let matches = [];        // view indexes of the search
  let legendPick = null;   // group key
  function focus() {
    const centre = hover >= 0 ? hover : selected >= 0 ? viewOf[selected] : -1;
    if (centre >= 0) {
      const set = new Set([centre, ...nbrs[centre]]);
      return { set, centre };
    }
    if (matches.length) return { set: new Set(matches), centre: -1 };
    if (legendPick) {
      const set = new Set();
      for (let i = 0; i < vis.length; i++) if (groupOf[i] === legendPick) set.add(i);
      return { set, centre: -1 };
    }
    return null;
  }

  function nowGlow(i) {
    const last = nodes[vis[i]].last;
    if (!last) return 0;
    const age = Date.now() - Date.parse(last);
    if (!(age >= 0) || age > 10 * 60000) return 0;
    if (age < 60000 && motion) return 0.55 + 0.45 * Math.sin(Date.now() / 220);
    return 1 - age / (10 * 60000) * 0.6;
  }

  // ---------------------------------------------------------------------------------------------
  // WebGL2 renderer

  const dirty = { pos: true, style: true };
  let gl = null;
  let prog = null;
  let ctx2d = null;
  let glowing = false;

  const EDGE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_seg;
layout(location=2) in float a_width;
layout(location=3) in vec4 a_color;
uniform vec2 u_res;
uniform vec3 u_cam;
out vec4 v_color;
out float v_side;
out float v_w;
void main() {
  vec2 p1 = a_seg.xy * u_cam.x + u_cam.yz;
  vec2 p2 = a_seg.zw * u_cam.x + u_cam.yz;
  vec2 d = p2 - p1;
  float len = length(d);
  vec2 dir = len > 0.0001 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float w = a_width + 1.0;
  vec2 p = mix(p1, p2, a_corner.x) + nrm * a_corner.y * w * 0.5;
  vec2 clip = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
  v_side = a_corner.y;
  v_w = w;
}`;
  const EDGE_FS = `#version 300 es
precision mediump float;
in vec4 v_color;
in float v_side;
in float v_w;
out vec4 o;
void main() {
  float a = clamp((1.0 - abs(v_side)) * v_w * 0.5, 0.0, 1.0) * v_color.a;
  o = vec4(v_color.rgb * a, a);
}`;
  const NODE_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec2 a_pos;
layout(location=2) in float a_r;
layout(location=3) in vec4 a_color;
uniform vec2 u_res;
uniform vec3 u_cam;
uniform float u_minpx;
uniform float u_scale;
out vec2 v_uv;
out vec4 v_color;
out float v_rpx;
void main() {
  vec2 c = a_pos * u_cam.x + u_cam.yz;
  float rpx = max(a_r * u_cam.x * u_scale, u_minpx);
  float ext = rpx + 1.5;
  vec2 p = c + a_corner * ext;
  vec2 clip = p / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = a_corner * ext;
  v_color = a_color;
  v_rpx = rpx;
}`;
  const NODE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
in vec4 v_color;
in float v_rpx;
uniform int u_mode;
out vec4 o;
void main() {
  float d = length(v_uv);
  float a;
  if (u_mode == 1) {
    a = clamp(1.0 - d / v_rpx, 0.0, 1.0);
    a = a * a;
  } else {
    a = clamp(v_rpx - d + 0.5, 0.0, 1.0);
  }
  a *= v_color.a;
  if (a <= 0.002) discard;
  o = vec4(v_color.rgb * a, a);
}`;

  function compile(vs, fs) {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      gl.attachShader(p, s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'program');
    const u = {};
    for (const name of ['u_res', 'u_cam', 'u_minpx', 'u_scale', 'u_mode']) u[name] = gl.getUniformLocation(p, name);
    return { p, u };
  }
  function makeVao(corners, a1Size, buffers) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const cb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(corners), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    buffers.geo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.geo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, a1Size, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    buffers.style = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.style);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, 20, 4);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    buffers.vao = vao;
    return buffers;
  }
  function initGL() {
    if (flags.has('2d')) return false;
    try {
      gl = glCanvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: flags.has('keep') });
    } catch {
      gl = null;
    }
    if (!gl) return false;
    try {
      prog = {
        edge: compile(EDGE_VS, EDGE_FS),
        node: compile(NODE_VS, NODE_FS),
      };
      prog.edges = makeVao([0, -1, 1, -1, 0, 1, 1, 1], 4, {});
      prog.nodes = makeVao([-1, -1, 1, -1, -1, 1, 1, 1], 2, {});
      prog.glow = makeVao([-1, -1, 1, -1, -1, 1, 1, 1], 2, {});
    } catch {
      gl = null;
      return false;
    }
    glCanvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    glCanvas.addEventListener('webglcontextrestored', () => {
      initGL();
      dirty.pos = dirty.style = true;
      request();
    });
    return true;
  }

  let edgeStyle = new Float32Array(0), nodeStyle = new Float32Array(0), glowPos = new Float32Array(0), glowStyle = new Float32Array(0), glowCount = 0;
  function buildStyles() {
    const f = focus();
    const m = vis.length, E = edgeS.length;
    nodeStyle = new Float32Array(5 * m);
    for (let i = 0; i < m; i++) {
      const g = groups.get(groupOf[i]);
      const c = g ? g.color : theme.muted;
      const a = f && !f.set.has(i) ? 0.16 : 1;
      nodeStyle.set([radius[i], c[0], c[1], c[2], a], 5 * i);
    }
    edgeStyle = new Float32Array(5 * E);
    const widthMul = settings.linkWidth * dpr;
    for (let e = 0; e < E; e++) {
      const s = edgeS[e], d = edgeT[e];
      let c = theme.edge, a = theme.edge[3] * (0.55 + 0.45 * Math.min(1, edgeW[e]));
      let w = clamp(0.5 + 0.6 * Math.log2(1 + 3 * edgeW[e]), 0.5, 4) * widthMul;
      if (f) {
        if (f.centre >= 0 && (s === f.centre || d === f.centre)) {
          c = theme.edgeHi;
          a = 0.9;
          w += 0.6 * dpr;
        } else if (f.centre < 0 && f.set.has(s) && f.set.has(d)) {
          a = Math.min(1, a * 1.6);
        } else {
          a *= 0.18;
        }
      }
      edgeStyle.set([w, c[0], c[1], c[2], a], 5 * e);
    }
    dirty.style = false;
    dirty.glow = true;
  }
  function buildGlow() {
    const list = [];
    let animate = false;
    for (let i = 0; i < vis.length; i++) {
      const g = nowGlow(i);
      if (g > 0) {
        list.push([i, g]);
        if (Date.now() - Date.parse(nodes[vis[i]].last) < 60000) animate = true;
      }
    }
    const sel = selected >= 0 ? viewOf[selected] : -1;
    glowPos = new Float32Array(2 * (list.length + (sel >= 0 ? 1 : 0)));
    glowStyle = new Float32Array(5 * (list.length + (sel >= 0 ? 1 : 0)));
    let k = 0;
    for (const [i, g] of list) {
      glowPos.set([pos[2 * i], pos[2 * i + 1]], 2 * k);
      glowStyle.set([radius[i], theme.glow[0], theme.glow[1], theme.glow[2], 0.75 * g], 5 * k);
      k++;
    }
    if (sel >= 0) {
      glowPos.set([pos[2 * sel], pos[2 * sel + 1]], 2 * k);
      glowStyle.set([radius[sel], theme.edgeHi[0], theme.edgeHi[1], theme.edgeHi[2], 0.85], 5 * k);
      k++;
    }
    glowCount = k;
    glowing = animate;
    dirty.glow = false;
  }

  function drawGL() {
    const E = edgeS.length, m = vis.length;
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clearColor(theme.bg[0], theme.bg[1], theme.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const camU = [cam.k * dpr, (W / 2 - cam.x * cam.k) * dpr, (H / 2 - cam.y * cam.k) * dpr];
    if (dirty.pos) {
      const seg = new Float32Array(4 * E);
      for (let e = 0; e < E; e++) {
        const s = edgeS[e], d = edgeT[e];
        seg[4 * e] = pos[2 * s];
        seg[4 * e + 1] = pos[2 * s + 1];
        seg[4 * e + 2] = pos[2 * d];
        seg[4 * e + 3] = pos[2 * d + 1];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.edges.geo);
      gl.bufferData(gl.ARRAY_BUFFER, seg, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.nodes.geo);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    }
    if (dirty.styleUpload) {
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.edges.style);
      gl.bufferData(gl.ARRAY_BUFFER, edgeStyle, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, prog.nodes.style);
      gl.bufferData(gl.ARRAY_BUFFER, nodeStyle, gl.DYNAMIC_DRAW);
      dirty.styleUpload = false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, prog.glow.geo);
    gl.bufferData(gl.ARRAY_BUFFER, glowPos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, prog.glow.style);
    gl.bufferData(gl.ARRAY_BUFFER, glowStyle, gl.DYNAMIC_DRAW);

    if (E) {
      gl.useProgram(prog.edge.p);
      gl.uniform2f(prog.edge.u.u_res, glCanvas.width, glCanvas.height);
      gl.uniform3f(prog.edge.u.u_cam, camU[0], camU[1], camU[2]);
      gl.bindVertexArray(prog.edges.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, E);
    }
    gl.useProgram(prog.node.p);
    gl.uniform2f(prog.node.u.u_res, glCanvas.width, glCanvas.height);
    gl.uniform3f(prog.node.u.u_cam, camU[0], camU[1], camU[2]);
    if (glowCount) {
      gl.uniform1f(prog.node.u.u_minpx, 7 * dpr);
      gl.uniform1f(prog.node.u.u_scale, 2.4);
      gl.uniform1i(prog.node.u.u_mode, 1);
      gl.bindVertexArray(prog.glow.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glowCount);
    }
    if (m) {
      gl.uniform1f(prog.node.u.u_minpx, 1.6 * dpr);
      gl.uniform1f(prog.node.u.u_scale, 1);
      gl.uniform1i(prog.node.u.u_mode, 0);
      gl.bindVertexArray(prog.nodes.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m);
    }
    gl.bindVertexArray(null);
  }

  /** The simpler drawing without WebGL2: the same picture, slower for big graphs. */
  function draw2d() {
    const c = ctx2d;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = css(theme.bg);
    c.fillRect(0, 0, glCanvas.width, glCanvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let e = 0; e < edgeS.length; e++) {
      const s = edgeS[e], d = edgeT[e], st = 5 * e;
      c.strokeStyle = css([edgeStyle[st + 1], edgeStyle[st + 2], edgeStyle[st + 3]], edgeStyle[st + 4]);
      c.lineWidth = edgeStyle[st] / dpr;
      c.beginPath();
      c.moveTo(sx(pos[2 * s]), sy(pos[2 * s + 1]));
      c.lineTo(sx(pos[2 * d]), sy(pos[2 * d + 1]));
      c.stroke();
    }
    for (let k = 0; k < glowCount; k++) {
      const st = 5 * k;
      c.fillStyle = css([glowStyle[st + 1], glowStyle[st + 2], glowStyle[st + 3]], glowStyle[st + 4] * 0.35);
      c.beginPath();
      c.arc(sx(glowPos[2 * k]), sy(glowPos[2 * k + 1]), Math.max(7, glowStyle[st] * cam.k * 2.4), 0, 2 * Math.PI);
      c.fill();
    }
    for (let i = 0; i < vis.length; i++) {
      const st = 5 * i;
      c.fillStyle = css([nodeStyle[st + 1], nodeStyle[st + 2], nodeStyle[st + 3]], nodeStyle[st + 4]);
      c.beginPath();
      c.arc(sx(pos[2 * i]), sy(pos[2 * i + 1]), Math.max(1.6, radius[i] * cam.k), 0, 2 * Math.PI);
      c.fill();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Labels

  function drawLabels() {
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
    lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!vis.length) return;
    const f = focus();
    // Labels from this many pixels of dot radius on (the slider moves it from 2 to 10).
    const minPx = 2 + 8 * settings.labels;
    const forced = new Set();
    if (f && f.centre >= 0) for (const i of f.set) forced.add(i);
    if (f && f.centre < 0 && f.set.size <= 40) for (const i of f.set) forced.add(i);
    const cand = [];
    for (let i = 0; i < vis.length; i++) {
      const x = sx(pos[2 * i]), y = sy(pos[2 * i + 1]);
      if (x < -200 || x > W + 200 || y < -40 || y > H + 40) continue;
      const rpx = radius[i] * cam.k;
      const must = forced.has(i);
      const a = must ? 1 : clamp((rpx - minPx) / 4, 0, 1);
      if (a <= 0) continue;
      cand.push([must ? 1e9 + rpx : rpx, i, x, y, rpx, a]);
    }
    cand.sort((p, q) => q[0] - p[0]);
    const cellW = 90, cellH = 16, taken = new Set();
    let drawn = 0;
    lctx.textAlign = 'center';
    lctx.textBaseline = 'top';
    lctx.lineJoin = 'round';
    for (const [, i, x, y, rpx, a] of cand) {
      if (drawn >= 350) break;
      const text = nodes[vis[i]].title;
      const ty = y + Math.max(rpx, 1.6) + 3;
      const big = forced.has(i);
      lctx.font = `${big ? 600 : 400} ${big ? 13 : 12}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const w = Math.min(lctx.measureText(text).width, 260);
      const c0 = Math.floor((x - w / 2) / cellW), c1 = Math.floor((x + w / 2) / cellW), row = Math.floor(ty / cellH);
      let free = true;
      if (!big) for (let c = c0; c <= c1 && free; c++) if (taken.has(`${c},${row}`)) free = false;
      if (!free) continue;
      for (let c = c0; c <= c1; c++) taken.add(`${c},${row}`);
      const dim = f && !f.set.has(i) ? 0.25 : 1;
      lctx.globalAlpha = a * dim;
      lctx.strokeStyle = theme.halo;
      lctx.lineWidth = 3;
      const shown = w < lctx.measureText(text).width ? `${text.slice(0, Math.max(4, Math.floor(text.length * w / lctx.measureText(text).width) - 1))}…` : text;
      lctx.strokeText(shown, x, ty);
      lctx.fillStyle = theme.label;
      lctx.fillText(shown, x, ty);
      drawn++;
    }
    lctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------------------------
  // The frame loop: draws only when something changed

  let queued = false;
  function request() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  }
  function frame() {
    queued = false;
    if (!theme || !data || (!gl && !ctx2d)) return;
    if (autoFit && vis.length && layoutAlpha > 0.02) fit(null, false);
    if (goal.on) {
      const e = motion ? 0.2 : 1;
      cam.x += (goal.x - cam.x) * e;
      cam.y += (goal.y - cam.y) * e;
      cam.k *= Math.pow(goal.k / cam.k, e);
      if (Math.abs(goal.k / cam.k - 1) < 0.002 && Math.abs(goal.x - cam.x) * cam.k < 0.5 && Math.abs(goal.y - cam.y) * cam.k < 0.5) {
        Object.assign(cam, { x: goal.x, y: goal.y, k: goal.k });
        goal.on = false;
      }
    }
    if (dirty.style) {
      buildStyles();
      dirty.styleUpload = true;
    }
    buildGlow();
    if (gl) drawGL();
    else draw2d();
    dirty.pos = false;
    drawLabels();
    if (goal.on || glowing || (autoFit && layoutAlpha > 0.02)) request();
  }

  // ---------------------------------------------------------------------------------------------
  // Pointer, wheel and keys

  function hit(px, py) {
    let best = -1, bestD = Infinity;
    const x = wx(px), y = wy(py);
    for (let i = 0; i < vis.length; i++) {
      const dx = pos[2 * i] - x, dy = pos[2 * i + 1] - y;
      const r = Math.max(radius[i], 7 / cam.k);
      const d = dx * dx + dy * dy;
      if (d <= r * r && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }
  const pointers = new Map();
  let down = null;       // {x, y, node, moved}
  let dragging = -1;     // view index
  let dragAt = null;
  let pinch = null;
  labelCanvas.addEventListener('pointerdown', (e) => {
    labelCanvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: cam.k };
      down = null;
      return;
    }
    down = { x: e.clientX, y: e.clientY, node: hit(e.clientX, e.clientY), moved: false, cx: cam.x, cy: cam.y };
  });
  labelCanvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (pinch.k * d) / pinch.d / cam.k);
      return;
    }
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && dx * dx + dy * dy > 16) down.moved = true;
      if (!down.moved) return;
      if (down.node >= 0) {
        if (dragging < 0) {
          dragging = down.node;
          labelCanvas.classList.add('dragging');
        }
        dragAt = [wx(e.clientX), wy(e.clientY)];
        pos[2 * dragging] = dragAt[0];
        pos[2 * dragging + 1] = dragAt[1];
        if (worker) worker.postMessage({ type: 'drag', i: dragging, x: dragAt[0], y: dragAt[1] });
        dirty.pos = true;
        request();
      } else {
        cam.x = down.cx - dx / cam.k;
        cam.y = down.cy - dy / cam.k;
        goal.on = false;
        autoFit = false;
        labelCanvas.classList.add('dragging');
        request();
      }
      return;
    }
    const h = hit(e.clientX, e.clientY);
    if (h !== hover) {
      hover = h;
      labelCanvas.classList.toggle('over-node', h >= 0);
      dirty.style = true;
      request();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!down) return;
    if (!down.moved) {
      if (down.node >= 0) openInfo(vis[down.node]);
      else closeInfo();
    }
    if (dragging >= 0 && worker) worker.postMessage({ type: 'release', i: dragging });
    dragging = -1;
    dragAt = null;
    down = null;
    labelCanvas.classList.remove('dragging');
  };
  labelCanvas.addEventListener('pointerup', endPointer);
  labelCanvas.addEventListener('pointercancel', endPointer);
  labelCanvas.addEventListener('pointerleave', () => {
    if (!down && hover >= 0) {
      hover = -1;
      dirty.style = true;
      request();
    }
  });
  labelCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dy = e.deltaY * unit * (e.ctrlKey ? 3 : 1);
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
  }, { passive: false });
  labelCanvas.addEventListener('dblclick', (e) => {
    const h = hit(e.clientX, e.clientY);
    if (h >= 0) {
      Object.assign(goal, { x: pos[2 * h], y: pos[2 * h + 1], k: Math.max(cam.k, 1.2), on: true });
      autoFit = false;
      request();
    } else {
      autoFit = true;
      fit(null, false);
    }
  });
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      $('search').focus();
    } else if ((e.key === 'f' || e.key === 'F') && !typing && !e.ctrlKey && !e.metaKey) {
      autoFit = true;
      fit(null, false);
    } else if (e.key === 'Escape') {
      if (typing && $('search').value) {
        $('search').value = '';
        updateMatches();
      } else if (localView) {
        setLocal(null);
      } else {
        closeInfo();
      }
      if (typing) e.target.blur();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Panels

  function applyLabels() {
    // Until the data file brings the words, only the notice shows.
    $('bar').hidden = !data;
    $('status').hidden = !data;
    for (const el of document.querySelectorAll('[data-l]')) el.textContent = t(el.getAttribute('data-l'));
    for (const el of document.querySelectorAll('[data-lp]')) el.setAttribute('placeholder', t(el.getAttribute('data-lp')));
    for (const el of document.querySelectorAll('[data-la]')) el.setAttribute('aria-label', t(el.getAttribute('data-la')));
    labelCanvas.setAttribute('aria-label', t('title'));
    document.title = data ? `${t('title')} · ${data.vault}` : t('title');
  }
  function syncControls() {
    for (const el of document.querySelectorAll('[data-s]')) {
      const key = el.getAttribute('data-s');
      if (el.type === 'checkbox') el.checked = Boolean(settings[key]);
      else el.value = String(settings[key]);
    }
    $('color-by').value = settings.colorBy;
    $('controls').hidden = !settings.open;
    $('toggle').setAttribute('aria-expanded', String(settings.open));
  }
  const FILTERS = new Set(['orphans', 'journal', 'inbox', 'archive', 'sectors', 'missing', 'nodeSize']);
  const FORCES = new Set(['center', 'repel', 'linkForce', 'linkDistance']);
  for (const el of document.querySelectorAll('[data-s]')) {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      const key = el.getAttribute('data-s');
      settings[key] = el.type === 'checkbox' ? el.checked : Number(el.value);
      saveSettings();
      if (FILTERS.has(key)) rebuildView({ refit: key !== 'nodeSize' });
      else if (FORCES.has(key)) {
        if (worker) worker.postMessage({ type: 'params', params: physics() });
      } else {
        dirty.style = true;
        request();
      }
    });
  }
  $('color-by').addEventListener('change', (e) => {
    settings.colorBy = e.target.value;
    saveSettings();
    legendPick = null;
    restyleGroups();
    renderLegend();
    dirty.style = true;
    request();
  });
  $('toggle').addEventListener('click', () => {
    settings.open = !settings.open;
    saveSettings();
    syncControls();
  });
  $('fit').addEventListener('click', () => {
    autoFit = true;
    fit(null, false);
  });
  $('reset').addEventListener('click', () => {
    settings = Object.assign({}, DEFAULT_SETTINGS, { open: settings.open });
    saveSettings();
    syncControls();
    if (worker) worker.postMessage({ type: 'params', params: physics() });
    rebuildView();
  });

  function renderLegend() {
    const ul = $('legend');
    ul.textContent = '';
    const list = [...groups.entries()].sort((a, b) => a[1].order - b[1].order || (a[1].label < b[1].label ? -1 : 1));
    for (const [key, g] of list) {
      const li = document.createElement('li');
      li.classList.toggle('on', legendPick === key);
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = css(g.color);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.label;
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = String(g.count);
      li.append(sw, name, n);
      li.addEventListener('click', () => {
        legendPick = legendPick === key ? null : key;
        renderLegend();
        dirty.style = true;
        request();
      });
      ul.appendChild(li);
    }
  }

  function updateMatches() {
    const q = fold($('search').value.trim());
    matches = [];
    if (q.length >= 2) {
      for (let i = 0; i < vis.length; i++) {
        const v = nodes[vis[i]];
        if (fold(v.title).includes(q) || fold(v.name).includes(q)) matches.push(i);
      }
    }
    $('matches').textContent = q.length >= 2 ? t('matches', { n: matches.length }) : '';
    dirty.style = true;
    request();
  }
  $('search').addEventListener('input', updateMatches);
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches.length) {
      const i = matches[0];
      openInfo(vis[i]);
      Object.assign(goal, { x: pos[2 * i], y: pos[2 * i + 1], k: Math.max(cam.k, 1), on: true });
      autoFit = false;
      request();
    }
  });

  function chip(text, color) {
    const s = document.createElement('span');
    s.className = color ? 'chip dot' : 'chip';
    if (color) s.style.setProperty('--c', css(color));
    s.textContent = text;
    return s;
  }
  function linkList(ul, items) {
    ul.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = t('no_links');
      ul.appendChild(li);
      return;
    }
    items.sort((a, b) => a[1] - b[1] || (nodes[a[0]].title < nodes[b[0]].title ? -1 : 1));
    for (const [j, k] of items.slice(0, 200)) {
      const li = document.createElement('li');
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = t(`kind_${kinds[k] ? kinds[k].id : 'link'}`);
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = nodes[j].title;
      b.title = nodes[j].rel || nodes[j].title;
      b.addEventListener('click', () => {
        openInfo(j);
        const v = viewOf[j];
        if (v >= 0) {
          Object.assign(goal, { x: pos[2 * v], y: pos[2 * v + 1], k: Math.max(cam.k, 0.8), on: true });
          autoFit = false;
          request();
        }
      });
      li.append(kind, b);
      ul.appendChild(li);
    }
  }
  function openInfo(i) {
    selected = i;
    const v = nodes[i];
    $('info').hidden = false;
    $('info-title').textContent = v.title;
    const chips = $('info-chips');
    chips.textContent = '';
    const g = groups.get(groupKey(v));
    if (v.missing) chips.appendChild(chip(L.missing, theme.missing));
    // A journal entry says so once, with the sector chip's colour below.
    if (v.type && v.type !== 'journal') chips.appendChild(chip((data.types || {})[v.type] || v.type, settings.colorBy === 'type' && g ? g.color : null));
    if (v.status) chips.appendChild(chip((data.statuses || {})[v.status] || v.status, settings.colorBy === 'status' && g ? g.color : null));
    if (v.sector) {
      const s = (data.sectors || []).find((x) => x.id === v.sector);
      chips.appendChild(chip(s ? s.title : v.sector, settings.colorBy === 'sector' && g ? g.color : null));
    } else if (v.area === 'journal' || v.area === 'inbox') {
      chips.appendChild(chip(L[v.area], settings.colorBy === 'sector' && g ? g.color : null));
    }
    if (v.local) chips.appendChild(chip(L.local));
    if (v.archived) chips.appendChild(chip(L.archived));
    if (v.used) chips.appendChild(chip(t('used', { n: v.used })));
    if (v.updated) chips.appendChild(chip(t('updated', { date: v.updated })));
    // Wiki links read as their names: [[rozsah-balicku|Rozsah]] → Rozsah.
    const plain = (s) => String(s || '').replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, name, alias) => alias || name);
    $('info-desc').textContent = plain(v.description);
    $('info-desc').hidden = !v.description;
    $('info-lead').textContent = v.lead && v.lead !== v.description ? plain(v.lead) : '';
    $('info-lead').hidden = !$('info-lead').textContent;
    $('info-path').hidden = !v.rel;
    $('info-path').querySelector('code').textContent = v.rel || '';
    $('local').textContent = localView && localView.id === v.id ? t('whole_graph') : t('local_graph');
    linkList($('info-out'), out[i].slice());
    linkList($('info-in'), inc[i].slice());
    dirty.style = true;
    request();
  }
  function closeInfo() {
    if (selected < 0 && $('info').hidden) return;
    selected = -1;
    $('info').hidden = true;
    dirty.style = true;
    request();
  }
  $('info-close').addEventListener('click', closeInfo);
  $('copy').addEventListener('click', () => {
    const text = $('info-path').querySelector('code').textContent;
    const done = () => {
      $('copy').textContent = t('copied');
      setTimeout(() => ($('copy').textContent = t('copy_path')), 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(done, () => selectPath());
    } catch {
      selectPath();
    }
  });
  function selectPath() {
    const range = document.createRange();
    range.selectNodeContents($('info-path').querySelector('code'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  function setLocal(id) {
    localView = id ? { id, depth: Number($('depth').value) || 1 } : null;
    rebuildView();
    if (selected >= 0) openInfo(selected);
  }
  $('local').addEventListener('click', () => {
    if (selected < 0) return;
    const id = nodes[selected].id;
    setLocal(localView && localView.id === id ? null : id);
  });
  $('depth').addEventListener('change', () => {
    if (localView) setLocal(localView.id);
  });

  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 90) return t('ago_s', { n: s });
    if (s < 5400) return t('ago_min', { n: Math.round(s / 60) });
    return t('ago_h', { n: Math.round(s / 3600) });
  }
  function renderTicker() {
    const box = $('ticker');
    const recent = (data && data.recent) || [];
    const fresh = recent.filter((r) => Date.now() - Date.parse(r.t) < 3600000).slice(-6).reverse();
    box.hidden = !fresh.length;
    box.textContent = '';
    if (!fresh.length) return;
    const head = document.createElement('li');
    head.className = 'head';
    head.textContent = t('recent');
    box.appendChild(head);
    for (const r of fresh) {
      const li = document.createElement('li');
      const who = r.agent ? AGENTS[r.agent] || r.agent : 'CLI';
      const what = t(`op_${r.op}`);
      const titles = (r.notes || []).map((i) => (nodes[i] ? nodes[i].title : '')).filter(Boolean).slice(0, 2).join(', ');
      li.textContent = [ago(r.t), r.via === 'mcp' ? `${who} (MCP)` : who, what, titles].filter(Boolean).join(' · ');
      box.appendChild(li);
    }
  }
  function renderStatus() {
    if (!data) return;
    const date = new Date(data.generated);
    const when = Number.isNaN(date.getTime()) ? '' : date.toLocaleString(data.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' });
    $('stats').textContent = t('stats', { notes: vis.length, links: edgeS.length, date: when });
    const live = $('live');
    live.hidden = !wasLive;
    live.classList.toggle('off', !data.live);
    live.textContent = data.live ? t('live') : t('stopped');
  }
  let noticeTimer = 0;
  function notice(text, toast) {
    const p = $('notice');
    p.textContent = text || '';
    p.hidden = !text;
    p.classList.toggle('toast', Boolean(toast));
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    if (text && toast) {
      noticeTimer = setTimeout(() => {
        p.hidden = true;
        noticeTimer = 0;
      }, 6000);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Data in: the first call draws, later calls (live mode) merge

  let wasLive = false;
  let pollTimer = 0;
  const dataSrc = 'graph-data.js';
  function poll() {
    pollTimer = 0;
    const s = document.createElement('script');
    s.src = `${dataSrc}?t=${Date.now()}`;
    const next = () => {
      s.remove();
      schedulePoll();
    };
    s.onload = next;
    s.onerror = next;
    document.body.appendChild(s);
  }
  function schedulePoll() {
    if (!pollTimer && data && data.live) pollTimer = setTimeout(poll, Math.max(500, Number(data.refresh) || 1500));
  }

  window.memoryGraph = function memoryGraph(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.nodes)) return;
    const first = !data;
    if (!first && d.hash === data.hash) {
      data.live = d.live;
      data.generated = d.generated;
      renderStatus();
      schedulePoll();
      return;
    }
    L = Object.assign({}, L, d.labels || {});
    if (d.lang) document.documentElement.lang = d.lang;
    if (first) {
      // Places the data file brings (a settled layout) come first, then the ones this browser kept.
      for (const source of [d.positions, store.get(`pos:${d.vault}:${d.local ? 1 : 0}`, null)]) {
        if (!source || typeof source !== 'object') continue;
        for (const [id, p] of Object.entries(source)) if (Array.isArray(p) && p.length === 2 && !posCache.has(id)) posCache.set(id, p);
      }
    } else {
      rememberPositions(false);
    }
    const selectedId = selected >= 0 && nodes[selected] ? nodes[selected].id : null;
    if (d.live) wasLive = true;
    prepare(d);
    applyLabels();
    syncControls();
    if (first) setupRenderer();
    selected = selectedId ? nodes.findIndex((v) => v.id === selectedId) : -1;
    rebuildView({ refit: first });
    if (selected >= 0) openInfo(selected);
    else closeInfo();
    renderTicker();
    if (!nodes.length) notice(t('empty'));
    else if (!noticeTimer) notice('');
    schedulePoll();
    // The first picture right away, not a frame later.
    if (first) frame();
  };

  function setupRenderer() {
    if (!initGL()) {
      ctx2d = glCanvas.getContext('2d');
      notice(t('no_webgl'), true);
    }
  }

  readTheme();
  resize();
  window.addEventListener('resize', resize);
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      readTheme();
      if (data) {
        restyleGroups();
        renderLegend();
      }
      dirty.style = true;
      request();
    });
  } catch {
    /* an older browser keeps the first colours */
  }
  setInterval(() => {
    if (!data) return;
    renderTicker();
    if (glowing || (data.recent || []).length) request();
  }, 5000);
  applyLabels();
  syncControls();
  // Shown until the data file calls memoryGraph(); a missing file never calls it.
  setTimeout(() => {
    if (!data) notice(t('waiting'));
  }, 1500);
})();
