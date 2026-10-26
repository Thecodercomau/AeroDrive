using AeroDrive.Core;
using AeroDrive.Vehicles;
using UnityEngine;

namespace AeroDrive.Presentation
{
    /// <summary>
    /// Drives the car's audio from its mechanical state: engine note, gear-change blip, tyre scrub,
    /// wind and impacts.
    /// </summary>
    /// <remarks>
    /// **Why the engine note is generated rather than sampled.** Recorded engine loops are the
    /// usual approach, but they need licensing, they are large, and a loop-based engine is very hard
    /// to make track RPM honestly across a 6000 RPM range without a pitch-shifted mess. This class
    /// synthesises a note whose harmonic content is a direct function of RPM, so the engine cannot
    /// drift out of tune with the tachometer — and the project ships with no audio assets at all.
    ///
    /// The synthesis is deliberately cheap: one looping buffer, per cylinder count, retuned by
    /// <see cref="AudioSource.pitch"/>. That keeps the whole system to a few milliseconds of
    /// startup cost instead of streaming anything.
    /// </remarks>
    [RequireComponent(typeof(AudioSource))]
    public sealed class EngineAudio : MonoBehaviour
    {
        [Header("Target")]
        [Tooltip("The car whose engine this is.")]
        public VehicleController vehicle;

        [Header("Mix")]
        [Range(0f, 1f)]
        public float masterVolume = 0.8f;

        [Tooltip("A low-frequency source keeps the engine's thrum; it is optional.")]
        public AudioSource lowSource;

        [Tooltip("The tyre scrub source. Optional.")]
        public AudioSource tyreSource;

        [Tooltip("The wind and road-noise source. Optional.")]
        public AudioSource windSource;

        [Tooltip("One-shot source for impacts and gear changes. Optional.")]
        public AudioSource effectsSource;

        [Header("Response")]
        [Tooltip("How quickly the engine note follows RPM. Too fast sounds synthetic.")]
        [Range(1f, 40f)]
        public float response = 12f;

        [Tooltip("Seconds for a gear-change blip. Keep it under the gearbox's own shift time.")]
        [Range(0.02f, 0.4f)]
        public float shiftBlipSeconds = 0.12f;

        private AudioSource _engine;
        private VehicleController _boundVehicle;
        private EventBus _bus;

        private float _smoothedRpm;
        private float _smoothedSpeed;
        private float _shiftBlipTimer;
        private bool _shiftWasUp;
        private bool _muted;

        // Held so the subscriptions can be released. A leaked handler would keep this component
        // alive after its car was destroyed, and would fire on the next session's events.
        private System.IDisposable _gearSubscription;
        private System.IDisposable _impactSubscription;
        private System.IDisposable _settingsSubscription;

        /// <summary>Expected RPM of the engine note at idle, used to normalise pitch.</summary>
        private const float ReferenceRpm = 1000f;

        /// <summary>The frequency the generated clip is tuned to at <see cref="ReferenceRpm"/>.</summary>
        private const float ReferenceFrequency = 60f;

        private void Awake()
        {
            _engine = GetComponent<AudioSource>();
            _engine.loop = true;
            _engine.playOnAwake = false;
            _engine.spatialBlend = 0.85f;
            _engine.dopplerLevel = 0.2f;
        }

        /// <summary>Attach this audio rig to a car and start it.</summary>
        public void Bind(VehicleController target, EventBus bus)
        {
            Unbind();

            vehicle = target;
            _bus = bus;

            if (vehicle == null || vehicle.Config == null) return;

            _boundVehicle = vehicle;
            BuildEngineClip(vehicle.Config.cylinders);

            _engine.volume = 0f;
            _engine.pitch = 1f;
            _engine.Play();

            if (tyreSource != null)
            {
                tyreSource.loop = true;
                tyreSource.volume = 0f;
                tyreSource.spatialBlend = 0.7f;
                if (!tyreSource.isPlaying) tyreSource.Play();
            }

            if (windSource != null)
            {
                windSource.loop = true;
                windSource.volume = 0f;
                windSource.spatialBlend = 0.4f;
                if (!windSource.isPlaying) windSource.Play();
            }

            if (bus != null)
            {
                _gearSubscription = bus.Subscribe((GameEvents.GearChanged e) => OnGearChanged(e));
                _impactSubscription = bus.Subscribe((GameEvents.Impact e) => OnImpact(e));
                _settingsSubscription = bus.Subscribe(
                    (GameEvents.SettingsChanged e) =>
                    {
                        if (e.Settings != null) masterVolume = e.Settings.masterVolume;
                    });
            }
        }

        private void Unbind()
        {
            _gearSubscription?.Dispose();
            _impactSubscription?.Dispose();
            _settingsSubscription?.Dispose();
            _gearSubscription = null;
            _impactSubscription = null;
            _settingsSubscription = null;

            if (tyreSource != null) tyreSource.Stop();
            if (windSource != null) windSource.Stop();
            if (_engine != null) _engine.Stop();
            _boundVehicle = null;
        }

        private void OnDisable()
        {
            _muted = true;
            if (_engine != null) _engine.Stop();
        }

        private void OnEnable()
        {
            _muted = false;
            if (_engine != null && _boundVehicle != null) _engine.Play();
        }

        private void OnDestroy()
        {
            Unbind();
        }

        /// <summary>Silence everything immediately. Used when the game is paused or a menu opens.</summary>
        public void SetMuted(bool muted)
        {
            _muted = muted;
            if (_engine == null) return;

            if (muted)
            {
                _engine.volume = 0f;
                if (tyreSource != null) tyreSource.volume = 0f;
                if (windSource != null) windSource.volume = 0f;
            }
            else if (!_engine.isPlaying)
            {
                _engine.Play();
            }
        }

        private void Update()
        {
            if (_boundVehicle == null || _muted) return;

            float dt = Time.deltaTime;
            if (dt <= 0f) return;

            VehicleConfig config = _boundVehicle.Config;

            // Both the note and the wind are damped: an engine that snaps straight to a new pitch on
            // every physics step sounds like a synthesiser, not a car.
            _smoothedRpm = Mathf.Lerp(_smoothedRpm, _boundVehicle.Rpm, Mathf.Clamp01(dt * response));
            _smoothedSpeed = Mathf.Lerp(_smoothedSpeed, _boundVehicle.SpeedKmh, Mathf.Clamp01(dt * 4f));

            UpdateEngine(dt, config);
            UpdateTyres();
            UpdateWind();
            UpdateShiftBlip(dt);
        }

        private void UpdateEngine(float dt, VehicleConfig config)
        {
            // A tone is played back at a pitch proportional to RPM, so the note and the tachometer
            // can never disagree — which is the failure mode of a sample-based engine.
            float rpm = Mathf.Max(_smoothedRpm, config.idleRpm);
            float pitch = rpm / ReferenceRpm;
            _engine.pitch = Mathf.Clamp(pitch, 0.35f, 4f);

            // Volume rises with throttle and revs, but never to zero: an engine at idle is audible.
            float revFraction = Mathf.InverseLerp(config.idleRpm, config.redlineRpm, rpm);
            float loadVolume = Mathf.Lerp(config.engineIdleVolume, 0.85f, revFraction);

            float target = _boundVehicle.IsDisabled ? 0.12f : loadVolume;
            _engine.volume = Mathf.Lerp(_engine.volume, target * masterVolume, Mathf.Clamp01(dt * 6f));
        }

        private void UpdateTyres()
        {
            if (tyreSource == null) return;

            // Slip, not speed, is what makes tyre noise. A car rolling along the motorway is quiet.
            float slip = _boundVehicle.DriveWheelSlip + _boundVehicle.LateralSlip * 0.8f;
            float target = Mathf.Clamp01(slip) * 0.7f * masterVolume;
            tyreSource.volume = Mathf.Lerp(tyreSource.volume, target, Time.deltaTime * 8f);
            tyreSource.pitch = Mathf.Lerp(0.8f, 1.6f, Mathf.Clamp01(slip));
        }

        private void UpdateWind()
        {
            if (windSource == null) return;

            // Wind noise is the cue that the car is going fast, so it follows road speed alone.
            float fraction = Mathf.InverseLerp(30f, 220f, _smoothedSpeed);
            windSource.volume = Mathf.Lerp(windSource.volume, fraction * 0.35f * masterVolume, Time.deltaTime * 3f);
            windSource.pitch = Mathf.Lerp(0.9f, 1.25f, fraction);
        }

        private void UpdateShiftBlip(float dt)
        {
            if (_shiftBlipTimer <= 0f) return;

            _shiftBlipTimer = Mathf.Max(0f, _shiftBlipTimer - dt);

            // A momentary lift in pitch on an upshift is what the ear reads as a gear change; the
            // engine note itself carries on, exactly as it does in a real car.
            float t = _shiftBlipTimer / Mathf.Max(0.001f, shiftBlipSeconds);
            float offset = _shiftWasUp ? -0.25f * t : 0.2f * t;
            _engine.pitch = Mathf.Clamp(_engine.pitch + offset, 0.35f, 4f);
        }

        private void OnGearChanged(GameEvents.GearChanged e)
        {
            // Neutral and reverse are not blipped: one is silence, the other is not a gear change.
            if (e.Gear <= 0 || e.PreviousGear <= 0) return;
            if (effectsSource == null) return;

            _shiftWasUp = e.Gear > e.PreviousGear;
            _shiftBlipTimer = shiftBlipSeconds;

            AudioClip clip = _shiftWasUp ? GenerateClick(620f, 0.05f) : GenerateClick(410f, 0.05f);
            effectsSource.PlayOneShot(clip, 0.18f * masterVolume);
        }

        private void OnImpact(GameEvents.Impact e)
        {
            if (effectsSource == null) return;
            if (e.ImpactSpeed < 4f) return;

            // Scaled and capped: a 100 km/h wall should be loud, not deafening.
            float volume = Mathf.Clamp01(e.ImpactSpeed / 30f) * 0.6f * masterVolume;
            effectsSource.PlayOneShot(GenerateNoise(0.25f), volume);
        }

        /// <summary>
        /// Build the looping engine tone for a given cylinder count.
        /// </summary>
        /// <remarks>
        /// The clip is one engine cycle: a fundamental plus its first few harmonics, weighted the way
        /// a four-cylinder and a V8 differ. More cylinders means more, closer-spaced harmonics, which
        /// is why an eight sounds smoother than a four at the same RPM.
        /// </remarks>
        private void BuildEngineClip(int cylinders)
        {
            const int sampleRate = 44100;
            const float cycleSeconds = 0.5f;
            int sampleCount = Mathf.RoundToInt(sampleRate * cycleSeconds);

            // The fundamental is one firing event per cylinder per two engine revolutions.
            int harmonicCount = Mathf.Clamp(cylinders / 2, 2, 8);
            float[] samples = new float[sampleCount];

            for (int i = 0; i < sampleCount; i++)
            {
                float t = (float)i / sampleRate;
                float value = 0f;

                for (int h = 1; h <= harmonicCount; h++)
                {
                    // An integer number of cycles across the buffer keeps the loop seamless; noise
                    // at the join would click once a second forever.
                    float frequency = ReferenceFrequency * h;
                    float amplitude = 1f / Mathf.Pow(h, 1.3f);
                    value += Mathf.Sin(2f * Mathf.PI * frequency * t) * amplitude;
                }

                // A little noise gives the note a mechanical edge rather than a pure tone.
                value += (Random.value * 2f - 1f) * 0.04f;

                samples[i] = value * 0.5f;
            }

            Normalise(samples);

            AudioClip clip = AudioClip.Create($"engine-{cylinders}", sampleCount, 1, sampleRate, false);
            clip.SetData(samples, 0);

            _engine.clip = clip;
        }

        private static void Normalise(float[] samples)
        {
            float peak = 0f;
            for (int i = 0; i < samples.Length; i++)
            {
                float magnitude = Mathf.Abs(samples[i]);
                if (magnitude > peak) peak = magnitude;
            }

            if (peak <= 0.0001f) return;

            float scale = 0.9f / peak;
            for (int i = 0; i < samples.Length; i++) samples[i] *= scale;
        }

        private static AudioClip GenerateClick(float frequency, float seconds)
        {
            const int sampleRate = 44100;
            int sampleCount = Mathf.Max(1, Mathf.RoundToInt(sampleRate * seconds));
            float[] samples = new float[sampleCount];

            for (int i = 0; i < sampleCount; i++)
            {
                float t = (float)i / sampleRate;
                float envelope = 1f - (float)i / sampleCount;
                samples[i] = Mathf.Sin(2f * Mathf.PI * frequency * t) * envelope * 0.5f;
            }

            AudioClip clip = AudioClip.Create($"click-{frequency}", sampleCount, 1, sampleRate, false);
            clip.SetData(samples, 0);
            return clip;
        }

        private static AudioClip GenerateNoise(float seconds)
        {
            const int sampleRate = 44100;
            int sampleCount = Mathf.Max(1, Mathf.RoundToInt(sampleRate * seconds));
            float[] samples = new float[sampleCount];

            for (int i = 0; i < sampleCount; i++)
            {
                float envelope = 1f - (float)i / sampleCount;
                // A decaying burst of noise reads as a thud rather than a tone.
                samples[i] = (Random.value * 2f - 1f) * envelope * envelope * 0.8f;
            }

            AudioClip clip = AudioClip.Create("impact", sampleCount, 1, sampleRate, false);
            clip.SetData(samples, 0);
            return clip;
        }
    }
}
