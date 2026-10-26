namespace AeroDrive.Vehicles
{
    /// <summary>
    /// The brake-torque rules that are not a straight pass-through of the pedal.
    /// </summary>
    /// <remarks>
    /// Split out of <see cref="VehicleController"/> as a pure function for the same reason
    /// <see cref="Gearbox"/> is one: it is a rule, not a simulation, and a rule that can be called with
    /// numbers is a rule that can be tested without a scene. The car's behaviour on the brakes — does
    /// it stop, does it stay stopped, can it still be steered — is almost entirely decided here.
    ///
    /// Two things this rules out, both of which were real bugs:
    ///
    /// * **Releasing the brake whenever a wheel is not turning.** That reads as "the wheel has locked,
    ///   so let it go", which is what ABS does — but a wheel that is not turning because the *car* is
    ///   not moving has not locked at all. Cutting the brake there means the car cannot be held still
    ///   on a slope and creeps away from rest, which the player experiences as the brakes failing.
    /// * **Deciding that from the drive torque.** Whether the brakes are working has nothing to do
    ///   with how hard the engine is pushing.
    /// </remarks>
    public static class BrakeAssist
    {
        /// <summary>Road speed below which ABS does nothing at all, in km/h.</summary>
        /// <remarks>
        /// Walking pace. Real ABS disengages at low speed for exactly this reason: below it, a wheel
        /// that is not turning is the intended outcome, not a lock-up to be corrected.
        /// </remarks>
        public const float AbsCutoffKmh = 5f;

        /// <summary>Wheel speed below which a moving car's wheel counts as locked, in RPM.</summary>
        public const float LockedWheelRpm = 5f;

        /// <summary>Fraction of the requested brake torque a locked wheel is released to.</summary>
        /// <remarks>
        /// A quarter, not zero: real ABS releases and re-applies in bursts, and a full release on every
        /// step would make the pedal feel like it had been disconnected.
        /// </remarks>
        public const float LockedWheelRelease = 0.25f;

        /// <summary>
        /// Brake torque one wheel should actually receive.
        /// </summary>
        /// <param name="requested">Torque the pedal is asking for, in Nm. Negative values are treated as zero.</param>
        /// <param name="wheelRpm">The wheel's current speed in RPM, from the wheel collider.</param>
        /// <param name="speedKmh">The car's road speed in km/h.</param>
        /// <param name="absEnabled">Whether this car has ABS fitted.</param>
        /// <returns>The torque to apply to that wheel.</returns>
        public static float ServiceBrake(float requested, float wheelRpm, float speedKmh, bool absEnabled)
        {
            if (requested <= 0f) return 0f;
            if (!absEnabled) return requested;

            // Standing still, or nearly: the brakes are doing their job, so hand back everything the
            // pedal asked for. This is the case a locked-wheel test alone gets wrong.
            if (speedKmh < AbsCutoffKmh) return requested;

            // Moving, and this wheel has stopped turning: it has locked. Release it so it can start
            // rolling again and the driver keeps some steering.
            if (System.Math.Abs(wheelRpm) < LockedWheelRpm) return requested * LockedWheelRelease;

            return requested;
        }
    }
}
