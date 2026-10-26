using AeroDrive.Vehicles;
using NUnit.Framework;

namespace AeroDrive.Tests
{
    /// <summary>
    /// Tests for the brake-torque rules.
    /// </summary>
    /// <remarks>
    /// Every case below is a way the brakes have been wrong: a car that could not be held on a slope
    /// because ABS released the brakes at a standstill, and ABS that never released at all because the
    /// test for a locked wheel was really a test for a stationary car.
    /// </remarks>
    public class BrakeAssistTests
    {
        [Test]
        public void ServiceBrake_PassesThePedalThroughWithNoAbsFitted()
        {
            Assert.AreEqual(400f, BrakeAssist.ServiceBrake(400f, 0f, 0f, false), 0.0001f);
            Assert.AreEqual(400f, BrakeAssist.ServiceBrake(400f, 0f, 200f, false), 0.0001f);
        }

        [Test]
        public void ServiceBrake_ReleasesALockedWheelWhileTheCarIsMoving()
        {
            // A wheel that has stopped turning while the car is still rolling is locked, which is the
            // one case ABS exists to correct.
            float released = BrakeAssist.ServiceBrake(400f, 0f, 80f, true);
            Assert.AreEqual(400f * BrakeAssist.LockedWheelRelease, released, 0.0001f);
            Assert.Greater(released, 0f, "A full release on every step makes the pedal feel disconnected.");
        }

        [Test]
        public void ServiceBrake_DoesNotReleaseTheBrakesAtAStandstill()
        {
            // The car is moving at walking pace or less. A wheel at zero RPM there has not locked: it is
            // the outcome the driver asked for. Cutting the torque means the car cannot be held on a
            // slope and creeps away from rest.
            Assert.AreEqual(400f, BrakeAssist.ServiceBrake(400f, 0f, 0f, true), 0.0001f);
            Assert.AreEqual(400f, BrakeAssist.ServiceBrake(400f, 0f, 4.9f, true), 0.0001f);
        }

        [Test]
        public void ServiceBrake_NeverInventsTorque()
        {
            Assert.AreEqual(0f, BrakeAssist.ServiceBrake(0f, 0f, 100f, true), 0.0001f);
            Assert.AreEqual(0f, BrakeAssist.ServiceBrake(-50f, 0f, 100f, true), 0.0001f);
        }

        [Test]
        public void ServiceBrake_LeavesARollingWheelAlone()
        {
            Assert.AreEqual(400f, BrakeAssist.ServiceBrake(400f, 300f, 100f, true), 0.0001f);
        }
    }
}
