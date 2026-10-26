using AeroDrive.Vehicles;
using NUnit.Framework;
using UnityEngine;

namespace AeroDrive.Tests
{
    /// <summary>
    /// Tests for the engine and transmission.
    /// </summary>
    /// <remarks>
    /// These run in EditMode with no scene and no physics, which is the whole reason the gearbox is a
    /// pure function. Every case below is a rule that has been got wrong at some point: reverse that
    /// drove forwards, a top gear that could not be left, a downshift that hunted between two gears.
    /// Expressing them here means they cannot come back.
    /// </remarks>
    public class GearboxTests
    {
        private VehicleConfig _config;

        /// <summary>Wheel speed in rad/s that puts the engine at roughly the given RPM in a gear.</summary>
        private float WheelSpeedForRpm(float rpm, int gear)
        {
            return Gearbox.WheelSpeedFromRpm(rpm, gear, _config);
        }

        [SetUp]
        public void SetUp()
        {
            _config = ScriptableObject.CreateInstance<VehicleConfig>();
            _config.idleRpm = 800f;
            _config.redlineRpm = 6200f;
            _config.shiftUpRpm = 5400f;
            _config.shiftDownRpm = 1400f;
            _config.shiftTime = 0.28f;
            _config.finalDrive = 3.9f;
            _config.reverseRatio = 3.2f;
            _config.forwardRatios = new[] { 3.6f, 2.1f, 1.4f, 1.05f, 0.82f };
            _config.torqueCurve = AnimationCurve.Linear(0f, 0f, 8000f, 120f);
        }

        [TearDown]
        public void TearDown()
        {
            Object.DestroyImmediate(_config);
        }

        [Test]
        public void EffectiveReduction_IsZeroInNeutral()
        {
            Assert.AreEqual(0f, Gearbox.EffectiveReduction(Gears.Neutral, _config), 0.0001f);
        }

        [Test]
        public void EffectiveReduction_IsNegativeInReverse()
        {
            // The sign is what makes a car in reverse move backwards. Losing it is a one-character
            // mistake with a very visible result, so it is asserted directly.
            float reduction = Gearbox.EffectiveReduction(Gears.Reverse, _config);
            Assert.Less(reduction, 0f);
            Assert.AreEqual(-3.2f * 3.9f, reduction, 0.0001f);
        }

        [Test]
        public void EffectiveReduction_TopGearIsLowerThanFirst()
        {
            float first = Gearbox.EffectiveReduction(1, _config);
            float top = Gearbox.EffectiveReduction(_config.forwardRatios.Length, _config);

            Assert.Greater(first, top);
        }

        [Test]
        public void RpmFromWheelSpeed_RoundTripsThroughWheelSpeedFromRpm()
        {
            float wheelSpeed = WheelSpeedForRpm(3000f, 3);
            Assert.AreEqual(3000f, Gearbox.RpmFromWheelSpeed(wheelSpeed, 3, _config), 0.5f);
        }

        [Test]
        public void WheelSpeedFromRpm_IsZeroInNeutral()
        {
            Assert.AreEqual(0f, Gearbox.WheelSpeedFromRpm(3000f, Gears.Neutral, _config), 0.0001f);
        }

        [Test]
        public void EngineTorque_IsZeroAboveTheRedline()
        {
            Assert.AreEqual(0f, Gearbox.EngineTorque(_config.redlineRpm + 500f, _config), 0.0001f);
            Assert.Greater(Gearbox.EngineTorque(3000f, _config), 0f);
        }

        [Test]
        public void Step_EngagesFirstGearFromNeutralWhenTheThrottleIsApplied()
        {
            GearboxState state = GearboxState.Default();

            GearboxOutput output = Gearbox.Step(ref state, 0f, 1f, 0f, false, false, 0.02f, _config);

            Assert.AreEqual(1, output.gear);
            // The shift is in progress, so no torque reaches the wheels on the frame it happens.
            Assert.IsTrue(output.shifting);
            Assert.AreEqual(0f, output.torque, 0.0001f);
        }

        [Test]
        public void Step_ReachesTheWheelsOnceTheShiftCompletes()
        {
            GearboxState state = GearboxState.Default();
            Gearbox.Step(ref state, 0f, 1f, 0f, false, false, 0.02f, _config);

            // Let the shift time run out, then hold the throttle with the wheels barely turning.
            for (float t = 0f; t < _config.shiftTime + 0.05f; t += 0.02f)
            {
                Gearbox.Step(ref state, 0f, 1f, 0f, false, false, 0.02f, _config);
            }

            GearboxOutput output = Gearbox.Step(ref state, 0f, 1f, 0f, false, false, 0.02f, _config);

            Assert.IsFalse(output.shifting);
            Assert.Greater(output.torque, 0f);
            Assert.AreEqual(1, output.gear);
        }

        [Test]
        public void Step_UpshiftsOnceTheEnginePassesTheUpshiftSpeed()
        {
            GearboxState state = GearboxState.Default();
            state.gear = 2;

            float wheelSpeed = WheelSpeedForRpm(_config.shiftUpRpm + 300f, 2);
            GearboxOutput output = Gearbox.Step(ref state, wheelSpeed, 1f, 0f, false, false, 0.02f, _config);

            Assert.AreEqual(3, output.gear);
        }

        [Test]
        public void Step_DoesNotUpshiftBeyondTopGear()
        {
            int topGear = _config.forwardRatios.Length;
            GearboxState state = GearboxState.Default();
            state.gear = topGear;

            float wheelSpeed = WheelSpeedForRpm(_config.shiftUpRpm + 1000f, topGear);
            GearboxOutput output = Gearbox.Step(ref state, wheelSpeed, 1f, 0f, false, false, 0.02f, _config);

            Assert.AreEqual(topGear, output.gear);
        }

        [Test]
        public void Step_IsAbleToLeaveTopGear()
        {
            int topGear = _config.forwardRatios.Length;
            GearboxState state = GearboxState.Default();
            state.gear = topGear;

            // Crawling in top gear must downshift. This is the case the old guard got wrong by
            // looking at the gear above instead of the gear below.
            float wheelSpeed = WheelSpeedForRpm(_config.shiftDownRpm * 0.5f, topGear);
            GearboxOutput output = Gearbox.Step(ref state, wheelSpeed, 0.2f, 0f, false, false, 0.02f, _config);

            Assert.Less(output.gear, topGear);
        }

        [Test]
        public void Step_DoesNotGearHuntAtAConstantSpeed()
        {
            GearboxState state = GearboxState.Default();
            state.gear = 3;

            // A speed where third sits comfortably between the shift points. Held for five seconds,
            // the box must settle on one gear rather than oscillating every step.
            float wheelSpeed = WheelSpeedForRpm((_config.shiftUpRpm + _config.shiftDownRpm) * 0.5f, 3);

            GearboxOutput output = default;
            int shifts = 0;
            int previous = state.gear;

            for (int i = 0; i < 250; i++)
            {
                output = Gearbox.Step(ref state, wheelSpeed, 0.5f, 0f, false, false, 0.02f, _config);
                if (output.gear != previous)
                {
                    shifts++;
                    previous = output.gear;
                }
            }

            Assert.LessOrEqual(shifts, 1, "The gearbox hunted between gears at a steady speed.");
        }

        [Test]
        public void Step_EngagesReverseOnlyFromAStandstill()
        {
            GearboxState state = GearboxState.Default();
            state.gear = 1;

            // Moving forwards: the brake is a brake, not a request to reverse.
            GearboxOutput moving = Gearbox.Step(ref state, 20f, 0f, 1f, false, false, 0.02f, _config);
            Assert.AreEqual(1, moving.gear);

            // Stopped: holding the brake engages reverse.
            GearboxOutput stopped = Gearbox.Step(ref state, 0f, 0f, 1f, false, false, 0.02f, _config);
            Assert.AreEqual(Gears.Reverse, stopped.gear);
            Assert.Less(stopped.reduction, 0f);
        }

        [Test]
        public void Step_UsesTheBrakePedalAsTheAcceleratorInReverse()
        {
            GearboxState state = GearboxState.Default();
            state.gear = Gears.Reverse;

            // Run past the shift timer so the revs settle.
            for (int i = 0; i < 40; i++)
            {
                Gearbox.Step(ref state, -10f, 0f, 1f, false, false, 0.02f, _config);
            }

            GearboxOutput output = Gearbox.Step(ref state, -10f, 0f, 1f, false, false, 0.02f, _config);

            Assert.Greater(output.torque, 0f, "Reverse has no way to drive the wheels.");
            Assert.Less(output.reduction, 0f);
        }

        [Test]
        public void Step_LeavesReverseWhenTheThrottleIsApplied()
        {
            GearboxState state = GearboxState.Default();
            state.gear = Gears.Reverse;

            GearboxOutput output = Gearbox.Step(ref state, -5f, 1f, 0f, false, false, 0.02f, _config);

            Assert.AreEqual(1, output.gear);
        }

        [Test]
        public void Step_ManualModeIgnoresTheAutomaticUpshift()
        {
            GearboxState state = GearboxState.Default(manual: true);
            state.gear = 2;

            float wheelSpeed = WheelSpeedForRpm(_config.shiftUpRpm + 2000f, 2);

            for (int i = 0; i < 20; i++)
            {
                Gearbox.Step(ref state, wheelSpeed, 1f, 0f, false, false, 0.02f, _config);
            }

            Assert.AreEqual(2, state.gear, "A manual gearbox shifted itself.");
        }

        [Test]
        public void Step_ManualModeShiftsOnlyWhenAsked()
        {
            GearboxState state = GearboxState.Default(manual: true);
            state.gear = 2;

            float wheelSpeed = WheelSpeedForRpm(3000f, 2);

            Gearbox.Step(ref state, wheelSpeed, 1f, 0f, true, false, 0.02f, _config);
            Assert.AreEqual(3, state.gear);
            Assert.Greater(state.shiftTimer, 0f, "An upshift should cut torque for the shift time.");

            // A second request while the shift is in progress must be ignored.
            Gearbox.Step(ref state, wheelSpeed, 1f, 0f, true, false, 0.02f, _config);
            Assert.AreEqual(3, state.gear);
        }

        [Test]
        public void Step_ManualModeNeverShiftsBelowNeutral()
        {
            GearboxState state = GearboxState.Default(manual: true);
            state.gear = 1;

            Gearbox.Step(ref state, 0f, 0f, 0f, false, true, 0.02f, _config);
            Assert.AreEqual(Gears.Neutral, state.gear);

            for (int i = 0; i < 30; i++)
            {
                Gearbox.Step(ref state, 0f, 0f, 0f, false, true, 0.02f, _config);
            }

            Assert.AreEqual(Gears.Neutral, state.gear);
        }

        [Test]
        public void Step_ClampsRpmBetweenIdleAndTheLimiter()
        {
            GearboxState state = GearboxState.Default();
            state.gear = 1;

            Gearbox.Step(ref state, 0f, 0f, 0f, false, false, 0.02f, _config);
            Assert.GreaterOrEqual(state.rpm, _config.idleRpm * 0.999f);

            // Spinning the wheels far beyond the redline must not push the engine past the limiter
            // by more than the tolerance the limiter allows.
            //
            // The wheels at ten times the redline do not simply sit on the limiter: the box sees an
            // over-revving engine and shifts up, and each shift cuts torque for `shiftTime`. With
            // five gears that is up to 1.4 s of shifting, which is longer than a two-second loop — and
            // during a shift the clutch is open, so the engine is unloaded and sits at its throttle
            // RPM instead of on the limiter. The loop therefore runs until the box has stopped
            // shifting and the wheels are finally driving the engine again, which is the state this
            // test is about. Asserting mid-shift would only be asserting that a shift was in progress.
            float insaneWheelSpeed = WheelSpeedForRpm(_config.redlineRpm * 10f, 1);

            // Long enough for every upshift and its shift time to have run their course: at 20 ms a
            // step, 400 steps is eight seconds, against a worst case of four shifts at 280 ms each.
            for (int i = 0; i < 400; i++)
            {
                Gearbox.Step(ref state, insaneWheelSpeed, 1f, 0f, false, false, 0.02f, _config);
            }

            Assert.LessOrEqual(state.shiftTimer, 0f, "The box never finished shifting.");
            Assert.AreEqual(_config.forwardRatios.Length, state.gear, "Over-revving must reach top gear.");
            Assert.LessOrEqual(state.rpm, _config.redlineRpm * 1.05f + 0.01f);
            // And at that wheel speed the limiter is holding the RPM at its clamp, not merely below it.
            Assert.AreEqual(_config.redlineRpm * 1.05f, state.rpm, 0.5f, "The limiter clamp should be reached.");
            Assert.AreEqual(0f, Gearbox.EngineTorque(state.rpm, _config), 0.0001f);
        }

        [Test]
        public void Step_CountsEveryShift()
        {
            GearboxState state = GearboxState.Default();
            Gearbox.Step(ref state, 0f, 1f, 0f, false, false, 0.02f, _config);

            Assert.AreEqual(1, state.shiftCount);
        }

        [Test]
        public void TorqueToWheelForce_HalvesWhenTheAxleTakesHalfTheTorque()
        {
            float full = Gearbox.TorqueToWheelForce(200f, 10f, 0.31f, 1f);
            float half = Gearbox.TorqueToWheelForce(200f, 10f, 0.31f, 0.5f);

            Assert.AreEqual(full * 0.5f, half, 0.0001f);
            Assert.Greater(full, 0f);
        }

        [Test]
        public void TorqueToWheelForce_IsZeroWhenTheWheelRadiusIsInvalid()
        {
            // A zero radius would otherwise divide by zero and hand the physics engine an infinity,
            // which turns into an invisible teleport rather than an error.
            Assert.AreEqual(0f, Gearbox.TorqueToWheelForce(200f, 10f, 0f));
            Assert.AreEqual(0f, Gearbox.TorqueToWheelForce(200f, 10f, -1f));
        }

        [Test]
        public void GearLabels_AreReadable()
        {
            Assert.AreEqual("R", Gears.Label(Gears.Reverse));
            Assert.AreEqual("N", Gears.Label(Gears.Neutral));
            Assert.AreEqual("4", Gears.Label(4));
        }

        [Test]
        public void VehicleConfig_ValidateRepairsAnEmptyGearList()
        {
            _config.forwardRatios = new float[0];
            _config.Validate();

            Assert.Greater(_config.forwardRatios.Length, 0, "A car with no gears cannot move.");
        }

        [Test]
        public void VehicleConfig_ValidateKeepsTheCentreOfMassInsideTheChassis()
        {
            _config.chassisHalfExtents = new Vector3(0.8f, 0.6f, 1.9f);
            _config.centreOfMass = new Vector3(0f, 5f, 0f);
            _config.Validate();

            Assert.LessOrEqual(_config.centreOfMass.y, 0.6f);
        }

        [Test]
        public void VehicleConfig_ValidateKeepsTheRedlineAboveIdle()
        {
            _config.idleRpm = 3000f;
            _config.redlineRpm = 1000f;
            _config.Validate();

            Assert.Greater(_config.redlineRpm, _config.idleRpm);
        }

        [Test]
        public void VehicleConfig_TorqueShares_FollowTheDrivetrain()
        {
            _config.drivetrain = DrivetrainType.FrontWheelDrive;
            Assert.AreEqual(1f, _config.FrontTorqueShare, 0.0001f);
            Assert.AreEqual(0f, _config.RearTorqueShare, 0.0001f);

            _config.drivetrain = DrivetrainType.RearWheelDrive;
            Assert.AreEqual(0f, _config.FrontTorqueShare, 0.0001f);
            Assert.AreEqual(1f, _config.RearTorqueShare, 0.0001f);

            _config.drivetrain = DrivetrainType.AllWheelDrive;
            Assert.AreEqual(0.5f, _config.FrontTorqueShare, 0.0001f);
            Assert.AreEqual(0.5f, _config.RearTorqueShare, 0.0001f);
        }
    }
}
