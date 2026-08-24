// A small WebGL viewer that renders the bundled STL arches the way an intra-oral scanner
// renders a live scan: the surface appears progressively as a virtual wand sweeps the arch,
// with scan-quality markers (holes / layering) on the raw mesh that clear during refinement.
//
// It exists only for the demo UI (see demo.js). No dependencies — the renderer is loaded from
// a file:// page under a strict CSP, so everything here is hand-written: the STL parse, the
// scan-order sort, the matrix math and the shaders.
//
// Geometry stays in the scanner's own millimetre coordinates; a single model matrix shared by
// both arches normalizes them, so upper and lower keep their real articulated relationship and
// the bite view is the actual occlusion rather than two meshes posed by hand.

'use strict';

window.ScanView = (function () {
  // ---------------------------------------------------------------------------
  // mat4 / vec3 — only the handful of operations the viewer needs.
  // ---------------------------------------------------------------------------
  const v3 = (x, y, z) => new Float32Array([x, y, z]);
  const v3sub = (a, b) => v3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const v3add = (a, b) => v3(a[0] + b[0], a[1] + b[1], a[2] + b[2]);
  const v3scale = (a, s) => v3(a[0] * s, a[1] * s, a[2] * s);
  const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const v3cross = (a, b) =>
    v3(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  function v3norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return v3(a[0] / l, a[1] / l, a[2] / l);
  }

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  }

  function lookAt(eye, center, up) {
    const z = v3norm(v3sub(eye, center));
    let x = v3cross(up, z);
    if (Math.hypot(x[0], x[1], x[2]) < 1e-6) x = v3cross(v3(0, 0, 1), z);
    x = v3norm(x);
    const y = v3cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
    m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
    m[12] = -v3dot(x, eye);
    m[13] = -v3dot(y, eye);
    m[14] = -v3dot(z, eye);
    m[15] = 1;
    return m;
  }

  // Uniform scale + translation only: p' = (p - center) * scale + offset.
  function scaleTranslate(scale, center, offset) {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = scale;
    m[12] = -center[0] * scale + offset[0];
    m[13] = -center[1] * scale + offset[1];
    m[14] = -center[2] * scale + offset[2];
    m[15] = 1;
    return m;
  }

  // Deterministic PRNG — the same "random" hole placement every run, so a demo of the same
  // arch looks identical each time it is shown.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------------
  // Geometry — parse a binary STL and put its triangles in scan order.
  // ---------------------------------------------------------------------------

  // Quality markers carried per triangle and read by the fragment shader (0 = clean surface).
  const Q_LAYERING = 1; // cyan fringe along the scan's cut boundary
  const Q_HOLE = 2; // green patch: missing data the scanner wants re-scanned

  /**
   * Parse a binary STL into render buffers ordered the way a scan arrives.
   *
   * The order is what makes the reveal read as scanning rather than as a wipe: triangles are
   * sorted into two passes around the arch — the buccal/outer surface swept one way, then the
   * lingual/inner surface swept back — so drawing the first N triangles is exactly the surface
   * a wand would have captured by then.
   */
  function buildArch(bytes, seed) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    if (!n || 84 + n * 50 > bytes.byteLength) throw new Error('not a binary STL');

    const rawPos = new Float32Array(n * 9);
    const cen = new Float32Array(n * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    let off = 84;
    for (let i = 0; i < n; i++) {
      off += 12; // the stored facet normal is discarded; vertex normals are welded below
      let sx = 0, sy = 0, sz = 0;
      for (let v = 0; v < 3; v++) {
        const x = dv.getFloat32(off, true);
        const y = dv.getFloat32(off + 4, true);
        const z = dv.getFloat32(off + 8, true);
        off += 12;
        const b = i * 9 + v * 3;
        rawPos[b] = x; rawPos[b + 1] = y; rawPos[b + 2] = z;
        sx += x; sy += y; sz += z;
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
      off += 2; // attribute byte count
      cen[i * 3] = sx / 3; cen[i * 3 + 1] = sy / 3; cen[i * 3 + 2] = sz / 3;
    }

    const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

    // The occluso-gingival axis is the shortest one: an arch is much wider and deeper than tall.
    let up = 0;
    if (ext[1] < ext[up]) up = 1;
    if (ext[2] < ext[up]) up = 2;
    const pa = [0, 1, 2].filter((i) => i !== up); // the two axes the arch curves in

    // Which end of that axis the teeth face. Triangle density peaks on the occlusal surface
    // (tooth detail costs triangles), so the occlusal side is whichever end that peak sits near.
    const bins = new Array(24).fill(0);
    for (let i = 0; i < n; i++) {
      const t = (cen[i * 3 + up] - min[up]) / (ext[up] || 1);
      bins[Math.min(23, Math.max(0, Math.floor(t * 24)))]++;
    }
    let peak = 0;
    for (let i = 1; i < 24; i++) if (bins[i] > bins[peak]) peak = i;
    const peakPos = min[up] + ((peak + 0.5) / 24) * ext[up];
    // -1: the camera belongs on the min side of the axis, +1: on the max side.
    const occSign = peakPos - min[up] < max[up] - peakPos ? -1 : 1;
    const occPlane = occSign < 0 ? min[up] : max[up];

    // Arch centre: the bbox centre nudged toward the open end of the U, so an angle measured
    // around it sweeps molar -> anterior -> molar. The open end is found from an occupancy grid:
    // it is the direction of the empty cell with the most clearance from any data.
    const G = 28;
    const grid = new Int32Array(G * G);
    for (let i = 0; i < n; i++) {
      const ga = Math.min(G - 1, Math.floor(((cen[i * 3 + pa[0]] - min[pa[0]]) / (ext[pa[0]] || 1)) * G));
      const gb = Math.min(G - 1, Math.floor(((cen[i * 3 + pa[1]] - min[pa[1]]) / (ext[pa[1]] || 1)) * G));
      grid[gb * G + ga]++;
    }
    let bestClear = -1;
    let bestA = G / 2;
    let bestB = G / 2;
    for (let b = 0; b < G; b++) {
      for (let a = 0; a < G; a++) {
        if (grid[b * G + a] > 0) continue;
        // Chebyshev clearance to the nearest occupied cell, capped — enough to rank cells.
        let clear = G;
        for (let r = 1; r <= 8 && r < clear; r++) {
          let hit = false;
          for (let d = -r; d <= r && !hit; d++) {
            const cells = [[a + d, b - r], [a + d, b + r], [a - r, b + d], [a + r, b + d]];
            for (const [ca, cb] of cells) {
              if (ca < 0 || cb < 0 || ca >= G || cb >= G) continue;
              if (grid[cb * G + ca] > 0) { hit = true; break; }
            }
          }
          if (hit) clear = r;
        }
        if (clear > bestClear) { bestClear = clear; bestA = a + 0.5; bestB = b + 0.5; }
      }
    }
    const openDirA = bestA / G - 0.5;
    const openDirB = bestB / G - 0.5;
    const openAxis = Math.abs(openDirA) > Math.abs(openDirB) ? 0 : 1;
    const openSign = (openAxis === 0 ? openDirA : openDirB) >= 0 ? 1 : -1;

    const ctr = [0, 0, 0];
    ctr[pa[0]] = (min[pa[0]] + max[pa[0]]) / 2;
    ctr[pa[1]] = (min[pa[1]] + max[pa[1]]) / 2;
    ctr[pa[openAxis]] += openSign * 0.12 * ext[pa[openAxis]];
    ctr[up] = (min[up] + max[up]) / 2;

    // Angle + radius of every triangle about that centre.
    const ang = new Float32Array(n);
    const rad = new Float32Array(n);
    const TAU = Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const da = cen[i * 3 + pa[0]] - ctr[pa[0]];
      const db = cen[i * 3 + pa[1]] - ctr[pa[1]];
      let a = Math.atan2(db, da);
      if (a < 0) a += TAU;
      ang[i] = a;
      rad[i] = Math.hypot(da, db);
    }

    // The sweep starts where the arch opens — the widest angular stretch with (almost) no data.
    const AB = 96;
    const abins = new Int32Array(AB);
    for (let i = 0; i < n; i++) abins[Math.min(AB - 1, Math.floor((ang[i] / TAU) * AB))]++;
    const mean = n / AB;
    const empty = (i) => abins[((i % AB) + AB) % AB] < mean * 0.12;
    let runStart = -1;
    let bestLen = 0;
    let bestEnd = 0;
    for (let i = 0; i < AB * 2; i++) {
      if (empty(i)) {
        if (runStart < 0) runStart = i;
        const len = i - runStart + 1;
        if (len > bestLen && len <= AB) { bestLen = len; bestEnd = i; }
      } else {
        runStart = -1;
      }
    }
    const sweepStart = bestLen > 0 ? (((bestEnd + 1) % AB) / AB) * TAU : 0;

    const sweep = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let t = (ang[i] - sweepStart) / TAU;
      t -= Math.floor(t);
      sweep[i] = t;
    }

    // Outer (buccal) vs inner (lingual): compare each triangle's radius with the median radius
    // of its angular slice, so a curved arch is classified locally instead of by one threshold.
    const SL = 48;
    const slices = Array.from({ length: SL }, () => []);
    for (let i = 0; i < n; i++) slices[Math.min(SL - 1, Math.floor(sweep[i] * SL))].push(rad[i]);
    const medians = slices.map((s) => {
      if (s.length === 0) return 0;
      s.sort((x, y) => x - y);
      return s[s.length >> 1];
    });

    const key = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const outer = rad[i] > medians[Math.min(SL - 1, Math.floor(sweep[i] * SL))];
      // Pass 0 sweeps the outer surface one way, pass 1 the inner surface back the other way.
      key[i] = outer ? sweep[i] : 1 + (1 - sweep[i]);
    }
    const order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    // Int32Array#sort takes a comparator but ignores it in some engines' fast paths; sorting a
    // plain array keeps the comparator honoured everywhere.
    const orderArr = Array.from(order);
    orderArr.sort((a, b) => key[a] - key[b]);

    // ---- quality markers -------------------------------------------------
    const rnd = mulberry32(seed);
    const depth = new Float32Array(n); // 0 at the occlusal plane, 1 at the far (gingival) edge
    for (let i = 0; i < n; i++) depth[i] = Math.abs(cen[i * 3 + up] - occPlane) / (ext[up] || 1);

    const quality = new Uint8Array(n);
    // Layering artefacts collect where the scan runs out: the gingival cut margin and the two
    // molar ends. Patchy, not a clean band, so a coarse noise gates it.
    const noiseAt = (i) => {
      const x = Math.sin(cen[i * 3] * 1.7 + cen[i * 3 + 1] * 0.9 + cen[i * 3 + 2] * 1.3) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let i = 0; i < n; i++) {
      const endish = sweep[i] < 0.03 || sweep[i] > 0.97;
      if ((depth[i] > 0.82 && noiseAt(i) > 0.62) || (endish && noiseAt(i) > 0.55)) {
        quality[i] = Q_LAYERING;
      }
    }

    // Holes: a few patches on the occlusal band, spread around the arch so they are visible from
    // the scanning camera the way a real "rescan here" marker is.
    const HOLES = 7;
    const seeds = [];
    for (let h = 0; h < HOLES; h++) {
      const targetSweep = (h + 0.35 + rnd() * 0.3) / HOLES;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < n; i += 7) {
        if (depth[i] > 0.3) continue;
        const d = Math.abs(sweep[i] - targetSweep);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) seeds.push([cen[best * 3], cen[best * 3 + 1], cen[best * 3 + 2], 1.1 + rnd() * 1.3]);
    }
    for (let i = 0; i < n; i++) {
      for (const [sx, sy, sz, r] of seeds) {
        const dx = cen[i * 3] - sx, dy = cen[i * 3 + 1] - sy, dz = cen[i * 3 + 2] - sz;
        if (dx * dx + dy * dy + dz * dz < r * r) { quality[i] = Q_HOLE; break; }
      }
    }

    // ---- welded vertex normals ------------------------------------------
    // STL stores no shared vertices, so a straight facet normal gives a faceted plastic look.
    // Averaging normals per welded position is what makes the surface read as a scan.
    const acc = new Map();
    const qKey = (x, y, z) => `${Math.round(x * 20)},${Math.round(y * 20)},${Math.round(z * 20)}`;
    for (let i = 0; i < n; i++) {
      const b = i * 9;
      const ax = rawPos[b], ay = rawPos[b + 1], az = rawPos[b + 2];
      const bx = rawPos[b + 3], by = rawPos[b + 4], bz = rawPos[b + 5];
      const cx = rawPos[b + 6], cy = rawPos[b + 7], cz = rawPos[b + 8];
      // Un-normalized cross product: its length is twice the area, which area-weights the average.
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
        const k = qKey(x, y, z);
        const cur = acc.get(k);
        if (cur) { cur[0] += nx; cur[1] += ny; cur[2] += nz; }
        else acc.set(k, [nx, ny, nz]);
      }
    }

    // ---- emit buffers in scan order --------------------------------------
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const qua = new Float32Array(n * 3);
    const ord = new Float32Array(n * 3);
    for (let o = 0; o < n; o++) {
      const i = orderArr[o];
      const src = i * 9;
      const dst = o * 9;
      for (let v = 0; v < 3; v++) {
        const x = rawPos[src + v * 3], y = rawPos[src + v * 3 + 1], z = rawPos[src + v * 3 + 2];
        pos[dst + v * 3] = x; pos[dst + v * 3 + 1] = y; pos[dst + v * 3 + 2] = z;
        const a = acc.get(qKey(x, y, z));
        const l = a ? Math.hypot(a[0], a[1], a[2]) || 1 : 1;
        nrm[dst + v * 3] = a ? a[0] / l : 0;
        nrm[dst + v * 3 + 1] = a ? a[1] / l : 0;
        nrm[dst + v * 3 + 2] = a ? a[2] / l : 1;
        qua[o * 3 + v] = quality[i];
        ord[o * 3 + v] = o / n;
      }
    }

    return {
      triangles: n,
      pos, nrm, qua, ord,
      min, max, ext,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      archCenter: ctr,
      upAxis: up,
      planeAxes: pa,
      occSign,
    };
  }

  // ---------------------------------------------------------------------------
  // Shaders
  // ---------------------------------------------------------------------------
  const VERT = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    attribute float aQuality;
    attribute float aOrder;
    uniform mat4 uProj;
    uniform mat4 uView;
    uniform mat4 uModel;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vQuality;
    varying float vOrder;
    void main() {
      vec4 w = uModel * vec4(aPos, 1.0);
      vWorld = w.xyz;
      vNormal = aNormal;
      vQuality = aQuality;
      vOrder = aOrder;
      gl_Position = uProj * uView * w;
    }
  `;

  const FRAG = `
    precision highp float;
    varying vec3 vWorld;
    varying vec3 vNormal;
    varying float vQuality;
    varying float vOrder;

    uniform vec3 uEye;
    uniform float uReveal;    // normalized scan position; the frontier glows just behind it
    uniform float uSmooth;    // 0 raw capture, 1 refined mesh
    uniform float uQuality;   // 0 hides the hole / layering markers
    uniform float uLive;      // 1 while the wand is capturing

    float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453); }
    float vnoise(vec3 p) {
      vec3 i = floor(p);
      vec3 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash(i), b = hash(i + vec3(1.0, 0.0, 0.0));
      float c = hash(i + vec3(0.0, 1.0, 0.0)), d = hash(i + vec3(1.0, 1.0, 0.0));
      float e = hash(i + vec3(0.0, 0.0, 1.0)), g = hash(i + vec3(1.0, 0.0, 1.0));
      float h = hash(i + vec3(0.0, 1.0, 1.0)), k = hash(i + vec3(1.0, 1.0, 1.0));
      return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
                 mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
    }

    void main() {
      vec3 n = normalize(vNormal);
      if (!gl_FrontFacing) n = -n;

      // Fresh capture is bumpy; refinement smooths it out.
      float raw = 1.0 - uSmooth;
      vec3 jitter = vec3(vnoise(vWorld * 70.0), vnoise(vWorld * 70.0 + 11.7), vnoise(vWorld * 70.0 + 4.3)) - 0.5;
      n = normalize(n + jitter * 0.38 * raw);

      vec3 v = normalize(uEye - vWorld);
      vec3 l1 = normalize(vec3(0.3, 0.65, 0.75));
      vec3 l2 = normalize(vec3(-0.55, -0.4, 0.35));

      float d = 0.55 * max(dot(n, v), 0.0) + 0.45 * max(dot(n, l1), 0.0) + 0.18 * max(dot(n, l2), 0.0);
      float spec = pow(max(dot(normalize(v + l1), n), 0.0), mix(22.0, 60.0, uSmooth)) * mix(0.18, 0.42, uSmooth);
      float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);

      vec3 base = vec3(0.905, 0.876, 0.822);
      float speckle = vnoise(vWorld * 220.0) * 0.5 + vnoise(vWorld * 90.0) * 0.5;
      base *= mix(1.0, 0.86 + 0.28 * speckle, 0.55 + 0.45 * raw);

      // Scan-quality overlay: cyan where the capture is layering, green where data is missing.
      if (vQuality > 1.5) base = mix(base, vec3(0.15, 0.86, 0.40), 0.86 * uQuality);
      else if (vQuality > 0.5) base = mix(base, vec3(0.24, 0.84, 0.93), 0.72 * uQuality);

      vec3 col = base * (0.19 + d * 1.1) + vec3(1.0, 0.98, 0.94) * spec + vec3(0.16, 0.24, 0.34) * fres * 0.7;

      // The strip captured in the last instant reads as the wand's live footprint.
      float behind = uReveal - vOrder;
      float front = 1.0 - smoothstep(0.0, 0.045, behind);
      col += vec3(0.22, 0.55, 0.66) * front * 0.95 * uLive;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s));
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Viewer
  // ---------------------------------------------------------------------------

  /** Create a scan viewer on a canvas. */
  function createScanView(canvas) {
    const gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL is unavailable');

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    const attr = {
      pos: gl.getAttribLocation(prog, 'aPos'),
      nrm: gl.getAttribLocation(prog, 'aNormal'),
      qua: gl.getAttribLocation(prog, 'aQuality'),
      ord: gl.getAttribLocation(prog, 'aOrder'),
    };
    const uni = {};
    for (const name of ['uProj', 'uView', 'uModel', 'uEye', 'uReveal', 'uSmooth', 'uQuality', 'uLive']) {
      uni[name] = gl.getUniformLocation(prog, name);
    }

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE); // a scan is an open surface: both sides of it are real

    const arches = {};
    // Normalization shared by every arch, so the two keep their real relative pose.
    let frame = null;

    function refreshFrame() {
      const keys = Object.keys(arches);
      if (keys.length === 0) { frame = null; return; }
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const k of keys) {
        const g = arches[k].geo;
        for (let a = 0; a < 3; a++) {
          if (g.min[a] < min[a]) min[a] = g.min[a];
          if (g.max[a] > max[a]) max[a] = g.max[a];
        }
      }
      const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
      const span = Math.max(ext[0], ext[1], ext[2]) || 1;
      frame = {
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        ext,
        scale: 1 / span,
      };
    }

    function buffer(data) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      return b;
    }

    /** Parse + upload one arch. `bytes` is the raw binary STL. */
    function loadArch(name, bytes) {
      const geo = buildArch(bytes, name === 'lower' ? 20250811 : 20250704);
      const entry = {
        geo,
        bufs: {
          pos: buffer(geo.pos),
          nrm: buffer(geo.nrm),
          qua: buffer(geo.qua),
          ord: buffer(geo.ord),
        },
        reveal: 0,
        visible: false,
      };
      // The typed arrays are on the GPU now; a few MB per arch is not worth keeping twice.
      geo.pos = geo.nrm = geo.qua = geo.ord = null;
      arches[name] = entry;
      refreshFrame();
      return { triangles: geo.triangles };
    }

    const hasArch = (name) => Boolean(arches[name]);

    const FOVY = (26 * Math.PI) / 180;

    const state = {
      focus: 'upper', // which arch the camera frames; 'bite' frames both
      azimuth: Math.PI / 2,
      azimuthTarget: Math.PI / 2,
      tilt: 0.34,
      tiltTarget: 0.34,
      pad: 1.15, // how much room to leave around the model
      dist: 2.5,
      distTarget: 2.5,
      spin: 0.05, // idle drift, rad/s
      quality: 1,
      smooth: 0,
      bite: 0,
      biteTarget: 0,
      live: 0, // 1 while a sweep is in progress
    };

    function show(name, visible) {
      if (arches[name]) arches[name].visible = visible;
    }
    function setReveal(name, t) {
      if (arches[name]) arches[name].reveal = Math.max(0, Math.min(1, t));
    }
    const setQuality = (q) => { state.quality = q; };
    const setSmooth = (s) => { state.smooth = s; };
    const setSpin = (s) => { state.spin = s; };
    const setLive = (on) => { state.live = on ? 1 : 0; };
    const setBite = (on) => { state.biteTarget = on ? 1 : 0; };

    /**
     * Point the camera at an arch ('upper' | 'lower') or at the occlusion ('bite').
     * `follow` (0..1) is where along the sweep the wand is, so the view leans that way.
     */
    function focus(name, follow) {
      state.focus = name;
      if (name === 'bite') {
        state.tiltTarget = 1.42; // all but in the occlusal plane: a buccal side view
        state.azimuthTarget = -0.16; // from the patient's right, barely off lateral
        state.pad = 1.34;
      } else {
        state.tiltTarget = 0.34;
        // Lean the occlusal view toward the part of the arch being swept.
        const f = typeof follow === 'number' ? follow : 0.5;
        state.azimuthTarget = Math.PI / 2 + (f - 0.5) * 0.7;
        state.pad = 1.04;
      }
    }

    function basisFor(entry) {
      const g = entry.geo;
      const U = [0, 0, 0]; U[g.upAxis] = 1;
      const A = [0, 0, 0]; A[g.planeAxes[0]] = 1;
      const B = [0, 0, 0]; B[g.planeAxes[1]] = 1;
      return { U: v3(U[0], U[1], U[2]), A: v3(A[0], A[1], A[2]), B: v3(B[0], B[1], B[2]), occSign: g.occSign };
    }

    function worldPoint(p) {
      return v3(
        (p[0] - frame.center[0]) * frame.scale,
        (p[1] - frame.center[1]) * frame.scale,
        (p[2] - frame.center[2]) * frame.scale
      );
    }

    let raf = 0;
    let last = 0;
    let running = false;
    let driftPhase = 0;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      return canvas.width / Math.max(1, canvas.height);
    }

    function frameTick(now) {
      raf = running ? requestAnimationFrame(frameTick) : 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;

      const aspect = resize();
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!frame) return;

      // Damp every camera move: a scanner view glides, it never snaps.
      const k = 1 - Math.exp(-dt * 3.2);
      driftPhase += state.spin * dt;
      const drift = 0.3 * Math.sin(driftPhase);
      state.azimuth += (state.azimuthTarget + drift - state.azimuth) * k;
      state.tilt += (state.tiltTarget - state.tilt) * k;
      state.bite += (state.biteTarget - state.bite) * (1 - Math.exp(-dt * 2.4));

      const names = Object.keys(arches);
      const anchorName = state.focus === 'bite'
        ? (arches.upper ? 'upper' : names[0])
        : (arches[state.focus] ? state.focus : names[0]);
      const anchor = arches[anchorName];
      if (!anchor) return;

      const basis = basisFor(anchor);
      // Anatomical up: the upper arch's teeth point away from it, the lower arch's point at it.
      const anatomicalUp = v3scale(basis.U, anchorName === 'lower' ? basis.occSign : -basis.occSign);

      let target;
      if (state.focus === 'bite') {
        const pts = names.filter((n) => arches[n].visible).map((n) => arches[n].geo.center);
        const src = pts.length ? pts : [anchor.geo.center];
        const avg = [0, 0, 0];
        for (const p of src) { avg[0] += p[0] / src.length; avg[1] += p[1] / src.length; avg[2] += p[2] / src.length; }
        target = worldPoint(avg);
      } else {
        target = worldPoint(anchor.geo.center);
      }

      const plane = v3add(v3scale(basis.A, Math.cos(state.azimuth)), v3scale(basis.B, Math.sin(state.azimuth)));
      const occ = v3scale(basis.U, basis.occSign);
      const eyeDir = v3norm(v3add(v3scale(occ, Math.cos(state.tilt)), v3scale(plane, Math.sin(state.tilt))));
      state.dist += (state.distTarget - state.dist) * k;
      const eye = v3add(target, v3scale(eyeDir, state.dist));
      const camUp = state.focus === 'bite' ? anatomicalUp : v3scale(basis.B, -1);

      // Frame on the two axes this view actually shows: an occlusal view is bounded by the
      // arch's width and depth, a lateral bite view by its depth and its height plus however
      // far the two arches are currently held apart.
      const g = anchor.geo;
      const pa = g.planeAxes;
      const fitMm = state.focus === 'bite'
        ? Math.max(frame.ext[pa[1]], frame.ext[g.upAxis] + 0.1 / frame.scale)
        : Math.max(g.ext[pa[0]], g.ext[pa[1]]);
      // The distance that frames those axes is measured to the model's centre, but at this
      // field of view the half of the model nearer the camera is magnified enough to spill out
      // of the frame — so back off by that half-depth too.
      const depthMm = state.focus === 'bite' ? frame.ext[pa[0]] : g.ext[g.upAxis];
      state.distTarget =
        ((fitMm * frame.scale) / 2 / Math.tan(FOVY / 2)) * state.pad + (depthMm * frame.scale) / 2;

      const proj = perspective(FOVY, aspect, 0.05, 30);
      const view = lookAt(eye, target, camUp);

      gl.uniformMatrix4fv(uni.uProj, false, proj);
      gl.uniformMatrix4fv(uni.uView, false, view);
      gl.uniform3fv(uni.uEye, eye);
      gl.uniform1f(uni.uSmooth, state.smooth);
      gl.uniform1f(uni.uQuality, state.quality);
      gl.uniform1f(uni.uLive, state.live);

      for (const name of names) {
        const e = arches[name];
        if (!e.visible || e.reveal <= 0) continue;
        const count = Math.floor(e.reveal * e.geo.triangles) * 3;
        if (count < 3) continue;

        // The bite view pulls the arches apart along the anatomical axis to show the occlusion.
        const sep = state.bite * 0.05 * (name === 'lower' ? -1 : 1);
        gl.uniformMatrix4fv(uni.uModel, false, scaleTranslate(frame.scale, frame.center, v3scale(anatomicalUp, sep)));
        gl.uniform1f(uni.uReveal, e.reveal);

        gl.bindBuffer(gl.ARRAY_BUFFER, e.bufs.pos);
        gl.enableVertexAttribArray(attr.pos);
        gl.vertexAttribPointer(attr.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, e.bufs.nrm);
        gl.enableVertexAttribArray(attr.nrm);
        gl.vertexAttribPointer(attr.nrm, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, e.bufs.qua);
        gl.enableVertexAttribArray(attr.qua);
        gl.vertexAttribPointer(attr.qua, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, e.bufs.ord);
        gl.enableVertexAttribArray(attr.ord);
        gl.vertexAttribPointer(attr.ord, 1, gl.FLOAT, false, 0, 0);

        gl.drawArrays(gl.TRIANGLES, 0, count);
      }
    }

    function start() {
      if (running) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(frameTick);
    }
    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    return {
      loadArch,
      hasArch,
      show,
      setReveal,
      setQuality,
      setSmooth,
      setSpin,
      setLive,
      setBite,
      focus,
      start,
      stop,
      triangles: (name) => (arches[name] ? arches[name].geo.triangles : 0),
    };
  }

  return { createScanView };
})();
