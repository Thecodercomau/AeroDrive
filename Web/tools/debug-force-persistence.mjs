import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // no gravity
world.timestep = 1 / 60;
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setMass(10), body);
body.addForce({ x: 100, y: 0, z: 0 }, true); // apply ONCE
for (let i = 0; i < 60; i++) world.step();
// 100 N on 10 kg is 10 m/s^2, so one second of that force is 10 m/s.
console.log('after 60 steps with a single addForce(100N) on 10kg:');
console.log('  velocity =', body.linvel().x.toFixed(4), 'm/s');
console.log(
  '  ~10 m/s means the force was applied on EVERY step (persistent, must be reset each frame);',
);
console.log('  ~0.167 m/s would mean it was consumed by the first step only.');
world.free();
