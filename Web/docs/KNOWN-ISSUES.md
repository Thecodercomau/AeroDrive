# Known issues

Last reviewed against the build in this repository. Everything listed here was observed; nothing
is speculative, and nothing here is hidden in a comment somewhere instead.

## Functional gaps

### The desert dune trail is a separate piece of road

`tools/probe-road-connectivity.mjs` joins roads whose asphalt actually meets and
reports which landmarks and spawn points end up on a piece nothing else reaches. Three of the four
maps now come back connected — Alpine Valley's village and lakeside spurs and Coastal Highway's
beach access each started 20–320 m short of the road they belong to, and now start on it. **Desert
Proving Grounds does not**: `dune-trail` passes within 283 m of the handling circuit and touches
nothing, so the jump ramp and the High Dunes are reached by driving across open sand rather than by
following a road onto the trail.

It is left that way deliberately for now. The map is an off-road proving ground where sand driving
is the point, the ground between the two roads is dry and flat (12.9–17.4 m of dune, measured), and
connecting them means adding roughly 640 m of new road that nothing has looked at. The measurement
is here so the next person does not have to rediscover it:

```bash
node tools/probe-road-connectivity.mjs desert-proving-grounds   # exits 1
```

### Traffic cannot path around an obstruction

Traffic follows the road centreline, so its "avoidance" is to slow for whatever is beside it and
edge within its own lane. It obeys junction signals, brakes for the player, and a car blocked for
nine seconds is relocated instead of being left to gridlock a road forever — but it will not drive
_around_ a parked car, and it does not overtake.

Signals only exist where two roads genuinely cross, which means Modern City's streets get them and
the mountain and desert maps do not. There are no posted speed limits either: cars have their own target
speeds rather than reading signs.

_Workaround:_ set **Traffic density** to 0 in Settings, or use the Potato preset, where it is
already 0. Traffic is off by default only on Potato.

### No damage deformation

Impacts accumulate a damage percentage that reduces performance, and collisions are felt and
heard, but bodywork does not bend, crumple or detach. This is a rigid-body model. Soft-body
deformation is a genuinely different simulation and is not claimed here.

### Traffic and distant vehicles have no LOD

Every active traffic vehicle is a full-detail mesh with its own rigid body. They are pooled and
capped (14 at 100% density), but there is no reduced-detail representation for distant ones.

### The handbrake is binary

`Space` locks the rear wheels fully. There is no analogue handbrake, so you cannot feather it.

### No cockpit interior detail

The cockpit camera is positioned correctly inside the bodywork, but there is no modelled interior
— no dashboard, steering wheel, or mirrors. The chase and hood views are the ones that look
finished.

### Challenges are still tied to one map each

Nine challenges exist, each tied to one map, and starting one on another map loads that map rather
than describing it as a route. The world map shows the current map's roads, landmarks, services and
the active challenge's gates — but it is per-map, not a single overview of all four.

## Visual and audio limitations

- **Bridges and tunnels exist, but only on the two maps that declare them.** Alpine Valley has two
  tunnels and two viaducts, Coastal Highway has one of each, and the city and desert maps have
  neither. Nothing is placed by hand: a road declares that it wants a structure and the terrain
  decides where, so a road with nothing to span or bore gets no structure and says so in the console.
- **A structure's vertical alignment is a straight line.** The road inside a span is straightened
  between the two ends of its search window, with a sine crown across a bridge and nothing between
  them; it does not follow a grade change or a crest. The **plan** geometry is not straightened — a
  deck and a bore sweep the road's own centreline, so a structure on a road that curves in plan
  curves with it.
- **The search window widens, but only as far as the road goes.** A span that would run into the edge
  of its window with the ground still opening up outside it widens the window and is decided again,
  so a hill or a gorge wider than the declared window still gets its portals on its own slopes. The
  road itself is the limit: a feature that runs the whole length of a road gets a structure that runs
  the whole length of the road.
- **Tunnel lighting is real, but not on the lowest preset.** Ceiling lamps are lit by point lights
  spaced by the graphics preset — 45 m on Low, 28 m on Medium, 18 m on High — capped at ten per map,
  because a point light costs per-fragment work on every lit surface in the scene, tunnel or not. On
  **Potato** a tunnel is the emissive lamp strip, lit by the same ambient light as the open road,
  with the car's headlights the only light source in there.
- **Traffic cannot overtake, and joins a connecting road by proximity.** At the end of a road a
  traffic car continues onto the nearest _point_ of the nearest other road — where a driver would
  actually merge — because the maps are drawn from parametric loops and a junction is a geometric
  coincidence rather than a declared node. Where the nearest road is more than 600 m away the car is
  moved to another road outright.
- **The sea is a flat plane, and it does not collide.** There is no reflection, no refraction and no
  wave motion, because a reflective water surface is one of the most expensive things a real-time
  renderer can do. Driving into it does not stop the car. The shore is simply where the terrain
  rises above the plane.
- **Rain is a visual and audio effect plus a grip change.** There are no puddles, no ripples, no
  splashes on the bodywork and no reduction in visibility beyond the darkened sky. Wetness does
  reach the tyres, where it matters most.
- **No day/night shadows beyond the sun's own.** The sun's colour, intensity and direction all
  follow the clock, but there is no moon shadow, no street lighting that switches on at night, and
  no contact hardening in the shadows it does cast. Shadow acne is still possible at low sun angles.
- **Dust and skid marks are heuristics.** Neither reads a tyre slip model, because Rapier's raycast
  vehicle does not have one; both are inferred from lateral velocity, the handbrake, hard braking and
  driven-wheel torque at low speed. They look right under a car that is visibly sliding, and they are
  not a tyre simulation.
- **Audio is fully synthesised.** The engine note is convincing for a generic four-cylinder, and the
  rain is a filtered noise bed, but the seven vehicles share one synthesis model with different
  parameters; they do not each have their own recorded character. There is no ambient occlusion or
  reverb per environment.

## Platform and environment

### WebGL is required, with no fallback renderer

A browser without WebGL gets a clear message explaining why the game cannot start, not a running
game. There is no Canvas 2D or software fallback.

### Pointer Lock is required for mouse look, and needs HTTPS

Mouse-look uses the Pointer Lock API, which only works in a secure context. On a deployment served
over plain HTTP, the mouse will silently not turn the camera — everything else still works.
`localhost` is treated as secure, so local development is unaffected.

Chrome also enforces a short cooldown after the user presses `Esc` to leave pointer lock. Clicking
the canvas re-locks. On Safari, pointer-lock behaviour differs slightly around `Esc` and fullscreen.

### Firefox is untested; Safari has a smoke test

The full gameplay suite runs in Chromium. WebKit — the engine Safari uses, and a genuinely different
WebGL stack — is covered by one smoke test that boots the production build, checks a real WebGL
context, a built world, the main menu and a clean console. It passes. Firefox is not covered by
anything automated: treat it as "should work, unverified".

## Performance

### No GPU benchmark has been run

Development happened in a headless environment with no GPU. Correctness is well covered; frame
rate on real hardware is not measured, and no FPS figure is claimed. See
[`PERFORMANCE.md`](PERFORMANCE.md).

### Map changes pause visibly

Terrain generation is staged and yields to the browser, so the tab stays responsive and the loading
screen updates — but switching maps still takes a noticeable pause. Generation is single-threaded;
there is no Web Worker.

### No adaptive quality

The preset is chosen once and stays. The game does not lower its own settings to hold a frame rate.
This is deliberate — a preset that changes underneath the player is worse than a stable lower one —
but it does mean a marginal machine needs manual tuning.

### Large first download

The Rapier physics chunk is ~4.3 MB uncompressed (1.6 MB gzipped) because its WebAssembly is
inlined as base64 so the game works on any static host without MIME configuration. It is cached
permanently after the first load.

## Testing gaps

Not issues with the game, but with the confidence you should place in it:

- **WebKit is covered by one smoke test; Firefox by nothing.** Neither is driven through the gameplay
  scenarios, so a WebKit- or Gecko-specific bug in driving, menus or audio would not be caught.
- No visual regression testing. "It renders correctly" is verified by a human looking at it, plus two
  browser assertions that the world-map canvas and the WebGL backing store are genuinely non-empty.
- Audio is not covered by automated tests at all. The browser suite proves rain and thunder do not
  throw; it cannot prove they sound right.
- No long-session memory test; streaming correctness is argued from the code (buffers disposed,
  colliders removed on unload) rather than measured over an hour. The same is true of the skid-mark
  ring buffer and the particle pool: both are fixed-size by construction, which is an argument, not a
  measurement.
- Gamepad mapping is unit-tested but no physical controller was used to confirm it end to end.
- Touch controls are covered by a phone-sized Chromium scenario that holds the throttle until the
  car moves, but no physical phone or tablet was used to confirm them.
- The browser suite starts a challenge and asserts the objective is live, but it does not race one to
  completion — the completion path is covered by unit tests against the real mission runtime.

## Design limitations worth knowing

- **Steering assist is on by default and cannot be turned off in the UI.** A mild stability assist
  keeps the car catchable and can be felt as a slight resistance to oversteer at speed. Its strength
  is a per-vehicle tuning value (`assists.stability`), not a settings slider — setting it to 0 in a
  vehicle definition disables it for that car.
- **The save format is browser-local.** Progress lives in IndexedDB (with a `localStorage`
  fallback) and does not follow the player between browsers or machines. There is no export or
  import. Clearing site data deletes progress.
- **Manual transmission is a settings toggle, not a per-car choice.** **Settings → Driving →
  Transmission** switches every car to manual, with `Shift` and `Ctrl` to shift. The choice is global
  and persists; there is no per-vehicle preference.
