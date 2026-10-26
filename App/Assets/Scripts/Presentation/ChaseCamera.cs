using AeroDrive.Vehicles;
using UnityEngine;

namespace AeroDrive.Presentation
{
    /// <summary>
    /// The camera modes the player can cycle through.
    /// </summary>
    public enum CameraMode
    {
        /// <summary>Behind and above the car. The default.</summary>
        Chase = 0,

        /// <summary>Closer and lower, for a sense of speed.</summary>
        Close = 1,

        /// <summary>Looking forward over the bonnet.</summary>
        Hood = 2,

        /// <summary>Free look around the car, from outside. Useful for admiring it.</summary>
        Orbit = 3,
    }

    /// <summary>
    /// Follows the car. Handles the four <see cref="CameraMode"/>s, speed-based field of view, and
    /// the collision that stops the camera from ending up inside a wall.
    /// </summary>
    /// <remarks>
    /// The camera is the single biggest contributor to how fast a car feels, and almost all of that
    /// comes from three things, in order: field of view that widens with speed, a slight lag behind
    /// the car's heading so acceleration is visible, and the pull-back that happens under braking.
    /// All three are here. Everything is damped rather than snapped, because an undamped chase
    /// camera turns every gear change into a jolt.
    /// </remarks>
    [RequireComponent(typeof(Camera))]
    public sealed class ChaseCamera : MonoBehaviour
    {
        [Header("Target")]
        [Tooltip("The car to follow.")]
        public VehicleController target;

        [Header("Placement")]
        [Tooltip("Height above the car's pivot, in metres.")]
        public float height = 2.6f;

        [Tooltip("Distance behind the car's pivot, in metres.")]
        public float distance = 6.5f;

        [Tooltip("Distance the camera is pulled back on top of the mode's distance, per 100 km/h.")]
        public float speedPullback = 1.8f;

        [Header("Response")]
        [Tooltip("Seconds to catch up with the car's position. Lower is tighter and less comfortable.")]
        [Range(0.02f, 0.5f)]
        public float positionSmoothing = 0.12f;

        [Tooltip("Seconds to catch up with the car's heading.")]
        [Range(0.02f, 1f)]
        public float rotationSmoothing = 0.3f;

        [Header("Field of view")]
        public float baseFieldOfView = 62f;

        [Tooltip("Additional field of view at the car's top speed.")]
        public float speedFieldOfView = 14f;

        [Header("Collision")]
        [Tooltip("Layers the camera must not pass through.")]
        public LayerMask collisionMask = ~0;

        [Tooltip("Radius used when pushing the camera out of scenery.")]
        public float collisionRadius = 0.35f;

        private Camera _camera;
        private CameraMode _mode = CameraMode.Chase;
        private Vector3 _positionVelocity;
        private float _heading;
        private float _headingVelocity;
        private float _orbitYaw;
        private float _orbitPitch = 12f;
        private float _lastImpactTime = float.NegativeInfinity;

        /// <summary>Current mode. Assigning applies it on the next frame.</summary>
        public CameraMode Mode
        {
            get { return _mode; }
            set { _mode = value; }
        }

        /// <summary>Look input, in degrees per second, from the mouse or the right stick.</summary>
        public Vector2 LookDelta { get; set; }

        /// <summary>The camera's own transform, for systems that need it (audio listener, HUD).</summary>
        public Camera Camera
        {
            get { return _camera; }
        }

        private void Awake()
        {
            _camera = GetComponent<Camera>();
            _camera.fieldOfView = baseFieldOfView;
        }

        /// <summary>Position the camera immediately, with no smoothing. Used when a session starts.</summary>
        public void SnapToTarget()
        {
            if (target == null) return;

            _heading = target.transform.eulerAngles.y;
            _positionVelocity = Vector3.zero;
            _headingVelocity = 0f;

            Vector3 desired = DesiredPosition();
            transform.position = desired;
            transform.rotation = Quaternion.LookRotation(
                (target.transform.position + Vector3.up - desired).normalized, Vector3.up);
        }

        /// <summary>Cycle to the next mode, in the order the enum declares them.</summary>
        public CameraMode CycleMode()
        {
            int count = System.Enum.GetValues(typeof(CameraMode)).Length;
            _mode = (CameraMode)(((int)_mode + 1) % count);
            return _mode;
        }

        private void LateUpdate()
        {
            if (target == null) return;

            float dt = Time.deltaTime;
            if (dt <= 0f) return;

            UpdateOrbitInput(dt);

            if (_mode == CameraMode.Orbit)
            {
                UpdateOrbit(dt);
                LookDelta = Vector2.zero;
                return;
            }

            // The heading follows the car's forward direction, but trails it: the lag is what makes
            // the car visibly accelerate away from the camera.
            float targetHeading = Mathf.Atan2(target.transform.forward.x, target.transform.forward.z) * Mathf.Rad2Deg;
            _heading = Mathf.SmoothDampAngle(_heading, targetHeading, ref _headingVelocity, rotationSmoothing, Mathf.Infinity, dt);

            Vector3 desired = DesiredPosition();

            if (_mode == CameraMode.Hood)
            {
                // An on-board view is bolted to the car. Smoothing it would let the camera lag
                // outside the windscreen on every gear change.
                transform.position = desired;
            }
            else
            {
                desired = ResolveCollision(desired);
                transform.position = Vector3.SmoothDamp(
                    transform.position, desired, ref _positionVelocity, positionSmoothing, Mathf.Infinity, dt);
            }

            Vector3 lookAt = target.transform.position + Vector3.up * 1.1f
                             + target.transform.forward * Mathf.Clamp(target.SignedSpeed * 0.15f, -2f, 4f);

            Vector3 lookDirection = lookAt - transform.position;
            if (lookDirection.sqrMagnitude > 0.0001f)
            {
                Quaternion desiredRotation = Quaternion.LookRotation(lookDirection, Vector3.up);
                transform.rotation = Quaternion.Slerp(transform.rotation, desiredRotation, Mathf.Clamp01(dt * 10f));
            }

            UpdateFieldOfView(dt);
            LookDelta = Vector2.zero;
        }

        private void UpdateOrbitInput(float dt)
        {
            if (LookDelta.sqrMagnitude > 0f)
            {
                _orbitYaw += LookDelta.x * dt;
                _orbitPitch = Mathf.Clamp(_orbitPitch - LookDelta.y * dt, -20f, 70f);
            }
        }

        private void UpdateOrbit(float dt)
        {
            float radius = distance + 2f;
            Quaternion rotation = Quaternion.Euler(_orbitPitch, _orbitYaw, 0f);
            Vector3 offset = rotation * new Vector3(0f, 0f, -radius);

            transform.position = Vector3.SmoothDamp(
                transform.position,
                target.transform.position + Vector3.up * 1.2f + offset,
                ref _positionVelocity,
                Mathf.Max(dt, positionSmoothing * 2f),
                Mathf.Infinity,
                dt);

            transform.rotation = Quaternion.LookRotation(
                target.transform.position + Vector3.up - transform.position, Vector3.up);

            UpdateFieldOfView(dt);
        }

        private Vector3 DesiredPosition()
        {
            float distanceForMode = _mode == CameraMode.Close ? distance * 0.62f : distance;
            float heightForMode = _mode == CameraMode.Hood ? 1.05f : height;
            distanceForMode = _mode == CameraMode.Hood ? 0.9f : distanceForMode;

            float speedKmh = target.SpeedKmh;
            float pullback = speedFieldOfView <= 0f ? 0f : (speedKmh / 100f) * speedPullback;

            Quaternion heading = Quaternion.Euler(0f, _heading, 0f);
            Vector3 basePosition = target.transform.position
                                   + heading * new Vector3(0f, 0f, -(distanceForMode + pullback))
                                   + Vector3.up * heightForMode;

            if (_mode == CameraMode.Hood)
            {
                return target.transform.position
                       + target.transform.forward * 0.4f
                       + Vector3.up * heightForMode;
            }

            return basePosition;
        }

        /// <summary>
        /// Pull the camera in if scenery is between it and the car.
        /// </summary>
        /// <remarks>
        /// Without this the camera spends every tight corner behind a wall, showing the player the
        /// inside of a building. The probe runs from the car outward and stops short of the first
        /// hit rather than stopping at it, so the near clip plane does not poke through.
        /// </remarks>
        private Vector3 ResolveCollision(Vector3 desired)
        {
            Vector3 pivot = target.transform.position + Vector3.up * 1.1f;
            Vector3 direction = desired - pivot;
            float length = direction.magnitude;
            if (length < 0.01f) return desired;

            RaycastHit hit;
            if (Physics.SphereCast(pivot, collisionRadius, direction.normalized, out hit, length, collisionMask, QueryTriggerInteraction.Ignore))
            {
                // Skip hits on the car itself, which would otherwise pin the camera to the bumper.
                if (hit.transform != target.transform && !hit.transform.IsChildOf(target.transform))
                {
                    return pivot + direction.normalized * Mathf.Max(1.2f, hit.distance - collisionRadius);
                }
            }

            return desired;
        }

        private void UpdateFieldOfView(float dt)
        {
            float speedFraction = Mathf.InverseLerp(0f, 220f, target.SpeedKmh);
            float targetFov = baseFieldOfView + speedFieldOfView * speedFraction;

            if (_mode == CameraMode.Hood) targetFov += 4f;

            _camera.fieldOfView = Mathf.Lerp(_camera.fieldOfView, targetFov, Mathf.Clamp01(dt * 2.5f));
        }

        /// <summary>Shake the camera on a heavy impact. Called by the session when it hears one.</summary>
        public void AddImpactShake(float impactSpeed)
        {
            if (impactSpeed < 5f) return;
            if (Time.time - _lastImpactTime < 0.15f) return;

            _lastImpactTime = Time.time;

            // A short positional kick, scaled by how hard the hit was, capped so a big crash does not
            // fling the camera off the map.
            float magnitude = Mathf.Min(impactSpeed * 0.02f, 0.35f);
            transform.position += Random.insideUnitSphere * magnitude;
        }
    }
}
