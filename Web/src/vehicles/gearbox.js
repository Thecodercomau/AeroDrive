import { clamp, lerp, safeDivide } from '../utilities/math.js';

/**
 * Engine / transmission model.
 *
 * Deliberately pure: it consumes a wheel angular velocity and a driver input
 * and returns an engine RPM, a gear, and the torque that should be pushed
 * through the drivetrain. No Rapier, no DOM — which makes the whole shifting
 * behaviour unit-testable.
 *
 * Gear encoding:
 *   -1 = reverse, 0 = neutral, 1..N = forward gears (index into `forwardRatios`).
 */

export const GEAR_REVERSE = -1;
export const GEAR_NEUTRAL = 0;

/** Human-readable gear label for the HUD. */
export function gearLabel(gear) {
  if (gear === GEAR_REVERSE) return 'R';
  if (gear === GEAR_NEUTRAL) return 'N';
  return String(gear);
}

export function createGearboxState({ gear = GEAR_NEUTRAL, manual = false } = {}) {
  return {
    gear,
    manual,
    rpm: 0,
    shiftTimer: 0, // > 0 while a shift is in progress (torque is cut)
    lastShiftWasUp: false,
    shiftCount: 0,
  };
}

/**
 * Effective (magnitude) total gear reduction currently engaged.
 * Neutral returns 0 so the engine coasts toward idle.
 */
export function effectiveReduction(gear, config) {
  if (gear === GEAR_NEUTRAL) return 0;
  const finalDrive = config.finalDrive ?? 3.4;
  if (gear === GEAR_REVERSE) return (config.reverseRatio ?? 3.2) * finalDrive;
  const ratio = config.forwardRatios?.[gear - 1];
  if (!ratio) return 0;
  return ratio * finalDrive;
}

/**
 * Engine RPM implied by the current road speed, i.e. what a mechanically
 * coupled drivetrain would be spinning at.
 *
 * @param {number} wheelAngularVelocity rad/s (absolute value is used)
 */
export function rpmFromWheelSpeed(wheelAngularVelocity, gear, config) {
  const reduction = effectiveReduction(gear, config);
  if (reduction === 0) return 0;
  const wheelRps = Math.abs(wheelAngularVelocity) / (2 * Math.PI);
  return wheelRps * reduction * 60;
}

/** Wheel angular velocity (rad/s) implied by an engine RPM in the current gear. */
export function wheelSpeedFromRpm(rpm, gear, config) {
  const reduction = effectiveReduction(gear, config);
  if (reduction === 0) return 0;
  return ((rpm / 60) * 2 * Math.PI) / reduction;
}

/**
 * Interpolate the engine torque curve at `rpm`.
 * `torqueCurve` is an array of `[rpm, torqueNewtonMetres]`, ascending.
 */
export function torqueAtRpm(rpm, torqueCurve) {
  if (!Array.isArray(torqueCurve) || torqueCurve.length === 0) return 0;
  if (rpm <= torqueCurve[0][0]) return torqueCurve[0][1];
  const last = torqueCurve[torqueCurve.length - 1];
  if (rpm >= last[0]) return last[1];
  for (let i = 0; i < torqueCurve.length - 1; i++) {
    const [r0, t0] = torqueCurve[i];
    const [r1, t1] = torqueCurve[i + 1];
    if (rpm >= r0 && rpm <= r1) {
      return lerp(t0, t1, safeDivide(rpm - r0, r1 - r0));
    }
  }
  return last[1];
}

/** Rev limiter: no torque is delivered above the redline. */
export function engineTorque(rpm, config) {
  const idle = config.idleRpm ?? 800;
  const redline = config.redlineRpm ?? 7000;
  if (rpm > redline) return 0;
  const raw = torqueAtRpm(Math.max(rpm, idle), config.torqueCurve);
  return Math.max(0, raw);
}

/**
 * Advance the gearbox one simulation step.
 *
 * @param {object} state  From `createGearboxState` (mutated in place for speed).
 * @param {object} params
 * @param {number} params.wheelAngularVelocity
 * @param {object} params.input   { throttle, brake, steer, handbrake, shiftUp, shiftDown }
 * @param {object} params.config  Gearbox + engine portion of a vehicle definition.
 * @param {number} params.dt
 * @returns {{ gear: number, rpm: number, shifting: boolean, torque: number, ratio: number }}
 */
export function stepGearbox(state, { wheelAngularVelocity, input, config, dt }) {
  const idleRpm = config.idleRpm ?? 800;
  const redlineRpm = config.redlineRpm ?? 7000;
  const shiftUpRpm = config.shiftUpRpm ?? redlineRpm * 0.9;
  const shiftDownRpm = config.shiftDownRpm ?? idleRpm * 1.6;
  const shiftTime = config.shiftTime ?? 0.28;
  const gearCount = config.forwardRatios?.length ?? 0;

  const throttle = clamp(input?.throttle ?? 0, 0, 1);
  const brakePedal = clamp(input?.brake ?? 0, 0, 1);
  // In reverse the *brake pedal* is the accelerator — the same pedal that
  // engaged reverse has to be the one that drives it, or the car can never
  // move backwards.
  const drivePedal = state.gear === GEAR_REVERSE ? brakePedal : throttle;

  // --- Shifting -----------------------------------------------------------
  if (state.shiftTimer > 0) {
    state.shiftTimer = Math.max(0, state.shiftTimer - dt);
  }

  // Reverse may be requested from any gear, not just neutral. The player has
  // only one pedal for "go backwards": they brake to a stop and keep holding it.
  // Requiring neutral meant that in a real session — where the car is already in
  // first — the brake would stop the car and then do nothing, leaving reverse
  // permanently unreachable. The speed guard is what keeps this safe: the pedal
  // only becomes reverse once the wheels have essentially stopped.
  const reverseRequested =
    brakePedal > 0.5 && Math.abs(wheelAngularVelocity) < 1.2 && state.gear !== GEAR_REVERSE;
  const forwardRequested = throttle > 0.1 && state.gear === GEAR_NEUTRAL;

  if (state.manual) {
    if (state.shiftTimer === 0) {
      if (input?.shiftUp) {
        const next = state.gear < 1 ? 1 : Math.min(gearCount, state.gear + 1);
        if (next !== state.gear) {
          state.gear = next;
          state.shiftTimer = shiftTime;
          state.lastShiftWasUp = true;
          state.shiftCount++;
        }
      } else if (input?.shiftDown) {
        const next = Math.max(GEAR_NEUTRAL, state.gear - 1);
        if (next !== state.gear) {
          state.gear = next;
          state.shiftTimer = shiftTime;
          state.lastShiftWasUp = false;
          state.shiftCount++;
        }
      }
    }
    // In manual mode the player still has to select R/N themselves; we only
    // auto-engage 1st from neutral so they are never stuck.
    if (forwardRequested && state.shiftTimer === 0 && state.gear === GEAR_NEUTRAL) {
      state.gear = 1;
      state.shiftTimer = shiftTime;
      state.lastShiftWasUp = true;
      state.shiftCount++;
    }
  } else {
    // --- Automatic transmission -----------------------------------------
    if (state.shiftTimer === 0) {
      if (reverseRequested) {
        state.gear = GEAR_REVERSE;
        state.shiftCount++;
      } else if (state.gear === GEAR_REVERSE && throttle > 0.1) {
        state.gear = 1;
        state.shiftTimer = shiftTime;
        state.lastShiftWasUp = true;
        state.shiftCount++;
      } else if (state.gear === GEAR_NEUTRAL && (forwardRequested || reverseRequested)) {
        state.gear = reverseRequested ? GEAR_REVERSE : 1;
        state.shiftTimer = shiftTime;
        state.lastShiftWasUp = true;
        state.shiftCount++;
      } else if (state.gear >= 1) {
        const currentRpm = rpmFromWheelSpeed(wheelAngularVelocity, state.gear, config);
        // The RPM the engine WOULD be doing one gear LOWER. This guards the
        // downshift against over-revving, and it must look at `gear - 1` —
        // looking at `gear + 1` makes the top gear un-leavable, because that is
        // where the driver actually wants to go.
        const lowerGearRpm = rpmFromWheelSpeed(wheelAngularVelocity, state.gear - 1, config);

        if (currentRpm > shiftUpRpm && state.gear < gearCount) {
          state.gear += 1;
          state.shiftTimer = shiftTime;
          state.lastShiftWasUp = true;
          state.shiftCount++;
        } else if (
          state.gear > 1 &&
          currentRpm < shiftDownRpm &&
          lowerGearRpm < shiftUpRpm * 0.95
        ) {
          // Downshift only if the resulting RPM would still be sane, which
          // prevents the classic "gear hunting" oscillation.
          state.gear -= 1;
          state.shiftTimer = shiftTime;
          state.lastShiftWasUp = false;
          state.shiftCount++;
        }
      }
    }
  }

  // --- RPM ----------------------------------------------------------------
  const coupledRpm = rpmFromWheelSpeed(wheelAngularVelocity, state.gear, config);
  // Clutch slip: at low speed the engine sits at a drive-pedal-dependent RPM
  // above the mechanically coupled value, which is what makes pulling away feel
  // right.
  const throttleRpm = lerp(idleRpm, redlineRpm * 0.92, drivePedal);
  const clutchEngagement = clamp(Math.abs(coupledRpm) / (idleRpm * 2.2), 0, 1);
  const targetRpm = Math.max(coupledRpm, lerp(throttleRpm, coupledRpm, clutchEngagement));

  if (state.shiftTimer > 0) {
    // During a shift the engine is unloaded and revs track the throttle.
    state.rpm = lerp(state.rpm, throttleRpm, clamp(dt * 8, 0, 1));
  } else {
    // Engines are not infinitely responsive.
    state.rpm = lerp(state.rpm, targetRpm, clamp(dt * 6, 0, 1));
  }

  // Idle floor and rev limiter.
  state.rpm = clamp(state.rpm, idleRpm, redlineRpm * 1.05);

  const shifting = state.shiftTimer > 0 || state.gear === GEAR_NEUTRAL;
  const torque = shifting ? 0 : engineTorque(state.rpm, config);

  // Reverse must drive the wheels the *other* way, so the reduction carries a
  // sign. Without it a car in reverse accelerates forwards — which is exactly
  // the bug this comment exists to prevent regressing.
  const signedReduction =
    effectiveReduction(state.gear, config) * (state.gear === GEAR_REVERSE ? -1 : 1);

  return {
    gear: state.gear,
    rpm: state.rpm,
    shifting,
    torque: torque * drivePedal,
    ratio: signedReduction,
  };
}

/**
 * Convert engine torque into a per-wheel drive force.
 *
 * @param {object} params
 * @param {number} params.torque          Engine torque (Nm) after throttle/throttle cut.
 * @param {number} params.reduction       Total gear reduction.
 * @param {number} params.wheelRadius     Metres.
 * @param {number} params.drivetrainFactor Fraction of torque to this axle.
 * @returns {number} force in newtons
 */
export function torqueToWheelForce({ torque, reduction, wheelRadius, drivetrainFactor = 1 }) {
  if (wheelRadius <= 0) return 0;
  return (torque * reduction * drivetrainFactor) / wheelRadius;
}
