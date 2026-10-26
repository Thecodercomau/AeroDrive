# Video prompt — AERODRIVE

A **prompt document**, not a video. Nothing here has been rendered: it is the brief you paste into a
text-to-video model, or hand to a human editor, to produce a trailer for the browser build.

Two things to know before you use it.

**The model has never seen the game.** Everything it renders comes from these words, so the prompt
below states the game's real look and, just as importantly, what _not_ to show. The
[ground truth](#ground-truth-what-the-game-actually-looks-like) section exists so a plausible-looking
trailer does not end up advertising features the project does not have — the one failure mode this
repository cares most about avoiding.

**A real trailer would be captured, not generated.** Everything in the browser build is procedural
and runs at frame rate, so the honest way to make a gameplay trailer is to screen-record it. Use
[the capture shot list](#appendix-a--capture-shot-list-for-real-footage) for that. The prompts below
are for the synthetic case: a mood piece, a pitch visual, or placeholder footage for the landing page
before capture exists.

---

## Ground truth: what the game actually looks like

Feed these constraints to the model, or reject output that breaks them.

| Element       | Reality                                                                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setting       | 4 open-world maps: **Alpine Valley** (mountain loop, forest, lake), **Coastal Highway** (ocean straight, cliffs, beach), **Modern City** (coastal metropolis: a bypass boring through a ridge, downtown avenues crossed by a diagonal, a curving suburb, an airfield with a drivable runway, and a shore road out to a bay with beaches), **Desert Proving Grounds** (dunes, handling circuit, skid pad, speed straight) |
| Vehicles      | 7 **procedurally generated, unbranded** cars: sedan, coupe, off-road, supercar classes. Flat-shaded, low-poly, no manufacturer styling, no badges, no liveries. Selectable paint colours                                                                                                     |
| Camera        | Chase, cockpit, hood and cinematic orbiting camera. The **cockpit has no modelled interior** — no dashboard, wheel or mirrors                                                                                                                                                                |
| World         | Procedural terrain, Catmull-Rom road networks with real cut-and-fill, asphalt and dirt surfaces, procedural road markings, instanced trees/rocks/buildings                                                                                                                                   |
| Structures    | Viaducts with parapets, piers and abutments, and **tunnels bored through intact hillside**, lit from inside by ceiling lamps. Alpine Valley has two of each, Coastal Highway one of each                                                                                                     |
| Desert detail | A solid **jump ramp** beside the dirt dune trail ("Jump Ridge")                                                                                                                                                                                                                              |
| Traffic       | Unbranded, low-poly traffic cars following lanes, stopping at traffic lights at genuine four-way junctions, braking for the player. Parked cars line city kerbs                                                                                                                              |
| Weather       | Clear, overcast, rain, thunderstorm. Rain darkens and **glosses the road**, reduces tyre grip, and lightning is followed by thunder                                                                                                                                                          |
| Time          | Full day/night cycle: sun arc, sky gradient, fog, warm dawn and dusk, **stars at night**, headlights that matter after dark                                                                                                                                                                  |
| Effects       | Skid marks on asphalt, surface-coloured dust plumes, wet-road spray, impact debris                                                                                                                                                                                                           |
| Surfaces      | Asphalt, dirt, gravel, sand, grass — each with different grip. The car is visibly slower and looser on grass                                                                                                                                                                                 |
| HUD           | Speed, gear, RPM, damage percentage, minimap, objective panel, a world map screen, settings, garage                                                                                                                                                                                          |
| Physics       | Real rigid-body simulation on a real heightfield. Cars pitch, roll and settle on suspension                                                                                                                                                                                                  |

**Never show** (the game does not have these, so a trailer that includes them is a false claim):

- Bodywork that dents, crumples or falls off — damage is a **percentage that affects handling only**
- Real car brands, logos, licence plates, or any recognisable production model
- Human characters, drivers, pedestrians or faces
- A modelled interior: no dashboard, steering wheel, mirrors or gauges inside the cockpit
- Puddles, ripples or splashes in the rain; the rain is a visual/audio effect plus a grip change
- Grass blades — ground cover is bushes; the sea is a flat non-colliding plane
- Multiplayer, racing opponents, or a damage model in the HUD sense

---

## Primary prompt — 30-second sizzle trailer

Paste as one prompt if your tool takes a single block; otherwise feed it shot by shot, adding the
previous frame as a style reference so the vehicle and lighting stay consistent.

```text
A 30-second cinematic trailer for a browser 3D driving game called AERODRIVE. Photoreal-adjacent
game-engine render, real-time graphics look: sharp midday light, physically plausible shadows,
slight film grain, no lens flares. All cars are generic, unbranded, low-poly-flat-shaded
procedural vehicles — no manufacturer styling, no badges, no licence plates. No people anywhere in
frame. Camera work is handheld-adjacent but smooth, always low and close to the tarmac, with heavy
speed cues: motion blur on the road surface, dust and gravel kicked from the wheels, depth of field
on the far mountains.

SHOT 1 (0:00–0:04) — Dawn, Alpine Valley. A metal-grey coupe sits at a mountain-pass tunnel mouth,
headlights on, mist in the trees. Camera: slow low dolly from the rear quarter, past the tunnel's
concrete portal ring. Warm orange sun behind ridgelines; long shadows.

SHOT 2 (0:04–0:09) — The car accelerates hard away from the camera into the tunnel. Interior lit by
a row of ceiling lamps receding down the bore. The hill above is intact — the road genuinely runs
through the mountain. Dust puffs from the rear tyres.

SHOT 3 (0:09–0:14) — Cut outside: an aerial pass alongside a concrete viaduct sweeping over a green
valley, piers descending to the ground, a waterfall far below. The same coupe crosses it at speed,
body rolling slightly on its suspension.

SHOT 4 (0:14–0:18) — Coastal Highway, late afternoon. A long straight beside open ocean, sun low and
glinting. Traffic ahead: three unbranded hatchbacks in a lane, brake lights flicking on. Tyre spray
haze on the horizon.

SHOT 5 (0:18–0:22) — Rain. Full thunderstorm on a city street at night. Wet asphalt mirrors the
streetlights and shopfront glow; headlights streak on the surface; rain visibly sheets across the
windscreen line. Traffic waits at a red light at a four-way intersection, then pulls away.

SHOT 6 (0:22–0:27) — Desert Proving Grounds, harsh midday. A dusty off-road 4x4 hits a wooden-framed
jump ramp at speed on a dirt trail and launches clean over a dune crest, sand spraying from all four
wheels, engine screaming, sun flare off the bonnet. Time it slightly slow-motion at the apex.

SHOT 7 (0:27–0:30) — Hard cut to a wide beauty shot: the car drifting through a long corner at dusk,
back end stepping out, skid marks laid dark on the asphalt behind it, sky going violet with the
first stars. Hold on the marks as the car exits frame. Fade to black.

Audio: synthesised engine note rising through gears, tyre scrub, gravel rattle, rain and thunder,
low cinematic drone underneath. No voice-over, no music with lyrics. End on a single low sub-bass hit.
```

**Suggested on-screen text** (only if the tool renders legible text reliably; otherwise add in an
editor): `AERODRIVE` · `Runs in your browser` · `No download`.

**Negative prompt:** deformed wheels, extra wheels, floating cars, warped or duplicated vehicles,
dashboard or steering-wheel interior shots, human figures, brand logos, licence plates, dents or
crushed bodywork, puddles or water reflections in the rain, cartoon or anime styling, text artefacts,
watermarks, flickering geometry.

---

## Shorter cuts

**Six-second hook** — one shot, one idea:

```text
A single 6-second shot: a generic unbranded off-road vehicle launches off a dirt jump ramp in a
desert at golden hour, sand spraying, camera low and tracking beside it, slow-motion at the apex,
hard cut to black on landing. Game-engine render, real-time graphics look, photoreal-adjacent.
No people, no branding.
```

**Fifteen-second social cut** — rain, then speed:

```text
A 15-second vertical-format driving-game clip. Shot 1: heavy rain at night on a city street, wet
asphalt reflecting traffic lights, a low-slung generic sports car accelerating past the camera
through streetlight pools. Shot 2 (cut on the beat): same car in golden-hour mountains, drifting
through a long corner at speed, skid marks trailing. Real-time engine look, unbranded vehicles,
no people, no logos.
```

**Sixty-second feature tour** — the structure of the full trailer, one shot per map, each ending on
the map's name over a wide shot: Alpine Valley (tunnel + viaduct), Coastal Highway (ocean straight),
Modern City (junction with traffic lights at night in the rain), Desert Proving Grounds (jump ramp).

---

## Tool notes

- **Duration.** Most text-to-video models cap at 5–10 s per generation. Generate shot by shot and cut
  in an editor; the shot list above is already divided that way.
- **Consistency.** Reuse one seed and one vehicle description verbatim across shots, and pass the
  last frame of the previous shot as the first frame or style reference where the tool supports it.
  Vehicle drift between shots is the most common defect.
- **Aspect ratio.** 16:9 for a landing page, 9:16 for social — regenerate rather than crop, since a
  crop usually cuts the horizon and the road.
- **Text.** Assume the model will mangle any on-screen text. Add titles in the editor.
- **Audio.** If the tool generates audio, keep it to engine/tyre/weather texture; a generated
  voice-over will invent product claims.

---

## Appendix A — capture shot list for real footage

If you would rather record the actual game (recommended — everything below exists and runs), this is
the same trailer as a capture plan. Start from a saved game, use the cinematic camera for moving
shots and the chase camera for speed, and `F3` to confirm the frame budget.

| Shot | Map                    | What to do                                                                      | Camera                                    |
| ---- | ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| 1    | Alpine Valley          | Spawn at Hollow Vale Garage at 06:30, park at a tunnel mouth with headlights on | Chase, low, slow dolly by hand            |
| 2    | Alpine Valley          | Accelerate through the tunnel and out the other portal                          | Chase                                     |
| 3    | Alpine Valley          | Circle the viaduct on the valley loop, keeping the piers in frame               | Cinematic                                 |
| 4    | Coastal Highway        | Long ocean straight at 17:00 with traffic ahead                                 | Chase                                     |
| 5    | Modern City            | Set Rain or Thunderstorm, 21:00, and drive into a junction as the light turns   | Hood, then cut to a stopped camera        |
| 6    | Desert Proving Grounds | Take the dune trail to the jump ramp and hit it flat out                        | Chase, then Cinematic for the replay feel |
| 7    | Alpine Valley          | Handbrake a long corner at dusk with the day/night cycle running                | Chase, hold after the car leaves frame    |

The in-game clock, weather and presets are all in **Settings**, so none of these shots needs a code
change — and each is reproducible, which is what makes a captured trailer honest.

---

## Why this file exists

The repository's rule is that nothing is claimed without being run. A generated trailer is the one
artefact that can break that rule silently: a model asked for "a driving game trailer" will happily
render crumpling bodywork, a dashboard, and a branded sports car — three things this project does not
have. The ground-truth table and the negative prompts are the guard rails, and they are the parts
worth reading before either a human or a model starts work.
