using System;
using UnityEngine;

namespace AeroDrive.Vehicles
{
    /// <summary>Which wheels are driven.</summary>
    public enum DrivetrainType
    {
        FrontWheelDrive,
        RearWheelDrive,
        AllWheelDrive,
    }

    /// <summary>
    /// Every handling parameter for one vehicle, as data.
    /// </summary>
    /// <remarks>
    /// A ScriptableObject rather than constants in the controller, for three reasons: a designer can
    /// tune a car without touching code; the values live in an asset that can be duplicated to make
    /// a new car; and a test can construct one in memory and assert on the physics it produces.
    ///
    /// The fields are grouped the way a chassis engineer thinks about them — mass, suspension,
    /// engine, tyres — rather than the way the controller consumes them. Tooltips state the units,
    /// because "stiffness: 35000" means nothing without them and a wrong unit is the easiest way to
    /// make a car behave inexplicably.
    /// </remarks>
    [CreateAssetMenu(fileName = "VehicleConfig", menuName = "AeroDrive/Vehicle Config", order = 0)]
    public class VehicleConfig : ScriptableObject
    {
        [Header("Identity")]
        [Tooltip("Stable id used by save files. Must not change once players have progress.")]
        public string vehicleId = "hatchback";

        [Tooltip("Display name shown in the garage.")]
        public string displayName = "Compact Hatchback";

        [Tooltip("Shown under the name in the garage.")]
        public string vehicleClass = "Compact";

        [TextArea(2, 4)]
        public string description = "Light, forgiving, and happy on a rough road.";

        [Header("Chassis")]
        [Tooltip("Total mass in kilograms, including the driver.")]
        [Range(400f, 3000f)]
        public float mass = 1080f;

        [Tooltip("Centre of mass, in local space. Keep Y low — it is the single biggest factor in whether a car feels planted.")]
        public Vector3 centreOfMass = new Vector3(0f, -0.25f, 0.05f);

        [Tooltip("Half the chassis collider's size, in metres. Should match the visual body.")]
        public Vector3 chassisHalfExtents = new Vector3(0.86f, 0.62f, 1.95f);

        [Tooltip("Air resistance. 0.30 is a typical hatchback; 0.25 is a supercar.")]
        [Range(0.15f, 0.9f)]
        public float dragCoefficient = 0.31f;

        [Tooltip("Downforce coefficient. Higher presses the car into the road at speed.")]
        [Range(0f, 3f)]
        public float downforce = 0.35f;

        [Header("Drivetrain")]
        public DrivetrainType drivetrain = DrivetrainType.FrontWheelDrive;

        [Tooltip("Distance between the front and rear axle centres, in metres.")]
        [Range(1.8f, 3.6f)]
        public float wheelbase = 2.45f;

        [Tooltip("Distance between the left and right wheel centres, in metres.")]
        [Range(1.2f, 2.2f)]
        public float trackWidth = 1.46f;

        [Header("Engine")]
        [Tooltip("Idle speed in RPM. Below this the engine stalls, so the gearbox never goes under it.")]
        [Range(500f, 1200f)]
        public float idleRpm = 800f;

        [Tooltip("Redline in RPM. No torque is delivered above it.")]
        [Range(4000f, 9000f)]
        public float redlineRpm = 6200f;

        [Tooltip("Torque in Nm against RPM. A flat curve is easy to drive; a peaky one is more fun.")]
        public AnimationCurve torqueCurve = new AnimationCurve(
            new Keyframe(800f, 78f),
            new Keyframe(2200f, 118f),
            new Keyframe(3800f, 128f),
            new Keyframe(5400f, 112f),
            new Keyframe(6200f, 88f));

        [Tooltip("Gear ratios, first to top. Index 0 is first gear.")]
        public float[] forwardRatios = { 3.6f, 2.1f, 1.4f, 1.05f, 0.82f };

        [Tooltip("Reverse gear ratio.")]
        public float reverseRatio = 3.2f;

        [Tooltip("Final drive ratio, applied on top of the gear ratio.")]
        public float finalDrive = 3.9f;

        [Tooltip("RPM at which the automatic gearbox shifts up.")]
        public float shiftUpRpm = 5400f;

        [Tooltip("RPM below which the automatic gearbox shifts down.")]
        public float shiftDownRpm = 1400f;

        [Tooltip("Seconds the drivetrain takes to change gear. Torque is cut for this long.")]
        [Range(0.05f, 1f)]
        public float shiftTime = 0.28f;

        [Header("Suspension")]
        [Tooltip("Distance from the wheel's hard-point to its rest position, in metres.")]
        [Range(0.1f, 0.5f)]
        public float suspensionRestLength = 0.36f;

        [Tooltip("Spring rate. Higher holds the car up more firmly.")]
        [Range(10000f, 90000f)]
        public float suspensionSpring = 35000f;

        [Tooltip("Damper setting while the suspension is being compressed.")]
        [Range(200f, 6000f)]
        public float suspensionDamper = 2600f;

        [Tooltip("How far the wheel may travel from its rest position, in metres.")]
        [Range(0.05f, 0.4f)]
        public float suspensionTravel = 0.18f;

        [Header("Wheels and tyres")]
        [Tooltip("Wheel radius in metres.")]
        [Range(0.2f, 0.6f)]
        public float wheelRadius = 0.31f;

        [Tooltip("Tyre grip. Higher grips harder and slides less.")]
        [Range(0.6f, 3f)]
        public float tyreGrip = 1.6f;

        [Header("Steering")]
        [Tooltip("Maximum steering angle at low speed, in degrees.")]
        [Range(15f, 50f)]
        public float maxSteerAngle = 34f;

        [Tooltip("Speed at which the steering angle has fallen to its minimum, in km/h.")]
        [Range(20f, 200f)]
        public float steerFalloffSpeed = 110f;

        [Tooltip("How much steering is removed at high speed. 0.6 keeps 40% of the low-speed angle.")]
        [Range(0f, 0.9f)]
        public float steerSpeedFalloff = 0.6f;

        [Tooltip("How fast the front wheels can turn, in degrees per second.")]
        [Range(60f, 600f)]
        public float steerRate = 260f;

        [Tooltip("How fast the steering self-centres when you let go, in degrees per second.")]
        [Range(60f, 900f)]
        public float steerReturnRate = 420f;

        [Header("Brakes and assists")]
        [Tooltip("Maximum brake torque applied per wheel.")]
        [Range(1000f, 8000f)]
        public float maxBrakeTorque = 2600f;

        [Tooltip("Handbrake torque as a multiple of a normal brake.")]
        [Range(1f, 4f)]
        public float handbrakeMultiplier = 2.2f;

        [Tooltip("Brake bias toward the front axle, 0.5 being even.")]
        [Range(0.3f, 0.8f)]
        public float brakeBias = 0.66f;

        [Tooltip("Traction control strength. Higher cuts drive torque earlier to stop wheelspin.")]
        [Range(0f, 1f)]
        public float tractionControl = 0.45f;

        [Tooltip("Anti-lock braking. Stops the brakes from locking the wheels under heavy braking.")]
        public bool absEnabled = true;

        [Tooltip("Stability assist strength. Higher is easier to catch a slide with.")]
        [Range(0f, 1f)]
        public float stabilityAssist = 0.3f;

        [Header("Damage")]
        [Tooltip("How much damage a heavy impact adds. Scales the whole damage model.")]
        [Range(0f, 3f)]
        public float damageSensitivity = 1f;

        [Tooltip("Damage percentage at which the engine loses its power.")]
        [Range(50f, 100f)]
        public float criticalDamage = 88f;

        [Header("Presentation")]
        [Tooltip("Body colours the player can choose in the garage.")]
        public Color[] paintOptions =
        {
            new Color(0.82f, 0.16f, 0.13f),
            new Color(0.14f, 0.32f, 0.62f),
            new Color(0.16f, 0.16f, 0.18f),
            new Color(0.90f, 0.90f, 0.88f),
            new Color(0.20f, 0.45f, 0.26f),
        };

        [Header("Audio")]
        [Tooltip("Cylinder count. Drives the engine note's harmonic spacing.")]
        [Range(3, 12)]
        public int cylinders = 4;

        [Tooltip("Engine note offset in semitones, for giving each car its own voice.")]
        [Range(-12f, 12f)]
        public float engineNoteOffset;

        [Tooltip("Base engine volume at idle.")]
        [Range(0f, 1f)]
        public float engineIdleVolume = 0.28f;

        /// <summary>
        /// Check the values and repair anything that would break the simulation.
        /// </summary>
        /// <remarks>
        /// Called from <c>OnValidate</c> so a mistyped value is corrected in the Inspector rather
        /// than turning a car into a rocket. Also callable by tests, which is how the rules below
        /// are covered without opening Unity.
        /// </remarks>
        /// <returns>True when anything had to be changed.</returns>
        public bool Validate()
        {
            bool changed = false;

            changed |= AssignIf(ref mass, Mathf.Clamp(mass, 200f, 4000f));
            changed |= AssignIf(ref wheelRadius, Mathf.Clamp(wheelRadius, 0.15f, 0.75f));
            changed |= AssignIf(ref wheelbase, Mathf.Clamp(wheelbase, 1.2f, 4f));
            changed |= AssignIf(ref trackWidth, Mathf.Clamp(trackWidth, 1f, 2.6f));

            // The centre of mass must sit inside the chassis, or the car will flip on the first
            // corner and the cause will not be obvious.
            Vector3 clampedCentre = new Vector3(
                Mathf.Clamp(centreOfMass.x, -chassisHalfExtents.x, chassisHalfExtents.x),
                Mathf.Clamp(centreOfMass.y, -chassisHalfExtents.y, chassisHalfExtents.y),
                Mathf.Clamp(centreOfMass.z, -chassisHalfExtents.z, chassisHalfExtents.z));
            changed |= AssignIf(ref centreOfMass, clampedCentre);

            if (redlineRpm <= idleRpm)
            {
                redlineRpm = idleRpm + 1000f;
                changed = true;
            }

            if (shiftDownRpm <= 0f || shiftDownRpm >= shiftUpRpm)
            {
                shiftDownRpm = Mathf.Min(shiftUpRpm * 0.5f, idleRpm * 1.8f);
                changed = true;
            }

            if (forwardRatios == null || forwardRatios.Length == 0)
            {
                // A car with no gears cannot move at all, so this is a hard repair rather than a clamp.
                forwardRatios = new[] { 3.6f, 2.1f, 1.4f, 1.05f, 0.82f };
                changed = true;
            }
            else
            {
                for (int i = 0; i < forwardRatios.Length; i++)
                {
                    if (forwardRatios[i] > 0.01f) continue;
                    forwardRatios[i] = 1f;
                    changed = true;
                }
            }

            if (finalDrive <= 0.1f)
            {
                finalDrive = 3.9f;
                changed = true;
            }

            if (reverseRatio <= 0.1f)
            {
                reverseRatio = 3.2f;
                changed = true;
            }

            // The suspension hard-point is solved rather than authored: for the wheel to rest one
            // radius above the ground the connection must sit `rest + radius` below the chassis
            // centre, offset by half the body height.
            suspensionRestLength = Mathf.Clamp(suspensionRestLength, 0.05f, chassisHalfExtents.y * 2f);
            suspensionTravel = Mathf.Clamp(suspensionTravel, 0.02f, suspensionRestLength + 0.2f);
            if (suspensionSpring <= 0f)
            {
                suspensionSpring = 35000f;
                changed = true;
            }

            if (suspensionDamper <= 0f)
            {
                suspensionDamper = 2600f;
                changed = true;
            }

            changed |= AssignIf(ref maxSteerAngle, Mathf.Clamp(maxSteerAngle, 5f, 60f));
            changed |= AssignIf(ref tyreGrip, Mathf.Clamp(tyreGrip, 0.2f, 5f));
            changed |= AssignIf(ref maxBrakeTorque, Mathf.Clamp(maxBrakeTorque, 100f, 20000f));
            changed |= AssignIf(ref brakeBias, Mathf.Clamp(brakeBias, 0.1f, 0.9f));

            if (paintOptions == null || paintOptions.Length == 0)
            {
                paintOptions = new[] { new Color(0.82f, 0.16f, 0.13f) };
                changed = true;
            }

            return changed;
        }

        private static bool AssignIf(ref float field, float value)
        {
            if (Mathf.Approximately(field, value)) return false;
            field = value;
            return true;
        }

        private static bool AssignIf(ref Vector3 field, Vector3 value)
        {
            if (field == value) return false;
            field = value;
            return true;
        }

        /// <summary>Rear axle share of the drive torque, 0..1.</summary>
        public float RearTorqueShare
        {
            get
            {
                switch (drivetrain)
                {
                    case DrivetrainType.RearWheelDrive: return 1f;
                    case DrivetrainType.AllWheelDrive: return 0.5f;
                    default: return 0f;
                }
            }
        }

        /// <summary>Front axle share of the drive torque, 0..1.</summary>
        public float FrontTorqueShare
        {
            get { return 1f - RearTorqueShare; }
        }

        /// <summary>Distance from the chassis centre to the front or rear axle, in metres.</summary>
        public float HalfWheelbase
        {
            get { return wheelbase * 0.5f; }
        }

        /// <summary>Distance from the chassis centre to the left or right wheel, in metres.</summary>
        public float HalfTrack
        {
            get { return trackWidth * 0.5f; }
        }

        private void OnValidate()
        {
            Validate();
        }
    }
}
