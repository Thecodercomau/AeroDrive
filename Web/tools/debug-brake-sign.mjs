/* Determine, empirically, what `setWheelBrake` actually does. */
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';

const DT = 1 / 60;

async function probe(brakeValue, useEngineForce) {
  const world = new PhysicsWorld();
  await world.init();
  world.addStaticBox({ x: 4000, y: 1, z: 4000 }, { x: 0, y: -1, z: 0 }, null, {
    surface: 'asphalt',
    tag: 'terrain',
  });
  const vehicle = new Vehicle({
    physics: world,
    definition: getVehicleDefinition('sedan'),
    spawn: { x: 0, y: 1.2, z: 0 },
  });

  // Settle, then spin the wheels up to a steady speed by ramping engine force.
  for (let i = 0; i < 120; i++) {
    vehicle.step(DT, { throttle: 1, brake: 0, steer: 0, handbrake: false });
    world.step(DT);
  }
  const speedBefore = vehicle.speedKmh();
  const contact = vehicle.wheelStates.map((w) => (w.inContact ? 1 : 0)).join('');

  // Now apply ONLY the brake, bypassing the vehicle's own assist logic, so we
  // observe the raw Rapier behaviour.
  for (let i = 0; i < 60; i++) {
    for (let w = 0; w < 4; w++) {
      vehicle.controller.setWheelEngineForce(w, useEngineForce);
      vehicle.controller.setWheelBrake(w, brakeValue);
      vehicle.controller.setWheelSteering(w, 0);
    }
    vehicle.controller.updateVehicle(DT);
    world.step(DT);
  }
  const speedAfter = vehicle.speedKmh();
  const impulses = [];
  for (let w = 0; w < 4; w++) impulses.push(vehicle.controller.wheelForwardImpulse(w)?.toFixed(1));

  console.log(
    `brake=${String(brakeValue).padStart(5)} engine=${String(useEngineForce).padStart(5)} contact=${contact} before=${speedBefore.toFixed(1).padStart(6)} after=${speedAfter.toFixed(1).padStart(6)} forwardImpulse=[${impulses.join(', ')}]`,
  );

  vehicle.dispose();
  world.dispose();
}

for (const brake of [0, 5, 20, 60, 200, 800]) {
  await probe(brake, 0);
}
console.log('--- with engine force 100 N per wheel ---');
for (const brake of [0, 20, 60, 200]) {
  await probe(brake, 100);
}
