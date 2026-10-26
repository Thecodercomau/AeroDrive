import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Three questions about Rapier heightfields, all of which decide how this
 * project builds a tunnel.
 *
 * The world pipeline flattens the terrain into the road corridor. For a bridge
 * that is fine — the bridge is above everything. For a tunnel it is the whole
 * problem: cutting the corridor down to the road means the hill over the road
 * is destroyed and only a cut-and-cover shell can be drawn. If instead a
 * heightfield only collides with bodies *above* its surface, the terrain over a
 * tunnel can be left intact and the road can pass genuinely *through* the hill,
 * which is what a tunnel is supposed to look like from the driver's seat.
 *
 * So:
 *   1. Does a body below the surface get pushed out? (If yes: no buried road.)
 *   2. Does a body resting underneath generate phantom contacts? (If yes: no.)
 *   3. Control: does a body above the surface still land on it normally?
 *
 * Usage: node tools/probe-heightfield-sides.mjs
 */

await RAPIER.init();

function makeHill() {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = 1 / 60;
  const n = 16;
  const size = 160;
  const heights = new Float32Array((n + 1) * (n + 1));
  for (let ix = 0; ix <= n; ix++) {
    for (let iz = 0; iz <= n; iz++) {
      const x = (ix / n - 0.5) * size;
      const z = (iz / n - 0.5) * size;
      const r = Math.hypot(x, z);
      heights[iz + ix * (n + 1)] = Math.max(0, 12 * (1 - Math.min(1, r / 40)));
    }
  }
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.heightfield(
      n,
      n,
      heights,
      { x: size, y: 1, z: size },
      RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES,
    )
      .setFriction(0.9)
      .setRestitution(0),
    ground,
  );
  return world;
}

// 1. Under the hill, with nothing to stand on: does it get ejected upward?
{
  const world = makeHill();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 1), body);
  for (let step = 0; step < 120; step++) world.step();
  console.log(
    `1. under the hill, free  : y=0 -> ${body.translation().y.toFixed(2)} (fell = not pushed out)`,
  );
}

// 2. Under the hill but standing on a road at the hill's foot: does the hill
//    above push it down, up, or leave it alone?
{
  const world = makeHill();
  // A flat road surface at y = 1, 140 m across, under the hill.
  const road = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const half = 70;
  const vertices = new Float32Array([
    -half,
    1,
    -half,
    half,
    1,
    -half,
    half,
    1,
    half,
    -half,
    1,
    half,
  ]);
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(vertices, new Uint32Array([0, 1, 2, 0, 2, 3])).setFriction(0.95),
    road,
  );
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 3, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 1), body);
  for (let step = 0; step < 240; step++) world.step();
  // A cuboid landed on y = 1 rests with its centre at 1.5.
  console.log(
    `2. under the hill, on road: y=3 -> ${body.translation().y.toFixed(2)} (1.50 = resting on the road)`,
  );
}

// 3. Control: away from the hill the heightfield is at y = 0.
{
  const world = makeHill();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(60, 8, 60));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 1), body);
  for (let step = 0; step < 240; step++) world.step();
  console.log(
    `3. on flat heightfield   : y=8 -> ${body.translation().y.toFixed(2)} (0.50 = resting on the surface)`,
  );
}
