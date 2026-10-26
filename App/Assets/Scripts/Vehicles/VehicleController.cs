using System;
using AeroDrive.Core;
using AeroDrive.Input;
using UnityEngine;

namespace AeroDrive.Vehicles
{
    /// <summary>
    /// Turns driver input into motion: pedals, gears, steering and grip, applied to four
    /// <see cref="WheelCollider"/>s.
    /// </summary>
    /// <remarks>
    /// Structure worth knowing before changing anything here:
    ///
    /// * **All tuning lives in <see cref="VehicleConfig"/>.** If a number needs typing into this
    ///   file to make a car handle, it belongs in the config instead.
    /// * **The gearbox is a pure function.** <see cref="Gearbox.Step"/> is handed a wheel speed and
    ///   the pedals and returns a torque; this class only applies the result. That split is what
    ///   lets the shift logic be unit-tested without a scene.
    /// * **Assists are subtractive.** Traction control and stability assist can only reduce what the
    ///   driver asked for, never add. An assist that adds torque makes a car feel possessed.
    /// * **Everything is done in <see cref="FixedUpdate"/>, at the physics rate.** Wheel colliders
    ///   and the gearbox both integrate over time, so running them from a variable-rate frame would
    ///   make the car's behaviour depend on the machine it is running on.
    /// </remarks>
    [RequireComponent(typeof(Rigidbody))]
    public sealed class VehicleController : MonoBehaviour
    {
        [Header("Configuration")]
        [Tooltip("Handling data for this vehicle. Required.")]
        public VehicleConfig config;

        [Header("Wheels")]
        public WheelCollider frontLeft;
        public WheelCollider frontRight;
        public WheelCollider rearLeft;
        public WheelCollider rearRight;

        [Tooltip("Meshes that follow the wheel colliders, in the same order.")]
        public Transform frontLeftVisual;
        public Transform frontRightVisual;
        public Transform rearLeftVisual;
        public Transform rearRightVisual;

        [Header("References")]
        [Tooltip("The event bus to publish gear changes and impacts on. Optional.")]
        public EventBus bus;

        [Tooltip("Headlight objects to switch on and off. Optional.")]
        public GameObject headlights;

        [Header("Recovery")]
        [Tooltip("Seconds a car may be upside down or stuck before it is offered a recovery.")]
        [Range(1f, 15f)]
        public float stuckTimeout = 4f;

        [Header("Handbrake")]
        [Tooltip("Rear lateral grip retained while the handbrake is held. Lower means the tail steps out further.")]
        [Range(0.1f, 1f)]
        public float handbrakeGripFactor = 0.35f;

        private float HandbrakeGripFactor
        {
            get { return Mathf.Clamp(handbrakeGripFactor, 0.1f, 1f); }
        }

        private Rigidbody _body;
        private IVehicleInputSource _inputSource;
        private GearboxState _gearbox;
        private VehicleInputState _input;

        private float _steerAngle;
        private float _signedSpeed;
        private float _lastImpactTime = float.NegativeInfinity;
        private float _stuckTimer;
        private float _sessionSeconds;

        private Vector3 _spawnPosition;
        private Quaternion _spawnRotation;

        // Cached so the same array is not rebuilt every physics step.
        private WheelCollider[] _wheels;
        private Transform[] _visuals;

        /// <summary>Signed road speed in m/s along the car's forward axis. Negative means reversing.</summary>
        public float SignedSpeed
        {
            get { return _signedSpeed; }
        }

        /// <summary>Absolute road speed in km/h.</summary>
        public float SpeedKmh
        {
            get { return Mathf.Abs(_signedSpeed) * 3.6f; }
        }

        /// <summary>Engine speed in RPM.</summary>
        public float Rpm
        {
            get { return _gearbox.rpm; }
        }

        /// <summary>Current gear: -1 reverse, 0 neutral, 1..N forward.</summary>
        public int Gear
        {
            get { return _gearbox.gear; }
        }

        public string GearLabel
        {
            get { return Gears.Label(_gearbox.gear); }
        }

        /// <summary>True while the gearbox is between gears and torque is cut.</summary>
        public bool IsShifting
        {
            get { return _gearbox.shiftTimer > 0f; }
        }

        /// <summary>True when the player has manual shifting enabled.</summary>
        public bool ManualGearbox
        {
            get { return _gearbox.manual; }
            set { _gearbox.manual = value; }
        }

        /// <summary>Accumulated damage, 0..100. At the config's critical threshold the engine is dead.</summary>
        public float DamagePercent { get; private set; }

        /// <summary>Engine health as a 0..1 fraction, for the HUD's damage bar.</summary>
        public float EngineHealth
        {
            get { return Mathf.Clamp01(1f - DamagePercent / 100f); }
        }

        /// <summary>True once damage has passed the critical threshold: the car is undriveable.</summary>
        public bool IsDisabled
        {
            get { return config != null && DamagePercent >= config.criticalDamage; }
        }

        /// <summary>Average drive-wheel slip, 0 (gripping) upward. Drives skid marks and tyre audio.</summary>
        public float DriveWheelSlip { get; private set; }

        /// <summary>How much the car is sliding sideways, 0..1. Drives the skid effect.</summary>
        public float LateralSlip { get; private set; }

        /// <summary>The config actually in use. Null only if none was assigned.</summary>
        public VehicleConfig Config
        {
            get { return config; }
        }

        /// <summary>Called by the session to hand the car an input source.</summary>
        public void SetInputSource(IVehicleInputSource source)
        {
            _inputSource = source;
        }

        /// <summary>Where the car started, for recovery and for "return to road".</summary>
        public void SetSpawnPoint(Vector3 position, Quaternion rotation)
        {
            _spawnPosition = position;
            _spawnRotation = rotation;
        }

        private void Awake()
        {
            _body = GetComponent<Rigidbody>();
            _gearbox = GearboxState.Default();

            _wheels = new[] { frontLeft, frontRight, rearLeft, rearRight };
            _visuals = new[] { frontLeftVisual, frontRightVisual, rearLeftVisual, rearRightVisual };

            ApplyConfig();

            _spawnPosition = transform.position;
            _spawnRotation = transform.rotation;
        }

        /// <summary>
        /// Push the config into the Rigidbody and the wheel colliders.
        /// </summary>
        /// <remarks>
        /// Public because a garage that changes cars at runtime needs to re-apply, and because the
        /// editor tool that creates wheel colliders from a config uses it.
        /// </remarks>
        public void ApplyConfig()
        {
            if (config == null)
            {
                Debug.LogError($"[AeroDrive] {name} has no VehicleConfig assigned; the car will not drive.", this);
                enabled = false;
                return;
            }

            config.Validate();

            _body.mass = config.mass;
            // A low centre of mass is the single biggest factor in a car that feels planted. Set it
            // from data rather than letting Unity compute it from the collider, which puts it too
            // high and makes every car want to roll.
            _body.centerOfMass = config.centreOfMass;
            _body.interpolation = RigidbodyInterpolation.Interpolate;
            // Sub-stepping the collision detector is what stops a fast car tunnelling through a wall
            // at speed, which on a 200 km/h supercar is not an edge case.
            _body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;

            ApplyWheelConfig(frontLeft, config.wheelRadius);
            ApplyWheelConfig(frontRight, config.wheelRadius);
            ApplyWheelConfig(rearLeft, config.wheelRadius);
            ApplyWheelConfig(rearRight, config.wheelRadius);
        }

        private void ApplyWheelConfig(WheelCollider wheel, float radius)
        {
            if (wheel == null) return;

            wheel.radius = radius;
            wheel.suspensionDistance = config.suspensionRestLength;

            JointSpring spring = wheel.suspensionSpring;
            spring.spring = config.suspensionSpring;
            spring.damper = config.suspensionDamper;
            spring.targetPosition = 0.5f;
            wheel.suspensionSpring = spring;

            WheelFrictionCurve forward = wheel.forwardFriction;
            forward.stiffness = config.tyreGrip;
            forward.extremumSlip = 0.4f;
            forward.extremumValue = 1f;
            forward.asymptoteSlip = 0.8f;
            forward.asymptoteValue = 0.5f;
            wheel.forwardFriction = forward;

            WheelFrictionCurve sideways = wheel.sidewaysFriction;
            sideways.stiffness = config.tyreGrip;
            sideways.extremumSlip = 0.2f;
            sideways.extremumValue = 1f;
            sideways.asymptoteSlip = 0.5f;
            sideways.asymptoteValue = 0.6f;
            wheel.sidewaysFriction = sideways;
        }

        private void FixedUpdate()
        {
            if (config == null || _wheels == null) return;

            float dt = Time.fixedDeltaTime;
            _sessionSeconds += dt;

            _input = _inputSource != null ? _inputSource.Read(dt) : VehicleInputState.Neutral();

            int previousGear = _gearbox.gear;
            float wheelAngularVelocity = AverageDriveWheelAngularVelocity();

            bool shiftUp = _input.shiftUp;
            bool shiftDown = _input.shiftDown;

            GearboxOutput output = Gearbox.Step(
                ref _gearbox,
                wheelAngularVelocity,
                _input.throttle,
                _input.brake,
                shiftUp,
                shiftDown,
                dt,
                config);

            if (_gearbox.gear != previousGear)
            {
                bus?.Publish(new GameEvents.GearChanged(previousGear, _gearbox.gear));
            }

            ApplySteering(dt);
            ApplyDrive(output);
            ApplyBrakes();
            ApplyAerodynamics();
            ApplyStabilityAssist();
            MeasureSlip();
            UpdateVisuals();
            UpdateStuckDetection(dt);

            _signedSpeed = Vector3.Dot(_body.linearVelocity, transform.forward);
        }

        private float AverageDriveWheelAngularVelocity()
        {
            float total = 0f;
            int count = 0;

            // Both axles contribute on an all-wheel-drive car; only the driven one matters otherwise.
            if (config.FrontTorqueShare > 0f)
            {
                if (frontLeft != null) { total += frontLeft.rpm * Mathf.PI / 30f; count++; }
                if (frontRight != null) { total += frontRight.rpm * Mathf.PI / 30f; count++; }
            }

            if (config.RearTorqueShare > 0f)
            {
                if (rearLeft != null) { total += rearLeft.rpm * Mathf.PI / 30f; count++; }
                if (rearRight != null) { total += rearRight.rpm * Mathf.PI / 30f; count++; }
            }

            if (count == 0) return 0f;
            return total / count;
        }

        private void ApplySteering(float dt)
        {
            float speedFactor = Mathf.InverseLerp(20f, config.steerFalloffSpeed, SpeedKmh);

            // Steering authority falls off with speed. Without this, a light car spins on the spot
            // at 100 km/h because the player asked for full lock and got it.
            float maxAngle = config.maxSteerAngle * Mathf.Lerp(1f, 1f - config.steerSpeedFalloff, speedFactor);
            float targetAngle = _input.steer * maxAngle;

            float rate = Mathf.Abs(targetAngle) > Mathf.Abs(_steerAngle) ? config.steerRate : config.steerReturnRate;
            _steerAngle = Mathf.MoveTowards(_steerAngle, targetAngle, rate * dt);

            // Ackermann: the inner wheel turns tighter than the outer one so the tyres roll rather
            // than scrub through a corner.
            float halfTrack = Mathf.Max(0.1f, config.HalfTrack);
            float halfWheelbase = Mathf.Max(0.1f, config.HalfWheelbase);
            float innerAngle = _steerAngle;
            float outerAngle = _steerAngle;

            if (Mathf.Abs(_steerAngle) > 0.01f)
            {
                float turnRadius = halfWheelbase / Mathf.Tan(Mathf.Abs(_steerAngle) * Mathf.Deg2Rad);
                float inner = Mathf.Atan(halfWheelbase / Mathf.Max(0.1f, turnRadius - halfTrack)) * Mathf.Rad2Deg;
                float outer = Mathf.Atan(halfWheelbase / Mathf.Max(0.1f, turnRadius + halfTrack)) * Mathf.Rad2Deg;
                float sign = Mathf.Sign(_steerAngle);
                innerAngle = inner * sign;
                outerAngle = outer * sign;
            }

            if (_steerAngle > 0f)
            {
                // Turning right: the right wheel is the inner one.
                if (frontRight != null) frontRight.steerAngle = innerAngle;
                if (frontLeft != null) frontLeft.steerAngle = outerAngle;
            }
            else
            {
                if (frontLeft != null) frontLeft.steerAngle = innerAngle;
                if (frontRight != null) frontRight.steerAngle = outerAngle;
            }
        }

        private void ApplyDrive(GearboxOutput output)
        {
            float torque = output.torque;

            // A dead engine delivers nothing, no matter what the pedal says.
            if (IsDisabled) torque = 0f;

            // Traction control and a wet-road-style grip limit both act on the same torque number.
            torque *= TractionControlFactor();

            float frontForce = Gearbox.TorqueToWheelForce(
                torque, output.reduction, config.wheelRadius, config.FrontTorqueShare);
            float rearForce = Gearbox.TorqueToWheelForce(
                torque, output.reduction, config.wheelRadius, config.RearTorqueShare);

            ApplyMotorTorque(frontLeft, frontForce);
            ApplyMotorTorque(frontRight, frontForce);
            ApplyMotorTorque(rearLeft, rearForce);
            ApplyMotorTorque(rearRight, rearForce);
        }

        /// <summary>
        /// Convert the per-wheel force the gearbox produced into the torque a wheel collider wants.
        /// </summary>
        /// <remarks>
        /// <see cref="Gearbox.TorqueToWheelForce"/> already divided by the wheel radius, so the
        /// collider — which applies torque, not force — is given the engine torque scaled by the
        /// axle's torque share and split across the two wheels on that axle. Getting this wrong
        /// once made every car accelerate as if it had no gearing at all, so the conversion lives
        /// here, in one place, rather than inline at each wheel.
        /// </remarks>
        private void ApplyMotorTorque(WheelCollider wheel, float axleForce)
        {
            if (wheel == null) return;

            float radius = Mathf.Max(0.01f, config.wheelRadius);
            wheel.motorTorque = axleForce * radius * 0.5f;
        }

        private float TractionControlFactor()
        {
            if (config.tractionControl <= 0f) return 1f;

            // Slip is the difference between how fast the wheels are spinning and how fast the car
            // is actually travelling. Positive means the wheels are outrunning the road.
            float expectedWheelRpm = Mathf.Abs(_signedSpeed) / (2f * Mathf.PI * Mathf.Max(0.01f, config.wheelRadius)) * 60f;
            float actualRpm = Mathf.Abs(AverageDriveWheelAngularVelocity() / (2f * Mathf.PI) * 60f);
            float excess = Mathf.Max(0f, actualRpm - expectedWheelRpm);

            if (excess <= 5f) return 1f;

            // Fade the intervention in rather than switching it, which would make the car lurch.
            float severity = Mathf.Clamp01((excess - 5f) / 45f);
            return Mathf.Lerp(1f, 1f - config.tractionControl, severity);
        }

        private void ApplyBrakes()
        {
            float brake = _input.brake;

            // In reverse the brake pedal is the accelerator, so it must not also brake.
            if (_gearbox.gear == Gears.Reverse) brake = 0f;

            float frontBrake = brake * config.brakeBias * config.maxBrakeTorque;
            float rearBrake = brake * (1f - config.brakeBias) * config.maxBrakeTorque;

            bool abs = config.absEnabled;
            float speedKmh = SpeedKmh;

            // The ABS rule is a pure function so it can be tested without a scene; the two bugs it
            // exists to prevent are documented on `BrakeAssist` itself.
            float frontTorque = BrakeAssist.ServiceBrake(frontBrake, frontLeft != null ? frontLeft.rpm : 0f, speedKmh, abs);
            if (frontLeft != null) frontLeft.brakeTorque = frontTorque;
            if (frontRight != null)
            {
                frontRight.brakeTorque = BrakeAssist.ServiceBrake(
                    frontBrake, frontRight.rpm, speedKmh, abs);
            }

            float handbrake = _input.handbrake ? config.maxBrakeTorque * config.handbrakeMultiplier : 0f;

            // The handbrake only locks the rear wheels. Applying it to all four would just be a
            // second brake pedal and would not let the car rotate.
            if (rearLeft != null)
            {
                float service = BrakeAssist.ServiceBrake(rearBrake, rearLeft.rpm, speedKmh, abs);
                rearLeft.brakeTorque = Mathf.Max(service, handbrake);

                // Locking the rears is what actually lets the car rotate. With the rear tyres still
                // at full cornering stiffness a locked wheel simply stops the car instead of stepping
                // the tail out, which is why the handbrake used to feel like a second brake pedal.
                // Restore the normal curve on the frame the handbrake is released.
                SetRearLateralGrip(rearLeft, _input.handbrake ? HandbrakeGripFactor : 1f);
            }

            if (rearRight != null)
            {
                float service = BrakeAssist.ServiceBrake(rearBrake, rearRight.rpm, speedKmh, abs);
                rearRight.brakeTorque = Mathf.Max(service, handbrake);
                SetRearLateralGrip(rearRight, _input.handbrake ? HandbrakeGripFactor : 1f);
            }
        }

        /// <summary>
        /// Scale a rear wheel's cornering stiffness, which is what makes the handbrake rotate the car.
        /// </summary>
        private void SetRearLateralGrip(WheelCollider wheel, float factor)
        {
            WheelFrictionCurve sideways = wheel.sidewaysFriction;
            float wanted = config.tyreGrip * factor;
            if (Mathf.Approximately(sideways.stiffness, wanted)) return;
            sideways.stiffness = wanted;
            wheel.sidewaysFriction = sideways;
        }

        private void ApplyAerodynamics()
        {
            Vector3 velocity = _body.linearVelocity;
            float speed = velocity.magnitude;
            if (speed < 0.5f) return;

            // Quadratic drag, so terminal velocity is speed-limited rather than an arbitrary clamp.
            float dragFactor = config.dragCoefficient * 0.5f * 1.2f * speed;
            _body.AddForce(-velocity * dragFactor, ForceMode.Force);

            if (config.downforce <= 0f) return;

            // Downforce grows with the square of speed and is applied at the contact patches, which
            // is what makes a fast car feel like it is being pressed onto the road instead of
            // floating across it.
            float downforce = config.downforce * speed * speed * 0.5f;
            _body.AddForce(-transform.up * downforce, ForceMode.Force);
        }

        private void ApplyStabilityAssist()
        {
            if (config.stabilityAssist <= 0f) return;
            if (SpeedKmh < 15f) return;

            Vector3 localVelocity = transform.InverseTransformDirection(_body.linearVelocity);
            float lateral = localVelocity.x;
            if (Mathf.Abs(lateral) < 0.6f) return;

            // Counter-yaw proportional to how sideways the car is, and only ever opposing the slide.
            // Applied as a torque rather than a force so it cannot change the car's speed.
            float yawCorrection = -lateral * config.stabilityAssist * config.mass * 0.05f;
            _body.AddTorque(transform.up * yawCorrection, ForceMode.Force);
        }

        private void MeasureSlip()
        {
            float total = 0f;
            int count = 0;

            for (int i = 0; i < _wheels.Length; i++)
            {
                WheelCollider wheel = _wheels[i];
                if (wheel == null) continue;

                WheelHit hit;
                if (!wheel.GetGroundHit(out hit)) continue;

                total += Mathf.Abs(hit.forwardSlip) + Mathf.Abs(hit.sidewaysSlip);
                count++;
            }

            DriveWheelSlip = count > 0 ? total / count : 0f;

            Vector3 localVelocity = transform.InverseTransformDirection(_body.linearVelocity);
            float speed = Mathf.Max(1f, _body.linearVelocity.magnitude);
            LateralSlip = Mathf.Clamp01(Mathf.Abs(localVelocity.x) / speed);
        }

        private void UpdateVisuals()
        {
            for (int i = 0; i < _wheels.Length; i++)
            {
                WheelCollider wheel = _wheels[i];
                Transform visual = _visuals != null && i < _visuals.Length ? _visuals[i] : null;
                if (wheel == null || visual == null) continue;

                wheel.GetWorldPose(out Vector3 position, out Quaternion rotation);
                visual.SetPositionAndRotation(position, rotation);
            }
        }

        private void UpdateStuckDetection(float dt)
        {
            bool upsideDown = Vector3.Dot(transform.up, Vector3.up) < 0.25f;

            // Wedged against scenery: full throttle, no movement. The threshold is far lower than
            // the one for a flip, because pulling away slowly from a standstill is not being stuck,
            // and the two cases must not be confused.
            bool wedged = SpeedKmh < 1.5f && _input.throttle > 0.5f;

            if (upsideDown || wedged)
            {
                _stuckTimer += dt;
            }
            else
            {
                _stuckTimer = 0f;
            }

            // Being stuck is a normal outcome on rough terrain and in a race, so the car recovers
            // itself rather than leaving the player to find a menu.
            float threshold = upsideDown ? stuckTimeout : stuckTimeout * 2f;
            if (_stuckTimer >= threshold) Recover();
        }

        /// <summary>Place the car upright at a safe point on the road and clear its momentum.</summary>
        /// <remarks>
        /// Uses the nearest road point when one is available, so recovering does not dump the player
        /// back at the start of the map having lost a minute of driving.
        /// </remarks>
        public void Recover()
        {
            _stuckTimer = 0f;

            Vector3 targetPosition = _spawnPosition;
            Quaternion targetRotation = _spawnRotation;

            // Prefer a point slightly ahead on the road, which puts the car back on the tarmac
            // rather than wherever it happened to leave it.
            RaycastHit hit;
            if (Physics.Raycast(transform.position + Vector3.up * 3f, Vector3.down, out hit, 50f))
            {
                targetPosition = hit.point + Vector3.up * 1.2f;
                targetRotation = LevelRotationOn(hit.normal);
            }

            _body.linearVelocity = Vector3.zero;
            _body.angularVelocity = Vector3.zero;
            _body.position = targetPosition;
            _body.rotation = targetRotation;

            // A recovered car is not in gear: dropping it back into third would launch it.
            _gearbox.gear = Gears.Neutral;
            _gearbox.shiftTimer = 0f;

            bus?.Publish(new GameEvents.VehicleRecovered(targetPosition));
        }

        /// <summary>
        /// An upright rotation on a surface normal, keeping the car's heading where it can.
        /// </summary>
        /// <remarks>
        /// `Quaternion.LookRotation` logs an error and returns the identity when handed a zero vector,
        /// and projecting the car's forward axis onto the ground produces exactly that when the car is
        /// stood on its nose or its tail — the pose recovery is most needed in. The other two axes are
        /// tried before giving up, so a car does not have to be pointing anywhere sensible to be put
        /// back on its wheels.
        /// </remarks>
        private Quaternion LevelRotationOn(Vector3 normal)
        {
            Vector3 forward = Vector3.ProjectOnPlane(transform.forward, normal);
            if (forward.sqrMagnitude < 0.0001f) forward = Vector3.ProjectOnPlane(transform.up, normal);
            if (forward.sqrMagnitude < 0.0001f) forward = Vector3.ProjectOnPlane(transform.right, normal);
            if (forward.sqrMagnitude < 0.0001f) return Quaternion.identity;
            return Quaternion.LookRotation(forward.normalized, normal);
        }

        /// <summary>Switch the headlights on or off.</summary>
        public void SetHeadlights(bool on)
        {
            if (headlights != null) headlights.SetActive(on);
        }

        /// <summary>Reset wear to a brand new car, as the garage does on repair.</summary>
        public void RepairFully()
        {
            DamagePercent = 0f;
        }

        /// <summary>Apply damage directly. Used by the garage and by scripted events.</summary>
        public void ApplyDamage(float amount)
        {
            if (amount <= 0f) return;
            DamagePercent = Mathf.Clamp(DamagePercent + amount, 0f, 100f);
        }

        private void OnCollisionEnter(Collision collision)
        {
            if (config == null) return;

            float impactSpeed = collision.relativeVelocity.magnitude;

            // Kerbs and speed bumps are continuously collided with on rough ground, and treating
            // those as impacts would constantly fire the damage and audio systems.
            if (impactSpeed < 4f) return;

            // The collider belongs to the car itself, so ignore self-contacts and spectators.
            if (collision.rigidbody == _body) return;

            float damage = Mathf.Pow(impactSpeed, 1.6f) * 0.06f * config.damageSensitivity;
            DamagePercent = Mathf.Clamp(DamagePercent + damage, 0f, 100f);

            bool worthReporting = impactSpeed > 6f && Time.time - _lastImpactTime > 0.2f;
            if (worthReporting)
            {
                _lastImpactTime = Time.time;
                bus?.Publish(new GameEvents.Impact(impactSpeed, DamagePercent, transform.position));
            }
        }

        /// <summary>Seconds since the car spawned. Used by the HUD and by challenge scoring.</summary>
        public float SessionSeconds
        {
            get { return _sessionSeconds; }
        }
    }
}
