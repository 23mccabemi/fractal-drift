// GLSL sources. The raymarch shader is assembled per fractal: header + uniforms
// + the fractal's distance estimator + the shared lighting/march body.
'use strict';
(function (FV) {
  const HEADER = `#version 300 es
precision highp float;
precision highp int;
`;

  const VS_FULLSCREEN = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Uniforms shared by the march + probe passes.
  const SCENE_UNIFORMS = `
uniform vec2  uRes;
uniform vec2  uJitter;
uniform vec3  uCamPos;
uniform mat3  uCamRot;
uniform float uTanHalf;
uniform float uTime;
uniform vec4  uAudio;      // bass, mid, high, energy (0..1)
uniform float uBeat;       // decaying beat pulse 0..1
uniform vec4  uP0;
uniform vec4  uP1;
uniform vec4  uP2;
uniform mat3  uRot;        // per-fractal fold rotation
uniform float uScale;      // smoothed local scene scale (distance to surface at camera)
uniform float uStepFactor;
uniform float uFar;
// runtime-opaque zero: stops the D3D compiler from unrolling/inlining loops (much faster compiles)
#define ZERO (min(int(uFar), 0))
`;

  const MARCH_UNIFORMS = `
uniform int   uMaxSteps;
uniform float uDetail;
uniform int   uShadowSteps;
uniform int   uAOSteps;
uniform float uAOStrength;
uniform vec3  uLightDir;
uniform vec3  uLightCol;
uniform vec3  uAmbCol;
uniform float uHeadlight;
uniform vec3  uFogCol;
uniform float uFogDen;
uniform vec3  uBase[6];
uniform vec3  uAcc[4];
uniform vec4  uTrapW;      // weights of log(orbit traps) -> main palette coordinate
uniform vec4  uAccW;       // weights of log(orbit traps) -> ring/accent coordinate
uniform vec4  uCol;        // x: palette frequency, y: ring frequency, z: palette sharpness, w: ring width
uniform float uPalShift;
uniform float uEmissive;
uniform float uSpec;
uniform float uSpecPow;
uniform float uCavity;
uniform float uShadowFloor;
uniform vec3  uBgA;
uniform vec3  uBgB;
uniform float uRimLight;
uniform float uContrastAO;
uniform sampler2D uCone;   // coarse pre-pass: (safe start distance, steps used) per 4x4 block
uniform int   uUseCone;
uniform float uRelax;
uniform float uAAFilter;   // 1 = band-limit colours that are far finer than a pixel      // over-relaxation factor for the sphere tracer (1 = off)
uniform float uRingPhase;  // bass-driven flow of the rings through the structure
uniform float uRingSwell;  // bass-driven ring width multiplier
uniform float uShimmer;    // hat/snare pulse -> sparkle on surfaces
uniform float uWarp;       // 1 = flowing, marbled colour bands; 0 = calm (colours change in place)
uniform float uHue;        // global hue rotation (radians) - calm-mode colour response
uniform float uAmbGain;    // bass-driven ambient light level
`;

  const COMMON_FUNCS = `
float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
`;

  const MARCH_BODY = `
out vec4 fragColor;

float DE(vec3 p){ vec4 t = vec4(1e10); return fractal(p, t); }

vec3 calcNormal(vec3 p, float e){
  vec3 n = vec3(0.0);
  for(int i=ZERO; i<4; i++){
    vec3 k = 0.5773*(2.0*vec3(float(((i+3)>>1)&1), float((i>>1)&1), float(i&1)) - 1.0);
    n += k*DE(p + k*e);
  }
  return normalize(n);
}

// cyclic 6-colour gradient; sharpness 0 = smooth blend, 1 = hard bands
vec3 palette(float u){
  u = fract(u) * 6.0;
  int i = int(u);
  float f = fract(u);
  float w = mix(0.5, 0.04, uCol.z);
  f = smoothstep(0.5 - w, 0.5 + w, f);
  return mix(uBase[i], uBase[(i+1)%6], f);
}
vec3 accent(float u){
  u = fract(u) * 4.0; int i = int(u);
  return mix(uAcc[i], uAcc[(i+1)%4], smoothstep(0.3, 0.7, fract(u)));
}

// Mandelbulb3D-style orbit colouring: log-scaled traps give concentric rings and rims
// around every bubble/cell, at every scale of the fractal.
vec3 hueRotate(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return max(c*ca + cross(k, c)*sin(a) + k*dot(k, c)*(1.0 - ca), 0.0);
}

void colorize(vec4 trap, out vec3 alb, out vec3 emi){
  vec4 lt = log2(max(trap, vec4(1e-6)));
  // calm mode uses broader bands, so the surface reads as texture rather than swirling liquid
  float u = dot(lt, uTrapW) * uCol.x * mix(0.55, 1.0, uWarp) + uPalShift;
  float v = dot(lt, uAccW) * uCol.y + (uPalShift * 0.5 + uRingPhase) * uWarp;
  // Anti-aliasing: how many colour bands / rings fall inside this pixel (screen derivatives).
  // Where it is more than about one, use their average colour instead of a random pick -
  // that random pick is what reads as grain on distant, sub-pixel detail.
  float fu = min(fwidth(u), 4.0), fv = min(fwidth(v), 4.0);
  vec3 palAvg = (uBase[0] + uBase[1] + uBase[2] + uBase[3] + uBase[4] + uBase[5]) / 6.0;
  vec3 accAvg = (uAcc[0] + uAcc[1] + uAcc[2] + uAcc[3]) * 0.25;
  float bu = smoothstep(0.35, 1.3, fu) * uAAFilter;
  alb = mix(palette(u), palAvg, bu);
  float w = uCol.w * uRingSwell;
  float ring = 1.0 - smoothstep(0.0, w, abs(fract(v) - 0.5) * 2.0);
  float bv = smoothstep(0.7, 2.2, fv) * uAAFilter;
  ring = mix(ring, w * 0.5, bv);                       // average ring coverage
  vec3 ac = mix(accent(floor(v) * 0.25 + u * 0.15), accAvg, max(bu, bv));
  alb = mix(alb, ac, ring);
  alb = hueRotate(alb, uHue);
  emi = hueRotate(ac, uHue) * ring * uEmissive;
}

float calcAO(vec3 p, vec3 n, float h0){
  float occ = 0.0, ws = 0.0, h = h0, w = 1.0;
  for(int i=ZERO; i<8; i++){
    if(i >= uAOSteps) break;
    float d = DE(p + n*h);
    occ += w * clamp((h - d)/h, 0.0, 1.0);
    ws += w;
    h *= 3.0; w *= 0.8;
  }
  return pow(clamp(1.0 - occ/max(ws, 1e-4), 0.0, 1.0), uAOStrength);
}

float softShadow(vec3 ro, vec3 rd, float mint, float maxt){
  float res = 1.0, t = mint;
  for(int i=ZERO; i<64; i++){
    if(i >= uShadowSteps) break;
    float h = DE(ro + rd*t);
    res = min(res, 8.0*h/t);
    t += clamp(h, mint*0.5, maxt*0.1);
    if(res < 0.01 || t > maxt) break;
  }
  return clamp(res, 0.0, 1.0);
}

void main(){
  vec2 frag = gl_FragCoord.xy + uJitter;
  vec2 ndc = (frag - 0.5*uRes) / uRes.y * 2.0 * uTanHalf;
  vec3 rd = uCamRot * normalize(vec3(ndc, 1.0));
  vec3 ro = uCamPos;

  float pix = 2.0*uTanHalf/uRes.y * uDetail;
  float t = 0.0, d = 1e10;
  int steps = 0, preSteps = 0;
  bool hit = false;
  if(uUseCone == 1){
    vec2 cs = texelFetch(uCone, ivec2(gl_FragCoord.xy) / 4, 0).rg;
    t = cs.x; preSteps = int(cs.y);
  }
  // over-relaxed sphere tracing (Keinert et al. 2014): take longer steps through empty
  // space, fall back to a normal step whenever two spheres stop overlapping
  float omega = uRelax, prevR = 0.0, stepLen = 0.0;
  int budget = uMaxSteps - preSteps / 2;
  for(int i=ZERO; i<1024; i++){
    if(i >= budget){ steps = i; hit = t < uFar; break; }
    d = DE(ro + rd*t);
    float r = abs(d);
    bool fail = omega > 1.0 && (r + prevR) < stepLen;
    if(fail){ stepLen -= omega*stepLen; omega = 1.0; }
    else {
      if(d < max(pix*t, 1e-7)){ hit = true; steps = i; break; }
      stepLen = d*uStepFactor*omega;
    }
    prevR = r;
    t += stepLen;
    if(t > uFar){ steps = i; break; }
  }
  steps += preSteps;

  vec3 col;
  float tOut = 60000.0;
  if(hit){
    vec3 p = ro + rd*t;
    float eps = max(pix*t, 1e-7);
    vec3 n = calcNormal(p - rd*eps*0.5, eps*0.5);
    vec4 trap = vec4(1e10);
    fractal(p, trap);
    vec3 alb, emi;
    colorize(trap, alb, emi);

    // How far this pixel is into the scene (0 near, 1 at the far plane). uFar already
    // tracks the zoom level, so this stays meaningful at every scale.
    float dist01 = clamp(t/max(uFar, 1e-9), 0.0, 1.0);
    float farFade = smoothstep(0.12, 0.55, dist01);

    float occ = calcAO(p, n, eps*4.0);
    float sao = 1.0 - float(steps)/float(uMaxSteps);           // step-count cavity term
    // the step count swings wildly between neighbouring grazing rays, so fade that term out
    // with distance - it is the main source of grain on fine detail far away
    occ *= mix(1.0, sao, uContrastAO * (1.0 - 0.85*farFade));
    float cav = mix(1.0, occ, uCavity);                         // extra darkening of deep crevices

    float dif = max(dot(n, uLightDir), 0.0);
    float sh = 1.0;
    if(uShadowSteps > 0 && dif > 0.0) sh = mix(uShadowFloor, 1.0, softShadow(p + n*eps*3.0, uLightDir, eps*6.0, uScale*4.0 + t*0.5));
    float hd = max(dot(n, -rd), 0.0);
    float fre = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 4.0);
    vec3 H = normalize(uLightDir - rd);
    float spe = pow(max(dot(n, H), 0.0), uSpecPow) * dif;

    // calibrated so an open, lit surface shows roughly its palette colour (palettes come from the
    // reference frames, which already contain their lighting)
    vec3 lin = uAmbCol * (0.8 + 0.2*n.y) * uAmbGain;
    lin += uLightCol * dif * sh * 0.45;
    lin += uHeadlight * hd * 0.4;
    col = alb * lin * cav;
    col += uSpec * spe * sh * cav * uLightCol;
    col += alb * fre * cav * uRimLight;
    col += emi * (0.4 + 0.6*cav);
    // hats/snares: brief glint on rims facing the camera, scattered by the orbit pattern
    float glint = smoothstep(0.55, 1.0, fract(dot(log2(max(trap.xyz, vec3(1e-6))), vec3(1.7, 2.3, 2.9))));
    col += uShimmer * glint * pow(hd, 6.0) * 0.25 * cav * (alb + 0.3) * (1.0 - farFade);

    // depth fog measured in units of the current zoom scale, gentle so far structure stays visible
    float fd = t / (uScale*40.0 + 1e-9);
    col = mix(col, uFogCol, 1.0 - exp(-fd*uFogDen));
    tOut = t;
  } else {
    col = mix(uBgA, uBgB, 0.5 + 0.5*rd.y);
  }
  fragColor = vec4(max(col, vec3(0.0)), min(tOut, 60000.0));
}
`;

  // Coarse pre-pass (cone marching): one ray per 4x4 block, stopping as soon as the cone
  // around it could touch the surface. Every ray in the block can safely start from there.
  const CONE_BODY = `
out vec4 fragColor;
uniform float uConeK;
float DE(vec3 p){ vec4 t = vec4(1e10); return fractal(p, t); }
void main(){
  vec2 ndc = (gl_FragCoord.xy - 0.5*uRes)/uRes.y * 2.0 * uTanHalf;
  vec3 rd = uCamRot * normalize(vec3(ndc, 1.0));
  float t = 0.0, safe = 0.0;
  int n = 0;
  for(int i=ZERO; i<200; i++){
    float d = DE(uCamPos + rd*t);
    if(d < uConeK*t + 1e-7 || t > uFar) break;
    safe = t;
    t += d*uStepFactor;
    n = i + 1;
  }
  fragColor = vec4(safe, float(n), 0.0, 1.0);
}
`;

  // Probe pass: 8x1 pixels. px0 = (DE at camera, gradient). px1..7 = free distance along
  // a cone of directions around the view axis (for autopilot steering + speed control).
  const PROBE_BODY = `
out vec4 fragColor;
float DE(vec3 p){ vec4 t = vec4(1e10); return fractal(p, t); }
void main(){
  int ix = int(gl_FragCoord.x);
  if(ix == 0){
    float d = DE(uCamPos);
    float e = max(d*0.05, 1e-7);
    vec3 n = vec3(DE(uCamPos+vec3(e,0,0)) - DE(uCamPos-vec3(e,0,0)),
                  DE(uCamPos+vec3(0,e,0)) - DE(uCamPos-vec3(0,e,0)),
                  DE(uCamPos+vec3(0,0,e)) - DE(uCamPos-vec3(0,0,e)));
    fragColor = vec4(d, normalize(n + 1e-12));
    return;
  }
  vec3 dir = vec3(0.0, 0.0, 1.0);
  if(ix > 1){
    float a = 0.5;
    float th = float(ix-2) * 6.2831853 / 6.0;
    dir = vec3(sin(a)*cos(th), sin(a)*sin(th), cos(a));
  }
  vec3 rd = uCamRot * dir;
  float t = 0.0;
  for(int i=0; i<200; i++){
    float d = DE(uCamPos + rd*t);
    if(d < max(t*0.002, 1e-7)) break;
    t += d*uStepFactor;
    if(t > uFar) break;
  }
  fragColor = vec4(min(t, uFar), 0.0, 0.0, 1.0);
}
`;

  // Temporal upsampling: low-res jittered samples are accumulated into a history buffer at
  // display resolution. Still frames converge to near-native sharpness.
  const FS_TAA = HEADER + `
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform vec2 uCurRes;
uniform vec2 uHistRes;
uniform vec2 uJitter;
uniform vec3 uCamPos, uPrevCamPos;
uniform mat3 uCamRot, uPrevCamRot;
uniform float uTanHalf;
uniform float uBlend;
uniform float uMotionAlpha;
uniform float uFar;
uniform float uClipLo, uClipHi;
uniform int uReset;
out vec4 fragColor;

vec3 toYCoCg(vec3 c){ return vec3(0.25*c.r+0.5*c.g+0.25*c.b, 0.5*c.r-0.5*c.b, -0.25*c.r+0.5*c.g-0.25*c.b); }
vec3 fromYCoCg(vec3 c){ return vec3(c.x+c.y-c.z, c.x+c.z, c.x-c.y-c.z); }
// compress HDR before statistics so bright emissive pixels do not dominate
vec3 tm(vec3 c){ return c/(1.0+max(c.r,max(c.g,c.b))); }
vec3 itm(vec3 c){ return c/max(1.0-max(c.r,max(c.g,c.b)), 1e-4); }

vec4 sampleCatmull(sampler2D tex, vec2 uv, vec2 res){
  vec2 sp = uv*res; vec2 tp1 = floor(sp-0.5)+0.5; vec2 f = sp-tp1;
  vec2 w0 = f*(-0.5+f*(1.0-0.5*f)); vec2 w1 = 1.0+f*f*(-2.5+1.5*f);
  vec2 w2 = f*(0.5+f*(2.0-1.5*f)); vec2 w3 = f*f*(-0.5+0.5*f);
  vec2 w12 = w1+w2; vec2 off12 = w2/w12;
  vec2 tp0 = (tp1-1.0)/res, tp3 = (tp1+2.0)/res, tp12 = (tp1+off12)/res;
  vec4 r = vec4(0.0);
  r += texture(tex, vec2(tp0.x, tp0.y))*w0.x*w0.y;  r += texture(tex, vec2(tp12.x, tp0.y))*w12.x*w0.y;  r += texture(tex, vec2(tp3.x, tp0.y))*w3.x*w0.y;
  r += texture(tex, vec2(tp0.x, tp12.y))*w0.x*w12.y; r += texture(tex, vec2(tp12.x, tp12.y))*w12.x*w12.y; r += texture(tex, vec2(tp3.x, tp12.y))*w3.x*w12.y;
  r += texture(tex, vec2(tp0.x, tp3.y))*w0.x*w3.y;  r += texture(tex, vec2(tp12.x, tp3.y))*w12.x*w3.y;  r += texture(tex, vec2(tp3.x, tp3.y))*w3.x*w3.y;
  return max(r, vec4(0.0));
}

void main(){
  vec2 o = gl_FragCoord.xy;
  vec2 s = o / uHistRes * uCurRes;                 // position in low-res pixel units
  float r = min(uCurRes.x / uHistRes.x, 1.0);      // low-res pixels per display pixel
  ivec2 ib = ivec2(floor(s - uJitter));
  ivec2 mx = ivec2(uCurRes) - 1;
  vec3 cs = vec3(0.0), cl = vec3(0.0), m1 = vec3(0.0), m2 = vec3(0.0);
  float ws = 0.0, wl = 0.0, tmin = 1e9, tmax = 0.0, tnear = 0.0;
  for(int y=-1; y<=1; y++) for(int x=-1; x<=1; x++){
    ivec2 ip = clamp(ib + ivec2(x, y), ivec2(0), mx);
    vec4 smp = texelFetch(uCur, ip, 0);
    vec2 d = s - (vec2(ip) + 0.5 + uJitter);
    vec2 dd = d / r;
    float w1 = exp(-2.2*dot(dd, dd));
    float w2 = exp(-1.4*dot(d, d));
    cs += smp.rgb*w1; ws += w1;
    cl += smp.rgb*w2; wl += w2;
    vec3 c = toYCoCg(tm(smp.rgb));
    m1 += c; m2 += c*c;
    tmin = min(tmin, smp.a);
    tmax = max(tmax, min(smp.a, 1e4));
    if(x == 0 && y == 0) tnear = smp.a;
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sigma = sqrt(max(m2 - m1*m1, 0.0));
  vec3 csmooth = cl / wl;
  vec3 csharp = ws > 1e-3 ? cs / ws : csmooth;
  float conf = clamp(ws, 0.0, 1.0);

  if(uReset == 1){ fragColor = vec4(csmooth, tnear); return; }

  float t = tnear;   // this pixel's own depth (mixing in neighbours stretched near surfaces)
  vec2 ndc = (o - 0.5*uHistRes)/uHistRes.y * 2.0 * uTanHalf;
  vec3 rd = uCamRot * normalize(vec3(ndc, 1.0));
  vec3 wp = uCamPos + rd*t;
  vec3 pc = transpose(uPrevCamRot) * (wp - uPrevCamPos);
  bool valid = false;
  vec2 puvOut = o/uHistRes;
  vec3 hist = csmooth;
  float alpha = uBlend;
  if(pc.z > 1e-9){
    vec2 puv = (pc.xy/pc.z/(2.0*uTanHalf)*uHistRes.y + 0.5*uHistRes)/uHistRes;
    if(all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))){
      hist = sampleCatmull(uHist, puv, uHistRes).rgb;
      valid = true; puvOut = puv;
      // depth test: the history pixel must have seen the same surface. If the stored distance
      // disagrees with where this point was relative to the previous camera, it is a different
      // (disoccluded / fast-moving) surface - drop it instead of smearing it across the frame.
      float hd = texelFetch(uHist, ivec2(puv*uHistRes), 0).a;
      float expect = length(wp - uPrevCamPos);
      // tolerate the depth spread already present among this pixel's neighbours (distant
      // sub-pixel detail flickers in depth every frame; rejecting that kills the averaging)
      float lo = min(expect*0.96, tmin*0.97), hi = max(expect*1.04, tmax*1.03);
      if(hd < lo || hd > hi) valid = false;
      float motion = length(puv*uHistRes - o);
      alpha = mix(uBlend, uMotionAlpha, clamp(motion/30.0, 0.0, 1.0));
    }
  }
  if(!valid){ fragColor = vec4(csmooth, tnear); return; }

  // clip history towards the neighbourhood mean (variance clipping)
  vec3 hy = toYCoCg(tm(hist));
  float g = mix(uClipLo, uClipHi, 1.0 - r);
  vec3 ext = g*sigma + 1e-4;
  vec3 dir = hy - m1;
  vec3 q = abs(dir)/ext;
  float k = max(q.x, max(q.y, q.z));
  if(k > 1.0) hy = m1 + dir/k;
  hist = itm(fromYCoCg(hy));
  // Distant pixels hardly move between frames, so let them average over more of them -
  // that is what settles the grain on far, fine detail. Near pixels keep their response.
  float far01 = clamp(t/max(uFar, 1e-9), 0.0, 1.0);
  float acc = mix(1.0, 0.5, smoothstep(0.15, 0.6, far01));
  float a = clamp(alpha * mix(0.25, 1.6, conf) * acc, 0.0, 1.0);
  vec3 res = mix(hist, csharp, a);
  fragColor = vec4(max(res, vec3(0.0)), tnear);
}
`;

  // 13-tap downsample (Jimenez, CoD:AW)
  const FS_DOWN = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;   // source texel size
uniform int uFirst;
out vec4 fragColor;
vec3 S(vec2 uv){ return texture(uSrc, uv).rgb; }
void main(){
  vec2 uv = (floor(gl_FragCoord.xy)*2.0 + 1.0) * uTexel;
  vec2 t = uTexel;
  vec3 a = S(uv+t*vec2(-2, 2)), b = S(uv+t*vec2(0, 2)), c = S(uv+t*vec2(2, 2));
  vec3 d = S(uv+t*vec2(-2, 0)), e = S(uv), f = S(uv+t*vec2(2, 0));
  vec3 g = S(uv+t*vec2(-2,-2)), h = S(uv+t*vec2(0,-2)), i = S(uv+t*vec2(2,-2));
  vec3 j = S(uv+t*vec2(-1, 1)), k = S(uv+t*vec2(1, 1)), l = S(uv+t*vec2(-1,-1)), m = S(uv+t*vec2(1,-1));
  vec3 col = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
  if(uFirst == 1) col = col / (1.0 + max(col.r, max(col.g, col.b))*0.25); // tame fireflies
  fragColor = vec4(col, 1.0);
}`;

  const FS_UP = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
uniform vec2 uDstRes;
out vec4 fragColor;
void main(){
  vec2 uv = gl_FragCoord.xy / uDstRes;
  vec2 t = uTexel*uRadius;
  vec3 c = texture(uSrc, uv).rgb*4.0;
  c += (texture(uSrc, uv+vec2(-t.x,0)).rgb + texture(uSrc, uv+vec2(t.x,0)).rgb + texture(uSrc, uv+vec2(0,-t.y)).rgb + texture(uSrc, uv+vec2(0,t.y)).rgb)*2.0;
  c += texture(uSrc, uv+vec2(-t.x,-t.y)).rgb + texture(uSrc, uv+vec2(t.x,-t.y)).rgb + texture(uSrc, uv+vec2(-t.x,t.y)).rgb + texture(uSrc, uv+vec2(t.x,t.y)).rgb;
  fragColor = vec4(c/16.0, 1.0);
}`;

  const FS_COMPOSITE = HEADER + `
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform vec2 uSrcRes;
uniform vec2 uOutRes;
uniform float uExposure;
uniform float uBloomAmt;
uniform float uVignette;
uniform float uCA;
uniform float uSharpen;
uniform float uFade;
uniform float uSat;
uniform float uContrast;
uniform float uTime;
out vec4 fragColor;

vec3 catmull(vec2 uv){
  vec2 res = uSrcRes;
  vec2 sp = uv*res; vec2 tp1 = floor(sp-0.5)+0.5; vec2 f = sp-tp1;
  vec2 w0 = f*(-0.5+f*(1.0-0.5*f)); vec2 w1 = 1.0+f*f*(-2.5+1.5*f);
  vec2 w2 = f*(0.5+f*(2.0-1.5*f)); vec2 w3 = f*f*(-0.5+0.5*f);
  vec2 w12 = w1+w2; vec2 off12 = w2/w12;
  vec2 tp0 = (tp1-1.0)/res, tp3 = (tp1+2.0)/res, tp12 = (tp1+off12)/res;
  vec3 r = vec3(0.0);
  r += texture(uSrc, vec2(tp0.x, tp0.y)).rgb*w0.x*w0.y;  r += texture(uSrc, vec2(tp12.x, tp0.y)).rgb*w12.x*w0.y;  r += texture(uSrc, vec2(tp3.x, tp0.y)).rgb*w3.x*w0.y;
  r += texture(uSrc, vec2(tp0.x, tp12.y)).rgb*w0.x*w12.y; r += texture(uSrc, vec2(tp12.x, tp12.y)).rgb*w12.x*w12.y; r += texture(uSrc, vec2(tp3.x, tp12.y)).rgb*w3.x*w12.y;
  r += texture(uSrc, vec2(tp0.x, tp3.y)).rgb*w0.x*w3.y;  r += texture(uSrc, vec2(tp12.x, tp3.y)).rgb*w12.x*w3.y;  r += texture(uSrc, vec2(tp3.x, tp3.y)).rgb*w3.x*w3.y;
  return max(r, vec3(0.0));
}

// ACES fitted (Hill) with a touch less desaturation than the Narkowicz curve
vec3 RRTAndODTFit(vec3 v){ vec3 a = v*(v+0.0245786)-0.000090537; vec3 b = v*(0.983729*v+0.4329510)+0.238081; return a/b; }
vec3 aces(vec3 c){
  const mat3 I = mat3(0.59719,0.07600,0.02840, 0.35458,0.90834,0.13383, 0.04823,0.01566,0.83777);
  const mat3 O = mat3(1.60475,-0.10208,-0.00327, -0.53108,1.10813,-0.07276, -0.07367,-0.00605,1.07602);
  return clamp(O*RRTAndODTFit(I*c), 0.0, 1.0);
}
// Khronos PBR Neutral: keeps hue and saturation of mid tones (no ACES toe crush / red shift)
vec3 neutralTM(vec3 c){
  const float sc = 0.76, ds = 0.15;
  float x = min(c.r, min(c.g, c.b));
  c -= x < 0.08 ? x - 6.25*x*x : 0.04;
  float peak = max(c.r, max(c.g, c.b));
  if(peak < sc) return c;
  float d = 1.0 - sc;
  float np = 1.0 - d*d/(peak + d - sc);
  c *= np/peak;
  float g = 1.0 - 1.0/(ds*(peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
vec3 toSRGB(vec3 c){ return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

void main(){
  vec2 uv = gl_FragCoord.xy / uOutRes;
  vec3 c = catmull(uv);
  // contrast-adaptive sharpening against the 4 neighbours (in compressed space)
  vec2 tx = 1.0/uSrcRes;
  vec3 a = texture(uSrc, uv+vec2(0,-tx.y)).rgb, b = texture(uSrc, uv+vec2(-tx.x,0)).rgb;
  vec3 d = texture(uSrc, uv+vec2(tx.x,0)).rgb,  e = texture(uSrc, uv+vec2(0,tx.y)).rgb;
  vec3 ca = a/(1.0+a), cb = b/(1.0+b), cc = c/(1.0+c), cd = d/(1.0+d), ce = e/(1.0+e);
  vec3 mn = min(cc, min(min(ca,cb), min(cd,ce))), mxv = max(cc, max(max(ca,cb), max(cd,ce)));
  vec3 amp = sqrt(clamp(min(mn, 1.0-mxv)/max(mxv, 1e-4), 0.0, 1.0));
  vec3 w = -amp * mix(0.0, 0.2, uSharpen);
  c = max((c + (a+b+d+e)*w)/(1.0+4.0*w), vec3(0.0));

  // subtle chromatic aberration towards the edges
  vec2 dv = uv - 0.5; float r2 = dot(dv, dv);
  if(uCA > 0.0){
    vec2 off = dv * r2 * uCA * 0.012;
    c.r = mix(c.r, texture(uSrc, uv - off).r, 0.85);
    c.b = mix(c.b, texture(uSrc, uv + off).b, 0.85);
  }
  c += texture(uBloom, uv).rgb * uBloomAmt;
  c *= uExposure;
  c = clamp(neutralTM(c), 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSat), 0.0);
  c = clamp((c - 0.5)*uContrast + 0.5, 0.0, 1.0);
  c *= mix(1.0, smoothstep(1.2, 0.25, sqrt(r2)*1.4), uVignette);
  c = toSRGB(c);
  c += (hash12(gl_FragCoord.xy + fract(uTime)*717.0) - 0.5) / 255.0;   // dither
  fragColor = vec4(c * uFade, 1.0);
}`;

  FV.shaders = {
    VS_FULLSCREEN,
    buildMarch(fractalSrc, defines) {
      return HEADER + (defines || '') + SCENE_UNIFORMS + MARCH_UNIFORMS + COMMON_FUNCS + fractalSrc + MARCH_BODY;
    },
    buildCone(fractalSrc, defines) {
      return HEADER + (defines || '') + SCENE_UNIFORMS + COMMON_FUNCS + fractalSrc + CONE_BODY;
    },
    buildProbe(fractalSrc, defines) {
      return HEADER + (defines || '') + SCENE_UNIFORMS + COMMON_FUNCS + fractalSrc + PROBE_BODY;
    },
    FS_TAA, FS_DOWN, FS_UP, FS_COMPOSITE,
  };
})(window.FV);
