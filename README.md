# AERODRIVE

An open-world 3D driving simulator, built twice from two prompts and two technology stacks:

| Directory      | Stack                                                    | Status                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`Web/`](Web/) | HTML, CSS, JavaScript ES modules, Three.js, Rapier, Vite | **Playable.** Built and verified end to end: 255 unit/integration tests, 19 browser checks in Chromium and WebKit (including touch controls and a sub-path deployment), clean lint, successful production build.                                                                                   |
| [`App/`](App/) | Unity 6.3 LTS, C#                                        | **Scaffolded.** Runtime systems, assembly definitions, EditMode tests, project settings and an Editor tool that generates the assets and a playable scene. Compiles clean and its EditMode suite passes, but there is no content and it has never been run as a game — see the honesty note below. |

Both are original works, provisional-named, and share no code, models, maps, audio or branding with
any commercial title. They are inspired by the _concept_ of open-world driving sandboxes, and
nothing more.

[`docs/PROMPT-COMPLIANCE.md`](docs/PROMPT-COMPLIANCE.md) checks both project prompts against the
repository requirement by requirement, and says plainly what is done, what is partial and what is
absent. Read that before trusting any summary — including the one above.

---

## Start here

**To play the game now:**

```bash
cd Web
npm install
npm run dev
```

Then see [`Web/README.md`](Web/README.md) for controls, features, testing and deployment.

**To open the Unity project:** see [`App/README.md`](App/README.md) and
[`App/docs/SETUP.md`](App/docs/SETUP.md).

---

## About the Unity build — read this before judging it

The `App/` project is a real Phase 1 scaffold: runtime systems (save file, input, vehicle physics,
gearbox, challenges, garage, audio, HUD), assembly definitions, an EditMode test assembly, project
settings with a pinned Unity version, a package manifest, and an Editor wizard that generates the
vehicle assets and a playable scene. Be clear about its limits:

- **It has been compiled, but never run as a game.** Unity 6000.6.5f1 imports the project, compiles
  its 242 scripts with no errors or warnings, and runs the EditMode suite to a green 64/64 — but no
  player build has ever been produced, there are no PlayMode tests, and no scene is committed. So the
  pure functions are proven and the application layer is not: nothing here shows that
  `VehicleController` drives a Rigidbody, that the wheel colliders have the right radii, or that the
  HUD renders.
- **The suite is five fixtures**: the gearbox, the brakes, the save system, the input map and the
  challenge rules. It is the fastest way to find out what else is wrong, and the manual checks in
  [`App/docs/TESTING.md`](App/docs/TESTING.md) are the ones that cover what it cannot.
- **There is no `.unity` scene file and no content.** Scenes and prefabs are Unity YAML; hand-writing
  that without a Unity install would mean shipping files that are probably corrupt and certainly
  unverified. Instead `AeroDrive ▸ Create Playground Scene` builds a car, camera, HUD, audio and
  ground inside Unity. There is also no road network, no terrain and no traffic here — the web build
  has all three, but that code is JavaScript and does not port mechanically.
- **Therefore: expect to fix compile errors.** Fix them in place and note them; `App/docs/SETUP.md`
  lists the most likely ones.

The web build is where the working game is. The Unity project is the beginning of the other one,
not a second finished game.

---

## Repository layout

```
AeroDrive/
  README.md          this file
  docs/              the prompt-compliance audit, and the trailer/video brief
  Web/               the browser game — playable
    src/             13 subsystems, ~13k lines
    tests/           Vitest suites + tests/e2e (Playwright)
    docs/            deployment, performance, testing, licences, known issues
    tools/           standalone diagnostic scripts
  App/               the Unity/C# project — scaffolded
    Assets/Scripts/  Core, Input, Missions, Presentation, SaveSystem, Vehicles
    Assets/Editor/   the wizard that generates the vehicle assets and the playground scene
    Assets/Tests/    EditMode tests for the gearbox, brakes, save system, input and challenges
    docs/            setup, architecture, testing, known issues
    ProjectSettings/ pinned Unity version
    Packages/        package manifest
```

---

## The bugs worth reading about

Both builds were developed under a rule: never claim something works without having run it. For the
web build that rule paid off repeatedly, and the failures are more instructive than the successes.
Each of these was found by a test, diagnosed to a root cause, fixed, and re-verified:

- **Cars could not move from their spawn.** The spawn pose lifted the car by a fixed clearance
  above a _single_ terrain sample. On a slope, the uphill wheels ended up buried in the ground, the
  down-raycasts started underground and returned no contact, and the engine free-revved. Fixed by
  carving a level pad under every spawn and sampling the terrain across the whole footprint.
- **A village garage was 280 m from the nearest road.** Spawn points were hand-picked coordinates
  that were never checked against the road network the maps actually generate.
- **Roads reached 90% grades.** Each centreline sample took its height straight from the terrain
  noise, so the road inherited metre-scale roughness between samples. Fixed with a proper vertical
  alignment: a distance-based low-pass filter plus a grade clamp, with the terrain cut and filled
  to the road.
- **The terrain had mountain-sized bumps every 50 m.** The "fine surface detail" term was scaled by
  the landform's amplitude, so on the alpine map it added ±25 m of relief at 50 m wavelength. The
  detail term now works in metres.
- **Reverse was unreachable in a real session.** Reverse could only be selected from neutral, but a
  player is always in first gear by the time they stop.
- **A traffic light stood in the middle of the carriageway.** Junctions were detected as the closest
  pair of sampled road points, which on a road sampled every few metres puts the "crossing" metres
  from the real one. Replaced with exact segment-to-segment intersection.
- **Clear weather darkened the sky.** The sky-top factor carried an unconditional multiplier, so the
  identity case was not the identity.
- **Dust fell instead of rising.** An unbounded Euler step let gravity overwhelm the upward velocity
  after a frame hitch. Particle integration is now sub-stepped.
- **"Alpine Valley loaded" disappeared a second after boot.** A save on its 800 ms debounce replaced
  the menu's status line, permanently. The browser suite caught it once boot timing shifted.
- **`Esc` did not pause.** It was never bound to anything; only a hard-coded `P` worked.
- **The reverse scenario passed, then failed.** Scenario 4 polled for "speed below 2 km/h" while
  holding the brake. Reverse engages the instant the wheels stop and then drives the car backwards,
  so the car could sail past 2 km/h between two 200 ms samples: the assertion was racing the
  behaviour it was testing. Rewritten to accept either outcome, then assert that reverse really does
  drive the car backwards.
- **Only one wheel found ground, so the car could not drive** at all in the browser — the same
  burial bug as above, seen from the wheel-contact side.
- **A structure was placed in the corner of a road.** The search that chooses where a bridge or
  tunnel goes compared candidate windows by their _mean_ depth — but a window longer than the road
  left was silently shortened, and a shortened window covers only the higher ground near the road's
  end, so it won the comparison for the wrong reason. Windows that cannot fit are now refused rather
  than clipped. Found while testing the window widening added in this pass.
- **A jump ramp was swallowed by the hill it stood on.** A ramp is rigid and the ground is not:
  placed pointing uphill, the terrain climbs faster than the ramp's incline does and buries it. Rays
  dropped on the middle of the ramp landed on sand. The ramp now faces down the local grade.
- **The car spun itself at a standstill.** Rapier keeps user _forces_ and user _torques_ in separate
  accumulators, and clearing only the forces left the per-step stability assist adding a yaw torque
  forever: measured in the browser, the body reached ~30 kN·m and pirouetted at 385°/s with the
  steering centred. This is the bug a player describes as "the car is broken" — it also flung the car
  off the road on a straight. Both accumulators are now cleared every step.
- **The car juddered on any display that is not 60 Hz.** Its mesh was snapped to the newest physics
  step, so a 120 Hz or 144 Hz panel rendered some steps twice and skipped others. The renderer now
  interpolates between the two steps the frame falls between, which costs one vector lerp and one
  quaternion nlerp per frame.

The full list, with root causes and the tests that guard each one, is in
[`Web/docs/TESTING.md`](Web/docs/TESTING.md).

## What is not done

Stated plainly rather than buried:

- No damage **deformation** — impacts accumulate damage that affects handling, but bodywork does
  not bend.
- Bridges and tunnels only exist on the two maps that declare them. Their vertical alignment is a
  straight line, but their plan geometry follows the road, so a structure on a curving road curves
  with it. Traffic obeys junction signals, joins a connecting road at its nearest point and brakes
  for the player, but cannot path around an obstruction and does not overtake.
- The sea is a flat plane that does not collide, and rain has no puddles or ripples.
- There is no traffic LOD, no occlusion culling and no adaptive quality.
- **No GPU performance benchmark has been run.** Development was headless with a software
  rasteriser, so no FPS figure is claimed anywhere in this repository.
- Firefox is expected to work but is not covered by anything automated. Safari's engine (WebKit) is
  covered by one smoke test, not by the gameplay suite.
- The Unity build has no content (no scenes, roads, terrain, traffic, models or front-end UI) and
  no player has been built from it. What it does have is a clean compile and a green EditMode suite:
  64 tests across five fixtures, covering the gearbox, the brake rules, the save system, the input
  map and the challenge rules. A mechanical audit of cross-namespace references and assembly
  definitions found three real mistakes before there was a compiler to catch them — two files using
  `GameSettings` without importing its namespace, and three components that could never be wired to
  the save file.

Full detail in [`Web/docs/KNOWN-ISSUES.md`](Web/docs/KNOWN-ISSUES.md).

## Licensing

Three.js (MIT) and Rapier (Apache-2.0) are the only third-party code. All art and audio is
generated procedurally at runtime; no third-party creative assets are bundled. See
[`Web/docs/ASSET-LICENCES.md`](Web/docs/ASSET-LICENCES.md).
