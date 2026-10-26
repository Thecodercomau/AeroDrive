using AeroDrive.SaveSystem;
using UnityEngine;

namespace AeroDrive.Input
{
    /// <summary>
    /// The input source the game actually uses: merges the keyboard and any gamepad into one state.
    /// </summary>
    /// <remarks>
    /// Both devices are always live, and their inputs are combined rather than switched between.
    /// Switching adds a mode the player has to think about ("why is my keyboard not working?") and
    /// gets it wrong whenever someone nudges a stick by accident. Merging takes the larger value for
    /// each analogue axis — so pressing `W` while a stick is idle still works — and ORs the buttons.
    /// </remarks>
    public sealed class VehicleInput : IVehicleInputSource
    {
        private readonly KeyboardInputSource _keyboard;
        private readonly GamepadInputSource _gamepad;
        /// <summary>
        /// Scratch state reused every frame so <see cref="Read"/> allocates nothing. Not
        /// <c>readonly</c>: the fields are assigned in place rather than the whole struct being
        /// replaced, and C# rejects member assignment through a <c>readonly</c> struct field.
        /// </summary>
        private VehicleInputState _merged;

        /// <summary>When false, reads return neutral. Used while a menu is open.</summary>
        public bool Enabled { get; set; }

        public VehicleInput(GameSettings settings)
        {
            _keyboard = new KeyboardInputSource(settings);
            _gamepad = new GamepadInputSource(settings);
            Enabled = true;
        }

        /// <summary>True when a controller is connected.</summary>
        public bool GamepadConnected
        {
            get { return _gamepad.IsConnected; }
        }

        /// <summary>Access to the keyboard half, for the settings menu's "press a key" rebinding.</summary>
        public KeyboardInputSource Keyboard
        {
            get { return _keyboard; }
        }

        /// <inheritdoc />
        public VehicleInputState Read(float deltaTime)
        {
            if (!Enabled)
            {
                // Clearing the keyboard's internal ramps matters: without it, letting go of the
                // throttle while paused would leave the car accelerating when play resumes.
                _keyboard.Clear();
                return VehicleInputState.Neutral();
            }

            VehicleInputState keyboard = _keyboard.Read(deltaTime);
            VehicleInputState gamepad = _gamepad.Read(deltaTime);

            _merged.throttle = Mathf.Max(keyboard.throttle, gamepad.throttle);
            _merged.brake = Mathf.Max(keyboard.brake, gamepad.brake);

            // Steering takes whichever device is asking for more, preserving that device's sign.
            _merged.steer = Mathf.Abs(keyboard.steer) >= Mathf.Abs(gamepad.steer)
                ? keyboard.steer
                : gamepad.steer;

            _merged.handbrake = keyboard.handbrake || gamepad.handbrake;
            _merged.shiftUp = keyboard.shiftUp || gamepad.shiftUp;
            _merged.shiftDown = keyboard.shiftDown || gamepad.shiftDown;
            _merged.toggleCamera = keyboard.toggleCamera || gamepad.toggleCamera;
            _merged.recover = keyboard.recover || gamepad.recover;
            _merged.toggleHeadlights = keyboard.toggleHeadlights || gamepad.toggleHeadlights;
            _merged.horn = keyboard.horn || gamepad.horn;

            _merged.lookYawDegrees = 0f;
            _merged.lookPitchDegrees = 0f;

            return _merged;
        }
    }
}
