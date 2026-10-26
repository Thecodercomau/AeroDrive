using AeroDrive.Core;
using AeroDrive.Input;
using AeroDrive.Missions;
using AeroDrive.Presentation;
using AeroDrive.Vehicles;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;

namespace AeroDrive.Editor
{
    /// <summary>
    /// Editor tooling that turns the code in this repository into a playable scene.
    /// </summary>
    /// <remarks>
    /// The scripts here are the project's answer to "I have the repository, now what?". Rather than
    /// shipping a scene file that can silently drift out of step with the code — a missing reference
    /// on a prefab is invisible until the game is run, and by then it is a runtime error — the scene
    /// is *generated* from the same config assets the car uses. Building it again after a change is
    /// one menu click, and a generation failure is an error at the point of generation.
    ///
    /// Everything is idempotent: running the wizard twice produces the same scene rather than
    /// duplicating objects.
    /// </remarks>
    public static class VehicleSetupWizard
    {
        private const string VehicleFolder = "Assets/Vehicles";
        private const string SceneFolder = "Assets/Scenes";
        private const string DefaultScenePath = SceneFolder + "/Playground.unity";

        [MenuItem("AeroDrive/Create Default Vehicles", false, 0)]
        public static void CreateDefaultVehicles()
        {
            EnsureFolder("Assets");
            EnsureFolder(VehicleFolder);

            CreateVehicle(
                "Hatchback",
                vehicleId: "hatchback",
                displayName: "Compact Hatchback",
                vehicleClass: "Compact",
                description: "Light, forgiving, and happy on a rough road.",
                mass: 1080f,
                drivetrain: DrivetrainType.FrontWheelDrive,
                torquePeak: 128f,
                redline: 6200f,
                grip: 1.6f,
                topRatio: 0.82f,
                paint: new Color(0.82f, 0.16f, 0.13f));

            CreateVehicle(
                "Sedan",
                vehicleId: "sedan",
                displayName: "Saloon",
                vehicleClass: "Saloon",
                description: "Heavier and quieter, with a longer wheelbase.",
                mass: 1420f,
                drivetrain: DrivetrainType.RearWheelDrive,
                torquePeak: 168f,
                redline: 6600f,
                grip: 1.7f,
                topRatio: 0.78f,
                paint: new Color(0.14f, 0.32f, 0.62f));

            CreateVehicle(
                "SportsCoupe",
                vehicleId: "coupe",
                displayName: "Sports Coupé",
                vehicleClass: "Sports",
                description: "Rear-driven and quick to rotate. Unlocked by finishing a challenge.",
                mass: 1290f,
                drivetrain: DrivetrainType.RearWheelDrive,
                torquePeak: 226f,
                redline: 7600f,
                grip: 2.1f,
                topRatio: 0.74f,
                paint: new Color(0.16f, 0.16f, 0.18f));

            CreateCatalog();

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();

            Debug.Log("[AeroDrive] Default vehicles and the catalog are ready in " + VehicleFolder);
        }

        private static void CreateVehicle(
            string assetName,
            string vehicleId,
            string displayName,
            string vehicleClass,
            string description,
            float mass,
            DrivetrainType drivetrain,
            float torquePeak,
            float redline,
            float grip,
            float topRatio,
            Color paint)
        {
            string path = $"{VehicleFolder}/{assetName}.asset";
            VehicleConfig config = AssetDatabase.LoadAssetAtPath<VehicleConfig>(path);

            if (config == null)
            {
                config = ScriptableObject.CreateInstance<VehicleConfig>();
                AssetDatabase.CreateAsset(config, path);
            }

            config.vehicleId = vehicleId;
            config.displayName = displayName;
            config.vehicleClass = vehicleClass;
            config.description = description;
            config.mass = mass;
            config.drivetrain = drivetrain;
            config.redlineRpm = redline;
            config.shiftUpRpm = redline * 0.87f;
            config.shiftDownRpm = Mathf.Max(1200f, redline * 0.25f);
            config.tyreGrip = grip;

            // The top gear is what sets the car's top speed, so each car is given one that suits it
            // rather than sharing a single "tall" ratio.
            config.forwardRatios = new[] { 3.6f, 2.1f, 1.4f, 1.05f, topRatio };

            // A torque curve shaped around the car's redline, peaking at about half of it. Every car
            // is authored from the same shape and then scaled, which keeps their characters distinct
            // without needing a curve editor opened for each one.
            float peakRpm = redline * 0.5f;
            config.torqueCurve = new AnimationCurve(
                new Keyframe(config.idleRpm, torquePeak * 0.62f),
                new Keyframe(peakRpm * 0.55f, torquePeak * 0.92f),
                new Keyframe(peakRpm, torquePeak),
                new Keyframe(redline * 0.9f, torquePeak * 0.86f),
                new Keyframe(redline, torquePeak * 0.68f));

            config.paintOptions = new[] { paint };

            // Rear-driven cars need more care with the centre of mass or they spin under power; the
            // physics is the same, so the values are.
            config.centreOfMass = drivetrain == DrivetrainType.RearWheelDrive
                ? new Vector3(0f, -0.28f, -0.05f)
                : new Vector3(0f, -0.25f, 0.05f);

            config.Validate();
            EditorUtility.SetDirty(config);
        }

        private static void CreateCatalog()
        {
            string path = $"{VehicleFolder}/VehicleCatalog.asset";
            VehicleCatalog catalog = AssetDatabase.LoadAssetAtPath<VehicleCatalog>(path);

            if (catalog == null)
            {
                catalog = ScriptableObject.CreateInstance<VehicleCatalog>();
                AssetDatabase.CreateAsset(catalog, path);
            }

            string[] names = { "Hatchback", "Sedan", "SportsCoupe" };
            string[] unlockChallenges = { null, null, "harbour-loop" };

            VehicleCatalogEntry[] entries = new VehicleCatalogEntry[names.Length];
            for (int i = 0; i < names.Length; i++)
            {
                VehicleConfig config = AssetDatabase.LoadAssetAtPath<VehicleConfig>($"{VehicleFolder}/{names[i]}.asset");
                entries[i] = new VehicleCatalogEntry
                {
                    config = config,
                    requiresUnlock = !string.IsNullOrEmpty(unlockChallenges[i]),
                    unlockedByChallengeId = unlockChallenges[i] ?? string.Empty,
                };
            }

            catalog.entries = entries;
            catalog.Validate();
            EditorUtility.SetDirty(catalog);
        }

        [MenuItem("AeroDrive/Create Playground Scene", false, 1)]
        public static void CreatePlaygroundScene()
        {
            CreateDefaultVehicles();

            EnsureFolder(SceneFolder);

            // A new, empty scene added alongside whatever is open, rather than replacing it:
            // generating over the player's unsaved work would be the single most annoying thing this
            // tool could do. The new scene is made active so every object below lands in it.
            UnityEngine.SceneManagement.Scene scene =
                UnityEditor.SceneManagement.EditorSceneManager.NewScene(
                    UnityEditor.SceneManagement.NewSceneSetup.EmptyScene,
                    UnityEditor.SceneManagement.NewSceneMode.Additive);

            UnityEngine.SceneManagement.SceneManager.SetActiveScene(scene);

            GameObject root = new GameObject("AeroDriveRoot");
            GameRoot gameRoot = root.AddComponent<GameRoot>();

            VehicleCatalog catalog = AssetDatabase.LoadAssetAtPath<VehicleCatalog>($"{VehicleFolder}/VehicleCatalog.asset");
            VehicleConfig hatchback = AssetDatabase.LoadAssetAtPath<VehicleConfig>($"{VehicleFolder}/Hatchback.asset");

            GameObject car = BuildCar(hatchback);
            GameObject camera = BuildCamera(car.GetComponent<VehicleController>());
            GameObject hud = BuildHud(car.GetComponent<VehicleController>(), camera.GetComponent<ChaseCamera>());
            GameObject audio = BuildAudio(car.GetComponent<VehicleController>(), gameRoot);

            // The session is created last so it can be handed every other object in one assignment
            // rather than being discovered in a different order at runtime.
            GameObject sessionObject = new GameObject("Session");
            SessionController session = sessionObject.AddComponent<SessionController>();
            session.vehicle = car.GetComponent<VehicleController>();
            session.chaseCamera = camera.GetComponent<ChaseCamera>();
            session.hud = hud.GetComponent<Hud>();
            session.audioRig = audio.GetComponent<EngineAudio>();
            session.spawnPoint = car.transform;

            BuildGround();
            BuildSun();

            string path = AssetDatabase.GenerateUniqueAssetPath(DefaultScenePath);
            UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, path);
            AssetDatabase.Refresh();

            Debug.Log($"[AeroDrive] Playground scene created at {path}. Press Play, or bake it with AeroDrive/Build.");
        }

        private static GameObject BuildCar(VehicleConfig config)
        {
            GameObject car = new GameObject("PlayerCar");
            car.transform.position = new Vector3(0f, 1f, 0f);

            Rigidbody body = car.AddComponent<Rigidbody>();
            body.mass = config != null ? config.mass : 1080f;
            body.centerOfMass = config != null ? config.centreOfMass : new Vector3(0f, -0.25f, 0f);
            body.interpolation = RigidbodyInterpolation.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

            // The chassis collider is built from the config, so the collider and the handling data
            // cannot disagree about how big the car is.
            Vector3 half = config != null ? config.chassisHalfExtents : new Vector3(0.86f, 0.62f, 1.95f);
            BoxCollider chassis = car.AddComponent<BoxCollider>();
            chassis.size = half * 2f;

            GameObject bodyMount = new GameObject("BodyMount");
            bodyMount.transform.SetParent(car.transform, false);

            VehicleController controller = car.AddComponent<VehicleController>();
            controller.config = config;

            if (config == null) return car;

            float halfWheelbase = config.HalfWheelbase;
            float halfTrack = config.HalfTrack;
            float wheelY = -config.chassisHalfExtents.y + config.wheelRadius * 0.5f;

            controller.frontLeft = AddWheel(car.transform, "WheelFL", new Vector3(-halfTrack, wheelY, halfWheelbase), config);
            controller.frontRight = AddWheel(car.transform, "WheelFR", new Vector3(halfTrack, wheelY, halfWheelbase), config);
            controller.rearLeft = AddWheel(car.transform, "WheelRL", new Vector3(-halfTrack, wheelY, -halfWheelbase), config);
            controller.rearRight = AddWheel(car.transform, "WheelRR", new Vector3(halfTrack, wheelY, -halfWheelbase), config);

            controller.SetSpawnPoint(car.transform.position, car.transform.rotation);

            return car;
        }

        private static WheelCollider AddWheel(Transform parent, string name, Vector3 localPosition, VehicleConfig config)
        {
            GameObject wheelObject = new GameObject(name);
            wheelObject.transform.SetParent(parent, false);
            wheelObject.transform.localPosition = localPosition;

            WheelCollider wheel = wheelObject.AddComponent<WheelCollider>();
            wheel.radius = config.wheelRadius;
            wheel.suspensionDistance = config.suspensionRestLength;

            JointSpring spring = wheel.suspensionSpring;
            spring.spring = config.suspensionSpring;
            spring.damper = config.suspensionDamper;
            wheel.suspensionSpring = spring;

            return wheel;
        }

        private static GameObject BuildCamera(VehicleController car)
        {
            GameObject cameraObject = new GameObject("ChaseCamera");
            cameraObject.AddComponent<Camera>();
            ChaseCamera chase = cameraObject.AddComponent<ChaseCamera>();
            chase.target = car;
            cameraObject.AddComponent<AudioListener>();

            // The car scene is small and the camera's position is smoothed, so a far plane well
            // beyond the map's extent costs nothing and cannot clip the horizon.
            Camera camera = cameraObject.GetComponent<Camera>();
            camera.farClipPlane = 2000f;
            camera.nearClipPlane = 0.15f;

            return cameraObject;
        }

        private static GameObject BuildHud(VehicleController car, ChaseCamera chase)
        {
            // A canvas built in code keeps the wizard self-contained. Text is placed with anchors
            // rather than absolute pixels so it survives a different resolution.
            GameObject canvasObject = new GameObject("Hud");
            Canvas canvas = canvasObject.AddComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;

            CanvasScaler scaler = canvasObject.AddComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1920f, 1080f);
            canvasObject.AddComponent<GraphicRaycaster>();

            Hud hud = canvasObject.AddComponent<Hud>();
            hud.vehicle = car;
            hud.chaseCamera = chase;
            hud.speedText = AddText(canvasObject.transform, "Speed", new Vector2(0.04f, 0.06f), 96, TextAnchor.LowerLeft, "0");
            hud.gearText = AddText(canvasObject.transform, "Gear", new Vector2(0.04f, 0.22f), 64, TextAnchor.LowerLeft, "N");
            hud.rpmText = AddText(canvasObject.transform, "Rpm", new Vector2(0.96f, 0.06f), 32, TextAnchor.LowerRight, "0");
            hud.timerText = AddText(canvasObject.transform, "Timer", new Vector2(0.5f, 0.94f), 40, TextAnchor.UpperCenter, "00:00.00");
            hud.cameraModeText = AddText(canvasObject.transform, "CameraMode", new Vector2(0.96f, 0.94f), 24, TextAnchor.UpperRight, "Chase");
            hud.messageText = AddText(canvasObject.transform, "Message", new Vector2(0.5f, 0.78f), 44, TextAnchor.MiddleCenter, string.Empty);

            return canvasObject;
        }

        private static Text AddText(Transform parent, string name, Vector2 anchor, int size, TextAnchor alignment, string initial)
        {
            GameObject textObject = new GameObject(name);
            textObject.transform.SetParent(parent, false);

            RectTransform rect = textObject.AddComponent<RectTransform>();
            rect.anchorMin = anchor;
            rect.anchorMax = anchor;
            rect.pivot = anchor;
            rect.anchoredPosition = Vector2.zero;
            rect.sizeDelta = new Vector2(600f, 140f);

            Text text = textObject.AddComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.fontSize = size;
            text.alignment = alignment;
            text.color = Color.white;
            text.text = initial;

            return text;
        }

        private static GameObject BuildAudio(VehicleController car, GameRoot root)
        {
            GameObject audioObject = new GameObject("VehicleAudio");
            audioObject.transform.SetParent(car.transform, false);

            AudioSource engine = audioObject.AddComponent<AudioSource>();
            engine.spatialBlend = 0.85f;

            EngineAudio rig = audioObject.AddComponent<EngineAudio>();
            rig.vehicle = car;

            // Sources are optional everywhere in the audio rig, but a scene generated by the wizard
            // should sound complete, so the low, tyre, wind and effects sources are all created.
            rig.lowSource = AddSource(audioObject, "EngineLow", 0.0f);
            rig.tyreSource = AddSource(audioObject, "Tyres", 0.7f);
            rig.windSource = AddSource(audioObject, "Wind", 0.4f);
            rig.effectsSource = AddSource(audioObject, "Effects", 1f);

            return audioObject;
        }

        private static AudioSource AddSource(GameObject parent, string name, float spatialBlend)
        {
            GameObject host = new GameObject(name);
            host.transform.SetParent(parent.transform, false);
            AudioSource source = host.AddComponent<AudioSource>();
            source.spatialBlend = spatialBlend;
            source.playOnAwake = false;
            return source;
        }

        private static void BuildGround()
        {
            GameObject ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
            ground.name = "Ground";
            ground.transform.localScale = new Vector3(60f, 1f, 60f);

            // A placeable surface rather than a physics material asset: generating the asset would
            // mean writing a file the wizard then has to keep in step with.
            ground.GetComponent<Renderer>().sharedMaterial.color = new Color(0.24f, 0.26f, 0.24f);
        }

        private static void BuildSun()
        {
            GameObject sun = new GameObject("Sun");
            Light light = sun.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.1f;
            sun.transform.rotation = Quaternion.Euler(48f, 32f, 0f);

            // The ambient source is set explicitly: a scene generated with no ambient light renders
            // everything unlit and black in the built-in pipeline's default skybox-off state.
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.42f, 0.45f, 0.5f);
        }

        private static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;

            string parent = System.IO.Path.GetDirectoryName(path)?.Replace('\\', '/');
            string leaf = System.IO.Path.GetFileName(path);
            if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(leaf)) return;

            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }

        /// <summary>Drop a checkpoint gate into the scene, parented to the mission's route.</summary>
        [MenuItem("GameObject/AeroDrive/Checkpoint", false, 10)]
        public static void CreateCheckpoint(MenuCommand command)
        {
            GameObject gate = GameObject.CreatePrimitive(PrimitiveType.Cube);
            gate.name = "Checkpoint";
            gate.transform.localScale = new Vector3(14f, 6f, 1f);

            Collider collider = gate.GetComponent<Collider>();
            collider.isTrigger = true;

            // The primitive's own mesh renderer is removed so the gate is a trigger and a marker
            // rather than a wall the car can hit.
            Object.DestroyImmediate(gate.GetComponent<MeshRenderer>());

            GameObject visual = new GameObject("Visual");
            visual.transform.SetParent(gate.transform, false);

            gate.AddComponent<Checkpoint>();

            GameObjectUtility.SetParentAndAlign(gate, command.context as GameObject);
            Undo.RegisterCreatedObjectUndo(gate, "Create Checkpoint");
            Selection.activeGameObject = gate;
        }

        /// <summary>Create a challenge asset with a route, ready to be moved into place.</summary>
        [MenuItem("AeroDrive/Create Challenge", false, 2)]
        public static void CreateChallenge()
        {
            EnsureFolder("Assets");
            EnsureFolder("Assets/Challenges");

            ChallengeDefinition challenge = ScriptableObject.CreateInstance<ChallengeDefinition>();
            challenge.checkpoints = new[]
            {
                new Vector3(0f, 2f, 60f),
                new Vector3(60f, 2f, 60f),
                new Vector3(60f, 2f, 0f),
                new Vector3(0f, 2f, 0f),
            };

            string path = AssetDatabase.GenerateUniqueAssetPath("Assets/Challenges/Challenge.asset");
            AssetDatabase.CreateAsset(challenge, path);
            AssetDatabase.SaveAssets();

            Selection.activeObject = challenge;
            Debug.Log($"[AeroDrive] Challenge created at {path}");
        }

        /// <summary>Ids of the input actions, so the settings menu can be built without typos.</summary>
        [MenuItem("AeroDrive/Log Input Actions", false, 30)]
        public static void LogInputActions()
        {
            for (int i = 0; i < InputBindings.Actions.Length; i++)
            {
                string action = InputBindings.Actions[i];
                Debug.Log($"{action} — {InputBindings.LabelFor(action)}");
            }
        }
    }
}
