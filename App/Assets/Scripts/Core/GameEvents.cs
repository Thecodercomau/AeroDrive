namespace AeroDrive.Core
{
    /// <summary>
    /// Everything the runtime publishes on the <see cref="EventBus"/>.
    /// </summary>
    /// <remarks>
    /// All payloads are structs so publishing does not allocate. They are declared in one file on
    /// purpose: the set of events is part of the architecture, and it should be possible to read it
    /// in one place.
    /// </remarks>
    public static class GameEvents
    {
        /// <summary>Raised once the runtime is constructed and ready to accept commands.</summary>
        public readonly struct GameReady
        {
            public readonly string Version;

            public GameReady(string version)
            {
                Version = version;
            }
        }

        /// <summary>Raised when a session starts (free roam or a challenge).</summary>
        public readonly struct SessionStarted
        {
            public readonly string VehicleId;
            public readonly string MapId;

            public SessionStarted(string vehicleId, string mapId)
            {
                VehicleId = vehicleId;
                MapId = mapId;
            }
        }

        /// <summary>Raised when the player returns to the menu, tearing the session down.</summary>
        public readonly struct SessionEnded
        {
            public readonly float DurationSeconds;

            public SessionEnded(float durationSeconds)
            {
                DurationSeconds = durationSeconds;
            }
        }

        /// <summary>Raised when the gearbox changes gear. Drives the HUD and the shift sound.</summary>
        public readonly struct GearChanged
        {
            public readonly int PreviousGear;
            public readonly int Gear;

            public GearChanged(int previousGear, int gear)
            {
                PreviousGear = previousGear;
                Gear = gear;
            }
        }

        /// <summary>Raised when the vehicle takes a hit worth reacting to.</summary>
        public readonly struct Impact
        {
            /// <summary>Closing speed lost in the collision, in metres per second.</summary>
            public readonly float ImpactSpeed;
            public readonly float DamageAfter;
            /// <summary>World position of the vehicle at the moment of impact.</summary>
            public readonly UnityEngine.Vector3 Position;

            public Impact(float impactSpeed, float damageAfter, UnityEngine.Vector3 position)
            {
                ImpactSpeed = impactSpeed;
                DamageAfter = damageAfter;
                Position = position;
            }
        }

        /// <summary>Raised when the vehicle is returned to the road by the recovery action.</summary>
        public readonly struct VehicleRecovered
        {
            public readonly UnityEngine.Vector3 Position;

            public VehicleRecovered(UnityEngine.Vector3 position)
            {
                Position = position;
            }
        }

        /// <summary>Raised when a settings value changes, so live systems can apply it immediately.</summary>
        public readonly struct SettingsChanged
        {
            public readonly AeroDrive.SaveSystem.GameSettings Settings;

            public SettingsChanged(AeroDrive.SaveSystem.GameSettings settings)
            {
                Settings = settings;
            }
        }

        /// <summary>Raised as each gate on a challenge route is passed.</summary>
        public readonly struct CheckpointReached
        {
            public readonly int Index;
            public readonly int Total;
            public readonly float ElapsedSeconds;
            public readonly int Score;

            public CheckpointReached(int index, int total, float elapsedSeconds, int score)
            {
                Index = index;
                Total = total;
                ElapsedSeconds = elapsedSeconds;
                Score = score;
            }
        }

        /// <summary>Raised when a lap of a challenge is completed.</summary>
        public readonly struct LapCompleted
        {
            public readonly int Lap;
            public readonly int TotalLaps;
            public readonly float ElapsedSeconds;

            public LapCompleted(int lap, int totalLaps, float elapsedSeconds)
            {
                Lap = lap;
                TotalLaps = totalLaps;
                ElapsedSeconds = elapsedSeconds;
            }
        }

        /// <summary>Raised when a challenge is finished successfully.</summary>
        public readonly struct ChallengeCompleted
        {
            public readonly string ChallengeId;
            public readonly float TimeSeconds;
            public readonly int Score;

            /// <summary>The best medal the finish time earned. None when the thresholds are disabled.</summary>
            public readonly AeroDrive.Missions.Medal MedalEarned;

            public readonly bool IsFirstCompletion;
            public readonly bool IsNewTimeRecord;
            public readonly bool IsNewScoreRecord;

            public ChallengeCompleted(
                string challengeId,
                float timeSeconds,
                int score,
                AeroDrive.Missions.Medal medal,
                bool isFirstCompletion,
                bool isNewTimeRecord,
                bool isNewScoreRecord)
            {
                ChallengeId = challengeId;
                TimeSeconds = timeSeconds;
                Score = score;
                MedalEarned = medal;
                IsFirstCompletion = isFirstCompletion;
                IsNewTimeRecord = isNewTimeRecord;
                IsNewScoreRecord = isNewScoreRecord;
            }
        }

        /// <summary>Raised when a challenge run ends without being completed.</summary>
        public readonly struct ChallengeFailed
        {
            public readonly string ChallengeId;
            /// <summary>"timeout" or "retired". Both are shown differently in the results panel.</summary>
            public readonly string Reason;

            public ChallengeFailed(string challengeId, string reason)
            {
                ChallengeId = challengeId;
                Reason = reason;
            }
        }
    }
}
