using AeroDrive.Core;
using AeroDrive.SaveSystem;
using AeroDrive.Vehicles;
using UnityEngine;

namespace AeroDrive.Missions
{
    /// <summary>Where a challenge run has got to.</summary>
    public enum ChallengeState
    {
        /// <summary>Nothing is running. The player is free to drive.</summary>
        Idle = 0,

        /// <summary>The clock is running and checkpoints count.</summary>
        Running = 1,

        /// <summary>Finished inside the time limit.</summary>
        Completed = 2,

        /// <summary>The time limit expired, or the player retired.</summary>
        Failed = 3,
    }

    /// <summary>
    /// Runs one challenge: the clock, the route order, the scoring and the records.
    /// </summary>
    /// <remarks>
    /// The runner is the only thing that decides whether progress is legitimate, and it is written so
    /// that a challenge cannot be completed by accident:
    ///
    /// * A gate only counts when it is the one the runner is expecting. Driving through the finish
    ///   line on the first corner does nothing.
    /// * The clock starts when the player first moves, not when the scene loads, so a slow load is
    ///   not scored against them.
    /// * Scoring is computed once, at the finish, from facts captured during the run — damage at the
    ///   start, damage now, time taken. Nothing is accumulated frame by frame, which is what makes a
    ///   long run's score reproduce exactly.
    /// </remarks>
    public sealed class ChallengeRunner : MonoBehaviour
    {
        [Header("Challenge")]
        [Tooltip("The challenge to run. Required.")]
        public ChallengeDefinition definition;

        [Header("Scene")]
        [Tooltip("The car being timed. Required.")]
        public VehicleController vehicle;

        [Tooltip("Parent of the checkpoints, for local-to-world conversion. Defaults to this transform.")]
        public Transform routeRoot;

        [Tooltip("Checkpoints in route order. Populated from the children when left empty.")]
        public Checkpoint[] checkpoints = new Checkpoint[0];

        [Tooltip("HUD used for messages. Optional.")]
        public Presentation.Hud hud;

        [Header("Behaviour")]
        [Tooltip("Start the challenge automatically when the scene loads.")]
        public bool startAutomatically = true;

        [Tooltip("Seconds after the last checkpoint before the player is offered a way back.")]
        [Range(10f, 600f)]
        public float strayTimeout = 90f;

        private EventBus _bus;
        private SaveManager _save;

        private ChallengeState _state = ChallengeState.Idle;
        private float _elapsed;
        private float _damageAtStart;
        private int _nextIndex;
        private int _lap = 1;
        private int _checkpointsPassed;
        private int _score;
        private float _timeSinceLastCheckpoint;
        private bool _waitingForMovement;

        /// <summary>Current state of the run.</summary>
        public ChallengeState State
        {
            get { return _state; }
        }

        /// <summary>Seconds on the clock, frozen once the run ends.</summary>
        public float ElapsedSeconds
        {
            get { return _elapsed; }
        }

        /// <summary>Seconds left before the time limit, or infinity when there is no limit.</summary>
        public float TimeRemaining
        {
            get { return definition != null ? definition.TimeRemaining(_elapsed) : float.PositiveInfinity; }
        }

        /// <summary>Score so far. Only final once the run completes.</summary>
        public int Score
        {
            get { return _score; }
        }

        /// <summary>Lap currently being driven, 1-based.</summary>
        public int Lap
        {
            get { return _lap; }
        }

        /// <summary>Index of the gate the player must reach next.</summary>
        public int NextCheckpointIndex
        {
            get { return _nextIndex; }
        }

        /// <summary>The car being timed, for the checkpoints to identify their driver.</summary>
        public VehicleController Vehicle
        {
            get { return vehicle; }
        }

        /// <summary>The challenge being run, or null when idle.</summary>
        public ChallengeDefinition Definition
        {
            get { return definition; }
        }

        /// <summary>Give the runner its dependencies. Called by the session, or by a test.</summary>
        public void Initialise(EventBus bus, SaveManager save)
        {
            _bus = bus;
            _save = save;
        }

        private void Awake()
        {
            if (routeRoot == null) routeRoot = transform;
            if (checkpoints == null || checkpoints.Length == 0) CollectCheckpoints();
        }

        private void Start()
        {
            if (startAutomatically) BeginRun();
        }

        /// <summary>Discover the checkpoints among the children, in the order they appear.</summary>
        private void CollectCheckpoints()
        {
            checkpoints = routeRoot.GetComponentsInChildren<Checkpoint>(true);

            // The hierarchy order is the only ordering Unity guarantees, and it matches how a
            // designer builds a route: a list of gates, top to bottom.
            System.Array.Sort(checkpoints, (a, b) => a.transform.GetSiblingIndex().CompareTo(b.transform.GetSiblingIndex()));
        }

        /// <summary>
        /// Start, or restart, the run.
        /// </summary>
        /// <remarks>
        /// The clock does not start until the car moves. A countdown that begins during a scene load
        /// punishes the player for the machine they are on.
        /// </remarks>
        public void BeginRun()
        {
            if (definition == null)
            {
                Debug.LogError("[AeroDrive] ChallengeRunner has no ChallengeDefinition assigned.", this);
                return;
            }

            if (!definition.IsValid)
            {
                Debug.LogWarning($"[AeroDrive] Challenge \"{definition.name}\" has no checkpoints and will not be run.");
                return;
            }

            // A scene generated by the editor wizard never calls Initialise. Without the save file
            // the run would still be timed and scored, but no record would be kept.
            if (_save == null && GameRoot.Instance != null) Initialise(GameRoot.Instance.Bus, GameRoot.Instance.Save);

            if (checkpoints == null || checkpoints.Length == 0) CollectCheckpoints();

            _state = ChallengeState.Running;
            _elapsed = 0f;
            _score = 0;
            _lap = 1;
            _checkpointsPassed = 0;
            _nextIndex = 0;
            _timeSinceLastCheckpoint = 0f;
            _damageAtStart = vehicle != null ? vehicle.DamagePercent : 0f;
            _waitingForMovement = true;

            for (int i = 0; i < checkpoints.Length; i++)
            {
                checkpoints[i].Initialise(this, i, i == checkpoints.Length - 1);
                checkpoints[i].SetState(i == 0, false);
            }

            hud?.ShowMessage($"{definition.displayName} — {definition.CheckpointCount} checkpoints", 2.5f);
        }

        /// <summary>Restart the run from the beginning.</summary>
        public void RestartRun()
        {
            hud?.ResetTimer();
            vehicle?.Recover();
            BeginRun();
        }

        private void Update()
        {
            if (_state != ChallengeState.Running || definition == null) return;

            float dt = Time.deltaTime;

            if (_waitingForMovement)
            {
                // A twentieth of a metre per second is below the noise floor of a stationary
                // rigidbody, so this fires on the first genuine movement of the car.
                if (vehicle != null && vehicle.SignedSpeed > 0.05f) _waitingForMovement = false;
                return;
            }

            _elapsed += dt;
            _timeSinceLastCheckpoint += dt;

            if (definition.HasTimedOut(_elapsed))
            {
                Fail("timeout");
                return;
            }

            if (_timeSinceLastCheckpoint > strayTimeout)
            {
                _timeSinceLastCheckpoint = 0f;
                hud?.ShowMessage("Follow the checkpoint markers", 3f);
            }
        }

        /// <summary>Called by a checkpoint when the player's car enters it.</summary>
        public void ReportCheckpointEntered(Checkpoint checkpoint)
        {
            if (_state != ChallengeState.Running || checkpoint == null) return;
            if (definition == null) return;

            // Out-of-order gates are ignored rather than rejected: a player who cuts a corner and
            // touches a later gate has not cheated, and failing them for it would be hostile.
            if (definition.orderedCheckpoints && checkpoint.index != _nextIndex)
            {
                if (checkpoint.index < _nextIndex) return;
                hud?.ShowMessage("Wrong way — next checkpoint is marked", 2f);
                return;
            }

            if (checkpoint.HasBeenPassed && definition.laps <= 1) return;

            _timeSinceLastCheckpoint = 0f;
            _checkpointsPassed++;
            _score += definition.pointsPerCheckpoint;

            checkpoint.SetState(false, true);

            _bus?.Publish(new GameEvents.CheckpointReached(
                checkpoint.index, definition.CheckpointCount, _elapsed, _score));

            _nextIndex = checkpoint.index + 1;

            if (checkpoint.isFinishLine)
            {
                if (_lap >= definition.laps)
                {
                    Complete();
                    return;
                }

                _lap++;
                _nextIndex = 0;

                // The whole route re-arms for the next lap, including the gate just passed — laps are
                // a loop, and leaving the finish line dark would make lap two unwinnable.
                for (int i = 0; i < checkpoints.Length; i++) checkpoints[i].SetState(i == 0, false);

                _bus?.Publish(new GameEvents.LapCompleted(_lap - 1, definition.laps, _elapsed));
                hud?.ShowMessage($"Lap {_lap} of {definition.laps}", 2f);
                return;
            }

            if (_nextIndex < checkpoints.Length)
            {
                checkpoints[_nextIndex].SetState(true, false);
            }
        }

        /// <summary>
        /// Finish the run, compute the score and record the result.
        /// </summary>
        /// <remarks>
        /// The score is computed here in one pass from four facts: checkpoints passed, time left,
        /// damage taken, and the base points already awarded. It is not accumulated, so it cannot
        /// drift and it can be recomputed from the save file for a leaderboard.
        /// </remarks>
        private void Complete()
        {
            _state = ChallengeState.Completed;

            int score = _score;
            string summary = $"Finished in {FormatTime(_elapsed)}";

            float remaining = definition.TimeRemaining(_elapsed);
            float limit = definition.timeLimitSeconds;

            if (limit > 0f && !float.IsPositiveInfinity(remaining) && remaining / limit >= definition.timeBonusThreshold)
            {
                score += definition.timeBonusPoints;
                summary += $"  ·  time bonus +{definition.timeBonusPoints}";
            }

            if (vehicle != null && definition.damagePenaltyPerPercent > 0f)
            {
                float damageTaken = Mathf.Max(0f, vehicle.DamagePercent - _damageAtStart);
                int penalty = Mathf.RoundToInt(damageTaken * definition.damagePenaltyPerPercent);
                if (penalty > 0)
                {
                    score = Mathf.Max(0, score - penalty);
                    summary += $"  ·  damage −{penalty}";
                }
            }

            _score = score;

            Medal medal = definition.MedalFor(_elapsed);
            ChallengeOutcome outcome = default;
            bool hasSave = _save != null;

            if (hasSave)
            {
                outcome = _save.RecordChallengeResult(definition.challengeId, true, _elapsed, score);

                // The first completion of a challenge is the game's progression hook: it is what
                // unlocks the next car, so it must be recorded exactly once.
                if (outcome.WasFirstCompletion) _save.Save();
            }

            for (int i = 0; i < checkpoints.Length; i++) checkpoints[i].SetState(false, true);

            _bus?.Publish(new GameEvents.ChallengeCompleted(
                definition.challengeId,
                _elapsed,
                score,
                medal,
                outcome.WasFirstCompletion,
                outcome.NewTimeRecord,
                outcome.NewScoreRecord));

            string medalText = medal == Medal.None ? string.Empty : $"  ·  {medal}";
            string recordText = outcome.NewTimeRecord ? "  ·  new best time" : string.Empty;
            hud?.ShowMessage(summary + medalText + recordText, 6f);
        }

        /// <summary>End the run without completing it.</summary>
        /// <param name="reason">\"timeout\" or \"retired\".</param>
        public void Fail(string reason)
        {
            if (_state != ChallengeState.Running) return;

            _state = ChallengeState.Failed;

            if (definition != null && _save != null)
            {
                // An attempt is still recorded when it fails: the count is shown in the results as
                // "3 attempts", which is information the player wants even when they did not finish.
                _save.RecordChallengeResult(definition.challengeId, false, 0f, _score);
            }

            _bus?.Publish(new GameEvents.ChallengeFailed(
                definition != null ? definition.challengeId : string.Empty,
                reason));

            hud?.ShowMessage(reason == "timeout" ? "Out of time" : "Run retired", 4f);
        }

        /// <summary>Stop the clock and go back to free driving, keeping any records earned.</summary>
        public void AbandonRun()
        {
            if (_state == ChallengeState.Running) Fail("retired");
            _state = ChallengeState.Idle;
        }

        /// <summary>Format seconds as m:ss.hh, the way a stopwatch reads.</summary>
        public static string FormatTime(float seconds)
        {
            if (seconds < 0f || float.IsNaN(seconds)) seconds = 0f;

            int minutes = Mathf.FloorToInt(seconds / 60f);
            int wholeSeconds = Mathf.FloorToInt(seconds % 60f);
            int hundredths = Mathf.FloorToInt((seconds * 100f) % 100f);
            return $"{minutes}:{wholeSeconds:00}.{hundredths:00}";
        }
    }
}
