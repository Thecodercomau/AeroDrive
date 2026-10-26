import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import {
  applyRoadFlattening,
  createHeightSampler,
  gridIndex,
  gridX,
  gridZ,
  heightAtGrid,
  sampleHeightfield,
  slopeAtGrid,
} from '../src/terrain/heightfield.js';

/**
 * Terrain tests.
 *
 * The most important one here is the grid-layout assertion: the visual mesh and
 * the Rapier collider are both derived from the same Float32Array, and if the
 * row/column convention ever diverged the car would appear to drive through a
 * hill. This test catches that by ray-casting against a real Rapier heightfield
 * and comparing to the sampler's own answer.
 */

describe('terrain heightfield', () => {
  /** @type {PhysicsWorld} */
  let physics;

  beforeAll(async () => {
    physics = new PhysicsWorld();
    await physics.init();
  });

  afterAll(() => {
    physics.dispose();
  });

  it("uses a grid layout that matches Rapier's heightfield convention", async () => {
    const world = new PhysicsWorld();
    await world.init();

    const resolution = 16;
    const size = 160;
    const heights = new Float32Array((resolution + 1) ** 2);

    // A deliberately asymmetric linear ramp: different slopes in X and Z means
    // a transposed grid fails immediately rather than passing by luck.
    for (let ix = 0; ix <= resolution; ix++) {
      for (let iz = 0; iz <= resolution; iz++) {
        const x = gridX(ix, resolution, size);
        const z = gridZ(iz, resolution, size);
        heights[gridIndex(ix, iz, resolution)] = x * 0.05 + z * 0.01;
      }
    }

    world.addHeightfield(
      resolution,
      resolution,
      heights,
      { x: size, y: 1, z: size },
      {
        tag: 'terrain',
      },
    );
    // Rapier only refreshes its query pipeline inside step(); without this the
    // raycast below would legitimately hit nothing.
    world.syncQueries();

    const field = { heights, resolution, size };
    const probes = [
      { x: 0, z: 0 },
      { x: 32, z: -24 },
      { x: -48, z: 56 },
      { x: 61, z: 12 },
    ];

    for (const probe of probes) {
      const hit = world.raycast({ x: probe.x, y: 200, z: probe.z }, { x: 0, y: -1, z: 0 }, 400);
      expect(hit, `no terrain hit at (${probe.x}, ${probe.z})`).not.toBeNull();
      const expected = heightAtGrid(field, probe.x, probe.z);
      expect(hit.point.y).toBeCloseTo(expected, 1);
    }

    world.dispose();
  });

  it('produces identical terrain for the same seed and different terrain for another', () => {
    const a = sampleHeightfield(createHeightSampler('alpine', 'seed-a'), {
      size: 600,
      resolution: 32,
    });
    const b = sampleHeightfield(createHeightSampler('alpine', 'seed-a'), {
      size: 600,
      resolution: 32,
    });
    const c = sampleHeightfield(createHeightSampler('alpine', 'seed-b'), {
      size: 600,
      resolution: 32,
    });

    expect(Array.from(a.heights)).toEqual(Array.from(b.heights));
    expect(Array.from(a.heights)).not.toEqual(Array.from(c.heights));
  });

  it("generates finite heights within the style's amplitude for every map style", () => {
    for (const style of ['alpine', 'coastal', 'city', 'desert']) {
      const field = sampleHeightfield(createHeightSampler(style, `seed-${style}`), {
        size: 800,
        resolution: 48,
      });
      for (const height of field.heights) {
        expect(Number.isFinite(height)).toBe(true);
      }
      const maxAbs = Math.max(...Array.from(field.heights, Math.abs));
      expect(maxAbs).toBeGreaterThan(1);
      // Nothing should be wildly outside the style's amplitude.
      expect(maxAbs).toBeLessThan(400);
    }
  });

  it('reports a higher slope on a cliff than on flat ground', () => {
    const resolution = 4;
    const size = 40;
    const n = resolution + 1;
    const steep = { heights: new Float32Array(n * n), resolution, size };
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        // Flat on the left half, a 20 m wall on the right half.
        steep.heights[gridIndex(ix, iz, resolution)] = ix >= 2 ? 20 : 0;
      }
    }
    const flat = { heights: new Float32Array(n * n), resolution, size };

    // Sampling across the cliff face must read a real gradient...
    expect(slopeAtGrid(steep, -2, 0, 7)).toBeGreaterThan(0.3);
    // ...while flat ground reads as flat.
    expect(slopeAtGrid(flat, 0, 0, 7)).toBeLessThan(0.05);
  });

  it('flattens the terrain along a road corridor', () => {
    const resolution = 40;
    const size = 400;
    const heights = new Float32Array((resolution + 1) ** 2);
    // Rolling terrain with 8 m of relief.
    for (let j = 0; j <= resolution; j++) {
      for (let i = 0; i <= resolution; i++) {
        const x = gridX(i, resolution, size);
        const z = gridZ(j, resolution, size);
        heights[gridIndex(i, j, resolution)] = Math.sin(x * 0.03) * 8 + Math.cos(z * 0.04) * 8;
      }
    }
    const field = { heights, resolution, size };

    // A road running along x = 0 at a constant height.
    const roadPoints = [];
    for (let z = -190; z <= 190; z += 4) roadPoints.push({ x: 0, y: 12, z });

    applyRoadFlattening(field.heights, field, roadPoints, { corridor: 12, blend: 12 });

    // On the centreline the terrain must now equal the road height.
    expect(heightAtGrid(field, 0, 0)).toBeCloseTo(12, 1);
    expect(heightAtGrid(field, 0, 120)).toBeCloseTo(12, 1);
    // Far from the road the original terrain survives untouched.
    expect(Math.abs(heightAtGrid(field, 190, 0) - 12)).toBeGreaterThan(0.5);
  });

  it('bilinearly interpolates between grid samples, with X and Z the right way round', () => {
    const resolution = 2;
    const size = 20;
    const n = resolution + 1;
    const field = { heights: new Float32Array(n * n), resolution, size };
    // h(ix, iz) = ix * 10 + iz * 100 -> X and Z contribute very differently, so
    // a transposed read produces a wildly different answer.
    for (let ix = 0; ix < n; ix++) {
      for (let iz = 0; iz < n; iz++) {
        field.heights[gridIndex(ix, iz, resolution)] = ix * 10 + iz * 100;
      }
    }

    expect(heightAtGrid(field, -10, -10)).toBeCloseTo(0, 3);
    expect(heightAtGrid(field, 10, -10)).toBeCloseTo(20, 3);
    expect(heightAtGrid(field, -10, 10)).toBeCloseTo(200, 3);
    // Centre of the grid: bilinear mean of the four corners (0, 20, 200, 220).
    expect(heightAtGrid(field, 0, 0)).toBeCloseTo(110, 3);
  });
});
