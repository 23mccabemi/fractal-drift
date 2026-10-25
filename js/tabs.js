// Tabs: separate worlds, switched with L1 / R1 (or , and .). Arrows still move between
// the scenes inside the current tab, and each tab remembers where you were.
//
// A tab is { id, name, kind, scenes }. Everything is drawn by the raymarch pipeline,
// so a new world is a distance estimator plus art direction.
'use strict';
(function (FV) {
  const P = (hexes) => hexes.map(FV.hexToRgb);

  // Shared art direction for the canyon scenes: the same colour machinery as the fractals
  // (orbit-trap palette + accent rings), so the music drives them identically.
  const world = (o) => ({
    base: P(o.base), acc: P(o.acc),
    trapW: o.trapW || [0.0, 0.0, 0.0, 1.0], accW: o.accW || [0.5, 0.0, 0.5, 0.0],
    col: o.col || [0.26, 0.4, 0.6, 0.15],
    emissive: o.emissive ?? 0.16, spec: o.spec ?? 0.1, specPow: 44, rim: o.rim ?? 0.14,
    light: { dir: o.lightDir || [0.35, 0.8, -0.4], col: o.lightCol || '#ffffff', int: o.lightInt ?? 1.1 },
    amb: { col: o.ambCol || '#ffffff', int: o.ambInt ?? 0.9 }, head: o.head ?? 0.4,
    fog: { col: o.fog, den: o.fogDen ?? 0.3 },
    bg: { a: o.bgA, b: o.bgB },
    ao: { strength: 0.6, cavity: 0.7, steps: 0.15 },
    post: { exposure: o.exposure ?? 1.3, sat: o.sat ?? 1.05, contrast: 1.06, bloom: o.bloom ?? 0.04 },
  });

  // ---- Canyon -------------------------------------------------------------------
  // p0 = [height, frequency]; you fly above an endless ridged landscape
  const canyonScene = (name, p0, look, cam) => ({
    name, program: 'canyon',
    p0: [p0[0], p0[1], 0, 0], p1: [0, 0, 0, 0], p2: [0, 0, 0, 0], rot: [0, 0, 0],
    morph: { key: 'p0', idx: 0, min: 0.4, max: 2.4, rate: 0.3 },
    look, cam, speed: 1.4, scaleClamp: [0.02, 3.0], far: 60,
  });

  const canyonScenes = [
    canyonScene('Dune Sea', [1.2, 0.55], world({
      base: ['#6e4a2a', '#9a6e40', '#523418', '#c89a60', '#7e5630', '#b0824c'],
      acc: ['#ffe0a8', '#fff4d8', '#ff9a50', '#ffffff'],
      emissive: 0.08, spec: 0.06, rim: 0.1,
      fog: '#e0b888', fogDen: 0.12, bgA: '#d8a870', bgB: '#f8e8c8',
      lightDir: [0.4, 0.45, -0.6], lightCol: '#fff0d0', lightInt: 1.6, ambCol: '#c8b090', ambInt: 0.8,
      exposure: 1.15, head: 0.1,
    }), { pos: [0, 3.2, 0], fwd: [0.1, -0.18, 1] }),
    canyonScene('Night Ridge', [1.6, 0.5], world({
      base: ['#1e2e57', '#395794', '#131e3d', '#6398ef', '#4167ba', '#2e4c81'],
      acc: ['#8ab0ff', '#d0e0ff', '#ff80c0', '#ffffff'],
      emissive: 0.2, spec: 0.12, rim: 0.18,
      fog: '#0a1020', fogDen: 0.18, bgA: '#05080f', bgB: '#16203c',
      lightDir: [-0.3, 0.5, -0.5], lightCol: '#b8d0ff', lightInt: 1.5, ambCol: '#405878', ambInt: 1.0,
      exposure: 1.5, head: 0.15, bloom: 0.06,
    }), { pos: [0, 3.6, 0], fwd: [-0.15, -0.16, 1] }),
    canyonScene('Ember Flats', [0.9, 0.7], world({
      base: ['#47111b', '#a02c33', '#691b22', '#ee4e41', '#bb3a36', '#7e2229'],
      acc: ['#ffb060', '#ffe0a0', '#ff5030', '#fff0c8'],
      emissive: 0.26, spec: 0.08, rim: 0.14,
      fog: '#200608', fogDen: 0.16, bgA: '#140306', bgB: '#3a1010',
      lightDir: [0.5, 0.35, -0.5], lightCol: '#ffc890', lightInt: 1.6, ambCol: '#8a4a40', ambInt: 0.95,
      exposure: 1.45, head: 0.12, bloom: 0.07,
    }), { pos: [0, 2.6, 0], fwd: [0.2, -0.2, 1] }),
  ];

  FV.tabs = [
    { id: 'fractals', name: 'Fractals', kind: 'march', get scenes() { return FV.fractals.scenes; } },
    { id: 'canyon', name: 'Canyon', kind: 'march', scenes: canyonScenes },
  ];
})(window.FV);
