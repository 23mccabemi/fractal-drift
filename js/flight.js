// Flight model. Speed scales with the distance to the nearest surface, so you can keep
// diving into ever-smaller detail ("infinite zoom") and never crash.
//
// Three models. "drift" (default) is the calm one: you point where you want to go and
// glide there, with a gentle lean into the turn for feel. There is no "up" in a fractal,
// so nothing levels the horizon for you - the left stick rolls, and it stays where you put it.
// "glide" flies like an aircraft - the bank itself carves the turn and momentum throws you
// wide. "free" is the old 6-DOF spectator cam (strafe anywhere, stop dead).
'use strict';
(function (FV) {
  const { v3, quat } = FV;

  // Tuning per model. Rates are per second; speeds are multiples of the local scene scale.
  const MODELS = {
    drift: {
      cruise: 0.5,      // you always drift forward gently - the calm part
      aim: 0.9,         // steering goes where you point: no carving, no fighting the stick
      pitch: 0.85,
      carve: 0.0,       // the lean is feel only, it does not steer for you
      bankGain: 0.35,   // a gentle 20-degree lean into a turn
      bankRate: 1.8,
      angRate: 6.5,     // responsive, still smoothed
      accel: 2.5, coast: 1.5, brake: 3.5,
      turnDrag: 0.0,    // steady speed; turning does not bleed it away
      velLag: 3.5,      // a soft glide behind the nose, not a drift
      slip: 0.55, lift: 0.6,
      avoid: 0.45,      // a light nudge away from walls, never a yank
    },
    glide: {
      cruise: 0.55, aim: 0.45, pitch: 0.8, carve: 0.6, bankGain: 0.75, bankRate: 2.2,
      angRate: 5, accel: 1.6, coast: 1.0, brake: 3.2, turnDrag: 0.3, velLag: 2.4,
      slip: 0.3, lift: 0.45, avoid: 0.9,
    },
  };

  class Flight {
    constructor() {
      this.pos = [0, 0, -3]; this.rot = quat.ident();
      this.vel = [0, 0, 0]; this.ang = [0, 0, 0];
      this.autopilot = false;
      this.userSpeed = 1.0;
      this.scale = 0.5;           // smoothed local scene scale
      this.de = 0.5;
      this.t = 0;
      this.autoTurn = [0, 0];
      this.idle = 0;
      this.model = 'drift';       // 'drift' | 'glide' | 'free'
      this.bank = 0;              // lean carried into the current turn
      this.sf = 0;                // airspeed, as a multiple of the local scene scale
      this.launched = false;      // touched the throttle since this scene was placed
      this.parked = false;        // photo mode: no cruise, you only move on the stick
    }

    place(cam) {
      this.pos = cam.pos.slice();
      this.rot = quat.lookRot(cam.fwd, [0, 1, 0]);
      this.vel = [0, 0, 0]; this.ang = [0, 0, 0];
      this.bank = 0; this.sf = 0; this.launched = false;
    }

    forward() { return quat.rotate(this.rot, [0, 0, 1]); }

    update(dt, ctl, probe, scene, audio, react) {
      this.t += dt;
      const de = probe ? Math.max(probe.de, 1e-6) : this.de;
      this.de = de;
      const sc = scene.scaleClamp || [0.002, 1];
      const target = FV.clamp(de, sc[0], sc[1]);
      // shrink fast when closing in, grow slowly when opening up - keeps fog/AO stable
      this.scale = FV.lerp(this.scale, target, FV.damp(target < this.scale ? 3.0 : 0.8, dt));

      const manualLook = Math.abs(ctl.look[0]) + Math.abs(ctl.look[1]) + Math.abs(ctl.roll) > 0.02;
      const manualMove = Math.abs(ctl.move[0]) + Math.abs(ctl.move[1]) + Math.abs(ctl.move[2]) > 0.02;
      this.idle = (manualLook || manualMove) ? 0 : this.idle + dt;
      // a scene opens parked on its composed viewpoint; touching the throttle takes off,
      // and from then on you are always flying until the next scene
      if (manualMove) this.launched = true;
      // any stick/key input hands control back unless autopilot was switched on explicitly
      if ((manualLook || manualMove) && !this.autopilot) this.engaged = false;

      const boost = FV.lerp(1, 6, ctl.boost) * FV.lerp(1, 0.12, ctl.slow);
      // How much room there is to move. The nearest surface (de) bounds us in general, but
      // when the view ahead is open we may use that instead: squeezing through a gap, de
      // collapses against the rim while the way through is wide, and keying speed to de
      // alone is what made you crawl to a stop in front of a hole you fit through.
      const fwdNow = quat.rotate(this.rot, [0, 0, 1]);
      const ahead = (probe && probe.free) ? Math.max(probe.free[0], 1e-6) : de;
      const vl = v3.len(this.vel);
      // only trust the forward probe to the extent we are actually travelling forward
      const align = vl > 1e-12 ? FV.clamp(v3.dot(v3.scale(this.vel, 1 / vl), fwdNow), 0, 1) : 1;
      this.room = Math.max(de, Math.min(ahead * 0.3, de * 8) * align);
      // one "unit" of speed: everything below is relative to the local scene scale
      const unit = (scene.speed || 1) * this.userSpeed * Math.max(this.room, 1e-6) * 1.6;

      // ---- commands: pitch / yaw / roll, and push (right, up, forward) ----
      let pitch = ctl.look[1] * (1 - 0.6 * ctl.slow);
      let yaw = ctl.look[0] * (1 - 0.6 * ctl.slow);
      let roll = -ctl.roll;
      const push = [ctl.move[0], ctl.move[1], ctl.move[2]];

      // autopilot: forced on by the toggle, or engages by itself after 20 s without input
      const wasEngaged = this.engaged;
      this.engaged = this.autopilot || (this.idleEngage !== false && this.idle >= 20);
      if (this.engaged && !wasEngaged && !this.autopilot && this.onAutoEngage) this.onAutoEngage();
      let apSpeed = 0;
      if (this.engaged) {
        const ap = this._autopilot(dt, probe, audio, react, scene);
        // stick input overrides the autopilot smoothly
        const w = manualLook ? 0.25 : 1;
        pitch += ap.ang[0] * w; yaw += ap.ang[1] * w; roll += ap.ang[2] * w;
        apSpeed = ap.speed * boost * (manualMove ? 0.5 : 1);
      }

      let rollRate = roll * 1.4;
      const M = MODELS[this.model];
      if (M) {
        // Lean into the turn. In drift this is feel only (carve = 0): the stick still aims
        // the nose directly, so you go exactly where you point - the lean just sells it.
        const bankTgt = FV.clamp(yaw * M.bankGain + push[0] * M.bankGain * 0.6, -1.3, 1.3);
        const prevBank = this.bank;
        this.bank = FV.lerp(this.bank, bankTgt, FV.damp(M.bankRate, dt));
        rollRate += (this.bank - prevBank) / Math.max(dt, 1e-4);
        yaw = yaw * M.aim + Math.sin(this.bank) * M.carve;
        pitch *= M.pitch;
        const av = this._avoid(probe, de);
        pitch += av[0]; yaw += av[1];
      }

      // ---- rotation ----
      const tgtAng = [pitch, yaw, rollRate];
      const angRate = M ? M.angRate : 8;
      for (let i = 0; i < 3; i++) this.ang[i] = FV.lerp(this.ang[i], tgtAng[i], FV.damp(angRate, dt));
      const r = this.rot;
      const right = quat.rotate(r, [1, 0, 0]), up = quat.rotate(r, [0, 1, 0]), fwd = quat.rotate(r, [0, 0, 1]);
      let q = quat.mul(quat.axisAngle(right, this.ang[0] * dt), r);
      q = quat.mul(quat.axisAngle(up, this.ang[1] * dt), q);
      q = quat.mul(quat.axisAngle(fwd, this.ang[2] * dt), q);
      this.rot = quat.norm(q);

      // ---- translation ----
      let tv, velLag;
      if (M) {
        // The stick is a throttle and an airbrake, not an on/off switch: centred, you keep
        // gliding at cruise; pulled back (or L2) you bleed the speed off almost to a stop.
        const cruise = (this.parked || !this.launched) ? 0 : M.cruise;
        const fin = push[2];
        const thr = fin >= 0 ? cruise + (1 - cruise) * fin : cruise * (1 - 0.96 * Math.min(1, -fin));
        // energy bleeds away in a hard turn and comes back on the straights
        const turn = Math.min(1, (Math.abs(this.ang[0]) + Math.abs(this.ang[1])) * 0.5);
        const tgt = Math.max(thr * boost, apSpeed / Math.max(unit, 1e-12)) * (1 - M.turnDrag * turn);
        const braking = fin < -0.05 || ctl.slow > 0.05;
        this.sf = FV.lerp(this.sf, tgt, FV.damp(tgt > this.sf ? M.accel : (braking ? M.brake : M.coast), dt));
        // cruise carries the craft; the stick slips / lifts it sideways
        tv = v3.add(v3.scale(fwd, unit * this.sf),
          v3.add(v3.scale(right, push[0] * unit * M.slip), v3.scale(up, push[1] * unit * M.lift)));
        // the path eases in behind the nose, so movement glides instead of snapping
        velLag = v3.len(this.vel) > 2 * v3.len(tv) ? 6 : M.velLag;
      } else {
        const speed = unit * boost;
        const local = [push[0] * speed, push[1] * speed, push[2] * speed];
        if (this.engaged && !manualMove) { local[0] = 0; local[1] = 0; local[2] = apSpeed; }
        else if (this.engaged) local[2] += apSpeed;
        tv = v3.add(v3.add(v3.scale(right, local[0]), v3.scale(up, local[1])), v3.scale(fwd, local[2]));
        velLag = 5;
      }
      this.vel = v3.lerp(this.vel, tv, FV.damp(velLag, dt));
      let step = v3.scale(this.vel, dt);
      // never move further than a fraction of the free distance (probe lags a frame or two)
      const maxStep = Math.min(this.room, ahead * 0.5) * 0.35;
      const sl = v3.len(step);
      if (sl > maxStep) step = v3.scale(step, maxStep / sl);
      this.pos = v3.add(this.pos, step);

      // collision: keep a minimum clearance proportional to the current scale
      if (probe && probe.normal) {
        // The cushion is deliberately small: it only has to cover the probe being a frame
        // or two stale. A wide one reads as invisible walls around gaps you should fit through.
        const clear = Math.max(this.scale * 0.012, 2e-6);
        const n = v3.norm(probe.normal);
        // skim along a surface you are closing on instead of stopping dead on it, but let
        // go of the brakes when the path ahead is open - that is the gap you are aiming at
        if (M) {
          const band = clear * 2.5;
          if (de < band) {
            const openAhead = FV.clamp(ahead / (de * 6), 0, 1);
            const vn = v3.dot(this.vel, n);
            if (vn < 0) this.vel = v3.sub(this.vel, v3.scale(n, vn * (0.35 + 0.65 * (1 - de / band)) * (1 - 0.8 * openAhead)));
          }
        }
        if (de < clear) {
          this.pos = v3.add(this.pos, v3.scale(n, (clear - de) * 0.5));
          const vn = v3.dot(this.vel, n);
          if (vn < 0) this.vel = v3.sub(this.vel, v3.scale(n, vn));
        }
      }
    }

    // Gentle auto pull-up: when the forward cone says the nose is about to bury itself in
    // the foam, bend toward the clearest neighbouring direction, so a glide skims the
    // surface instead of face-planting into it. It only bites when something is close.
    _avoid(probe, de) {
      const M = MODELS[this.model];
      if (!probe || !probe.free || !M) return [0, 0];
      const free = probe.free;
      const danger = FV.clamp(1 - free[0] / (de * 14), 0, 1);
      if (danger < 0.02) return [0, 0];
      const cap = de * 20;
      let sx = 0, sy = 0;
      for (let i = 1; i < 7; i++) {
        const th = (i - 1) * Math.PI * 2 / 6;
        const w = Math.min(free[i], cap) / cap;
        sx += Math.cos(th) * w; sy += Math.sin(th) * w;
      }
      const m = Math.hypot(sx, sy);
      if (m < 1e-4) return [0, 0];
      const g = danger * danger * M.avoid;
      return [-(sy / m) * g, (sx / m) * g];
    }

    // Steer toward open space, follow the music for speed, slowly wander.
    _autopilot(dt, probe, audio, react, scene) {
      const out = { ang: [0, 0, 0], speed: 0 };
      if (!probe) return out;
      const free = probe.free;
      const fwdFree = free[0];
      const de = Math.max(probe.de, 1e-6);
      // directions used by the probe shader (camera space)
      // openness is capped (beyond ~8x the wall distance everything is "open enough"), and
      // directions that see nothing at all are penalised so we keep flying along structure
      const cap = de * 8, far = probe.far || 1e9;
      const score = (f) => (f >= far * 0.98 ? 0.35 : 1) * Math.min(f, cap);
      const fs = score(fwdFree);
      let sx = 0, sy = 0, wsum = 0;
      for (let i = 1; i < 7; i++) {
        const th = (i - 1) * Math.PI * 2 / 6;
        const w = Math.pow(score(free[i]) / (fs + 1e-9), 3);
        sx += Math.cos(th) * w; sy += Math.sin(th) * w; wsum += w;
      }
      sx /= wsum + 1e-9; sy /= wsum + 1e-9;
      // forward sees only void: bend towards whichever side has the nearest structure
      if (fwdFree >= far * 0.98) {
        let bi = 1; for (let i = 2; i < 7; i++) if (free[i] < free[bi]) bi = i;
        const th = (bi - 1) * Math.PI * 2 / 6;
        sx += Math.cos(th) * 0.8; sy += Math.sin(th) * 0.8;
      }
      const blocked = FV.clamp(1 - fwdFree / (de * 6), 0, 1);
      const gain = 0.6 + 2.6 * blocked;
      const wander = 0.18;
      const nx = FV.noise1(this.t * 0.07) * wander, ny = FV.noise1(this.t * 0.05 + 40) * wander * 0.6;
      const tx = FV.clamp(sx * gain + nx, -1.2, 1.2), ty = FV.clamp(sy * gain + ny, -1.0, 1.0);
      this.autoTurn[0] = FV.lerp(this.autoTurn[0], tx, FV.damp(2, dt));
      this.autoTurn[1] = FV.lerp(this.autoTurn[1], ty, FV.damp(2, dt));
      out.ang = [-this.autoTurn[1] * 0.7, this.autoTurn[0] * 0.7, FV.noise1(this.t * 0.03 + 9) * 0.12];
      const music = 0.85 + react * 0.25 * audio.energy;   // camera stays calm; the colours carry the music
      const base = Math.min(de * 2.2, fwdFree * 0.3);
      out.speed = (scene.speed || 1) * this.userSpeed * base * music * (1 - 0.7 * blocked);
      return out;
    }

    levelHorizon() {
      const f = this.forward();
      this.rot = quat.lookRot(f, [0, 1, 0]);
      this.bank = 0; this.ang[2] = 0;
    }
  }

  FV.Flight = Flight;
})(window.FV);
