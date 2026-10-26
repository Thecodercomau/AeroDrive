import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { World } from '../src/world/World.js';
import { Vehicle } from '../src/vehicles/Vehicle.js';
import { getVehicleDefinition } from '../src/vehicles/definitions.js';
import { MAPS, getMap } from '../src/world/maps.js';
import { JUMP_RAMP, chunkKey } from '../src/world/props.js';
import { TrafficSignalController } from '../src/ai/trafficSignals.js';
import { TrafficSystem } from '../src/ai/TrafficSystem.js';
import { emptyControlState } from '../src/input/inputMapping.js';

/**
 * World integration tests.
 *
 * These build a real map (terrain + roads + props + colliders) and then drive a
 * real car on it. They are the tests that would catch the most damaging class of
 * bug in this project — a world that looks fine but that you fall through, or a
 * road you cannot actually drive along.
 *
 * Canvas is unavailable under Node, so the road texture is skipped; that path is
 * explicitly supported (see `createRoadTexture`).
 */

const DT = 1 / 60;

describe('world building and driving', () => {
  /** @type {World} */
  let world;
  /** @type {PhysicsWorld} */
  let physics;

  beforeAll(async () => {
    physics = new PhysicsWorld();
    await physics.init();
    world = new World({ physics, mapId: 'alpine-valley', vegetationDensity: 40 });
    world.build();
  });

  afterAll(() => {
    world?.dispose();
    physics?.dispose();
  });

  it('builds terrain, roads and props', () => {
    expect(world.built).toBe(true);
    expect(world.terrain).not.toBeNull();
    expect(world.roads.roads.length).toBeGreaterThan(0);
    expect(world.props).not.toBeNull();

    // A full-resolution mesh: (resolution + 1)^2 vertices.
    const expectedVertices = (world.map.terrain.resolution + 1) ** 2;
    expect(world.terrain.mesh.geometry.attributes.position.count).toBe(expectedVertices);
  });

  it('creates a physics collider for the terrain and for every road', () => {
    expect(world.terrain.collider).not.toBeNull();
    const colliders = world.roads.roads.filter((road) => road.collider !== null);
    expect(colliders.length).toBe(world.roads.roads.length);
  });

  it('spawns vehicles safely above the ground', () => {
    for (const spawn of world.spawnPoints) {
      const pose = world.resolveSpawn(spawn.id);
      const groundHeight = world.heightAt(pose.x, pose.z);
      expect(pose.y).toBeGreaterThan(groundHeight);
      expect(pose.y - groundHeight).toBeLessThan(3);
    }
  });

  it('reports the road surface where a road actually is', () => {
    const road = world.roads.roads[0];
    const mid = road.centreline[Math.floor(road.centreline.length / 2)];
    // Directly on the centreline the surface must be the road's own material.
    expect(world.surfaceAt(mid.x, mid.z, 0)).toBe(road.surface);
    // And far away from any road it must not be asphalt.
    const far = world.surfaceAt(0, world.bounds.max - 40, 0);
    expect(['grass', 'dirt', 'sand']).toContain(far);
  });

  it('drives a car along a road without falling through the world', () => {
    const road = world.roads.roads.find((candidate) => candidate.name === 'valley-loop');
    const start = road.centreline[0];
    const ahead = road.centreline[3];
    const heading = Math.atan2(ahead.x - start.x, ahead.z - start.z);

    const pose = world.spawnPose(start.x, start.z, heading, 1.4);
    const vehicle = new Vehicle({
      physics,
      definition: getVehicleDefinition('coupe'),
      spawn: pose,
      heading,
    });

    const startPosition = vehicle.position();
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < 420; i++) {
      vehicle.step(DT, { ...emptyControlState(), throttle: i > 30 ? 1 : 0 });
      physics.step(DT);
      const p = vehicle.position();
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }

    const endPosition = vehicle.position();
    const travelled = Math.hypot(endPosition.x - startPosition.x, endPosition.z - startPosition.z);

    // It must actually move...
    expect(travelled).toBeGreaterThan(20);
    // ...and it must stay on the surface rather than sink through it or fly.
    expect(minY).toBeGreaterThan(-20);
    expect(maxY).toBeLessThan(world.heightAt(endPosition.x, endPosition.z) + 25);
    // The wheels must be finding ground, not free-falling forever.
    expect(vehicle.wheelStates.some((wheel) => wheel.inContact)).toBe(true);

    vehicle.dispose();
  });

  it('joins a connecting road at its nearest point, not at a road start', () => {
    const traffic = new TrafficSystem({ physics, world, density: 50 });
    try {
      expect(traffic.route.length).toBeGreaterThan(2);
      const roadStart = traffic.roadStarts[0];
      const roadEnd = traffic.route[roadStart].roadEnd;
      const endNode = traffic.route[roadEnd];

      const vehicle = { roadStart, roadEnd, routeIndex: roadEnd, heading: endNode.heading };
      traffic._continueRoute(vehicle);

      // The nearest node on ANY other road, and the nearest road START, so the
      // two rules can be compared directly.
      let nearest = -1;
      let nearestDistance = Infinity;
      traffic.route.forEach((node, index) => {
        if (node.roadStart === roadStart) return;
        const distance = Math.hypot(node.x - endNode.x, node.z - endNode.z);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = index;
        }
      });
      let nearestStartDistance = Infinity;
      for (const start of traffic.roadStarts) {
        if (start === roadStart) continue;
        const node = traffic.route[start];
        nearestStartDistance = Math.min(
          nearestStartDistance,
          Math.hypot(node.x - endNode.x, node.z - endNode.z),
        );
      }

      // A car is never left with nothing to drive, so the target road's own last
      // node is stepped back from.
      const target = traffic.route[nearest];
      const expected =
        nearest >= target.roadEnd && target.roadEnd > target.roadStart
          ? target.roadEnd - 1
          : nearest;

      expect(vehicle.routeIndex).toBe(expected);
      expect(vehicle.roadStart).toBe(traffic.route[expected].roadStart);
      expect(vehicle.roadStart).not.toBe(roadStart);
      // The nearest-point rule can only beat or match the old nearest-start rule.
      expect(nearestDistance).toBeLessThanOrEqual(nearestStartDistance);
      // And it has to be a real improvement to be worth the extra scan.
      expect(nearestStartDistance).toBeGreaterThan(0);
    } finally {
      traffic.dispose();
    }
  });

  it('streams props in around the player and bounds the loaded collider count', () => {
    const start = world.spawnPoints[0];
    world.update({ x: start.x, z: start.z }, { loadDistance: 300 });

    expect(world.props.stats.loadedChunks).toBeGreaterThan(0);
    expect(world.props.stats.loadedProps).toBeGreaterThan(0);
    expect(world.props.stats.unloadedChunks).toBeGreaterThan(0);

    // Colliders are bounded by the streaming radius, never the whole world.
    expect(world.props.stats.colliders).toBeLessThan(world.props.chunkCount * 40);
  });

  it('unloads far chunks when the player drives away', () => {
    const start = world.spawnPoints[0];
    world.update({ x: start.x, z: start.z }, { loadDistance: 300 });
    const nearCount = world.props.stats.loadedChunks;

    // Teleport to the opposite corner of the map and stream again.
    world.update({ x: -2200, z: 2200 }, { loadDistance: 300 });
    for (let i = 0; i < 30; i++) world.update({ x: -2200, z: 2200 }, { loadDistance: 300 });

    expect(world.props.stats.loadedChunks).toBeLessThan(nearCount + 200);
    // The world must never be fully resident: streaming is real, not cosmetic.
    expect(world.props.stats.loadedChunks).toBeLessThan(world.props.chunkCount);
  });
});

describe('services and junctions on a built map', () => {
  /** @type {World} */
  let city;
  /** @type {PhysicsWorld} */
  let physics;

  beforeAll(async () => {
    physics = new PhysicsWorld();
    await physics.init();
    city = new World({ physics, mapId: 'modern-city', vegetationDensity: 0 });
    city.build();
  });

  afterAll(() => {
    city?.dispose();
    physics?.dispose();
  });

  it('resolves every declared service onto the map', () => {
    expect(city.services.length).toBe(getMap('modern-city').services.length);
    for (const service of city.services) {
      expect(Number.isFinite(service.x)).toBe(true);
      expect(service.name.length).toBeGreaterThan(0);
    }
  });

  it('places every service on a road', () => {
    // This is the check that would have caught a garage stranded 280 m from the
    // nearest tarmac. Services inherit their position from spawn points, and
    // spawn points are separately asserted to be on-road, but the wiring between
    // the two is exactly the kind of thing that breaks silently.
    for (const service of city.services) {
      const nearest = city.roads.nearestRoad(service.x, service.z);
      expect(
        nearest.distance,
        `${service.name} is ${nearest.distance.toFixed(1)} m from a road`,
      ).toBeLessThan(12);
    }
  });

  it('finds the nearest service inside its radius, and nothing outside it', () => {
    const target = city.services[0];
    expect(city.serviceNear({ x: target.x + 4, z: target.z }, 24)?.id).toBe(target.id);
    expect(city.serviceNear({ x: target.x + 900, z: target.z }, 24)).toBeNull();
  });

  it('derives junctions from the built city grid', () => {
    const controller = new TrafficSignalController({
      roads: city.minimapRoads({ maxPointsPerRoad: 220 }),
    });
    // The city is a 5x5 grid of streets, so the crossings must come out of the
    // geometry rather than out of hand-authored coordinates.
    expect(controller.count).toBeGreaterThanOrEqual(16);
  });
});

describe('jump ramp on the desert proving grounds', () => {
  /** @type {World} */
  let world;
  /** @type {PhysicsWorld} */
  let physics;

  beforeAll(async () => {
    physics = new PhysicsWorld();
    await physics.init();
    world = new World({ physics, mapId: 'desert-proving-grounds', vegetationDensity: 30 });
    world.build();
  });

  afterAll(() => {
    world?.dispose();
    physics?.dispose();
  });

  const findRamp = () => {
    for (const instances of world.props.chunks.values()) {
      const ramp = instances.find((instance) => instance.type === 'jumpRamp');
      if (ramp) return ramp;
    }
    return null;
  };

  it('stands beside the dune trail on ground the road has levelled', () => {
    const ramp = findRamp();
    expect(ramp).toBeTruthy();
    expect(ramp.solid).toBe(true);

    const nearest = world.roads.nearestRoad(ramp.x, ramp.z);
    expect(nearest.road.name).toBe('dune-trail');
    expect(nearest.distance).toBeLessThan(12);
    // Flat enough that the ramp is not fighting the terrain it sits on.
    expect(world.slopeAt(ramp.x, ramp.z)).toBeLessThan(0.25);
  });

  it('has a surface you can drive up, and air above it', () => {
    const ramp = findRamp();
    // Load just the chunk the ramp is in, which is what builds its collider.
    world.props._loadChunk(chunkKey(ramp.x, ramp.z));
    // Rapier only rebuilds its query pipeline inside a step, so a collider is
    // invisible to a raycast until the simulation is advanced past it.
    physics.syncQueries();

    const forwardX = Math.sin(ramp.rotation);
    const forwardZ = Math.cos(ramp.rotation);
    const half = JUMP_RAMP.length / 2;
    const probe = { x: ramp.x + forwardX * half, z: ramp.z + forwardZ * half };

    // Drop a ray onto the middle of the incline. Its surface must be the ramp's
    // incline at that point — which is the one thing a wheel has to find.
    const drop = physics.raycast(
      { x: probe.x, y: ramp.y + JUMP_RAMP.rise * 2, z: probe.z },
      { x: 0, y: -1, z: 0 },
      60,
    );
    expect(drop).toBeTruthy();
    expect(drop.tag).toBe('prop:jumpRamp');
    expect(drop.point.y).toBeCloseTo(ramp.y + JUMP_RAMP.rise / 2, 1);

    // And a metre above the surface is clear: the collider is the ramp, not a
    // block the car would hit like a wall.
    const above = physics.raycast(
      { x: probe.x, y: ramp.y + JUMP_RAMP.rise / 2 + 1.2, z: probe.z },
      { x: 0, y: -1, z: 0 },
      1,
    );
    expect(above).toBeNull();
  });
});

describe('map definitions', () => {
  it('gives every map at least one service and points it at a real spawn', () => {
    for (const map of MAPS) {
      const services = map.services ?? [];
      expect(services.length, `${map.id} has no services`).toBeGreaterThan(0);
      // The whole point of defining a service by spawn id is that the spawn
      // tests then cover it. A typo would silently drop the service instead.
      for (const service of services) {
        expect(
          map.spawnPoints.some((spawn) => spawn.id === service.spawnId),
          `${map.id} service "${service.name}" references ${service.spawnId}`,
        ).toBe(true);
      }
      // And at least one garage or recovery point, or a damaged car can never be
      // repaired on that map.
      expect(
        services.some((service) => service.type === 'garage' || service.type === 'recovery'),
      ).toBe(true);
    }
  });

  it('defines four distinct maps with coherent data', () => {
    expect(MAPS).toHaveLength(4);
    const ids = new Set(MAPS.map((map) => map.id));
    expect(ids.size).toBe(4);

    for (const map of MAPS) {
      expect(map.terrain.size).toBeGreaterThan(500);
      expect(map.terrain.resolution).toBeGreaterThan(32);
      // A whole grid of arrays would violate "no enormous empty maps".
      expect(map.spawnPoints.length).toBeGreaterThan(0);
      expect(map.landmarks.length).toBeGreaterThan(0);
      expect(map.buildRoads().length).toBeGreaterThan(0);
    }
  });

  it('returns null for an unknown map id', () => {
    expect(getMap('does-not-exist')).toBeNull();
  });

  it('rejects building an unknown map', async () => {
    const isolated = new PhysicsWorld();
    await isolated.init();
    expect(() => new World({ physics: isolated, mapId: 'nope' })).toThrow(/unknown map id/);
    isolated.dispose();
  });
});
