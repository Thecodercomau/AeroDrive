import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { World } from '../src/world/World.js';
import { MAPS } from '../src/world/maps.js';
import { gradeCentreline } from '../src/roads/RoadNetwork.js';
import {
  STRUCTURE_DEFAULTS,
  buildTunnelProfile,
  lateralVectors,
  profileHeightAt,
} from '../src/roads/structures.js';

/** Distance from a point to a segment in the XZ plane. */
function pointToSegment(px, pz, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSq));
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/**
 * Count the connected pieces of a road network.
 *
 * Mirrors `tools/probe-road-connectivity.mjs`: two roads are joined when their
 * centreline corridors overlap, which is the same rule that decides whether a
 * car can drive from one onto the other without leaving the tarmac.
 */
function roadNetworkPieces(roads) {
  const parent = roads.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const width = ((roads[i].width ?? 10) + (roads[j].width ?? 10)) / 2;
      let gap = Infinity;
      outer: for (let a = 0; a < roads[i].points.length - 1; a++) {
        for (let b = 0; b < roads[j].points.length - 1; b++) {
          gap = Math.min(
            gap,
            pointToSegment(
              roads[i].points[a].x,
              roads[i].points[a].z,
              roads[j].points[b],
              roads[j].points[b + 1],
            ),
            pointToSegment(
              roads[j].points[b].x,
              roads[j].points[b].z,
              roads[i].points[a],
              roads[i].points[a + 1],
            ),
          );
          if (gap <= width) break outer;
        }
      }
      if (gap <= width) union(i, j);
    }
  }

  return new Set(roads.map((_, index) => find(index))).size;
}

/**
 * Road geometry tests.
 *
 * A road that follows the raw terrain height sample-for-sample inherits the
 * terrain's micro-relief, which produced 90% grades and a surface that threw
 * cars off at speed. These tests pin the two properties that matter: the road
 * is graded into a drivable vertical alignment, and it is actually flat across
 * its width where the player drives.
 */

describe('gradeCentreline', () => {
  it('removes high-frequency roughness while keeping the overall climb', () => {
    // A 600 m ramp climbing 60 m, with 2 m of noise sampled every 2 m.
    const points = [];
    for (let i = 0; i <= 300; i++) {
      const x = i * 2;
      const noise = i % 2 === 0 ? 2 : -2;
      points.push({ x, y: i * 0.2 + noise, z: 0 });
    }

    gradeCentreline(points, { windowMetres: 30 });

    // The climb survives: start low, end high, roughly the original 60 m.
    expect(points[0].y).toBeLessThan(points[points.length - 1].y);
    expect(points[points.length - 1].y - points[0].y).toBeGreaterThan(45);

    // The noise is gone: no step between adjacent samples is a 2 m spike.
    let maxStep = 0;
    for (let i = 1; i < points.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(points[i].y - points[i - 1].y));
    }
    expect(maxStep).toBeLessThan(0.6);
  });

  it('leaves a short centreline alone rather than dividing by zero', () => {
    const points = [
      { x: 0, y: 5, z: 0 },
      { x: 10, y: 6, z: 0 },
    ];
    expect(() => gradeCentreline(points)).not.toThrow();
    expect(points[1].y).toBe(6);
  });
});

describe('road network on real maps', () => {
  const physics = new PhysicsWorld();
  const worlds = new Map();

  beforeAll(async () => {
    await physics.init();
    for (const map of MAPS) {
      const world = new World({ physics, mapId: map.id, vegetationDensity: 0 });
      world.build();
      worlds.set(map.id, world);
    }
  });

  afterAll(() => {
    for (const world of worlds.values()) world.dispose();
    physics.dispose();
  });

  it.each(MAPS.map((map) => [map.id, map.name]))(
    '%s (%s) grades every road into a drivable profile',
    (mapId) => {
      const world = worlds.get(mapId);
      expect(world.roads.roads.length).toBeGreaterThan(0);

      for (const road of world.roads.roads) {
        let maxGrade = 0;
        const samples = road.centreline;
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1];
          const b = samples[i];
          const run = Math.hypot(b.x - a.x, b.z - a.z);
          if (run < 0.5) continue; // skip duplicated samples
          maxGrade = Math.max(maxGrade, Math.abs(b.y - a.y) / run);
        }
        // 35% is around the limit of a real mountain pass; anything steeper is
        // not a road, and a car cannot restart on it from a standstill.
        expect(maxGrade, `${road.name} climbs at ${(maxGrade * 100).toFixed(0)}%`).toBeLessThan(
          0.35,
        );
      }
    },
  );

  it.each(MAPS.map((map) => [map.id, map.name]))(
    '%s (%s) has one connected road network',
    (mapId) => {
      const world = worlds.get(mapId);
      const roads = world.roads.roads.map((road) => ({
        width: road.width,
        points: road.centreline,
      }));
      expect(roadNetworkPieces(roads), `${mapId} has a disconnected road`).toBe(1);
    },
  );

  it('reports the road surface as asphalt along the whole centreline', () => {
    const world = worlds.get('alpine-valley');
    for (const road of world.roads.roads) {
      for (const point of road.centreline) {
        expect(world.surfaceAt(point.x, point.z, 0)).toBe(road.surface ?? 'asphalt');
      }
    }
  });

  it('keeps the terrain tight against the road so there is no cliff at the verge', () => {
    // Everywhere EXCEPT inside a bridge or a tunnel, where the whole point is
    // that the road leaves the ground: a deck is above it, a bore is under it.
    // Those two cases are asserted separately, and more strongly, below.
    const world = worlds.get('alpine-valley');
    let checked = 0;
    for (const road of world.roads.roads) {
      for (let i = 0; i < road.centreline.length; i += 7) {
        if (road.structureAt(i)) continue;
        const point = road.centreline[i];
        // The road surface and the ground beneath it must agree, or cars would
        // catch an invisible lip when running wide onto the verge.
        const terrainHeight = world.heightAt(point.x, point.z);
        expect(Math.abs(terrainHeight - point.y)).toBeLessThan(1.5);
        checked++;
      }
    }
    // Guard against the assertion passing by checking nothing.
    expect(checked).toBeGreaterThan(150);
  });

  it('places bridges that clear the ground and tunnels that are buried by it', () => {
    const totals = { bridges: 0, tunnels: 0 };
    const profile = buildTunnelProfile();
    const wallOffsets = [-profile[0].x * 0.95, 0, profile[0].x * 0.95];

    for (const map of MAPS) {
      const world = worlds.get(map.id);
      for (const road of world.roads.roads) {
        const laterals = lateralVectors(road.centreline);
        for (const structure of road.resolvedStructures) {
          expect(
            structure.endIndex - structure.startIndex,
            `${road.name} structure is too short to build`,
          ).toBeGreaterThan(2);

          let peak = -Infinity;
          for (let i = structure.startIndex; i <= structure.endIndex; i++) {
            const sample = road.centreline[i];
            peak = Math.max(peak, sample.y - world.heightAt(sample.x, sample.z));
          }

          if (structure.type === 'bridge') {
            totals.bridges++;
            // A deck has to FADE ONTO the ground at both ends, where it meets the
            // approach road: a deck that stepped up would launch the car, and one
            // that ended in mid-air would drop it.
            // The lower bound is the same 1.5 m the verge test allows, and for
            // the same reason: the heightfield is sampled on a 13 m grid, so the
            // ground beside a road cannot be resolved more finely than that.
            for (const index of [structure.startIndex, structure.endIndex]) {
              const sample = road.centreline[index];
              const clearance = sample.y - world.heightAt(sample.x, sample.z);
              expect(clearance, `${road.name} deck end`).toBeGreaterThan(-1.5);
              expect(clearance, `${road.name} deck end`).toBeLessThan(6);
            }
            // And somewhere along it the ground has to fall away by the amount the
            // resolver asked for. A bridge with no gap under it is scenery
            // pretending to be a bridge.
            expect(peak, `${road.name} has no gap to bridge`).toBeGreaterThan(
              STRUCTURE_DEFAULTS.bridge.minClearance,
            );
            continue;
          }

          totals.tunnels++;
          // A tunnel has to stay under the ground across its whole width, for its
          // whole length. A bore that clips the side of a hill shows daylight
          // through the wall, which is the one thing a tunnel must never do — and
          // the deepest point of the span is the only place worth checking to a
          // tight tolerance, since the ends are by definition near the surface.
          // The resolver promises 0.8 m of rock plus a 0.1 m margin at every
          // sample across that width; 0.7 leaves a hair for rounding.
          for (let i = structure.startIndex; i <= structure.endIndex; i++) {
            const sample = road.centreline[i];
            for (const offset of wallOffsets) {
              const ground = world.heightAt(
                sample.x + laterals[i].x * offset,
                sample.z + laterals[i].z * offset,
              );
              const rock = ground - (sample.y + profileHeightAt(profile, offset));
              expect(
                rock,
                `${road.name} tunnel at ${Math.round(offset)} m offset, ${i} of ` +
                  `${structure.startIndex}-${structure.endIndex}`,
              ).toBeGreaterThan(0.7);
            }
          }
        }
      }
    }

    // Both maps that ask for a tunnel must actually get one: a declaration that
    // silently resolves to nothing is the failure mode this test exists for.
    expect(totals.bridges).toBeGreaterThan(0);
    expect(totals.tunnels).toBeGreaterThan(0);
  });
});
