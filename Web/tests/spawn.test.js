import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { World } from '../src/world/World.js';
import { MAPS } from '../src/world/maps.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';

/**
 * Spawn-point sanity.
 *
 * A car dropped onto a steep slope slides off sideways with two wheels in the
 * air, the engine free-revs and the player cannot move. That is exactly the bug
 * this suite exists to catch: every declared spawn point must sit on ground
 * flat enough for a vehicle to be placed on it, on every map.
 *
 * The measurement uses the real terrain generator, the real road projection and
 * the real road-corridor flattening, so a change to any of them is covered.
 */

const physics = new PhysicsWorld();
const worlds = new Map();

/** Terrain height difference across the vehicle footprint (wheelbase + track). */
function footprintRelief(world, x, z) {
  const reach = 2.2; // metres — a little more than the longest vehicle's half wheelbase
  let min = Infinity;
  let max = -Infinity;
  for (let dx = -reach; dx <= reach; dx += reach / 2) {
    for (let dz = -reach; dz <= reach; dz += reach / 2) {
      const h = world.heightAt(x + dx, z + dz);
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
  }
  return max - min;
}

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

describe('spawn points', () => {
  it('builds every map', () => {
    expect(worlds.size).toBe(MAPS.length);
  });

  it.each(MAPS.map((map) => [map.id, map.name]))(
    '%s (%s) places every spawn on drivable ground',
    (mapId) => {
      const world = worlds.get(mapId);
      expect(world.spawnPoints.length).toBeGreaterThan(0);

      for (const spawn of world.spawnPoints) {
        const relief = footprintRelief(world, spawn.x, spawn.z);
        // 1.2 m of relief across a car's footprint is roughly a 30% grade — the
        // steepest surface a road car can stand on without sliding.
        expect(
          relief,
          `${spawn.id} sits on ${relief.toFixed(2)} m of relief — too steep to spawn a car`,
        ).toBeLessThan(1.2);

        const pose = world.resolveSpawn(spawn.id);
        const gap = pose.y - world.heightAt(pose.x, pose.z);
        // High enough to clear the terrain, low enough that the suspension
        // settles rather than the car being dropped from a height.
        expect(gap).toBeGreaterThan(0.5);
        expect(gap).toBeLessThan(2.5);
      }
    },
  );

  it.each(MAPS.map((map) => [map.id, map.name]))(
    '%s (%s) starts the player on a road surface, not in a field',
    (mapId) => {
      const world = worlds.get(mapId);
      for (const spawn of world.spawnPoints) {
        const nearest = world.roads.nearestRoad(spawn.x, spawn.z);
        // A garage or car park far from any road is not a usable place to start
        // driving from — the player would have to cross open terrain first.
        expect(
          nearest.distance,
          `${spawn.id} is ${nearest.distance.toFixed(0)} m from a road`,
        ).toBeLessThan(15);
        expect(world.surfaceAt(spawn.x, spawn.z, 0)).not.toBe('grass');
      }
    },
  );

  it('faces every spawn along the road it sits on', () => {
    for (const world of worlds.values()) {
      for (const spawn of world.spawnPoints) {
        const pose = world.resolveSpawn(spawn.id);
        const roadHeading = world.roads.directionNear(spawn.x, spawn.z);
        if (roadHeading === null) continue;
        // `forward` is (sin yaw, cos yaw), so compare forward vectors rather than
        // raw angles — wrap-around can then never produce a false failure.
        const dot =
          Math.sin(pose.heading) * Math.sin(roadHeading) +
          Math.cos(pose.heading) * Math.cos(roadHeading);
        expect(dot, `${spawn.id} faces across the road, not along it`).toBeGreaterThan(0.9);
      }
    }
  });

  it('drives away from every alpine spawn without leaving the asphalt', () => {
    const world = worlds.get('alpine-valley');
    const definition = getVehicleDefinition('hatchback');

    for (const spawn of world.spawnPoints) {
      const pose = world.resolveSpawn(spawn.id);
      const vehicle = new Vehicle({ physics, definition, spawn: pose, heading: pose.heading });

      // Let the suspension settle, then drive flat out with the wheel straight.
      for (let i = 0; i < 60; i++) {
        vehicle.step(1 / 60, { throttle: 0, brake: 0, steer: 0 });
        physics.step(1 / 60);
      }
      for (let i = 0; i < 180; i++) {
        vehicle.step(1 / 60, { throttle: 1, brake: 0, steer: 0 });
        physics.step(1 / 60);
      }

      const speed = vehicle.telemetry.speedKmh;
      expect(speed, `${spawn.id}: the car never got moving`).toBeGreaterThan(20);

      // Three seconds of straight-line throttle must still be on the road. A car
      // spawned *across* the asphalt instead of along it veers off within the
      // first second, so this is the assertion that catches a bad heading.
      const position = vehicle.position();
      const surface = world.surfaceAt(position.x, position.z, 3);
      expect(surface, `${spawn.id}: the car drove off the road`).not.toBe('grass');

      vehicle.dispose();
    }
  });
});
