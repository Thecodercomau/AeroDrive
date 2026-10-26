# Known issues, gaps and unverified claims

This file is the honest state of the native build. Anything here should be read as "do not assume
this works" rather than "this is a nice-to-have".

## Unverified

- **Nothing is exercised outside the EditMode suite.** The code does compile — Unity 6000.6.5f1
  imports the project, builds 242 scripts with no compiler errors or warnings, and runs the EditMode
  suite to a green 64/64 — but the assertions all live in that suite, which is pure functions and
  data, and none of it touches a scene.
- **No PlayMode test, and no player build, has ever been produced.** `BuildScript` compiles against
  Unity's build API but no player has been built with it. Nothing therefore proves that
  `VehicleController` drives a Rigidbody correctly in a running game, that the wheel colliders are
  configured with the right radii, or that the HUD renders. See [TESTING.md](TESTING.md) for the
  manual checks that stand in for those tests.
- **No frame rate has been measured.** `docs/PERFORMANCE.md` does not exist for this build, because
  there is nothing to measure yet: there is no content to render.

## Missing content

- **No scenes, prefabs or models are committed.** The playground scene is generated from code. There
  is no car body art, no environment art, and no hand-built challenge route.
- **No world.** There is no road network, no terrain and no traffic. `GameRoot` and the vehicle work
  with the generated ground plane and nothing else. The browser build (`../Web`) has all three; that
  code is JavaScript and does not port mechanically.
- **No front end.** The main menu, settings menu and garage screen exist as controllers
  (`SessionController`, `GarageController`) with no UI built for them. The HUD is the only screen.
- **No audio mixer asset.** `GameRoot.audioMixer` is optional and is null by default, so the per-channel
  volume sliders in the settings have nothing to drive until one is created and assigned.
- **No vehicle select or paint UI**, though `GarageController` supports both.
- **`BuildScript` has never produced a build.** It is written against Unity's build API and exits with
  a status code, but no player has been built from it. If it fails, the exit code is the thing CI will
  read, so check it before trusting a green build.

## Known weaknesses in what does exist

- **ABS is an approximation.** `BrakeAssist` drops a wheel's brake torque to a quarter when that wheel
  has stopped turning while the car is still rolling, which prevents a full lock-up but is not a real
  ABS loop — there is no per-wheel pressure modulation and no pump-back. A car under heavy braking
  will still understeer more than it should.
- **Traction control reads wheel RPM against road speed**, which is a one-line approximation of
  slip. It is stable, but it will intervene slightly early on a grippy surface and slightly late on a
  loose one.
- **Damage is irreversible.** Passing `criticalDamage` disables the engine permanently until the
  garage repairs it. There is no limp-home mode and no gradual power loss before the threshold.
- **`VehicleController.Recover` raycasts straight down** from three metres up. Over a bridge, a
  tunnel or a canyon this can place the car on the wrong surface — the raycast has no notion of
  "the road the car was on".
- **The engine note is a static harmonic series.** Cylinder count changes the harmonic spacing, but
  the note does not gain the roughness a real engine has under load. It reads as an engine at a
  distance, not one under the bonnet.
- **`RenderScale` depends on dynamic resolution**, which some platforms and cameras do not support.
  Where it is unsupported the setting silently does nothing rather than being greyed out in a menu
  that does not exist yet.
- **`VehicleSetupWizard.CreatePlaygroundScene` creates the scene additively** and leaves it open next
  to whatever was already loaded. That is intentional — it never overwrites unsaved work — but it
  does mean the editor has two scenes open immediately afterwards.

## Design decisions that might look like bugs

- **Reverse is the brake pedal from a standstill.** There is no separate reverse control. Holding the
  brake below a walking pace engages reverse, and the same pedal then drives it. This is a decision,
  not an oversight; see the README.
- **The car recovers itself** after being upside down or wedged. There is no prompt. If that feels
  wrong for a challenge, `ChallengeRunner.strayTimeout` and `VehicleController.stuckTimeout` are the
  knobs.
- **`VehicleInput` merges keyboard and gamepad rather than switching between them.** A pad nudged by
  accident must not take the keyboard away from the player.
