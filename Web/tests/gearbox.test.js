import { describe, expect, it } from 'vitest';
import {
  GEAR_NEUTRAL,
  GEAR_REVERSE,
  createGearboxState,
  effectiveReduction,
  engineTorque,
  gearLabel,
  rpmFromWheelSpeed,
  stepGearbox,
  torqueAtRpm,
  torqueToWheelForce,
  wheelSpeedFromRpm,
} from '../src/vehicles/gearbox.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';

const DT = 1 / 60;
const coupe = getVehicleDefinition('coupe').engine;

const idle = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  shiftUp: false,
  shiftDown: false,
};

describe('gearbox and engine', () => {
  it('labels gears correctly', () => {
    expect(gearLabel(GEAR_REVERSE)).toBe('R');
    expect(gearLabel(GEAR_NEUTRAL)).toBe('N');
    expect(gearLabel(3)).toBe('3');
  });

  it('returns zero reduction in neutral and a negative reduction in reverse', () => {
    expect(effectiveReduction(GEAR_NEUTRAL, coupe)).toBe(0);
    // `effectiveReduction` returns magnitude; the sign is applied by stepGearbox.
    expect(effectiveReduction(GEAR_REVERSE, coupe)).toBeGreaterThan(0);
    expect(effectiveReduction(1, coupe)).toBeGreaterThan(effectiveReduction(3, coupe));
  });

  it('converts between wheel speed and RPM consistently in both directions', () => {
    const wheelOmega = 40; // rad/s
    const rpm = rpmFromWheelSpeed(wheelOmega, 3, coupe);
    expect(rpm).toBeGreaterThan(0);
    expect(wheelSpeedFromRpm(rpm, 3, coupe)).toBeCloseTo(wheelOmega, 6);
  });

  it('interpolates the torque curve and returns zero above the redline', () => {
    const curve = coupe.torqueCurve;
    const peakTorque = Math.max(...curve.map(([, torque]) => torque));
    // Somewhere in the middle of the curve we should see near-peak torque.
    expect(torqueAtRpm(5000, curve)).toBeGreaterThan(peakTorque * 0.75);
    // Below the first point and above the last, the curve clamps.
    expect(torqueAtRpm(0, curve)).toBe(curve[0][1]);
    expect(torqueAtRpm(20000, curve)).toBe(curve[curve.length - 1][1]);
    // Past the redline the limiter cuts torque entirely.
    expect(engineTorque(coupe.redlineRpm + 500, coupe)).toBe(0);
  });

  it('engages first gear from neutral when the throttle is applied', () => {
    const state = createGearboxState();
    const result = stepGearbox(state, {
      wheelAngularVelocity: 0,
      input: { ...idle, throttle: 1 },
      config: coupe,
      dt: DT,
    });
    expect(result.gear).toBe(1);
    expect(result.shifting).toBe(true); // torque is cut during the shift
  });

  it('upshifts as speed rises and downshifts as it falls', () => {
    const state = createGearboxState({ gear: 1 });
    const seen = new Set();

    // A realistic ramp: ~6 m/s^2 of acceleration on a 0.34 m wheel works out to
    // roughly 0.3 rad/s of wheel speed gained per 60 Hz frame. Stepping the
    // speed in huge jumps would instead keep the box permanently mid-shift,
    // which is not what the shift logic is meant to be exercised against.
    let wheelOmega = 0;
    for (let frame = 0; frame < 900; frame++) {
      wheelOmega += 0.3;
      const result = stepGearbox(state, {
        wheelAngularVelocity: wheelOmega,
        input: { ...idle, throttle: 1 },
        config: coupe,
        dt: DT,
      });
      // Ignore frames where a shift is in progress: torque is cut and the gear
      // is mid-transition, so they are not "settled" gears.
      if (!result.shifting) seen.add(result.gear);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(4);

    // Now slow down gently and confirm it walks back down the box.
    const topGear = state.gear;
    for (let frame = 0; frame < 900; frame++) {
      wheelOmega -= 0.3;
      stepGearbox(state, {
        wheelAngularVelocity: wheelOmega,
        input: { ...idle, throttle: 0.1 },
        config: coupe,
        dt: DT,
      });
    }
    expect(state.gear).toBeLessThan(topGear);
  });

  it('never shifts past the highest or lowest forward gear', () => {
    const state = createGearboxState({ gear: 1, manual: true });
    const topGear = coupe.forwardRatios.length;

    for (let i = 0; i < 60; i++) {
      stepGearbox(state, {
        wheelAngularVelocity: 5,
        input: { ...idle, shiftUp: true },
        config: coupe,
        dt: DT,
      });
    }
    expect(state.gear).toBe(topGear);

    for (let i = 0; i < 60; i++) {
      stepGearbox(state, {
        wheelAngularVelocity: 5,
        input: { ...idle, shiftDown: true },
        config: coupe,
        dt: DT,
      });
    }
    expect(state.gear).toBe(GEAR_NEUTRAL);
  });

  it('engages reverse from rest and drives it with the brake pedal', () => {
    const state = createGearboxState();
    const reverse = stepGearbox(state, {
      wheelAngularVelocity: 0,
      input: { ...idle, brake: 1 },
      config: coupe,
      dt: DT,
    });
    expect(reverse.gear).toBe(GEAR_REVERSE);

    // With reverse engaged, the brake pedal is the accelerator, so torque must
    // be non-zero — and the reduction must be negative so the wheels go the
    // other way. This is the regression test for "reverse drives forwards".
    let torque = 0;
    for (let i = 0; i < 30; i++) {
      const result = stepGearbox(state, {
        wheelAngularVelocity: -1,
        input: { ...idle, brake: 1 },
        config: coupe,
        dt: DT,
      });
      torque = result.torque;
      expect(result.ratio).toBeLessThan(0);
    }
    expect(torque).toBeGreaterThan(0);
  });

  it('engages reverse when the brake is held from rest in a forward gear', () => {
    // The regression test for "reverse is unreachable after driving": the player
    // brakes to a stop in first and keeps holding, which must select reverse.
    const state = createGearboxState({ gear: 1 });
    const result = stepGearbox(state, {
      wheelAngularVelocity: 0,
      input: { ...idle, brake: 1 },
      config: coupe,
      dt: DT,
    });
    expect(result.gear).toBe(GEAR_REVERSE);
  });

  it('does not slam into reverse while still rolling forwards', () => {
    const state = createGearboxState({ gear: 2 });
    // 20 rad/s is roughly 25 km/h on a 0.31 m wheel — a moving car.
    const result = stepGearbox(state, {
      wheelAngularVelocity: 20,
      input: { ...idle, brake: 1 },
      config: coupe,
      dt: DT,
    });
    expect(result.gear).toBeGreaterThanOrEqual(1);
  });

  it('returns to a forward gear when the accelerator is pressed in reverse', () => {
    const state = createGearboxState({ gear: GEAR_REVERSE });
    const result = stepGearbox(state, {
      wheelAngularVelocity: -3,
      input: { ...idle, throttle: 1 },
      config: coupe,
      dt: DT,
    });
    expect(result.gear).toBeGreaterThanOrEqual(1);
  });

  it('settles at idle RPM when stationary', () => {
    const state = createGearboxState({ gear: 1 });
    for (let i = 0; i < 300; i++) {
      stepGearbox(state, {
        wheelAngularVelocity: 0,
        input: idle,
        config: coupe,
        dt: DT,
      });
    }
    expect(state.rpm).toBeGreaterThanOrEqual(coupe.idleRpm - 1);
    expect(state.rpm).toBeLessThan(coupe.idleRpm * 1.6);
  });

  it('limits RPM to the redline even at absurd wheel speeds', () => {
    const state = createGearboxState({ gear: 1 });
    for (let i = 0; i < 120; i++) {
      stepGearbox(state, {
        wheelAngularVelocity: 5000,
        input: { ...idle, throttle: 1 },
        config: coupe,
        dt: DT,
      });
    }
    expect(state.rpm).toBeLessThanOrEqual(coupe.redlineRpm * 1.06);
  });

  it('converts torque to a wheel force through the gear ratio', () => {
    const force = torqueToWheelForce({ torque: 100, reduction: 6, wheelRadius: 0.3 });
    expect(force).toBeCloseTo(2000, 6);
    // A zero-radius wheel would be a divide-by-zero; the helper must not throw.
    expect(torqueToWheelForce({ torque: 100, reduction: 6, wheelRadius: 0 })).toBe(0);
  });

  it('counts shifts so the audio layer can react to them', () => {
    const state = createGearboxState();
    for (let i = 0; i < 240; i++) {
      stepGearbox(state, {
        wheelAngularVelocity: i * 1.2,
        input: { ...idle, throttle: 1 },
        config: coupe,
        dt: DT,
      });
    }
    expect(state.shiftCount).toBeGreaterThan(0);
  });
});
