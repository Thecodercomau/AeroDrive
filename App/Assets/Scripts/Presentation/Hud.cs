using AeroDrive.Vehicles;
using UnityEngine;
using UnityEngine.UI;

namespace AeroDrive.Presentation
{
    /// <summary>
    /// The in-game readout: speed, gear, revs, damage and transient messages.
    /// </summary>
    /// <remarks>
    /// Every widget is an optional serialised reference and every read is null-checked. That is on
    /// purpose: a HUD is the piece most likely to be edited by hand in a scene, and a missing
    /// tachometer image must not throw once per frame and drown the console in the middle of a race.
    ///
    /// The HUD deliberately does **not** drive gameplay. It reads state and writes to widgets; when
    /// a value is wrong, the bug is upstream in the vehicle or the session, never here.
    /// </remarks>
    public sealed class Hud : MonoBehaviour
    {
        [Header("Target")]
        public VehicleController vehicle;

        [Tooltip("Used for the camera mode indicator. Optional.")]
        public ChaseCamera chaseCamera;

        [Header("Speed and gear")]
        public Text speedText;
        public Text gearText;

        [Tooltip("Radial or bar fill for the rev counter, 0..1.")]
        public Image rpmFill;

        public Text rpmText;

        [Header("State")]
        [Tooltip("Damage bar, 0..1 filled.")]
        public Image damageFill;

        [Tooltip("Shown when the car has taken critical damage.")]
        public GameObject damageWarning;

        [Tooltip("Shown while the tyres are sliding.")]
        public GameObject slipIndicator;

        [Header("Session")]
        public Text timerText;
        public Text cameraModeText;

        [Header("Messages")]
        [Tooltip("Line used for short, transient messages such as \"New best time\".")]
        public Text messageText;

        [Tooltip("Prefab shown when a controller is connected. Optional.")]
        public GameObject gamepadHint;

        [Header("Behaviour")]
        [Tooltip("Seconds a transient message stays on screen.")]
        public float messageDuration = 3f;

        [Tooltip("Update the readout every frame, or every N frames. 1 is every frame.")]
        [Range(1, 10)]
        public int updateEveryFrames = 1;

        private float _messageTimer;
        private int _frameCounter;
        private bool _controllerWasConnected;
        private float _sessionStartTime;

        private void Awake()
        {
            _sessionStartTime = Time.time;
            if (messageText != null) messageText.text = string.Empty;
            SetActive(damageWarning, false);
            SetActive(slipIndicator, false);
        }

        /// <summary>Point the HUD at a new car, as happens when the player changes vehicle.</summary>
        public void Bind(VehicleController target, ChaseCamera camera)
        {
            vehicle = target;
            chaseCamera = camera;
            _sessionStartTime = Time.time;
            Refresh(true);
        }

        /// <summary>Show a short message, replacing any current one.</summary>
        public void ShowMessage(string message, float duration = -1f)
        {
            if (messageText == null) return;

            messageText.text = message ?? string.Empty;
            _messageTimer = duration > 0f ? duration : messageDuration;
        }

        private void Update()
        {
            _frameCounter++;
            Refresh(false);
        }

        private void Refresh(bool force)
        {
            if (!force && updateEveryFrames > 1 && _frameCounter % updateEveryFrames != 0) return;

            if (vehicle == null)
            {
                // A HUD with no car still shows its timer, so a menu-driven scene can reuse it.
                UpdateTimer();
                return;
            }

            UpdateSpeedAndGear();
            UpdateRevCounter();
            UpdateDamage();
            UpdateSlip();
            UpdateCameraMode();
            UpdateTimer();
            UpdateMessage();
        }

        private void UpdateSpeedAndGear()
        {
            // Round down: a speedometer that reads 101 at 100.6 km/h looks broken.
            int speed = Mathf.FloorToInt(vehicle.SpeedKmh);
            if (speedText != null) speedText.text = speed.ToString();

            if (gearText != null)
            {
                // A brief flash of the gear being selected is the standard cue that a shift happened.
                gearText.text = vehicle.IsShifting ? "–" : vehicle.GearLabel;
            }
        }

        private void UpdateRevCounter()
        {
            VehicleConfig config = vehicle.Config;
            if (config == null) return;

            float fraction = Mathf.InverseLerp(config.idleRpm, config.redlineRpm, vehicle.Rpm);

            if (rpmFill != null) rpmFill.fillAmount = Mathf.Clamp01(fraction);
            if (rpmText != null) rpmText.text = Mathf.RoundToInt(vehicle.Rpm).ToString();
        }

        private void UpdateDamage()
        {
            float fraction = 1f - vehicle.EngineHealth;

            if (damageFill != null) damageFill.fillAmount = Mathf.Clamp01(fraction);
            SetActive(damageWarning, vehicle.IsDisabled);
        }

        private void UpdateSlip()
        {
            bool sliding = vehicle.DriveWheelSlip > 0.35f || vehicle.LateralSlip > 0.45f;
            SetActive(slipIndicator, sliding);
        }

        private void UpdateCameraMode()
        {
            if (cameraModeText == null || chaseCamera == null) return;
            cameraModeText.text = chaseCamera.Mode.ToString();
        }

        private void UpdateTimer()
        {
            if (timerText == null) return;

            float elapsed = Time.time - _sessionStartTime;
            int minutes = Mathf.FloorToInt(elapsed / 60f);
            int seconds = Mathf.FloorToInt(elapsed % 60f);
            int hundredths = Mathf.FloorToInt((elapsed * 100f) % 100f);

            timerText.text = $"{minutes:00}:{seconds:00}.{hundredths:00}";
        }

        private void UpdateMessage()
        {
            if (messageText == null) return;
            if (_messageTimer <= 0f) return;

            _messageTimer = Mathf.Max(0f, _messageTimer - Time.deltaTime);
            if (_messageTimer <= 0f) messageText.text = string.Empty;
        }

        /// <summary>Tell the player whether a pad is connected. Called by the session.</summary>
        public void SetGamepadConnected(bool connected)
        {
            if (connected == _controllerWasConnected) return;
            _controllerWasConnected = connected;
            SetActive(gamepadHint, connected);
        }

        /// <summary>Reset the session clock. Used when a challenge restarts.</summary>
        public void ResetTimer()
        {
            _sessionStartTime = Time.time;
            _messageTimer = 0f;
            if (messageText != null) messageText.text = string.Empty;
        }

        private static void SetActive(GameObject target, bool active)
        {
            if (target != null && target.activeSelf != active) target.SetActive(active);
        }
    }
}
