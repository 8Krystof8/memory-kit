/* memory-kit graph layout: a force simulation in a Web Worker, d3-force style (velocity decay 0.4,
   alpha cooling over about 300 ticks), on typed arrays: Barnes-Hut many-body repulsion over a
   quadtree, link springs whose strength follows the link's weight, a pull toward the middle, and a
   collision pass so dots never overlap. The page starts it from this text as a classic Blob
   worker (a file:// page can start no other kind).
   In:  init {gen, n, src, dst, w, r, pos, alpha, params} · params {params} · drag {i, x, y}
        release {i} · reheat {alpha} · stop
   Out: pos {gen, pos: Float32Array [x0, y0, x1, y1, ...], alpha} · idle {gen}
   gen is the page's number of the graph it sent, so it can drop answers about an older one. */
(function () {
  'use strict';
  var n = 0, E = 0;
  var X, Y, VX, VY, FX, FY, R;
  var SRC, DST, K, BIAS, DIST, WRAW, WBASE;
  var P = { charge: -1000, distance: 250, link: 1, gravity: 0.05, theta: 0.9, distanceMin: 30, pad: 4, decay: 0.4 };
  var alpha = 1, alphaTarget = 0;
  var ALPHA_MIN = 0.001, ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
  var timer = 0, running = false, lastPost = 0, gen = 0;

  // Quadtree in flat arrays: mass, centre of mass, cell width and centre, first child, point range.
  var cap = 0, TM, TX, TY, TW, TCX, TCY, TC, TA, TB, IDX, TMP;
  var STACK = new Int32Array(4096), BSTACK = new Int32Array(8192), CNT = new Int32Array(4), OFF = new Int32Array(4);

  function grow(min) {
    var next = Math.max(min, cap * 2, 64);
    function g(A, T) { var b = new T(next); if (A) b.set(A.subarray(0, cap)); return b; }
    TM = g(TM, Float64Array); TX = g(TX, Float64Array); TY = g(TY, Float64Array); TW = g(TW, Float64Array);
    TCX = g(TCX, Float64Array); TCY = g(TCY, Float64Array);
    TC = g(TC, Int32Array); TA = g(TA, Int32Array); TB = g(TB, Int32Array);
    cap = next;
  }

  function build() {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i, k;
    for (i = 0; i < n; i++) {
      IDX[i] = i;
      var a = X[i], b = Y[i];
      if (a < minX) minX = a; if (a > maxX) maxX = a;
      if (b < minY) minY = b; if (b > maxY) maxY = b;
    }
    if (cap < 64) grow(64);
    TCX[0] = (minX + maxX) / 2; TCY[0] = (minY + maxY) / 2;
    TW[0] = Math.max(maxX - minX, maxY - minY, 1e-3) * 1.0001;
    TA[0] = 0; TB[0] = n;
    var nodes = 1, sp = 0;
    BSTACK[sp++] = 0; BSTACK[sp++] = 0;
    while (sp > 0) {
      var depth = BSTACK[--sp], nd = BSTACK[--sp];
      var lo = TA[nd], hi = TB[nd], m = hi - lo, sx = 0, sy = 0;
      for (k = lo; k < hi; k++) { var j = IDX[k]; sx += X[j]; sy += Y[j]; }
      TM[nd] = m; TX[nd] = sx / m; TY[nd] = sy / m; TC[nd] = -1;
      if (m <= 8 || depth >= 22) continue;
      var cx = TCX[nd], cy = TCY[nd], half = TW[nd] / 2, q = half / 2;
      CNT[0] = CNT[1] = CNT[2] = CNT[3] = 0;
      for (k = lo; k < hi; k++) { var p = IDX[k]; CNT[(X[p] >= cx ? 1 : 0) + (Y[p] >= cy ? 2 : 0)]++; }
      OFF[0] = lo; OFF[1] = lo + CNT[0]; OFF[2] = OFF[1] + CNT[1]; OFF[3] = OFF[2] + CNT[2];
      for (k = lo; k < hi; k++) { var t = IDX[k]; TMP[OFF[(X[t] >= cx ? 1 : 0) + (Y[t] >= cy ? 2 : 0)]++] = t; }
      for (k = lo; k < hi; k++) IDX[k] = TMP[k];
      if (nodes + 4 > cap) grow(nodes + 4);
      var first = nodes; nodes += 4; TC[nd] = first;
      var s = lo;
      for (var c = 0; c < 4; c++) {
        var ch = first + c, e = s + CNT[c];
        TA[ch] = s; TB[ch] = e; TW[ch] = half;
        TCX[ch] = cx + ((c & 1) ? q : -q); TCY[ch] = cy + ((c & 2) ? q : -q);
        if (CNT[c] > 0) {
          if (sp + 2 > BSTACK.length) { var nb = new Int32Array(BSTACK.length * 2); nb.set(BSTACK); BSTACK = nb; }
          BSTACK[sp++] = ch; BSTACK[sp++] = depth + 1;
        } else { TM[ch] = 0; TC[ch] = -1; }
        s = e;
      }
    }
  }

  function manyBody(a) {
    var theta2 = P.theta * P.theta, str = P.charge * a, dmin2 = P.distanceMin * P.distanceMin;
    for (var i = 0; i < n; i++) {
      var xi = X[i], yi = Y[i], fx = 0, fy = 0, sp = 0, dx, dy, d2, w;
      STACK[sp++] = 0;
      while (sp > 0) {
        var nd = STACK[--sp], m = TM[nd];
        if (m === 0) continue;
        var c = TC[nd];
        if (c < 0) {
          for (var k = TA[nd], e = TB[nd]; k < e; k++) {
            var j = IDX[k];
            if (j === i) continue;
            dx = X[j] - xi; dy = Y[j] - yi;
            if (dx === 0 && dy === 0) { dx = ((i * 7 + j) % 13 - 6) * 1e-3; dy = ((i * 3 + j) % 11 - 5) * 1e-3; }
            d2 = dx * dx + dy * dy;
            if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
            w = str / d2; fx += dx * w; fy += dy * w;
          }
        } else {
          dx = TX[nd] - xi; dy = TY[nd] - yi; d2 = dx * dx + dy * dy;
          var W = TW[nd];
          if (W * W < theta2 * d2) {
            if (d2 < dmin2) d2 = Math.sqrt(dmin2 * d2);
            w = str * m / d2; fx += dx * w; fy += dy * w;
          } else {
            if (sp + 4 > STACK.length) { var ns = new Int32Array(STACK.length * 2); ns.set(STACK); STACK = ns; }
            STACK[sp++] = c; STACK[sp++] = c + 1; STACK[sp++] = c + 2; STACK[sp++] = c + 3;
          }
        }
      }
      VX[i] += fx; VY[i] += fy;
    }
  }

  function links(a) {
    for (var e = 0; e < E; e++) {
      var s = SRC[e], t = DST[e];
      var dx = X[t] + VX[t] - X[s] - VX[s], dy = Y[t] + VY[t] - Y[s] - VY[s];
      var l = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      l = (l - DIST[e]) / l * a * K[e];
      dx *= l; dy *= l;
      var b = BIAS[e];
      VX[t] -= dx * b; VY[t] -= dy * b;
      VX[s] += dx * (1 - b); VY[s] += dy * (1 - b);
    }
  }

  // Collision: a spatial hash in typed arrays (cell = the largest diameter), each pair once.
  var HEAD = null, NEXT = null, CELLX = null, CELLY = null, MASK = 0, SEEN = new Int32Array(9);
  function hashCell(cx, cy) {
    var h = Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy + 0x7f4a7c15, 0x85ebca77);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return h & MASK;
  }
  function collide() {
    var maxR = 0, i;
    for (i = 0; i < n; i++) if (R[i] > maxR) maxR = R[i];
    var inv = 1 / (2 * maxR + P.pad);
    HEAD.fill(-1);
    for (i = 0; i < n; i++) {
      var cx = Math.floor(X[i] * inv), cy = Math.floor(Y[i] * inv);
      CELLX[i] = cx; CELLY[i] = cy;
      var h = hashCell(cx, cy);
      NEXT[i] = HEAD[h]; HEAD[h] = i;
    }
    for (i = 0; i < n; i++) {
      var gx = CELLX[i], gy = CELLY[i], ri = R[i] + P.pad / 2, seen = 0;
      for (var ax = -1; ax <= 1; ax++) {
        for (var ay = -1; ay <= 1; ay++) {
          var bucket = hashCell(gx + ax, gy + ay), dup = false;
          for (var q = 0; q < seen; q++) if (SEEN[q] === bucket) { dup = true; break; }
          if (dup) continue;
          SEEN[seen++] = bucket;
          for (var j = HEAD[bucket]; j !== -1; j = NEXT[j]) {
            if (j <= i) continue;
            var dx = X[i] + VX[i] - X[j] - VX[j], dy = Y[i] + VY[i] - Y[j] - VY[j];
            var rr = ri + R[j] + P.pad / 2, d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr) continue;
            var d = Math.sqrt(d2);
            if (d === 0) { dx = ((i - j) % 2 ? 1 : -1) * 0.01; dy = 0.01; d = 0.0141; }
            var f = (rr - d) / d * 0.5, wi = R[j] * R[j], wj = R[i] * R[i], ws = wi + wj || 1;
            VX[i] += dx * f * (wi / ws); VY[i] += dy * f * (wi / ws);
            VX[j] -= dx * f * (wj / ws); VY[j] -= dy * f * (wj / ws);
          }
        }
      }
    }
  }

  function tick() {
    alpha += (alphaTarget - alpha) * ALPHA_DECAY;
    var a = alpha, g = P.gravity * a, keep = 1 - P.decay, i;
    if (E) links(a);
    if (n > 1) { build(); manyBody(a); }
    if (n > 1) collide();
    for (i = 0; i < n; i++) {
      if (FX[i] === FX[i]) { X[i] = FX[i]; Y[i] = FY[i]; VX[i] = 0; VY[i] = 0; continue; }
      VX[i] -= X[i] * g; VY[i] -= Y[i] * g;
      VX[i] *= keep; VY[i] *= keep;
      X[i] += VX[i]; Y[i] += VY[i];
    }
  }

  function post(force) {
    var now = Date.now();
    if (!force && now - lastPost < 33) return;
    lastPost = now;
    var out = new Float32Array(2 * n);
    for (var i = 0; i < n; i++) { out[2 * i] = X[i]; out[2 * i + 1] = Y[i]; }
    self.postMessage({ type: 'pos', gen: gen, pos: out, alpha: alpha }, [out.buffer]);
  }

  function loop() {
    timer = 0;
    if (!running) return;
    var t0 = Date.now();
    do { tick(); } while (Date.now() - t0 < 12 && (alpha >= ALPHA_MIN || alphaTarget > 0));
    if (alpha < ALPHA_MIN && alphaTarget === 0) {
      post(true);
      running = false;
      self.postMessage({ type: 'idle', gen: gen });
      return;
    }
    post(false);
    timer = setTimeout(loop, 0);
  }

  function start() {
    if (running) return;
    running = true;
    if (!timer) timer = setTimeout(loop, 0);
  }

  function setParams(p) {
    if (!p) return;
    for (var k in p) if (Object.prototype.hasOwnProperty.call(P, k) && typeof p[k] === 'number' && isFinite(p[k])) P[k] = p[k];
    if (!E) return;
    var deg = new Int32Array(n), e;
    for (e = 0; e < E; e++) { deg[SRC[e]]++; deg[DST[e]]++; }
    for (e = 0; e < E; e++) {
      var ds = deg[SRC[e]], dt = deg[DST[e]];
      BIAS[e] = ds / (ds + dt);
      // A stronger link pulls harder and a little closer.
      K[e] = P.link * WBASE[e] / Math.min(ds, dt);
      DIST[e] = P.distance * (1.1 - 0.25 * Math.min(1, WRAW[e]));
    }
  }

  function init(msg) {
    gen = msg.gen || 0;
    n = msg.n; E = msg.src.length;
    X = new Float64Array(n); Y = new Float64Array(n); VX = new Float64Array(n); VY = new Float64Array(n);
    FX = new Float64Array(n).fill(NaN); FY = new Float64Array(n).fill(NaN);
    R = new Float64Array(n); R.set(msg.r);
    SRC = msg.src; DST = msg.dst;
    K = new Float64Array(E); BIAS = new Float64Array(E); DIST = new Float64Array(E);
    WRAW = msg.w; WBASE = new Float64Array(E);
    for (var e = 0; e < E; e++) WBASE[e] = Math.min(1, 0.35 + 0.65 * WRAW[e]);
    IDX = new Int32Array(n); TMP = new Int32Array(n); NEXT = new Int32Array(n);
    CELLX = new Int32Array(n); CELLY = new Int32Array(n);
    var size = 16; while (size < 2 * n) size *= 2;
    HEAD = new Int32Array(size); MASK = size - 1;
    cap = 0; TM = null; grow(Math.max(64, 2 * n + 16));
    setParams(msg.params);
    // Known positions stay; a new dot starts at the middle of its placed neighbours, else on a spiral.
    var pos = msg.pos, placed = new Uint8Array(n), i, scale = P.distance / 30;
    for (i = 0; i < n; i++) {
      var x = pos ? pos[2 * i] : NaN, y = pos ? pos[2 * i + 1] : NaN;
      if (x === x && y === y) { X[i] = x; Y[i] = y; placed[i] = 1; }
    }
    var sumX = new Float64Array(n), sumY = new Float64Array(n), cnt = new Int32Array(n);
    for (e = 0; e < E; e++) {
      var s = SRC[e], t = DST[e];
      if (placed[s] && !placed[t]) { sumX[t] += X[s]; sumY[t] += Y[s]; cnt[t]++; }
      if (placed[t] && !placed[s]) { sumX[s] += X[t]; sumY[s] += Y[t]; cnt[s]++; }
    }
    for (i = 0; i < n; i++) {
      if (placed[i]) continue;
      if (cnt[i]) {
        var ang = i * 2.399963, rad = 10 + (i % 7) * 4;
        X[i] = sumX[i] / cnt[i] + rad * Math.cos(ang); Y[i] = sumY[i] / cnt[i] + rad * Math.sin(ang);
      } else {
        var r = 10 * scale * Math.sqrt(0.5 + i), a = i * Math.PI * (3 - Math.sqrt(5));
        X[i] = r * Math.cos(a); Y[i] = r * Math.sin(a);
      }
    }
    alpha = typeof msg.alpha === 'number' ? msg.alpha : 1;
    alphaTarget = 0;
    post(true);
    start();
  }

  self.onmessage = function (ev) {
    var m = ev.data || {};
    if (m.type === 'init') init(m);
    else if (m.type === 'params') { setParams(m.params); alpha = Math.max(alpha, 0.3); start(); }
    else if (m.type === 'drag' && m.i >= 0 && m.i < n) { FX[m.i] = m.x; FY[m.i] = m.y; alphaTarget = 0.3; alpha = Math.max(alpha, 0.3); start(); }
    else if (m.type === 'release' && m.i >= 0 && m.i < n) { FX[m.i] = NaN; FY[m.i] = NaN; alphaTarget = 0; }
    else if (m.type === 'reheat') { alpha = Math.max(alpha, m.alpha || 0.5); start(); }
    else if (m.type === 'stop') { running = false; if (timer) clearTimeout(timer); timer = 0; }
  };

  // The same simulation without messages, for the kit's tests in Node.
  self.memoryKitLayout = {
    init: function (msg) { init(msg); running = false; if (timer) clearTimeout(timer); timer = 0; },
    tick: tick,
    state: function () { return { alpha: alpha, n: n, x: X, y: Y, r: R }; },
  };
})();
