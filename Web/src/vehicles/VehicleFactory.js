import * as THREE from 'three';
import { resolvePaint } from './paints.js';
import { WHEEL_LAYOUT } from './Vehicle.js';

/**
 * Procedural vehicle models.
 *
 * Every vehicle silhouette is a 2D side profile extruded across the car's width,
 * which produces a real automotive shape rather than a stack of boxes. Seven
 * distinct profiles (hatchback, sedan, coupe, supercar, SUV, pickup, off-road)
 * mean no two classes are the same mesh recoloured.
 *
 * All geometry is generated in-engine; no external models are loaded or bundled.
 *
 * Material conventions:
 *  - `userData.paintable` marks meshes whose colour the garage can change.
 *  - `userData.brakeLight` marks materials that brighten under braking.
 *  - `userData.headlight` marks meshes belonging to the lamp units.
 */

/** Side-view silhouettes, normalised: x in [-1, 1] rear->front, y in [0, 1] floor->roof. */
const PROFILES = {
  hatchback: [
    [-1.0, 0.1],
    [-1.0, 0.6],
    [-0.7, 0.97],
    [0.24, 0.97],
    [0.62, 0.62],
    [1.0, 0.5],
    [1.0, 0.1],
  ],
  sedan: [
    [-1.0, 0.1],
    [-1.0, 0.5],
    [-0.78, 0.62],
    [-0.4, 0.93],
    [0.18, 0.93],
    [0.56, 0.6],
    [1.0, 0.5],
    [1.0, 0.1],
  ],
  coupe: [
    [-1.0, 0.08],
    [-1.0, 0.44],
    [-0.55, 0.66],
    [-0.16, 0.88],
    [0.24, 0.86],
    [0.72, 0.5],
    [1.0, 0.34],
    [1.0, 0.08],
  ],
  supercar: [
    [-1.0, 0.06],
    [-1.0, 0.46],
    [-0.3, 0.5],
    [0.02, 0.82],
    [0.3, 0.8],
    [0.85, 0.34],
    [1.0, 0.28],
    [1.0, 0.06],
  ],
  suv: [
    [-1.0, 0.1],
    [-1.0, 0.86],
    [-0.68, 1.0],
    [0.3, 1.0],
    [0.66, 0.72],
    [1.0, 0.62],
    [1.0, 0.1],
  ],
  pickup: [
    [-1.0, 0.1],
    [-1.0, 0.52],
    [-0.66, 0.54],
    [-0.4, 0.94],
    [0.1, 0.94],
    [0.42, 0.6],
    [1.0, 0.5],
    [1.0, 0.1],
  ],
  offroad: [
    [-1.0, 0.1],
    [-1.0, 0.8],
    [-0.8, 0.98],
    [0.4, 0.98],
    [0.72, 0.7],
    [1.0, 0.62],
    [1.0, 0.1],
  ],
};

/** Per-class extras: spoiler, roof rack, light bar, exhaust tips. */
const CLASS_EXTRAS = {
  hatchback: { spoiler: true, roofRack: false, lightBar: false },
  sedan: { spoiler: false, roofRack: false, lightBar: false },
  coupe: { spoiler: true, roofRack: false, lightBar: false },
  supercar: { spoiler: true, roofRack: false, lightBar: false, lowSplitter: true },
  suv: { spoiler: false, roofRack: true, lightBar: false },
  pickup: { spoiler: false, roofRack: false, lightBar: false, bed: true },
  offroad: { spoiler: false, roofRack: true, lightBar: true },
};

/** Geometry is cached per class; the mesh itself is per-vehicle. */
const geometryCache = new Map();

function bodyGeometry(config) {
  const key = `body:${config.id}`;
  if (geometryCache.has(key)) return geometryCache.get(key);

  const half = config.chassisHalfExtents;
  const profile = PROFILES[config.klass] ?? PROFILES.sedan;

  const shape = new THREE.Shape();
  profile.forEach(([px, py], index) => {
    // Map normalised profile space into the chassis' local space.
    const x = px * half.z;
    const y = -half.y + py * half.y * 2 * 0.98;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  });
  shape.closePath();

  const depth = half.x * 2 * 0.94;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.035,
    bevelSegments: 2,
    curveSegments: 4,
  });
  // ExtrudeGeometry builds along +Z; rotate so the profile's X becomes the car's
  // forward axis (Z) and the extrusion becomes the car's width (X).
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(depth / 2, 0, 0);
  geometry.computeVertexNormals();

  geometryCache.set(key, geometry);
  return geometry;
}

function wheelGeometry(config) {
  const key = `wheel:${config.id}`;
  if (geometryCache.has(key)) return geometryCache.get(key);
  const geometry = new THREE.CylinderGeometry(
    config.wheelRadius,
    config.wheelRadius,
    config.wheelWidth,
    18,
    1,
  );
  // Cylinders are Y-aligned; wheels spin about X.
  geometry.rotateZ(Math.PI / 2);
  geometryCache.set(key, geometry);
  return geometry;
}

function rimGeometry(config) {
  const key = `rim:${config.id}`;
  if (geometryCache.has(key)) return geometryCache.get(key);
  const geometry = new THREE.CylinderGeometry(
    config.wheelRadius * 0.62,
    config.wheelRadius * 0.62,
    config.wheelWidth * 1.06,
    12,
    1,
  );
  geometry.rotateZ(Math.PI / 2);
  geometryCache.set(key, geometry);
  return geometry;
}

/* Shared materials — reused across every vehicle to keep draw calls and GPU
   memory low, which matters a lot on the Potato preset. */
const SHARED = {
  glass: new THREE.MeshStandardMaterial({
    color: 0x1a2733,
    metalness: 0.1,
    roughness: 0.08,
    transparent: true,
    opacity: 0.55,
  }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.9, metalness: 0.02 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xb9c0c8, roughness: 0.28, metalness: 0.85 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.55, metalness: 0.25 }),
  headlight: new THREE.MeshStandardMaterial({
    color: 0xfff4da,
    emissive: 0xffe9b8,
    emissiveIntensity: 1.1,
    roughness: 0.2,
  }),
  taillight: new THREE.MeshStandardMaterial({
    color: 0x6b0d12,
    emissive: 0xff2222,
    emissiveIntensity: 0.35,
    roughness: 0.3,
  }),
  interior: new THREE.MeshStandardMaterial({ color: 0x25282d, roughness: 0.86 }),
  interiorTrim: new THREE.MeshStandardMaterial({
    color: 0x111317,
    roughness: 0.5,
    metalness: 0.3,
  }),
  mirror: new THREE.MeshStandardMaterial({ color: 0x8d98a3, roughness: 0.15, metalness: 0.9 }),
};

/**
 * Add a simple cabin so the cockpit camera looks out of a car rather than
 * floating inside an empty painted shell. Only the player's vehicle asks for
 * this: traffic cars keep the cheap exterior-only model.
 */
function addInterior(group, config) {
  const half = config.chassisHalfExtents;
  const eye = config.cameraPositions.cockpit;
  const interior = new THREE.Group();
  interior.name = 'interior';

  const dashboard = new THREE.Mesh(
    new THREE.BoxGeometry(half.x * 1.5, 0.16, 0.32),
    SHARED.interior,
  );
  dashboard.position.set(0, eye.y - 0.17, eye.z + 0.56);
  interior.add(dashboard);

  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.025, 8, 20), SHARED.interiorTrim);
  wheel.position.set(eye.x, eye.y - 0.18, eye.z + 0.36);
  wheel.rotation.x = -0.22;
  interior.add(wheel);

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.06, 10), SHARED.trim);
  hub.position.copy(wheel.position);
  hub.rotation.x = Math.PI / 2;
  interior.add(hub);

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.035, 0.3, 8),
    SHARED.interiorTrim,
  );
  column.position.set(eye.x, eye.y - 0.22, eye.z + 0.5);
  column.rotation.x = Math.PI / 2;
  interior.add(column);

  const console = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.5), SHARED.interior);
  console.position.set(0, eye.y - 0.34, eye.z + 0.12);
  interior.add(console);

  for (const side of [-1, 1]) {
    const seatX = side * half.x * 0.34;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.42), SHARED.interior);
    base.position.set(seatX, eye.y - 0.31, eye.z - 0.22);
    interior.add(base);

    const back = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.58, 0.11), SHARED.interior);
    back.position.set(seatX, eye.y - 0.02, eye.z - 0.48);
    back.rotation.x = -0.12;
    interior.add(back);

    const door = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.82), SHARED.interior);
    door.position.set(side * half.x * 0.82, eye.y - 0.18, eye.z - 0.02);
    interior.add(door);
  }

  const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.07, 0.04), SHARED.mirror);
  mirror.position.set(0, half.y * 0.68, eye.z + 0.7);
  interior.add(mirror);

  group.add(interior);
  group.userData.interior = interior;
}

function paintMaterial(paintId) {
  const paint = resolvePaint(paintId);
  return new THREE.MeshStandardMaterial({
    color: paint.hex,
    metalness: paint.metalness,
    roughness: paint.roughness,
  });
}

/**
 * Build a complete visual model for a vehicle definition.
 *
 * @param {object} config Normalised vehicle definition.
 * @param {string} [paintId]
 * @param {{interior?: boolean}} [options] Build the player-only cabin geometry.
 * @returns {THREE.Group} Group whose `userData` exposes wheels and light hooks.
 */
export function createVehicleModel(config, paintId = null, { interior = false } = {}) {
  const group = new THREE.Group();
  group.name = `vehicle:${config.id}`;
  group.userData.definitionId = config.id;

  const half = config.chassisHalfExtents;
  const paint = paintMaterial(paintId ?? config.paint.default);
  const extras = CLASS_EXTRAS[config.klass] ?? {};

  // --- Main body ---------------------------------------------------------
  const body = new THREE.Mesh(bodyGeometry(config), paint);
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData.paintable = true;
  group.add(body);

  // --- Cabin glazing -----------------------------------------------------
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(half.x * 1.72, half.y * 0.62, half.z * 0.86),
    SHARED.glass,
  );
  glass.position.set(0, half.y * 0.52, -half.z * 0.08);
  glass.userData.paintable = false;
  group.add(glass);

  // --- Bumpers / trim ----------------------------------------------------
  const frontBumper = new THREE.Mesh(
    new THREE.BoxGeometry(half.x * 1.86, half.y * 0.4, 0.18),
    SHARED.trim,
  );
  frontBumper.position.set(0, -half.y * 0.55, half.z * 0.97);
  group.add(frontBumper);

  const rearBumper = frontBumper.clone();
  rearBumper.position.z = -half.z * 0.97;
  group.add(rearBumper);

  // --- Headlights and brake lights --------------------------------------
  const headlights = [];
  const brakeLightMaterials = [];

  const lampGeometry = new THREE.BoxGeometry(half.x * 0.44, half.y * 0.2, 0.1);
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(lampGeometry, SHARED.headlight);
    lamp.position.set(side * half.x * 0.55, -half.y * 0.08, half.z * 0.99);
    lamp.userData.headlight = true;
    lamp.userData.paintable = false;
    headlights.push(lamp);
    group.add(lamp);

    // Each vehicle needs its own tail-light material so brake lights can be lit
    // per-vehicle without affecting other traffic cars.
    const brakeMaterial = SHARED.taillight.clone();
    const tail = new THREE.Mesh(lampGeometry, brakeMaterial);
    tail.position.set(side * half.x * 0.55, -half.y * 0.08, -half.z * 0.99);
    tail.userData.paintable = false;
    brakeLightMaterials.push(brakeMaterial);
    group.add(tail);
  }

  // --- Class-specific extras --------------------------------------------
  if (extras.spoiler) {
    const spoiler = new THREE.Mesh(
      new THREE.BoxGeometry(half.x * 1.5, 0.06, 0.34),
      paintMaterial(paintId ?? config.paint.default),
    );
    spoiler.position.set(0, half.y * 0.72, -half.z * 0.92);
    spoiler.userData.paintable = true;
    spoiler.castShadow = true;
    group.add(spoiler);
  }

  if (extras.roofRack) {
    const rack = new THREE.Mesh(
      new THREE.BoxGeometry(half.x * 1.5, 0.07, half.z * 1.1),
      SHARED.trim,
    );
    rack.position.set(0, half.y * 0.99, -half.z * 0.02);
    group.add(rack);
  }

  if (extras.lightBar) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(half.x * 1.2, 0.12, 0.12), SHARED.headlight);
    bar.position.set(0, half.y * 1.16, half.z * 0.3);
    bar.userData.headlight = true;
    group.add(bar);
    headlights.push(bar);
  }

  if (extras.bed) {
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(half.x * 1.8, half.y * 0.5, half.z * 0.75),
      SHARED.trim,
    );
    bed.position.set(0, half.y * 0.28, -half.z * 0.55);
    group.add(bed);
  }

  if (extras.lowSplitter) {
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(half.x * 1.9, 0.06, 0.5), SHARED.trim);
    splitter.position.set(0, -half.y * 0.92, half.z * 0.78);
    group.add(splitter);
  }

  if (interior) addInterior(group, config);

  // --- Wheels ------------------------------------------------------------
  const halfTrack = config.derived.halfTrack;
  const halfWheelbase = config.derived.halfWheelbase;
  const connectionY = config.suspension.restLength + config.wheelRadius - half.y - 0.1;
  const restY = connectionY - config.suspension.restLength;

  const wheels = [];
  WHEEL_LAYOUT.forEach((layout) => {
    const pivot = new THREE.Group();
    pivot.position.set(layout.x * halfTrack, restY, layout.z * halfWheelbase);
    // `restY` is where the wheel sits with the suspension at rest; the runtime
    // adds suspension compression on top of it.
    pivot.userData.restY = restY;
    pivot.userData.layout = layout.name;

    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeometry(config), SHARED.tyre);
    tyre.castShadow = true;
    spin.add(tyre);

    const rim = new THREE.Mesh(rimGeometry(config), SHARED.rim);
    spin.add(rim);

    // Debug aid: a spoke makes wheel rotation visible in screenshots.
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(config.wheelWidth * 1.1, config.wheelRadius * 1.7, 0.03),
      SHARED.trim,
    );
    spin.add(spoke);

    pivot.add(spin);
    pivot.userData.spin = spin;
    group.add(pivot);
    wheels.push(pivot);
  });

  group.userData.wheels = wheels;
  group.userData.headlights = headlights;
  group.userData.brakeLightMaterials = brakeLightMaterials;
  group.userData.bodyMesh = body;

  return group;
}

/**
 * Update brake-light emissive intensity from a braking amount (0..1).
 * Cheap enough to call every frame: it only touches two materials.
 */
export function setBrakeLights(group, amount) {
  const materials = group?.userData?.brakeLightMaterials;
  if (!Array.isArray(materials)) return;
  const intensity = 0.35 + Math.min(1, Math.max(0, amount)) * 2.4;
  for (const material of materials) material.emissiveIntensity = intensity;
}

/** Enable/disable headlight glow (the spotlights themselves are owned by Game). */
export function setHeadlightGlow(group, on) {
  const lamps = group?.userData?.headlights;
  if (!Array.isArray(lamps)) return;
  for (const lamp of lamps) {
    if (lamp.material && lamp.material.emissiveIntensity !== undefined) {
      lamp.material = on ? SHARED.headlight : SHARED.headlightOff;
    }
  }
}

/** Release all cached geometry. Used when tearing down the game. */
export function disposeVehicleGeometry() {
  for (const geometry of geometryCache.values()) geometry.dispose();
  geometryCache.clear();
}

// Dim variant used when headlights are switched off. Declared after SHARED for
// readability but attached here so both materials exist before first use.
SHARED.headlightOff = new THREE.MeshStandardMaterial({
  color: 0x8d8778,
  emissive: 0x000000,
  emissiveIntensity: 0,
  roughness: 0.3,
});

export { SHARED as VEHICLE_MATERIALS };
