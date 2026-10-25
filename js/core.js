// Shared namespace + small math helpers. Classic scripts (no modules) so the
// app runs straight from file:// by double-clicking index.html.
'use strict';
window.FV = window.FV || {};

(function (FV) {
  FV.clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  FV.lerp = (a, b, t) => a + (b - a) * t;
  // Frame-rate independent exponential smoothing factor.
  FV.damp = (rate, dt) => 1 - Math.exp(-rate * dt);

  FV.halton = (i, b) => {
    let f = 1, r = 0;
    while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
    return r;
  };

  FV.hexToRgb = (hex) => {
    const n = parseInt(hex.replace('#', ''), 16);
    // sRGB -> linear so palettes authored by eye stay true after tonemapping.
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  };

  // --- vec3 ---
  const v3 = FV.v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };

  // --- quaternion [x,y,z,w] ---
  const q = FV.quat = {
    ident: () => [0, 0, 0, 1],
    mul: (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ],
    axisAngle: (ax, ang) => {
      const s = Math.sin(ang / 2);
      return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)];
    },
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1; return [a[0] / l, a[1] / l, a[2] / l, a[3] / l]; },
    rotate: (a, v) => {
      // v' = v + 2w(u x v) + 2u x (u x v)
      const u = [a[0], a[1], a[2]], w = a[3];
      const t = v3.scale(v3.cross(u, v), 2);
      return v3.add(v3.add(v, v3.scale(t, w)), v3.cross(u, t));
    },
    // Column-major mat3 whose columns are camera right / up / forward.
    toMat3: (a) => {
      const r = q.rotate(a, [1, 0, 0]), u = q.rotate(a, [0, 1, 0]), f = q.rotate(a, [0, 0, 1]);
      return new Float32Array([r[0], r[1], r[2], u[0], u[1], u[2], f[0], f[1], f[2]]);
    },
    // Orientation looking along `fwd` with `up` hint.
    lookRot: (fwd, up) => {
      const f = v3.norm(fwd);
      let r = v3.cross(up || [0, 1, 0], f);
      if (v3.len(r) < 1e-4) r = [1, 0, 0];
      r = v3.norm(r);
      const u = v3.cross(f, r);
      // rotation matrix columns r,u,f -> quaternion
      const m00 = r[0], m01 = u[0], m02 = f[0], m10 = r[1], m11 = u[1], m12 = f[1], m20 = r[2], m21 = u[2], m22 = f[2];
      const tr = m00 + m11 + m22;
      let x, y, z, w;
      if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
      else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
      else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
      else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
      return q.norm([x, y, z, w]);
    },
  };

  // Rotation matrix (column-major mat3) from Euler angles, used for KIFS folds.
  FV.rotMat3 = (ax, ay, az) => {
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // R = Rz * Ry * Rx
    const m = [
      cz * cy, sz * cy, -sy,
      cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx,
      cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx,
    ];
    return new Float32Array(m);
  };

  // Cheap smooth 1D value noise for camera wander.
  FV.noise1 = (x) => {
    const i = Math.floor(x), f = x - i;
    const h = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    const u = f * f * (3 - 2 * f);
    return FV.lerp(h(i), h(i + 1), u) * 2 - 1;
  };

  FV.store = {
    get(key, def) { try { const v = localStorage.getItem('fv.' + key); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(key, val) { try { localStorage.setItem('fv.' + key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } },
  };
})(window.FV);
