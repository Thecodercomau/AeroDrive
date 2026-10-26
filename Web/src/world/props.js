import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createRandom } from '../utilities/random.js';
import { clamp } from '../utilities/math.js';

/**
 * Merge geometries for a prop.
 *
 * Two details matter here:
 *  - `mergeGeometries` refuses to mix indexed and non-indexed inputs, and the
 *    primitives we combine are a mix (`CylinderGeometry` is indexed, the
 *    `IcosahedronGeometry` crowns and rocks are not), so everything is converted
 *    to non-indexed first.
 *  - The merge keeps sub-mesh groups, which would cost an extra draw call per
 *    instance. Every prop uses one material, so the groups are dropped.
 */
function mergeClean(geometries) {
  const converted = geometries.map((geometry) =>
    geometry.index ? geometry.toNonIndexed() : geometry,
  );
  const merged = mergeGeometries(converted);
  if (!merged) throw new Error('mergeClean: geometries could not be merged');
  merged.clearGroups();
  // Release the throwaway de-indexed copies; the caller owns the originals.
  converted.forEach((geometry, index) => {
    if (geometry !== geometries[index]) geometry.dispose();
  });
  return merged;
}

/**
 * World props: vegetation, rocks, buildings, street furniture.
 *
 * Three performance decisions drive this module:
 *
 * 1. **Instancing.** Every tree of a given variant is one InstancedMesh, so
 *    1500 trees cost roughly one draw call per chunk instead of 1500.
 * 2. **Chunked streaming.** Props are bucketed into square chunks. Chunks
 *    outside the view distance are unloaded (GPU buffers released, physics
 *    colliders removed); chunks that come back are rebuilt from the stored
 *    transforms. Nothing about the *world* is regenerated, so it stays identical.
 * 3. **Cheap colliders.** Colliders are primitives (cylinder, ball, box) sized to
 *    the prop, never the visual mesh. A tree is a cylinder, not a cone mesh, and
 *    only solid props get colliders at all.
 *
 * Placement is fully deterministic: same map + same seed = same world.
 */

export const PROP_TYPES = [
  'pineTree',
  'broadleafTree',
  'bush',
  'rock',
  'building',
  'streetlight',
  'sign',
  'parkedCar',
  'jumpRamp',
];

/**
 * Jump-ramp dimensions, in metres.
 *
 * Shared by the visual wedge and its collider, so the surface a wheel climbs and
 * the surface you can see are the same surface. The rise is deliberately under a
 * third of the length: at 15.5 degrees a car launches at speed without the nose
 * digging into the transition.
 */
export const JUMP_RAMP = {
  length: 13,
  rise: 3.6,
  width: 8,
  thickness: 0.5,
};

/** Shared materials — reused by every instance of a type. */
let sharedMaterials = null;
function materials() {
  if (sharedMaterials) return sharedMaterials;
  sharedMaterials = {
    pine: new THREE.MeshStandardMaterial({ color: 0x2f5d3a, roughness: 0.92, metalness: 0.02 }),
    broadleaf: new THREE.MeshStandardMaterial({ color: 0x4a7c3f, roughness: 0.9, metalness: 0.02 }),
    bush: new THREE.MeshStandardMaterial({ color: 0x557f3c, roughness: 0.95, metalness: 0.0 }),
    trunk: new THREE.MeshStandardMaterial({ color: 0x4b3a2a, roughness: 0.95, metalness: 0.0 }),
    rock: new THREE.MeshStandardMaterial({ color: 0x77726c, roughness: 0.95, metalness: 0.03 }),
    building: new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.82, metalness: 0.05 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x8a4a3a, roughness: 0.85, metalness: 0.03 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x4c5259, roughness: 0.5, metalness: 0.6 }),
    signFace: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7, metalness: 0.05 }),
    // Parked cars share one material per variant, like every other prop, so the
    // three colours here are all the variety there is. That is a deliberate
    // trade: per-instance colour would mean either a unique material per body
    // (breaking instancing) or a vertex-colour pass over the merged geometry.
    carBody: [
      new THREE.MeshStandardMaterial({ color: 0xc2c6cb, roughness: 0.45, metalness: 0.35 }),
      new THREE.MeshStandardMaterial({ color: 0x8f3b32, roughness: 0.5, metalness: 0.3 }),
      new THREE.MeshStandardMaterial({ color: 0x39424d, roughness: 0.5, metalness: 0.3 }),
    ],
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff3cf,
      emissive: 0xffe9b0,
      emissiveIntensity: 0.4,
      roughness: 0.3,
    }),
    ramp: new THREE.MeshStandardMaterial({ color: 0x9a8f80, roughness: 0.86, metalness: 0.04 }),
  };
  return sharedMaterials;
}

/* -------------------------------------------------------------------------- */
/*                              geometry builders                             */
/* -------------------------------------------------------------------------- */

function pineGeometry(rand) {
  const trunkHeight = rand.range(1.4, 2.4);
  const trunk = new THREE.CylinderGeometry(0.16, 0.22, trunkHeight, 6);
  trunk.translate(0, trunkHeight / 2, 0);

  // Two stacked cones read as a conifer far more convincingly than one.
  const lower = new THREE.ConeGeometry(rand.range(1.5, 2.1), rand.range(3.2, 4.4), 8);
  lower.translate(0, trunkHeight + 1.6, 0);
  const upper = new THREE.ConeGeometry(rand.range(1.0, 1.4), rand.range(2.2, 3.0), 8);
  upper.translate(0, trunkHeight + 3.5, 0);

  const foliage = mergeClean([lower, upper]);
  lower.dispose();
  upper.dispose();

  const merged = mergeClean([trunk, foliage]);
  trunk.dispose();
  foliage.dispose();
  return { geometry: merged };
}

function broadleafGeometry(rand) {
  const trunkHeight = rand.range(1.8, 3.0);
  const trunk = new THREE.CylinderGeometry(0.18, 0.26, trunkHeight, 6);
  trunk.translate(0, trunkHeight / 2, 0);

  const crown = new THREE.IcosahedronGeometry(rand.range(1.8, 2.6), 1);
  // Squash and stretch so canopies are not perfect spheres.
  crown.scale(1.1, rand.range(0.8, 1.1), 1.05);
  crown.translate(0, trunkHeight + 1.6, 0);

  const merged = mergeClean([trunk, crown]);
  trunk.dispose();
  crown.dispose();
  return { geometry: merged };
}

function bushGeometry(rand) {
  const geometry = new THREE.IcosahedronGeometry(rand.range(0.7, 1.3), 0);
  geometry.scale(1.2, 0.85, 1.2);
  geometry.translate(0, rand.range(0.4, 0.7), 0);
  return { geometry };
}

function rockGeometry(rand) {
  const geometry = new THREE.IcosahedronGeometry(rand.range(0.8, 2.4), 0);
  // Randomly displace vertices to break the perfect polyhedron silhouette.
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const factor = 1 + (rand() - 0.5) * 0.5;
    position.setXYZ(
      i,
      position.getX(i) * factor,
      position.getY(i) * factor * 0.8,
      position.getZ(i) * factor,
    );
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  return { geometry };
}

function buildingGeometry(rand) {
  const width = rand.range(7, 15);
  const depth = rand.range(7, 15);
  const height = rand.range(7, 26);
  const body = new THREE.BoxGeometry(width, height, depth);
  body.translate(0, height / 2, 0);
  return { geometry: body, size: { width, depth, height } };
}

function roofedBuildingGeometry(rand) {
  const width = rand.range(6, 11);
  const depth = rand.range(6, 10);
  const height = rand.range(4, 8);
  const body = new THREE.BoxGeometry(width, height, depth);
  body.translate(0, height / 2, 0);
  const roof = new THREE.ConeGeometry(Math.max(width, depth) * 0.78, 2.4, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, height + 1.2, 0);
  const merged = mergeClean([body, roof]);
  body.dispose();
  roof.dispose();
  return { geometry: merged, size: { width, depth, height } };
}

function streetlightGeometry() {
  const pole = new THREE.CylinderGeometry(0.12, 0.16, 8, 6);
  pole.translate(0, 4, 0);
  const arm = new THREE.BoxGeometry(0.16, 0.16, 2.2);
  arm.translate(0, 8.1, 1.1);
  const head = new THREE.BoxGeometry(0.5, 0.18, 0.9);
  head.translate(0, 7.95, 2.1);
  const merged = mergeClean([pole, arm, head]);
  pole.dispose();
  arm.dispose();
  head.dispose();
  return { geometry: merged };
}

/**
 * A simplified parked car.
 *
 * Deliberately not a vehicle model: this is scenery, and it is instanced by the
 * hundred. A wedge body plus a cabin box reads as a parked car at a glance from
 * the road, which is all it has to do.
 */
function parkedCarGeometry(rand) {
  const length = rand.range(4.1, 5.2);
  const width = rand.range(1.75, 2.0);
  const bodyHeight = rand.range(0.65, 0.8);

  const body = new THREE.BoxGeometry(width, bodyHeight, length);
  body.translate(0, 0.42 + bodyHeight / 2, 0);

  const cabin = new THREE.BoxGeometry(width * 0.86, rand.range(0.5, 0.66), length * 0.46);
  cabin.translate(0, 0.42 + bodyHeight + 0.3, -length * 0.06);

  const merged = mergeClean([body, cabin]);
  body.dispose();
  cabin.dispose();
  return { geometry: merged, size: { width, depth: length, height: bodyHeight + 0.95 } };
}

function signGeometry() {
  const pole = new THREE.CylinderGeometry(0.08, 0.08, 2.6, 5);
  pole.translate(0, 1.3, 0);
  const panel = new THREE.BoxGeometry(1.5, 0.9, 0.08);
  panel.translate(0, 2.3, 0);
  const merged = mergeClean([pole, panel]);
  pole.dispose();
  panel.dispose();
  return { geometry: merged };
}

/**
 * A solid wedge standing on the ground, climbing along +Z.
 *
 * Built as explicit triangles rather than from boxes because the incline has to
 * be a real slope: a box pile would be a step the car crashes into. The origin
 * is the low edge, on the ground, so an instance only has to be placed on the
 * terrain and rotated to face the direction of travel.
 *
 * Winding matters — `MeshStandardMaterial` is single-sided — so each face is
 * ordered with its normal pointing out of the solid: up-and-back for the incline,
 * +Z for the tail, -X and +X for the two sides.
 */
function rampGeometry() {
  const { length: L, rise: H, width: W } = JUMP_RAMP;
  const halfWidth = W / 2;
  const lowLeft = [-halfWidth, 0, 0];
  const lowRight = [halfWidth, 0, 0];
  const topLeft = [-halfWidth, H, L];
  const topRight = [halfWidth, H, L];
  const backLeft = [-halfWidth, 0, L];
  const backRight = [halfWidth, 0, L];

  const positions = new Float32Array([
    ...lowLeft,
    ...topRight,
    ...lowRight,
    ...lowLeft,
    ...topLeft,
    ...topRight,
    ...backLeft,
    ...backRight,
    ...topRight,
    ...backLeft,
    ...topRight,
    ...topLeft,
    ...lowLeft,
    ...backLeft,
    ...topLeft,
    ...lowRight,
    ...topRight,
    ...backRight,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry };
}

/**
 * Build the geometry + material for one prop type and variant.
 * Three variants per type gives visual variety without unbounded geometry.
 */
export function createPropVariants(type, seed = 1, variantCount = 3) {
  const rand = createRandom(`${type}:${seed}`);
  const mat = materials();
  /** @type {Array<{geometry: THREE.BufferGeometry, material: THREE.Material, solid: string|null}>} */
  const variants = [];

  for (let variant = 0; variant < variantCount; variant++) {
    switch (type) {
      case 'pineTree': {
        const built = pineGeometry(rand);
        variants.push({
          geometry: built.geometry,
          material: mat.pine,
          solid: 'cylinder',
          solidRadius: 0.35,
          solidHeight: 3,
        });
        break;
      }
      case 'broadleafTree': {
        const built = broadleafGeometry(rand);
        variants.push({
          geometry: built.geometry,
          material: mat.broadleaf,
          solid: 'cylinder',
          solidRadius: 0.4,
          solidHeight: 3,
        });
        break;
      }
      case 'bush':
        variants.push({ geometry: bushGeometry(rand).geometry, material: mat.bush, solid: null });
        break;
      case 'rock': {
        const built = rockGeometry(rand);
        variants.push({
          geometry: built.geometry,
          material: mat.rock,
          solid: 'ball',
          solidRadius: 1.1,
        });
        break;
      }
      case 'building': {
        const built = variant % 2 === 0 ? buildingGeometry(rand) : roofedBuildingGeometry(rand);
        variants.push({
          geometry: built.geometry,
          material: variant % 2 === 0 ? mat.building : mat.roof,
          solid: 'box',
          solidSize: built.size,
        });
        break;
      }
      case 'streetlight':
        variants.push({
          geometry: streetlightGeometry().geometry,
          material: mat.metal,
          solid: 'cylinder',
          solidRadius: 0.2,
          solidHeight: 4,
        });
        break;
      case 'sign':
        variants.push({
          geometry: signGeometry().geometry,
          material: mat.signFace,
          solid: 'cylinder',
          solidRadius: 0.15,
          solidHeight: 1.6,
        });
        break;
      case 'parkedCar': {
        const built = parkedCarGeometry(rand);
        variants.push({
          geometry: built.geometry,
          material: mat.carBody[variant % mat.carBody.length],
          solid: 'box',
          solidSize: built.size,
        });
        break;
      }
      case 'jumpRamp':
        // One variant, and only one: a ramp is not scenery. The wedge is the same
        // size every time and there is nothing to vary, so the other two variants
        // would be identical geometry costing memory for no visual difference.
        if (variant === 0) {
          variants.push({
            geometry: rampGeometry().geometry,
            material: mat.ramp,
            solid: 'ramp',
            ramp: { ...JUMP_RAMP },
          });
        }
        break;
      default:
        throw new Error(`createPropVariants: unknown prop type "${type}"`);
    }
  }
  return variants;
}

/* -------------------------------------------------------------------------- */
/*                               placement                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deterministically place props for a map.
 *
 * Rejection sampling is used rather than a Poisson disc grid: it is simpler, it
 * keeps the world reproducible from the seed, and the accept/reject rules
 * (slope, road clearance, water, spacing) are easy to read and to test.
 *
 * @returns {Map<string, Array>} chunk key -> instances
 */
export function generateProps({ map, terrain, roads, vegetationDensity = 100, seed }) {
  const rand = createRandom(seed ?? map.terrain.seed);
  const config = map.props;
  const density = clamp(vegetationDensity / 100, 0, 1) * (config.density ?? 1);
  const halfSize = map.terrain.size / 2 - 40;

  const roadSamples = roads.allCentrelinePoints();
  // A 100 m cell grid guarantees the 3x3 lookup covers at least 100 m in every
  // direction, which is the furthest `maxRoadDistance` any prop rule asks for,
  // so a distant road can never be missed and silently reject a valid placement.
  const roadGrid = buildSpatialGrid(roadSamples, 100);
  const distanceToRoad = (x, z) => nearestDistance(roadGrid, x, z, 100);

  const chunks = new Map();
  const push = (instance) => {
    const key = chunkKey(instance.x, instance.z, CHUNK_SIZE);
    let list = chunks.get(key);
    if (!list) {
      list = [];
      chunks.set(key, list);
    }
    list.push(instance);
  };

  const solidBudget = { used: 0, max: config.solidColliderBudget ?? 700 };

  const tryPlace = (type, attempts, options) => {
    for (let i = 0; i < attempts; i++) {
      const x = (rand() * 2 - 1) * halfSize;
      const z = (rand() * 2 - 1) * halfSize;
      const height = terrain.heightAt(x, z);
      const slope = terrain.slopeAt(x, z);
      if (height < (options.minHeight ?? -Infinity)) continue;
      if (height > (options.maxHeight ?? Infinity)) continue;
      if (slope > (options.maxSlope ?? 0.45)) continue;
      const roadDistance = distanceToRoad(x, z);
      if (roadDistance < (options.minRoadDistance ?? 10)) continue;
      if (options.maxRoadDistance !== undefined && roadDistance > options.maxRoadDistance) continue;

      const variant = Math.floor(rand() * 3);
      const scale = options.scaleRange
        ? rand.range(options.scaleRange[0], options.scaleRange[1])
        : 1;
      const rotation = rand() * Math.PI * 2;
      const solid = Boolean(options.solid) && solidBudget.used < solidBudget.max;
      if (solid) solidBudget.used++;

      push({
        type,
        variant,
        x,
        y: height + (options.yOffset ?? 0),
        z,
        scale,
        rotation,
        solid,
        tint: rand(),
      });
    }
  };

  const veg = (n) => Math.round(n * density);

  tryPlace('pineTree', veg(config.trees * 0.62), {
    maxSlope: 0.6,
    minRoadDistance: 9,
    scaleRange: [0.85, 1.35],
    solid: true,
  });
  tryPlace('broadleafTree', veg(config.trees * 0.38), {
    maxSlope: 0.42,
    maxHeight: 55,
    minRoadDistance: 9,
    scaleRange: [0.85, 1.3],
    solid: true,
  });
  tryPlace('bush', veg(config.trees * 0.5), {
    maxSlope: 0.5,
    minRoadDistance: 6,
    scaleRange: [0.8, 1.4],
  });
  tryPlace('rock', Math.round(config.rocks * Math.max(0.5, density)), {
    maxSlope: 1,
    minHeight: 2,
    minRoadDistance: 7,
    scaleRange: [0.6, 1.6],
    solid: true,
  });
  tryPlace('building', Math.round(config.buildings * density), {
    maxSlope: 0.16,
    minRoadDistance: 14,
    maxRoadDistance: 90,
    scaleRange: [0.9, 1.25],
    solid: true,
  });
  tryPlace('streetlight', Math.round(config.streetlights * density), {
    maxSlope: 0.2,
    minRoadDistance: 5.5,
    maxRoadDistance: 9,
    scaleRange: [0.95, 1.05],
    solid: true,
  });
  tryPlace('sign', Math.round(config.signs * density), {
    maxSlope: 0.3,
    minRoadDistance: 6,
    maxRoadDistance: 14,
    scaleRange: [0.9, 1.15],
    solid: true,
  });
  // Parked cars line the kerb: close enough to read as parking, far enough out
  // that they never sit on the carriageway. The minimum is half the widest road
  // (11 m) plus the car's own half-width.
  tryPlace('parkedCar', Math.round((config.parkedCars ?? 0) * density), {
    maxSlope: 0.14,
    minRoadDistance: 7.5,
    maxRoadDistance: 13,
    scaleRange: [0.95, 1.05],
    solid: true,
  });

  // Jump ramps are the one prop that is *declared* rather than scattered. A
  // random ramp is a ramp pointing somewhere useless: it has to sit flat, on the
  // approach to a corner the map author had in mind, and face the way a car will
  // arrive. So the map lists them by position and heading and they are placed
  // exactly, without the rejection sampling above. They sit on the flattened road
  // verge, which is why the map derives their coordinates from a road.
  for (const ramp of config.ramps ?? []) {
    // Sunk a metre into the ground on purpose. The terrain under a ramp is a
    // bilinear interpolation of a height grid whose spacing is over ten metres,
    // so the ground can be a good fraction of a metre higher or lower along the
    // ramp's length than it is at its origin. Setting the ramp's origin a metre
    // down means the incline always emerges from the ground part way along and
    // no configuration leaves a lip for a wheel to catch on — the buried half
    // simply is not visible.
    const sink = ramp.sink ?? 1;
    const heading = ramp.heading ?? 0;
    // Point the ramp down the local grade rather than up it. A ramp is rigid and
    // the ground is not, so facing uphill the hill climbs faster than the incline
    // does and swallows the ramp whole — a ray dropped on the middle of the
    // incline lands on terrain. Facing downhill, the incline stays proud of the
    // ground for its whole run and the car launches over the falling terrain,
    // which is what a jump ramp is for. The map still chooses the axis; this only
    // decides which end is the low one.
    const forwardX = Math.sin(heading);
    const forwardZ = Math.cos(heading);
    const reach = JUMP_RAMP.length;
    const ahead = terrain.heightAt(ramp.x + forwardX * reach, ramp.z + forwardZ * reach);
    const behind = terrain.heightAt(ramp.x - forwardX * reach, ramp.z - forwardZ * reach);
    push({
      type: 'jumpRamp',
      variant: 0,
      x: ramp.x,
      y: terrain.heightAt(ramp.x, ramp.z) - sink,
      z: ramp.z,
      scale: ramp.scale ?? 1,
      rotation: ahead <= behind ? heading : heading + Math.PI,
      solid: true,
      // Mid tint: the per-instance shading exists to break up clone forests, and
      // a single ramp has nothing to disguise.
      tint: 0.5,
    });
  }

  return chunks;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);

export const CHUNK_SIZE = 180;

export function chunkKey(x, z, chunkSize = CHUNK_SIZE) {
  return `${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`;
}

function buildSpatialGrid(points, cellSize) {
  const grid = new Map();
  for (const point of points) {
    const key = `${Math.floor(point.x / cellSize)},${Math.floor(point.z / cellSize)}`;
    let list = grid.get(key);
    if (!list) {
      list = [];
      grid.set(key, list);
    }
    list.push(point);
  }
  return grid;
}

function nearestDistance(grid, x, z, cellSize) {
  const cx = Math.floor(x / cellSize);
  const cz = Math.floor(z / cellSize);
  let best = Infinity;
  // Search a 3x3 neighbourhood; anything further than 2 cells away cannot beat
  // the current best for our purposes because the caller's thresholds are small.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx + dx},${cz + dz}`);
      if (!list) continue;
      for (const point of list) {
        const distance = Math.hypot(point.x - x, point.z - z);
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/*                                prop field                                  */
/* -------------------------------------------------------------------------- */

/**
 * Streams props in and out around the player.
 *
 * `update()` is called once per frame from the render side, but only touches
 * chunk bookkeeping (a handful of distance comparisons), never the props
 * themselves. Loading/unloading work happens at most a few chunks per frame.
 */
export class PropField {
  /**
   * @param {object} options
   * @param {object} options.map
   * @param {import('../terrain/Terrain.js').Terrain} options.terrain
   * @param {import('../roads/RoadNetwork.js').RoadNetwork} options.roads
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} options.physics
   */
  constructor({ map, terrain, roads, physics, vegetationDensity = 100, seed = null }) {
    this.map = map;
    this.terrain = terrain;
    this.roads = roads;
    this.physics = physics;
    this.group = new THREE.Group();
    this.group.name = 'props';

    this.variants = new Map();
    for (const type of PROP_TYPES)
      this.variants.set(type, createPropVariants(type, map.terrain.seed));

    this.chunks = generateProps({ map, terrain, roads, vegetationDensity, seed });
    /** @type {Map<string, {meshes: THREE.InstancedMesh[], colliders: any[], loaded: boolean}>} */
    this.loaded = new Map();
    this.stats = {
      loadedChunks: 0,
      loadedProps: 0,
      colliders: 0,
      unloadedChunks: this.chunks.size,
    };
    this._dirty = true;
  }

  get chunkCount() {
    return this.chunks.size;
  }

  /** Force every chunk to (re)build — used on first load and after a settings change. */
  loadAll() {
    for (const key of this.chunks.keys()) this._loadChunk(key);
  }

  /**
   * Stream chunks around a world position.
   * @param {{x:number,z:number}} position
   * @param {object} options
   */
  update(position, { loadDistance = 700, unloadDistance = null } = {}) {
    const unload = unloadDistance ?? loadDistance * 1.35;
    const loadRadiusSq = loadDistance * loadDistance;
    const unloadRadiusSq = unload * unload;

    // Cap the work per frame so a fast car crossing many chunk boundaries cannot
    // stall the frame by rebuilding a dozen chunks in one tick.
    let budget = 4;

    for (const [key, instances] of this.chunks) {
      const centre = chunkCentre(key);
      const distanceSq = (centre.x - position.x) ** 2 + (centre.z - position.z) ** 2;
      const isLoaded = this.loaded.has(key);

      if (!isLoaded && distanceSq <= loadRadiusSq && budget > 0) {
        this._loadChunk(key, instances);
        budget--;
      } else if (isLoaded && distanceSq > unloadRadiusSq) {
        this._unloadChunk(key);
      }
    }
  }

  _loadChunk(key, instances = this.chunks.get(key)) {
    if (this.loaded.has(key) || !instances) return;

    // Group the chunk's instances by (type, variant) so each becomes one
    // InstancedMesh — one draw call per type-variant per chunk.
    const buckets = new Map();
    for (const instance of instances) {
      const bucketKey = `${instance.type}:${instance.variant}`;
      let list = buckets.get(bucketKey);
      if (!list) {
        list = [];
        buckets.set(bucketKey, list);
      }
      list.push(instance);
    }

    const meshes = [];
    const colliders = [];
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const vector = new THREE.Vector3();
    const scaleVector = new THREE.Vector3();
    const colour = new THREE.Color();

    for (const [bucketKey, list] of buckets) {
      const [type, variantIndex] = bucketKey.split(':');
      const variant = this.variants.get(type)?.[Number(variantIndex)];
      if (!variant) continue;

      const instanced = new THREE.InstancedMesh(variant.geometry, variant.material, list.length);
      instanced.castShadow =
        type === 'pineTree' ||
        type === 'broadleafTree' ||
        type === 'building' ||
        type === 'jumpRamp';
      instanced.receiveShadow = true;
      instanced.frustumCulled = true;

      list.forEach((instance, index) => {
        quaternion.setFromAxisAngle(UP, instance.rotation);
        vector.set(instance.x, instance.y, instance.z);
        scaleVector.set(instance.scale, instance.scale, instance.scale);
        matrix.compose(vector, quaternion, scaleVector);
        instanced.setMatrixAt(index, matrix);

        // Subtle per-instance tint so a forest does not look like clones.
        const shade = 0.86 + instance.tint * 0.28;
        colour.setRGB(shade, shade, shade);
        if (instanced.setColorAt) instanced.setColorAt(index, colour);
      });

      instanced.instanceMatrix.needsUpdate = true;
      if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
      instanced.computeBoundingSphere?.();
      this.group.add(instanced);
      meshes.push(instanced);
    }

    // Physics: primitive colliders only, and only for solid props.
    if (this.physics) {
      for (const instance of instances) {
        if (!instance.solid) continue;
        const variant = this.variants.get(instance.type)?.[instance.variant];
        if (!variant?.solid) continue;
        const collider = this._addCollider(instance, variant);
        if (collider) colliders.push(collider);
      }
    }

    this.loaded.set(key, { meshes, colliders, loaded: true });
    this._recount();
  }

  _addCollider(instance, variant) {
    const { physics } = this;
    const position = { x: instance.x, y: instance.y, z: instance.z };
    try {
      if (variant.solid === 'cylinder') {
        const radius = (variant.solidRadius ?? 0.3) * instance.scale;
        const height = (variant.solidHeight ?? 2) * instance.scale;
        const desc = physics.RAPIER.ColliderDesc.cylinder(height / 2, radius).setTranslation(
          position.x,
          position.y + height / 2,
          position.z,
        );
        return physics.addStatic(desc, { surface: 'dirt', tag: `prop:${instance.type}` });
      }
      if (variant.solid === 'ball') {
        const radius = (variant.solidRadius ?? 1) * instance.scale;
        const desc = physics.RAPIER.ColliderDesc.ball(radius).setTranslation(
          position.x,
          position.y + radius * 0.6,
          position.z,
        );
        return physics.addStatic(desc, { surface: 'dirt', tag: `prop:${instance.type}` });
      }
      if (variant.solid === 'box') {
        const size = variant.solidSize ?? { width: 8, depth: 8, height: 8 };
        const half = {
          x: (size.width * instance.scale) / 2,
          y: (size.height * instance.scale) / 2,
          z: (size.depth * instance.scale) / 2,
        };
        const rotation = new THREE.Quaternion().setFromAxisAngle(UP, instance.rotation);
        const desc = physics.RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(
          position.x,
          position.y + half.y,
          position.z,
        );
        desc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
        return physics.addStatic(desc, { surface: 'asphalt', tag: `prop:${instance.type}` });
      }
      if (variant.solid === 'ramp') {
        // A ramp is a cuboid tilted up to the wedge's incline, not the wedge
        // mesh: an inclined box is a cheap primitive, and its top face is the
        // exact plane a wheel has to roll up. The slab is offset perpendicular
        // to the incline so that its TOP face — not its centre — is the surface,
        // and the tail is left an inch proud of the wedge so a wheel cannot catch
        // on a lip at the crest.
        const spec = variant.ramp ?? JUMP_RAMP;
        const scale = instance.scale;
        const length = spec.length * scale;
        const rise = spec.rise * scale;
        const width = spec.width * scale;
        const thickness = spec.thickness * scale;
        const slope = Math.hypot(length, rise) || 1;
        const pitch = Math.atan2(rise, length);

        const yaw = new THREE.Quaternion().setFromAxisAngle(UP, instance.rotation);
        const orientation = yaw
          .clone()
          .multiply(new THREE.Quaternion().setFromAxisAngle(X_AXIS, -pitch));
        const offset = new THREE.Vector3(
          0,
          rise / 2 - (length / slope) * (thickness / 2),
          length / 2 + (rise / slope) * (thickness / 2),
        ).applyQuaternion(yaw);

        const desc = physics.RAPIER.ColliderDesc.cuboid(width / 2, thickness / 2, slope / 2)
          .setTranslation(position.x + offset.x, position.y + offset.y, position.z + offset.z)
          .setRotation({
            x: orientation.x,
            y: orientation.y,
            z: orientation.z,
            w: orientation.w,
          });
        return physics.addStatic(desc, { surface: 'asphalt', tag: `prop:${instance.type}` });
      }
    } catch (error) {
      console.warn(`[Props] Could not build collider for ${instance.type}:`, error.message);
    }
    return null;
  }

  _unloadChunk(key) {
    const chunk = this.loaded.get(key);
    if (!chunk) return;
    for (const mesh of chunk.meshes) {
      // Geometries and materials are shared across chunks, so only the
      // InstancedMesh's own instance buffers are released here.
      mesh.dispose();
      this.group.remove(mesh);
    }
    if (this.physics) {
      for (const collider of chunk.colliders) this.physics.removeCollider(collider);
    }
    this.loaded.delete(key);
    this._recount();
  }

  _recount() {
    let props = 0;
    let colliders = 0;
    for (const chunk of this.loaded.values()) {
      colliders += chunk.colliders.length;
      for (const mesh of chunk.meshes) props += mesh.count;
    }
    this.stats.loadedChunks = this.loaded.size;
    this.stats.loadedProps = props;
    this.stats.colliders = colliders;
    this.stats.unloadedChunks = this.chunks.size - this.loaded.size;
  }

  /** Unload everything (map change, quit to menu). */
  unloadAll() {
    for (const key of [...this.loaded.keys()]) this._unloadChunk(key);
  }

  dispose() {
    this.unloadAll();
    for (const variants of this.variants.values()) {
      for (const variant of variants) variant.geometry.dispose();
    }
    this.variants.clear();
    this.group.parent?.remove(this.group);
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function chunkCentre(key, chunkSize = CHUNK_SIZE) {
  const [cx, cz] = key.split(',').map(Number);
  return { x: (cx + 0.5) * chunkSize, z: (cz + 0.5) * chunkSize };
}

export { chunkCentre };

/** Release the module-level shared materials (called on full teardown). */
export function disposePropMaterials() {
  if (!sharedMaterials) return;
  for (const material of Object.values(sharedMaterials)) material.dispose();
  sharedMaterials = null;
}
