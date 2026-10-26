using AeroDrive.Presentation;
using AeroDrive.SaveSystem;
using UnityEngine;

namespace AeroDrive.Core
{
    /// <summary>
    /// The one object that outlives every scene: it owns the event bus and the save file.
    /// </summary>
    /// <remarks>
    /// Everything else in the game is a participant: it is created when a scene loads, it asks the
    /// root for what it needs, and it is destroyed when the scene unloads. Having exactly one
    /// persistent object is what makes "return to the main menu" a scene load rather than a
    /// carefully ordered teardown of a dozen singletons.
    ///
    /// Place it in the first scene, or let <see cref="Ensure"/> create it — the two paths are
    /// equivalent, which matters because a test or a development scene will not have placed it.
    /// </remarks>
    [DefaultExecutionOrder(-1000)]
    public sealed class GameRoot : MonoBehaviour
    {
        /// <summary>Version of the game, written into the save file and reported on the bus.</summary>
        public const string Version = "0.1.0";

        private static GameRoot _instance;

        /// <summary>The live root, or null before <see cref="Awake"/> has run.</summary>
        public static GameRoot Instance
        {
            get { return _instance; }
        }

        /// <summary>Shared event bus. Never null once the root exists.</summary>
        public EventBus Bus { get; private set; }

        /// <summary>The player's save file. Never null once the root exists.</summary>
        public SaveManager Save { get; private set; }

        [Header("Behaviour")]
        [Tooltip("Keep this object alive across scene loads.")]
        public bool persistAcrossScenes = true;

        [Tooltip("Apply the saved graphics and audio settings on startup.")]
        public bool applySettingsOnStart = true;

        [Header("Audio mixer")]
        [Tooltip("Optional audio mixer. Without one, only the per-source volumes apply.")]
        public UnityEngine.Audio.AudioMixer audioMixer;

        public const string MasterVolumeParameter = "MasterVolume";
        public const string EngineVolumeParameter = "EngineVolume";
        public const string AmbienceVolumeParameter = "AmbienceVolume";
        public const string EffectsVolumeParameter = "EffectsVolume";

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                // A second root means a scene was loaded additively or the object was placed twice.
                // Destroying the newcomer keeps the first root's save file authoritative.
                Destroy(gameObject);
                return;
            }

            _instance = this;
            if (persistAcrossScenes) DontDestroyOnLoad(gameObject);

            Bus = new EventBus();
            Save = new SaveManager(Bus);
            Save.Load();

            if (applySettingsOnStart) ApplySettings();

            Bus.Publish(new GameEvents.GameReady(Version));
        }

        /// <summary>
        /// Create the root if the scene does not contain one.
        /// </summary>
        /// <remarks>
        /// Used by development scenes and by tests that need a bus but are not the real game.
        /// </remarks>
        public static GameRoot Ensure()
        {
            if (_instance != null) return _instance;

            GameObject host = new GameObject("AeroDriveRoot");
            return host.AddComponent<GameRoot>();
        }

        /// <summary>Push the saved settings onto the engine and the audio mixer.</summary>
        public void ApplySettings()
        {
            if (Save == null) return;

            GameSettings settings = Save.Data.settings;
            ApplyGraphics(settings);
            ApplyAudio(settings);

            Bus?.Publish(new GameEvents.SettingsChanged(settings));
        }

        /// <summary>
        /// Apply the quality tier, render scale and frame-rate cap.
        /// </summary>
        /// <remarks>
        /// The tier is a floor, not a replacement: an explicit per-setting value that the player has
        /// changed is respected on top of it. That is why the shadow distance is applied after
        /// <see cref="QualitySettings.SetQualityLevel"/> rather than being left to the tier.
        /// </remarks>
        public void ApplyGraphics(GameSettings settings)
        {
            if (settings == null) return;

            QualitySettings.SetQualityLevel((int)settings.quality, true);
            QualitySettings.shadows = settings.shadows ? ShadowQuality.All : ShadowQuality.Disable;
            QualitySettings.shadowDistance = settings.shadowDistance;
            QualitySettings.vSyncCount = settings.vSync ? 1 : 0;

            Application.targetFrameRate = settings.targetFrameRate;

            // Render scale is applied to the camera rather than through the render pipeline, so it
            // works identically in the built-in pipeline and in URP.
            Camera[] cameras = Camera.allCameras;
            for (int i = 0; i < cameras.Length; i++)
            {
                RenderScale.Apply(cameras[i], settings.renderScale);
            }

            if (settings.quality <= QualityTier.Potato)
            {
                QualitySettings.anisotropicFiltering = AnisotropicFiltering.Disable;
            }
        }

        /// <summary>Apply the volume levels, if an audio mixer is assigned to <see cref="audioMixer"/>.</summary>
        public void ApplyAudio(GameSettings settings)
        {
            if (settings == null || audioMixer == null) return;

            SetVolume(settings.masterVolume, MasterVolumeParameter);
            SetVolume(settings.engineVolume, EngineVolumeParameter);
            SetVolume(settings.ambienceVolume, AmbienceVolumeParameter);
            SetVolume(settings.effectsVolume, EffectsVolumeParameter);
        }

        private void SetVolume(float linear, string parameter)
        {
            if (audioMixer == null) return;

            // Mixer volumes are in decibels. A linear 0 must become silence, not -infinity, because
            // an audio mixer will happily accept a value it cannot represent and produce garbage.
            float decibels = linear <= 0.0001f ? -80f : Mathf.Log10(Mathf.Clamp01(linear)) * 20f;
            audioMixer.SetFloat(parameter, decibels);
        }

        private void OnDestroy()
        {
            if (_instance == this) _instance = null;
        }
    }
}
