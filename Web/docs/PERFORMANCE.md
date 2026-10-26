# Performance

## What was actually measured

The game was developed and verified in a **headless Linux environment with no GPU**. Chromium
there runs on ANGLE's SwiftShader software rasteriser, which is roughly two orders of magnitude
slower than any real GPU. That environment is excellent for proving the game is _correct_ and
useless for predicting frame rate on real hardware.

Measured in that environment, through `npm run preview` at 1280×720:

| Metric                           | Value                         |
| -------------------------------- | ----------------------------- |
| Frame rate                       | 6–9 FPS (software rasteriser) |
| Frame time                       | 110–170 ms                    |
| CPU time in simulation           | 4–12 ms per frame             |
| CPU time in rendering            | 1–14 ms per frame             |
| Fixed simulation steps per frame | 5 (the catch-up cap)          |

The interesting number in that table is the **simulation cost: 4–12 ms of CPU per frame** to
simulate the vehicle, stream props, update traffic, drive audio and write the HUD. That work is
CPU-bound and hardware-independent, and it is small enough that the game is not CPU-limited on any
plausible machine. Everything else in that table is the software rasteriser and scales away
completely once a GPU is present.

**No GPU frame-rate benchmark has been run. No FPS target is claimed.** Anything else would be a
number invented in a document.

## How to benchmark it yourself

1. `npm run build && npm run preview`
2. Open the URL in the browser you care about, in a fresh tab at 1280×720.
3. Press `F3` to show the overlay. It reports:
   - **fps** and **frameMs** — smoothed, so give it a few seconds to settle.
   - **updateMs** — CPU time in the fixed-step simulation.
   - **renderMs** — CPU time issuing the render. (This is _not_ GPU time; the GPU can still be the
     bottleneck even when this is small.)
   - **subSteps** — how many simulation steps ran this frame, out of a cap of 5.
4. Drive the same route on each preset and note the numbers. Start at the Alpine Valley garage
   spawn and hold `W`.

**Reading the result.** `subSteps` consistently at 5 means the machine cannot keep up and the
simulation is being slowed down to compensate — the game is still stable, but time is moving
slower than reality, which is a clear sign to lower a setting. If `updateMs` is high and
`renderMs` is low, you are CPU-bound: reduce traffic and vegetation density. If the opposite, you
are GPU-bound: reduce render scale, then shadows, then view distance.

## How the game is built for low-end hardware

**Rendering**

- One draw call for the entire terrain (a single indexed `BufferGeometry` with vertex colours; no
  texture fetches).
- All props are `InstancedMesh`, bucketed per chunk, type and variant. A 1500-tree forest costs a
  handful of draw calls, not 1500.
- Shared materials across every instance of a type; geometries disposed on unload.
- Bridges and tunnels are a handful of meshes each — a deck, two parapets, one instanced mesh of
  piers and abutments, and for a tunnel a shell, a lamp strip and two portals. They are built once
  with the world and never touched again, and the whole world has fewer than a dozen of them.
- **Tunnel interiors are lit by real point lights, spaced by the preset and capped at ten per map.**
  This is the one thing in the world that a quality setting _adds_ rather than removes: a point light
  is evaluated on every lit fragment in the scene wherever the player is, so the cost is not local to
  the tunnel. Low spaces them 45 m apart, Medium 28 m, High 18 m, and **Potato adds none at all** —
  there a tunnel is the emissive lamp strip lit by the same ambient light as the open road.
- `matrixAutoUpdate = false` on static terrain and road meshes so Three.js skips per-frame matrix
  recomputation.
- Render scale multiplies the internal resolution, which is the single most effective lever on a
  weak GPU. Potato uses 0.6.
- Shadows are off entirely on Potato, and the shadow map drops (1024 → 2048 → 4096) and the shadow
  camera's extent follows the view distance on the others.
- Fog distances track the view distance so geometry fades out before the far plane and pop-in is
  hidden rather than visible.

**CPU and memory**

- A fixed-timestep loop with a catch-up cap of 5 substeps. If a machine falls behind, the
  simulation slows down instead of entering a death spiral of unbounded catch-up.
- **The car's on-screen pose is interpolated between the two physics steps the frame falls between**
  (`Vehicle.syncVisual`), so it moves smoothly on a 120 Hz or 144 Hz panel without simulating at
  anything but 60 Hz. That is one vector lerp and one shortest-path quaternion nlerp per frame — the
  car is the only object that needs it, because everything else either moves slowly or is scenery.
- World build is staged and yields to the browser between phases, so terrain generation never
  freezes the tab.
- Props stream in and out of 180 m chunks with a **budget of 4 chunk operations per frame**, so a
  fast car crossing several chunk boundaries cannot stall a frame.
- Physics colliders are primitives (cylinder, ball, box) sized to the prop, never the visual mesh,
  and only solid props get one at all — there is a hard budget on colliders per map.
- Traffic vehicles are pooled: the whole fleet is created once at map load, parked below the
  world, and activated and deactivated as the player moves. Spawning traffic never allocates.
- No per-frame allocation in the hot paths: telemetry, wheel state and control-state objects are
  created once and mutated.
- Audio re-sends the engine profile only when the vehicle actually changes.
- **Rain is one GPU-animated `LineSegments`.** Every drop moves in the vertex shader from a single
  `uTime` uniform, so the CPU cost of heavy rain after setup is zero; only the particle _count_
  changes with the preset. The field is a box that follows the camera, so rain is never drawn where
  the player cannot see it.
- **Traffic lights are four instanced meshes per map**, not three lamps per junction. Modern City
  has 19 signalled junctions; lamp-per-junction would be over a hundred draw calls of scenery the
  player glances at for a second.
- **Skid marks and particles are preallocated pools.** Nothing allocates after construction: marks
  are written into a ring buffer of quads and particles are recycled from a fixed array. Both are
  sized by the preset and neither grows with play time.
- **The time of day is a uniform update, not a second render pass.** Night costs the same as noon;
  the star field is a hash in the existing sky shader rather than a texture or a second draw.
- **Particle integration is sub-stepped and capped at 50 ms per step.** A frame hitch would
  otherwise hand the Euler integrator a step long enough to fling the whole pool across the map.

**Feature detection**

- WebGL is probed at boot before anything is constructed; a software renderer is detected by
  reading `WEBGL_debug_renderer_info` and the game starts on Potato automatically.
- A browser without WebGL gets a readable explanation and a suggested fix instead of a blank
  canvas.
- If the 2D canvas context is unavailable (some headless or hardened configurations), the road
  texture generator returns `null` and roads render as untextured asphalt: degraded, never broken.

## Presets

| Preset          | Render scale | View distance | Shadows | AA   | Vegetation | Traffic | Skid marks | Particle pool |
| --------------- | ------------ | ------------- | ------- | ---- | ---------- | ------- | ---------- | ------------- |
| Potato          | 0.6          | 350 m         | off     | off  | 15%        | 0%      | off        | 180           |
| Low _(default)_ | 0.85         | 700 m         | low     | off  | 45%        | 25%     | 420 quads  | 380           |
| Medium          | 1.0          | 1400 m        | medium  | FXAA | 75%        | 50%     | 760 quads  | 720           |
| High            | 1.0          | 2600 m        | high    | MSAA | 100%       | 70%     | 1200 quads | 1200          |

Weather is deliberately **not** part of a preset: it is the player's choice, not a quality level, so
the preset only scales its cost — the rain field's particle budget is 700 drops on Potato and 4200 on
High. Skid marks are the one environmental effect a preset switches off outright, because the ring
buffer is a fixed memory cost that only grows with driving.

Presets are partial patches applied over the defaults, so an individual slider can be moved after
choosing a preset without switching preset. Individual graphics settings and traffic and vegetation
density are also exposed directly, because on a marginal machine the right answer is often "Medium
but with traffic off".

## Known performance limitations

- **The Rapier chunk is large** (~4.3 MB, 1.6 MB gzipped). That is a one-time download cost and it
  is why the first load has a progress screen. It is cached permanently after that.
- **The world is built synchronously per map** — staged and yielded, but a map change still costs
  a noticeable pause. There is no background worker; terrain generation is single-threaded.
- **Traffic AI runs for every spawned traffic vehicle**, not at reduced fidelity for distant ones.
  Traffic is capped per chunk, but this is the least optimised system in the project. The traffic
  signal lookup adds a per-road cached scan on top of that.
- **Particles are integrated on the CPU.** At the High budget that is 1200 particles of cheap
  arithmetic per frame; it is not free, but it is also not a GPU pass.
- **No occlusion culling.** Frustum culling and distance unloading are implemented; occlusion
  queries are not.
- **Quality is not adaptive.** The preset is chosen once (and defaults to Potato on a software
  rasteriser) and does not adjust itself to hold a frame rate. Adaptive quality was deliberately
  left out: tuning it to be stable is harder than it looks, and a preset that changes underneath
  the player is worse than a steady, lower setting. A consequence is that the preset is read when a
  map is built, so changing it takes effect on the next map load for anything baked into the world —
  vegetation density and the tunnel lights among them.
- **Tunnel lights are the one setting that costs everywhere.** Each is a `PointLight` with a bounded
  reach, and none of them is near the player except inside a tunnel, but a forward renderer still
  evaluates every light on every lit fragment. The per-map cap of ten and the preset spacing exist
  precisely so that adding tunnels could not quietly make the whole game more expensive.
