// Audio capture + analysis.
// Spotify's Web API no longer exposes audio analysis to new apps, so we react to the
// actual sound: system audio via screen-capture (Chrome/Edge on Windows can share
// "system audio" with an entire-screen share), a mic/line-in device, or a built-in demo beat.
'use strict';
(function (FV) {
  const BANDS = [
    ['sub', 20, 60], ['bass', 60, 250], ['lowmid', 250, 800], ['mid', 800, 3000], ['high', 3000, 14000],
  ];

  class AudioEngine {
    constructor() {
      this.ctx = null; this.analyser = null; this.source = null; this.stream = null;
      this.mode = 'none'; this.label = 'No audio';
      this.onEnded = null;
      this.f = { sub: 0, bass: 0, lowmid: 0, mid: 0, high: 0, energy: 0, beat: 0, kick: false, level: 0, low: 0, hat: 0,
        haptic: 0, hapticPunch: 0 };
      this.hapRef = 0;            // slow AGC reference for the haptic channel
      this.raw = {}; this.peak = {}; this.floor = {};
      for (const [n] of BANDS) { this.raw[n] = 0; this.peak[n] = 1e-6; this.floor[n] = 0; }
      this.prevSpec = null; this.fluxHist = []; this.lastBeat = 0; this.beatInterval = 0.5;
      this.musicTime = 0;
    }

    _ensureCtx() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.0;
        this.analyser.minDecibels = -100; this.analyser.maxDecibels = -10;
        this.spec = new Float32Array(this.analyser.frequencyBinCount);
        this.wave = new Float32Array(this.analyser.fftSize);

        // Everything feeds a bus so the haptic chain can tap the same audio.
        this.bus = this.ctx.createGain();
        this.bus.connect(this.analyser);

        // Haptic tap: a bass-only version of the signal, read in the time domain.
        // Band energies from the FFT are level meters - slow, compressed and smeared across
        // a window - which is why they feel vague. A transducer (Woojer, Crusher) is driven
        // by the low-passed waveform itself, so we follow that envelope instead: the kick's
        // attack and every wobble of a bassline survive.
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass'; hp.frequency.value = 18; hp.Q.value = 0.7;      // drop DC / capture rumble
        const lp1 = this.ctx.createBiquadFilter();
        lp1.type = 'lowpass'; lp1.frequency.value = 150; lp1.Q.value = 0.707;
        const lp2 = this.ctx.createBiquadFilter();
        lp2.type = 'lowpass'; lp2.frequency.value = 150; lp2.Q.value = 0.707;  // 24 dB/oct in total
        this.hapAn = this.ctx.createAnalyser();
        this.hapAn.fftSize = 1024;            // ~21 ms window: fast enough to feel like the sound
        this.hapAn.smoothingTimeConstant = 0;
        this.bus.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(this.hapAn);
        this.hapWave = new Float32Array(this.hapAn.fftSize);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    stop() {
      if (this.demo) { this.demo.stop(); this.demo = null; }
      if (this.source) { try { this.source.disconnect(); } catch (e) { /* already disconnected */ } this.source = null; }
      if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
      this.mode = 'none'; this.label = 'No audio';
    }

    _attachStream(stream, mode, label) {
      this._ensureCtx();
      this.stop();
      this.stream = stream;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.bus);               // analysis only, never to speakers (no echo)
      this.mode = mode; this.label = label;
      const at = stream.getAudioTracks()[0];
      if (at) at.addEventListener('ended', () => { if (this.stream === stream) { this.stop(); this.onEnded && this.onEnded(); } });
    }

    // System audio (what Spotify is playing). User picks "Entire screen" + "Share system audio".
    async startSystem() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error('Screen/audio capture is not supported in this browser. Use Chrome or Edge.');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1, width: 64, height: 64 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
        systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
        preferCurrentTab: false,
      });
      const at = stream.getAudioTracks();
      if (!at.length) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error('No audio was shared. Choose "Entire screen" (or the Spotify Web Player tab) and switch ON "Also share system audio".');
      }
      // The video track is only a carrier for the audio; drop it to save power.
      stream.getVideoTracks().forEach((t) => { t.stop(); stream.removeTrack(t); });
      this._attachStream(stream, 'system', 'System audio (Spotify)');
    }

    async listInputs() {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        return devs.filter((d) => d.kind === 'audioinput');
      } catch (e) { return []; }
    }

    async startInput(deviceId) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const t = stream.getAudioTracks()[0];
      this._attachStream(stream, 'input', t ? t.label || 'Audio input' : 'Audio input');
    }

    startDemo(audible) {
      this._ensureCtx();
      this.stop();
      this.demo = new DemoBeat(this.ctx, this.bus, audible);
      this.mode = 'demo'; this.label = 'Demo beat';
    }

    setDemoAudible(on) { if (this.demo) this.demo.setAudible(on); }

    update(dt) {
      const f = this.f;
      const active = this.analyser && this.mode !== 'none';
      if (!active) {
        // gentle synthetic motion so the visuals still breathe with no audio
        for (const k of ['sub', 'bass', 'lowmid', 'mid', 'high', 'energy', 'level', 'low', 'hat']) f[k] *= Math.exp(-dt * 3);
        f.beat *= Math.exp(-dt * 5); f.kick = false;
        f.haptic *= Math.exp(-dt * 8); f.hapticPunch = 0;
        this.musicTime += dt * 0.5;
        return f;
      }
      const an = this.analyser;
      an.getFloatFrequencyData(this.spec);
      const sr = this.ctx.sampleRate, binHz = sr / an.fftSize, N = this.spec.length;

      // linear magnitudes
      const mag = this._mag || (this._mag = new Float32Array(N));
      for (let i = 0; i < N; i++) { const db = this.spec[i]; mag[i] = db > -160 ? Math.pow(10, db / 20) : 0; }

      let total = 0;
      for (const [name, lo, hi] of BANDS) {
        const a = Math.max(1, Math.floor(lo / binHz)), b = Math.min(N - 1, Math.ceil(hi / binHz));
        let s = 0; for (let i = a; i <= b; i++) s += mag[i] * mag[i];
        const v = Math.sqrt(s / (b - a + 1));
        total += v;
        // adaptive normalisation: track a slowly decaying peak and a floor
        this.peak[name] = Math.max(v, this.peak[name] * Math.exp(-dt * 0.15), 1e-5);
        this.floor[name] = Math.min(v, FV.lerp(this.floor[name], v, FV.damp(0.3, dt)));
        let n = (v - this.floor[name]) / Math.max(this.peak[name] - this.floor[name], 1e-6);
        n = FV.clamp(n, 0, 1);
        n = Math.pow(n, 1.4);
        const prev = f[name];
        const rate = n > prev ? 28 : 7;   // fast attack, slower release
        f[name] = FV.lerp(prev, n, FV.damp(rate, dt));
      }
      f.level = FV.lerp(f.level, Math.min(1, total * 4), FV.damp(10, dt));
      f.energy = FV.lerp(f.energy, FV.clamp(1.9 * (0.35 * f.bass + 0.25 * f.lowmid + 0.25 * f.mid + 0.15 * f.high), 0, 1), FV.damp(2.5, dt));

      // beat detection: spectral flux of the low end vs. an adaptive threshold
      const lo = Math.max(1, Math.floor(30 / binHz)), hi = Math.ceil(180 / binHz);
      let flux = 0;
      if (this.prevSpec) for (let i = lo; i <= hi; i++) { const d = mag[i] - this.prevSpec[i]; if (d > 0) flux += d; }
      if (!this.prevSpec) this.prevSpec = new Float32Array(N);
      this.prevSpec.set(mag);
      const H = this.fluxHist; H.push(flux); if (H.length > 50) H.shift();
      let mean = 0; for (const x of H) mean += x; mean /= H.length;
      let vari = 0; for (const x of H) vari += (x - mean) * (x - mean); vari = Math.sqrt(vari / H.length);
      const now = this.ctx.currentTime;
      f.kick = false;
      if (flux > mean + 1.4 * vari && flux > 1e-4 && now - this.lastBeat > 0.24) {
        const iv = now - this.lastBeat;
        if (iv < 1.5) this.beatInterval = FV.lerp(this.beatInterval, iv, 0.2);
        this.lastBeat = now; f.beat = 1; f.kick = true;
      } else {
        f.beat *= Math.exp(-dt * 5.5);
      }
      // high-frequency onsets (hats/snares) -> small background shimmer pulses
      const hlo = Math.floor(2500 / binHz), hhi = Math.min(N - 1, Math.ceil(12000 / binHz));
      let hflux = 0;
      for (let i = hlo; i <= hhi; i++) { const d = mag[i] - (this.prevHigh ? this.prevHigh[i] : mag[i]); if (d > 0) hflux += d; }
      if (!this.prevHigh) this.prevHigh = new Float32Array(N);
      this.prevHigh.set(mag);
      const HH = this.hfluxHist || (this.hfluxHist = []); HH.push(hflux); if (HH.length > 40) HH.shift();
      let hm = 0; for (const x of HH) hm += x; hm /= HH.length;
      let hv = 0; for (const x of HH) hv += (x - hm) * (x - hm); hv = Math.sqrt(hv / HH.length);
      if (hflux > hm + 1.5 * hv && hflux > 1e-5 && now - (this.lastHat || 0) > 0.09) { this.lastHat = now; f.hat = 1; }
      else f.hat = (f.hat || 0) * Math.exp(-dt * 9);
      // low-end envelope for dubstep: sub + bass, slower release so wobbles read as swells
      const lowNow = Math.max(f.sub, f.bass);
      f.low = FV.lerp(f.low || 0, lowNow, FV.damp(lowNow > (f.low || 0) ? 20 : 4, dt));
      this._haptics(dt, f);
      this.musicTime += dt * (0.4 + 1.6 * f.energy);
      return f;
    }
  }

  // Bass you can feel. Follows the low-passed waveform with a near-instant attack and a
  // short release, so a kick lands as a thump and a wobble bassline reads as the wobble
  // rather than as one long buzz. The level is normalised slowly (over seconds), which
  // keeps the dynamics inside a bar intact instead of flattening them like the band meters do.
  AudioEngine.prototype._haptics = function (dt, f) {
    const an = this.hapAn;
    if (!an) { f.haptic = 0; f.hapticPunch = 0; return; }
    an.getFloatTimeDomainData(this.hapWave);
    const w = this.hapWave;
    let peak = 0, sum = 0;
    for (let i = 0; i < w.length; i++) { const v = w[i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sum += v * v; }
    const rms = Math.sqrt(sum / w.length);
    // body from the rms, snap from the peak
    const inst = Math.max(rms * 1.7, peak * 0.85);

    // slow AGC: track a decaying reference so quiet tracks still come through, without
    // flattening the difference between a soft bar and the drop
    // The reference decays slowly (~15 s) so it tracks the capture gain, not the music.
    // A fast one would normalise a quiet bar straight back up to full and flatten the
    // track's dynamics - the opposite of what a transducer does.
    this.hapRef = Math.max(inst, this.hapRef * Math.exp(-dt / 15));
    const ref = Math.max(this.hapRef, 0.02);
    let n = inst / ref;

    // expander: silence stays silent, and the loud part of the range gets the travel
    n = FV.clamp((n - 0.1) / 0.9, 0, 1);
    n = Math.pow(n, 0.8);
    // Absolute presence gate. Measured through this same filter chain, real bass sits at
    // 0.12-1.1 while hats, vocals and mids leak only about 0.02. Without this, a long
    // bass-free passage would let the AGC creep that leakage up into a constant buzz.
    n *= FV.clamp((inst - 0.03) / 0.05, 0, 1);

    const prev = f.haptic;
    // attack is almost instant, release is quick but not clicky
    const rate = n > prev ? 90 : 11;
    f.haptic = FV.lerp(prev, n, FV.damp(rate, dt));
    // transient: how hard it just jumped, for the snap on top of the body
    f.hapticPunch = FV.clamp((f.haptic - prev) / Math.max(dt, 1e-3) * 0.06, 0, 1);
  };

  // Small synthesized techno loop so everything can be tried without Spotify.
  class DemoBeat {
    constructor(ctx, analyser, audible) {
      this.ctx = ctx; this.out = ctx.createGain(); this.out.gain.value = 0.8;
      this.out.connect(analyser);
      this.spk = ctx.createGain(); this.spk.gain.value = audible ? 0.5 : 0; this.out.connect(this.spk); this.spk.connect(ctx.destination);
      this.bpm = 124; this.step = 0; this.next = ctx.currentTime + 0.1; this.running = true;
      const len = ctx.sampleRate * 0.5; const b = ctx.createBuffer(1, len, ctx.sampleRate); const d = b.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = b;
      this.timer = setInterval(() => this._schedule(), 25);
    }
    setAudible(on) { this.spk.gain.value = on ? 0.5 : 0; }
    stop() { this.running = false; clearInterval(this.timer); try { this.out.disconnect(); this.spk.disconnect(); } catch (e) { /* ignore */ } }
    _schedule() {
      const ctx = this.ctx, spb = 60 / this.bpm / 4;
      while (this.next < ctx.currentTime + 0.12) {
        const s = this.step % 64, t = this.next;
        if (s % 4 === 0) this._kick(t);
        if (s % 4 === 2) this._hat(t, 0.35);
        if (s % 2 === 1) this._hat(t, 0.12);
        if (s % 8 === 4) this._clap(t);
        const notes = [36, 36, 48, 36, 39, 36, 43, 41];
        if (s % 2 === 0) this._bass(t, notes[(s >> 1) % 8] + (s >= 32 ? 3 : 0), spb * 1.6);
        this.step++; this.next += spb;
      }
    }
    _env(g, t, a, peak, dec) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(1e-4, t + a + dec); }
    _kick(t) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      this._env(g, t, 0.002, 1.0, 0.35); o.connect(g); g.connect(this.out); o.start(t); o.stop(t + 0.5);
    }
    _hat(t, v) {
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = this.ctx.createGain(); this._env(g, t, 0.001, v, 0.05);
      s.connect(f); f.connect(g); g.connect(this.out); s.start(t); s.stop(t + 0.1);
    }
    _clap(t) {
      const s = this.ctx.createBufferSource(); s.buffer = this.noise;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
      const g = this.ctx.createGain(); this._env(g, t, 0.002, 0.5, 0.18);
      s.connect(f); f.connect(g); g.connect(this.out); s.start(t); s.stop(t + 0.3);
    }
    _bass(t, midi, dur) {
      const o = this.ctx.createOscillator(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      o.type = 'sawtooth'; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(140, t + dur); f.Q.value = 6;
      this._env(g, t, 0.005, 0.25, dur); o.connect(f); f.connect(g); g.connect(this.out); o.start(t); o.stop(t + dur + 0.05);
    }
  }

  FV.AudioEngine = AudioEngine;
})(window.FV);
