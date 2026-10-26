import { describe, expect, it } from 'vitest';
import { JUMP_RAMP, PROP_TYPES, createPropVariants, generateProps } from '../src/world/props.js';
import { MAPS, getMap } from '../src/world/maps.js';

/**
 * Prop placement.
 *
 * Props are cheap individually and expensive in aggregate, so the properties
 * worth testing are the ones that keep them that way: only known types are ever
 * produced, the collider budget holds, and the one prop that is *declared*
 * rather than scattered — the jump ramp — ends up where the map says, pointing
 * where the map says.
 *
 * These tests call the generator directly rather than building a world. The
 * generator's only inputs are the map, a height query and the road samples, so a
 * world build would add seconds of terrain work and prove nothing extra.
 */

/** The smallest stand-in the prop generator will accept. */
function fakeInputs(map) {
  return {
    map,
    terrain: { heightAt: () => 0, slopeAt: () => 0 },
    roads: { allCentrelinePoints: () => [{ x: 0, z: 0 }] },
  };
}

function instancesOf(map, { vegetationDensity = 100, seed = undefined } = {}) {
  const chunks = generateProps({ ...fakeInputs(map), vegetationDensity, seed });
  const out = [];
  for (const list of chunks.values()) out.push(...list);
  return out;
}

describe('prop generation', () => {
  it('only ever produces known prop types', () => {
    for (const map of MAPS) {
      for (const instance of instancesOf(map)) {
        expect(PROP_TYPES, `${map.id} produced an unknown prop`).toContain(instance.type);
        expect(Number.isFinite(instance.x)).toBe(true);
        expect(Number.isFinite(instance.y)).toBe(true);
        expect(Number.isFinite(instance.z)).toBe(true);
        expect(instance.scale).toBeGreaterThan(0);
      }
    }
  });

  it('stays inside the solid-collider budget on every map', () => {
    for (const map of MAPS) {
      const instances = instancesOf(map);
      const solid = instances.filter((instance) => instance.solid);
      expect(solid.length).toBeLessThanOrEqual(map.props.solidColliderBudget ?? 700);
    }
  });

  it('places every declared ramp at its declared position and heading', () => {
    for (const map of MAPS) {
      const declared = map.props.ramps ?? [];
      const placed = instancesOf(map).filter((instance) => instance.type === 'jumpRamp');
      expect(placed).toHaveLength(declared.length);

      declared.forEach((ramp, index) => {
        expect(Number.isFinite(ramp.x)).toBe(true);
        expect(Number.isFinite(ramp.z)).toBe(true);
        expect(Number.isFinite(ramp.heading)).toBe(true);
        expect(placed[index].x).toBeCloseTo(ramp.x, 6);
        expect(placed[index].z).toBeCloseTo(ramp.z, 6);
        // Along the declared axis, either way round: which end is the low one is
        // decided by the ground, not by the map. See `generateProps`.
        expect(Math.abs(Math.cos(placed[index].rotation - ramp.heading))).toBeCloseTo(1, 6);
        // Solid without being subject to the budget: a ramp you can drive through
        // is not a ramp.
        expect(placed[index].solid).toBe(true);
      });
    }
  });
});

describe('the jump ramp', () => {
  it('builds a wedge whose geometry is the size its collider assumes', () => {
    // Asked for the usual three variants, and deliberately given one: identical
    // geometry three times over is memory spent on nothing.
    const variants = createPropVariants('jumpRamp', 'desert-proving-2026');
    expect(variants).toHaveLength(1);

    const [variant] = variants;
    expect(variant.solid).toBe('ramp');
    expect(variant.ramp).toEqual(JUMP_RAMP);

    variant.geometry.computeBoundingBox();
    const box = variant.geometry.boundingBox;
    // The origin is the low edge, on the ground: it climbs the ramp's full rise
    // along +Z, and is the ramp's full width across.
    expect(box.max.y - box.min.y).toBeCloseTo(JUMP_RAMP.rise, 6);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.min.z).toBeCloseTo(0, 6);
    expect(box.max.z).toBeCloseTo(JUMP_RAMP.length, 6);
    expect(box.max.x - box.min.x).toBeCloseTo(JUMP_RAMP.width, 6);
  });

  it('puts the Desert Proving Grounds ramp beside the dune trail', () => {
    const map = getMap('desert-proving-grounds');
    const ramp = (map.props.ramps ?? [])[0];
    expect(ramp).toBeTruthy();

    const trail = map.buildRoads().find((road) => road.name === 'dune-trail');
    expect(trail).toBeTruthy();
    const nearest = Math.min(
      ...trail.points.map((point) => Math.hypot(point.x - ramp.x, point.z - ramp.z)),
    );
    // Beside the trail, not on it: far enough out that a ramp does not sit in the
    // carriageway, close enough in to be on the verge the road has levelled.
    expect(nearest).toBeGreaterThan(3);
    expect(nearest).toBeLessThan(12);
  });
});
