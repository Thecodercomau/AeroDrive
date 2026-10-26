import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Does `resetForces` also clear the user torques? **No.**
 *
 * `Vehicle.step` applies a yaw torque from the stability assist on every step
 * and relies on the force reset to keep the accumulators clean. Rapier keeps
 * forces and torques in *separate* accumulators — `resetForces` clears one and
 * `resetTorques` the other — so resetting only the forces let the yaw correction
 * pile up step after step. The car ended up pirouetting across the map, which is
 * the bug this probe was written to pin down.
 *
 * Usage: node tools/probe-torque-accumulation.mjs
 */

await RAPIER.init();

/**
 * Apply the same torque every step for a second, resetting only what the caller
 * asks for, and report the angular velocity each step.
 *
 * @param {{forces: boolean, torques: boolean}} reset
 */
function run(reset) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = 1 / 60;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setAngularDamping(0),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 1).setDensity(1), body);

  const angularVelocities = [];
  for (let step = 0; step < 10; step++) {
    if (reset.forces) body.resetForces(true);
    if (reset.torques) body.resetTorques(true);
    body.addTorque({ x: 0, y: 100, z: 0 }, true);
    world.step();
    angularVelocities.push(body.angvel().y);
  }
  const userTorque = body.userTorque().y;
  world.free();
  return { angularVelocities, userTorque };
}

const onlyForces = run({ forces: true, torques: false });
const both = run({ forces: true, torques: true });

const fmt = (values) => values.map((v) => v.toFixed(2).padStart(6)).join(' ');

console.log('100 N.m of yaw torque applied every step, 10 steps:\n');
console.log(`  resetForces only        angvel: ${fmt(onlyForces.angularVelocities)}`);
console.log(`                          user torque left on the body: ${onlyForces.userTorque.toFixed(0)} N.m\n`);
console.log(`  resetForces+resetTorques angvel: ${fmt(both.angularVelocities)}`);
console.log(`                          user torque left on the body: ${both.userTorque.toFixed(0)} N.m\n`);

// The per-step increments are the evidence. A torque applied once per step is a
// constant acceleration, so the increments are flat (damping is zero here); a
// torque left in the accumulator applies once more every step, so the
// increments grow linearly. That difference is the whole bug.
const increments = (values) => values.slice(1).map((v, i) => v - values[i]);
const accumulating = increments(onlyForces.angularVelocities);
const perStep = increments(both.angularVelocities);

const spread = (values) => Math.max(...values) / Math.min(...values);
const growing = spread(accumulating) > 3;
const flat = spread(perStep) < 1.01;

console.log(
  `  increments, forces only  : ${accumulating.map((v) => v.toFixed(2)).join(' ')}  -> ${
    growing ? 'GROWING (torque accumulates)' : 'flat'
  }`,
);
console.log(
  `  increments, both resets  : ${perStep.map((v) => v.toFixed(2)).join(' ')}  -> ${
    flat ? 'constant (torque applied once per step)' : 'not constant'
  }`,
);

const ok =
  growing &&
  flat &&
  onlyForces.angularVelocities[9] > both.angularVelocities[9] * 2 &&
  Math.abs(both.userTorque) < 200;

console.log(
  `\n${ok ? 'OK' : 'UNEXPECTED'}: resetForces alone lets the user torque accumulate; ` +
    `Vehicle.step must reset the torques too.`,
);
process.exit(ok ? 0 : 1);
