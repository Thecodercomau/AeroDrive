import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();

const resolution = 16;
const size = 160;
const n = resolution + 1;
const heights = new Float32Array(n * n);
const gx = (i) => (i / resolution - 0.5) * size;
const gz = (j) => (j / resolution - 0.5) * size;
// Layout A: index = i + j*n  (i along X, j along Z)
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) heights[i + j * n] = gx(i) * 0.05 + gz(j) * 0.01;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const desc = RAPIER.ColliderDesc.heightfield(
  resolution,
  resolution,
  heights,
  { x: size, y: 1, z: size },
  1,
);
const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
const collider = world.createCollider(desc, body);
console.log('collider created, handle =', collider.handle);

for (const p of [
  { x: 0, z: 0 },
  { x: 32, z: -24 },
  { x: -48, z: 56 },
  { x: 61, z: 12 },
]) {
  const ray = new RAPIER.Ray({ x: p.x, y: 200, z: p.z }, { x: 0, y: -1, z: 0 });
  const hit = world.castRayAndGetNormal(ray, 400, true);
  const expected = p.x * 0.05 + p.z * 0.01; // layout A prediction
  const expectedB = p.z * 0.05 + p.x * 0.01; // layout B (transposed) prediction
  console.log(
    `(${p.x},${p.z}) hit=${hit ? hit.timeOfImpact.toFixed(2) : 'NONE'} y=${hit ? (200 - hit.timeOfImpact).toFixed(3) : '-'} expectA=${expected.toFixed(3)} expectB=${expectedB.toFixed(3)}`,
  );
}
world.free();
