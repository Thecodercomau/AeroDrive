# Testing

Three layers, all runnable from the command line:

```bash
npm test                # 262 unit + integration tests (Vitest)
npm run test:e2e        # 17 gameplay scenarios + a touch check + 2 deployment checks, in Chromium and WebKit
npm run test:e2e:webkit # Safari's engine only — the WebKit smoke test
npm run lint            # ESLint
npm run format:check
```

## Unit and integration tests

Fast; no browser. Several suites instantiate **real Rapier physics** in Node, so they are genuine
integration tests rather than mocks.

| File                            | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/gearbox.test.js`         | Gear selection, shift guards, torque, clutch slip, reverse direction, rev limiter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tests/vehicle-physics.test.js` | A real car driven on real terrain: settling, wheel contact, acceleration, braking, steering, reverse, recovery, surface reporting, that the stability assist's torque does not accumulate between steps, and that the visual pose is interpolated between physics steps.                                                                                                                                                                                                                                                                             |
| `tests/spawn.test.js`           | Every spawn point on every map: flat ground, on-road surface, correct heading, and a car that actually drives away from it.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/roads.test.js`           | Grade smoothing and clamping, drivable grades on every map, road surface reporting, terrain tight against the verge everywhere except inside a structure, and bridges and tunnels that are genuinely above and under the ground.                                                                                                                                                                                                                                                                                                                     |
| `tests/structures.test.js`      | The bridge and tunnel maths against synthetic terrain: arc-length lookup, the tunnel cross-section and where it is high, the sweep's vertex and index counts, placement on a hill and over a dip, refusal on flat ground and on a gap too short to be worth building, the straight-line vertical alignment, piers that only stand where the deck is off the ground, the window widening for a feature wider than it, that a structure follows the road's plan curve exactly, and that the tunnel's point lights are placed, spaced and preset-gated. |
| `tests/props.test.js`           | Prop generation invariants: only known types are produced on any map, the solid-collider budget holds, every declared jump ramp is placed at its declared position and heading, and the ramp's wedge geometry is the size its collider assumes.                                                                                                                                                                                                                                                                                                      |
| `tests/terrain.test.js`         | The heightfield grid convention asserted against a real Rapier heightfield, determinism per seed, slope measurement, road flattening, bilinear interpolation.                                                                                                                                                                                                                                                                                                                                                                                        |
| `tests/world.test.js`           | Map building, streaming, prop density, collision surfaces, driving along a generated road.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/missions.test.js`        | Mission lifecycle: gate order, timeout, scoring, restart, landmark discovery, and every challenge resolved against its own map.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tests/settings.test.js`        | Schema sanitisation, enum/range clamping, presets, binding validation, migration, persistence.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/saves.test.js`           | Progress sanitisation, records, unlocks, discovery, storage fallback, reset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/input.test.js`           | Keyboard, gamepad and touch sampling, deadzones, edge-triggered actions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tests/daylight.test.js`        | The solar arc, clock wrapping and day length, three-mood colour blending, and that dawn has no step in it.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `tests/weather.test.js`         | Weather profiles, wet-grip curves per surface, the soak/dry ramp, and that clear weather changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tests/traffic-signals.test.js` | Junction detection from road geometry, signal phases and amber windows, and approach logic including junctions behind the car.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `tests/effects.test.js`         | Skid-mark ring buffer, degenerate and teleport-sized segments, and the particle pool's lifecycle, recycling, fade and expiry.                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Notes on the terrain tests

Two of them exist specifically to catch silent, catastrophic regressions:

- **The grid convention test** asserts the height array's memory layout against a real Rapier
  heightfield. Rapier stores `heights[iz + ix * (resolution + 1)]` — fastest-varying index walks
  **Z**, not X. Getting that backwards transposes the entire landscape, and the symptom is the car
  driving through a hill. If a future Rapier release changes the convention, that test fails loudly
  instead of the world quietly rotating 90°.
- **The spawn tests** assert properties, not values: every spawn is on ground flat enough to place
  a car, on a road surface, facing along that road, and a car spawned there reaches a real speed
  without leaving the tarmac. These caught spawn points 280 m from the nearest road.

## Browser tests

`npm run test:e2e` builds the game and then drives it through Playwright: seventeen gameplay
scenarios in Chromium, a phone-sized touch-control scenario, plus two checks that the same
production build survives being _deployed_ — served from a hosting sub-path, and booted in WebKit:

1. Start the game and reach the main menu
2. Select a vehicle in the garage
3. Accelerate and steer on the map
4. Brake, then reverse
5. Collide with the world without falling through it
6. Recover the vehicle with `R`
7. Cycle the camera views with `C`, confirm the cockpit eye is under the roofline and that the
   player's car carries a cabin interior
   7b. Hold `F` and confirm the horn fires once, not once per frame
8. Open and close the pause menu
9. Change settings and see them reach the renderer
10. Persist settings and progress across a page reload
11. Set rain, manual transmission and a night clock, then confirm the wet grip really drops, the car
    is in manual, the sky really is night, and a handbrake slide lays down skid marks
12. Open the world map and confirm the canvas was genuinely painted and the panel lists the map's
    locations
13. List the challenges and start the braking-distance test, confirming a live objective on the HUD
14. Load Alpine Valley, check the bridges and tunnels were actually built with real triangles and
    that the tunnel interiors carry real point lights rather than only a painted strip, then drop the
    car onto a bridge deck and into a tunnel and confirm the physics agrees: the car stands on the
    deck with the valley floor still metres below it, and it stays on the road inside a hill with the
    terrain still metres above it — then drives out of the bore under its own power
15. Toggle drift mode with the key and with the HUD button
16. Switch the whole map from the pause menu
17. `touch.spec.js` — boot with a touch-capable, phone-sized viewport, confirm the on-screen
    steering, throttle, brake and handbrake controls appear, hold the throttle until the car is
    actually moving, then pause from the touch HUD and confirm the controls hide again
18. `subpath.spec.js` — boot the same build from `http://127.0.0.1:4174/aerodrive/`, served by
    `tools/serve-dist.mjs`, and reach the menu with a clean console and **nothing fetched from the
    server root**. This is the GitHub Pages shape, and it is the only test that would catch an
    absolute `/assets/...` reference in the bundle
19. `webkit-smoke.spec.js` — the same boot in **WebKit**, Safari's engine, which the Chromium suite
    says nothing about: a real WebGL context, a built world, the main menu, a clean console

Each of the gameplay scenarios also asserts the **browser console stayed clean**: uncaught errors
and `console.error` calls fail the test. That is what makes these tests worth running — the failures
they surfaced were the ones a human would only notice by playing for a while.

### Important caveat: software rendering

The Chromium tests run against `vite preview` (the production bundle, minified and code-split) but
with **software WebGL** via SwiftShader, forced on with `--use-angle=swiftshader` because the
test machine has no GPU to give headless Chromium. The frame rate is 6–9 FPS, and the game's
fixed-step loop caps catch-up at 5 substeps, so **wall-clock time inside the browser is roughly ten
times slower than simulation time**. The WebKit project does not take those flags — they mean
nothing outside Chromium — and the sub-path project is served by `tools/serve-dist.mjs` rather
than `vite preview`.

Consequently the tests assert on _simulated_ progress — odometer distance, reported speed, gear,
state — never on wall-clock durations. A test that says "wait 3 seconds and check the car moved
10 m" would be measuring the rasteriser. `expect.poll` against a live game value is used
throughout instead.

First run needs the browser binaries:

```bash
npx playwright install chromium webkit
```

## What the tests found

Recorded because it is the evidence that the suite is doing real work. Each of these was a real
bug, found by a test, fixed in the source, and re-verified:

| Symptom                                                            | Root cause                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A car placed at a spawn point revved but never moved               | Only one wheel found ground: the spawn was on a slope with two wheels buried. Fixed by carving a level pad under every spawn and lifting the pose to clear the terrain.                                                                                                                                                                                                        |
| A village garage spawn was 280 m from the nearest road             | Spawn points were hand-picked coordinates, never checked against the road network. Fixed by moving them onto roads, adding the access roads the maps were missing, and asserting the property in tests.                                                                                                                                                                        |
| Cars were thrown off the road at speed                             | Roads followed raw terrain height sample-for-sample and inherited its micro-relief, reaching **90% grades**. Fixed by grading the centreline (low-pass filter plus a 22% grade clamp) and letting the terrain be cut and filled to the road.                                                                                                                                   |
| Terrain had mountain-sized bumps every 50 m                        | The "fine surface detail" term was scaled by the style's amplitude, so on an alpine map it added ±25 m of relief at 50 m wavelength. Fixed by adding detail in **metres**.                                                                                                                                                                                                     |
| Reverse could never be engaged in a real session                   | Reverse was only reachable from neutral, but a player is always in first. Fixed so the brake pedal selects reverse from any gear once the wheels have stopped.                                                                                                                                                                                                                 |
| `Esc` did not pause the game                                       | It was never bound; only a hard-coded `P` was. Fixed by adding a `pause` binding (Escape + P) that the player can rebind.                                                                                                                                                                                                                                                      |
| Backing out of Settings mid-drive dropped you in the main menu     | `back` assumed the main menu instead of tracking where the player came from. Fixed with a screen-aware back.                                                                                                                                                                                                                                                                   |
| Tyre grip scaled the wrong way with speed                          | Traction-control budget was cut as speed rose, making the assist _more_ intrusive the faster you went. Fixed.                                                                                                                                                                                                                                                                  |
| Accelerating to top speed in one gear                              | The downshift guard computed the RPM for the gear above instead of the one being shifted into.                                                                                                                                                                                                                                                                                 |
| Speed dropped to zero with the throttle held                       | Only some wheels found ground; the front wheels hung in the air while the rear (undriven) wheels carried the car, so the engine free-revved. Fixed via the spawn and grading work above.                                                                                                                                                                                       |
| A traffic light was in the middle of the road                      | Junctions were detected as the closest pair of sampled points, which on a road sampled every 4 m puts the "crossing" metres from the real one. Replaced with exact segment-to-segment intersection.                                                                                                                                                                            |
| Clear weather darkened the sky by 10%                              | The sky-top factor carried an unconditional 0.9 multiplier, so the identity case was not the identity.                                                                                                                                                                                                                                                                         |
| Stars twinkled through an overcast sky                             | Star visibility was derived from the brightness factor instead of being stated per profile.                                                                                                                                                                                                                                                                                    |
| Dust fell instead of rising after a frame hitch                    | An unbounded Euler step let gravity overwhelm the upward velocity. Particle integration is now sub-stepped and capped at 50 ms.                                                                                                                                                                                                                                                |
| "Alpine Valley loaded" vanished a second after boot                | The 800 ms save debounce fired after the menu appeared and replaced the status line permanently. Pre-existing; surfaced when boot timing shifted. The status line now restores its persistent message.                                                                                                                                                                         |
| Every dirt road was drawn as asphalt                               | `minimapRoads()` omitted `surface`, which both the minimap and the world map read — so `surface === 'dirt'` was never true.                                                                                                                                                                                                                                                    |
| A structure was placed in the corner of a road                     | The window search compared candidates by their _mean_ fit, but a window longer than the road left was silently shortened — and a shortened window covers only the higher ground near the road's end, so it won the comparison for the wrong reason. Windows that cannot fit are now refused rather than clipped. Found when window widening kept re-selecting a corner window. |
| A jump ramp swallowed by the hill it stood on                      | The ramp was placed pointing along the road without regard for the ground: facing uphill, the terrain climbs faster than the ramp's own incline does and buries it. The ramp now faces down the local grade, so its incline stays proud of the ground for its whole run. Found by dropping a ray on the middle of the ramp and landing on terrain.                             |
| Every car was 25–45% below its claimed top speed                   | Rapier's `linearDamping` is applied to the whole body every step, not just as a stability aid. The global `0.06` removed ~1.8 kN at highway speed. Lowered to `0.005` and each car's aerodynamic drag was calibrated against its spec sheet; a browser test now pins both top speed and 0–100 km/h.                                                                            |
| Braking from 100 km/h took 16 seconds                              | `maxBrake` was authored as an impulse but the values were force-sized, producing only ~0.2 g. It is now a force in newtons, converted to Rapier's impulse units per step; ABS still clamps it to available grip.                                                                                                                                                               |
| Holding `C`, `R`, `H` or `F` repeated the action every frame       | Raw held device flags were OR-ed into the one-shot latches, so a held key re-fired every sample. The latches are now authoritative.                                                                                                                                                                                                                                            |
| Desert Proving Grounds' dune trail was an isolated road island     | The trail ended 283 m from the handling circuit. A 302 m `dune-link` now joins a dune-trail control point to the circuit's north-west corner; all four maps report a single connected network.                                                                                                                                                                                 |
| The cockpit camera floated above the roof, and the horn was silent | Cockpit/hood offsets were authored above the bodywork and several cars had no hood offset at all; the horn had bindings but no synthesiser or game hook. The camera now sits inside the cabin, the player's car gains a lightweight interior, and `F` fires a synthesised dual-tone blast once per press.                                                                      |

## What is _not_ tested automatically

Stated plainly, because "the tests pass" should never be read as "everything works":

- **Visual correctness.** No test asserts the game looks right. Materials, lighting, the sky, the
  star field, vehicle silhouettes, the HUD layout and the minimap need human eyes. The closest the
  suite comes is asserting that two canvases (the WebGL backing store and the world map) contain
  non-blank pixels — which catches "nothing was drawn" and nothing subtler.
- **Audio.** Web Audio does not run meaningfully headless. That the engine note tracks RPM, that
  gear changes are audible, that rain sits under the engine rather than over it, and that thunder
  lands behind the flash is verified by listening, not by CI.
- **Real GPU performance.** See [`PERFORMANCE.md`](PERFORMANCE.md) — no GPU benchmark has been run.
- **Firefox, and every browser running the gameplay scenarios.** WebKit is smoke-tested, but the
  gameplay suite is Chromium-only, so an engine-specific bug in driving, menus or audio would not be
  caught on any other browser.
- **Long sessions.** Memory growth over an hour of streaming chunks in and out was reasoned about
  (buffers disposed on unload, colliders removed) but not measured over a long run.
- **Gamepad input.** The mapping is unit-tested, but no physical controller was used to verify it.

## Manual test script

Run through this after any significant change; it takes about ten minutes and covers what the
automated suites cannot.

**Boot and menu**

1. Load the page. A loading screen with progress appears, then the main menu, with a live 3D
   backdrop behind it.
2. Tab through the menu: focus is visible on every button, and arrow keys move it.
3. Open Settings, change the preset to High, close it. The backdrop's lighting and shadows change
   immediately.

**Driving**

4. **Play**. You start on tarmac at a garage. The HUD shows speed, gear, RPM, damage and a
   minimap, with your car centred on it.
5. Accelerate. Speed climbs smoothly; the engine note rises with RPM and the gear indicator
   upshifts. Steer — the car turns without snapping, and the camera lags behind believably.
6. Brake hard to a stop, keep holding: the gear indicator shows **R** and the car reverses.
7. `C` cycles chase → cockpit → hood → cinematic and back. In cockpit the interior is positioned
   sensibly, not floating.
8. `Space` at speed: the rear steps out and the car rotates.
9. Drive off the road onto grass: the car is noticeably slower and looser, and the HUD hints that
   grip is reduced.
10. Hit a wall or a tree: damage increases and the impact is audible and felt.
11. `R` puts the car back on the road, upright, repaired.
    11a. Handbrake hard into a corner at speed: the rear steps out, and **dark marks are left on the
    asphalt behind the car**. Do the same on grass and there should be none (grass takes no mark)
    but there should be dust.
    11b. Drive onto a dirt road at speed: a dust plume trails the driven wheels, in that surface's colour.
    11c. Run into a tree: a puff of debris appears at the point of contact, not at the centre of the car.
    11d. `Settings → World → Weather: Thunderstorm`: rain starts, the sky darkens, the road glosses over,
    the rain gets louder, spray kicks up from the wheels, and **the car takes noticeably longer to
    stop**. Lightning flashes and thunder follows a beat later.
    11e. Set the weather back to Clear and drive for a minute: the road dries out and grip returns — it
    should not snap back the instant the rain stops.
    11f. Set **Time of day** to 22:00 with the cycle off: the sky goes dark, stars come out, and the
    headlights matter. Set it to 05:30 and watch the sky go through dawn rather than switching.
    11g. Drive to a garage marker and stop: a "Repaired at …" message appears and the damage counter
    resets. Driving past at speed must **not** trigger it.
    11h. Drive into an Alpine Valley tunnel on the default preset: the interior is lit by the ceiling
    lamps, not only by the car's headlights. Then set the preset to **Potato**, switch maps and come
    back: the lamps are flat emissive shapes again and the tunnel is lit like the open road — the
    lights are preset-gated, and this is the visible difference.
    11i. On **Desert Proving Grounds**, follow the dirt dune trail and find the jump ramp beside it:
    a wedge rising out of the sand on flat ground, facing down the slope. Hit it at speed and the car
    leaves the ground. It must not be a step you crash into — there is no lip at its foot.
12. Drive hard at the edge of the map: terrain continues, there is no visible invisible wall in
    the middle of the drivable area.

**Menus and persistence**

13. `Esc` pauses. The world is frozen, not just covered.
14. Pause → Settings → adjust volume; the engine note changes as you move the slider. Then Back:
    you return to the **pause** menu, not the main menu.
15. Quit to main menu → Vehicles: seven vehicles listed, locked ones show what unlocks them.
    Pick the sedan, change the paint, drive it — the model, handling and colour all change.
16. Maps: switch to Modern City. The world reloads and you start in the city.
    16a. Drive north out of downtown and onto the beltway: a wide ring road around the built-up area,
    which tunnels under Eastgate Ridge on its north-east arc and comes out the other side.
    16b. Follow the beltway's west side and take the **airfield link** at its north-west corner:
    the road runs to Meridian Airfield, whose runway (45 m wide) is drivable and whose apron loops
    past the terminal. The runway is reachable only by road, so a car that arrives there drove there.
    16c. Take the beltway east and turn off at **Willowbrook Estate**: a curving loop of residential
    streets, not a grid — crescents off a loop, with houses on both sides.
    16d. Drive south down **Harbour Road** (the only route from downtown to the shore): it crosses the
    creek on a bridge, reaches the coast boulevard, and a beach access turns off to **Cinder Beach**
    and its promenade loop. The sea, the sand and the streets are all coloured from the heightfield,
    so the shoreline is where the water plane meets the sand rather than a painted texture.
17. Challenges: pick a time trial. An objective panel appears with a distance to the first gate,
    the minimap shows the markers, and the timer runs. Let it time out and confirm the fail
    message, then restart it.
    17a. Pick **Braking Distance Test**. Reach 100 km/h and cross the trigger line, stop in the zone, and
    confirm the completion message reports the distance in metres. Run it again and cross the line
    at 60 km/h: it must fail for arriving too slowly. Run it a third time and drive straight past
    the stop line: it must fail for overshooting.
    17b. Pick **Parts Delivery** and crash hard on the way: it must fail with "the cargo was damaged".
    17c. Pause → **World map**. Roads, landmarks, garages, recovery points and the player arrow are all
    drawn, the scale bar is readable, and the right-hand list is sorted by distance.
    17d. On Modern City, drive to an intersection and watch the traffic lights change; traffic on the
    red road stops at it. Park across the road in front of traffic and wait: after a few seconds the
    blocked car is moved rather than left there forever.
18. Reload the page. Your preset, volume, selected vehicle and paint are all still set.
19. Settings → Reset progress: a confirmation dialog appears first, and cancelling does nothing.
