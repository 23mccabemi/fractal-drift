// Input: PS5 DualSense (Gamepad API), keyboard + mouse, touch (Surface screen).
'use strict';
(function (FV) {
  // Logical buttons in the W3C "standard" layout (Chrome/Edge expose DualSense this way).
  const STD = {
    cross: 0, circle: 1, square: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
    create: 8, options: 9, l3: 10, r3: 11, up: 12, down: 13, left: 14, right: 15, ps: 16, touchpad: 17,
  };
  // Raw DirectInput layout some browsers report for DualSense over Bluetooth.
  const DS_RAW = {
    square: 0, cross: 1, circle: 2, triangle: 3, l1: 4, r1: 5, l2: 6, r2: 7,
    create: 8, options: 9, l3: 10, r3: 11, ps: 12, touchpad: 13,
  };

  const dead = (x, y, dz) => {
    const m = Math.hypot(x, y);
    if (m < dz) return [0, 0];
    const k = Math.min(1, (m - dz) / (1 - dz));
    const c = k * k * (0.35 + 0.65 * k) / m;     // smooth response curve
    return [x * c, y * c];
  };

  // ---------------------------------------------------------------------------
  // DualSense haptics over WebHID.
  // Chromium only drives the DualSense motors through the Gamepad API over USB; over
  // Bluetooth it reports no vibration support at all. Talking to the controller directly
  // works on both transports, so this is the Bluetooth fix - it just needs a one-time
  // permission click (a controller button cannot grant it; use the mouse or keyboard).
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return (bytes) => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
  })();

  class DualSenseHID {
    constructor(dev) {
      this.dev = dev;
      this.seq = 0;
      this.state = null;        // latest sticks/buttons, read from the controller itself
      this.stamp = 0;
      dev.addEventListener('inputreport', (e) => this._onReport(e));
      // Bluetooth exposes the big 0x31 input report; USB does not.
      this.bt = !!(dev.collections || []).some((c) => (c.inputReports || []).some((r) => r.reportId === 0x31));
      this.last = [-1, -1];
    }

    static available() { return !!(navigator.hid && navigator.hid.requestDevice); }

    // DualSense input report: report 0x01 over USB, 0x31 over Bluetooth (same layout,
    // one byte further in). The short 0x01 Bluetooth report is the pre-full-mode one and
    // has a different layout, so it is ignored.
    _onReport(e) {
      const d = e.data, id = e.reportId;
      let o = -1;
      if (id === 0x01 && d.byteLength >= 10) o = 0;
      else if (id === 0x31 && d.byteLength >= 11) o = 1;
      if (o < 0) return;
      const b = (i) => d.getUint8(o + i);
      const ax = (i) => FV.clamp((b(i) - 128) / 127.5, -1, 1);
      const b0 = b(7), b1 = b(8), b2 = b(9);
      const hat = b0 & 0x0f;                  // 0 = N, clockwise, 8 = centred
      this.state = {
        lx: ax(0), ly: ax(1), rx: ax(2), ry: ax(3),
        l2: b(4) / 255, r2: b(5) / 255,
        square: (b0 >> 4) & 1, cross: (b0 >> 5) & 1, circle: (b0 >> 6) & 1, triangle: (b0 >> 7) & 1,
        l1: b1 & 1, r1: (b1 >> 1) & 1, create: (b1 >> 4) & 1, options: (b1 >> 5) & 1,
        l3: (b1 >> 6) & 1, r3: (b1 >> 7) & 1,
        ps: b2 & 1, touchpad: (b2 >> 1) & 1,
        up: (hat === 7 || hat === 0 || hat === 1) ? 1 : 0,
        right: (hat >= 1 && hat <= 3) ? 1 : 0,
        down: (hat >= 3 && hat <= 5) ? 1 : 0,
        left: (hat >= 5 && hat <= 7) ? 1 : 0,
      };
      this.stamp = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    }

    // fresh means the controller is actually reporting, not just opened
    fresh() {
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      return !!this.state && (now - this.stamp) < 1000;
    }

    // Reconnects silently to a controller the user has already granted.
    static async reconnect() {
      if (!DualSenseHID.available()) return null;
      try {
        const devs = await navigator.hid.getDevices();
        const d = devs.find((x) => x.vendorId === 0x054c);
        if (!d) return null;
        if (!d.opened) await d.open();
        return new DualSenseHID(d);
      } catch (e) { return null; }
    }

    static async request() {
      if (!DualSenseHID.available()) throw new Error('This browser has no WebHID (use Edge or Chrome)');
      const devs = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x054c }] });
      const d = devs && devs[0];
      if (!d) throw new Error('cancelled');
      if (!d.opened) await d.open();
      const h = new DualSenseHID(d);
      // asking for this feature report switches a Bluetooth DualSense into full mode,
      // which is what makes it accept output reports at all
      if (h.bt) { try { await d.receiveFeatureReport(0x05); } catch (e) { /* not fatal */ } }
      return h;
    }

    get connected() { return !!(this.dev && this.dev.opened); }

    // strong/weak are 0..1. The DualSense calls them left (low frequency) and right.
    async send(strong, weak) {
      if (!this.connected) return false;
      const L = Math.round(FV.clamp(strong, 0, 1) * 255), R = Math.round(FV.clamp(weak, 0, 1) * 255);
      if (L === this.last[0] && R === this.last[1]) return true;
      this.last = [L, R];
      // the 47-byte common output report: flags, then the two motors
      const common = new Uint8Array(47);
      common[0] = 0x03;        // valid_flag0: compatible vibration + haptics select
      common[2] = R;           // motor right (weak / high frequency)
      common[3] = L;           // motor left  (strong / low frequency)
      common[38] = 0x04;       // valid_flag2: compatible vibration mode 2 (newer firmware)
      try {
        if (!this.bt) {
          await this.dev.sendReport(0x02, common);
        } else {
          const out = new Uint8Array(77);
          out[0] = (this.seq = (this.seq + 1) & 0x0F) << 4;
          out[1] = 0x10;       // output tag
          out.set(common, 2);
          // Bluetooth reports are checksummed over 0xA2 + report id + payload
          const buf = new Uint8Array(75);
          buf[0] = 0xA2; buf[1] = 0x31; buf.set(out.subarray(0, 73), 2);
          const c = CRC(buf);
          out[73] = c & 0xFF; out[74] = (c >>> 8) & 0xFF; out[75] = (c >>> 16) & 0xFF; out[76] = (c >>> 24) & 0xFF;
          await this.dev.sendReport(0x31, out);
        }
        return true;
      } catch (e) { return false; }
    }

    stop() { return this.send(0, 0); }
  }

  FV.DualSenseHID = DualSenseHID;

  class Input {
    constructor(el) {
      this.el = el;
      this.keys = new Set();
      this.pressedKeys = new Set();
      this.mouse = { dx: 0, dy: 0, down: false, wheel: 0 };
      this.touch = { look: [0, 0], move: 0, pts: new Map(), pinch: 0 };
      this.prevButtons = {};
      this.pad = null; this.padName = '';
      this.lastPadActivity = -1;
      this.rumble = 1;              // 0 = off, 1 = normal, up to 1.4 = strong
      this.rumbleState = 'unknown'; // unknown | ok | hid | unsupported | error (shown in stats)
      this._rum = { t: -1, strong: 0, weak: 0, on: false };
      this.hid = null;              // DualSenseHID, when the user has granted it
      // silently pick up a controller that was granted in an earlier session
      if (FV.DualSenseHID.available()) FV.DualSenseHID.reconnect().then((h) => { if (h) { this.hid = h; this.rumbleState = 'hid'; } });

      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (!this.keys.has(e.code)) this.pressedKeys.add(e.code);
        this.keys.add(e.code);
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      });
      window.addEventListener('keyup', (e) => this.keys.delete(e.code));
      window.addEventListener('blur', () => this.keys.clear());

      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') { this.touch.pts.set(e.pointerId, [e.clientX, e.clientY]); return; }
        this.mouse.down = true; el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch') {
          const p = this.touch.pts.get(e.pointerId); if (!p) return;
          if (this.touch.pts.size === 1) { this.touch.look[0] += e.clientX - p[0]; this.touch.look[1] += e.clientY - p[1]; }
          p[0] = e.clientX; p[1] = e.clientY;
          if (this.touch.pts.size === 2) {
            const [a, b] = [...this.touch.pts.values()];
            const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
            if (this.touch.lastPinch) this.touch.pinch += d - this.touch.lastPinch;
            this.touch.lastPinch = d;
          }
          return;
        }
        if (this.mouse.down) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
      });
      const up = (e) => {
        if (e.pointerType === 'touch') { this.touch.pts.delete(e.pointerId); this.touch.lastPinch = 0; return; }
        this.mouse.down = false;
      };
      el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      el.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
      window.addEventListener('gamepadconnected', (e) => { this.padName = e.gamepad.id; });
      window.addEventListener('gamepaddisconnected', () => { this.pad = null; this.padName = ''; });
    }

    _readPad() {
      // the direct connection wins when it is reporting: once WebHID holds the DualSense,
      // the Gamepad API usually stops listing it altogether
      if (this.hid && this.hid.connected && this.hid.fresh()) {
        const h = this.hid.state;
        const st = {};
        for (const k of Object.keys(STD)) st[k] = h[k] || 0;
        [st.lx, st.ly] = dead(h.lx, h.ly, 0.12);
        [st.rx, st.ry] = dead(h.rx, h.ry, 0.12);
        st.l2 = h.l2 < 0.04 ? 0 : h.l2;
        st.r2 = h.r2 < 0.04 ? 0 : h.r2;
        this.pad = this.hid.dev;
        this.padName = 'DualSense (direct)';
        this.padSource = 'hid';
        return st;
      }
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const live = [];
      for (const p of pads) if (p && p.connected) live.push(p);
      const ds = (p) => /054c|dualsense|wireless controller|playstation/i.test(p.id);
      // prefer a DualSense that can actually vibrate, then any DualSense, then anything
      let gp = live.find((p) => ds(p) && p.vibrationActuator) || live.find(ds) || live[0] || null;
      this.padCount = live.length;
      this.pad = gp;
      this.padSource = gp ? 'gamepad' : 'none';
      if (!gp) return null;
      this.padName = gp.id;
      const std = gp.mapping === 'standard';
      const map = std ? STD : DS_RAW;
      const b = (name) => { const i = map[name]; const bt = i != null ? gp.buttons[i] : null; return bt ? (bt.value || (bt.pressed ? 1 : 0)) : 0; };
      const st = {};
      for (const k of Object.keys(STD)) st[k] = b(k);
      let lx = gp.axes[0] || 0, ly = gp.axes[1] || 0, rx, ry;
      if (std) { rx = gp.axes[2] || 0; ry = gp.axes[3] || 0; }
      else {
        rx = gp.axes[2] || 0; ry = gp.axes[5] || 0;
        st.l2 = gp.axes[3] != null ? (gp.axes[3] + 1) / 2 : st.l2;
        st.r2 = gp.axes[4] != null ? (gp.axes[4] + 1) / 2 : st.r2;
        const hat = gp.axes[9];
        if (hat != null && hat < 1.1) {
          const dir = Math.round((hat + 1) * 3.5); // 0..7 clockwise from up
          st.up = [7, 0, 1].includes(dir) ? 1 : 0; st.right = [1, 2, 3].includes(dir) ? 1 : 0;
          st.down = [3, 4, 5].includes(dir) ? 1 : 0; st.left = [5, 6, 7].includes(dir) ? 1 : 0;
        }
      }
      [st.lx, st.ly] = dead(lx, ly, 0.12);
      [st.rx, st.ry] = dead(rx, ry, 0.12);
      st.l2 = st.l2 < 0.04 ? 0 : st.l2; st.r2 = st.r2 < 0.04 ? 0 : st.r2;
      return st;
    }

    // Continuous haptics. The browser replaces whatever effect is running on each call, so
    // a steady cadence of slightly-longer-than-the-interval effects reads as one smooth
    // rumble that tracks the music, instead of the single 70 ms tick we used to fire on kicks.
    setRumble(strong, weak, now) {
      // WebHID drives the motors directly when connected - the only route that works
      // over Bluetooth. Everything else falls back to the Gamepad API.
      if (this.hid && this.hid.connected) {
        const r = this._rum;
        strong = FV.clamp(strong, 0, 1); weak = FV.clamp(weak, 0, 1);
        if (now - r.t < 0.012) return;          // ~80 Hz: fast enough to feel a wobble
        r.t = now; r.strong = strong; r.weak = weak; r.on = strong > 0.02 || weak > 0.02;
        this.hid.send(strong, weak).then((ok) => { this.rumbleState = ok ? 'hid' : 'error'; });
        return;
      }
      const gp = this.pad;
      if (!gp) return;
      const act = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
      if (!act) { this.rumbleState = 'unsupported'; return; }
      const r = this._rum;
      strong = FV.clamp(strong, 0, 1); weak = FV.clamp(weak, 0, 1);
      const quiet = strong < 0.02 && weak < 0.02;
      if (quiet) {
        if (r.on) { try { act.reset ? act.reset() : act.playEffect('dual-rumble', { duration: 1, strongMagnitude: 0, weakMagnitude: 0 }); } catch (e) { /* ignore */ } }
        r.on = false; r.strong = 0; r.weak = 0;
        return;
      }
      // re-issue on a steady cadence, or at once when the level jumps (a kick landing)
      const due = now - r.t > 0.05 || Math.abs(strong - r.strong) > 0.12;
      if (!due) return;
      r.t = now; r.strong = strong; r.weak = weak; r.on = true;
      this._play(act, strong, weak, 110);
    }

    // One deliberate buzz, for the settings menu - you feel the level you just picked.
    rumbleTest(strength) {
      if (this.hid && this.hid.connected) {
        const s = FV.clamp(strength, 0, 1);
        this.hid.send(s, s * 0.4).then(() => setTimeout(() => this.hid.stop(), 320));
        return 'sent';
      }
      const gp = this.pad;
      if (!gp) return 'nopad';
      const act = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
      if (!act) { this.rumbleState = 'unsupported'; return 'unsupported'; }
      this._play(act, FV.clamp(strength, 0, 1), FV.clamp(strength * 0.4, 0, 1), 320);
      this._rum.on = true; this._rum.t = -1;
      return 'sent';
    }

    async connectHid() {
      const h = await FV.DualSenseHID.request();
      this.hid = h; this.rumbleState = 'hid';
      await h.send(0.6, 0.25);
      setTimeout(() => h.stop(), 350);
      return h.bt ? 'bluetooth' : 'usb';
    }

    _play(act, strong, weak, ms) {
      try {
        if (act.playEffect) {
          const p = act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak });
          if (p && p.then) p.then(() => { this.rumbleState = 'ok'; }, () => { this.rumbleState = 'error'; });
          else this.rumbleState = 'ok';
        } else if (act.pulse) {                 // older hapticActuators API
          act.pulse(Math.max(strong, weak), ms);
          this.rumbleState = 'ok';
        } else this.rumbleState = 'unsupported';
      } catch (e) { this.rumbleState = 'error'; }
    }

    // Returns the per-frame control state plus edge-triggered actions.
    poll(dt, now) {
      const s = {
        move: [0, 0, 0], look: [0, 0], roll: 0, boost: 0, slow: 0, morph: 0,
        actions: new Set(), pad: false, hold: {},
      };
      const gp = this._readPad();
      if (gp) {
        s.pad = true;
        const pressed = (k) => gp[k] > 0.5 && !(this.prevButtons[k] > 0.5);
        s.roll += gp.lx * 1.4; s.move[2] += -gp.ly;
        s.look[0] += gp.rx * 2.0; s.look[1] += gp.ry * 1.6;
        s.boost = Math.max(s.boost, gp.r2); s.slow = Math.max(s.slow, gp.l2);
        s.morph += (gp.up - gp.down);
        if (pressed('r1')) s.actions.add('nextTab');
        if (pressed('l1')) s.actions.add('prevTab');
        if (pressed('right')) s.actions.add('nextScene');
        if (pressed('left')) s.actions.add('prevScene');
        if (pressed('cross')) s.actions.add('autopilot');
        if (pressed('circle')) s.actions.add('reset');
        if (pressed('square')) s.actions.add('palette');
        if (pressed('triangle')) s.actions.add('hud');
        if (pressed('options')) s.actions.add('menu');
        if (pressed('create')) s.actions.add('screenshot');
        if (pressed('touchpad')) s.actions.add('reactivity');
        if (pressed('r3')) s.actions.add('level');
        if (pressed('l3')) s.actions.add('photo');
        s.menuNav = { up: pressed('up'), down: pressed('down'), left: pressed('left'), right: pressed('right'), ok: pressed('cross'), back: pressed('circle') };
        const any = Math.abs(gp.lx) + Math.abs(gp.ly) + Math.abs(gp.rx) + Math.abs(gp.ry) + gp.l2 + gp.r2 + gp.l1 + gp.r1;
        if (any > 0.05) this.lastPadActivity = now;
        this.prevButtons = gp;
      }

      // keyboard / mouse
      const K = (c) => this.keys.has(c) ? 1 : 0;
      const P = (c) => this.pressedKeys.has(c);
      s.move[0] += K('KeyE') - K('KeyQ');          // sideways slide
      s.move[2] += K('KeyW') - K('KeyS');
      s.move[1] += K('Space') - K('KeyC');
      s.look[0] += (K('ArrowRight') - K('ArrowLeft')) * 1.5;
      s.look[1] += (K('ArrowDown') - K('ArrowUp')) * 1.2;
      s.roll += (K('KeyD') - K('KeyA')) * 1.4;   // roll, same axis as the left stick
      if (K('ShiftLeft') || K('ShiftRight')) s.boost = 1;
      if (K('ControlLeft') || K('AltLeft')) s.slow = 1;
      s.morph += K('KeyR') - K('KeyF');
      const md = 0.0035 / Math.max(dt, 1e-3);
      s.look[0] += this.mouse.dx * md; s.look[1] += this.mouse.dy * md;
      this.mouse.dx = this.mouse.dy = 0;
      if (this.mouse.wheel) { s.wheel = this.mouse.wheel; this.mouse.wheel = 0; }

      // touch: drag to look, pinch to fly
      const td = 0.004 / Math.max(dt, 1e-3);
      s.look[0] += this.touch.look[0] * td; s.look[1] += this.touch.look[1] * td;
      this.touch.look = [0, 0];
      if (this.touch.pinch) { s.move[2] += FV.clamp(this.touch.pinch * 0.05, -1, 1); this.touch.pinch *= 0.6; if (Math.abs(this.touch.pinch) < 0.5) this.touch.pinch = 0; }

      if (P('Period')) s.actions.add('nextTab');
      if (P('Comma')) s.actions.add('prevTab');
      if (P('BracketRight') || P('KeyN') || P('PageDown')) s.actions.add('nextScene');
      if (P('BracketLeft') || P('KeyB') || P('PageUp')) s.actions.add('prevScene');
      for (let i = 1; i <= 9; i++) if (P('Digit' + i)) s.actions.add('scene:' + (i - 1));
      if (P('KeyP')) s.actions.add('autopilot');
      if (P('Home') || P('Backspace')) s.actions.add('reset');
      if (P('KeyO')) s.actions.add('palette');
      if (P('KeyH')) s.actions.add('hud');
      if (P('Escape') || P('KeyM') || P('Tab')) s.actions.add('menu');
      if (P('F12') || P('KeyK')) s.actions.add('screenshot');
      if (P('KeyL')) s.actions.add('level');
      if (P('Enter') && (K('AltLeft'))) s.actions.add('fullscreen');
      if (P('KeyG')) s.actions.add('fullscreen');
      if (P('KeyX')) s.actions.add('photo');
      if (P('KeyV')) s.actions.add('reactivity');
      s.keyNav = { up: P('ArrowUp'), down: P('ArrowDown'), left: P('ArrowLeft'), right: P('ArrowRight'), ok: P('Enter') || P('Space'), back: P('Escape') || P('Backspace') };
      this.pressedKeys.clear();
      return s;
    }
  }

  FV.Input = Input;
})(window.FV);
