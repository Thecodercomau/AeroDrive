using System;
using System.Collections.Generic;
using UnityEngine;

namespace AeroDrive.SaveSystem
{
    /// <summary>
    /// Graphics quality tiers. Kept as an enum so the value can never be a string that nobody
    /// recognises after a save file has been hand-edited.
    /// </summary>
    public enum QualityTier
    {
        Potato = 0,
        Low = 1,
        Medium = 2,
        High = 3,
    }

    /// <summary>
    /// Everything the player can change in the settings menu.
    /// </summary>
    /// <remarks>
    /// Plain serializable fields rather than properties: <see cref="JsonUtility"/> only serialises
    /// fields, and using it means one save format that works identically on every platform Unity
    /// supports, with no third-party dependency.
    /// </remarks>
    [Serializable]
    public class GameSettings
    {
        /// <summary>Bumped whenever the shape changes, so old files can be migrated.</summary>
        public int version = CurrentVersion;

        public const int CurrentVersion = 1;

        // --- Graphics -------------------------------------------------------
        public QualityTier quality = QualityTier.Low;
        public float renderScale = 1f;
        public float viewDistance = 800f;
        public bool shadows = true;
        public int shadowDistance = 80;
        public int targetFrameRate = 60;
        public bool vSync = true;
        public bool showPerformanceOverlay;

        // --- Audio ----------------------------------------------------------
        public float masterVolume = 0.8f;
        public float engineVolume = 0.75f;
        public float ambienceVolume = 0.5f;
        public float effectsVolume = 0.7f;

        // --- Controls -------------------------------------------------------
        /// <summary>
        /// Keyboard chords, one entry per action, encoded as <see cref="KeyCode"/> names.
        /// </summary>
        /// <remarks>
        /// Stored as strings because <see cref="JsonUtility"/> does not serialise dictionaries and
        /// an array of key/value pairs survives a version change better than parallel arrays.
        /// </remarks>
        public BindingEntry[] bindings = Array.Empty<BindingEntry>();

        public float mouseSensitivity = 1f;
        public float gamepadDeadzone = 0.12f;
        public bool invertCameraY;

        /// <summary>Return a fresh set of defaults. Never returns null.</summary>
        public static GameSettings CreateDefault()
        {
            GameSettings settings = new GameSettings();
            settings.bindings = Input.InputBindings.CreateDefaultEntries();
            return settings;
        }

        /// <summary>
        /// Coerce whatever was loaded into something usable.
        /// </summary>
        /// <remarks>
        /// A save file is untrusted input: it may be truncated, hand-edited, written by a newer
        /// build, or all zeroes because a disk filled up. Nothing here throws — a bad field falls
        /// back to its default and the game stays playable, which is always better than a crash on
        /// the main menu.
        /// </remarks>
        public void Sanitise()
        {
            if (quality < QualityTier.Potato || quality > QualityTier.High) quality = QualityTier.Low;

            renderScale = Mathf.Clamp(renderScale <= 0f ? 1f : renderScale, 0.5f, 1f);
            viewDistance = Mathf.Clamp(viewDistance <= 0f ? 800f : viewDistance, 200f, 5000f);
            shadowDistance = Mathf.Clamp(shadowDistance <= 0 ? 80 : shadowDistance, 10, 300);

            if (targetFrameRate != -1 && targetFrameRate != 30 && targetFrameRate != 60
                && targetFrameRate != 120 && targetFrameRate != 144)
            {
                targetFrameRate = 60;
            }

            masterVolume = Clamp01Or(masterVolume, 0.8f);
            engineVolume = Clamp01Or(engineVolume, 0.75f);
            ambienceVolume = Clamp01Or(ambienceVolume, 0.5f);
            effectsVolume = Clamp01Or(effectsVolume, 0.7f);

            mouseSensitivity = Mathf.Clamp(mouseSensitivity <= 0f ? 1f : mouseSensitivity, 0.1f, 5f);
            gamepadDeadzone = Mathf.Clamp(gamepadDeadzone, 0f, 0.6f);

            bindings = Input.InputBindings.Sanitise(bindings);
        }

        /// <summary>
        /// Clamp a volume into 0..1, treating NaN as "not set".
        /// </summary>
        /// <remarks>
        /// Zero is a legitimate value — a player who mutes the engine must stay muted — so only
        /// NaN falls back to the default. The <paramref name="fallback"/> parameter exists for the
        /// case where a field is missing entirely from the file and deserialises to 0 by accident;
        /// <see cref="Sanitise"/> only applies it when the field is NaN, which JsonUtility never
        /// produces, making the distinction safe rather than load-bearing.
        /// </remarks>
        private static float Clamp01Or(float value, float fallback)
        {
            if (float.IsNaN(value)) return fallback;
            return Mathf.Clamp01(value);
        }
    }

    /// <summary>One rebindable action and the keys that trigger it.</summary>
    [Serializable]
    public class BindingEntry
    {
        public string action;
        public string[] keys = Array.Empty<string>();

        public BindingEntry()
        {
        }

        public BindingEntry(string action, params string[] keys)
        {
            this.action = action;
            this.keys = keys ?? Array.Empty<string>();
        }
    }

    /// <summary>
    /// Player progression: what has been unlocked and what has been beaten.
    /// </summary>
    [Serializable]
    public class PlayerProgress
    {
        public const int CurrentVersion = 1;

        public int version = CurrentVersion;

        public string selectedVehicleId = "hatchback";
        public List<string> unlockedVehicleIds = new List<string> { "hatchback", "sedan" };
        public List<string> discoveredLocationIds = new List<string>();
        public List<string> visitedMapIds = new List<string>();

        /// <summary>Challenge id to best result. See <see cref="ChallengeRecord"/>.</summary>
        public List<ChallengeRecord> challenges = new List<ChallengeRecord>();

        public float totalPlaySeconds;

        public static PlayerProgress CreateDefault()
        {
            return new PlayerProgress();
        }

        /// <summary>Coerce loaded data into something usable. Never throws; never returns null lists.</summary>
        public void Sanitise()
        {
            if (string.IsNullOrEmpty(selectedVehicleId)) selectedVehicleId = "hatchback";

            unlockedVehicleIds = SanitiseIdList(unlockedVehicleIds);
            // The starters can never be lost, or a corrupt save would brick the garage.
            EnsureContains(unlockedVehicleIds, "hatchback");
            EnsureContains(unlockedVehicleIds, "sedan");

            if (!unlockedVehicleIds.Contains(selectedVehicleId)) selectedVehicleId = "hatchback";

            discoveredLocationIds = SanitiseIdList(discoveredLocationIds);
            visitedMapIds = SanitiseIdList(visitedMapIds);

            if (challenges == null) challenges = new List<ChallengeRecord>();
            for (int i = challenges.Count - 1; i >= 0; i--)
            {
                ChallengeRecord record = challenges[i];
                if (record == null || string.IsNullOrEmpty(record.challengeId))
                {
                    challenges.RemoveAt(i);
                    continue;
                }

                record.Sanitise();
            }

            if (float.IsNaN(totalPlaySeconds) || totalPlaySeconds < 0f) totalPlaySeconds = 0f;
        }

        public ChallengeRecord GetOrCreateChallenge(string challengeId)
        {
            for (int i = 0; i < challenges.Count; i++)
            {
                if (challenges[i].challengeId == challengeId) return challenges[i];
            }

            ChallengeRecord created = new ChallengeRecord { challengeId = challengeId };
            challenges.Add(created);
            return created;
        }

        /// <summary>Drop nulls and duplicates, preserving order. Always returns a usable list.</summary>
        private static List<string> SanitiseIdList(List<string> source)
        {
            List<string> result = new List<string>();
            if (source == null) return result;

            for (int i = 0; i < source.Count; i++)
            {
                string id = source[i];
                if (string.IsNullOrEmpty(id)) continue;
                if (!result.Contains(id)) result.Add(id);
            }

            return result;
        }

        private static void EnsureContains(List<string> list, string id)
        {
            if (!list.Contains(id)) list.Add(id);
        }
    }

    /// <summary>The best result a player has achieved on one challenge.</summary>
    [Serializable]
    public class ChallengeRecord
    {
        public string challengeId;
        public bool completed;
        public float bestTimeSeconds;
        public int bestScore;
        public int attempts;

        public void Sanitise()
        {
            // A best time of zero or less is corrupt data, not a record. Reporting "best 0.00s"
            // would be worse than reporting no record at all, so it becomes "no record".
            if (float.IsNaN(bestTimeSeconds) || bestTimeSeconds <= 0f) bestTimeSeconds = 0f;
            if (bestScore < 0) bestScore = 0;
            if (attempts < 0) attempts = 0;
        }

        public bool HasTimeRecord
        {
            get { return bestTimeSeconds > 0f; }
        }
    }

    /// <summary>
    /// Everything persisted for one player, in one object.
    /// </summary>
    [Serializable]
    public class SaveFile
    {
        public const int CurrentVersion = 1;

        public int version = CurrentVersion;
        public string gameVersion = "0.1.0";
        public GameSettings settings = GameSettings.CreateDefault();
        public PlayerProgress progress = PlayerProgress.CreateDefault();

        /// <summary>Coerce every part of a loaded file. Never throws.</summary>
        public void Sanitise()
        {
            if (settings == null) settings = GameSettings.CreateDefault();
            if (progress == null) progress = PlayerProgress.CreateDefault();

            settings.Sanitise();
            progress.Sanitise();

            version = CurrentVersion;
        }
    }
}
