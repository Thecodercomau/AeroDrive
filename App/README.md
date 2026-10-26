# AeroDrive — Unity Application

The native build of AeroDrive: a driving sandbox written in C# for Unity 6.3 LTS. This is the
project you open in the Unity Editor.

> **Status: scaffold.** The runtime systems — save file, input, vehicle physics, gearbox,
> challenges, garage, audio, HUD — are complete and covered by EditMode tests. **The content is
> not**: there are no hand-built scenes, no car models, and no road network committed to this
> repository. A working playground scene is generated from the code by a menu item, and the browser
> build next door (`../Web`) is the one that is playable end to end today.
>
> The code compiles and its tests pass: Unity 6000.6.5f1 imports the project, builds all four
> assemblies with no compiler errors or warnings, and runs the EditMode suite to a green 64/64. What
> has never happened is the game *running* — no player build exists, there are no PlayMode tests, and
> no scene is committed, so the physics application layer is unexercised. See
> [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) and [docs/SETUP.md](docs/SETUP.md#first-open).

## Requirements

| | |
|---|---|
| Unity | **6000.6.5f1**. `ProjectSettings/ProjectVersion.txt` pins it, and `Packages/manifest.json` needs modules that older 6000.3 patch releases do not ship; a newer 6000.6 patch is fine, a different major version is not. |
| Packages | All in `Packages/manifest.json` — uGUI, Test Framework, Rider/Visual Studio integration, and built-in modules only. No third-party packages. |
| Platforms | Windows, macOS, Linux. The input layer uses the legacy Input Manager, which is available everywhere. |

There are no assets to download. The engine note, tyre scrub and impact sounds are **synthesised at
runtime** (`EngineAudio`), which is why the repository contains no audio files and no licences to
track.

## Getting it running

1. Open `AeroDrive/App` with Unity 6000.3.
2. `AeroDrive ▸ Create Playground Scene`.
   This creates the three default `VehicleConfig` assets, the `VehicleCatalog`, and a scene with a
   car, chase camera, HUD, audio and ground.
3. Press **Play**.

The scene lives at `Assets/Scenes/Playground.unity` and is generated, not hand-authored — re-running
the menu item is always safe. See [docs/SETUP.md](docs/SETUP.md) for the details and for the build
instructions.

## Controls

| Action | Default | Action | Default |
|---|---|---|---|
| Accelerate | `W` / `↑` | Change camera | `C` |
| Brake and reverse | `S` / `↓` | Recover vehicle | `R` |
| Steer left / right | `A` `D` / `←` `→` | Headlights | `H` |
| Handbrake | `Space` | Horn | `F` |
| Upshift / downshift | `Left Shift` / `Left Ctrl` | Pause | `Esc` |

Every one of these is rebindable, and stored in the save file. See
`Assets/Scripts/Input/InputBindings.cs`.

**Reverse is the brake pedal.** Brake to a stop and keep holding: once the wheels have essentially
stopped, the same pedal engages reverse and then drives it. That is deliberate — it means one pedal
does "slow down, stop, back up", which is what a player expects in a game without a gear lever.

Keyboard steering and pedals are **ramped**, not switched. A throttle that goes from 0 to 100% in
one frame makes a 1400 kg car feel like it is being launched, and no amount of physics tuning fixes
that.

## Layout

```
App/
├── Assets/
│   ├── Editor/           VehicleSetupWizard — generates assets and the playground scene
│   ├── Scripts/
│   │   ├── Core/         EventBus, GameRoot (bootstrap), SessionController, GameEvents
│   │   ├── Input/        Rebindable keyboard/pad input behind IVehicleInputSource
│   │   ├── Missions/     ChallengeDefinition, Checkpoint, ChallengeRunner
│   │   ├── Presentation/ ChaseCamera, Hud, EngineAudio, RenderScale
│   │   ├── SaveSystem/   SaveFile, GameSettings, PlayerProgress, SaveManager
│   │   └── Vehicles/     VehicleConfig, VehicleController, Gearbox, BrakeAssist, Garage, Catalog
│   └── Tests/EditMode/   NUnit tests for the gearbox, brakes, save system, input and challenges
├── Packages/manifest.json
└── ProjectSettings/
```

## Testing

Run the EditMode suite with **Window ▸ General ▸ Test Runner ▸ EditMode ▸ Run All**, or from the
command line:

```bash
Unity -batchmode -projectPath AeroDrive/App \
      -runTests -testPlatform EditMode \
      -testResults results.xml -quit
```

There are no PlayMode tests: everything worth asserting is behind a pure function or a ScriptableObject
precisely so that it can be tested without a scene. See [docs/TESTING.md](docs/TESTING.md) for what
is and is not covered.

## Where to go next

- [docs/SETUP.md](docs/SETUP.md) — first open, generating content, building
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the systems fit together, and why
- [docs/TESTING.md](docs/TESTING.md) — the test suite and its blind spots
- [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) — what is missing, unfinished or unverified
