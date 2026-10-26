# Diagnostic tools

Standalone Node scripts, run by hand. They are not part of the build and not part of the test
suite — they exist because a few bugs could only be found by asking a real physics engine or a
real browser a question directly, and re-deriving those answers later would be wasteful.

Run them from the `Web/` directory. The `debug-e2e-*` scripts and `debug-spawn.mjs` need a
running preview server:

```bash
npm run build
npm run preview        # leave running in another terminal, port 4173
node tools/debug-drive.mjs
```

## Physics engine questions (no browser needed)

These test assumptions about Rapier directly. Each one settles a question that is easy to get
wrong and hard to debug from the symptom.

| Script                          | Question it answers                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug-force-persistence.mjs`   | Does `addForce` persist across steps? **Yes** — it must be reset every frame, or drag and rolling resistance accumulate and the car accelerates to absurd speeds on its own.                                                                                                                                                                                                                                                      |
| `probe-torque-accumulation.mjs` | Does `addTorque` persist across steps, and does `resetForces` clear it? **It persists, and `resetForces` does not clear it** — user forces and user torques are separate accumulators. Resetting only the forces let the per-step stability assist build up to ~30 kN·m of yaw torque, which drove the car into a 6.7 rad/s pirouette with the steering centred. `resetTorques` has to be called beside `resetForces` every step. |
| `debug-brake-sign.mjs`          | What sign does the brake impulse take, and what does a negative engine force do? Used to get reverse driving the right way.                                                                                                                                                                                                                                                                                                       |
| `debug-braking.mjs`             | How much braking force actually stops the car, and how does it interact with the suspension load?                                                                                                                                                                                                                                                                                                                                 |
| `debug-heightfield*.mjs`        | What exactly does `ColliderDesc.heightfield` expect, and which axis varies fastest in the heights array? Answer: `heights[iz + ix * (resolution + 1)]` — **Z varies fastest**. Getting this backwards transposes the entire landscape.                                                                                                                                                                                            |
| `probe-heightfield-sides.mjs`   | Can a road run _under_ a heightfield? **Yes.** A body below a heightfield surface is not pushed out, and a body resting on a road under 11 m of heightfield is completely stable. This is the answer that makes a real tunnel possible — without it, a tunnel could only ever be a cut-and-cover shell lying in an open trench.                                                                                                   |

## Map authoring

| Script                        | Question it answers                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect-structures.mjs`      | Where would a bridge or a tunnel land on each road, and how deep is the gap or the cover if it did? Prints the best window the resolver can find per road, with its score, plus the reason when it refuses. Run it after moving a road or adding a landform (`node tools/inspect-structures.mjs [mapId]`).                                                                                                                                                    |
| `probe-road-connectivity.mjs` | Does every named place have a road to it? Joins roads whose asphalt actually meets, then reports how many separate pieces the network is in, which landmark or spawn point sits on a piece nothing reaches, and how far each stranded piece is from the nearest road in the network. Run it after moving a road or a spawn point, or after adding either (`node tools/probe-road-connectivity.mjs [mapId]`). It exits non-zero when something is unreachable. |

## Browser questions (need the preview server)

| Script                | Question it answers                                                                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug-e2e-input.mjs` | Where does the input pipeline break? Dumps the pressed-key set, the sampled control state, per-wheel contact/force/suspension, the body's linear velocity and the terrain height — it is what located "only one wheel has contact, so the car cannot move". |
| `debug-spawn.mjs`     | What does the terrain around a spawn point actually look like? Prints a height profile grid, the chassis half-extents, the suspension geometry, wheel contact and a raycast, so spawn placement can be judged from numbers instead of a screenshot.         |
| `debug-drive.mjs`     | How does a car behave over time from a spawn? Samples speed, RPM, gear, surface, position and height above ground every second.                                                                                                                             |
| `debug-fps.mjs`       | What is the frame time made of? Reports frame rate, frame time, and CPU time split between simulation and rendering.                                                                                                                                        |

## Test fixtures

| Script           | What it is for                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve-dist.mjs` | Serves `dist/` under a URL prefix, so the GitHub-Pages shape (`/<repo>/`) can be exercised locally. `vite preview` only ever serves at the root, which is the one case a deployment never faces. The browser suite starts it on port 4174 for `tests/e2e/subpath.spec.js`; run it by hand with `node tools/serve-dist.mjs --port 4174 --mount /aerodrive/`. It refuses requests outside the mount, so an absolute asset path in the bundle fails loudly. |

## A caveat on the browser scripts

They launch Chromium with `--use-angle=swiftshader`, i.e. software WebGL, because there is no GPU
in the development environment. Frame rates reported by `debug-fps.mjs` are therefore **not**
representative of real hardware — the useful number there is the simulation time, not the frame
rate. See [`../docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).
