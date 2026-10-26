using AeroDrive.Missions;
using NUnit.Framework;
using UnityEngine;

namespace AeroDrive.Tests
{
    /// <summary>
    /// Tests for the challenge rules.
    /// </summary>
    /// <remarks>
    /// The runner itself needs a scene, so what is covered here is the part that decides the outcome:
    /// medal thresholds, the clock, and the validity check that stops an unfinished challenge asset
    /// from completing itself the instant it loads.
    /// </remarks>
    public class ChallengeTests
    {
        private ChallengeDefinition _challenge;

        [SetUp]
        public void SetUp()
        {
            _challenge = ScriptableObject.CreateInstance<ChallengeDefinition>();
            _challenge.challengeId = "harbour-loop";
            _challenge.laps = 1;
            _challenge.timeLimitSeconds = 180f;
            _challenge.goldTimeSeconds = 80f;
            _challenge.silverTimeSeconds = 110f;
            _challenge.bronzeTimeSeconds = 150f;
            _challenge.checkpoints = new[] { Vector3.zero, new Vector3(10f, 0f, 0f) };
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_challenge);
        }

        [Test]
        public void MedalFor_ReturnsTheBestMedalEarned()
        {
            Assert.AreEqual(Medal.Gold, _challenge.MedalFor(60f));
            Assert.AreEqual(Medal.Gold, _challenge.MedalFor(80f));
            Assert.AreEqual(Medal.Silver, _challenge.MedalFor(95f));
            Assert.AreEqual(Medal.Silver, _challenge.MedalFor(110f));
            Assert.AreEqual(Medal.Bronze, _challenge.MedalFor(140f));
            Assert.AreEqual(Medal.None, _challenge.MedalFor(151f));
        }

        [Test]
        public void MedalFor_IgnoresThresholdsThatAreDisabled()
        {
            _challenge.goldTimeSeconds = 0f;
            _challenge.silverTimeSeconds = 0f;
            _challenge.bronzeTimeSeconds = 0f;

            Assert.AreEqual(Medal.None, _challenge.MedalFor(1f));
        }

        [Test]
        public void TimeRemaining_CountsDownAndStopsAtZero()
        {
            Assert.AreEqual(120f, _challenge.TimeRemaining(60f), 0.001f);
            Assert.AreEqual(0f, _challenge.TimeRemaining(200f), 0.001f);
        }

        [Test]
        public void TimeRemaining_IsInfiniteWhenThereIsNoLimit()
        {
            _challenge.timeLimitSeconds = 0f;

            Assert.IsTrue(float.IsPositiveInfinity(_challenge.TimeRemaining(9999f)));
            Assert.IsFalse(_challenge.HasTimedOut(9999f));
        }

        [Test]
        public void HasTimedOut_FiresOnTheLimit()
        {
            Assert.IsFalse(_challenge.HasTimedOut(179.9f));
            Assert.IsTrue(_challenge.HasTimedOut(180f));
        }

        [Test]
        public void IsValid_RejectsAChallengeWithNoCheckpoints()
        {
            // A challenge with no gates would complete on the first frame, which reads as a bug in
            // the results screen rather than a missing asset in the project.
            _challenge.checkpoints = new Vector3[0];
            Assert.IsFalse(_challenge.IsValid);

            _challenge.checkpoints = new[] { Vector3.zero };
            Assert.IsTrue(_challenge.IsValid);
        }

        [Test]
        public void IsValid_RejectsAChallengeWithNoId()
        {
            _challenge.challengeId = string.Empty;
            Assert.IsFalse(_challenge.IsValid);
        }

        [Test]
        public void CheckpointCount_TracksTheRoute()
        {
            Assert.AreEqual(2, _challenge.CheckpointCount);

            _challenge.checkpoints = null;
            Assert.AreEqual(0, _challenge.CheckpointCount);
        }

        [Test]
        public void FormatTime_ReadsLikeAStopwatch()
        {
            Assert.AreEqual("0:00.00", ChallengeRunner.FormatTime(0f));
            Assert.AreEqual("1:05.50", ChallengeRunner.FormatTime(65.5f));
            Assert.AreEqual("10:00.00", ChallengeRunner.FormatTime(600f));
        }

        [Test]
        public void FormatTime_SurvivesBadInput()
        {
            // A NaN time would otherwise print "NaN:NaN.NaN" onto the results panel.
            Assert.AreEqual("0:00.00", ChallengeRunner.FormatTime(float.NaN));
            Assert.AreEqual("0:00.00", ChallengeRunner.FormatTime(-5f));
        }
    }
}
