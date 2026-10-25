// DOM overlay: start screen, HUD, controller-navigable settings menu, toasts.
'use strict';
(function (FV) {
  const $ = (id) => document.getElementById(id);

  class UI {
    constructor(app) {
      this.app = app;
      this.hudVisible = FV.store.get('hud', true);
      this.menuOpen = false;
      this.menuIdx = 0;
      this.toastTimer = 0;
      this.titleTimer = 0;
      this.meters = $('meters').querySelectorAll('i');
      this._bindStart();
      this._buildMenu();
      $('hud').classList.toggle('hidden', !this.hudVisible);
    }

    _bindStart() {
      const a = this.app;
      $('btnSystem').onclick = () => a.startAudio('system');
      $('btnInput').onclick = () => a.startAudio('input');
      $('btnDemo').onclick = () => a.startAudio('demo');
      $('btnNone').onclick = () => a.startAudio('none');
      $('menuBtn').onclick = () => this.toggleMenu();
      $('fsBtn').onclick = () => a.toggleFullscreen();
    }

    hideStart() { $('start').classList.add('hidden'); }
    showStart() { $('start').classList.remove('hidden'); }
    startVisible() { return !$('start').classList.contains('hidden'); }
    setStartError(msg) { const e = $('startErr'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }
    setLoading(msg) { const e = $('loading'); e.textContent = msg || ''; e.style.display = msg ? 'block' : 'none'; }

    toast(msg, secs) {
      const t = $('toast'); t.textContent = msg; t.classList.add('show');
      this.toastTimer = secs || 2.2;
    }

    showTitle(name, sub) {
      $('title').textContent = name; $('subtitle').textContent = sub || '';
      $('titleBox').classList.add('show');
      this.titleTimer = 3.5;
    }

    toggleHud() {
      this.hudVisible = !this.hudVisible; FV.store.set('hud', this.hudVisible);
      $('hud').classList.toggle('hidden', !this.hudVisible);
    }

    // --- menu ---
    _items() {
      const a = this.app;
      return [
        { label: 'Tab', get: () => a.tabLabel(), step: (d) => a.setTab(a.tabIdx + d) },
        { label: 'Scene', get: () => a.scene().name, step: (d) => a.setScene(a.sceneIdx + d) },
        { label: 'Palette', get: () => a.paletteName(), step: (d) => a.cyclePalette(d) },
        { label: 'Audio source', get: () => a.audio.label, action: () => { this.toggleMenu(false); a.showAudioPicker(); } },
        { label: 'Reactivity', get: () => ['Off', 'Low', 'Medium', 'High', 'Insane'][a.reactLevel], step: (d) => a.setReact(a.reactLevel + d) },
        { label: 'Autopilot', get: () => a.flight.autopilot ? 'On' : (a.flight.engaged ? 'Auto (idle)' : 'After 20 s idle'), step: () => a.toggleAutopilot() },
        { label: 'Flight model', get: () => a.flightModelLabel(), step: (d) => a.cycleFlightModel(d) },
        { label: 'Flight speed', get: () => a.flight.userSpeed.toFixed(2) + 'x', step: (d) => a.setUserSpeed(a.flight.userSpeed * (d > 0 ? 1.25 : 0.8)) },
        { label: 'Quality', get: () => a.qualityLabel(), step: (d) => a.cycleQuality(d) },
        { label: 'Output resolution', get: () => a.resLabel(), step: (d) => a.cycleRes(d) },
        { label: 'Colour flow', get: () => ({ scene: 'On (default)', on: 'On', off: 'Off (flat hue shift)' })[a.warpMode], step: (d) => a.cycleWarp(d) },
        { label: 'Target FPS', get: () => String(a.targetFps), step: () => a.cycleTargetFps() },
        { label: 'Bloom', get: () => Math.round(a.bloomMul * 100) + '%', step: (d) => a.setBloom(a.bloomMul + d * 0.25) },
        { label: 'Lens effects', get: () => a.lensFx ? 'On' : 'Off', step: () => a.setLens(!a.lensFx) },
        { label: 'Controller rumble', get: () => a.rumbleLabel(), step: (d) => a.cycleRumble(d) },
        { label: 'Direct haptics', get: () => a.hapticsLabel(), action: () => a.connectHaptics() },
        { label: 'Demo beat audible', get: () => a.demoAudible ? 'On' : 'Off', step: () => a.setDemoAudible(!a.demoAudible) },
        { label: 'Show stats', get: () => a.showStats ? 'On' : 'Off', step: () => a.setStats(!a.showStats) },
        { label: 'Fullscreen', get: () => document.fullscreenElement ? 'On' : 'Off', action: () => a.toggleFullscreen() },
        { label: 'Controls help', get: () => '', action: () => { this.toggleMenu(false); $('help').classList.toggle('hidden'); } },
      ];
    }

    _buildMenu() {
      const list = $('menuList');
      list.innerHTML = '';
      this.items = this._items();
      this.items.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'mrow';
        row.innerHTML = `<span class="ml"></span><span class="mv"><b class="arr">&#8249;</b><span class="val"></span><b class="arr">&#8250;</b></span>`;
        row.querySelector('.ml').textContent = it.label;
        const arrs = row.querySelectorAll('.arr');
        arrs[0].onclick = (e) => { e.stopPropagation(); this.menuIdx = i; this._step(-1); };
        arrs[1].onclick = (e) => { e.stopPropagation(); this.menuIdx = i; this._step(1); };
        row.onclick = () => { this.menuIdx = i; if (it.action) it.action(); else this._step(1); };
        if (it.action) arrs.forEach((x) => x.style.visibility = 'hidden');
        list.appendChild(row);
      });
      this.refreshMenu();
    }

    _step(d) { const it = this.items[this.menuIdx]; if (it.step) it.step(d); else if (it.action) it.action(); this.refreshMenu(); }

    refreshMenu() {
      if (!this.items) return;
      const rows = $('menuList').children;
      this.items.forEach((it, i) => {
        rows[i].querySelector('.val').textContent = it.get();
        rows[i].classList.toggle('sel', i === this.menuIdx);
      });
    }

    toggleMenu(force) {
      this.menuOpen = force != null ? force : !this.menuOpen;
      $('menu').classList.toggle('hidden', !this.menuOpen);
      if (this.menuOpen) { $('help').classList.add('hidden'); this.refreshMenu(); }
    }

    navigate(nav) {
      if (!nav) return;
      const n = this.items.length;
      if (nav.up) this.menuIdx = (this.menuIdx + n - 1) % n;
      if (nav.down) this.menuIdx = (this.menuIdx + 1) % n;
      if (nav.left) this._step(-1);
      if (nav.right) this._step(1);
      if (nav.ok) { const it = this.items[this.menuIdx]; if (it.action) it.action(); else this._step(1); }
      if (nav.back) this.toggleMenu(false);
      this.refreshMenu();
    }

    update(dt, a) {
      if (this.toastTimer > 0) { this.toastTimer -= dt; if (this.toastTimer <= 0) $('toast').classList.remove('show'); }
      if (this.titleTimer > 0) { this.titleTimer -= dt; if (this.titleTimer <= 0) $('titleBox').classList.remove('show'); }
      const f = a.audio.f;
      const vals = [f.sub, f.bass, f.lowmid, f.mid, f.high];
      for (let i = 0; i < 5; i++) this.meters[i].style.transform = `scaleY(${0.04 + 0.96 * vals[i]})`;
      $('beatDot').style.opacity = (0.15 + 0.85 * f.beat).toFixed(2);
      if (a.showStats) {
        $('stats').textContent = `${a.fps.toFixed(0)} fps  ${a.renderer.rw}x${a.renderer.rh} (${Math.round(a.renderer.renderScale * 100)}%)` +
          `${a.renderer.gpuMs ? '  gpu ' + a.renderer.gpuMs.toFixed(1) + 'ms' : ''}  depth ${a.flight.de.toExponential(1)}` +
          `${a.flight.engaged ? '  AUTO' : ''}${a.photoMode ? '  PHOTO' : ''}${a.input.pad ? '  pad:' + (a.input.padSource || '?') + ' rumble:' + a.input.rumbleState : '  no pad'}` +
          '\nGPU: ' + (a.renderer.gpuName || 'unknown').replace(/^ANGLE \(|\)$/g, '').replace(/ Direct3D.*$/, '') +
          (a.renderer.passMs ? '\n' + Object.entries(a.renderer.passMs).map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  ') + ' ms' : '');
      }
      $('stats').style.display = a.showStats ? 'block' : 'none';
      $('padState').textContent = a.input.pad ? '🎮 ' + (/054c|dualsense|wireless/i.test(a.input.padName) ? 'DualSense' : 'Controller') : '';
      $('srcState').textContent = a.audio.mode === 'none' ? 'no audio' : a.audio.label;
    }
  }

  FV.UI = UI;
})(window.FV);
