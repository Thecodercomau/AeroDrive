import RAPIER from '@dimforge/rapier3d-compat';
import { GEAR_NEUTRAL, createGearboxState, gearLabel, stepGearbox } from './gearbox.js';
import { steeringAngleForSpeed } from './vehicleConfig.js';
import { clamp, degToRad, lerp, moveTowards, MS_TO_KMH } from '../utilities/math.js';

/**
 * Wheel layout. Index order is fixed: 0 = front-left, 1 = front-right,
 * 2 = rear-left, 3 = rear-right. The gearbox, drivetrain split, brake bias and
 * the visual mesh all rely on this order.
 */
export const WHEEL_LAYOUT = [
  { name: 'front-left', x: -1, z: 1, steering: true, axle: 'front' },
  { name: 'front-right', x: 1, z: 1, steering: true, axle: 'front' },
  { name: 'rear-left', x: -1, z: -1, steering: false, axle: 'rear' },
  { name: 'rear-right', x: 1, z: -1, steering: false, axle: 'rear' },
];

const SUSPENSION_DIRECTION = { x: 0, y: -1, z: 0 };
// Axle pointing left. With a Y-up / Z-forward chassis this yields a forward
// direction of +Z in Rapier's raycast-vehicle maths (verified by
// tests/vehicle-physics.test.js).
const WHEEL_AXLE = { x: -1, y: 0, z: 0 };

/**
 * A physically simulated vehicle.
 *
 * The chassis is a single dynamic rigid body; the wheels are *raycasts*, not
 * separate bodies. This is the same approach used by production raycast-vehicle
 * simulations: it is fast, stable, and — because the wheel forces are computed
 * explicitly — every handling characteristic is inspectable and tunable.
 *
 * This is deliberately *not* a soft-body model. BeamNG-style deformation is a
 * different (and much heavier) simulation; the architecture here keeps damage
 * and deformation concerns separate so they could be added later without
 * touching the drivetrain or suspension code.
 */
export class Vehicle {
  /**
   * @param {object} options
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} options.physics
   * @param {object} options.definition Normalised vehicle definition.
   * @param {{x:number,y:number,z:number}} [options.spawn]
   * @param {number} [options.heading] Yaw in radians.
   * @param {THREE.Group|null} [options.object3D] Visual model.
   */
  constructor({ physics, definition, spawn = { x: 0, y: 2, z: 0 }, heading = 0, object3D = null }) {
    this.physics = physics;
    this.definition = definition;
    this.object3D = object3D;
    this.disposed = false;

    this.wheelStates = WHEEL_LAYOUT.map(() => ({
      inContact: false,
      suspensionLength: 0,
      suspensionForce: 0,
      steerAngle: 0,
      rotation: 0,
      surface: 'asphalt',
      forwardImpulse: 0,
      sideImpulse: 0,
      slip: 0,
    }));

    this.gearbox = createGearboxState({
      gear: GEAR_NEUTRAL,
      manual: false,
    });

    // Runtime telemetry surfaced to the HUD and audio systems.
    this.telemetry = {
      speedKmh: 0,
      forwardSpeed: 0,
      lateralSpeed: 0,
      rpm: this.definition.engine.idleRpm,
      gear: GEAR_NEUTRAL,
      gearLabel: 'N',
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: false,
      wheelSlip: 0,
      airborne: false,
      onSurface: 'asphalt',
      damage: 0,
      odometer: 0,
      acceleration: 0,
      wonkySteering: 0,
      lastImpact: 0,
    };

    this.headlightsOn = true;
    this.hornActive = false;
    /**
     * Multiplier applied to every tyre's grip budget.
     *
     * Weather is a property of the *world*, not of the car, so it is pushed in
     * from outside rather than baked into the vehicle definition — a wet road is
     * still wet when you change cars.
     */
    this.gripMultiplier = 1;
    this.driftMode = false;
    /** Set when a collision event names this vehicle's collider. */
    this._impactPending = false;
    this._impactSpeedLoss = 0;

    this._prevSpeed = 0;
    this._smoothedAccel = 0;
    this._steerAngle = 0;
    this._wheelRotation = WHEEL_LAYOUT.map(() => 0);
    this._collisionUnsub = null;

    // Pose at the START of the current fixed step, kept so the renderer can
    // interpolate between two simulation states instead of snapping to the
    // newest one. Without this the car's on-screen motion is a staircase built
    // from 1/60 s quanta: on any display that is not exactly 60 Hz (a 120 Hz
    // MacBook panel, a 144 Hz monitor) some frames advance two steps and some
    // one, and the car visibly judders. See `syncVisual`.
    this._prevPosition = { x: 0, y: 0, z: 0 };
    this._prevRotation = { x: 0, y: 0, z: 0, w: 1 };
    this._visualRotation = { x: 0, y: 0, z: 0, w: 1 };

    this._buildBody(spawn, heading);
    this._buildController();
    this._registerCollisionDamage();

    this.syncVisual();
  }

  /** Remember the pose the simulation is starting this fixed step from. */
  _captureStepStart() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._prevPosition.x = t.x;
    this._prevPosition.y = t.y;
    this._prevPosition.z = t.z;
    this._prevRotation.x = r.x;
    this._prevRotation.y = r.y;
    this._prevRotation.z = r.z;
    this._prevRotation.w = r.w;
  }

  /* ------------------------------- construction ------------------------------ */

  _buildBody(spawn, heading) {
    const { definition } = this;
    const half = definition.chassisHalfExtents;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation(quaternionFromYaw(heading))
      .setLinearDamping(definition.linearDamping)
      .setAngularDamping(definition.angularDamping)
      // A vehicle that falls asleep mid-drive is a bug players notice, so we
      // disable sleeping and rely on damping to settle it instead.
      .setCanSleep(false)
      .setCcdEnabled(true);

    this.body = this.physics.world.createRigidBody(bodyDesc);

    const mass = definition.massKg;
    const wx = 2 * half.x;
    const wy = 2 * half.y;
    const wz = 2 * half.z;
    const inertia = {
      x: (mass / 12) * (wy * wy + wz * wz),
      y: (mass / 12) * (wx * wx + wz * wz),
      z: (mass / 12) * (wx * wx + wy * wy),
    };

    const colliderDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setFriction(definition.colliderFriction)
      .setRestitution(definition.colliderRestitution)
      // Explicit mass properties let the centre of mass sit low and slightly
      // rearward of the geometric centre, which is the single biggest factor in
      // whether a car feels planted or feels like a shopping trolley.
      .setMassProperties(mass, definition.centreOfMass, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    this.collider = this.physics.world.createCollider(colliderDesc, this.body);
    this.physics.registerSurface(this.collider, 'asphalt');
    this.physics.registerTag(this.collider, 'vehicle:player');
    this.physics.markPlayerCollider(this.collider);
  }

  _buildController() {
    const { definition } = this;
    const controller = this.physics.world.createVehicleController(this.body);
    this.controller = controller;

    // Rapier defaults are y-up (1) / z-forward (2), which is exactly the
    // chassis convention used throughout this project, so the axes are left
    // at their defaults rather than being re-declared here.

    const halfTrack = definition.derived.halfTrack;
    const halfWheelbase = definition.derived.halfWheelbase;
    // Height of the suspension hard-point in chassis space. Solving for the
    // rest pose (wheel centre one radius above the ground) keeps every vehicle
    // correctly planted without per-vehicle magic numbers.
    const bodyHalfHeight = definition.chassisHalfExtents.y;
    const connectionY =
      definition.suspension.restLength + definition.wheelRadius - bodyHalfHeight - 0.1;
    // Kept for `wheelWorldPosition`, which needs the same rest pose the
    // controller was built with.
    this.wheelConnectionY = connectionY;

    WHEEL_LAYOUT.forEach((layout, index) => {
      const connection = {
        x: layout.x * halfTrack,
        y: connectionY,
        z: layout.z * halfWheelbase,
      };
      controller.addWheel(
        connection,
        SUSPENSION_DIRECTION,
        WHEEL_AXLE,
        definition.suspension.restLength,
        definition.wheelRadius,
      );

      controller.setWheelSuspensionStiffness(index, definition.suspension.stiffness);
      controller.setWheelSuspensionCompression(index, definition.suspension.compression);
      controller.setWheelSuspensionRelaxation(index, definition.suspension.relaxation);
      controller.setWheelMaxSuspensionTravel(index, definition.suspension.maxTravel);
      controller.setWheelMaxSuspensionForce(index, definition.suspension.maxForce);
      controller.setWheelFrictionSlip(index, definition.tyre.frictionSlip);
      controller.setWheelSideFrictionStiffness(index, definition.tyre.sideFrictionStiffness);
    });
  }

  _registerCollisionDamage() {
    this._collisionUnsub = this.physics.onCollision((h1, h2, started) => {
      if (!started) return;
      const isMine = this.collider.handle === h1 || this.collider.handle === h2;
      if (!isMine) return;
      const otherHandle = this.collider.handle === h1 ? h2 : h1;
      const tag = this.physics.tagOf(otherHandle);
      if (tag === 'terrain' || tag === 'mesh') return;
      // Record the impact; the magnitude is resolved in `step()` where the
      // velocity delta for this frame is known.
      this._impactPending = true;
    });
  }

  /* --------------------------------- control -------------------------------- */

  /** Engage manual shifting (used by the tuning UI / optional manual mode). */
  setManualTransmission(manual) {
    this.gearbox.manual = Boolean(manual);
  }

  setDriftMode(enabled) {
    this.driftMode = Boolean(enabled);
  }

  /**
   * Advance the vehicle by one fixed simulation step.
   * @param {number} dt
   * @param {import('../input/inputMapping.js').emptyControlState} input
   */
  step(dt, input) {
    if (this.disposed) return;
    this._captureStepStart();
    const { definition } = this;
    const velocity = this.body.linvel();
    const forward = this.forwardVector();
    const right = { x: forward.z, y: 0, z: -forward.x };

    const forwardSpeed = velocity.x * forward.x + velocity.z * forward.z;
    const lateralSpeed = velocity.x * right.x + velocity.z * right.z;
    const speed = Math.hypot(velocity.x, velocity.z);
    const speedKmh = speed * MS_TO_KMH;

    // Signed speed for the gearbox: reversing is negative forward speed.
    const wheelAngularVelocity = forwardSpeed / definition.wheelRadius;

    const throttle = clamp(input.throttle ?? 0, 0, 1);
    const brakeInput = clamp(input.brake ?? 0, 0, 1);
    const handbrake = Boolean(input.handbrake);

    // --- Transmission ------------------------------------------------------
    const shift = stepGearbox(this.gearbox, {
      wheelAngularVelocity,
      input: {
        throttle,
        brake: brakeInput,
        handbrake,
        shiftUp: input.shiftUp,
        shiftDown: input.shiftDown,
      },
      config: definition.engine,
      dt,
    });

    // --- Steering ----------------------------------------------------------
    // `input.steer` is +1 for *right* (see inputMapping). Internally the code
    // works in a left-positive steering angle, because that matches the
    // right-handed chassis axes (forward +Z, up +Y => driver's left is +X), the
    // bicycle model below, and the wheel mesh rotation.
    const targetSteer = steeringAngleForSpeed(-(input.steer ?? 0), speedKmh, definition.steering);
    const steerRate = degToRad(
      input.steer
        ? definition.steering.maxSteerRateDegPerSec
        : definition.steering.returnRateDegPerSec,
    );
    this._steerAngle = moveTowards(this._steerAngle, targetSteer, steerRate * dt);
    for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
      if (WHEEL_LAYOUT[i].steering) this.controller.setWheelSteering(i, this._steerAngle);
      else this.controller.setWheelSteering(i, 0);
    }

    // --- Refresh wheel state before computing forces ----------------------
    this.controller.updateVehicle(dt);
    this._readWheelState();

    // --- Engine force ------------------------------------------------------
    const drivetrain = definition.derived.drivetrainFactors;
    const axleWheelCount = { front: 2, rear: 2 };
    const surface = this.telemetry.onSurface;
    const surfaceGrip = (definition.tyre.surfaceGrip[surface] ?? 1) * this.gripMultiplier;

    const wheelForce = new Array(4).fill(0);
    if (shift.torque > 0) {
      const total = (shift.torque * shift.ratio) / definition.wheelRadius;
      WHEEL_LAYOUT.forEach((layout, index) => {
        const share = drivetrain[layout.axle] / axleWheelCount[layout.axle];
        wheelForce[index] = total * share;
      });
    }

    // Engine braking / coasting resistance when off the throttle.
    if (throttle < 0.05 && Math.abs(forwardSpeed) > 0.4 && !shift.shifting) {
      const engineBrake = definition.brakes.maxBrake * 0.06;
      WHEEL_LAYOUT.forEach((layout, index) => {
        const share = drivetrain[layout.axle] / axleWheelCount[layout.axle];
        wheelForce[index] -= Math.sign(forwardSpeed) * engineBrake * share;
      });
    }

    this._applyTractionControl(wheelForce, { drivetrain, throttle });

    WHEEL_LAYOUT.forEach((layout, index) => {
      this.controller.setWheelEngineForce(index, wheelForce[index]);
    });

    // --- Brakes ------------------------------------------------------------
    const brakeBiasFront = clamp(definition.brakes.brakeBias, 0.1, 0.9);
    WHEEL_LAYOUT.forEach((layout, index) => {
      let brake = 0;
      if (brakeInput > 0) {
        // Braking while rolling forward is normal braking; holding brake from a
        // standstill engages reverse (handled by the gearbox).
        if (forwardSpeed > 0.5 || this.gearbox.gear !== -1) {
          const bias = layout.axle === 'front' ? brakeBiasFront : 1 - brakeBiasFront;
          brake += definition.brakes.maxBrake * brakeInput * bias;
        }
      }
      if (handbrake && layout.axle === 'rear') {
        brake += definition.brakes.maxBrake * definition.brakes.handbrakeFactor;
        // Locking the rear wheels is what actually lets the car rotate: with
        // full rear grip the handbrake would only ever slow you down. The drop
        // is deliberately large (to ~35% of normal) so the rear end steps out.
        const driftGrip = this.driftMode && layout.axle === 'rear' ? 0.78 : 1;
        this.controller.setWheelFrictionSlip(
          index,
          definition.tyre.frictionSlip * 0.35 * driftGrip,
        );
      } else {
        const driftGrip = this.driftMode && layout.axle === 'rear' ? 0.78 : 1;
        this.controller.setWheelFrictionSlip(
          index,
          definition.tyre.frictionSlip * surfaceGrip * driftGrip,
        );
      }
      this.controller.setWheelSideFrictionStiffness(
        index,
        definition.tyre.sideFrictionStiffness *
          (this.driftMode && layout.axle === 'rear' ? 0.72 : 1),
      );

      if (definition.assists.abs && brakeInput > 0.15 && brake > 0) {
        brake = Math.min(brake, this._maxLongitudinalForce(index) * 0.9);
      }
      // `maxBrake` is a force (N); Rapier's wheel brake input is an impulse.
      this.controller.setWheelBrake(index, brake * dt);
    });

    // --- Secondary forces --------------------------------------------------
    // Rapier's `addForce` / `addTorque` are PERSISTENT: whatever is added stays
    // applied every timestep until it is explicitly cleared. Reset first, then
    // re-apply this step's own forces.
    //
    // `resetForces` clears the user forces **but not the user torques** — they
    // are separate accumulators, and the stability assist below adds a torque on
    // every step. Resetting only the forces therefore let the yaw correction
    // accumulate forever: measured in-browser, the body's user torque reached
    // ~30 kN·m and the car pirouetted at 6.7 rad/s (385°/s) with the steering
    // centred — which is exactly the "it spins, jitters and flings itself"
    // behaviour this project was reported for. Both accumulators must be
    // cleared every step; `tools/probe-torque-accumulation.mjs` pins this down.
    this.body.resetForces(true);
    this.body.resetTorques(true);
    this._applyAeroForces(speed, forward);
    this._applyStabilityAssist({ forward, forwardSpeed, lateralSpeed });

    // --- Damage from this frame's impact ----------------------------------
    this._resolveImpact();

    // --- Update telemetry (read AFTER updateVehicle so it reflects the step) --
    this.telemetry.speedKmh = speedKmh;
    this.telemetry.forwardSpeed = forwardSpeed;
    this.telemetry.lateralSpeed = lateralSpeed;
    this.telemetry.rpm = shift.rpm;
    this.telemetry.gear = shift.gear;
    this.telemetry.gearLabel = gearLabel(shift.gear);
    this.telemetry.throttle = throttle;
    this.telemetry.brake = brakeInput;
    this.telemetry.steer = input.steer ?? 0;
    this.telemetry.handbrake = handbrake;
    this.telemetry.wheelSlip = this.telemetry.wheelSlip * 0.8 + this._computeSlipProbe() * 0.2;
    this.telemetry.onSurface = this._dominantSurface();
    this.telemetry.odometer += speed * dt;

    const accel = (speed - this._prevSpeed) / Math.max(dt, 1e-5);
    this._prevSpeed = speed;
    this._smoothedAccel = lerp(this._smoothedAccel, accel, clamp(dt * 8, 0, 1));
    this.telemetry.acceleration = this._smoothedAccel;

    // Airborne when no wheel is touching the ground for a beat.
    const anyContact = this.wheelStates.some((w) => w.inContact);
    this.telemetry.airborne = !anyContact;
    this.telemetry.wonkySteering = clamp(
      this._steerAngle / (definition.derived.maxSteerRadians || 1),
      -1,
      1,
    );

    // Integrate wheel spin for the visual-only rotation.
    const spin = forwardSpeed / definition.wheelRadius;
    for (let i = 0; i < 4; i++) this._wheelRotation[i] += spin * dt;
  }

  /** Read contact/suspension data out of the controller into plain objects. */
  _readWheelState() {
    for (let i = 0; i < WHEEL_LAYOUT.length; i++) {
      const state = this.wheelStates[i];
      state.inContact = this.controller.wheelIsInContact(i);
      state.suspensionLength = this.controller.wheelSuspensionLength(i) ?? 0;
      state.suspensionForce = this.controller.wheelSuspensionForce(i) ?? 0;
      state.rotation = this.controller.wheelRotation(i) ?? this._wheelRotation[i];
      state.forwardImpulse = this.controller.wheelForwardImpulse(i) ?? 0;
      state.sideImpulse = this.controller.wheelSideImpulse(i) ?? 0;
      if (state.inContact) {
        const ground = this.controller.wheelGroundObject(i);
        if (ground) state.surface = this.physics.surfaceOf(ground.handle);
      }
    }
  }

  /** Longitudinal force the tyre can transmit before it slips, in newtons. */
  _maxLongitudinalForce(index) {
    const state = this.wheelStates[index];
    const surfaceGrip =
      (this.definition.tyre.surfaceGrip[state.surface] ?? 1) * this.gripMultiplier;
    const normal = Math.max(state.suspensionForce, 0);
    return this.definition.tyre.frictionSlip * surfaceGrip * normal;
  }

  /**
   * Reduce drive force when the driven wheels are being asked for more grip
   * than they have.
   *
   * The raycast vehicle has no per-wheel spin model, so "slip" is inferred from
   * the demand/grip ratio rather than modelled directly. That is an honest
   * simplification: it reproduces the *behaviour* of traction control (no
   * wheelspin on launch, no power-on oversteer in low gears) without pretending
   * to simulate tyre slip curves.
   */
  _applyTractionControl(wheelForce, { drivetrain, throttle }) {
    const tc = clamp(this.definition.assists.tractionControl, 0, 1);
    if (this.driftMode || tc <= 0 || throttle <= 0.05) return;

    let demand = 0;
    let capacity = 0;
    WHEEL_LAYOUT.forEach((layout, index) => {
      const share = drivetrain[layout.axle] / 2;
      if (share <= 0) return;
      demand += Math.max(0, wheelForce[index]);
      // The grip budget IS the physical traction limit of that tyre, so there
      // is no extra speed scaling here: cutting the budget at speed would make
      // traction control *more* intrusive the faster you go, which is backwards.
      capacity += this._maxLongitudinalForce(index) * share;
    });
    if (capacity <= 1 || demand <= capacity) return;

    // tc scales how aggressively the excess is trimmed.
    const allowed = capacity * lerp(1.15, 1.0, tc);
    const scale = clamp(allowed / demand, 0, 1);
    for (let i = 0; i < 4; i++) {
      if (wheelForce[i] > 0) wheelForce[i] *= scale;
    }
  }

  /** Drag, rolling resistance and downforce. */
  _applyAeroForces(speed, forward) {
    const { aero, massKg } = this.definition;
    if (speed > 0.1) {
      // 0.5 * rho * Cd * A, with A folded into the coefficient for simplicity.
      const dragMagnitude = 0.5 * 1.225 * aero.dragCoefficient * speed * speed;
      this.body.addForce(
        { x: -forward.x * dragMagnitude, y: 0, z: -forward.z * dragMagnitude },
        true,
      );
      const rolling = aero.rollingResistance * massKg * 9.81;
      this.body.addForce({ x: -forward.x * rolling, y: 0, z: -forward.z * rolling }, true);
    }
    // Downforce presses the car into the ground, which is what makes a supercar
    // stable at speed while a hatchback starts to float.
    const downforce = aero.downforce * speed * speed * 0.5;
    if (downforce > 1) this.body.addForce({ x: 0, y: -downforce, z: 0 }, true);
  }

  /**
   * A mild yaw correction toward the "textbook" yaw rate for the current
   * steering input. This stands in for the electronic stability control fitted
   * to road cars: it makes a spinning car catchable without removing the
   * possibility of spinning at all.
   */
  _applyStabilityAssist({ forward, forwardSpeed, lateralSpeed }) {
    const strength = this.driftMode ? 0 : clamp(this.definition.assists.stability, 0, 1);
    if (strength <= 0 || Math.abs(forwardSpeed) < 1.5) return;

    const yawRate = this.body.angvel().y;
    const speed = Math.max(Math.abs(forwardSpeed), 0.1);
    // Bicycle-model reference yaw rate.
    const desired = (speed / this.definition.wheelbase) * Math.tan(this._steerAngle);
    const error = desired - yawRate;
    const inertia = this.definition.massKg * 1.2;
    // Cap the correction so it can never overpower genuine driver input.
    const maxTorque = this.definition.massKg * 3.5;
    const torque = clamp(error * inertia * strength * 2, -maxTorque, maxTorque);
    this.body.addTorque({ x: 0, y: torque, z: 0 }, true);

    // Gentle straightening at speed stops a nudged car drifting forever.
    if (quadraticAssist(lateralSpeed, forwardSpeed)) {
      const correction = -lateralSpeed * this.definition.massKg * 0.6 * strength;
      this.body.addForce({ x: forward.z * correction, y: 0, z: -forward.x * correction }, true);
    }
  }

  /** Turn queued collision events into damage points. */
  _resolveImpact() {
    if (!this._impactPending) return;
    this._impactPending = false;
    const speed = Math.hypot(this.body.linvel().x, this.body.linvel().z);
    const loss = Math.max(0, this._prevSpeed - speed);
    if (loss > 2.5) {
      // Damage grows with kinetic energy, so a 20 km/h scrape barely registers
      // while a 120 km/h wall impact is severe.
      const damage = clamp((loss * loss) / 900, 0, 1) * 22;
      this.telemetry.damage = clamp(this.telemetry.damage + damage, 0, 100);
      this.telemetry.lastImpact = loss;
    }
    this._impactSpeedLoss = loss;
  }

  _computeSlipProbe() {
    if (this.telemetry.speedKmh < 3) return 0;
    const lateral = Math.abs(this.telemetry.lateralSpeed);
    return clamp(lateral / Math.max(this.telemetry.speedKmh / MS_TO_KMH, 0.1), 0, 1);
  }

  _dominantSurface() {
    const counts = {};
    for (const wheel of this.wheelStates) {
      if (!wheel.inContact) continue;
      counts[wheel.surface] = (counts[wheel.surface] ?? 0) + 1;
    }
    let best = 'asphalt';
    let bestCount = 0;
    for (const [surface, count] of Object.entries(counts)) {
      if (count > bestCount) {
        best = surface;
        bestCount = count;
      }
    }
    return best;
  }

  /* --------------------------------- helpers -------------------------------- */

  /** Unit forward vector (XZ plane) for the current chassis orientation. */
  forwardVector() {
    const q = this.body.rotation();
    // Rotate (0,0,1) by the quaternion, then project onto the ground plane.
    const x = 2 * (q.x * q.z + q.w * q.y);
    const z = 1 - 2 * (q.x * q.x + q.y * q.y);
    const length = Math.hypot(x, z) || 1;
    return { x: x / length, y: 0, z: z / length };
  }

  position() {
    return this.body.translation();
  }

  /**
   * World position of a wheel's ground contact point.
   *
   * Derived from the same rest pose the controller was built with rather than
   * from the visual model, so it is correct for a `Vehicle` that has no mesh at
   * all — which is how the physics tests construct one.
   *
   * @param {number} index Wheel index (see `WHEEL_LAYOUT`).
   * @param {{x:number,y:number,z:number}} [out]
   */
  wheelWorldPosition(index, out = { x: 0, y: 0, z: 0 }) {
    const layout = WHEEL_LAYOUT[index];
    if (!layout) return out;
    const state = this.wheelStates[index];
    const travel = state.inContact ? state.suspensionLength : this.definition.suspension.restLength;
    const local = {
      x: layout.x * this.definition.derived.halfTrack,
      y: this.wheelConnectionY - travel - this.definition.wheelRadius,
      z: layout.z * this.definition.derived.halfWheelbase,
    };
    const translation = this.body.translation();
    const q = this.body.rotation();
    // Rotate the local offset by the chassis quaternion: v' = v + w*t + q x t,
    // where t = 2 * (q x v).
    const tx = 2 * (q.y * local.z - q.z * local.y);
    const ty = 2 * (q.z * local.x - q.x * local.z);
    const tz = 2 * (q.x * local.y - q.y * local.x);
    out.x = translation.x + local.x + q.w * tx + (q.y * tz - q.z * ty);
    out.y = translation.y + local.y + q.w * ty + (q.z * tx - q.x * tz);
    out.z = translation.z + local.z + q.w * tz + (q.x * ty - q.y * tx);
    return out;
  }

  rotation() {
    return this.body.rotation();
  }

  /**
   * Push the visual model to match the physics state.
   *
   * @param {number} [alpha] Fraction of the current fixed step that has already
   *   elapsed. `0` renders the pose the step started from, `1` the pose it
   *   ended at, and anything between interpolates. Simulation always advances in
   *   exact 1/60 s steps, so on a display that is not exactly 60 Hz the render
   *   clock and the simulation clock drift in and out of phase; interpolating is
   *   what makes the car move smoothly instead of snapping between step poses.
   */
  syncVisual(alpha = 1) {
    if (!this.object3D) return;
    const t = this.body.translation();
    const r = this.body.rotation();
    const a = clamp(alpha, 0, 1);
    const from = this._prevPosition;
    const previous = this._prevRotation;
    // Shortest-path quaternion blend. `nlerp` is used rather than a true slerp:
    // the rotation between two consecutive 1/60 s steps is tiny, so the two agree
    // to well under a pixel, and this avoids a trigonometry call per frame.
    const dot = previous.x * r.x + previous.y * r.y + previous.z * r.z + previous.w * r.w;
    const sign = dot < 0 ? -1 : 1;
    const q = this._visualRotation;
    const bx = previous.x * sign;
    const by = previous.y * sign;
    const bz = previous.z * sign;
    const bw = previous.w * sign;
    const length =
      Math.hypot(
        bx + (r.x - bx) * a,
        by + (r.y - by) * a,
        bz + (r.z - bz) * a,
        bw + (r.w - bw) * a,
      ) || 1;
    q.x = (bx + (r.x - bx) * a) / length;
    q.y = (by + (r.y - by) * a) / length;
    q.z = (bz + (r.z - bz) * a) / length;
    q.w = (bw + (r.w - bw) * a) / length;
    this.object3D.position.set(
      from.x + (t.x - from.x) * a,
      from.y + (t.y - from.y) * a,
      from.z + (t.z - from.z) * a,
    );
    this.object3D.quaternion.set(q.x, q.y, q.z, q.w);
    const wheels = this.object3D.userData?.wheels;
    if (Array.isArray(wheels)) {
      wheels.forEach((wheel, index) => {
        if (!wheel) return;
        const state = this.wheelStates[index];
        // When the suspension compresses, the body sinks toward the wheel, so the
        // wheel's offset from the chassis becomes *less* negative (it moves up
        // relative to the body). Hence `restY + compression`, not `-`.
        const compression = Math.max(
          0,
          this.definition.suspension.restLength - state.suspensionLength,
        );
        wheel.position.y = wheel.userData.restY + compression;
        if (WHEEL_LAYOUT[index].steering) wheel.rotation.y = this._steerAngle;
        wheel.userData.spin.rotation.x = state.rotation ?? this._wheelRotation[index];
      });
    }
  }

  /**
   * Teleport the vehicle to a safe, upright position above the nearest ground.
   * Used by the "recover" action and by checkpoint resets.
   */
  recover(target = null) {
    let destination = target;
    if (!destination) {
      const t = this.body.translation();
      // Probe downward from high above to find the ground beneath us.
      const hit = this.physics.raycast(
        { x: t.x, y: t.y + 60, z: t.z },
        { x: 0, y: -1, z: 0 },
        400,
        this.collider,
      );
      const groundY = hit ? hit.point.y : Math.max(0, t.y);
      destination = { x: t.x, y: groundY + 1.2, z: t.z };
    }

    this.body.setTranslation({ x: destination.x, y: destination.y, z: destination.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (destination.heading !== undefined) {
      this.body.setRotation(quaternionFromYaw(destination.heading), true);
    } else {
      // Always restore a level attitude, even if the car was on its roof.
      const q = this.body.rotation();
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
      this.body.setRotation(quaternionFromYaw(yaw), true);
    }
    this.gearbox.gear = GEAR_NEUTRAL;
    this.gearbox.rpm = this.definition.engine.idleRpm;
    this.gearbox.shiftTimer = 0;
    this._steerAngle = 0;
    this._prevSpeed = 0;
    this._smoothedAccel = 0;
    // The teleport above must not be interpolated across: snap the previous pose
    // to the new one or the car would visibly slide from where it was recovered
    // from to where it landed.
    this._captureStepStart();
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelEngineForce(i, 0);
      this.controller.setWheelBrake(i, 0);
      this.controller.setWheelSteering(i, 0);
    }
    this.syncVisual();
  }

  /** Restore the pod to full health (garage repair, mission restart). */
  repair() {
    this.telemetry.damage = 0;
  }

  /** Speed in km/h, unsigned. */
  speedKmh() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z) * MS_TO_KMH;
  }

  /** Set the paint of the visual model, if one is attached. */
  setPaint(hex) {
    if (!this.object3D) return;
    this.object3D.traverse((child) => {
      if (child.userData?.paintable && child.material) {
        child.material.color.setHex(hex);
      }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._collisionUnsub?.();
    this._collisionUnsub = null;
    if (this.controller) {
      this.controller.free();
      this.controller = null;
    }
    if (this.body && this.physics.world) {
      this.physics.forget(this.collider);
      this.physics.world.removeRigidBody(this.body);
    }
    this.body = null;
    this.collider = null;
  }
}

/** Build a Y-axis quaternion from a yaw angle. */
export function quaternionFromYaw(yaw) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** Convert a yaw quaternion back to an angle. */
export function yawFromQuaternion(q) {
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

function quadraticAssist(lateralSpeed, forwardSpeed) {
  return Math.abs(lateralSpeed) > 0.8 && Math.abs(forwardSpeed) > 6;
}
