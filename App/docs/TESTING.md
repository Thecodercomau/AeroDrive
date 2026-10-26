# Testing

## Running the tests

**Window ▸ General ▸ Test Runner ▸ EditMode ▸ Run All**, or:

```bash
Unity -batchmode -projectPath AeroDrive/App \
      -runTests -testPlatform EditMode \
      -testResults results.xml -quit
```

The suite lives in `Assets/Tests/EditMode` and is guarded by `UNITY_INCLUDE_TESTS`, so it is excluded
from player builds automatically.

## What is covered

Five fixtures, chosen so that each one protects a decision that is easy to get wrong and hard to
notice:

| Fixture | Protects |
|---|---|
| `GearboxTests` | Shifting: reverse engagement, the downshift guard, top gear, manual mode, the rev limiter, torque conversion, and `VehicleConfig.Validate`. |
| `BrakeAssistTests` | Braking: the pedal passed through unchanged with no ABS fitted, a locked wheel released while the car is still moving, brakes *not* released at a standstill, and no torque ever invented. |
| `SaveSystemTests` | Loading: range clamping, invalid quality tiers, an empty garage, duplicate ids, corrupt challenge records, and idempotent sanitising. |
| `InputBindingTests` | Rebindable controls: unreadable keys falling back to defaults, unknown actions being dropped, and no action ever ending up with no key. |
| `ChallengeTests` | Rules: medal thresholds, the clock, challenge validity, and stopwatch formatting. |

Two properties are asserted repeatedly because they are the ones that turn into a support burden:

- **Bad data stays playable.** Every save-file test feeds in something invalid and asserts the game
  still has a car it can drive, a control it can press, and a value in range.
- **The gearbox can always be escaped from.** Top gear can be left, neutral can be left, reverse can
  be left, and a steady speed does not shift.

## Why there are no PlayMode tests

Everything worth asserting was put behind a pure function or a ScriptableObject so that it *could* be
tested without a scene. `Gearbox.Step` is the clearest example: the alternative — driving a car in
play mode and asserting on its velocity — would be slower, flakier, and would test the physics engine
as much as the transmission.

The gap this leaves is real and is listed in [KNOWN-ISSUES.md](KNOWN-ISSUES.md): nothing here proves
that `VehicleController` applies the gearbox's output correctly, or that a wheel collider is
configured with the right radius.

## Verifying by hand

Since the physics application layer is untested, the manual checks below are the ones that catch a
regression in it. Run them after any change to `VehicleController` or `VehicleConfig`:

1. **Standing start.** From rest, full throttle. The car should pull away, change up through the
   gears, and hold a straight line. A car that revs to the limiter without moving has its torque
   applied to the wrong wheel, or `ApplyMotorTorque` has lost its radius conversion.
2. **Reverse.** Brake to a complete stop, keep holding. The gear indicator should read `R` and the car
   should move *backwards*. Moving forwards in `R` means the reduction lost its sign.
3. **Top gear.** Accelerate to top speed, then lift off and let the car coast down. It must change
   down. If it stays in top gear, the downshift guard is looking at the wrong gear.
4. **Brake and steer.** At 100 km/h, brake hard and turn. The car should slow *and* turn. A car that
   ploughs straight on has its brake torque locking the wheels.
5. **Hold on a slope.** Facing uphill, brake to a stop and keep holding. The car must stay put. A car
   that creeps backwards has ABS releasing the brakes because the wheels are not turning — see
   `BrakeAssist`.
6. **Recovery.** Drive into a wall and hold the throttle. After `stuckTimeout` the car should return
   to a nearby road point, upright and in neutral.
7. **Pause.** Pause while holding the throttle, wait, unpause. The car must not lurch — if it does,
   the input source is not being cleared while paused.
8. **Save.** Change a setting, quit to the main menu, reload. The setting, the selected car and the
   challenge records must all survive.
