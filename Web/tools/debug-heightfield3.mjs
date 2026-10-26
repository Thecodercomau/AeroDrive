import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

function raycastWorld(world, label) {
  let hits = 0;
  const samples = [];
  for (let x = -120; x <= 120; x += 30) {
    for (let z = -120; z <= 120; z += 30) {
      const ray = new RAPIER.Ray({ x, y: 200, z }, { x: 0, y: -1, z: 0 });
      const hit = world.castRay(ray, 400, true);
      if (hit) {
        hits++;
        if (samples.length < 5)
          samples.push(`(${x},${z})->y=${(200 - hit.timeOfImpact).toFixed(2)}`);
      }
    }
  }
  console.log(`${label}: ${hits} hits`, samples.join(' '));
}

// A: plain cuboid (sanity check the raycast plumbing)
{
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(100, 1, 100).setTranslation(0, 0, 0), body);
  raycastWorld(world, 'cuboid');
  world.free();
}

// B: heightfield, resolution 16, 17x17 heights, ramp
{
  const resolution = 16,
    size = 160,
    n = 17;
  const heights = new Float32Array(n * n);
  const gx = (i) => (i / resolution - 0.5) * size;
  const gz = (j) => (j / resolution - 0.5) * size;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) heights[i + j * n] = gx(i) * 0.05 + gz(j) * 0.01;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(resolution, resolution, heights, { x: size, y: 1, z: size }, 1),
    body,
  );
  raycastWorld(world, 'heightfield A (i+n*j)');
  world.free();
}

// C: all-zero heights (flat plane) — does any ray hit?
{
  const resolution = 16,
    size = 160,
    n = 17;
  const heights = new Float32Array(n * n);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(resolution, resolution, heights, { x: size, y: 1, z: size }, 1),
    body,
  );
  raycastWorld(world, 'heightfield flat');
  world.free();
}
