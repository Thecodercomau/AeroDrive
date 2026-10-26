using UnityEngine;

namespace AeroDrive.Missions
{
    /// <summary>
    /// One gate on a challenge route.
    /// </summary>
    /// <remarks>
    /// The trigger only reports that it was entered; it does not decide whether the entry counts.
    /// Ordering, laps and the clock are the runner's business, and splitting them this way means a
    /// checkpoint can be moved, resized or reused between challenges without any of that logic
    /// needing to know.
    /// </remarks>
    [RequireComponent(typeof(Collider))]
    public sealed class Checkpoint : MonoBehaviour
    {
        [Header("Identity")]
        [Tooltip("Position in the route. Assigned by the runner, or set by hand in the scene.")]
        public int index;

        [Tooltip("The final checkpoint of a lap. Used to know when a lap is complete.")]
        public bool isFinishLine;

        [Header("Presentation")]
        [Tooltip("Shown while this is the next checkpoint to reach.")]
        public GameObject activeVisual;

        [Tooltip("Shown once it has been passed.")]
        public GameObject passedVisual;

        [Tooltip("The direction marker must face, so the player can tell which way to go through it.")]
        public bool alignToRoute = true;

        private ChallengeRunner _runner;

        /// <summary>True once the runner has accepted a pass through this gate.</summary>
        public bool HasBeenPassed { get; private set; }

        /// <summary>The collider, which must be a trigger.</summary>
        public Collider Collider { get; private set; }

        private void Awake()
        {
            Collider = GetComponent<Collider>();
            // Forcing the trigger flag here rather than relying on the scene means a checkpoint that
            // was hand-placed as a solid object still cannot stop the car dead.
            Collider.isTrigger = true;
        }

        /// <summary>Tell the checkpoint who to report to. Called by the runner as it builds the route.</summary>
        public void Initialise(ChallengeRunner runner, int routeIndex, bool finishLine)
        {
            _runner = runner;
            index = routeIndex;
            isFinishLine = finishLine;
            HasBeenPassed = false;
            SetState(false, false);
        }

        /// <summary>Switch the visuals between "next", "passed" and "inactive".</summary>
        public void SetState(bool isNext, bool isPassed)
        {
            HasBeenPassed = isPassed;

            if (activeVisual != null) activeVisual.SetActive(isNext);
            if (passedVisual != null) passedVisual.SetActive(isPassed);
        }

        private void OnTriggerEnter(Collider other)
        {
            if (_runner == null) return;

            // The other collider belongs to a child of the car, so the check walks up the hierarchy.
            // Without this, a checkpoint would never fire for a car whose collider sits on the body
            // mesh rather than on the rigidbody's own GameObject — which is the normal setup.
            Vehicles.VehicleController car = other.GetComponentInParent<Vehicles.VehicleController>();
            if (car == null) return;
            if (car != _runner.Vehicle) return;

            _runner.ReportCheckpointEntered(this);
        }
    }
}
