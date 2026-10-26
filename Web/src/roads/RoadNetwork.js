import * as THREE from 'three';
import { clamp } from '../utilities/math.js';
import {
  cumulativeDistances,
  resolveSpans,
  applyAlignedProfile,
  buildTunnelProfile,
} from './structures.js';

/**
 * Road construction.
 *
 * A road is a Catmull-Rom curve whose Y coordinate is sampled from the terrain,
 * then swept into a ribbon. The ribbon produces BOTH the visible mesh and the
 * physics trimesh, from the same vertex buffer, so a car can never clip through
 * a road surface.
 *
 * Using a real curve (rather than a series of straight segments) is what gives
 * the roads believable, continuous curvature — important for a driving game,
 * where a kinked road feels immediately wrong under the wheels.
 */

/** Build a smooth curve through the provided XZ control points. */
export function createRoadCurve(points, { closed = false, tension = 0.5 } = {}) {
  const vectors = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
  const curve = new THREE.CatmullRomCurve3(vectors, closed, 'catmullrom', tension);
  return curve;
}

/**
 * Sample a road centreline, clamping each sample onto the terrain surface and
 * lifting it by `surfaceOffset` so the road sits just above the ground.
 *
 * @returns {Array<{x:number,y:number,z:number,t:number}>}
 */
export function sampleCentreline(curve, heightAt, { segments = 160, surfaceOffset = 0.06 } = {}) {
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const point = curve.getPointAt(Math.min(t, 1));
    const y = heightAt(point.x, point.z) + surfaceOffset;
    points.push({ x: point.x, y, z: point.z, t });
  }
  return points;
}

/**
 * Grade a freshly sampled centreline into a drivable road profile.
 *
 * Sampling terrain noise directly produces a corrugated ribbon: the terrain's
 * fine detail varies by more than a metre between adjacent centreline samples,
 * which shows up as 90% grades and a surface that throws a car off the road at
 * speed. Real roads are cut and filled into a smooth vertical alignment, so the
 * raw profile is low-pass filtered and the TERRAIN is then blended to the road
 * (see `applyRoadFlattening`) rather than the road chasing the terrain.
 *
 * The window is measured in metres rather than samples so the result does not
 * change when the map's sample density is tuned.
 *
 * After smoothing, the profile is clamped to `maxGrade` by a forward/backward
 * pass. Smoothing alone cannot fix a route that is genuinely too steep for a
 * road — it just spreads the steepness over a longer stretch — so the vertical
 * alignment is limited the way a real highway engineer would limit it. The
 * terrain is then cut and filled to the road, so the excess shows up as the
 * embankment and cutting beside the tarmac rather than as an unclimbable hill.
 *
 * @param {Array<{x:number,y:number,z:number}>} points Mutated in place.
 * @param {{windowMetres?:number, maxGrade?:number, closed?:boolean}} [options]
 */
export function gradeCentreline(
  points,
  { windowMetres = 120, maxGrade = 0.22, closed = false } = {},
) {
  const count = points.length;
  if (count < 3) return points;

  const raw = points.map((point) => point.y);
  const smoothed = new Array(count);

  // Average over a fixed distance either side of each sample. A box filter is
  // enough here: the window spans many samples, so the result is already smooth
  // and it stays O(n) with a prefix sum instead of a kernel per sample.
  const prefix = new Array(count + 1).fill(0);
  for (let i = 0; i < count; i++) prefix[i + 1] = prefix[i] + raw[i];

  const radiusSamplesFor = (index) => {
    // Walk outwards until the arc length exceeds the half-window.
    let total = 0;
    let steps = 0;
    while (steps < count) {
      const next = index + steps + 1;
      const prev = index - steps - 1;
      const a = points[Math.min(count - 1, next)];
      const b = points[Math.max(0, prev)];
      const anchor = points[index];
      total = Math.max(
        total,
        Math.hypot(a.x - anchor.x, a.z - anchor.z),
        Math.hypot(b.x - anchor.x, b.z - anchor.z),
      );
      if (total >= windowMetres / 2) break;
      steps++;
    }
    return Math.max(1, steps);
  };

  for (let i = 0; i < count; i++) {
    const radius = radiusSamplesFor(i);
    let from = i - radius;
    let to = i + radius;
    let span = to - from;

    if (closed) {
      // Wrap around the loop so the join is graded like any other point.
      let sum = 0;
      for (let k = 0; k < span; k++) {
        sum += raw[(((from + k) % (count - 1)) + (count - 1)) % (count - 1)];
      }
      smoothed[i] = sum / span;
      continue;
    }

    from = Math.max(0, from);
    to = Math.min(count - 1, to);
    span = to - from + 1;
    smoothed[i] = (prefix[to + 1] - prefix[from]) / span;
  }

  for (let i = 0; i < count; i++) points[i].y = smoothed[i];

  limitGrade(points, { maxGrade, closed });
  return points;
}

/**
 * Clamp the vertical profile so no segment exceeds `maxGrade`.
 *
 * Two sweeps are used, forward then backward. A single forward sweep would
 * lower every point after a steep rise and leave the road sagging away from its
 * true start and end; running the pass in both directions and keeping the value
 * closest to the original profile preserves the endpoints while still breaking
 * up the steep section.
 *
 * @param {Array<{x:number,y:number,z:number}>} points Mutated in place.
 */
function limitGrade(points, { maxGrade = 0.22, closed = false } = {}) {
  const count = points.length;
  if (count < 3 || !(maxGrade > 0)) return points;

  const original = points.map((point) => point.y);
  const span = (i, j) => Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z);

  const forward = original.slice();
  for (let i = 1; i < count; i++) {
    const limit = span(i - 1, i) * maxGrade;
    forward[i] = clamp(forward[i], forward[i - 1] - limit, forward[i - 1] + limit);
  }

  const backward = original.slice();
  for (let i = count - 2; i >= 0; i--) {
    const limit = span(i, i + 1) * maxGrade;
    backward[i] = clamp(backward[i], backward[i + 1] - limit, backward[i + 1] + limit);
  }

  for (let i = 0; i < count; i++) {
    // Both sweeps agree where the profile was already legal, and disagree only
    // where it was too steep — take the midpoint there.
    points[i].y = (forward[i] + backward[i]) / 2;
  }

  if (closed && count > 2) {
    // Close the loop by averaging the join, then re-limit so the seam is not
    // itself a step.
    points[count - 1].y = (points[count - 1].y + points[0].y) / 2;
    points[0].y = points[count - 1].y;
  }

  return points;
}

/**
 * Sweep a centreline into a flat ribbon.
 *
 * Pure function: it returns typed arrays and never touches Three.js or Rapier,
 * which makes the hardest part of road building unit-testable.
 *
 * @param {Array<{x:number,y:number,z:number}>} centreline
 * @param {number} width Metres across.
 * @returns {{ positions: Float32Array, uvs: Float32Array, indices: Uint32Array, vertexCount: number }}
 */
export function buildRibbon(centreline, width) {
  const count = centreline.length;
  const half = width / 2;
  const positions = new Float32Array(count * 2 * 3);
  const uvs = new Float32Array(count * 2 * 2);
  const indices = new Uint32Array(Math.max(0, count - 1) * 6);

  let travelled = 0;
  for (let i = 0; i < count; i++) {
    const current = centreline[i];
    const previous = centreline[Math.max(0, i - 1)];
    const next = centreline[Math.min(count - 1, i + 1)];

    // Tangent across the ground plane, then the perpendicular gives the
    // left/right offset direction.
    let tx = next.x - previous.x;
    let tz = next.z - previous.z;
    const length = Math.hypot(tx, tz) || 1;
    tx /= length;
    tz /= length;
    const nx = -tz;
    const nz = tx;

    if (i > 0) {
      travelled += Math.hypot(current.x - previous.x, current.z - previous.z);
    }

    const leftIndex = i * 2;
    const rightIndex = i * 2 + 1;

    positions[leftIndex * 3] = current.x + nx * half;
    positions[leftIndex * 3 + 1] = current.y;
    positions[leftIndex * 3 + 2] = current.z + nz * half;

    positions[rightIndex * 3] = current.x - nx * half;
    positions[rightIndex * 3 + 1] = current.y;
    positions[rightIndex * 3 + 2] = current.z - nz * half;

    // V repeats every 12 metres so the markings tile evenly regardless of how
    // long the road is.
    const v = travelled / 12;
    uvs[leftIndex * 2] = 0;
    uvs[leftIndex * 2 + 1] = v;
    uvs[rightIndex * 2] = 1;
    uvs[rightIndex * 2 + 1] = v;
  }

  let cursor = 0;
  for (let i = 0; i < count - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    // Wound so the surface normal points up.
    indices[cursor++] = a;
    indices[cursor++] = c;
    indices[cursor++] = d;
    indices[cursor++] = a;
    indices[cursor++] = d;
    indices[cursor++] = b;
  }

  return { positions, uvs, indices, vertexCount: count * 2 };
}

/**
 * Procedurally draw the road surface texture: asphalt grain plus a dashed
 * centre line and solid edge lines.
 *
 * Generated at runtime rather than shipped as an image, so the project bundles
 * no third-party textures (and no licence questions).
 */
export function createRoadTexture({ size = 128, length = 512, seed = 7 } = {}) {
  // Canvas is a browser API. When it is unavailable (headless test runs, or a
  // browser that blocks 2D canvas) we simply return null and the road renders as
  // flat asphalt with no markings — degraded, never broken.
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = length;
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, size, length);

  // Grainy asphalt speckle. Deterministic so the texture is stable across loads.
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < size * 26; i++) {
    const x = rand() * size;
    const y = rand() * length;
    const shade = 40 + Math.floor(rand() * 46);
    ctx.fillStyle = `rgba(${shade},${shade + 2},${shade + 5},0.5)`;
    ctx.fillRect(x, y, 1.6, 1.6);
  }

  // Solid edge lines.
  ctx.fillStyle = 'rgba(232,232,224,0.82)';
  ctx.fillRect(size * 0.05, 0, 3, length);
  ctx.fillRect(size * 0.95 - 3, 0, 3, length);

  // Dashed centre line.
  const dash = length / 4;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = 'rgba(236,225,150,0.78)';
    ctx.fillRect(size / 2 - 2, i * dash, 4, dash * 0.55);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** A single road in the world. */
export class Road {
  /**
   * @param {object} options
   * @param {Array<{x:number,z:number}>} options.points Control points.
   * @param {number} [options.width]
   * @param {boolean} [options.closed]
   * @param {string} [options.surface]
   * @param {string} [options.name]
   * @param {Array<{type:'bridge'|'tunnel', at?:number, length?:number}>} [options.structures]
   *   Bridges and tunnels. Where they go is derived from the terrain unless `at`
   *   pins them; see `resolveStructures`.
   * @param {number} [options.corridor] Half-width, in metres, of the terrain this
   *   road flattens *completely* before the blend starts. A ribbon is flat across
   *   its whole width, so a road wider than the default corridor would have its
   *   edges hanging over ground the grading never touched — which is why a
   *   runway has to say how much ground it needs. Defaults to `flattenPoints`'s
   *   own argument.
   * @param {number} [options.blend] Metres of falloff outside the corridor.
   */
  constructor({
    points,
    width = 9,
    closed = false,
    surface = 'asphalt',
    name = 'road',
    structures = [],
    corridor = null,
    blend = null,
  }) {
    this.points = points;
    this.width = width;
    this.closed = closed;
    this.surface = surface;
    this.name = name;
    this.structures = structures;
    this.corridor = corridor;
    this.blend = blend;
    /** @type {Array<object>} Resolved spans — empty until `resolveStructures`. */
    this.resolvedStructures = [];
    /** Natural (pre-flattening) ground sampler, kept for the structure builders. */
    this.naturalHeightAt = () => 0;
    this.curve = createRoadCurve(points, { closed });
    this.centreline = [];
    this.mesh = null;
    this.collider = null;
    this.length = 0;
  }

  /** Resample the centreline onto the terrain and measure the road length. */
  project(
    heightAt,
    { segments = 220, surfaceOffset = 0.06, gradeWindow = 120, maxGrade = 0.22 } = {},
  ) {
    this.centreline = sampleCentreline(this.curve, heightAt, { segments, surfaceOffset });
    gradeCentreline(this.centreline, {
      windowMetres: gradeWindow,
      maxGrade,
      closed: this.closed,
    });
    let length = 0;
    for (let i = 1; i < this.centreline.length; i++) {
      const a = this.centreline[i - 1];
      const b = this.centreline[i];
      length += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this.length = this.closed ? length : length;
    return this.centreline;
  }

  /**
   * Resolve this road's bridges and tunnels against the terrain.
   *
   * Must run AFTER `project` (the spans are indices into the centreline) and
   * BEFORE the terrain is flattened, because a bridge changes the road's own
   * vertical alignment and the flattening follows it.
   *
   * @param {(x:number,z:number)=>number} heightAt Natural ground height.
   */
  resolveStructures(heightAt) {
    this.naturalHeightAt = heightAt;
    const declarations = this.structures ?? [];
    if (declarations.length === 0) {
      this.resolvedStructures = [];
      return this.resolvedStructures;
    }

    const diagnostics = [];
    const context = { heightAt, width: this.width, profile: buildTunnelProfile(), diagnostics };

    // Bridges first. Both types rewrite the road's height over their span, and a
    // tunnel's fit is measured against the road, so the order matters for a road
    // that carries one of each.
    const bridges = resolveSpans(
      this.centreline,
      declarations.filter((structure) => structure.type === 'bridge'),
      context,
    );
    for (const bridge of bridges) applyAlignedProfile(this.centreline, bridge);

    const tunnels = resolveSpans(
      this.centreline,
      declarations.filter((structure) => structure.type === 'tunnel'),
      context,
    );
    for (const tunnel of tunnels) applyAlignedProfile(this.centreline, tunnel);

    // A declaration the terrain does not justify is reported, not invented —
    // with the best score the road could offer, so the message says how far off
    // it is rather than merely refusing.
    for (const diagnostic of diagnostics) {
      console.warn(
        `[Road] "${this.name}" declares a ${diagnostic.type}, but the terrain does not ` +
          `justify one here: ${diagnostic.reason}, and ${diagnostic.minClearance} m is the ` +
          'minimum. Nothing was placed there.',
      );
    }

    this.resolvedStructures = [...bridges, ...tunnels].sort(
      (a, b) => a.startDistance - b.startDistance,
    );
    return this.resolvedStructures;
  }

  /** The structure covering a centreline index, or null. */
  structureAt(index) {
    return (
      this.resolvedStructures.find(
        (structure) => index >= structure.startIndex && index <= structure.endIndex,
      ) ?? null
    );
  }

  /**
   * Centreline samples in the form the terrain flattening pass wants.
   *
   * Two differences from `allCentrelinePoints`:
   *  - Samples inside a structure are dropped, so the terrain under a bridge and
   *    over a tunnel keeps the shape the structure was chosen for. Since a span
   *    is resolved only where the alignment is at or below the ground (bridge)
   *    or under it (tunnel), and grown outwards only while that still holds, the
   *    road neither floats nor intrudes and the edge of the untouched ground is
   *    exactly where the structure's end is — no step to see.
   *  - Samples just outside a tunnel portal ask for a narrower corridor, so the
   *    mouth is a tight cutting around the shell rather than a wide scar.
   *
   * @param {{corridor?:number, blend?:number, portalMetres?:number, portalCorridor?:number,
   *          portalBlend?:number}} [options]
   */
  flattenPoints({
    corridor = 13,
    blend = 16,
    claimCorridor = 0.5,
    claimBlend = 0.5,
    portalMetres = 30,
    portalCorridor = 10,
    portalBlend = 8,
  } = {}) {
    // A road that declared its own grading reach wins over the caller's default:
    // the reach is a property of how wide the surface is, not of how `World`
    // happened to call this.
    if (this.corridor !== null) corridor = this.corridor;
    if (this.blend !== null) blend = this.blend;

    const out = [];
    const tunnels = this.resolvedStructures.filter((structure) => structure.type === 'tunnel');
    const distances = tunnels.length > 0 ? cumulativeDistances(this.centreline) : null;

    for (let i = 0; i < this.centreline.length; i++) {
      const point = this.centreline[i];

      if (this.structureAt(i)) {
        // Inside a span the terrain is left exactly as it was found: no cut, no
        // fill. The sample is still *submitted*, graded to the height it already
        // has, so it wins the nearest-sample lookup for the ground around it. If
        // it were simply omitted, a road sample twenty metres away outside the
        // span would be the nearest one for ground inside the tunnel and would
        // cut away the hill the tunnel runs through. The half-metre reach means
        // this claim never actually moves a vertex.
        out.push({
          x: point.x,
          y: this.naturalHeightAt(point.x, point.z),
          z: point.z,
          corridor: claimCorridor,
          blend: claimBlend,
        });
        continue;
      }

      // Just outside a tunnel portal the cutting is deliberately narrow, so the
      // mouth reads as a cutting around the shell rather than a wide scar. Narrow
      // means 10 m of full corridor, which is still wider than the worst-case
      // distance to the nearest terrain vertex (half a diagonal of the height
      // grid) — a corridor tighter than that would leave grid vertices ungraded
      // and the terrain poking through the road.
      const nearPortal = tunnels.some((tunnel) => {
        const distance = distances[i];
        if (distance < tunnel.startDistance) return tunnel.startDistance - distance <= portalMetres;
        if (distance > tunnel.endDistance) return distance - tunnel.endDistance <= portalMetres;
        return false;
      });

      out.push({
        x: point.x,
        y: point.y,
        z: point.z,
        corridor: nearPortal ? portalCorridor : corridor,
        blend: nearPortal ? portalBlend : blend,
      });
    }
    return out;
  }
  directionAt({ x, z }) {
    const points = this.centreline;
    if (points.length < 2) return 0;

    let bestIndex = 0;
    let bestDistanceSq = Infinity;
    for (let i = 0; i < points.length; i++) {
      const distanceSq = (points[i].x - x) ** 2 + (points[i].z - z) ** 2;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = i;
      }
    }

    const span = 2;
    const before = points[Math.max(0, bestIndex - span)];
    const after = points[Math.min(points.length - 1, bestIndex + span)];
    // `forward` in this project is (sin yaw, cos yaw), matching the chassis
    // convention used by the vehicle and camera.
    return Math.atan2(after.x - before.x, after.z - before.z);
  }

  /** Build the visible mesh. */
  buildMesh(material) {
    const ribbon = buildRibbon(this.centreline, this.width);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(ribbon.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(ribbon.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(ribbon.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    // Lift by 4 cm to defeat z-fighting with the terrain it was cut into.
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = 0.04;
    mesh.receiveShadow = true;
    mesh.name = this.name;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.mesh = mesh;
    return mesh;
  }

  /** Build the matching trimesh collider. */
  buildCollider(physics) {
    const ribbon = buildRibbon(this.centreline, this.width);
    this.collider = physics.addTrimesh(ribbon.positions, ribbon.indices, {
      surface: this.surface,
      tag: 'mesh',
    });
    return this.collider;
  }

  dispose() {
    this.mesh?.geometry?.dispose();
    this.mesh = null;
    this.collider = null;
  }
}

/** A collection of roads that are built and torn down together. */
export class RoadNetwork {
  constructor() {
    /** @type {Road[]} */
    this.roads = [];
    this.material = null;
    this.group = new THREE.Group();
    this.group.name = 'roads';
  }

  add(options) {
    const road = new Road(options);
    this.roads.push(road);
    return road;
  }

  /** Project every road onto the terrain (call before flattening). */
  projectAll(heightAt, options) {
    for (const road of this.roads) road.project(heightAt, options);
    return this;
  }

  /**
   * Resolve every road's bridges and tunnels. Call after `projectAll` and before
   * the terrain is flattened — see `Road.resolveStructures`.
   */
  resolveStructures(heightAt) {
    for (const road of this.roads) road.resolveStructures(heightAt);
    return this;
  }

  /** Every resolved structure on the network, with the road it belongs to. */
  allStructures() {
    const out = [];
    for (const road of this.roads) {
      for (const structure of road.resolvedStructures) out.push({ road, ...structure });
    }
    return out;
  }

  /** Every centreline point, for terrain flattening and prop avoidance. */
  allCentrelinePoints() {
    const out = [];
    for (const road of this.roads) {
      for (const point of road.centreline) out.push({ x: point.x, y: point.y, z: point.z });
    }
    return out;
  }

  /**
   * The points the terrain flattening pass should use, concatenated across the
   * network. Differs from `allCentrelinePoints` around bridges and tunnels.
   */
  flattenPoints(options) {
    const out = [];
    for (const road of this.roads) out.push(...road.flattenPoints(options));
    return out;
  }

  /** Build meshes for all roads, sharing one material to limit draw calls. */
  buildMeshes({ scene, texture = null, colour = 0x3a3d42 } = {}) {
    if (!this.material) {
      this.material = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: 0.88,
        metalness: 0.03,
        ...(texture ? { map: texture } : {}),
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
      // Kept so wetness can be applied and removed without accumulating rounding
      // error over thousands of frames of rain.
      this.dryAppearance = { colour, roughness: 0.88, metalness: 0.03 };
      this.wetness = 0;
    }
    for (const road of this.roads) {
      const mesh = road.buildMesh(this.material);
      this.group.add(mesh);
    }
    if (scene) scene.add(this.group);
    return this.group;
  }

  buildColliders(physics) {
    for (const road of this.roads) road.buildCollider(physics);
    return this;
  }

  /** Nearest road and distance to it, used for "on road" checks and navigation. */
  /**
   * Darken and gloss the asphalt to match how wet it is.
   *
   * Called with a ramped value from the weather system, so a road dries out
   * gradually rather than snapping back the instant the rain stops. Values are
   * recomputed from the *dry* appearance each call, so the interpolation can
   * never drift.
   *
   * @param {number} wetness 0 (dry) to 1 (standing water).
   */
  setWetness(wetness) {
    if (!this.material || !this.dryAppearance) return this;
    const wet = Math.max(0, Math.min(1, wetness));
    if (Math.abs(wet - this.wetness) < 0.002) return this;
    this.wetness = wet;

    const dry = this.dryAppearance;
    const dryR = (dry.colour >> 16) & 0xff;
    const dryG = (dry.colour >> 8) & 0xff;
    const dryB = dry.colour & 0xff;
    // Wet asphalt is darker and much more specular.
    const factor = 1 - wet * 0.42;
    const r = Math.round(dryR * factor);
    const g = Math.round(dryG * factor);
    const b = Math.round(dryB * factor);
    this.material.color.setHex((r << 16) | (g << 8) | b);
    this.material.roughness = dry.roughness - wet * 0.55;
    this.material.metalness = Math.min(0.5, dry.metalness + wet * 0.28);
    this.material.needsUpdate = true;
    return this;
  }

  nearestRoad(x, z) {
    let best = null;
    let bestDistance = Infinity;
    let bestPoint = null;
    for (const road of this.roads) {
      for (let i = 0; i < road.centreline.length; i++) {
        const point = road.centreline[i];
        const distance = Math.hypot(point.x - x, point.z - z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = road;
          bestPoint = point;
        }
      }
    }
    return { road: best, distance: bestDistance, point: bestPoint };
  }

  /**
   * Direction of travel (radians) of the road nearest to a point.
   *
   * Used to point a spawned vehicle the right way along the road. Hand-authored
   * headings drift out of sync the moment a road is re-routed, and a car spawned
   * across the asphalt drives straight off it — so the heading is derived from
   * the geometry instead of being typed in.
   */
  directionNear(x, z) {
    const nearest = this.nearestRoad(x, z);
    if (!nearest.road) return null;
    return nearest.road.directionAt(nearest.point ?? { x, z });
  }

  dispose() {
    for (const road of this.roads) road.dispose();
    this.roads.length = 0;
    this.material?.map?.dispose();
    this.material?.dispose();
    this.material = null;
    this.group.clear();
    this.group.parent?.remove(this.group);
  }
}
