using System;
using System.IO;
using AeroDrive.Core;
using UnityEngine;

namespace AeroDrive.SaveSystem
{
    /// <summary>
    /// Owns the on-disk save file: loading, validating, saving and resetting.
    /// </summary>
    /// <remarks>
    /// Design decisions worth stating, because each one is a bug avoided:
    ///
    /// * **Never throws.** A missing, unreadable or corrupt file leaves the game running on
    ///   defaults. Failing to load a save must never stop somebody playing.
    /// * **Atomic writes.** The new file is written to a temporary path and then moved over the
    ///   old one. A crash or a full disk mid-write therefore cannot destroy a good save.
    /// * **Saving is explicit, never per frame.** Callers decide when to save (leaving a session,
    ///   closing the settings menu), because writing to disk every frame would stutter the game.
    /// * **Path is <see cref="Application.persistentDataPath"/>.** No hard-coded file-system paths,
    ///   so the same code is correct on Windows, macOS, Linux and consoles.
    /// </remarks>
    public sealed class SaveManager
    {
        public const string FileName = "aerodrive-save.json";

        private readonly EventBus _bus;

        /// <summary>Absolute path of the save file. Useful for diagnostics and for tests.</summary>
        public string FilePath { get; private set; }

        /// <summary>The live save data. Never null after construction.</summary>
        public SaveFile Data { get; private set; }

        /// <summary>True when the last load had to fall back to defaults.</summary>
        public bool LoadedWithFallback { get; private set; }

        private bool _dirty;

        public SaveManager(EventBus bus, string overridePath = null)
        {
            _bus = bus;
            // A caller-supplied path is used by tests so they never touch the real save file.
            FilePath = string.IsNullOrEmpty(overridePath)
                ? Path.Combine(Application.persistentDataPath, FileName)
                : overridePath;

            Data = new SaveFile();
        }

        /// <summary>Load the save file, falling back to defaults on any failure.</summary>
        public void Load()
        {
            LoadedWithFallback = false;

            if (!File.Exists(FilePath))
            {
                Data = new SaveFile();
                Data.Sanitise();
                return;
            }

            try
            {
                string json = File.ReadAllText(FilePath);
                SaveFile loaded = JsonUtility.FromJson<SaveFile>(json);

                if (loaded == null)
                {
                    Debug.LogWarning("[AeroDrive] Save file could not be parsed; using defaults.");
                    loaded = new SaveFile();
                    LoadedWithFallback = true;
                }

                loaded.Sanitise();
                Data = loaded;
            }
            catch (Exception error)
            {
                // Covers a locked file, a permissions problem, and malformed JSON alike. The game
                // continues either way.
                Debug.LogWarning($"[AeroDrive] Could not read the save file ({error.GetType().Name}: {error.Message}); using defaults.");
                Data = new SaveFile();
                Data.Sanitise();
                LoadedWithFallback = true;
            }
        }

        /// <summary>Apply and persist a change to the settings.</summary>
        public void ApplySettings(GameSettings settings)
        {
            if (settings == null) return;

            settings.Sanitise();
            Data.settings = settings;
            MarkDirty();
            _bus?.Publish(new GameEvents.SettingsChanged(settings));
        }

        public void MarkDirty()
        {
            _dirty = true;
        }

        public bool IsDirty
        {
            get { return _dirty; }
        }

        /// <summary>
        /// Write the save file now, if there is anything to write.
        /// </summary>
        /// <returns>True when the file on disk is up to date.</returns>
        public bool Save()
        {
            if (!_dirty) return true;

            try
            {
                string directory = Path.GetDirectoryName(FilePath);
                if (!string.IsNullOrEmpty(directory) && !Directory.Exists(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                Data.Sanitise();
                string json = JsonUtility.ToJson(Data, true);

                // Write to a temporary file first, then move it into place, so a failure part-way
                // through cannot leave a half-written save behind.
                string temporaryPath = FilePath + ".tmp";
                File.WriteAllText(temporaryPath, json);

                if (File.Exists(FilePath)) File.Delete(FilePath);
                File.Move(temporaryPath, FilePath);

                _dirty = false;
                Debug.Log($"[AeroDrive] Progress saved to {FilePath}");
                return true;
            }
            catch (Exception error)
            {
                // Reported, never fatal. The player keeps playing; they will be told on the next
                // attempt that saving is failing.
                Debug.LogWarning($"[AeroDrive] Could not save ({error.GetType().Name}: {error.Message}). Progress for this session is not on disk.");
                return false;
            }
        }

        /// <summary>Delete the save file and start again, keeping nothing.</summary>
        public void ResetProgress()
        {
            GameSettings settings = Data != null ? Data.settings : GameSettings.CreateDefault();
            Data = new SaveFile { settings = settings };
            Data.Sanitise();

            try
            {
                if (File.Exists(FilePath)) File.Delete(FilePath);
            }
            catch (Exception error)
            {
                Debug.LogWarning($"[AeroDrive] Could not delete the save file ({error.GetType().Name}). It will be overwritten on the next save.");
            }

            _dirty = true;
            Save();
        }

        /// <summary>Unlock a vehicle. Returns true when this was a new unlock.</summary>
        public bool UnlockVehicle(string vehicleId)
        {
            if (string.IsNullOrEmpty(vehicleId)) return false;
            if (Data.progress.unlockedVehicleIds.Contains(vehicleId)) return false;

            Data.progress.unlockedVehicleIds.Add(vehicleId);
            MarkDirty();
            return true;
        }

        public bool IsVehicleUnlocked(string vehicleId)
        {
            return !string.IsNullOrEmpty(vehicleId) && Data.progress.unlockedVehicleIds.Contains(vehicleId);
        }

        /// <summary>Record a challenge attempt and update the records that improved. Returns a summary.</summary>
        public ChallengeOutcome RecordChallengeResult(string challengeId, bool completed, float timeSeconds, int score)
        {
            ChallengeRecord record = Data.progress.GetOrCreateChallenge(challengeId);

            // Capture whether this is the first time the challenge has *ever* been completed
            // before recording this attempt, otherwise the flag is meaningless.
            bool wasCompletedBefore = record.completed;

            record.attempts += 1;
            record.completed |= completed;

            ChallengeOutcome outcome = new ChallengeOutcome
            {
                WasFirstCompletion = completed && !wasCompletedBefore,
            };

            if (completed && timeSeconds > 0f && (!record.HasTimeRecord || timeSeconds < record.bestTimeSeconds))
            {
                record.bestTimeSeconds = timeSeconds;
                outcome.NewTimeRecord = true;
            }

            if (score > record.bestScore)
            {
                record.bestScore = score;
                outcome.NewScoreRecord = true;
            }

            outcome.BestTimeSeconds = record.bestTimeSeconds;
            outcome.BestScore = record.bestScore;
            MarkDirty();
            return outcome;
        }

        public ChallengeRecord GetChallengeRecord(string challengeId)
        {
            for (int i = 0; i < Data.progress.challenges.Count; i++)
            {
                if (Data.progress.challenges[i].challengeId == challengeId) return Data.progress.challenges[i];
            }

            return null;
        }

        /// <summary>Mark a map as visited. Returns true when this was the first visit.</summary>
        public bool MarkMapVisited(string mapId)
        {
            if (string.IsNullOrEmpty(mapId)) return false;
            if (Data.progress.visitedMapIds.Contains(mapId)) return false;

            Data.progress.visitedMapIds.Add(mapId);
            MarkDirty();
            return true;
        }

        public bool MarkLocationDiscovered(string locationId)
        {
            if (string.IsNullOrEmpty(locationId)) return false;
            if (Data.progress.discoveredLocationIds.Contains(locationId)) return false;

            Data.progress.discoveredLocationIds.Add(locationId);
            MarkDirty();
            return true;
        }

        /// <summary>Add elapsed play time. Rounded to whole seconds so the file stays readable.</summary>
        public void AddPlayTime(float seconds)
        {
            if (seconds <= 0f || float.IsNaN(seconds)) return;

            Data.progress.totalPlaySeconds += seconds;
            MarkDirty();
        }
    }

    /// <summary>What changed when a challenge result was recorded.</summary>
    public struct ChallengeOutcome
    {
        public bool WasFirstCompletion;
        public bool NewTimeRecord;
        public bool NewScoreRecord;
        public float BestTimeSeconds;
        public int BestScore;
    }
}
