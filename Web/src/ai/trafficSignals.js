/**
 * Intersection detection and traffic-signal timing.
 *
 * Deliberately free of THREE and of physics: giving a road a signal phase is
 * arithmetic, and it is the part most likely to be subtly wrong (a car that
 * waits at a permanently red light is a bug players will notice immediately).
 * Keeping it pure means the *timing* is unit-tested even though the lamps are
 * only ever drawn in a browser.
 *
 * ## How intersections are found
 *
 * Not from any hand-authored data — from the built road network. Two roads
 * intersect where their centrelines pass within `radius` of each other. That
 * means the signals appear on any map that happens to have crossing roads, and
 * they follow a road automatically when it is re-routed. A 160 m city grid
 * produces 25 crossings from one function, with no coordinates typed in twice.
 *
 * ## How the phase is decided
 *
 * Each intersection alternates between its two roads, half a cycle each, with an
 * amber window before every change. The offset is derived from the
 * intersection's own position, so neighbouring junctions are not all green at
 * once — which is both more realistic and the thing that makes a green wave
 * possible at all.
 */

/** Fraction of a road's own length that must run along an axis to call it that. */
const AXIS_DOMINANCE = 1.4;

/**
 * Group a road's centreline into `{ name, points, axis }`.
 * @param {Array<{name:string, width?:number, points:Array<{x:number,z:number}>}>} roads
 */
export function describeRoads(roads = []) {
  return roads.map((road) => ({
    ...road,
    axis: roadAxis(road.points),
    bounds: pointsBounds(road.points),
  }));
}

/** Axis-aligned bounds of a point list, used to prune non-overlapping road pairs. */
function pointsBounds(points = []) {
  if (points.length === 0) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * The axis a road runs along: `'x'` (east–west) or `'z'` (north–south).
 * Ties are broken toward `'x'` so the result is always deterministic.
 */
export function roadAxis(points = []) {
  if (points.length < 2) return 'x';
  let dx = 0;
  let dz = 0;
  for (let i = 1; i < points.length; i++) {
    dx += Math.abs(points[i].x - points[i - 1].x);
    dz += Math.abs(points[i].z - points[i - 1].z);
  }
  return dx >= dz * AXIS_DOMINANCE ? 'x' : dz >= dx * AXIS_DOMINANCE ? 'z' : dx >= dz ? 'x' : 'z';
}

/**
 * Every place two roads cross.
 *
 * @param {Array<{name:string, points:Array}>} roads
 * @param {object} [options]
 * @param {number} [options.radius] How close two centrelines must pass.
 * @param {number} [options.stride] Sample every nth point (detection only).
 * @returns {Array<{x:number,z:number,a:object,b:object}>} `a` and `b` are the
 *   two road descriptors from `describeRoads()`.
 */
export function findIntersections(roads, { radius = 16, stride = 2 } = {}) {
  const described = describeRoads(roads);
  const found = [];
  const seen = new Set();

  for (let i = 0; i < described.length; i++) {
    for (let j = i + 1; j < described.length; j++) {
      const a = described[i];
      const b = described[j];
      // Two roads running the same way can run parallel and close without ever
      // crossing; only perpendicular pairs can form a junction.
      if (a.axis === b.axis) continue;
      // Cheap prune: two roads whose bounding boxes do not come within `radius`
      // of each other cannot cross, and this skips the O(n*m) scan entirely for
      // the majority of pairs on a large map.
      if (!boundsWithin(a.bounds, b.bounds, radius)) continue;

      for (let ai = 0; ai + stride < a.points.length; ai += stride) {
        const a0 = a.points[ai];
        const a1 = a.points[ai + stride];
        for (let bi = 0; bi + stride < b.points.length; bi += stride) {
          const b0 = b.points[bi];
          const b1 = b.points[bi + stride];
          const hit = segmentCrossing(a0, a1, b0, b1);
          if (!hit) continue;
          // One junction per 30 m cell: two roads that run alongside each other
          // for a stretch would otherwise report a whole row of crossings.
          const key = `${Math.round(hit.x / 30)},${Math.round(hit.z / 30)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ x: hit.x, z: hit.z, a, b });
        }
      }
    }
  }
  return found;
}

/**
 * Where two 2D segments cross, or null when they do not.
 *
 * Used instead of "the closest pair of sampled points" because that approach
 * places a junction up to half a sampling interval away from the real crossing —
 * metres off on a city grid, which is the difference between a traffic light on
 * the kerb and one in the middle of the road.
 *
 * @param {{x:number,z:number}} p1 Start of the first segment.
 * @param {{x:number,z:number}} p2 End of the first segment.
 * @param {{x:number,z:number}} p3 Start of the second segment.
 * @param {{x:number,z:number}} p4 End of the second segment.
 * @returns {{x:number,z:number}|null}
 */
export function segmentCrossing(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1z = p2.z - p1.z;
  const d2x = p4.x - p3.x;
  const d2z = p4.z - p3.z;
  const denominator = d1x * d2z - d1z * d2x;
  // Parallel (or degenerate) segments never form a junction.
  if (Math.abs(denominator) < 1e-9) return null;
  const ox = p3.x - p1.x;
  const oz = p3.z - p1.z;
  const t = (ox * d2z - oz * d2x) / denominator;
  const u = (ox * d1z - oz * d1x) / denominator;
  // Both parameters must land inside their own segment.
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + d1x * t, z: p1.z + d1z * t };
}

/** Do two axis-aligned boxes come within `margin` of each other? */
function boundsWithin(a, b, margin) {
  return (
    a.minX - margin <= b.maxX &&
    a.maxX + margin >= b.minX &&
    a.minZ - margin <= b.maxZ &&
    a.maxZ + margin >= b.minZ
  );
}

/** Default signal timings, in seconds. */
export const SIGNAL_DEFAULTS = { cycle: 20, amber: 2.6, stopDistance: 26 };

/**
 * Signal timing for a set of intersections.
 */
export class TrafficSignalController {
  /**
   * @param {object} options
   * @param {Array<{name:string, points:Array}>} options.roads
   * @param {number} [options.cycle] Seconds for a full A-green → B-green cycle.
   * @param {number} [options.amber] Seconds of amber before each change.
   * @param {number} [options.stopDistance] How far ahead a car looks for a signal.
   * @param {number} [options.radius]
   */
  constructor({ roads, cycle, amber, stopDistance, radius } = {}) {
    this.cycle = cycle ?? SIGNAL_DEFAULTS.cycle;
    this.amber = Math.min(amber ?? SIGNAL_DEFAULTS.amber, this.cycle / 2 - 0.5);
    this.stopDistance = stopDistance ?? SIGNAL_DEFAULTS.stopDistance;
    this.intersections = findIntersections(roads ?? [], radius ? { radius } : {});
    /** @type {Map<string, Array<{index:number, intersection:object, group:'a'|'b'}>>} */
    this._byRoad = new Map();
    this.intersections.forEach((intersection, index) => {
      for (const group of ['a', 'b']) {
        const road = intersection[group];
        let list = this._byRoad.get(road.name);
        if (!list) {
          list = [];
          this._byRoad.set(road.name, list);
        }
        list.push({ index, intersection, group });
      }
    });
  }

  get count() {
    return this.intersections.length;
  }

  /** Offset by position so adjacent junctions are out of phase. */
  _offset(intersection) {
    // A cheap spatial hash: same junction, same phase, every run.
    const hash = Math.abs(Math.round(intersection.x * 0.37 + intersection.z * 0.71));
    return ((hash % 7) / 7) * this.cycle;
  }

  /**
   * Which road group has green at a moment in time.
   *
   * @param {number} index Intersection index.
   * @param {number} time Seconds; may be any growing value.
   * @returns {{green:'a'|'b', amber:boolean, timeToChange:number}}
   */
  stateAt(index, time) {
    const intersection = this.intersections[index];
    if (!intersection) return { green: 'a', amber: false, timeToChange: Infinity };
    const half = this.cycle / 2;
    const phase = (((time + this._offset(intersection)) % this.cycle) + this.cycle) % this.cycle;
    const inFirstHalf = phase < half;
    const withinHalf = inFirstHalf ? phase : phase - half;
    const amber = withinHalf >= half - this.amber;
    return {
      green: inFirstHalf ? 'a' : 'b',
      amber,
      // While amber, the *next* group is about to get green, so the countdown
      // belongs to the group that is still (just) green.
      timeToChange: half - withinHalf,
    };
  }

  /**
   * Should a car on `roadName` just past (x, z) hold at a red light?
   *
   * @param {string} roadName
   * @param {{x:number,z:number}} position
   * @param {{x:number,z:number}} forward Unit heading vector.
   * @param {number} time
   * @returns {{stop:boolean, distance:number, index:number}}
   */
  signalAhead(roadName, position, forward, time) {
    const candidates = this._byRoad.get(roadName);
    if (!candidates || candidates.length === 0) {
      return { stop: false, distance: Infinity, index: -1 };
    }

    let nearest = null;
    let nearestDistance = this.stopDistance;
    for (const entry of candidates) {
      const dx = entry.intersection.x - position.x;
      const dz = entry.intersection.z - position.z;
      // Behind us? Then it is not a signal we are approaching.
      if (dx * forward.x + dz * forward.z <= 0) continue;
      const distance = Math.hypot(dx, dz);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = entry;
      }
    }
    if (!nearest) return { stop: false, distance: Infinity, index: -1 };

    const state = this.stateAt(nearest.index, time);
    const isGreen = state.green === nearest.group;
    // Amber means "stop unless you are already in the junction".
    if (isGreen && state.amber) {
      const stop = nearestDistance > 12;
      return { stop, distance: nearestDistance, index: nearest.index };
    }
    return { stop: !isGreen, distance: nearestDistance, index: nearest.index };
  }
}
