# AERODRIVE — Web build

An open-world 3D driving simulator that runs in a browser. Three.js renders it, Rapier
simulates it, and everything you see and hear is generated procedurally at runtime — the
project bundles **no** third-party models, textures, or audio.

This directory is the browser game. The Unity/C# build lives in [`../App`](../App) and is a
separate, independently scaffolded project.

---

## Quick start

Requires **Node.js 20.19+** (Vite 7 needs it) and npm.

```bash
cd Web
npm install
npm run dev
```

Open the URL Vite prints (by default <http://localhost:5173>). Click **Play**, then drive.

### Scripts

| Command                | What it does                                                          |
| ---------------------- | --------------------------------------------------------------------- |
| `npm run dev`          | Vite dev server with hot module replacement.                          |
| `npm run build`        | Production bundle into `dist/`.                                       |
| `npm run preview`      | Serve the built `dist/` locally — use this to check a real build.     |
| `npm test`             | Unit and integration tests (Vitest).                                  |
| `npm run test:e2e`     | Builds, then drives the real build in headless Chromium (Playwright). |
| `npm run lint`         | ESLint.                                                               |
| `npm run lint:fix`     | ESLint with `--fix`.                                                  |
| `npm run format`       | Prettier write.                                                       |
| `npm run format:check` | Prettier check.                                                       |

`npm run test:e2e` needs a browser binary once:

```bash
npx playwright install chromium
```

---

## Controls

| Action                               | Keys               |
| ------------------------------------ | ------------------ |
| Accelerate                           | `W` / `↑`          |
| Brake, then reverse                  | `S` / `↓`          |
| Steer                                | `A` `D` / `←` `→`  |
| Handbrake                            | `Space`            |
| Toggle drift mode                    | `G` (rebindable)   |
| Upshift / downshift (manual gearbox) | `Shift` / `Ctrl`   |
| Change camera                        | `C`                |
| Recover vehicle                      | `R`                |
| Headlights                           | `H`                |
| Horn                                 | `F`                |
| Toggle control guide                 | `M`                |
| Performance overlay                  | `F3`               |
| Pause                                | `Esc` (rebindable) |

Game controllers work through the Gamepad API: left stick steers, triggers drive, `A` cycles
the camera and `Y` recovers the car. Every binding above can be changed in **Settings →
Controls**.

On phones and tablets, on-screen steering, throttle, brake, handbrake and pause buttons appear
while driving. They are multi-touch, so one thumb can steer while the other holds the throttle.

Drift mode can also be toggled with the on-screen HUD button. It reduces rear tyre grip and
switches off traction and stability assists while enabled. Try the Desert Drift Pad or the
Modern City Airfield Drift Loop challenge.

---

## What is actually implemented

**Vehicles.** Seven procedural bodies — hatchback, sedan, coupé, supercar, SUV, pickup and
off-road 4×4 — built from lofted geometry with independent wheels, working headlights and brake
lights, and per-vehicle handling data. Front, rear and all-wheel drive, automatic and manual
gearboxes, an engine torque curve, a clutch model, traction control, ABS, a stability assist,
engine braking and handbrake rear-lock. The player's car gets a modelled cockpit interior
(dashboard, wheel, seats, console, door cards and mirror); traffic keeps the lighter exterior model.

Only the hatchback and sedan are unlocked at first launch; the rest are unlocked by finishing
challenges, so there is a reason to play them.

**Driving physics.** Rapier's ray-cast vehicle controller drives a rigid chassis with a solved
suspension rest pose, speed-sensitive steering, aerodynamic drag, rolling resistance and
downforce. Impact damage accumulates from real collision events.

**World.** Four maps (Alpine Valley, Coastal Highway, Modern City, Desert Proving Grounds) built
from one procedural heightfield per map that feeds _both_ the visual mesh and the physics collider,
so they can never disagree. Modern City is a coastal metropolis: a 16 m bypass looping the built-up
area and boring through Eastgate Ridge, a downtown of avenues crossed by a diagonal, a curving
suburban estate at Willowbrook, an airfield with a drivable 45 m runway, a taxiway and an apron
loop, and a shore road out to a beach on the bay — with the sea, the sand and the streets all
coloured from the same heightfield. Roads are Catmull-Rom curves projected onto the terrain,
graded into a drivable vertical alignment, cut into the ground, and given real collision
surfaces. Level pads are carved under every spawn point. The coastal map gets a sea plane at its
terrain style's sea level, and every map places parked cars along its kerbs.

**Bridges and tunnels.** A road can declare that it wants a bridge or a tunnel and the terrain
decides where, if anywhere, it goes. A window of road is fitted with a straight _vertical_ alignment,
and the structure is placed only if that line clears the ground by enough (or is buried under it by
enough) _across the full width of the structure_, not just along the centreline. The span is then
grown outwards until the two surfaces meet — which is where the abutment or the portal belongs — and
if it reaches the edge of the window with the ground still opening up outside it, the window is
widened and the whole decision taken again, so a hill or a gorge wider than the declared window still
gets its portals on its own slopes. Only the vertical is straightened: the plan geometry is the
road's own, so a structure on a curving road curves with it.

The road over the span is left completely ungraded, so a bridge spans the valley it was chosen for
and a tunnel bores through intact hillside: a Rapier heightfield does not collide with anything
beneath it (`tools/probe-heightfield-sides.mjs` demonstrates this), so the hill above a tunnel stays
exactly as it was. A road with nothing to span gets no bridge and says so in the console instead.
Alpine Valley and Coastal Highway have two of each, and Modern City has a tunnel under Eastgate
Ridge and a viaduct over the creek at Cinder Beach — all with decks, parapets, piers, abutments,
portal surrounds and ceiling lamps — and real point lights inside the bore on every preset but
Potato, spaced by the preset and capped at ten per map.

**Time and weather.** A real day/night cycle: the clock hour drives the sun's arc, its colour and
intensity, the sky gradient, the fog, the ambient fill and a hash-based star field, and it can be
pinned or left running at 24, 2 or 240 real minutes per day. Weather adds rain, wet roads that
really do lose grip — asphalt keeps 72% of it when soaked — tyre spray, and lightning with thunder
a beat behind the flash. Wetness soaks in over ~14 s and dries over ~45 s, so the road stays
treacherous after the rain stops.

**Services.** Every map declares garages, fuel stops and recovery points. Stopping at one repairs
the car for free; they are listed on the world map with distances.

**Streaming.** Props are bucketed into 180 m chunks, instanced per type and variant, and loaded
and unloaded around the player with a per-frame work budget. Unloading disposes GPU buffers and
removes colliders.

**Traffic.** Road-following AI cars drawn from a pooled fleet that is created once and activated
and deactivated around the player, with configurable density — including off entirely. Junctions are
derived from the built road geometry, each crossing gets a timed signal, and traffic obeys it,
brakes for the player and edges around them. A car that has been blocked for nine seconds is
relocated rather than left to gridlock a road.

**Audio.** A fully synthesised engine (oscillator stack plus induction noise, pitch-tracked to
RPM), tyre, wind and ambience beds built with the Web Audio API. Audio arms on the first user
gesture and respects autoplay rules.

**Gameplay.** Nine challenges across the maps (checkpoint races, time trials, drift circuits, a speed run, a
handling test, a landmark exploration tour, a braking-distance test and a parts-delivery run), each
with real checkpoints, timers, failure conditions, scoring and unlocks. The braking test measures the
distance you actually needed and fails you for arriving too slowly _or_ overshooting; the delivery
run fails if the cargo takes more than 12 damage. Free roam is always available.

**UI.** Main menu, garage with spec sheets and paint selection, map and challenge browsers, a full
world map, settings, credits, pause menu, confirm dialogs, an HUD with a canvas speedometer, RPM,
gear, damage, clock, weather, grip and a live minimap, plus a performance overlay and multi-touch
driving controls on phones and tablets. Keyboard navigable with visible focus.

**Saves.** Settings in `localStorage`, structured progress in IndexedDB with a `localStorage`
fallback, both versioned and sanitised on read.

---

## Project layout

```
src/
  app/          Game orchestrator: state machine, boot, map loading, wiring
  core/         EventBus, fixed-timestep GameLoop
  rendering/    Renderer + quality presets, sky/fog/lighting, day/night, weather,
                skid marks and particles
  physics/      Rapier world wrapper: colliders, surfaces, tags, raycasts
  vehicles/     Vehicle controller, gearbox, definitions, procedural models
  terrain/      Heightfield generation and the terrain mesh/collider
  roads/        Road curves, ribbon meshes, grading and flattening
  world/        Map definitions, the World builder, streamed prop field
  audio/        Synthesised engine, tyre, wind and ambience
  input/        Keyboard, mouse, gamepad and touch sampling
  camera/       Chase, cockpit, hood and cinematic rigs
  ai/           Road-following traffic + junction detection and signal timing
  missions/     Challenge definitions and the mission runtime
  ui/           Screens, HUD, minimap, world map, garage and settings panels
  settings/     Settings schema, defaults, presets, persistence
  saves/        Progress model and storage
  utilities/    Maths, noise, RNG, scheduling
tests/          Vitest suites + tests/e2e (Playwright)
tools/          Standalone diagnostic scripts (see tools/README.md)
```

The architecture rule that matters most: **physics and rendering are separate.**
`GameLoop` advances the simulation in fixed `1/60 s` steps and calls presentation once per
animation frame, so handling is identical on a 30 Hz laptop and a 240 Hz monitor.

---

## Testing

```bash
npm test                # 262 unit + integration tests
npm run test:e2e        # 17 gameplay scenarios + touch and sub-path checks + a WebKit smoke test
npm run test:e2e:webkit # WebKit only — Safari's engine
npm run lint
```

The suite is not decoration — it found the bugs that mattered. Among others: reverse being
impossible to engage after driving, roads inheriting the terrain's micro-relief and reaching 90%
grades, spawn points placed 280 m from the nearest road, the beam of the terrain generator
producing mountain-sized "surface detail", tyre grip scaling the wrong way with speed,
`Escape` never actually being bound to pause, a traffic light placed in the middle of the
carriageway by sampled instead of exact junction detection, clear weather dimming the sky, dust
falling instead of rising after a long frame, and a save notification permanently replacing the
main-menu status line.

The one a player would have described as "half the roads go nowhere" was a map whose named places sat on
roads that no other road reached. Alpine Valley's two spurs and Coastal Highway's beach access each
stopped 20–320 m short of the road they belonged to, which is invisible on the world map, invisible in
a screenshot, and only noticed when you drive to the landmark the map promised and cross a strip of
grass to get onto the road that serves it. They now start on the parent road's own geometry, and
`tools/probe-road-connectivity.mjs` is the check that finds this class of defect: it joins roads whose
asphalt actually meets and reports every landmark and spawn point on a piece nothing reaches. All
four maps now come back as a single connected network; Desert Proving Grounds gained a 302 m
`dune-link` between the end of the dune trail and the handling circuit.

The two that a player would have described as "the car is broken" were both in how the vehicle is
driven rather than in what it is: Rapier's user forces and user torques are **separate accumulators**,
and resetting only the forces left the per-step stability assist building up until the body had
~30 kN·m of yaw torque and the car pirouetted with the steering centred — `probe-torque-accumulation.mjs`
is the standalone script that pinned it down. On top of that, the car's on-screen pose was snapped to
the newest physics step, so on any display that is not exactly 60 Hz it advanced two steps on some
frames and one on others and visibly juddered; the renderer now interpolates between the two steps
it sits between (`Vehicle.syncVisual`). See [`docs/TESTING.md`](docs/TESTING.md) for what each suite covers and how
to reproduce the browser run.

Two of the worst were found by writing the structure tests: a bridge was judged by the _worst_
point in a 150 m window, which rejects every bridge on every road, because a window's ends are by
definition where the road is back on the ground; and a span was allowed to grow past the stretch of
road its alignment was drawn over, so the road inside the span was its old graded self rather than
the line the clearance had been measured against — a road that could quietly poke into the hill it
was meant to run through.

Three more came out of the same area in the latest pass: a window longer than the road left was
being silently shortened, and a shortened window covers only the higher ground near the road's end,
so it won the comparison that picks where a structure goes for the wrong reason; a jump ramp placed
pointing uphill was buried by the terrain, which climbs faster than the ramp's own incline does; and
the browser suite's mesh assertions had to be told that a structure group now contains lights, which
is exactly the kind of assumption a test should be forced to state.

Two limits worth knowing: the e2e suite runs against **software WebGL** in headless Chromium,
where the frame rate is in the single digits, so it asserts on simulated progress (odometer,
speed, gear) rather than wall-clock timing; and no automated test can confirm that the game
_looks_ right, which still needs a human.

---

## Performance

Four presets ship — Potato, Low, Medium, High — selectable in Settings and remembered between
sessions. A fresh installation starts with the laptop-friendly Low settings; existing saved graphics
choices are preserved. Potato drops the internal render scale to 0.6, disables shadows and anti-aliasing,
halves the view distance, and cuts vegetation to 15%, traffic to none and skid marks off. A software
rasteriser is detected at boot and downgraded to Potato automatically, so the first impression on a
weak machine is "it runs" rather than "it stutters".

| Preset          | Render scale | View distance | Shadows | AA   | Vegetation | Traffic | Skid marks | Particles |
| --------------- | ------------ | ------------- | ------- | ---- | ---------- | ------- | ---------- | --------- |
| Potato          | 0.6          | 350 m         | off     | off  | 15%        | 0%      | off        | 180       |
| Low _(default)_ | 0.85         | 700 m         | low     | off  | 45%        | 25%     | on         | 380       |
| Medium          | 1.0          | 1400 m        | medium  | FXAA | 75%        | 50%     | on         | 720       |
| High            | 1.0          | 2600 m        | high    | MSAA | 100%       | 70%     | on         | 1200      |

Weather is deliberately not part of a preset — it is the player's choice, not a quality level — so
the preset only scales its cost. Rain is one GPU-animated draw pass whose drops all move in the
vertex shader, so heavy rain costs the CPU nothing after setup.

**What has been measured, and what has not.** The game was developed and verified in a headless
Linux environment with no GPU, where Chromium falls back to the SwiftShader software rasteriser.
That runs the game at single-digit frame rates and is useful for proving correctness, but it says
nothing about performance on real hardware. **No frame-rate benchmark on a GPU has been performed
here, so no FPS target is claimed.** Treat the preset table as the tuning lever, not a promise.

The levers that matter, in order of effect: **render scale** (scales pixels quadratically),
**shadows** (a second full scene pass), **view distance** (how much geometry and how many chunks
stay resident), then vegetation and traffic density. `F3` in game shows live frame rate, frame
time, and CPU time split between simulation and rendering — watch the simulation/render split to
find out whether you are GPU- or CPU-bound before changing anything.
See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for the full picture and how to benchmark it
yourself.

---

## Browser support

| Browser                       | Status                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| Chrome / Edge (Chromium 110+) | Primary target; the full gameplay suite runs here.                                                        |
| Firefox 115+                  | Expected to work (WebGL2 + WASM + Web Audio). Not covered by anything automated.                          |
| Safari / WebKit 16.4+         | Boots, renders and reaches the menu under a smoke test. The gameplay suite is Chromium-only.              |
| Touch devices (iOS / Android) | On-screen driving controls appear automatically; a phone-sized touch scenario drives the car in Chromium. |

WebGL is feature-detected at startup and a readable message is shown instead of a blank canvas
if it is missing, along with the reason and what to do about it.

---

## Deployment

The build is a static bundle with relative asset paths, so it works from a domain root _or_ a
repository sub-path unchanged. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for GitHub Pages,
Cloudflare Pages and Netlify, and for the verification steps to run after deploying. The sub-path
case is not left to trust either: `tools/serve-dist.mjs` serves the build under a mount prefix and
the browser suite boots it there on every run, checking that nothing is fetched from the server root.

---

## Licensing and assets

All geometry, textures, road markings, terrain colours and audio are generated by the code in
this repository. The only third-party code is Three.js (MIT) and Rapier (Apache-2.0). See
[`docs/ASSET-LICENCES.md`](docs/ASSET-LICENCES.md).

AERODRIVE is an original work. It is _inspired by_ the freedom and simulation spirit of modern
driving sandboxes but shares no code, model, map, sound or branding with any commercial title.

## Known issues

See [`docs/KNOWN-ISSUES.md`](docs/KNOWN-ISSUES.md). The short version: there is still no damage
_deformation_ — impacts accumulate a damage percentage that affects handling, but bodywork does not
bend — bridges and tunnels exist only on the three maps that declare them, and a tunnel is dark
unless the preset is Low or above. No GPU frame rate has been measured, so no FPS figure is claimed
anywhere.
