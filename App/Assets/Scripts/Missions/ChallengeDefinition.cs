using UnityEngine;

namespace AeroDrive.Missions
{
    /// <summary>How well a challenge was completed. Ordered worst to best.</summary>
    public enum Medal
    {
        None = 0,
        Bronze = 1,
        Silver = 2,
        Gold = 3,
    }

    /// <summary>
    /// One challenge: a set of checkpoints, a time limit and the medals it awards.
    /// </summary>
    /// <remarks>
    /// A challenge is data, not code. That is what allows a route to be built and tuned without a
    /// programmer, and it is why the runner below never has a special case for a particular event.
    ///
    /// Checkpoint positions are in local space of the object the runner sits on, so a challenge can
    /// be moved by moving its parent rather than by editing every point — which is the difference
    /// between relocating a race and rebuilding it.
    /// </remarks>
    [CreateAssetMenu(fileName = "Challenge", menuName = "AeroDrive/Challenge", order = 10)]
    public class ChallengeDefinition : ScriptableObject
    {
        [Header("Identity")]
        [Tooltip("Stable id used in the save file. Do not change once it has been published.")]
        public string challengeId = "harbour-loop";

        public string displayName = "Harbour Loop";

        [TextArea(2, 4)]
        public string description = "Three laps of the harbour circuit before the ferry leaves.";

        [Header("Rules")]
        [Tooltip("Seconds the player has to finish. Zero means no limit.")]
        [Min(0f)]
        public float timeLimitSeconds = 180f;

        [Tooltip("Total number of laps. 1 for a simple point-to-point run.")]
        [Min(1)]
        public int laps = 1;

        [Tooltip("Checkpoints must be reached in order.")]
        public bool orderedCheckpoints = true;

        [Tooltip("Metres within which a checkpoint counts as reached. Independent of the trigger's own size.")]
        [Min(1f)]
        public float checkpointRadius = 12f;

        [Header("Scoring")]
        [Tooltip("Points awarded for each checkpoint.")]
        [Min(0)]
        public int pointsPerCheckpoint = 100;

        [Tooltip("Bonus points for finishing with more than this share of the time limit remaining.")]
        [Range(0f, 1f)]
        public float timeBonusThreshold = 0.25f;

        [Min(0)]
        public int timeBonusPoints = 500;

        [Tooltip("Points lost for every percent of damage taken during the run.")]
        [Min(0f)]
        public float damagePenaltyPerPercent = 4f;

        [Header("Medals")]
        [Tooltip("Finish within this many seconds for gold. Zero disables the medal.")]
        [Min(0f)]
        public float goldTimeSeconds = 80f;

        [Min(0f)]
        public float silverTimeSeconds = 110f;

        [Min(0f)]
        public float bronzeTimeSeconds = 150f;

        [Header("Route")]
        [Tooltip("Checkpoint positions in the runner's local space.")]
        public Vector3[] checkpoints = new Vector3[0];

        [Tooltip("Position the car starts from, in local space. Zero uses the scene's spawn point.")]
        public Vector3 startPosition;

        /// <summary>Number of checkpoints in the route.</summary>
        public int CheckpointCount
        {
            get { return checkpoints != null ? checkpoints.Length : 0; }
        }

        /// <summary>True when the challenge can actually be run.</summary>
        /// <remarks>
        /// A challenge with no checkpoints would complete instantly, which reads as a bug. The runner
        /// checks this rather than asserting, so a half-authored asset is skipped with a warning
        /// instead of producing a nonsense result.
        /// </remarks>
        public bool IsValid
        {
            get { return !string.IsNullOrEmpty(challengeId) && CheckpointCount > 0; }
        }

        /// <summary>Which medal a finish time earns.</summary>
        public Medal MedalFor(float seconds)
        {
            if (goldTimeSeconds > 0f && seconds <= goldTimeSeconds) return Medal.Gold;
            if (silverTimeSeconds > 0f && seconds <= silverTimeSeconds) return Medal.Silver;
            if (bronzeTimeSeconds > 0f && seconds <= bronzeTimeSeconds) return Medal.Bronze;
            return Medal.None;
        }

        /// <summary>Seconds left on the clock, or infinity when the challenge has no limit.</summary>
        public float TimeRemaining(float elapsedSeconds)
        {
            if (timeLimitSeconds <= 0f) return float.PositiveInfinity;
            return Mathf.Max(0f, timeLimitSeconds - elapsedSeconds);
        }

        /// <summary>True when the clock has run out.</summary>
        public bool HasTimedOut(float elapsedSeconds)
        {
            return timeLimitSeconds > 0f && elapsedSeconds >= timeLimitSeconds;
        }
    }
}
