# Setup

## First open1. Install **Unity 6000.6.5f1** through Unity Hub — that is the version in
   `ProjectSettings/ProjectVersion.txt`. Use it: `Packages/manifest.json` declares modules
   (`com.unity.modules.physicscore2d`, `tetgen`, `timelinefoundation`) that older 6000.3 patch
   releases do not ship, and opening with one of those fails package resolution rather than
   importing. Any 6000.6 patch should be fine; a different major version will import the project but
   may rewrite `ProjectSettings`, so commit that change deliberately or not at all.
2. **Add ▸ Add project from disk ▸** select `AeroDrive/App`.
3. Let the first import finish. The editor creates `Library/`, `Logs/` and `Temp/`, all of which are
   ignored by `.gitignore`; the first import of a fresh clone takes a minute or two.

### The project compiles clean

It was built from a Unity installation in batch mode before it was committed: import, script
compilation (242 scripts, no compiler errors and no warnings) and the whole EditMode suite, which
passes — see [TESTING.md](TESTING.md). So there is nothing to fix on first open.

If you do hit an error, the four shapes below are the ones the code was written to avoid, and they
are the ones to check first:

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `The type or namespace name 'Text' could not be found` | uGUI assembly not referenced | The reference is declared in `Assets/Scripts/AeroDrive.Runtime.asmdef`; if the package is missing, let the Package Manager resolve `com.unity.ugui`. |
| Editor script cannot see a runtime type | Missing asmdef reference | `Assets/Editor/AeroDrive.Editor.asmdef` lists `AeroDrive.Runtime`. |
| `MenuItem` / `EditorSceneManager` not found in a non-editor file | A script that uses UnityEditor landed outside `Assets/Editor` | Move it; the editor assembly is platform-restricted to the Editor. |
| `Rigidbody.linearVelocity` not found | Unity older than 2023.3 | This project targets Unity 6, where `velocity` was renamed. Upgrade the editor rather than the code. |

Fix anything that does appear in place, note it in the commit message, and update this section if a
pattern emerges.

## Generating the content

The repository deliberately ships no scenes and no prefabs: a scene file is a large binary-ish
document that drifts out of step with the code silently, and a broken reference on a prefab is
invisible until the game is run. Instead the content is generated from the same data the game uses.

### AeroDrive ▸ Create Default Vehicles

Creates `Assets/Vehicles/`:

- `Hatchback.asset` — front-wheel drive, 1080 kg, unlocked from the start
- `Sedan.asset` — rear-wheel drive, 1420 kg, unlocked from the start
- `SportsCoupe.asset` — rear-wheel drive, 1290 kg, unlocked by finishing a challenge
- `VehicleCatalog.asset` — the list of cars and their unlock rules

Every value in these assets is editable in the Inspector, and the wizard is idempotent: run it again
to refresh them without creating duplicates.

Each car's `torqueCurve` is authored from one shared shape scaled to its torque peak and redline, so
cars differ in character without anyone opening a curve editor. `VehicleConfig.Validate` repairs
values that would break the simulation — a centre of mass outside the chassis, a redline below idle,
an empty gear list — and runs automatically in `OnValidate` as well as from the wizard.

### AeroDrive ▸ Create Playground Scene

Creates `Assets/Scenes/Playground.unity` containing:

- `AeroDriveRoot` — the `GameRoot`, which owns the event bus and the save file and survives scene loads
- `PlayerCar` — a rigidbody, a chassis collider sized from the config, four wheel colliders placed by
  the config's wheelbase and track, and the `VehicleController`
- `ChaseCamera` — the camera rig and the scene's `AudioListener`
- `Hud` — a canvas with speed, gear, revs, timer, camera mode and message widgets wired up
- `VehicleAudio` — engine, low-frequency, tyre, wind and effects sources
- `Session` — the `SessionController`, wired to all of the above
- `Ground` and `Sun` — a plane and a directional light so the scene is not black

The scene is written to a new file rather than over whatever is open, and the new scene is made
active before anything is created so every object lands in it.

## Builds

From the editor, either **File ▸ Build Settings ▸ Build**, or **AeroDrive ▸ Build ▸ Windows 64-bit /
macOS / Linux 64-bit / Current Platform**.

From the command line:

```bash
Unity -batchmode -nographics -quit \
      -projectPath AeroDrive/App \
      -executeMethod AeroDrive.Editor.BuildScript.BuildWindows \
      -logFile build.log
```

Swap `BuildWindows` for `BuildMacOS`, `BuildLinux` or `BuildCurrentPlatform`. Output goes to
`Builds/<platform>/`, and the process exits non-zero when the build fails, so a CI job can read the
status without parsing the log.

`BuildScript` resolves the scene list from the build settings. If that list is empty it falls back to
`Assets/Scenes/Playground.unity`, and if neither exists it **fails** rather than producing a player
with no scenes in it. It does not add the generated scene to the build settings for you: that would
silently edit a project setting you may have curated by hand. Add it yourself the first time you want
more than one scene shipped.

`BuildWindows` and friends are the parameterless entry points `-executeMethod` needs. The general
form, `BuildScript.Build(BuildTarget, locationPathName)`, is public if you want to script a build of
several platforms in one editor session.

### Player settings worth checking before a first build

- **Active Input Handling** must be *Input Manager (Old)* or *Both*. If it is *Input System Package
  (New)*, `KeyboardInputSource` receives nothing and the car will not move. The fix is either the
  player setting or a new `IVehicleInputSource` for the new system — the vehicle controller does not
  need to change, which is why the interface exists.
- **Graphic APIs** — the built-in render pipeline is fine. `RenderScale` uses dynamic resolution,
  which is the built-in pipeline's mechanism; on a platform that does not support it, the calls are
  no-ops and the full resolution is used.
- **Colour space** — Linear is strongly preferred. The paint colours in the vehicle configs are
  authored for it.

## Where the save file lives

`Application.persistentDataPath/aerodrive-save.json`:

| Platform | Path |
|---|---|
| Windows | `%USERPROFILE%\AppData\LocalLow\<Company>\AeroDrive\` |
| macOS | `~/Library/Application Support/<Company>/AeroDrive/` |
| Linux | `~/.config/unity3d/<Company>/AeroDrive/` |

Delete it to reset all progress, settings and unlocks. The file is plain JSON and is safe to inspect;
`SaveFile.Sanitise` is written to make a load succeed even if it has been edited into something
invalid.
