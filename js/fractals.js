// Fractal distance estimators (GLSL) and the art-directed scenes built on them.
// Every fractal(p, trap) returns a distance estimate and min-accumulates an
// orbit trap (|x|,|y|,|z|,r^2) that the colouring stage turns into palettes.
'use strict';
(function (FV) {
  const programs = {
    mandelbox: {
      defines: '#define ITER 12\n',
      stepFactor: 0.9,
      src: `
float fractal(vec3 pos, inout vec4 trap){
  float scale = uP0.x, minR2 = uP0.y, fold = uP0.z;
  vec4 scalevec = vec4(scale, scale, scale, abs(scale)) / minR2;
  float C1 = abs(scale - 1.0), C2 = pow(abs(scale), float(1 - ITER));
  vec4 p = vec4(pos, 1.0), p0 = vec4(pos + uP1.xyz, 1.0);
  for(int i=0; i<ITER; i++){
    p.xyz = clamp(p.xyz, -fold, fold)*2.0 - p.xyz;
    p.xyz = uRot * p.xyz;
    float r2 = dot(p.xyz, p.xyz);
    if(i < 6) trap = min(trap, vec4(abs(p.xyz), r2));
    p *= clamp(max(minR2/r2, minR2), 0.0, 1.0);
    p = p*scalevec + p0;
  }
  return (length(p.xyz) - C1)/p.w - C2;
}`,
    },

    mandelbulb: {
      defines: '#define ITER 10\n',
      stepFactor: 0.85,
      src: `
float fractal(vec3 p, inout vec4 trap){
  vec3 z = p; float dr = 1.0; float r = length(z); float power = uP0.x;
  for(int i=0; i<ITER; i++){
    r = length(z);
    if(r > 2.0) break;
    float th = acos(clamp(z.y/r, -1.0, 1.0)) + uP0.y;
    float ph = atan(z.z, z.x) + uP0.z;
    dr = pow(r, power - 1.0)*power*dr + 1.0;
    float zr = pow(r, power);
    th *= power; ph *= power;
    z = zr*vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph)) + p + uP1.xyz;
    trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  r = length(z);
  return 0.5*log(r)*r/dr;
}`,
    },

    apollonian: {
      defines: '#define ITER 9\n',
      stepFactor: 0.9,
      src: `
float fractal(vec3 p, inout vec4 trap){
  float s = uP0.x;
  float scale = 1.0;
  p = uRot * p;
  for(int i=0; i<ITER; i++){
    p = -1.0 + 2.0*fract(0.5*p + 0.5);
    float r2 = dot(p, p);
    trap = min(trap, vec4(abs(p), r2));
    float k = s/r2;
    p *= k; scale *= k;
  }
  return 0.25*abs(p.y)/scale;
}`,
    },

    kleinian: {
      defines: '#define ITER 11\n',
      stepFactor: 0.75,
      src: `
float fractal(vec3 p, inout vec4 trap){
  vec3 csize = uP0.xyz; float size = uP0.w; vec3 C = uP1.xyz; float thick = uP1.w;
  float DEf = 1.0;
  for(int i=0; i<ITER; i++){
    p = 2.0*clamp(p, -csize, csize) - p;
    float r2 = dot(p, p);
    trap = min(trap, vec4(abs(p), r2));
    float k = max(size/r2, 1.0);
    p *= k; DEf *= k;
    p += C;
  }
  float rxy = length(p.xy);
  return 0.5*max(rxy - thick, abs(rxy*p.z)/length(p)) / DEf;
}`,
    },

    menger: {
      defines: '#define ITER 8\n',
      stepFactor: 0.9,
      src: `
float fractal(vec3 z, inout vec4 trap){
  float per = uP1.x;
  z = mod(z + 0.5*per, per) - 0.5*per;
  float scale = uP0.x; vec3 off = uP0.yzw;
  for(int n=0; n<ITER; n++){
    z = abs(z);
    if(z.x < z.y) z.xy = z.yx;
    if(z.x < z.z) z.xz = z.zx;
    if(z.y < z.z) z.yz = z.zy;
    z = uRot * z;
    z = scale*z - off*(scale - 1.0);
    if(z.z < -0.5*off.z*(scale - 1.0)) z.z += off.z*(scale - 1.0);
    if(n < 5) trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  vec3 d = abs(z) - vec3(1.0);
  float dist = min(max(d.x, max(d.y, d.z)), 0.0) + length(max(d, 0.0));
  return dist * pow(scale, -float(ITER));
}`,
    },

    // Endless ridged terrain with a horizon: an open, exterior world to set against all
    // the interiors. Ridged noise, so the ridges catch the light like a canyon rim.
    canyon: {
      defines: '#define ITER 7\n',
      stepFactor: 0.4,
      src: `
float terrH(vec2 q){
  float h = 0.0, a = 1.0, f = 1.0;
  for(int i=0; i<ITER; i++){
    h += a * (1.0 - abs(sin(q.x*f + sin(q.y*f*0.7))))*cos(q.y*f*0.9);
    a *= 0.52; f *= 2.07;
  }
  return h;
}
float fractal(vec3 p, inout vec4 trap){
  float h = terrH(p.xz*uP0.y)*uP0.x;
  float d = p.y - h;
  trap = min(trap, vec4(abs(h) + 1e-3, abs(d) + 1e-3, abs(p.y)*0.5 + 1e-3, dot(p.xz, p.xz)*0.02 + 1e-3));
  return d * 0.35;
}`,
    },

    // Folded tetrahedron (KIFS): hard flat faces and sharp edges - a crystal, the complete
    // opposite of the bubble foam, so it breaks up a run of round shapes.
    sierpinski: {
      defines: '#define ITER 13\n',
      stepFactor: 0.9,
      src: `
float fractal(vec3 z, inout vec4 trap){
  float scale = uP0.x; vec3 off = uP0.yzw;
  for(int i=0; i<ITER; i++){
    if(z.x + z.y < 0.0) z.xy = -z.yx;
    if(z.x + z.z < 0.0) z.xz = -z.zx;
    if(z.y + z.z < 0.0) z.zy = -z.yz;
    z = uRot * z;
    z = z*scale - off*(scale - 1.0);
    if(i < 7) trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  return (length(z) - 2.0) * pow(scale, -float(ITER));
}`,
    },

    // Field of rounded, cell-patterned asteroids (domain repetition of a Mandelbox
    // ball with a per-cell random orientation) - the "space debris" look.
    asteroids: {
      defines: '#define ITER 11\n',
      stepFactor: 0.7,
      src: `
mat3 rotAxis(vec3 a, float ang){ a = normalize(a); float s = sin(ang), c = cos(ang), oc = 1.0 - c;
  return mat3(oc*a.x*a.x+c, oc*a.x*a.y+a.z*s, oc*a.z*a.x-a.y*s,
              oc*a.x*a.y-a.z*s, oc*a.y*a.y+c, oc*a.y*a.z+a.x*s,
              oc*a.z*a.x+a.y*s, oc*a.y*a.z-a.x*s, oc*a.z*a.z+c); }
float fractal(vec3 pos, inout vec4 trap){
  float per = uP1.x;
  vec3 id = floor(pos/per + 0.5);
  vec3 q = pos - id*per;
  vec3 h = fract(sin(vec3(dot(id, vec3(127.1,311.7,74.7)), dot(id, vec3(269.5,183.3,246.1)), dot(id, vec3(113.5,271.9,124.6))))*43758.5453);
  q += (h - 0.5)*per*0.25;
  float rad = per*(0.22 + 0.12*h.x);
  q = rotAxis(h*2.0 - 1.0 + 1e-3, h.y*6.2831 + uTime*0.03*(h.z - 0.5)) * q;
  q *= 1.0/rad;                                // unit ball space
  // a Mandelbulb planetoid per cell (bounded, well-behaved DE)
  vec3 z = q*uP0.z, c = z; float dr = 1.0, r = length(z); float power = uP0.x + (h.z - 0.5)*uP0.y;
  for(int i=0; i<ITER; i++){
    r = length(z);
    if(r > 2.0) break;
    float th = acos(clamp(z.y/r, -1.0, 1.0)), ph = atan(z.z, z.x);
    dr = pow(r, power - 1.0)*power*dr + 1.0;
    float zr = pow(r, power);
    th *= power; ph *= power;
    z = zr*vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph)) + c;
    trap = min(trap, vec4(abs(z), dot(z, z)));
  }
  r = length(z);
  float d = 0.5*log(r)*r/dr / uP0.z;
  if(fract(h.x*7.13 + h.y*3.71 + h.z*1.37) < uP1.y) d = 1e3;   // leave some cells empty
  // never step past the cell boundary
  float cell = per*0.5 - max(abs(pos.x - id.x*per), max(abs(pos.y - id.y*per), abs(pos.z - id.z*per)));
  return min(d*rad, max(cell, 0.0) + per*0.02);
}`,
    },
  };

  // ---- palettes (authored in sRGB hex, converted to linear) ----
  const P = (hexes) => hexes.map(FV.hexToRgb);

  // Scenes are modelled on the chapters of the reference video (youtu.be/R2PiVXjanws);
  // palettes were extracted from its frames (k-means on 1080p captures).
  // look.col = [palette frequency, ring frequency, palette sharpness, ring width]
  // audio(u, a): mutate shape uniforms from audio (a = bass, mid, high, energy, beat; all 0..1).
  const KLEIN_A = { pos: [0.0476, 0.1399, 0.2736], fwd: [0.989, -0.063, -0.131] };
  const KLEIN_B = { pos: [0.4, 0.3, 1.2], fwd: [0.3, 0.1, 1] };
  const kleinAudio = (u, a) => { u.p0[0] += a.bass * 0.006; u.p1[3] += a.high * 0.004; };
  const boxAudio = (u, a) => { u.p0[0] += a.bass * 0.012 * Math.sign(u.p0[0]); u.rot = [u.rot[0], u.rot[1] + a.mid * 0.01, u.rot[2]]; };
  const DARK = { a: '#000000', b: '#050407' };
  // the pseudo-Kleinian foam behind Magenta Foam / Fractal Light and their variations
  const KFOAM = { p0: [0.808, 0.808, 1.167, 1.0], p1: [0, 0, 0, 0.92784], p2: [0, 0, 0, 0], rot: [0, 0, 0],
    morph: { key: 'p0', idx: 2, min: 0.9, max: 1.4, rate: 0.05 } };

  // Variations on the two favourites: the same foam, same scale, new viewpoint and palette.
  // `bright` gets the Fractal Light treatment (ambient light, pale sky, specular lace);
  // otherwise the Magenta Foam one (dark void, emissive rims). Geometry stays audio-free.
  const foam = (name, cam, o) => ({
    name, program: 'kleinian', ...KFOAM,
    look: {
      base: P(o.base), acc: P(o.acc),
      trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
      emissive: o.emissive ?? (o.bright ? 0.05 : 0.17),
      spec: o.bright ? 0.20 : 0.06, specPow: o.bright ? 60 : 32, rim: o.bright ? 0.24 : 0.07,
      light: { dir: o.lightDir || (o.bright ? [0.3, 0.85, -0.35] : [0.4, 0.7, -0.5]),
        col: o.lightCol || (o.bright ? '#fff6fa' : '#ffe6f0'), int: o.bright ? 1.4 : 0.9 },
      amb: { col: o.ambCol || '#ffffff', int: o.bright ? 1.0 : 0.85 }, head: o.bright ? 0.35 : 0.3,
      fog: { col: o.fog || (o.bright ? '#c4dcea' : '#030003'), den: o.bright ? 0.1 : 0.12 },
      bg: o.bright ? { a: o.bgA, b: o.bgB } : DARK,
      ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
      post: { exposure: o.bright ? 1.15 : 1.35, sat: o.sat ?? (o.bright ? 1.15 : 1.0), contrast: 1.05, bloom: 0.03 },
    },
    cam, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
  });

  const scenes = [
    {
      name: 'Magenta Foam',
      program: 'kleinian', ...KFOAM,
      look: {
        warp: 1,
        base: P(['#280a22', '#712c49', '#491839', '#ac496c', '#802c70', '#491839']),
        acc: P(['#e48c77', '#f0b090', '#8a4cd0', '#ffa070']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.5, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.4, 0.7, -0.5], col: '#ffe6f0', int: 0.9 }, amb: { col: '#ffffff', int: 0.85 }, head: 0.3,
        fog: { col: '#030003', den: 0.12 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: { pos: [-1.3721, 0.5864, -0.0172], fwd: [-0.84, 0.472, -0.27] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Fractal Light',
      program: 'kleinian', ...KFOAM,
      look: {
        base: P(['#8a82ac', '#a69ec4', '#7c74a0', '#bcb4d4', '#948cb8', '#aca4c8']),
        acc: P(['#f4f0ff', '#e8d0f0', '#ffffff', '#d8e8ff']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.05, spec: 0.20, specPow: 60, rim: 0.24,
        light: { dir: [0.3, 0.85, -0.35], col: '#fff6fa', int: 1.4 }, amb: { col: '#d8e8ff', int: 1.0 }, head: 0.35,
        fog: { col: '#c4dcea', den: 0.12 }, bg: { a: '#a8d4f0', b: '#f4f8ff' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.15, sat: 1.15, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [0.0476, 0.1399, 0.2736], fwd: [0.989, -0.063, -0.131] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Orchid Ember',
      program: 'kleinian', ...KFOAM,
      look: {
        base: P(['#1e0a3a', '#4a1a7a', '#2e1250', '#7a3aa8', '#5a2690', '#3a1660']),
        acc: P(['#ffb060', '#ff7a40', '#ffd090', '#ff9050']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.17, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.4, 0.7, -0.5], col: '#ffe6f0', int: 0.9 }, amb: { col: '#ffffff', int: 0.85 }, head: 0.3,
        fog: { col: '#030006', den: 0.12 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [-1.1473, -1.4536, -0.0443], fwd: [-0.595, 0.084, 0.799] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Abyssal Foam',
      program: 'kleinian', ...KFOAM,
      look: {
        base: P(['#06122a', '#0f2f5a', '#0a1f40', '#1f5a8a', '#16406e', '#0d2a50']),
        acc: P(['#ff4fa8', '#ff80c8', '#40e0ff', '#ff60b0']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.17, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.3, 0.8, -0.4], col: '#e8f4ff', int: 0.9 }, amb: { col: '#ffffff', int: 0.85 }, head: 0.3,
        fog: { col: '#000308', den: 0.12 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.4, sat: 1.0, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [-1.575, -1.211, 0.243], fwd: [0.15, -0.426, 0.892] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Pearl Lace',
      program: 'kleinian', ...KFOAM,
      look: {
        base: P(['#7a3a6a', '#a05a90', '#6a2c5c', '#c07aa8', '#8a4a7c', '#b06a98']),
        acc: P(['#fff4e0', '#ffe0c0', '#ffffff', '#ffd0d8']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.05, spec: 0.20, specPow: 60, rim: 0.24,
        light: { dir: [0.3, 0.85, -0.35], col: '#fff6f0', int: 1.4 }, amb: { col: '#ffe8e0', int: 1.0 }, head: 0.35,
        fog: { col: '#eccfcc', den: 0.1 }, bg: { a: '#f0c8c0', b: '#fff6f0' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.15, sat: 1.15, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [0.3314, 0.6704, -0.0364], fwd: [-0.023, -0.163, -0.986] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Frost Lace',
      program: 'kleinian', ...KFOAM,
      look: {
        base: P(['#0e3a5a', '#1e5a80', '#0a2c48', '#3a7aa0', '#16486a', '#2a6a90']),
        acc: P(['#e8fbff', '#c0f0ff', '#ffffff', '#a8e8ff']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.05, spec: 0.24, specPow: 60, rim: 0.24,
        light: { dir: [0.3, 0.85, -0.35], col: '#f4fbff', int: 1.4 }, amb: { col: '#e0f4ff', int: 1.0 }, head: 0.35,
        fog: { col: '#cfe6f2', den: 0.1 }, bg: { a: '#b8e0f4', b: '#f8fcff' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.15, sat: 1.1, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [-0.3716, 0.4834, -0.039], fwd: [-0.515, -0.404, -0.756] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    // --- variations of the two favourites: same foam, new viewpoints and palettes ---
    foam('Violet Drift', { pos: [-0.0449, 0.4211, -0.3097], fwd: [0.926, 0.351, 0.139] }, {
      base: ['#1a0b3c', '#3f1f7a', '#2a1358', '#5e35a8', '#432288', '#311a66'],
      acc: ['#8ad8ff', '#c8f0ff', '#b07aff', '#e8f8ff'], lightCol: '#eef0ff',
    }),
    foam('Ultraviolet', { pos: [1.1027, -0.0399, 0.2534], fwd: [-0.743, 0.663, -0.084] }, {
      base: ['#0d0620', '#241046', '#160a30', '#3a1a6e', '#2a1252', '#1b0c3a'],
      acc: ['#ff40e0', '#ff8af0', '#9a60ff', '#ffc0ff'], emissive: 0.22, lightCol: '#f4e8ff',
    }),
    foam('Lilac Mist', { pos: [0.2765, 1.2116, 0.0174], fwd: [-0.695, -0.043, 0.718] }, {
      bright: true,
      base: ['#9a8ec0', '#b4a8d4', '#8c80b0', '#c8bee0', '#a49ac8', '#bcb2d8'],
      acc: ['#fdf8ff', '#eadcff', '#ffffff', '#dce8ff'],
      fog: '#d8cfea', bgA: '#c0b4e4', bgB: '#f8f4ff', ambCol: '#e4dcff',
    }),
    foam('Jade Lace', { pos: [-1.8139, -0.0646, 0.0369], fwd: [-0.064, 0.701, 0.71] }, {
      bright: true,
      base: ['#7ca89a', '#9cc4b4', '#6e9a8c', '#b8d8cc', '#88b0a2', '#a8ccc0'],
      acc: ['#f0fffa', '#d8f4e8', '#ffffff', '#c8eee0'],
      fog: '#cfe8e0', bgA: '#b4ded2', bgB: '#f4fcf8', lightCol: '#f6fffb', ambCol: '#dff4ec',
    }),
    foam('Cobalt Bloom', { pos: [1.7188, -1.8471, -0.1265], fwd: [0.928, -0.352, 0.122] }, {
      base: ['#07122e', '#143a7a', '#0c2250', '#2558a8', '#1a4288', '#102c5e'],
      acc: ['#ff9a3c', '#ffc070', '#ff6a2a', '#ffe0a8'], lightCol: '#e8f0ff', fog: '#000208',
    }),
    foam('Porcelain', { pos: [1.202, 1.7795, -0.0302], fwd: [-0.402, 0.884, -0.241] }, {
      bright: true,
      base: ['#9aa3ad', '#b6bec7', '#8a939d', '#ccd4dc', '#a4adb6', '#c0c8d0'],
      acc: ['#ffffff', '#e8f0f8', '#f8fbff', '#d8e4f0'],
      fog: '#d8dee6', bgA: '#c2ccd8', bgB: '#f8fafc', lightCol: '#fdfeff', ambCol: '#e6ecf4', sat: 1.05,
    }),
    foam('Ruby Haze', { pos: [-1.7884, -1.4114, -0.2666], fwd: [-0.783, 0.349, 0.515] }, {
      base: ['#250812', '#6e1030', '#450a1f', '#a01848', '#7c1238', '#550d26'],
      acc: ['#ffb0c8', '#ffd8e0', '#ffc060', '#fff0f4'], lightCol: '#fff0f4',
    }),
    foam('Emerald Deep', { pos: [-1.6555, 1.8605, -0.0827], fwd: [-0.685, -0.015, -0.728] }, {
      base: ['#051a14', '#0e3f2e', '#092a20', '#17604a', '#10483a', '#0a3024'],
      acc: ['#a0ff70', '#d8ffb0', '#50e0c0', '#f0ffd8'], lightCol: '#eaffee', fog: '#000403',
    }),
    foam('Mint Glass', { pos: [-0.9581, -0.1128, 0.1056], fwd: [0.896, -0.391, 0.211] }, {
      bright: true,
      base: ['#8ab4b0', '#a8cfc8', '#789e9c', '#c0e0da', '#94bcb6', '#b4d4ce'],
      acc: ['#f4ffff', '#d0f6f0', '#ffffff', '#bceee8'],
      fog: '#cfe8ea', bgA: '#b8e2e0', bgB: '#f6fdfd', lightCol: '#f4ffff', ambCol: '#dcf6f4',
    }),
    foam('Sunset Foam', { pos: [0.0218, -1.5011, -0.4959], fwd: [-0.929, 0.033, 0.368] }, {
      base: ['#2e0a18', '#70182e', '#4a1020', '#9c3020', '#7e2028', '#581424'],
      acc: ['#ffd060', '#ffa040', '#ffe8a0', '#ff7050'], lightCol: '#fff0e0', fog: '#060102',
    }),
    foam('Copper Veil', { pos: [-0.3025, -0.3235, -0.1488], fwd: [0.966, -0.127, -0.226] }, {
      base: ['#2a1410', '#6e3420', '#48201a', '#9a4e2e', '#78381f', '#552a18'],
      acc: ['#60e0d0', '#a8f0e4', '#ffb070', '#d8fff8'], lightCol: '#fff2e8', fog: '#040201',
    }),
    {
      name: 'Coral Foam',
      program: 'kleinian',
      p0: [0.808, 0.808, 1.167, 1.0], p1: [0, 0, 0, 0.92784], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 2, min: 0.9, max: 1.4, rate: 0.05 }, audio: kleinAudio,
      look: {
        base: P(['#3a2a28', '#7f5c5f', '#c46a58', '#a48787', '#473b39', '#d88470']),
        acc: P(['#4dc2ab', '#c2a9c6', '#e050c8', '#5fd8c0']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.6, 0.0, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.09, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.3, 0.8, -0.4], col: '#fff2ec', int: 0.9 }, amb: { col: '#ffffff', int: 1.0 }, head: 0.35,
        fog: { col: '#000000', den: 0.08 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: KLEIN_A, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      name: 'Teal Bubbles',
      program: 'kleinian',
      p0: [0.92436, 0.90756, 0.92436, 1.0], p1: [0, 0, 0, 0.012], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 1, min: 0.78, max: 1.05, rate: 0.05 }, audio: kleinAudio,
      look: {
        base: P(['#1c3139', '#2f6778', '#384b53', '#468ca1', '#1c3139', '#847f78']),
        acc: P(['#5fb6c8', '#9ad8e4', '#c8c0b0', '#6fd0e0']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.5, 0.5, 0.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.07, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [-0.3, 0.8, -0.5], col: '#f0fbff', int: 1.0 }, amb: { col: '#ffffff', int: 0.9 }, head: 0.35,
        fog: { col: '#020809', den: 0.1 }, bg: { a: '#020809', b: '#081516' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: KLEIN_B, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },

    {
      name: 'Toxic Bloom',
      program: 'mandelbox',
      p0: [2.5, 0.25, 1.0, 0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 0, min: 2.0, max: 3.2, rate: 0.12 }, audio: boxAudio,
      look: {
        base: P(['#142810', '#2c681e', '#1c4212', '#48a42e', '#307a24', '#22581a']),
        acc: P(['#b6ff3a', '#e4ff9a', '#6cffb0', '#ffffff']),
        trapW: [0.3, 0.3, 0.3, 0.2], accW: [0.0, 0.0, 0.0, 1.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.18, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.4, 0.8, -0.3], col: '#eaffd8', int: 0.9 }, amb: { col: '#ffffff', int: 1.1 }, head: 0.45,
        fog: { col: '#020602', den: 0.06 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.3, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: { pos: [-3.0217, -2.8035, 2.1872], fwd: [-0.298, 0.943, -0.147] }, speed: 0.8, scaleClamp: [0.002, 0.6], far: 14,
    },

    {
      name: 'Opal Bubbles',
      program: 'apollonian',
      p0: [1.22, 0, 0, 0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 0, min: 1.05, max: 1.45, rate: 0.06 }, audio: (u, a) => { u.p0[0] += a.bass * 0.02; },
      look: {
        base: P(['#6f8fa0', '#8aa8b4', '#a49cc0', '#7aa49a', '#b4aecb', '#90b0b8']),
        acc: P(['#f4f0ff', '#e0f4ee', '#ffe8f4', '#ffffff']),
        trapW: [0.0, 0.3, 0.0, 0.7], accW: [0.6, 0.6, 0.6, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.10, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [-0.4, 0.8, 0.3], col: '#fbfff8', int: 1.2 }, amb: { col: '#ffffff', int: 0.95 }, head: 0.4,
        fog: { col: '#cfe4e0', den: 0.1 }, bg: { a: '#b8dcd6', b: '#f2faf8' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: { pos: [-0.5768, -0.1156, 0.9267], fwd: [0.897, -0.404, -0.181] }, speed: 0.8, scaleClamp: [0.004, 0.4], far: 14,
    },
    {
      name: 'Rose Reef',
      program: 'kleinian',
      p0: [0.92436, 0.90756, 0.92436, 1.0], p1: [0, 0, 0, 0.012], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 1, min: 0.78, max: 1.05, rate: 0.05 }, audio: kleinAudio,
      look: {
        base: P(['#57242f', '#b10f50', '#df1899', '#726954', '#b54a81', '#df1899']),
        acc: P(['#d286b5', '#ffffff', '#a0c060', '#ff60c0']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.5, 0.5, 0.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.09, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.3, 0.8, -0.5], col: '#fff4f8', int: 1.0 }, amb: { col: '#ffffff', int: 0.95 }, head: 0.35,
        fog: { col: '#080304', den: 0.08 }, bg: DARK,
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.35, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: KLEIN_B, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },

    {
      name: 'Silver Spires',
      program: 'menger',
      p0: [3.0, 1.0, 1.0, 1.0], p1: [2.4, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0.18, 0.0, 0.12],
      morph: { key: 'rot', idx: 1, min: -0.5, max: 0.5, rate: 0.12 },
      audio: (u, a) => { u.rot = [u.rot[0] + a.bass * 0.02, u.rot[1] + a.mid * 0.015, u.rot[2]]; },
      look: {
        base: P(['#3e4745', '#59685f', '#abb1a6', '#83758c', '#59685f', '#dcdad7']),
        acc: P(['#7aa372', '#d080c0', '#a0e090', '#ffffff']),
        trapW: [0.3, 0.3, 0.3, 0.0], accW: [0.0, 0.0, 1.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.07, spec: 0.06, specPow: 32, rim: 0.07,
        light: { dir: [0.45, 0.75, 0.35], col: '#ffffff', int: 1.0 }, amb: { col: '#f0f2ff', int: 0.75 }, head: 0.4,
        fog: { col: '#3e464f', den: 1.6 }, bg: { a: '#2a3038', b: '#4a525c' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.0, sat: 1.0, contrast: 1.05, bloom: 0.02 },
      },
      cam: { pos: [0.3, 0.25, 0.1], fwd: [0.3, -0.2, 1] }, speed: 0.8, scaleClamp: [0.002, 0.6], far: 14,
    },

    // --- three more in the Silver Spires family: same Menger towers, different fold
    // scale, cell size and light. Cameras scouted against the real distance field. ---
    {
      name: 'Obsidian Spires',
      program: 'menger',
      p0: [3.0, 1.0, 1.0, 1.0], p1: [2.4, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0.18, 0.0, 0.12],
      morph: { key: 'rot', idx: 1, min: -0.5, max: 0.5, rate: 0.12 },
      look: {
        base: P(['#373944', '#63687a', '#464b58', '#979fb9', '#727a8f', '#535b6b']),
        acc: P(['#ff8a3c', '#ffc27a', '#ff5e2a', '#ffe0b0']),
        trapW: [0.3, 0.3, 0.3, 0.0], accW: [0.0, 0.0, 1.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.20, spec: 0.08, specPow: 40, rim: 0.10,
        light: { dir: [0.4, 0.75, -0.4], col: '#ffd0a0', int: 1.0 }, amb: { col: '#9fb0cf', int: 0.9 }, head: 0.35,
        fog: { col: '#2a2f3e', den: 1.6 }, bg: { a: '#12141c', b: '#333a4c' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.4, sat: 1.0, contrast: 1.08, bloom: 0.04 },
      },
      cam: { pos: [0.4028, 1.1862, -1.0514], fwd: [-0.659, -0.196, -0.726] }, speed: 0.8, scaleClamp: [0.002, 0.6], far: 14,
    },
    {
      name: 'Cathedral',
      program: 'menger',
      p0: [2.6, 1.2, 0.8, 1.0], p1: [4.0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0.1, 0.0, 0.45],
      morph: { key: 'rot', idx: 2, min: 0.1, max: 0.8, rate: 0.1 },
      look: {
        base: P(['#b4a890', '#cfc4ac', '#9c907a', '#e4dcc8', '#c0b49c', '#d8ccb4']),
        acc: P(['#fff8e8', '#ffffff', '#ffe8c0', '#f0f4ff']),
        trapW: [0.3, 0.3, 0.3, 0.0], accW: [0.0, 0.0, 1.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.04, spec: 0.16, specPow: 50, rim: 0.20,
        light: { dir: [0.25, 0.9, -0.3], col: '#fff4e0', int: 1.5 }, amb: { col: '#dce8ff', int: 1.0 }, head: 0.3,
        fog: { col: '#cfd8e4', den: 0.55 }, bg: { a: '#b8c8dc', b: '#f4f8ff' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.1, sat: 1.05, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [-1.6518, 0.2246, -0.3191], fwd: [-0.652, -0.095, -0.753] }, speed: 0.8, scaleClamp: [0.002, 0.7], far: 16,
    },
    {
      name: 'Verdigris Lattice',
      program: 'menger',
      p0: [3.0, 1.0, 1.0, 1.0], p1: [2.4, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0.18, 0.0, 0.12],
      morph: { key: 'rot', idx: 0, min: -0.2, max: 0.6, rate: 0.12 },
      look: {
        base: P(['#225b4c', '#378d72', '#1b4439', '#57c9a3', '#42a081', '#2c6e5b']),
        acc: P(['#7fe8c0', '#c0f4e0', '#ffb86c', '#eafff6']),
        trapW: [0.3, 0.3, 0.3, 0.0], accW: [0.0, 0.0, 1.0, 0.0], col: [0.22, 0.3, 0.6, 0.14],
        emissive: 0.12, spec: 0.10, specPow: 44, rim: 0.12,
        light: { dir: [-0.35, 0.8, 0.35], col: '#eafff8', int: 1.1 }, amb: { col: '#bfe4da', int: 1.0 }, head: 0.4,
        fog: { col: '#1d5248', den: 1.5 }, bg: { a: '#0e2620', b: '#2a6454' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.4, sat: 1.05, contrast: 1.05, bloom: 0.03 },
      },
      cam: { pos: [-0.0642, -1.1959, -0.2086], fwd: [0.437, 0.001, 0.9] }, speed: 0.8, scaleClamp: [0.002, 0.5], far: 12,
    },

    // --- three different shapes entirely, to break up the bubbles ---
    {
      // one organic bulb seen from outside, not a cave you fly through
      name: 'Ivory Bulb',
      program: 'mandelbulb',
      p0: [8.0, 0, 0, 0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p0', idx: 0, min: 5.0, max: 11.0, rate: 0.5 },
      look: {
        base: P(['#baa69a', '#f7e0ce', '#95857a', '#ffffff', '#d9c4b2', '#fffae7']),
        acc: P(['#fff4e4', '#ffd9a8', '#ffffff', '#ffe8d0']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.5, 0.0, 0.5, 0.0], col: [0.3, 0.45, 0.55, 0.16],
        emissive: 0.05, spec: 0.22, specPow: 56, rim: 0.26,
        light: { dir: [0.45, 0.7, -0.4], col: '#fff2e0', int: 1.5 }, amb: { col: '#a8bcd8', int: 1.05 }, head: 0.25,
        fog: { col: '#05060a', den: 0.05 }, bg: { a: '#04050a', b: '#121828' },
        ao: { strength: 0.65, cavity: 0.8, steps: 0.15 },
        post: { exposure: 1.4, sat: 1.0, contrast: 1.08, bloom: 0.04 },
      },
      cam: { pos: [-0.4498, -1.396, 0.537], fwd: [0.352, 0.887, -0.299] }, speed: 0.5, scaleClamp: [0.003, 0.5], far: 10,
    },
    {
      // hard flat faces and sharp edges: the opposite of the foam
      name: 'Quartz Shards',
      program: 'sierpinski',
      p0: [2.0, 1.0, 1.0, 1.0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0.1, 0.2, 0.0],
      morph: { key: 'rot', idx: 1, min: 0.0, max: 0.6, rate: 0.08 },
      look: {
        base: P(['#685f90', '#998cd1', '#4c4473', '#d1bfff', '#a99bf5', '#7c70b2']),
        acc: P(['#d8ccff', '#ffffff', '#9ad8ff', '#f0e8ff']),
        trapW: [0.3, 0.3, 0.3, 0.0], accW: [0.0, 0.0, 1.0, 0.0], col: [0.26, 0.36, 0.7, 0.12],
        emissive: 0.10, spec: 0.26, specPow: 64, rim: 0.24,
        light: { dir: [0.35, 0.8, -0.45], col: '#f4f0ff', int: 1.4 }, amb: { col: '#c4d0f0', int: 1.05 }, head: 0.3,
        fog: { col: '#0a0a14', den: 0.25 }, bg: { a: '#07070f', b: '#1a1830' },
        ao: { strength: 0.6, cavity: 0.75, steps: 0.15 },
        post: { exposure: 1.4, sat: 1.05, contrast: 1.1, bloom: 0.05 },
      },
      cam: { pos: [0.215, 0.8374, 0.9612], fwd: [-0.25, -0.648, -0.719] }, speed: 0.7, scaleClamp: [0.002, 0.5], far: 12,
    },
    {
      // a field of separate objects rather than one connected surface
      name: 'Drift Belt',
      program: 'asteroids',
      p0: [8.0, 2.0, 1.0, 0], p1: [2.0, 0.25, 0, 0], p2: [0, 0, 0, 0], rot: [0, 0, 0],
      morph: { key: 'p1', idx: 1, min: 0.0, max: 0.55, rate: 0.1 },
      look: {
        base: P(['#6e675b', '#a29483', '#504a41', '#d1c2af', '#877d6a', '#b6a794']),
        acc: P(['#9cd8ff', '#d8f0ff', '#ffc890', '#ffffff']),
        trapW: [0.0, 0.0, 0.0, 1.0], accW: [0.5, 0.0, 0.5, 0.0], col: [0.28, 0.4, 0.6, 0.14],
        emissive: 0.06, spec: 0.14, specPow: 48, rim: 0.22,
        light: { dir: [0.5, 0.55, -0.4], col: '#fff4e8', int: 1.6 }, amb: { col: '#7a92b8', int: 0.85 }, head: 0.2,
        fog: { col: '#020306', den: 0.04 }, bg: { a: '#010205', b: '#0a1020' },
        ao: { strength: 0.6, cavity: 0.7, steps: 0.15 },
        post: { exposure: 1.45, sat: 1.05, contrast: 1.08, bloom: 0.05 },
      },
      cam: { pos: [1.0, 1.0, 1.0], fwd: [-0.42, -0.26, 0.87] }, speed: 0.8, scaleClamp: [0.004, 0.8], far: 18,
    },
  ];

  // Running order. Shapes are interleaved on purpose: every third world is a non-foam
  // shape, so you never get a long run of the same bubbles.
  const ORDER = [
    'Magenta Foam', 'Fractal Light', 'Silver Spires',
    'Orchid Ember', 'Abyssal Foam', 'Ivory Bulb',
    'Pearl Lace', 'Violet Drift', 'Obsidian Spires',
    'Frost Lace', 'Ultraviolet', 'Quartz Shards',
    'Lilac Mist', 'Jade Lace', 'Toxic Bloom',
    'Cobalt Bloom', 'Porcelain', 'Cathedral',
    'Ruby Haze', 'Emerald Deep', 'Drift Belt',
    'Mint Glass', 'Sunset Foam', 'Verdigris Lattice',
    'Copper Veil', 'Coral Foam', 'Opal Bubbles',
    'Teal Bubbles', 'Rose Reef',
  ];
  const byName = new Map(scenes.map((sc) => [sc.name, sc]));
  const ordered = ORDER.map((n) => {
    const sc = byName.get(n);
    if (!sc) throw new Error('scene order lists an unknown scene: ' + n);
    byName.delete(n);
    return sc;
  });
  // anything added later but not placed in ORDER still shows up, at the end
  for (const sc of byName.values()) ordered.push(sc);

  FV.fractals = { programs, scenes: ordered };
})(window.FV);
