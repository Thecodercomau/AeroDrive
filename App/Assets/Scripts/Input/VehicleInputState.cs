namespace AeroDrive.Input
{
    /// <summary>
    /// One frame of driver input, already normalised.
    /// </summary>
    /// <remarks>
    /// Every source produces this shape, which is what lets the vehicle controller stay ignorant of
    /// keyboards and gamepads — and what makes "the car accelerates when you hold W" a pure unit
    /// test rather than a play-mode test.
    /// </remarks>
    public struct VehicleInputState
    {
        /// <summary>Throttle pedal, 0 (off) to 1 (floored).</summary>
        public float throttle;

        /// <summary>Brake pedal, 0 to 1. Doubles as the reverse control from a standstill.</summary>
        public float brake;

        /// <summary>Steering, -1 (full left) to +1 (full right).</summary>
        public float steer;

        /// <summary>Handbrake is on. Locks the rear wheels.</summary>
        public bool handbrake;

        /// <summary>Momentary: upshift requested this frame.</summary>
        public bool shiftUp;

        /// <summary>Momentary: downshift requested this frame.</summary>
        public bool shiftDown;

        /// <summary>Momentary: cycle the camera.</summary>
        public bool toggleCamera;

        /// <summary>Momentary: recover the vehicle.</summary>
        public bool recover;

        /// <summary>Momentary: toggle headlights.</summary>
        public bool toggleHeadlights;

        /// <summary>Momentary: sound the horn.</summary>
        public bool horn;

        /// <summary>Axis the player is looking along this frame, in degrees. Mouse and right stick.</summary>
        public float lookYawDegrees;
        public float lookPitchDegrees;

        public static VehicleInputState Neutral()
        {
            return new VehicleInputState();
        }
    }

    /// <summary>
    /// Anything that can drive a car: a keyboard, a gamepad, an AI, or a replay.
    /// </summary>
    /// <remarks>
    /// Deliberately tiny. The vehicle controller depends on this interface and nothing else, so an
    /// AI driver for traffic is a new implementation rather than a change to the controller.
    /// </remarks>
    public interface IVehicleInputSource
    {
        /// <summary>Sample the current input. Must not allocate.</summary>
        VehicleInputState Read(float deltaTime);
    }
}
