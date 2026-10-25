// App: ties audio, input, flight and the renderer together.
'use strict';
(function (FV) {
  const $ = (id) => document.getElementById(id);
  const QUALITY_KEYS = ['auto', 'low', 'medium', 'high', 'fine', 'ultra'];
  const REACT = [0, 0.45, 0.8, 1.15, 1.6];
  const RUMBLE = [0, 0.6, 1.0, 1.4];

  class App {
    constructor() {
      const params = new URLSearchParams(location.search);
      this.params = params;
      FV.perfFlags = { nocone: params.has('nocone'), norelax: params.has('norelax'), noaa: params.has('noaa'), oldtaa: params.has('oldtaa'), profile: params.has('profile') };
      this.canvas = $('gl');
      this.renderer = new FV.Renderer(this.canvas);
      this.audio = new FV.AudioEngine();
      this.input = new FV.Input(this.canvas);
      this.flight = new FV.Flight();

      this.tabIdx = Math.max(0, FV.tabs.findIndex((t) => t.id === (params.get('tab') || FV.store.get('tab', 'fractals'))));
      // each tab remembers which of its scenes you were on
      this.tabScene = FV.store.get('tabScene', {});
      this.sceneIdx = FV.clamp(+(params.get('scene') ?? this.tabScene[this.tab().id] ?? FV.store.get('scene', 0)) || 0, 0, this.tab().scenes.length - 1);
      this.paletteIdx = -1;
      this.reactLevel = FV.store.get('react', 2);
      this.quality = params.get('q') || FV.store.get('quality2', 'auto');
      if (!QUALITY_KEYS.includes(this.quality)) this.quality = 'auto';
      this.targetFps = FV.store.get('fps', 60);
      this.bloomMul = FV.store.get('bloom', 1);
      this.lensFx = FV.store.get('lens2', false);
      this.input.rumble = FV.store.get('rumble2', 1);
      this.demoAudible = FV.store.get('demoAudible', true);
      this.showStats = params.has('stats') || FV.store.get('stats', false);
      this.flight.userSpeed = FV.store.get('speed', 1);
      this.flight.autopilot = params.has('auto') && params.get('auto') !== '0';
      this.flight.model = params.has('free') ? 'free' : FV.store.get('model', 'drift');
      this.flight.idleEngage = !(params.has('auto') && params.get('auto') === '0');
      this.photoMode = false;
      this.warpMode = FV.store.get('warp', 'scene');         // 'scene' | 'on' | 'off'
      this.resMode = FV.store.get('res', 'auto');           // 'auto' | pixel width cap
      this.integratedGpu = /intel|adreno|qualcomm|mali|apple|powervr/i.test(this.renderer.gpuName || '');
      this.still = params.has('still');

      this.fade = 0; this.fadeTarget = 1; this.pendingScene = null;
      this.time = 0; this.fps = 60; this.frameMs = 16; this.lastNow = 0;
      this.dynTimer = 0; this.goodTime = 0;
      this.morph = {};
      this.palShift = 0;
      this.shotRequest = null;
      this.ui = new FV.UI(this);
      this.flight.onAutoEngage = () => this.ui.toast('Autopilot engaged - move a stick to take over');

      this.audio.onEnded = () => { this.ui.toast('Audio capture ended - press Options / Esc > Audio source to reconnect', 4); };

      window.addEventListener('resize', () => this._resize());
      this._resize();
      const s0 = params.get('scale'); if (s0) this.renderer.setRenderScale(+s0);
      else this.renderer.setRenderScale(Math.min(this._q().maxScale, 0.6));

      this._applyScene(this.sceneIdx, true);
      const cam = params.get('cam');
      if (cam) { const c = cam.split(',').map(Number); this.flight.place({ pos: c.slice(0, 3), fwd: c.slice(3, 6) }); }

      if (params.has('demo')) this.startAudio('demo', true);
      if (params.has('go')) this.ui.hideStart();

      this.ui.setLoading('Compiling fractal shaders…');
      // Windows throttles the GPU hard on battery; tell the user why it may look soft
      // A dual-GPU PC will quietly hand WebGL to the Intel chip if the page was opened in
      // an ordinary browser window instead of the launcher's Edge app window. That halves
      // the frame rate and is invisible unless you go looking, so say it out loud once.
      if (this.integratedGpu) {
        const name = (this.renderer.gpuName || 'integrated graphics').replace(/^ANGLE \(|\)$/g, '').replace(/ Direct3D.*$/, '');
        setTimeout(() => this.ui.toast('Running on ' + name + '. If this PC also has an NVIDIA/AMD GPU, close this window and start it with "Start Fractal Drift.bat" for full performance.', 9), 2500);
      }
      if (navigator.getBattery) navigator.getBattery().then((b) => {
        const warn = () => { if (!b.charging) this.ui.toast('On battery: Windows limits the GPU. Plug in + set Power mode to Best performance for full quality', 7); };
        setTimeout(warn, 4000); b.addEventListener('chargingchange', warn);
      }).catch(() => {});
      requestAnimationFrame((t) => this._frame(t));
      this._exposeDebug();
    }

    // ---------- settings ----------
    _q() { return FV.QUALITY[this.quality === 'auto' ? (this.autoTier || 'high') : this.quality]; }
    qualityLabel() { return this.quality === 'auto' ? 'Auto (' + FV.QUALITY[this.autoTier || 'high'].label + ')' : FV.QUALITY[this.quality].label + ' (adaptive res)'; }
    cycleQuality(d) {
      const i = (QUALITY_KEYS.indexOf(this.quality) + d + QUALITY_KEYS.length) % QUALITY_KEYS.length;
      this.quality = QUALITY_KEYS[i]; FV.store.set('quality2', this.quality);
      this.renderer.setRenderScale(Math.min(this.renderer.renderScale, this._q().maxScale));
      this.renderer.invalidateHistory();
    }
    setReact(l) { this.reactLevel = FV.clamp(l, 0, REACT.length - 1); FV.store.set('react', this.reactLevel); }
    setTargetFps(f) { this.targetFps = f; FV.store.set('fps', f); }
    cycleTargetFps() { const o = [30, 60, 90, 120]; this.setTargetFps(o[(o.indexOf(this.targetFps) + 1) % o.length]); }
    setBloom(b) { this.bloomMul = FV.clamp(b, 0, 3); FV.store.set('bloom', this.bloomMul); }
    setLens(on) { this.lensFx = on; FV.store.set('lens2', on); }
    // Bluetooth DualSense rumble only works through WebHID; this is that opt-in.
    // Must be triggered by a real click or key press - a controller button grants no
    // permission, so the menu row has to be clicked or confirmed from the keyboard.
    async connectHaptics() {
      if (this.input.hid && this.input.hid.connected) { this.ui.toast('Direct haptics already connected'); return; }
      try {
        const how = await this.input.connectHid();
        this.ui.toast(how === 'bluetooth' ? 'Direct haptics connected over Bluetooth - rumble should work now' : 'Direct haptics connected over USB', 4);
      } catch (e) {
        const m = String(e && e.message || e);
        this.ui.toast(m === 'cancelled' ? 'No controller picked' : 'Could not connect: ' + m, 4);
      }
      this.ui.refreshMenu();
    }
    hapticsLabel() {
      if (!this.input.hid || !this.input.hid.connected) return FV.DualSenseHID.available() ? 'Connect (fixes Bluetooth)' : 'Not available';
      return this.input.hid.bt ? 'Connected (Bluetooth)' : 'Connected (USB)';
    }
    rumbleLabel() {
      const n = ['Off', 'Light', 'Normal', 'Strong'][RUMBLE.indexOf(this.input.rumble)] || 'Normal';
      const st = this.input.rumbleState;
      if (this.input.hid && this.input.hid.connected) return n + ' (direct)';
      if (!this.input.pad) return n + ' (no controller)';
      if (st === 'unsupported') return n + ' (not supported)';
      if (st === 'error') return n + ' (blocked by the browser)';
      return n;
    }
    cycleRumble(d) {
      const i = (RUMBLE.indexOf(this.input.rumble) + (d || 1) + RUMBLE.length) % RUMBLE.length;
      this.input.rumble = RUMBLE[i]; FV.store.set('rumble2', RUMBLE[i]);
      // buzz at the level you just picked, so the setting is self-testing
      if (RUMBLE[i] > 0) {
        const r = this.input.rumbleTest(0.55 * RUMBLE[i]);
        if (r === 'nopad') this.ui.toast('Connect the controller and press a button first');
        else if (r === 'unsupported') this.ui.toast('This controller reports no vibration support. Over Bluetooth, try a USB-C cable', 5);
      } else this.input.setRumble(0, 0, this.time);
    }

    // Haptics modelled on a bass transducer (Woojer / Crusher): the heavy motor tracks the
    // low-passed waveform envelope itself, so you feel the shape of the bass - each kick's
    // thump and every wobble - rather than a smeared level meter. The light motor only adds
    // the transient snap on top, the way a kick has both body and click.
    _updateRumble(a, react, now) {
      const inp = this.input;
      if (!inp.pad && !(inp.hid && inp.hid.connected)) return;
      if (!inp.rumble || react <= 0) { inp.setRumble(0, 0, now); return; }
      const amt = inp.rumble;
      const body = a.haptic;
      // the motors do nothing under ~0.12, so sit the usable range on top of that floor
      const strong = body > 0.012 ? FV.clamp((0.12 + 0.88 * body) * amt, 0, 1) : 0;
      // snap: the attack transient, plus a little of the kick detector for certainty
      if (a.kick) this.rumblePunch = 1;
      this.rumblePunch = (this.rumblePunch || 0) * Math.exp(-this.dt * 11);
      const snap = Math.max(a.hapticPunch, this.rumblePunch * 0.7);
      const weak = FV.clamp((snap * 0.75 + body * 0.18) * amt, 0, 1);
      inp.setRumble(strong, weak, now);
    }
    setDemoAudible(on) { this.demoAudible = on; FV.store.set('demoAudible', on); this.audio.setDemoAudible(on); }
    resCap() {
      if (this.resMode !== 'auto') return +this.resMode;
      return this.integratedGpu ? 1600 : 2560;
    }
    cycleRes(d) {
      const opts = ['auto', '1280', '1600', '1920', '2560', '3840'];
      this.resMode = opts[(opts.indexOf(String(this.resMode)) + d + opts.length) % opts.length];
      FV.store.set('res', this.resMode); this.histCapped = 0; this.renderer.invalidateHistory();
    }
    resLabel() { return this.resMode === 'auto' ? `Auto (${this.resCap()}px wide)` : this.resMode + 'px wide'; }
    cycleWarp(d) {
      const opts = ['scene', 'off', 'on'];
      this.warpMode = opts[(opts.indexOf(this.warpMode) + d + 3) % 3]; FV.store.set('warp', this.warpMode);
    }
    setStats(on) { this.showStats = on; FV.store.set('stats', on); }
    cycleFlightModel(d) {
      const keys = ['drift', 'glide', 'free'];
      const i = (keys.indexOf(this.flight.model) + (d || 1) + keys.length) % keys.length;
      this.flight.model = keys[i]; FV.store.set('model', keys[i]); this.flight.bank = 0;
    }
    flightModelLabel() { return ({ drift: 'Drift (calm)', glide: 'Glide (plane)', free: 'Free cam' })[this.flight.model]; }
    setUserSpeed(s) { this.flight.userSpeed = FV.clamp(s, 0.1, 8); FV.store.set('speed', this.flight.userSpeed); }
    toggleAutopilot() {
      const f = this.flight;
      if (f.engaged) { f.autopilot = false; f.idle = 0; this.ui.toast('Autopilot OFF - it re-engages after 20 s without input'); }
      else { f.autopilot = true; this.ui.toast('Autopilot ON - sticks still steer'); }
    }
    paletteName() { return this.paletteIdx < 0 ? 'Native' : this.scenes()[this.paletteIdx].name; }
    cyclePalette(d) {
      const n = this.scenes().length;
      let i = this.paletteIdx + (d || 1);
      if (i === this.sceneIdx) i += (d || 1);
      if (i >= n) i = -1; if (i < -1) i = n - 1;
      if (i === this.sceneIdx) i = -1;
      this.paletteIdx = i;
      this.renderer.invalidateHistory();
      this.ui.toast('Palette: ' + this.paletteName());
    }

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => this.ui.toast('Fullscreen needs a click or key press'));
    }

    async startAudio(kind, quiet) {
      this.ui.setStartError('');
      try {
        if (kind === 'system') await this.audio.startSystem();
        else if (kind === 'input') await this.audio.startInput();
        else if (kind === 'demo') this.audio.startDemo(this.demoAudible);
        else this.audio.stop();
        this.ui.hideStart();
        if (!quiet) this.ui.toast(kind === 'none' ? 'Exploring without audio' : 'Listening: ' + this.audio.label, 3);
      } catch (e) {
        console.warn(e);
        const msg = e && e.name === 'NotAllowedError' ? 'Capture was cancelled or blocked. Try again and pick "Entire screen" with "Share system audio" turned on.' : (e.message || String(e));
        this.ui.setStartError(msg);
      }
    }
    showAudioPicker() { this.ui.showStart(); }

    // ---------- tabs ----------
    tab() { return FV.tabs[this.tabIdx] || FV.tabs[0]; }
    scenes() { return this.tab().scenes; }
    scene() { return this.scenes()[this.sceneIdx] || this.scenes()[0]; }
    tabLabel() { return this.tab().name + ' (' + (this.tabIdx + 1) + '/' + FV.tabs.length + ')'; }

    setTab(i) {
      const n = FV.tabs.length;
      i = ((i % n) + n) % n;
      if (i === this.tabIdx && this.pendingTab == null) return;
      this.pendingTab = i; this.fadeTarget = 0;
    }

    _applyTab(i) {
      this.tabScene[this.tab().id] = this.sceneIdx;
      this.tabIdx = i;
      FV.store.set('tab', this.tab().id);
      FV.store.set('tabScene', this.tabScene);
      const want = this.tabScene[this.tab().id] || 0;
      this._applyScene(FV.clamp(want, 0, this.scenes().length - 1));
      this.ui.refreshMenu();
    }

    // ---------- scenes ----------
    setScene(i) {
      const n = this.scenes().length;
      i = ((i % n) + n) % n;
      this.pendingScene = i; this.fadeTarget = 0;
    }

    _applyScene(i, first) {
      const sc = this.scenes()[i];
      this.sceneIdx = i; FV.store.set('scene', i);
      this.tabScene[this.tab().id] = i; FV.store.set('tabScene', this.tabScene);
      this.paletteIdx = -1;
      const z4 = [0, 0, 0, 0];
      this.morph = { p0: (sc.p0 || z4).slice(), p1: (sc.p1 || z4).slice(), p2: (sc.p2 || z4).slice(), rot: (sc.rot || [0, 0, 0]).slice() };
      this.flight.place(sc.cam);
      this.flight.scale = sc.scaleClamp ? (sc.scaleClamp[0] + sc.scaleClamp[1]) * 0.25 : 1.0;
      this.renderer.probeResult = null;
      this.renderer.invalidateHistory();
      if (!first) this.ui.refreshMenu();
      this.ui.showTitle(sc.name, `${this.tab().name}  ${i + 1} / ${this.scenes().length}`);
    }

    // ---------- main loop ----------
    _resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
      this.renderer.resize(w, h);
    }

    _handleActions(ctl) {
      const A = ctl.actions;
      if (A.has('menu')) { this.ui.toggleMenu(); return this.ui.menuOpen; }
      if (this.ui.menuOpen) {
        this.ui.navigate(ctl.menuNav);
        this.ui.navigate(ctl.keyNav);
        return true;
      }
      if (A.has('nextTab')) this.setTab(this.tabIdx + 1);
      if (A.has('prevTab')) this.setTab(this.tabIdx - 1);
      if (A.has('nextScene')) this.setScene(this.sceneIdx + 1);
      if (A.has('prevScene')) this.setScene(this.sceneIdx - 1);
      for (const a of A) if (a.startsWith('scene:')) this.setScene(+a.slice(6));
      if (A.has('autopilot')) this.toggleAutopilot();
      if (A.has('reset')) { this._applyScene(this.sceneIdx); this.ui.toast('View reset'); }
      if (A.has('palette')) this.cyclePalette(1);
      if (A.has('hud')) this.ui.toggleHud();
      if (A.has('screenshot')) this.shotRequest = { download: true };
      if (A.has('reactivity')) { this.setReact((this.reactLevel + 1) % REACT.length); this.ui.toast('Reactivity: ' + ['Off', 'Low', 'Medium', 'High', 'Insane'][this.reactLevel]); }
      if (A.has('level')) { this.flight.levelHorizon(); this.ui.toast('Horizon levelled'); }
      if (A.has('photo')) { this.photoMode = !this.photoMode; this.renderer.invalidateHistory(); this.ui.toast(this.photoMode ? 'Photo mode: max detail (hold still to refine)' : 'Photo mode off'); }
      if (A.has('fullscreen')) this.toggleFullscreen();
      if (ctl.wheel) this.setUserSpeed(this.flight.userSpeed * (ctl.wheel < 0 ? 1.15 : 0.87));
      return false;
    }

    _sceneUniforms(sc, a, react) {
      const look = sc.look;
      const pal = this.paletteIdx >= 0 ? this.scenes()[this.paletteIdx].look : look;
      const f = this.flight;
      // Geometry is NOT driven by audio (changing the shape each frame defeats temporal
      // reconstruction and smears the image). Music drives colour and texture instead.
      const u = { p0: this.morph.p0.slice(), p1: this.morph.p1.slice(), p2: this.morph.p2.slice(), rot: this.morph.rot.slice() };
      const ar = { bass: a.bass * react, mid: a.mid * react, high: a.high * react, energy: a.energy * react, beat: a.beat * react,
        low: a.low * react, sub: a.sub * react, hat: a.hat * react };
      const flat = (arr) => { const o = new Float32Array(arr.length * 3); arr.forEach((c, i) => o.set(c, i * 3)); return o; };
      const col = (c, k) => { const v = FV.hexToRgb(c.col || c); const s = k == null ? (c.int ?? 1) : k; return [v[0] * s, v[1] * s, v[2] * s]; };
      const q = this.photoMode ? FV.QUALITY.ultra : this._q();
      const dt = this.dt, lo = Math.min(1.5, ar.low);
      const warp = this.warpMode === 'on' ? 1 : this.warpMode === 'off' ? 0 : (look.warp ?? 1);
      if (a.kick) this.palVel = (this.palVel || 0) + 0.06 * react;
      this.palVel = (this.palVel || 0) * Math.exp(-dt * 3);
      const sub = Math.min(1.5, ar.sub);
      if (warp) {
        // flowing mode: bass pushes colours along the bands, sub-bass ripples rings outward
        this.palShift += (0.006 + 0.22 * lo * lo + this.palVel) * dt;
        this.ringPhase = (this.ringPhase || 0) + (0.03 + 0.9 * sub * sub) * dt;
      } else {
        // calm mode: nothing slides across the surface; the whole palette changes hue in place
        this.palShift += 0.002 * dt;
        this.hue = (this.hue || 0) + (0.015 + 0.55 * lo * lo + 4 * this.palVel) * dt;
      }
      const ringSwell = 1 + (warp ? 1.4 : 0.5) * lo;
      const emis = look.emissive * (0.4 + (warp ? 2.6 : 1.2) * lo + 0.3 * ar.beat);
      const ambGain = 1 + (warp ? 0.1 : 0.3) * lo + 0.06 * ar.beat;
      return {
        uCamPos: new Float32Array(f.pos), uCamRot: FV.quat.toMat3(f.rot), uTanHalf: Math.tan((62 * Math.PI / 180) / 2),
        uTime: this.still ? 0 : this.time, uAudio: [ar.bass, ar.mid, ar.high, ar.energy], uBeat: ar.beat,
        uP0: u.p0, uP1: u.p1, uP2: u.p2, uRot: FV.rotMat3(u.rot[0], u.rot[1], u.rot[2]),
        uScale: f.scale, uStepFactor: FV.fractals.programs[sc.program].stepFactor,
        uFar: Math.min(sc.far, Math.max(f.scale, 1e-5) * 600),
        uMaxSteps: q.steps, uDetail: q.detail * this.renderer.rh / Math.max(1, this.renderer.hh),
        uShadowSteps: q.shadow, uAOSteps: q.ao,
        uAOStrength: look.ao.strength, uCavity: look.ao.cavity, uContrastAO: look.ao.steps, uShadowFloor: 0.35,
        uLightDir: FV.v3.norm(look.light.dir), uLightCol: col(pal.light, (pal.light.int ?? 1)),
        uAmbCol: col(pal.amb), uHeadlight: look.head,
        uFogCol: col(pal.fog.col, 1), uFogDen: look.fog.den,
        uBase: flat(pal.base), uAcc: flat(pal.acc),
        uTrapW: look.trapW, uAccW: look.accW, uCol: look.col,
        uPalShift: this.still ? 0 : this.palShift,
        uEmissive: emis,
        uRingPhase: this.still ? 0 : this.ringPhase, uRingSwell: ringSwell, uWarp: warp, uHue: this.still ? 0 : (this.hue || 0), uAmbGain: ambGain, uShimmer: Math.min(1.2, ar.hat + 0.4 * ar.high),
        uSpec: look.spec, uSpecPow: look.specPow, uRimLight: look.rim,
        uBgA: col(pal.bg.a, 1), uBgB: col(pal.bg.b, 1),
      };
    }

    // Adaptive resolution. Budgets leave headroom below the display refresh: a frame that
    // misses vsync by 1 ms halves the frame rate, so we react before that happens.
    _dynamicResolution(dt) {
      if (this.params.has('scale')) return;
      const r = this.renderer;
      const raw = this._raw || (this._raw = []);
      raw.push(dt * 1000); if (raw.length > 90) raw.shift();
      this.dynTimer += dt;
      if (this.dynTimer < 0.5 || raw.length < 20) return;
      this.dynTimer = 0;
      const sorted = raw.slice().sort((x, y) => x - y);
      const vsync = Math.max(sorted[Math.floor(sorted.length * 0.1)], 4);   // fastest frames ~ refresh interval
      const median = sorted[Math.floor(sorted.length * 0.5)];
      const budget = Math.max(1000 / (this.photoMode ? 20 : this.targetFps), vsync * 0.98);
      const gpu = r.gpuMs;
      const tiers = ['low', 'medium', 'high', 'fine'];   // auto stops below ultra: ultra adds shadows, which changes the look
      let tier = this.quality === 'auto' ? (this.autoTier || 'high') : this.quality;
      const q = this.photoMode ? FV.QUALITY.ultra : FV.QUALITY[tier];
      let s = r.renderScale;
      const now = this.time;
      let slow, fast;
      if (gpu > 0) { slow = gpu > budget * 0.9; fast = gpu < budget * 0.68; }
      else { slow = median > budget * 1.15; fast = median < budget * 1.04; }
      if (slow) {
        const ratio = gpu > 0 ? budget * 0.8 / gpu : budget / median;
        s *= FV.clamp(Math.sqrt(ratio), 0.7, 0.94);
        this.failScale = r.renderScale; this.failTime = now; this.goodTime = 0;
      } else if (fast) {
        this.goodTime += 0.5;
        const capped = this.failTime != null && now - this.failTime < 12 && s * 1.06 > this.failScale * 0.96;
        if (this.goodTime >= (gpu > 0 ? 1 : 2) && !capped) { s *= 1.06; this.goodTime = 0; }
      } else this.goodTime = 0;
      // auto: below 55% resolution, spend less on lighting instead of blurring the image;
      // climb a tier when the frame is already at full resolution with time to spare.
      // Tier changes are held apart (8 s) so a borderline GPU cannot pump between them.
      if (this.quality === 'auto' && !this.photoMode) {
        const ti = tiers.indexOf(tier);
        const settled = this.tierTime == null || now - this.tierTime > 8;
        if (s < 0.55 && ti > 0) { this.autoTier = tiers[ti - 1]; s = Math.min(0.7, s * 1.2); this.failTime = null; this.tierTime = now; }
        else if (settled && s >= FV.QUALITY[tier].maxScale && fast && ti < tiers.length - 1 && this.goodTime === 0) {
          this.autoTier = tiers[ti + 1]; s *= 0.9; this.tierTime = now;
        }
        tier = this.autoTier || tier;
      }
      // last resort for very slow GPUs: lower the output resolution itself
      if (s < 0.5 && r.maxHistW > 1280 && this.resMode === 'auto') { r.setMaxHistWidth(Math.max(1280, Math.round(r.maxHistW * 0.8))); this.histCapped = r.maxHistW; s = 0.6; }
      // recover output resolution once there is clear headroom again
      if (this.histCapped && fast && s >= FV.QUALITY[tier].maxScale * 0.98 && this.goodTime === 0) {
        this.histCapped = Math.min(this.resCap(), Math.round(this.histCapped * 1.15));
        if (this.histCapped >= this.resCap()) this.histCapped = 0;
        r.setMaxHistWidth(this.histCapped || this.resCap()); s *= 0.9;
      }
      s = FV.clamp(s, 0.5, FV.QUALITY[tier].maxScale);
      if (Math.abs(s - r.renderScale) > 0.015) r.setRenderScale(s);
    }

    _frame(now) {
      requestAnimationFrame((t) => this._frame(t));
      const dt = this.lastNow ? FV.clamp((now - this.lastNow) / 1000, 1 / 240, 0.1) : 1 / 60;
      this.lastNow = now; this.dt = dt;
      this.frameMs = FV.lerp(this.frameMs, dt * 1000, 0.08);
      this.fps = 1000 / this.frameMs;

      const r = this.renderer;
      const sc = this.scene();
      if (!r.ready(sc.program)) { this.ui.setLoading('Compiling fractal shaders…'); return; }
      const err = r.errorFor(sc.program);
      if (err) { this.ui.setLoading('Shader error - see console'); return; }
      const all = r.allReady();
      if (!all) r.compileNext();
      this.ui.setLoading(all || this.ui.startVisible() ? '' : 'Preparing other fractals…');

      this.time += dt;
      const a = this.audio.update(dt);
      const react = REACT[this.reactLevel];
      const ctl = this.input.poll(dt, now / 1000);
      const blocked = this._handleActions(ctl) || this.ui.startVisible();
      if (blocked) { ctl.move = [0, 0, 0]; ctl.look = [0, 0]; ctl.roll = 0; ctl.morph = 0; }

      // morph the main shape parameter with D-pad up/down (or R/F)
      if (ctl.morph && sc.morph) {
        const m = sc.morph, arr = this.morph[m.key];
        arr[m.idx] = FV.clamp(arr[m.idx] + ctl.morph * m.rate * dt, m.min, m.max);
        this.renderer.invalidateHistory();
      }

      this._updateRumble(a, react, now / 1000);

      this.flight.parked = this.photoMode;     // photo mode: hold still unless asked to move
      this.flight.update(dt, ctl, r.probeResult, sc, a, react);

      // scene fade transitions
      this.fade = FV.lerp(this.fade, this.fadeTarget, FV.damp(9, dt));
      if (this.pendingTab != null && this.fade < 0.02) {
        const pt = this.pendingTab; this.pendingTab = null;
        this._applyTab(pt);
        this.fadeTarget = 1;
      }
      if (this.pendingScene != null && this.fade < 0.02) {
        const ps = this.pendingScene; this.pendingScene = null;
        if (r.ready(this.scenes()[ps].program)) { this._applyScene(ps); }
        else this.ui.toast('Still compiling that one…');
        this.fadeTarget = 1;
      }

      r.setMaxHistWidth(this.photoMode ? 3840 : (this.histCapped || this.resCap()));
      const scene = this._sceneUniforms(sc, a, react);
      const look = this.paletteIdx >= 0 ? this.scenes()[this.paletteIdx].look : sc.look;
      const moving = FV.v3.len(this.flight.vel) / Math.max(this.flight.de, 1e-9);
      r.render({
        programId: sc.program, scene, taa: true,
        taaBlend: this.photoMode ? 0.04 : FV.clamp(0.09 + moving * 0.02, 0.09, 0.2),
        post: {
          exposure: look.post.exposure, bloom: look.post.bloom * this.bloomMul,
          vignette: this.lensFx ? 0.35 : 0.0, ca: this.lensFx ? 0.5 : 0, sharpen: 0.35, sat: look.post.sat, contrast: look.post.contrast,
        },
        fade: this.fade, time: this.time,
      });
      if (this.shotRequest) { this._takeShot(this.shotRequest); this.shotRequest = null; }
      this._dynamicResolution(dt);
      this.ui.update(dt, this);
    }

    _takeShot(req) {
      const name = `fractal-${this.scene().name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.png`;
      if (req.dataUrl) { req.resolve(this.canvas.toDataURL('image/png')); return; }
      this.canvas.toBlob((b) => {
        const url = URL.createObjectURL(b); const el = document.createElement('a');
        el.href = url; el.download = name; el.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      }, 'image/png');
      this.ui.toast('Screenshot saved to Downloads');
    }

    _exposeDebug() {
      const app = this;
      window.__fv = {
        app,
        capture: () => new Promise((resolve) => { app.shotRequest = { dataUrl: true, resolve }; }),
        // dev-server only: saves a PNG next to the project for visual comparison
        shot: async (name) => {
          const data = await window.__fv.capture();
          const r = await fetch('/shot?name=' + encodeURIComponent(name), { method: 'POST', body: data });
          return r.text();
        },
        cam: () => ({ pos: app.flight.pos, fwd: app.flight.forward(), de: app.flight.de, scale: app.flight.scale }),
        place: (pos, fwd) => { app.flight.place({ pos, fwd }); app.renderer.invalidateHistory(); },
        scene: (i) => { app._applyScene(i); },
      };
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    try { window.app = new App(); }
    catch (e) {
      console.error(e);
      document.getElementById('loading').textContent = 'Could not start: ' + e.message;
      document.getElementById('loading').style.display = 'block';
    }
  });
})(window.FV);
