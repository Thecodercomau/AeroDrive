using AeroDrive.SaveSystem;
using UnityEngine;

namespace AeroDrive.Input
{
    /// <summary>
    /// Drives a car from a connected game controller.
    /// </summary>
    /// <remarks>
    /// Reads the standard "old" Input Manager axes directly rather than relying on a project Input
    /// Manager asset, so no ProjectSettings asset has to be shipped for this to work. Those axes
    /// ("Horizontal", "Vertical", the trigger axes and joystick buttons) are part of Unity's default
    /// input configuration on every platform.
    ///
    /// Reports <see cref="IsConnected"/> so the HUD can tell the player a pad was found, and the
    /// combined source can prefer the pad when it is being used.
    /// <para>
    /// The UnityEngine API is spelled out as <c>UnityEngine.Input</c> throughout. Inside the
    /// <c>AeroDrive.Input</c> namespace the bare name <c>Input</c> resolves to the namespace, not to
    /// the class, so <c>Input.GetAxisRaw(...)</c> does not compile here.
    /// </para>
    /// </remarks>
    public sealed class GamepadInputSource : IVehicleInputSource
    {
        private readonly GameSettings _settings;

        /// <summary>Axis index for the pad's left stick and triggers, using the default Input Manager layout.</summary>
        private const string AxisHorizontal = "Horizontal";
        private const string AxisVertical = "Vertical";

        private bool _lastThrottleDown;
        private bool _lastCameraDown;
        private bool _lastRecoverDown;

        public GamepadInputSource(GameSettings settings)
        {
            _settings = settings;
        }

        /// <summary>True when at least one controller is plugged in.</summary>
        public bool IsConnected
        {
            get
            {
                // GetJoystickNames returns an array whose entries are empty strings for disconnected
                // pads, so the length alone is not a reliable answer.
                string[] names = UnityEngine.Input.GetJoystickNames();
                for (int i = 0; i < names.Length; i++)
                {
                    if (!string.IsNullOrEmpty(names[i])) return true;
                }

                return false;
            }
        }

        /// <inheritdoc />
        public VehicleInputState Read(float deltaTime)
        {
            VehicleInputState state = VehicleInputState.Neutral();

            float deadzone = _settings != null ? _settings.gamepadDeadzone : 0.12f;
            float steer = ApplyDeadzone(UnityEngine.Input.GetAxisRaw(AxisHorizontal), deadzone);
            float vertical = ApplyDeadzone(UnityEngine.Input.GetAxisRaw(AxisVertical), deadzone);

            // Negative vertical is "up" on a standard pad, which is forward.
            if (vertical < 0f) state.throttle = -vertical;
            else if (vertical > 0f) state.brake = vertical;

            state.steer = steer;

            // Analogue triggers, when the connected pad exposes them.
            float rightTrigger = SafeAxis("RightTrigger");
            float leftTrigger = SafeAxis("LeftTrigger");
            if (rightTrigger > 0.02f) state.throttle = Mathf.Max(state.throttle, rightTrigger);
            if (leftTrigger > 0.02f) state.brake = Mathf.Max(state.brake, leftTrigger);

            // Button layout follows the common Xbox-style mapping.
            state.handbrake = UnityEngine.Input.GetKey(KeyCode.JoystickButton0);
            state.shiftUp = UnityEngine.Input.GetKey(KeyCode.JoystickButton5);
            state.shiftDown = UnityEngine.Input.GetKey(KeyCode.JoystickButton4);
            state.horn = UnityEngine.Input.GetKey(KeyCode.JoystickButton2);

            state.toggleCamera = Edge(UnityEngine.Input.GetKey(KeyCode.JoystickButton3), ref _lastCameraDown);
            state.recover = Edge(UnityEngine.Input.GetKey(KeyCode.JoystickButton1), ref _lastRecoverDown);

            _lastThrottleDown = state.throttle > 0.5f;

            return state;
        }

        /// <summary>True when the pad is actually being touched, so it can take priority over the keyboard.</summary>
        public bool IsInUse
        {
            get
            {
                return _lastThrottleDown
                       || Mathf.Abs(UnityEngine.Input.GetAxisRaw(AxisHorizontal)) > 0.2f
                       || Mathf.Abs(UnityEngine.Input.GetAxisRaw(AxisVertical)) > 0.2f;
            }
        }

        private static bool Edge(bool isDownNow, ref bool wasDownLastFrame)
        {
            bool pressed = isDownNow && !wasDownLastFrame;
            wasDownLastFrame = isDownNow;
            return pressed;
        }

        private static float ApplyDeadzone(float value, float deadzone)
        {
            if (Mathf.Abs(value) < deadzone) return 0f;

            // Rescale so the stick still reaches full lock: without this, the first movement after
            // the deadzone would jump straight to `deadzone` instead of starting from zero.
            float sign = Mathf.Sign(value);
            return sign * ((Mathf.Abs(value) - deadzone) / (1f - deadzone));
        }

        /// <summary>Read an axis that may not exist on this platform's default layout.</summary>
        private static float SafeAxis(string axisName)
        {
            try
            {
                return UnityEngine.Input.GetAxisRaw(axisName);
            }
            catch (System.ArgumentException)
            {
                // Unity throws for an axis that is not configured. A pad without analogue triggers
                // is a normal situation, not an error.
                return 0f;
            }
        }
    }
}
