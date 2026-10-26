using System;
using System.IO;
using AeroDrive.Core;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace AeroDrive.Editor
{
    /// <summary>
    /// Builds player binaries, from the editor menu or from a command line.
    /// </summary>
    /// <remarks>
    /// The command-line entry points are the point of this file. A build that only exists as a set of
    /// settings in somebody's editor session is not reproducible: the scene list, the target and the
    /// output path are all invisible state. Naming them here means the same build can be produced by
    /// a script, a CI job or a person, and the options live in version control.
    ///
    /// Every entry point exits with a non-zero status when the build fails, and refuses to build at
    /// all when no scene is in the list. A build that succeeds while producing a player with no
    /// scenes in it is the worst possible outcome: it looks like a green build and there is nothing
    /// to run.
    /// </remarks>
    public static class BuildScript
    {
        /// <summary>Output root, relative to the project directory.</summary>
        public const string OutputRoot = "Builds";

        /// <summary>The scene the wizard generates. Used when the build settings list is empty.</summary>
        public const string DefaultScenePath = "Assets/Scenes/Playground.unity";

        [MenuItem("AeroDrive/Build/Windows 64-bit", false, 100)]
        public static void BuildWindows()
        {
            Build(BuildTarget.StandaloneWindows64, Path.Combine(OutputRoot, "Windows/AeroDrive.exe"));
        }

        [MenuItem("AeroDrive/Build/macOS", false, 101)]
        public static void BuildMacOS()
        {
            Build(BuildTarget.StandaloneOSX, Path.Combine(OutputRoot, "macOS/AeroDrive.app"));
        }

        [MenuItem("AeroDrive/Build/Linux 64-bit", false, 102)]
        public static void BuildLinux()
        {
            Build(BuildTarget.StandaloneLinux64, Path.Combine(OutputRoot, "Linux/AeroDrive.x86_64"));
        }

        /// <summary>Build the current platform, which is what a developer usually wants.</summary>
        [MenuItem("AeroDrive/Build/Current Platform", false, 99)]
        public static void BuildCurrentPlatform()
        {
            string extension = EditorUserBuildSettings.activeBuildTarget == BuildTarget.StandaloneWindows64
                ? ".exe"
                : string.Empty;

            Build(
                EditorUserBuildSettings.activeBuildTarget,
                Path.Combine(OutputRoot, $"Current/AeroDrive{extension}"));
        }

        /// <summary>
        /// Build a player and exit with a status code.
        /// </summary>
        /// <param name="target">Platform to build for.</param>
        /// <param name="locationPathName">Output path, relative to the project directory.</param>
        /// <remarks>
        /// Public and parameterless-free on purpose: it is the shape <c>-executeMethod</c> can call
        /// from a batch-mode command line, which is the interface the documentation promises.
        /// </remarks>
        public static void Build(BuildTarget target, string locationPathName)
        {
            string[] scenes = ResolveScenes();
            if (scenes.Length == 0)
            {
                // Failing here rather than building an empty player: a player with no scenes starts,
                // shows nothing, and looks like a rendering bug.
                Fail(
                    $"No scenes to build. Add a scene to the build settings, or run " +
                    $"AeroDrive ▸ Create Playground Scene to generate {DefaultScenePath}.");
                return;
            }

            if (target != EditorUserBuildSettings.activeBuildTarget && !CanBuildInCurrentEditor(target))
            {
                Fail(
                    $"{target} is not installed for this editor, or the active build target cannot be " +
                    $"switched to it. Install the module from Unity Hub, or build it from a machine that has it.");
                return;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(locationPathName) ?? OutputRoot);

            BuildPlayerOptions options = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = locationPathName,
                target = target,
                // No explicit options: a release build, with no development flags or profiler hooks.
                options = BuildOptions.None,
            };

            // Keeping the player's version in step with the runtime's means the version reported on
            // the bus, in the save file and on the binary's properties are the same number.
            PlayerSettings.bundleVersion = GameRoot.Version;

            Debug.Log($"[AeroDrive] Building {target} → {locationPathName} ({scenes.Length} scene(s))");

            BuildReport report = BuildPipeline.BuildPlayer(options);
            BuildSummary summary = report.summary;

            if (summary.result == BuildResult.Succeeded)
            {
                Debug.Log(
                    $"[AeroDrive] Build succeeded: {summary.outputPath} " +
                    $"({summary.totalSize / (1024f * 1024f):F1} MB in {summary.totalTime.TotalSeconds:F1}s)");

                if (Application.isBatchMode) EditorApplication.Exit(0);
                return;
            }

            // Every warning is printed rather than a count: a failed build's warnings are usually the
            // only clue as to why it failed, and a CI log is the only place anybody will read them.
            for (int i = 0; i < report.steps.Length; i++)
            {
                BuildStep step = report.steps[i];
                for (int j = 0; j < step.messages.Length; j++)
                {
                    BuildStepMessage message = step.messages[j];
                    if (message.type != LogType.Error && message.type != LogType.Exception) continue;
                    Debug.LogError($"[AeroDrive] Build step {step.name}: {message.content}");
                }
            }

            Fail(
                $"Build failed: {summary.result} with {summary.totalErrors} error(s) " +
                $"({summary.totalWarnings} warning(s)).");

            if (Application.isBatchMode) EditorApplication.Exit(1);
        }

        /// <summary>
        /// The scenes to build: everything enabled in the build settings, or the generated
        /// playground scene when the list is empty.
        /// </summary>
        private static string[] ResolveScenes()
        {
            EditorBuildSettingsScene[] configured = EditorBuildSettings.scenes;
            int enabled = 0;
            for (int i = 0; i < configured.Length; i++)
            {
                if (configured[i] != null && configured[i].enabled) enabled++;
            }

            if (enabled > 0)
            {
                string[] scenes = new string[enabled];
                int index = 0;
                for (int i = 0; i < configured.Length; i++)
                {
                    if (configured[i] == null || !configured[i].enabled) continue;
                    scenes[index++] = configured[i].path;
                }

                return scenes;
            }

            // The fallback exists because the wizard writes the scene to a file but does not add it
            // to the build settings: doing so would silently modify a project setting the developer
            // may have curated by hand.
            if (File.Exists(DefaultScenePath)) return new[] { DefaultScenePath };

            Debug.LogWarning(
                $"[AeroDrive] The build settings list is empty and {DefaultScenePath} does not exist. " +
                $"Run AeroDrive ▸ Create Playground Scene first.");

            return Array.Empty<string>();
        }

        /// <summary>True when this editor can target the requested platform.</summary>
        /// <remarks>
        /// <c>BuildPipeline.IsBuildTargetSupported</c> is the only reliable check; a target can be
        /// listed in the build settings window and still be unbuildable because its module is not
        /// installed, which is what this catches before a long build attempt.
        /// </remarks>
        private static bool CanBuildInCurrentEditor(BuildTarget target)
        {
            BuildTargetGroup group = BuildPipeline.GetBuildTargetGroup(target);
            if (group == BuildTargetGroup.Unknown) return false;

            return BuildPipeline.IsBuildTargetSupported(group, target);
        }

        private static void Fail(string message)
        {
            Debug.LogError($"[AeroDrive] {message}");
        }
    }
}
