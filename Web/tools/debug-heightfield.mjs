import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

function attempt(label, nrows, ncols, len) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try {
    const heights = new Float32Array(len);
    for (let i = 0; i < len; i++) heights[i] = i * 0.01;
    const desc = RAPIER.ColliderDesc.heightfield(
      nrows,
      ncols,
      heights,
      { x: 100, y: 1, z: 100 },
      1,
    );
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(desc, body);
    console.log(`OK   ${label}: nrows=${nrows} ncols=${ncols} len=${len}`);
  } catch (e) {
    console.log(
      `FAIL ${label}: nrows=${nrows} ncols=${ncols} len=${len} -> ${String(e.message).slice(0, 60)}`,
    );
  } finally {
    world.free();
  }
}

attempt('square 17x17', 17, 17, 289);
attempt('square 16x16', 16, 16, 256);
attempt('square 16x16 with 289', 16, 16, 289);
attempt('17x17 with 256', 17, 17, 256);
attempt('flat 289x1', 289, 1, 289);
attempt('flags 0', 17, 17, 289);
