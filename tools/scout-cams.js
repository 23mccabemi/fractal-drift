// Scouts camera viewpoints for new pseudo-Kleinian foam scenes (the KFOAM family in
// js/fractals.js). It ports that distance estimator to JS and rates candidate views the
// way a frame of the real thing would look: how much of the frame is filled with
// structure, how layered the depth is, and how much room the camera has.
//
//   node tools/scout-cams.js [count] [seed]
//
// Prints ready-to-paste `cam:` entries. Viewpoints that pass here match the statistical
// profile of the owner's locked-in cams (DE 0.006-0.03, coverage >= 0.95, depth spread).
'use strict';

// KFOAM parameters - keep in sync with js/fractals.js
const CSIZE = [0.808, 0.808, 1.167], SIZE = 1.0, C = [0, 0, 0], THICK = 0.92784;
const ITER = 11, STEP = 0.75, FAR = 12, FOV = 62;

function DE(x, y, z) {
  let px = x, py = y, pz = z, DEf = 1.0;
  for (let i = 0; i < ITER; i++) {
    px = 2 * Math.min(Math.max(px, -CSIZE[0]), CSIZE[0]) - px;
    py = 2 * Math.min(Math.max(py, -CSIZE[1]), CSIZE[1]) - py;
    pz = 2 * Math.min(Math.max(pz, -CSIZE[2]), CSIZE[2]) - pz;
    const r2 = px * px + py * py + pz * pz;
    const k = Math.max(SIZE / r2, 1.0);
    px *= k; py *= k; pz *= k; DEf *= k;
    px += C[0]; py += C[1]; pz += C[2];
  }
  const rxy = Math.hypot(px, py);
  const len = Math.hypot(px, py, pz) || 1e-12;
  return 0.5 * Math.max(rxy - THICK, Math.abs(rxy * pz) / len) / DEf;
}

function march(o, d) {
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const h = DE(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
    if (h < Math.max(t * 0.002, 1e-7)) return t;
    t += h * STEP;
    if (t > FAR) return FAR;
  }
  return t;
}

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Cast a fan of rays over the frustum: coverage, median depth and depth spread.
function rate(pos, fwd, n = 7) {
  const f = norm(fwd);
  let up = Math.abs(f[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const r = norm(cross(up, f)); up = cross(f, r);
  const tanH = Math.tan((FOV * Math.PI / 180) / 2);
  const hits = [];
  let covered = 0, total = 0, near = FAR;
  for (let iy = 0; iy < n; iy++) for (let ix = 0; ix < n; ix++) {
    const sx = (ix / (n - 1) * 2 - 1) * tanH * 1.6, sy = (iy / (n - 1) * 2 - 1) * tanH;
    const d = norm([f[0] + r[0] * sx + up[0] * sy, f[1] + r[1] * sx + up[1] * sy, f[2] + r[2] * sx + up[2] * sy]);
    const t = march(pos, d);
    total++;
    if (t < FAR * 0.98) { covered++; hits.push(t); near = Math.min(near, t); }
  }
  if (hits.length < 6) return null;
  hits.sort((a, b) => a - b);
  const mean = hits.reduce((a, b) => a + b, 0) / hits.length;
  return {
    cov: covered / total, near,
    med: hits[Math.floor(hits.length / 2)],
    sd: Math.sqrt(hits.reduce((a, b) => a + (b - mean) ** 2, 0) / hits.length),
  };
}

// Viewpoints already in use - new picks keep their distance from these.
const TAKEN = [
  [-1.3721, 0.5864, -0.0172], [0.0476, 0.1399, 0.2736], [-1.1473, -1.4536, -0.0443],
  [-1.575, -1.211, 0.243], [1.5007, -0.7181, 0.111], [0.3314, 0.6704, -0.0364],
  [-0.3716, 0.4834, -0.039], [0.4, 0.3, 1.2], [-0.0449, 0.4211, -0.3097],
  [1.1027, -0.0399, 0.2534], [0.2765, 1.2116, 0.0174], [1.4617, -0.2438, -0.2263],
  [-1.8139, -0.0646, 0.0369], [1.7188, -1.8471, -0.1265], [1.202, 1.7795, -0.0302],
  [-1.7884, -1.4114, -0.2666], [-1.6555, 1.8605, -0.0827], [-0.9581, -0.1128, 0.1056],
  [0.0218, -1.5011, -0.4959], [-0.3025, -0.3235, -0.1488],
];

function scout(count = 12, seed = Date.now() >>> 0) {
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return st / 4294967296; };
  const rr = (a, b) => a + (b - a) * rnd();
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const found = [];
  for (let n = 0; n < 400000 && found.length < count * 30; n++) {
    const p = [rr(-1.9, 1.9), rr(-1.9, 1.9), rr(-1.4, 1.4)];
    const de = DE(p[0], p[1], p[2]);
    if (!(de > 0.006 && de < 0.032)) continue;             // room to fly, still inside the foam
    if (TAKEN.some((t) => dist(t, p) < 0.35)) continue;
    let d = [rr(-1, 1), rr(-1, 1), rr(-1, 1)];
    if (Math.hypot(d[0], d[1], d[2]) < 0.2) continue;
    d = norm(d);
    const r = rate(p, d);
    if (!r || r.cov < 0.95 || r.sd < 1.5) continue;        // a full, layered frame
    if (r.near < 0.03 || r.near > 2.4) continue;           // something close enough to read
    if (r.med < 0.2 || r.med > 4.2) continue;
    found.push({ p, d, de, ...r, score: r.sd + r.cov * 2 + Math.min(r.med, 2) });
  }
  found.sort((a, b) => b.score - a.score);
  const picks = [];
  for (const f of found) {
    if (picks.some((q) => dist(q.p, f.p) < 0.55)) continue;   // spread them around
    picks.push(f);
    if (picks.length >= count) break;
  }
  return picks;
}

module.exports = { DE, march, rate, scout };

if (require.main === module) {
  const count = +process.argv[2] || 12;
  const seed = +process.argv[3] || 20261015;
  for (const f of scout(count, seed)) {
    const r3 = (v) => v.map((x) => +x.toFixed(4)).join(', ');
    console.log(`{ pos: [${r3(f.p)}], fwd: [${f.d.map((x) => +x.toFixed(3)).join(', ')}] },`.padEnd(70) +
      `// DE ${f.de.toFixed(4)} cov ${f.cov.toFixed(2)} near ${f.near.toFixed(2)} med ${f.med.toFixed(2)} sd ${f.sd.toFixed(2)}`);
  }
}
