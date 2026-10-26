# Architecture

## The shape of the thing

Six namespaces, each with one job. The dependency direction is deliberate and one-way at each step,
which is what keeps a change to the gearbox from reaching the HUD.

```
Core ──────────► EventBus, GameRoot, SessionController, GameEvents
  │
  ├─► SaveSystem ──► SaveFile, GameSettings, PlayerProgress, SaveManager
  ├─► Input ───────► IVehicleInputSource, VehicleInput, KeyboardInputSource, ...
  ├─► Vehicles ────► VehicleConfig, Gearbox, VehicleController, Garage, Catalog
  ├─► Missions ────► ChallengeDefinition, Checkpoint, ChallengeRunner
  └─► Presentation ► ChaseCamera, Hud, EngineAudio, RenderScale
```

`Core` is the only namespace the others may all reference. `Vehicles` does not know about
`Missions`; `Missions` reads a `VehicleController` and nothing more. `Presentation` reads everything
and is read by nothing — a HUD that something depends on is a HUD that cannot be deleted.

## GameRoot and the event bus

`GameRoot` is the single object that survives a scene load. It owns the `EventBus` and the
`SaveManager`, loads the save file before anything else runs (`[DefaultExecutionOrder(-1000)]`), and
publishes `GameReady`.

Everything else is a *participant*: created when a scene loads, given what it needs, destroyed when
the scene unloads. That is what makes "return to the main menu" a scene load rather than a careful
teardown of a dozen singletons in the right order.

The bus carries structs only, so publishing never allocates, and the full set of events is readable
in one file (`GameEvents.cs`). It is deliberately small — no priorities, no cancellation, no string
keys. If an event needs any of those, a direct reference is probably the better design.

## The vehicle

### VehicleConfig is the car

Mass, centre of mass, chassis size, drag, drivetrain, gear ratios, torque curve, suspension, tyre
grip, steering, brakes, assists, damage sensitivity, paint, cylinder count. All data, all in a
ScriptableObject, all with tooltips and units.

The test for "does this belong in the config" is simple: if making a car handle differently requires
typing a number into `VehicleController.cs`, that number is in the wrong file. `VehicleConfig.Validate`
repairs values that would break the simulation, and is called from `OnValidate` so a mistake shows up
in the Inspector rather than on the road.

### The gearbox is a pure function

```
Gearbox.Step(ref state, wheelAngularVelocity, throttle, brake, shiftUp, shiftDown, dt, config)
    → { gear, rpm, shifting, torque, reduction }
```

No Rigidbody, no Transform, no MonoBehaviour. This is the single most valuable structural decision in
the project: it means every shifting rule — reverse engaging only from a standstill, the downshift
that must not hunt, the top gear that must be leavable — is an EditMode test that runs in
milliseconds with no scene. It also means the rules are portable, and the same ones are implemented
in the browser build (`../Web/src/vehicles/gearbox.js`).

Three of those rules exist because they were wrong once:

- **Reverse is requested by the brake pedal from any gear**, guarded by a wheel-speed check. An early
  version required neutral first, which in a real session — where the car is already in first — left
  reverse permanently unreachable.
- **The downshift guard looks at the gear *below*.** Looking at the gear above made top gear
  impossible to leave, because that is where the driver is trying to go.
- **Reverse carries a sign through the reduction.** Without it a car in reverse accelerates forwards.

### VehicleController applies, and does not decide

It reads input, steps the gearbox, and applies the result to four `WheelCollider`s. It never adjusts
a tuning value and never invents torque. The assists (traction control, stability assist, ABS) can
only ever *reduce* what the driver asked for — an assist that adds torque makes a car feel possessed.

The one assist with rules of its own is ABS, and those rules live in `BrakeAssist` as a pure function
for the same reason `Gearbox` does. `BrakeAssist.ServiceBrake(requested, wheelRpm, speedKmh,
absEnabled)` decides what a wheel actually gets, and the two mistakes it exists to prevent are worth
naming: releasing the brake because a wheel is not turning (a wheel at zero RPM while the *car* is
stopped has not locked, and cutting the torque there means the car cannot be held on a slope), and
deciding a lock-up from the drive torque rather than from the road speed.

Notable choices in the application layer:

- **Ackermann steering**, so the inner wheel turns tighter than the outer one and the tyres roll
  rather than scrub.
- **Speed-sensitive steering falloff**, without which a light car spins on the spot at 100 km/h.
- **Downforce and quadratic drag applied as forces**, so terminal velocity is a consequence of the
  config rather than an arbitrary clamp.
- **Automatic recovery** after being upside down or wedged, because being stuck is a normal outcome
  on rough ground and hunting for a menu is not the way out of it.

## Session lifecycle

```
GameRoot.Awake            load save, apply settings, publish GameReady
  └─ SessionController.StartSession
        ├─ build VehicleInput from the saved bindings
        ├─ move the car to its spawn point
        ├─ bind the chase camera, the HUD and the engine audio
        └─ publish SessionStarted
  └─ per frame: session commands (pause, camera, recover, headlights), then autosave ticks
  └─ EndSession           bank play time, publish SessionEnded
```

Pausing stops time *and* disables input. Stopping time alone is not enough: the keyboard's throttle
ramp integrates over time, so a player who lets go while paused would resume at full throttle.

## Save system

One JSON file through `JsonUtility`, because it is one format that works identically on every
platform Unity supports and needs no third-party dependency. Three properties matter:

- **Never throws.** A missing, unreadable, hand-edited or truncated file leaves the game running on
  defaults. Failing to load a save must never stop somebody playing.
- **Atomic writes.** The file is written to `*.tmp` and moved into place, so a crash mid-write cannot
  destroy a good save.
- **Sanitise, don't trust.** `SaveFile.Sanitise` clamps every value, drops unknown bindings, and
  restores the starter cars if the garage came back empty. A player with no car and no way to get one
  is a state the game must be unable to reach.

## Presentation

The camera is the biggest contributor to how fast a car feels, and almost all of that comes from
three things: a field of view that widens with speed, a heading that lags the car so acceleration is
visible, and a pull-back under braking. All three are in `ChaseCamera`, and everything there is
damped — an undamped chase camera turns every gear change into a jolt.

`EngineAudio` **synthesises** the engine note rather than playing a sample: a looping harmonic series
per cylinder count, retuned by `AudioSource.pitch` from the actual RPM. A sampled engine has to be
pitch-shifted across a 6000 RPM range and drifts out of tune with the tachometer; a synthesised one
cannot. It also means the repository ships with no audio assets and no licences.

## What is deliberately absent

- **No singletons beyond `GameRoot`.** Static mutable state is what makes a scene unloadable.
- **No Addressables, no DI container, no reactive framework.** The project's dependencies are the
  engine, uGUI and the test framework. Everything above is a few hundred lines of plain C#.
- **No world generation.** `../Web` has a procedural road network and terrain; this build does not,
  and porting it is the next substantial piece of work rather than something half-present here.
