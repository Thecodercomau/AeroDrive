using System;
using System.Collections.Generic;
using AeroDrive.SaveSystem;
using UnityEngine;

namespace AeroDrive.Input
{
    /// <summary>
    /// Drives a car from the keyboard, using a rebindable key map.
    /// </summary>
    /// <remarks>
    /// Uses the built-in <see cref="UnityEngine.Input"/> API, which works in a project whose
    /// **Active Input Handling** is set to "Input Manager (Old)" or "Both". That is the default for a
    /// project created without a template, and it keeps this project free of a package dependency.
    ///
    /// If you later install the Input System package and switch Active Input Handling to "Input
    /// System Package (New)", this class stops receiving input. Either set it to "Both", or write a
    /// new <see cref="IVehicleInputSource"/> for the new system — the vehicle controller will not
    /// need to change, which is the point of the interface.
    ///
    /// Keyboard steering and pedals are ramped rather than switched on and off, because a binary
    /// 0-or-1 throttle makes a heavy car feel like it is being pushed by a switch.
    /// <para>
    /// The UnityEngine API is spelled out as <c>UnityEngine.Input</c>. Inside this
    /// <c>AeroDrive.Input</c> namespace the bare name <c>Input</c> resolves to the namespace itself,
    /// so <c>Input.GetKey(...)</c> would not compile.
    /// </para>
    /// </remarks>
    public sealed class KeyboardInputSource : IVehicleInputSource
    {
        private readonly GameSettings _settings;
        private readonly List<KeyCode> _scratch = new List<KeyCode>(4);

        private float _throttle;
        private float _brake;
        private float _steer;

        /// <summary>How fast the pedals reach full travel, in units per second.</summary>
        public float pedalResponse = 5f;

        /// <summary>How fast the steering wheel reaches full lock, and how fast it self-centres.</summary>
        public float steerResponse = 4f;
        public float steerReturnResponse = 8f;

        public KeyboardInputSource(GameSettings settings)
        {
            _settings = settings;
        }

        /// <inheritdoc />
        public VehicleInputState Read(float deltaTime)
        {
            VehicleInputState state = VehicleInputState.Neutral();
            if (deltaTime <= 0f) deltaTime = Time.unscaledDeltaTime;

            bool accelerate = IsHeld(InputBindings.Accelerate, _scratch);
            bool brake = IsHeld(InputBindings.Brake, _scratch);
            bool left = IsHeld(InputBindings.SteerLeft, _scratch);
            bool right = IsHeld(InputBindings.SteerRight, _scratch);

            // Pedals ramp toward their target. Holding both is treated as a brake, matching the
            // convention that the brake always wins.
            _throttle = MoveTowards(_throttle, accelerate ? 1f : 0f, pedalResponse * deltaTime);
            _brake = MoveTowards(_brake, brake ? 1f : 0f, pedalResponse * deltaTime);
            if (accelerate && brake) _throttle = 0f;

            float steerTarget = (right ? 1f : 0f) - (left ? 1f : 0f);
            float response = steerTarget == 0f ? steerReturnResponse : steerResponse;
            _steer = MoveTowards(_steer, steerTarget, response * deltaTime);

            state.throttle = _throttle;
            state.brake = _brake;
            state.steer = _steer;
            state.handbrake = IsHeld(InputBindings.Handbrake, _scratch);
            state.shiftUp = IsHeld(InputBindings.ShiftUp, _scratch);
            state.shiftDown = IsHeld(InputBindings.ShiftDown, _scratch);
            state.toggleCamera = IsPressedThisFrame(InputBindings.Camera, _scratch);
            state.recover = IsPressedThisFrame(InputBindings.Recover, _scratch);
            state.toggleHeadlights = IsPressedThisFrame(InputBindings.Headlights, _scratch);
            state.horn = IsHeld(InputBindings.Horn, _scratch);

            return state;
        }

        /// <summary>Drop any keys currently held. Called when a menu opens.</summary>
        public void Clear()
        {
            _throttle = 0f;
            _brake = 0f;
            _steer = 0f;
        }

        /// <summary>True while any key bound to <paramref name="action"/> is down.</summary>
        private bool IsHeld(string action, List<KeyCode> scratch)
        {
            CollectKeys(action, scratch);
            for (int i = 0; i < scratch.Count; i++)
            {
                if (UnityEngine.Input.GetKey(scratch[i])) return true;
            }

            return false;
        }

        /// <summary>True only on the frame the key went down.</summary>
        private bool IsPressedThisFrame(string action, List<KeyCode> scratch)
        {
            CollectKeys(action, scratch);
            for (int i = 0; i < scratch.Count; i++)
            {
                if (UnityEngine.Input.GetKeyDown(scratch[i])) return true;
            }

            return false;
        }

        /// <summary>Parse an action's bound key names into <see cref="KeyCode"/> values.</summary>
        private void CollectKeys(string action, List<KeyCode> scratch)
        {
            scratch.Clear();
            if (_settings == null) return;

            string[] names = InputBindings.KeysFor(_settings.bindings, action);
            for (int i = 0; i < names.Length; i++)
            {
                if (Enum.TryParse(names[i], out KeyCode key)) scratch.Add(key);
            }
        }

        private static float MoveTowards(float current, float target, float maxDelta)
        {
            float difference = target - current;
            if (Mathf.Abs(difference) <= maxDelta) return target;
            return current + Mathf.Sign(difference) * maxDelta;
        }
    }
}
