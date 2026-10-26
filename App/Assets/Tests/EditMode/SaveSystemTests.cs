using AeroDrive.SaveSystem;
using NUnit.Framework;

namespace AeroDrive.Tests
{
    /// <summary>
    /// Tests for the save file and the settings it carries.
    /// </summary>
    /// <remarks>
    /// A save file is the one input the game cannot trust: it may be from an older build, edited by
    /// hand, or truncated by a full disk. Every test here asserts the same property in a different
    /// way — that bad data produces a *playable* game, never an exception and never a state the
    /// player cannot get out of.
    /// </remarks>
    public class SaveSystemTests
    {
        [Test]
        public void SaveFile_SanitiseFillsInMissingSections()
        {
            SaveFile file = new SaveFile { settings = null, progress = null };
            file.Sanitise();

            Assert.IsNotNull(file.settings);
            Assert.IsNotNull(file.progress);
            Assert.AreEqual(SaveFile.CurrentVersion, file.version);
        }

        [Test]
        public void GameSettings_SanitiseClampsEveryRange()
        {
            GameSettings settings = new GameSettings
            {
                renderScale = 12f,
                viewDistance = -5f,
                shadowDistance = 99999,
                masterVolume = 5f,
                engineVolume = -3f,
                mouseSensitivity = 0f,
                gamepadDeadzone = 9f,
                targetFrameRate = 7,
            };

            settings.Sanitise();

            Assert.LessOrEqual(settings.renderScale, 1f);
            Assert.GreaterOrEqual(settings.renderScale, 0.5f);
            Assert.GreaterOrEqual(settings.viewDistance, 200f);
            Assert.LessOrEqual(settings.shadowDistance, 300);
            Assert.AreEqual(1f, settings.masterVolume, 0.0001f);
            Assert.AreEqual(0f, settings.engineVolume, 0.0001f);
            Assert.Greater(settings.mouseSensitivity, 0f);
            Assert.LessOrEqual(settings.gamepadDeadzone, 0.6f);
            Assert.AreEqual(60, settings.targetFrameRate);
        }

        [Test]
        public void GameSettings_SanitiseRepairsAnInvalidQualityTier()
        {
            GameSettings settings = new GameSettings { quality = (QualityTier)77 };
            settings.Sanitise();

            Assert.AreEqual(QualityTier.Low, settings.quality);
        }

        [Test]
        public void GameSettings_SanitiseKeepsAMutedEngineMuted()
        {
            // Zero is a real setting, not a missing one. Treating it as "unset" would un-mute a
            // player's game every time it loaded.
            GameSettings settings = new GameSettings { engineVolume = 0f };
            settings.Sanitise();

            Assert.AreEqual(0f, settings.engineVolume, 0.0001f);
        }

        [Test]
        public void PlayerProgress_SanitiseAlwaysKeepsTheStarterCars()
        {
            // A save file with an empty garage would leave the player with nothing to drive and no
            // way to get a car back, so the starters are restored rather than trusted.
            PlayerProgress progress = new PlayerProgress { unlockedVehicleIds = null };
            progress.Sanitise();

            CollectionAssert.Contains(progress.unlockedVehicleIds, "hatchback");
            CollectionAssert.Contains(progress.unlockedVehicleIds, "sedan");
        }

        [Test]
        public void PlayerProgress_SanitiseReselectsACarThePlayerOwns()
        {
            PlayerProgress progress = new PlayerProgress
            {
                selectedVehicleId = "coupe",
                unlockedVehicleIds = new System.Collections.Generic.List<string> { "hatchback" },
            };
            progress.Sanitise();

            Assert.AreEqual("hatchback", progress.selectedVehicleId);
        }

        [Test]
        public void PlayerProgress_SanitiseDropsDuplicateIds()
        {
            PlayerProgress progress = new PlayerProgress
            {
                unlockedVehicleIds = new System.Collections.Generic.List<string> { "hatchback", "hatchback", "" },
            };
            progress.Sanitise();

            Assert.AreEqual(2, progress.unlockedVehicleIds.Count);
        }

        [Test]
        public void ChallengeRecord_SanitiseTreatsAZeroBestTimeAsNoRecord()
        {
            ChallengeRecord record = new ChallengeRecord { challengeId = "harbour-loop", bestTimeSeconds = -12f };
            record.Sanitise();

            Assert.IsFalse(record.HasTimeRecord);
        }

        [Test]
        public void PlayerProgress_GetOrCreateChallenge_ReturnsTheSameRecord()
        {
            PlayerProgress progress = new PlayerProgress();

            ChallengeRecord first = progress.GetOrCreateChallenge("harbour-loop");
            first.bestScore = 900;
            ChallengeRecord second = progress.GetOrCreateChallenge("harbour-loop");

            Assert.AreSame(first, second);
            Assert.AreEqual(900, second.bestScore);
            Assert.AreEqual(1, progress.challenges.Count);
        }

        [Test]
        public void Settings_DefaultBindingsCoverEveryAction()
        {
            GameSettings settings = GameSettings.CreateDefault();

            Assert.AreEqual(AeroDrive.Input.InputBindings.Actions.Length, settings.bindings.Length);

            for (int i = 0; i < AeroDrive.Input.InputBindings.Actions.Length; i++)
            {
                string action = AeroDrive.Input.InputBindings.Actions[i];
                string[] keys = AeroDrive.Input.InputBindings.KeysFor(settings.bindings, action);

                Assert.Greater(keys.Length, 0, $"Action \"{action}\" has no key bound to it.");
            }
        }

        [Test]
        public void SaveFile_SanitiseIsIdempotent()
        {
            // Sanitising twice must not change anything the second time, or a loaded file would drift
            // every time the game was started.
            SaveFile file = new SaveFile();
            file.Sanitise();
            string first = UnityEngine.JsonUtility.ToJson(file, true);

            file.Sanitise();
            string second = UnityEngine.JsonUtility.ToJson(file, true);

            Assert.AreEqual(first, second);
        }
    }
}
