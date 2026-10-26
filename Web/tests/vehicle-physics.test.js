import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { createVehicleModel } from '../src/vehicles/VehicleFactory.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';
import { emptyControlState } from '../src/input/inputMapping.js';

/**
 * Integration tests that run the *real* Rapier simulation.
 *
 * These are the tests that catch the failure mode that matters most for this
 * project: a "car" that builds cleanly but does not actually drive. They assert
 * on simulated behaviour (position, speed, gear, damage) rather than on the
 * shape of objects, so a regression anywhere in the force pipeline fails here.
 *
 * Geometry convention: the chassis faces +Z, so with +Y up the *driver's left*
 * is +X and the driver's right is -X (right-handed system).
 */

const DT = 1 / 60;
// Generously large ground so no test accidentally drives off the edge.
const GROUND_HALF = 4000;

function makeGround(physics, surface = 'asphalt') {
  return physics.addStaticBox(
    { x: GROUND_HALF, y: 1, z: GROUND_HALF },
    { x: 0, y: -1, z: 0 },
    null,
    { surface, tag: 'terrain' },
  );
}

/** Run `steps` fixed steps with the given control state overrides. */
function simulate(physics, vehicle, steps, controls) {
  for (let i = 0; i < steps; i++) {
    const input = { ...emptyControlState(), ...controls };
    vehicle.step(DT, input);
    physics.step(DT);
  }
}

describe('vehicle physics (real Rapier simulation)', () => {
  /** @type {PhysicsWorld} */
  let physics;

  beforeAll(async () => {
    physics = new PhysicsWorld();
    await physics.init();
  });

  afterAll(() => {
    physics.dispose();
  });

  it('settles on the ground and reports wheel contact', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('sedan'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 180, {});
    const pos = vehicle.position();

    expect(pos.y).toBeGreaterThan(0.2);
    expect(pos.y).toBeLessThan(1.6);
    expect(vehicle.wheelStates.some((w) => w.inContact)).toBe(true);
    expect(vehicle.speedKmh()).toBeLessThan(2);

    vehicle.dispose();
    world.dispose();
  });

  it('centres the body mesh over the wheels', () => {
    const definition = getVehicleDefinition('sedan');
    const model = createVehicleModel(definition);
    const body = model.userData.bodyMesh;
    body.geometry.computeBoundingBox();
    const bounds = body.geometry.boundingBox;
    expect((bounds.min.x + bounds.max.x) / 2).toBeCloseTo(0, 6);
  });

  it('keeps front wheel steering separate from wheel spin', async () => {
    const world = new PhysicsWorld();
    await world.init();
    const definition = getVehicleDefinition('sedan');
    const model = createVehicleModel(definition);
    const vehicle = new Vehicle({
      physics: world,
      definition,
      spawn: { x: 0, y: 1.2, z: 0 },
      object3D: model,
    });

    vehicle._steerAngle = 0.35;
    vehicle.wheelStates[0].rotation = 1.2;
    vehicle.wheelStates[1].rotation = 1.2;
    vehicle.syncVisual();

    for (const index of [0, 1]) {
      const wheel = model.userData.wheels[index];
      expect(wheel.rotation.y).toBeCloseTo(0.35, 6);
      expect(wheel.rotation.x).toBe(0);
      expect(wheel.userData.spin.rotation.x).toBeCloseTo(1.2, 6);
    }

    vehicle.dispose();
    world.dispose();
  });

  it('drives forward (+Z) when the throttle is applied', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('sedan'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 60, {}); // settle
    const startZ = vehicle.position().z;
    simulate(world, vehicle, 240, { throttle: 1 });

    const pos = vehicle.position();
    const speed = vehicle.speedKmh();

    expect(pos.z).toBeGreaterThan(startZ + 10);
    expect(speed).toBeGreaterThan(30);
    expect(Math.abs(pos.x)).toBeLessThan(6);
    expect(vehicle.telemetry.gear).toBeGreaterThanOrEqual(1);

    vehicle.dispose();
    world.dispose();
  });

  it('reaches roughly the acceleration its spec sheet claims', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const definition = getVehicleDefinition('coupe');
    const vehicle = new Vehicle({
      physics: world,
      definition,
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 60, {});
    let elapsed = 0;
    for (let i = 0; i < 900; i++) {
      simulate(world, vehicle, 1, { throttle: 1 });
      elapsed += DT;
      if (vehicle.speedKmh() >= 100) break;
    }

    // The published 0-100 must be in the right ballpark of the simulation —
    // a spec sheet that lies by 2x is a bug, not a rounding error.
    expect(elapsed).toBeGreaterThan(1.0);
    expect(elapsed).toBeLessThan(definition.stats.zeroTo100 * 2.2 + 1.5);

    vehicle.dispose();
    world.dispose();
  });

  it('reverses when the brake is held from a standstill', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('hatchback'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 90, {});
    const startZ = vehicle.position().z;
    simulate(world, vehicle, 180, { brake: 1 });

    const pos = vehicle.position();
    expect(vehicle.telemetry.gear).toBe(-1);
    expect(pos.z).toBeLessThan(startZ - 1);

    vehicle.dispose();
    world.dispose();
  });

  it('brakes a moving car to a near stop', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('sedan'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 360, { throttle: 1 });
    const fastSpeed = vehicle.speedKmh();
    expect(fastSpeed).toBeGreaterThan(60);

    simulate(world, vehicle, 600, { brake: 1 });
    expect(vehicle.speedKmh()).toBeLessThan(10);

    vehicle.dispose();
    world.dispose();
  });

  it('steers left and right, and both directions are symmetric', async () => {
    const run = async (steer) => {
      const world = new PhysicsWorld();
      await world.init();
      makeGround(world);
      const vehicle = new Vehicle({
        physics: world,
        definition: getVehicleDefinition('hatchback'),
        spawn: { x: 0, y: 1.2, z: 0 },
      });
      simulate(world, vehicle, 120, { throttle: 0.8 });
      simulate(world, vehicle, 120, { throttle: 0.6, steer });
      const x = vehicle.position().x;
      vehicle.dispose();
      world.dispose();
      return x;
    };

    const left = await run(-1);
    const right = await run(1);

    // Steering left must move the car toward the driver's left (+X).
    expect(left).toBeGreaterThan(0.4);
    expect(right).toBeLessThan(-0.4);
    // Symmetric steering input must produce a symmetric path.
    expect(Math.abs(left + right)).toBeLessThan(Math.abs(left) * 0.35);
  });

  it('recovers an overturned vehicle to an upright pose', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('suv'),
      spawn: { x: 0, y: 1.4, z: 0 },
    });

    // Flip the car onto its roof and fling it into the air.
    vehicle.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
    vehicle.body.setLinvel({ x: 12, y: 4, z: 9 }, true);
    simulate(world, vehicle, 30, {});

    vehicle.recover();
    expect(vehicle.body.linvel().x).toBeCloseTo(0, 1);
    expect(vehicle.body.linvel().z).toBeCloseTo(0, 1);

    // After recovering there must be a level attitude: the chassis' local up
    // (+Y) should point mostly along world up.
    simulate(world, vehicle, 90, {});
    const q = vehicle.rotation();
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    expect(upY).toBeGreaterThan(0.7);

    vehicle.dispose();
    world.dispose();
  });

  it('accumulates damage on a high-speed collision', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    // A wall directly ahead of the spawn point.
    world.addStaticBox({ x: 8, y: 3, z: 0.5 }, { x: 0, y: 2, z: 24 }, null, {
      tag: 'prop:wall',
    });

    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('coupe'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    // Launch it at the wall at ~90 km/h and let it hit.
    vehicle.body.setLinvel({ x: 0, y: 0, z: 25 }, true);
    simulate(world, vehicle, 120, {});

    expect(vehicle.telemetry.damage).toBeGreaterThan(0);
    // It must not have passed through the wall.
    expect(vehicle.position().z).toBeLessThan(25);

    vehicle.dispose();
    world.dispose();
  });

  it('handbrake scrubs speed and drops rear grip', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('coupe'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 240, { throttle: 1 });
    const before = vehicle.speedKmh();
    simulate(world, vehicle, 90, { handbrake: true });

    expect(vehicle.speedKmh()).toBeLessThan(before);
    const grip = vehicle.definition.tyre.frictionSlip;
    expect(vehicle.controller.wheelFrictionSlip(2)).toBeCloseTo(grip * 0.35, 3);

    vehicle.dispose();
    world.dispose();
  });

  it('drift mode lowers rear grip without changing front grip', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const definition = getVehicleDefinition('coupe');
    const vehicle = new Vehicle({
      physics: world,
      definition,
      spawn: { x: 0, y: 1.2, z: 0 },
    });
    vehicle.setDriftMode(true);
    vehicle.step(DT, { ...emptyControlState(), throttle: 0.4 });

    expect(vehicle.controller.wheelFrictionSlip(0)).toBeCloseTo(definition.tyre.frictionSlip, 4);
    expect(vehicle.controller.wheelFrictionSlip(2)).toBeCloseTo(
      definition.tyre.frictionSlip * 0.78,
      4,
    );
    expect(vehicle.controller.wheelSideFrictionStiffness(2)).toBeCloseTo(
      definition.tyre.sideFrictionStiffness * 0.72,
      4,
    );

    vehicle.dispose();
    world.dispose();
  });

  it('does not let the stability assist torque accumulate between steps', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);
    const definition = getVehicleDefinition('sedan');
    const vehicle = new Vehicle({
      physics: world,
      definition,
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    // Rapier keeps user forces and user torques in separate accumulators and
    // `resetForces` clears only the forces. `Vehicle.step` adds a yaw torque from
    // the stability assist every step, so failing to reset the torques makes that
    // correction pile up without bound: the car ends up pirouetting at several
    // radians per second with the steering centred.
    const cap = definition.massKg * 3.5;
    simulate(world, vehicle, 90, {});

    // Corner hard, which is when the assist actually does work.
    simulate(world, vehicle, 180, { throttle: 0.7, steer: 1 });
    expect(Math.abs(vehicle.body.userTorque().y)).toBeLessThanOrEqual(cap * 1.05);

    // Then let go. The correction has to decay rather than live on in the
    // accumulator, so the car straightens out instead of spinning.
    simulate(world, vehicle, 90, {});
    expect(Math.abs(vehicle.body.userTorque().y)).toBeLessThanOrEqual(cap * 1.05);
    simulate(world, vehicle, 180, {});
    expect(Math.abs(vehicle.body.angvel().y)).toBeLessThan(0.35);

    vehicle.dispose();
    world.dispose();
  });

  it('interpolates the visual pose between physics steps', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world);

    // A stand-in for the rendered model: just the two properties `syncVisual`
    // writes, recording whatever it is given.
    const position = {
      x: 0,
      y: 0,
      z: 0,
      set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
      },
    };
    const quaternion = {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
      set(x, y, z, w) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.w = w;
      },
    };

    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('sedan'),
      spawn: { x: 0, y: 1.2, z: 0 },
      object3D: { position, quaternion, userData: {} },
    });

    simulate(world, vehicle, 120, { throttle: 0.6 });

    // The pose the next fixed step starts from, then the pose it ends at.
    const before = { ...vehicle.position() };
    vehicle.step(DT, { ...emptyControlState(), throttle: 0.6 });
    world.step(DT);
    const after = { ...vehicle.position() };
    const travel = Math.hypot(after.x - before.x, after.z - before.z);
    // Sanity: the car actually moved this step, or the assertions below are
    // vacuous.
    expect(travel).toBeGreaterThan(0.05);

    // alpha = 0 is the pose at the start of the step, alpha = 1 the pose at the
    // end, and the renderer is handed every value in between.
    vehicle.syncVisual(0);
    expect(position.z).toBeCloseTo(before.z, 3);
    vehicle.syncVisual(1);
    expect(position.z).toBeCloseTo(after.z, 3);

    vehicle.syncVisual(0.5);
    expect(position.z).toBeCloseTo((before.z + after.z) / 2, 3);
    expect(position.z).toBeGreaterThan(before.z);
    expect(position.z).toBeLessThan(after.z);
    // The quaternion has to stay normalised after blending.
    const length = Math.hypot(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    expect(length).toBeCloseTo(1, 5);

    vehicle.dispose();
    world.dispose();
  });

  it('reports the surface it is actually driving on', async () => {
    const world = new PhysicsWorld();
    await world.init();
    makeGround(world, 'grass');
    const vehicle = new Vehicle({
      physics: world,
      definition: getVehicleDefinition('sedan'),
      spawn: { x: 0, y: 1.2, z: 0 },
    });

    simulate(world, vehicle, 60, {});
    expect(vehicle.telemetry.onSurface).toBe('grass');
    expect(vehicle.definition.tyre.surfaceGrip.grass).toBeLessThan(
      vehicle.definition.tyre.surfaceGrip.asphalt,
    );

    vehicle.dispose();
    world.dispose();
  });
});
