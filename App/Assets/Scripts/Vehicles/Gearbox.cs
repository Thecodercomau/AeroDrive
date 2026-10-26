using System;
using UnityEngine;

namespace AeroDrive.Vehicles
{
    /// <summary>Gear encoding shared by the whole game: -1 reverse, 0 neutral, 1..N forward.</summary>
    public static class Gears
    {
        public const int Reverse = -1;
        public const int Neutral = 0;

        /// <summary>Label for the HUD: "R", "N", or the gear number.</summary>
        public static string Label(int gear)
        {
            if (gear == Reverse) return "R";
            if (gear == Neutral) return "N";
            return gear.ToString();
        }
    }

    /// <summary>Mutable state of one car's engine and transmission.</summary>
    [Serializable]
    public struct GearboxState
    {
        [Tooltip("Current gear. -1 reverse, 0 neutral, 1..N forward.")]
        public int gear;

        [Tooltip("True when the player shifts by hand instead of leaving it to the automatic.")]
        public bool manual;

        [Tooltip("Current engine speed in RPM.")]
        public float rpm;

        [Tooltip("Seconds left in the current shift. Torque is cut while this is positive.")]
        public float shiftTimer;

        [Tooltip("True when the last completed shift was up. Used to pick the shift sound.")]
        public bool lastShiftWasUp;

        [Tooltip("Total shifts since the car spawned. Diagnostics only.")]
        public int shiftCount;

        /// <summary>Neutral, engine off, automatic — the state a car starts a session in.</summary>
        public static GearboxState Default(bool manual = false)
        {
            return new GearboxState { gear = Gears.Neutral, manual = manual, rpm = 0f };
        }

        /// <summary>True while torque is not reaching the wheels.</summary>
        public bool IsShifting
        {
            get { return shiftTimer > 0f || gear == Gears.Neutral; }
        }

        public string GearLabel
        {
            get { return Gears.Label(gear); }
        }
    }

    /// <summary>What one step of the gearbox produced, for the controller to apply.</summary>
    public struct GearboxOutput
    {
        public int gear;
        public float rpm;
        public bool shifting;
        /// <summary>Engine torque after the throttle and the shift cut, in Nm.</summary>
        public float torque;
        /// <summary>Total reduction, negative in reverse.</summary>
        public float reduction;

        /// <summary>Fraction of the rev range, for the tachometer needle.</summary>
        public float RevFraction(float idleRpm, float redlineRpm)
        {
            float span = Mathf.Max(1f, redlineRpm - idleRpm);
            return Mathf.Clamp01((rpm - idleRpm) / span);
        }
    }

    /// <summary>
    /// Engine and transmission model.
    /// </summary>
    /// <remarks>
    /// Deliberately pure and static: it takes a wheel speed and a set of pedals, and returns an RPM,
    /// a gear, and a torque. Nothing here touches a Rigidbody, a Transform, or an AudioSource, so
    /// the entire shifting behaviour can be driven from a test that runs in milliseconds instead of
    /// waiting for a scene to load.
    ///
    /// This mirrors the web build's gearbox one-for-one — the same clutch-slip formula, the same
    /// downshift guard, the same reverse rules — so the two versions of the game drive alike.
    /// </remarks>
    public static class Gearbox
    {
        /// <summary>Wheel angular velocity below which the brake pedal engages reverse, in rad/s.</summary>
        public const float ReverseEngageWheelSpeed = 1.2f;

        /// <summary>Total reduction currently engaged, signed by rotation direction of travel.</summary>
        /// <remarks>Neutral returns zero so the engine coasts down toward idle instead of stalling.</remarks>
        public static float EffectiveReduction(int gear, VehicleConfig config)
        {
            if (gear == Gears.Neutral) return 0f;

            float finalDrive = config.finalDrive > 0.01f ? config.finalDrive : 3.4f;

            if (gear == Gears.Reverse)
            {
                float reverse = config.reverseRatio > 0.01f ? config.reverseRatio : 3.2f;
                return -reverse * finalDrive;
            }

            if (config.forwardRatios == null || gear < 1 || gear > config.forwardRatios.Length) return 0f;
            return config.forwardRatios[gear - 1] * finalDrive;
        }

        /// <summary>Engine RPM implied by a road speed, as if the drivetrain were rigidly coupled.</summary>
        /// <param name="wheelAngularVelocity">Wheel speed in rad/s. The sign is ignored.</param>
        public static float RpmFromWheelSpeed(float wheelAngularVelocity, int gear, VehicleConfig config)
        {
            float reduction = Mathf.Abs(EffectiveReduction(gear, config));
            if (reduction <= 0f) return 0f;
            float wheelRevolutionsPerSecond = Mathf.Abs(wheelAngularVelocity) / (2f * Mathf.PI);
            return wheelRevolutionsPerSecond * reduction * 60f;
        }

        /// <summary>Wheel angular velocity implied by an engine RPM in the current gear, in rad/s.</summary>
        public static float WheelSpeedFromRpm(float rpm, int gear, VehicleConfig config)
        {
            float reduction = Mathf.Abs(EffectiveReduction(gear, config));
            if (reduction <= 0f) return 0f;
            return (rpm / 60f) * 2f * Mathf.PI / reduction;
        }

        /// <summary>Engine torque at a given RPM, before the limiter is applied, in Nm.</summary>
        public static float TorqueAtRpm(float rpm, AnimationCurve torqueCurve)
        {
            if (torqueCurve == null || torqueCurve.length == 0) return 0f;
            return Mathf.Max(0f, torqueCurve.Evaluate(rpm));
        }

        /// <summary>Torque the engine delivers at this RPM, with the rev limiter applied, in Nm.</summary>
        public static float EngineTorque(float rpm, VehicleConfig config)
        {
            float idle = config.idleRpm > 0f ? config.idleRpm : 800f;
            float redline = config.redlineRpm > idle ? config.redlineRpm : idle + 1000f;

            // Hitting the limiter cuts torque completely, which is what makes the needle bounce.
            if (rpm > redline) return 0f;

            // The curve is authored from idle up; below idle the engine still pulls.
            return TorqueAtRpm(Mathf.Max(rpm, idle), config.torqueCurve);
        }

        /// <summary>Convert engine torque into the drive force one axle should apply.</summary>
        /// <param name="torque">Engine torque in Nm, after the throttle and shift cut.</param>
        /// <param name="reduction">Total reduction, signed.</param>
        /// <param name="wheelRadius">Metres. A non-positive radius yields zero force rather than an infinity.</param>
        /// <param name="axleShare">Fraction of the torque routed to this axle, 0..1.</param>
        public static float TorqueToWheelForce(
            float torque,
            float reduction,
            float wheelRadius,
            float axleShare = 1f)
        {
            if (wheelRadius <= 0.01f) return 0f;
            return torque * reduction * axleShare / wheelRadius;
        }

        /// <summary>
        /// Advance the gearbox one simulation step.
        /// </summary>
        /// <param name="state">Mutated in place.</param>
        /// <param name="wheelAngularVelocity">Average driven-wheel speed in rad/s.</param>
        /// <param name="throttle">0..1. Extra values are clamped.</param>
        /// <param name="brake">0..1. In reverse this is the accelerator, not the brake.</param>
        /// <param name="shiftUp">Manual upshift was requested this frame.</param>
        /// <param name="shiftDown">Manual downshift was requested this frame.</param>
        /// <param name="dt">Seconds since the last step.</param>
        /// <param name="config">Engine and drivetrain parameters.</param>
        public static GearboxOutput Step(
            ref GearboxState state,
            float wheelAngularVelocity,
            float throttle,
            float brake,
            bool shiftUp,
            bool shiftDown,
            float dt,
            VehicleConfig config)
        {
            float idleRpm = config.idleRpm > 0f ? config.idleRpm : 800f;
            float redlineRpm = config.redlineRpm > idleRpm ? config.redlineRpm : idleRpm + 1000f;
            float shiftUpRpm = config.shiftUpRpm > 0f ? config.shiftUpRpm : redlineRpm * 0.9f;
            float shiftDownRpm = config.shiftDownRpm > 0f ? config.shiftDownRpm : idleRpm * 1.6f;
            float shiftTime = Mathf.Max(0f, config.shiftTime);
            int gearCount = config.forwardRatios != null ? config.forwardRatios.Length : 0;

            throttle = Mathf.Clamp01(throttle);
            float brakePedal = Mathf.Clamp01(brake);

            // In reverse the brake pedal is the accelerator. The pedal that engaged reverse has to
            // be the one that drives it, or the player can never move backwards.
            float drivePedal = state.gear == Gears.Reverse ? brakePedal : throttle;

            if (state.shiftTimer > 0f)
            {
                state.shiftTimer = Mathf.Max(0f, state.shiftTimer - dt);
            }

            // Reverse can be requested from any gear: the player brakes to a stop and keeps holding.
            // The speed guard is what makes that safe — the pedal only becomes reverse once the
            // wheels have essentially stopped.
            bool reverseRequested = brakePedal > 0.5f
                                    && Mathf.Abs(wheelAngularVelocity) < ReverseEngageWheelSpeed
                                    && state.gear != Gears.Reverse;
            bool forwardRequested = throttle > 0.1f && state.gear == Gears.Neutral;

            if (state.manual)
            {
                StepManual(ref state, gearCount, shiftUp, shiftDown, shiftTime, forwardRequested);
            }
            else
            {
                StepAutomatic(
                    ref state,
                    gearCount,
                    wheelAngularVelocity,
                    throttle,
                    reverseRequested,
                    forwardRequested,
                    shiftUpRpm,
                    shiftDownRpm,
                    shiftTime,
                    config);
            }

            // --- RPM -----------------------------------------------------------
            float coupledRpm = RpmFromWheelSpeed(wheelAngularVelocity, state.gear, config);

            // Clutch slip: at low road speed the engine sits above the mechanically coupled RPM by an
            // amount that depends on the pedal. This is what makes pulling away feel right rather
            // than having the engine drop instantly to idle.
            float throttleRpm = Mathf.Lerp(idleRpm, redlineRpm * 0.92f, drivePedal);
            float clutchEngagement = Mathf.Clamp01(Mathf.Abs(coupledRpm) / (idleRpm * 2.2f));
            float targetRpm = Mathf.Max(coupledRpm, Mathf.Lerp(throttleRpm, coupledRpm, clutchEngagement));

            if (state.shiftTimer > 0f)
            {
                // Unloaded during a shift, so the engine tracks the pedal.
                state.rpm = Mathf.Lerp(state.rpm, throttleRpm, Mathf.Clamp01(dt * 8f));
            }
            else
            {
                // Engines are not infinitely responsive.
                state.rpm = Mathf.Lerp(state.rpm, targetRpm, Mathf.Clamp01(dt * 6f));
            }

            state.rpm = Mathf.Clamp(state.rpm, idleRpm, redlineRpm * 1.05f);

            GearboxOutput output;
            output.gear = state.gear;
            output.rpm = state.rpm;
            output.shifting = state.shiftTimer > 0f || state.gear == Gears.Neutral;
            output.torque = output.shifting ? 0f : EngineTorque(state.rpm, config) * drivePedal;
            output.reduction = EffectiveReduction(state.gear, config);
            return output;
        }

        private static void StepManual(
            ref GearboxState state,
            int gearCount,
            bool shiftUp,
            bool shiftDown,
            float shiftTime,
            bool forwardRequested)
        {
            if (state.shiftTimer <= 0f)
            {
                if (shiftUp)
                {
                    int next = state.gear < 1 ? 1 : Mathf.Min(gearCount, state.gear + 1);
                    if (next != state.gear)
                    {
                        state.gear = next;
                        state.shiftTimer = shiftTime;
                        state.lastShiftWasUp = true;
                        state.shiftCount++;
                    }
                }
                else if (shiftDown)
                {
                    int next = Mathf.Max(Gears.Neutral, state.gear - 1);
                    if (next != state.gear)
                    {
                        state.gear = next;
                        state.shiftTimer = shiftTime;
                        state.lastShiftWasUp = false;
                        state.shiftCount++;
                    }
                }
            }

            // Manual still needs the game to select first from neutral, otherwise a player who never
            // touches the shift keys sits at a standstill with the throttle pinned.
            if (forwardRequested && state.shiftTimer <= 0f && state.gear == Gears.Neutral)
            {
                state.gear = 1;
                state.shiftTimer = shiftTime;
                state.lastShiftWasUp = true;
                state.shiftCount++;
            }
        }

        private static void StepAutomatic(
            ref GearboxState state,
            int gearCount,
            float wheelAngularVelocity,
            float throttle,
            bool reverseRequested,
            bool forwardRequested,
            float shiftUpRpm,
            float shiftDownRpm,
            float shiftTime,
            VehicleConfig config)
        {
            if (state.shiftTimer > 0f) return;

            if (reverseRequested)
            {
                state.gear = Gears.Reverse;
                state.shiftCount++;
                return;
            }

            if (state.gear == Gears.Reverse && throttle > 0.1f)
            {
                state.gear = 1;
                state.shiftTimer = shiftTime;
                state.lastShiftWasUp = true;
                state.shiftCount++;
                return;
            }

            if (state.gear == Gears.Neutral && (forwardRequested || reverseRequested))
            {
                state.gear = reverseRequested ? Gears.Reverse : 1;
                state.shiftTimer = shiftTime;
                state.lastShiftWasUp = true;
                state.shiftCount++;
                return;
            }

            if (state.gear < 1) return;

            float currentRpm = RpmFromWheelSpeed(wheelAngularVelocity, state.gear, config);

            // The RPM the engine would be doing one gear lower. The downshift guard must look at
            // gear - 1; looking at gear + 1 makes top gear un-leavable, because that is where the
            // driver is trying to go.
            float lowerGearRpm = RpmFromWheelSpeed(wheelAngularVelocity, state.gear - 1, config);

            if (currentRpm > shiftUpRpm && state.gear < gearCount)
            {
                state.gear += 1;
                state.shiftTimer = shiftTime;
                state.lastShiftWasUp = true;
                state.shiftCount++;
            }
            else if (state.gear > 1 && currentRpm < shiftDownRpm && lowerGearRpm < shiftUpRpm * 0.95f)
            {
                // Only downshift when the resulting RPM would still be sane. Without this check the
                // box oscillates between two gears under light throttle.
                state.gear -= 1;
                state.shiftTimer = shiftTime;
                state.lastShiftWasUp = false;
                state.shiftCount++;
            }
        }
    }
}
