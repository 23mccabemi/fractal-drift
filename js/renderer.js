// WebGL2 renderer: raymarch -> temporal AA (reprojected) -> bloom -> tonemap/upscale.
'use strict';
(function (FV) {
  const S = () => FV.shaders;

  class Program {
    constructor(gl, vs, fs, name) {
      this.gl = gl; this.name = name;
      const p = this.prog = gl.createProgram();
      this.vs = this._shader(gl.VERTEX_SHADER, vs);
      this.fs = this._shader(gl.FRAGMENT_SHADER, fs);
      gl.attachShader(p, this.vs); gl.attachShader(p, this.fs);
      gl.linkProgram(p);
      this.uniforms = null;
    }
    _shader(type, src) {
      const gl = this.gl, s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    }
    // Non-blocking when KHR_parallel_shader_compile is available.
    isReady(ext) {
      if (this._ready) return true;
      if (ext && !this.gl.getProgramParameter(this.prog, ext.COMPLETION_STATUS_KHR)) return false;
      this._finalize();
      return true;
    }
    _finalize() {
      const gl = this.gl;
      if (!gl.getProgramParameter(this.prog, gl.LINK_STATUS)) {
        const log = gl.getShaderInfoLog(this.fs) || '';
        const vlog = gl.getShaderInfoLog(this.vs) || '';
        const plog = gl.getProgramInfoLog(this.prog) || '';
        console.error(`[FV] program "${this.name}" failed:\n${log}\n${vlog}\n${plog}`);
        this.error = log || plog || 'link failed';
      }
      this._ready = true;
      this.uniforms = {};
      const n = gl.getProgramParameter(this.prog, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(this.prog, i);
        const nm = info.name.replace(/\[0\]$/, '');
        this.uniforms[nm] = { loc: gl.getUniformLocation(this.prog, info.name), type: info.type, size: info.size };
      }
    }
    use() { if (!this._ready) this._finalize(); this.gl.useProgram(this.prog); }
    set(name, v) {
      const u = this.uniforms[name]; if (!u) return;
      const gl = this.gl, l = u.loc;
      switch (u.type) {
        case gl.FLOAT: u.size > 1 ? gl.uniform1fv(l, v) : gl.uniform1f(l, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(l, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(l, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(l, v); break;
        case gl.INT: case gl.SAMPLER_2D: case gl.BOOL: gl.uniform1i(l, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(l, false, v); break;
        default: break;
      }
    }
    setAll(obj) { for (const k in obj) this.set(k, obj[k]); }
  }

  class Target {
    constructor(gl, w, h, fmt, filter) {
      this.gl = gl; this.w = w; this.h = h;
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, fmt.internal, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      this.ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    dispose() { this.gl.deleteTexture(this.tex); this.gl.deleteFramebuffer(this.fbo); }
  }

  FV.QUALITY = {
    low:    { steps: 90,  ao: 2, shadow: 0,  detail: 1.4,  maxScale: 0.75, label: 'Low' },
    medium: { steps: 120, ao: 3, shadow: 0,  detail: 1.2,  maxScale: 0.85, label: 'Medium' },
    high:   { steps: 150, ao: 4, shadow: 0,  detail: 1.0,  maxScale: 1.0,  label: 'High' },
    // Same look as High (no shadows), just sampled finer: a smaller hit threshold and more
    // steps resolve the fine detail in the distance instead of speckling it. Auto climbs
    // here when there is spare GPU, which is where 90+ fps headroom should go.
    fine:   { steps: 210, ao: 5, shadow: 0,  detail: 0.8,  maxScale: 1.35, label: 'Very high' },
    ultra:  { steps: 240, ao: 6, shadow: 32, detail: 0.75, maxScale: 1.35, label: 'Ultra' },
  };


  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = this.gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: false, stencil: false,
        powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true,
      });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.extCBF = gl.getExtension('EXT_color_buffer_float');
      gl.getExtension('EXT_color_buffer_half_float');
      gl.getExtension('OES_texture_float_linear');
      this.extPar = gl.getExtension('KHR_parallel_shader_compile');
      this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      this.gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
      this.hdr = { internal: this.extCBF ? gl.RGBA16F : gl.RGBA8 };
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);

      const VS = S().VS_FULLSCREEN;
      this.taa = new Program(gl, VS, S().FS_TAA, 'taa');
      this.down = new Program(gl, VS, S().FS_DOWN, 'down');
      this.up = new Program(gl, VS, S().FS_UP, 'up');
      this.comp = new Program(gl, VS, S().FS_COMPOSITE, 'composite');

      // fractal programs are compiled on demand: the current scene first, the rest in the background
      this.march = {}; this.probe = {}; this.cone = {};

      // probe readback (async via PBO + fence so we never stall the GPU)
      this.probeTarget = new Target(gl, 8, 1, { internal: this.extCBF ? gl.RGBA32F : gl.RGBA8 }, gl.NEAREST);
      this.probeFloat = !!this.extCBF;
      // ring of pixel-pack buffers; each is read back before it is written again
      this.pbos = [0, 1, 2].map(() => {
        const b = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, 8 * 4 * 4, gl.STREAM_READ);
        return { buf: b, fence: null };
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.pboHead = 0;
      this.probeData = new Float32Array(32);
      this.probeResult = null;

      this.renderScale = 0.6;
      this.maxHistW = 1920;
      this.frameIndex = 0;
      this.histIdx = 0;
      this.resetHistory = true;
      this.prevCam = null;
      this.size = [0, 0];
      this.rw = 0; this.rh = 0;
      this.gpuMs = 0;
      this.queries = [];
    }

    ensure(id) {
      if (this.march[id]) return;
      const def = FV.fractals.programs[id], VS = S().VS_FULLSCREEN;
      this.march[id] = new Program(this.gl, VS, S().buildMarch(def.src, def.defines), 'march:' + id);
      this.probe[id] = new Program(this.gl, VS, S().buildProbe(def.src, def.defines), 'probe:' + id);
      this.cone[id] = new Program(this.gl, VS, S().buildCone(def.src, def.defines), 'cone:' + id);
    }
    // start compiling the next not-yet-requested program (call once the current one is ready)
    compileNext() {
      const id = Object.keys(FV.fractals.programs).find((k) => !this.march[k]);
      if (id) this.ensure(id);
    }
    ready(id) { this.ensure(id); return this.march[id].isReady(this.extPar) && this.probe[id].isReady(this.extPar) && this.cone[id].isReady(this.extPar); }
    allReady() { return Object.keys(FV.fractals.programs).every((id) => this.march[id] && this.ready(id)) && [this.taa, this.down, this.up, this.comp].every((p) => p.isReady(this.extPar)); }
    errorFor(id) { return this.march[id].error || this.probe[id].error || this.taa.error || this.comp.error; }

    resize(w, h) {
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this.size = [w, h];
      this._alloc();
    }

    setMaxHistWidth(w) {
      if (w === this.maxHistW) return;
      this.maxHistW = w;
      if (this.size[0]) this._alloc();
    }

    setRenderScale(s) {
      s = Math.round(FV.clamp(s, 0.25, 2.0) * 40) / 40;
      if (s === this.renderScale && this.rw) return;
      this.renderScale = s;
      this._alloc();
    }

    _alloc() {
      const gl = this.gl;
      // history (accumulation) resolution: display res, capped to keep bandwidth sane
      const k = Math.min(1, this.maxHistW / this.size[0]);
      const hw = Math.max(64, Math.round(this.size[0] * k)), hh = Math.max(36, Math.round(this.size[1] * k));
      let rw = Math.max(64, Math.round(hw * this.renderScale));
      let rh = Math.max(36, Math.round(hh * this.renderScale));
      // supersampling (scale > 1) is allowed, but keep the march target inside a sane
      // pixel budget so a 4K display in photo mode cannot ask for a huge allocation
      const MAXPX = 12e6;
      if (rw * rh > MAXPX) { const q = Math.sqrt(MAXPX / (rw * rh)); rw = Math.round(rw * q); rh = Math.round(rh * q); }
      if (rw === this.rw && rh === this.rh && hw === this.hw && hh === this.hh) return;
      const histChanged = hw !== this.hw || hh !== this.hh;
      this.rw = rw; this.rh = rh; this.hw = hw; this.hh = hh;
      [this.cur, ...(this.bloom || [])].forEach((t) => t && t.dispose());
      this.cur = new Target(gl, rw, rh, this.hdr, gl.NEAREST);
      if (this.coneTarget) this.coneTarget.dispose();
      this.coneTarget = this.extCBF ? new Target(gl, Math.ceil(rw / 4), Math.ceil(rh / 4), { internal: gl.RG32F }, gl.NEAREST) : null;
      if (this.coneTarget && !this.coneTarget.ok) { this.coneTarget.dispose(); this.coneTarget = null; }
      if (histChanged || !this.hist) {
        (this.hist || []).forEach((t) => t.dispose());
        this.hist = [new Target(gl, hw, hh, this.hdr, gl.LINEAR), new Target(gl, hw, hh, this.hdr, gl.LINEAR)];
        this.resetHistory = true;
      }
      this.bloom = [];
      let bw = rw, bh = rh;
      for (let i = 0; i < 6; i++) {
        bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
        if (bw < 4 || bh < 4) break;
        this.bloom.push(new Target(gl, bw, bh, this.hdr, gl.LINEAR));
      }
    }

    _bindTarget(t) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : this.size[0], t ? t.h : this.size[1]);
    }
    _tex(unit, tex) { const gl = this.gl; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }
    _draw() { this.gl.drawArrays(this.gl.TRIANGLES, 0, 3); }

    _pollProbe() {
      const gl = this.gl;
      // read every completed buffer (oldest first); keep the newest result
      for (let k = 0; k < this.pbos.length; k++) {
        const p = this.pbos[(this.pboHead + k) % this.pbos.length];
        if (!p.fence || gl.getSyncParameter(p.fence, gl.SYNC_STATUS) !== gl.SIGNALED) continue;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p.buf);
        if (this.probeFloat) gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.probeData);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        gl.deleteSync(p.fence); p.fence = null;
        const d = this.probeData;
        const free = []; for (let i = 1; i < 8; i++) free.push(d[i * 4]);
        if (this.probeFloat && isFinite(d[0])) this.probeResult = { de: d[0], normal: [d[1], d[2], d[3]], free, far: p.far };
      }
    }

    _gpuTimerBegin() {
      const gl = this.gl, t = this.timer;
      if (!t) return null;
      // harvest finished queries
      while (this.queries.length) {
        const q = this.queries[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const disjoint = gl.getParameter(t.GPU_DISJOINT_EXT);
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        if (!disjoint) this.gpuMs = FV.lerp(this.gpuMs || ns / 1e6, ns / 1e6, 0.1);
        gl.deleteQuery(q); this.queries.shift();
      }
      if (this.queries.length > 4) return null;
      const q = gl.createQuery();
      gl.beginQuery(t.TIME_ELAPSED_EXT, q);
      return q;
    }

    // Profiling (?profile): time each pass separately. Only one timer query may be active,
    // so a section ends the previous one.
    _sec(name) {
      if (!this.prof) return;
      const gl = this.gl, T = this.timer.TIME_ELAPSED_EXT;
      if (this.secQ) { gl.endQuery(T); this.pq.push(this.secQ); this.secQ = null; }
      if (name) { const q = gl.createQuery(); gl.beginQuery(T, q); this.secQ = [name, q]; }
    }
    _harvestSections() {
      const gl = this.gl; this.passMs = this.passMs || {};
      while (this.pq.length) {
        const [name, q] = this.pq[0];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.passMs[name] = FV.lerp(this.passMs[name] ?? ms, ms, 0.1);
        gl.deleteQuery(q); this.pq.shift();
      }
      this.gpuMs = Object.values(this.passMs).reduce((a, b) => a + b, 0);
    }

    // state: { programId, cam:{pos, rot(mat3), tanHalf}, uniforms (scene), quality, post, fade, time }
    render(st) {
      const gl = this.gl;
      this._pollProbe();
      this.prof = !!(FV.perfFlags && FV.perfFlags.profile && this.timer);
      this.pq = this.pq || [];
      if (this.prof) this._harvestSections();
      const q = this.prof ? null : this._gpuTimerBegin();
      this._sec('probe');
      const mp = this.march[st.programId], pp = this.probe[st.programId];
      const scene = st.scene;

      // --- probe ---
      const slot = this.pbos[this.pboHead];
      if (!slot.fence) {
        pp.use();
        pp.setAll(scene);
        this._bindTarget(this.probeTarget);
        this._draw();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf);
        gl.readPixels(0, 0, 8, 1, gl.RGBA, this.probeFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        slot.far = scene.uFar;
        this.pboHead = (this.pboHead + 1) % this.pbos.length;
      }

      // --- raymarch ---
      const fi = this.frameIndex++;
      const jitter = [FV.halton((fi % 32) + 1, 2) - 0.5, FV.halton((fi % 32) + 1, 3) - 0.5];
      const flags = FV.perfFlags || {};
      const useCone = !!this.coneTarget && !flags.nocone;
      this._sec('cone');
      if (useCone) {
        const cp = this.cone[st.programId];
        cp.use();
        cp.setAll(scene);
        const cw = this.coneTarget.w, ch = this.coneTarget.h;
        cp.set('uRes', [cw, ch]);
        // cone radius covers the whole 4x4 block (half-diagonal 2.8 px) plus TAA jitter
        cp.set('uConeK', 2 * scene.uTanHalf / this.rh * 3.6);
        this._bindTarget(this.coneTarget);
        this._draw();
      }
      this._sec('march');
      mp.use();
      mp.setAll(scene);
      mp.set('uRes', [this.rw, this.rh]);
      mp.set('uUseCone', useCone ? 1 : 0);
      mp.set('uRelax', flags.norelax ? 1.0 : 1.3);
      mp.set('uAAFilter', flags.noaa ? 0.0 : 1.0);
      if (useCone) { this._tex(2, this.coneTarget.tex); mp.set('uCone', 2); }
      mp.set('uJitter', st.taa ? jitter : [0, 0]);
      this._bindTarget(this.cur);
      this._draw();

      this._sec('taa');
      // --- temporal AA ---
      const src = this.hist[this.histIdx], dst = this.hist[1 - this.histIdx];
      this.taa.use();
      this._tex(0, this.cur.tex); this._tex(1, src.tex);
      this.taa.setAll({
        uCur: 0, uHist: 1, uCurRes: [this.rw, this.rh], uHistRes: [this.hw, this.hh], uJitter: st.taa ? jitter : [0, 0],
        uCamPos: scene.uCamPos, uCamRot: scene.uCamRot, uTanHalf: scene.uTanHalf,
        uPrevCamPos: this.prevCam ? this.prevCam.pos : scene.uCamPos,
        uPrevCamRot: this.prevCam ? this.prevCam.rot : scene.uCamRot,
        uBlend: st.taa ? st.taaBlend : 1.0,
        // with the depth test catching disocclusions, history can be kept longer (less grain)
        uMotionAlpha: flags.oldtaa ? 0.4 : 0.2, uClipLo: flags.oldtaa ? 1.0 : 1.25, uClipHi: flags.oldtaa ? 1.25 : 1.75,
        uFar: scene.uFar,
        uReset: (this.resetHistory || !st.taa) ? 1 : 0,
      });
      this._bindTarget(dst);
      this._draw();
      this.histIdx = 1 - this.histIdx;
      this.resetHistory = false;
      this.prevCam = { pos: scene.uCamPos.slice(), rot: scene.uCamRot.slice() };

      this._sec('bloom');
      // --- bloom (from the low-res frame; the blur hides the jitter) ---
      let srcTex = this.cur.tex, sw = this.rw, sh = this.rh;
      this.down.use();
      for (let i = 0; i < this.bloom.length; i++) {
        const b = this.bloom[i];
        this._tex(0, srcTex);
        this.down.setAll({ uSrc: 0, uTexel: [1 / sw, 1 / sh], uFirst: i === 0 ? 1 : 0 });
        this._bindTarget(b); this._draw();
        srcTex = b.tex; sw = b.w; sh = b.h;
      }
      this.up.use();
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = this.bloom.length - 1; i > 0; i--) {
        const s = this.bloom[i], d = this.bloom[i - 1];
        this._tex(0, s.tex);
        this.up.setAll({ uSrc: 0, uTexel: [1 / s.w, 1 / s.h], uRadius: 1.0, uDstRes: [d.w, d.h] });
        this._bindTarget(d); this._draw();
      }
      gl.disable(gl.BLEND);

      this._sec('composite');
      // --- composite to screen ---
      this.comp.use();
      this._tex(0, dst.tex); this._tex(1, this.bloom.length ? this.bloom[0].tex : dst.tex);
      const post = st.post;
      this.comp.setAll({
        uSrc: 0, uBloom: 1, uSrcRes: [this.hw, this.hh], uOutRes: this.size,
        uExposure: post.exposure, uBloomAmt: post.bloom / Math.max(1, this.bloom.length * 0.5), uVignette: post.vignette,
        uCA: post.ca, uSharpen: post.sharpen, uFade: st.fade, uSat: post.sat, uContrast: post.contrast,
        uTime: st.time,
      });
      this._bindTarget(null);
      this._draw();

      this._sec(null);
      if (q) { gl.endQuery(this.timer.TIME_ELAPSED_EXT); this.queries.push(q); }
    }

    invalidateHistory() { this.resetHistory = true; }
  }

  FV.Renderer = Renderer;
})(window.FV);
