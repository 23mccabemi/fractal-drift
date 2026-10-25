# Fractal Drift - project notes for Claude

Real-time 3D fractal music visualizer (WebGL2, no build step, classic `<script>` files).
Launch: `Start Fractal Drift.bat` -> `tools/serve.ps1` (localhost:8765, opens Edge with
`--force_high_performance_gpu` in its own profile). Dev server with a `/shot` endpoint: `node tools/devserver.js 8770`.

## Owner's preferences (from review sessions)
- Favourite worlds: **Magenta Foam** and **Fractal Light** (pseudo-Kleinian foam, `KFOAM` params in
  `js/fractals.js`). New worlds should be variations of these: same shape and scale, different viewpoints and palettes.
- Visual reference: https://youtu.be/R2PiVXjanws (dense bubble/foam fractals, orbit-trap rings).
- The marbled orbit-trap colour texture with colour flow (`uWarp` = 1) is wanted in every world.
- Music should drive **colour/texture, not geometry**. Geometry modulation broke temporal reprojection
  and caused smearing. The owner's music is psychedelic dubstep, so bass and sub-bass matter most;
  hats/snares get only a subtle glint.
- Ambient-lit look preferred: low emissive/specular, light from the surroundings.
- No FOV/exposure pulses, no lens blur. Lens effects are off by default.
- Autopilot engages only after 20 s idle (or the toggle); any input hands control back.
- Flight: the owner wants **calm, forgiving and satisfying, not plane-like**. The default `drift` model in
  `js/flight.js` aims the nose directly (no bank-carving), leans only for feel and keeps a gentle forward
  drift. **Roll is the left stick's X axis and nothing auto-levels it** - a fractal has no up, so a
  self-levelling horizon is wrong here (tried it, removed it). L1/R1 are reserved for tab switching. An aircraft-style `glide` model and the old `free` cam are kept behind
  *Settings > Flight model* (`?free`). Tuning lives in one `MODELS` table - adjust there, not in the update
  loop. A scene opens parked on its composed viewpoint until the throttle is touched, so the shots survive.
- Speed and the step clamp key off `this.room` (how far the view ahead is clear), not just the DE to the
  nearest surface. Keying them to the DE alone made the craft crawl to a halt in front of gaps it fits
  through: in a corridor test it covered 10% of the open path; with `room` it covers >100%. The collision
  cushion is deliberately small (`scale * 0.012`) and the skim lets go when the way ahead is open.
- Rumble is continuous and bass-driven (`Input.setRumble` re-issues an overlapping `dual-rumble` effect on a
  ~90 ms cadence; a single short pulse on kicks was too sparse to feel). Strength lives in Settings and
  buzzes on change; `input.rumbleState` shows up in `?stats` when a pad is connected.
- **DualSense over Bluetooth cannot rumble through the Gamepad API** (Chromium only wires it up over USB).
  `FV.DualSenseHID` in `js/input.js` talks to the pad directly over WebHID instead - output report 0x02 on
  USB, 0x31 + CRC32 over `0xA2 + id + payload` on Bluetooth - and is the preferred path when connected.
  It needs a real click/keypress for the permission (a controller button grants no user activation).
- Removed by request: Neon Grid, Candy Cathedral, Acid Kaleidoscope.
- Foam variations are built with the `foam(name, cam, opts)` factory in `js/fractals.js` (dark/emissive
  Magenta Foam treatment, or `bright: true` for the Fractal Light one). Get viewpoints from
  `node tools/scout-cams.js [count] [seed]`: it ports the KFOAM DE to JS and only prints cams whose
  frame is full of layered structure. Don't hand-pick cams - most of the parameter space is empty void.

## Tabs (js/tabs.js)
L1/R1 switch tabs, arrows switch scenes inside one. A tab is `{ id, name, kind, scenes }`.
Two tabs exist: Fractals and Canyon. `kind: 'march'` reuses the whole raymarch pipeline, so Canyon
is just a new distance estimator plus art direction - do the same for any new world.
Removed by request (failed prototypes): Tunnel, Nebula and Songform, and the `Renderer.renderGeo`
points/lines path they used. Don't bring them back.

## Rendering pipeline (js/renderer.js, js/shaders.js)
cone pre-pass (1/4 res) -> over-relaxed raymarch (dynamic res) -> temporal upsampling with depth-tested
reprojection -> bloom -> neutral tonemap + upscale. The raymarch is the bottleneck (55-75% of GPU time).
URL flags: `?stats&profile` (per-pass GPU ms + GPU name), `?nocone`, `?norelax`, `?noaa`, `?oldtaa`,
`?scene=N`, `?go`, `?demo`, `?still`, `?q=high|ultra`, `?scale=0.6`, `?free` (old spectator camera).

## Distance graininess (investigated 2026-10-15)
Second pass: what remains on **thin filaments** is coverage aliasing (does the ray hit the strand at all),
which no shading-side filter can fix. The answer is real supersampling: `setRenderScale` now allows >1 and
the `fine`/`ultra` tiers cap at 1.35, so auto spends spare GPU on extra rays per display pixel. Measured
-37.8% per-frame sampling noise with **+11% detail** (it resolves more, not less).
Measured, not guessed: flattening the albedo removes ~78% of it, so the grain is **orbit-trap colour
aliasing**, not AO/specular/step-count noise. The fix that worked was band-limiting the palette and ring
bands earlier in `colorize` (the `fwidth` smoothstep thresholds) - about **70% less frame-to-frame sampling
noise for ~2% less detail**. Step-count cavity and the hat glint now also fade with distance.
To measure: render the same frozen frame twice (`?still`, parked camera, TAA temporarily off) - the two
frames differ only by jitter, so `mean|A-B|` is pure sampling noise. Comparing a single still frame is
useless, because TAA has already cleaned it up.

## Gotchas
- Keep noise/AO/shadow/normal loops wrapped in `ZERO` (fast D3D compiles); leave fractal ITER loops unrolled (faster at runtime).
- Laptop GPUs throttle hard on battery, so benchmark plugged in, with interleaved A/B runs (see the profile flag).
- On dual-GPU PCs check the GPU line in stats: the browser may pick Intel instead of NVIDIA. The app now
  toasts a warning when the GPU looks integrated. `tools/serve.ps1` must open the Edge app window with
  `--force_high_performance_gpu` on **every** path - its old port-busy branch fell back to
  `Start-Process $url`, which handed the page to the default browser (Chrome tab, Intel GPU) whenever a
  previous server instance was still running. Use `serve.ps1 -DryRun` to print the launch command.
- Headless tests: use the dev server's `?nopad` flag - it injects the `navigator.getGamepads` stub. A
  connected controller steers the camera and flips scenes, which silently ruins screenshot comparisons
  (it happened: two "identical" captures differed because the pad was nudging the camera).
- Headless audio needs `--autoplay-policy=no-user-gesture-required`, or the AudioContext stays
  suspended and every audio-driven thing reads zero. An audio-driven tab looked broken for an hour
  because of this - the HUD meters being flat is the tell.
- Judge a new palette by measuring, not by eye on one screenshot: mean luma of the frame (HUD strips
  excluded) should land between Magenta Foam (~27, a deliberately dark world) and Silver Spires (~94).
  Several new scenes rendered as literally black (mean 0.5) while looking plausible in source.
