/* Diagnostic: trace speed/gear/rpm/contact while braking and while handbraking. */
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';
import { emptyControlState } from '../src/input/inputMapping.js';

const DT = 1 / 60;

async function run(label, accelSteps, phaseTwo, phaseTwoSteps) {
  const world = new PhysicsWorld();
  await world.init();
  world.addStaticBox({ x: 400, y: 1, z: 400 }, { x: 0, y: -1, z: 0 }, null, {
    surface: 'asphalt',
    tag: 'terrain',
  });
  const vehicle = new Vehicle({
    physics: world,
    definition: getVehicleDefinition('coupe'),
    spawn: { x: 0, y: 1.2, z: 0 },
  });

  const stepWith = (controls, n) => {
    for (let i = 0; i < n; i++) {
      vehicle.step(DT, { ...emptyControlState(), ...controls });
      world.step(DT);
    }
  };

  stepWith({}, 60);
  stepWith({ throttle: 1 }, accelSteps);
  console.log(`\n=== ${label} ===`);
  console.log(
    `after accel: speed=${vehicle.speedKmh().toFixed(1)}km/h gear=${vehicle.telemetry.gear} rpm=${vehicle.telemetry.rpm.toFixed(0)} y=${vehicle.position().y.toFixed(2)}`,
  );

  for (let i = 0; i < phaseTwoSteps; i += 20) {
    stepWith(phaseTwo, 20);
    const t = vehicle.telemetry;
    const contacts = vehicle.wheelStates.map((w) => (w.inContact ? '1' : '0')).join('');
    console.log(
      `t=${(i / 60).toFixed(2)}s speed=${vehicle.speedKmh().toFixed(1)} gear=${t.gear} rpm=${t.rpm.toFixed(0)} contact=${contacts} y=${vehicle.position().y.toFixed(2)} fw=i${vehicle.wheelStates.map((w) => w.forwardImpulse.toFixed(0)).join(',')}`,
    );
  }
  vehicle.dispose();
  world.dispose();
}

await run('brake only', 600, { brake: 1 }, 200);
await run('handbrake only', 300, { handbrake: true }, 120);
await run('throttle+handbrake', 300, { handbrake: true, throttle: 1 }, 120);
