import { describe, expect, it, vi } from 'vitest';
import { MissionRunner, MISSION_STATUS } from '../src/missions/MissionRunner.js';
import { CHALLENGES, getChallenge, describeObjective } from '../src/missions/challenges.js';
import { EventBus } from '../src/core/EventBus.js';
import { VEHICLES } from '../src/vehicles/definitions.js';
import { World } from '../src/world/World.js';

/**
 * Mission tests.
 *
 * The runner takes a world only to derive checkpoints, so the world is injected.
 * That keeps these tests fast and focused on the rules — does a gate register,
 * does a timeout fail the run, is a new record reported — rather than on
 * terrain generation.
 */

/** Minimal stand-in exposing exactly what the challenge builders use. */
function fakeWorld(landmarks = []) {
  return {
    landmarks,
    heightAt: () => 0,
    roads: {
      roads: [
        {
          name: 'test-road',
          surface: 'asphalt',
          width: 10,
          centreline: Array.from({ length: 41 }, (_, index) => ({
            x: index * 10,
            y: 0,
            z: 0,
          })),
        },
      ],
    },
  };
}

function makeChallenge(overrides = {}) {
  return {
    id: 'unit-test-race',
    name: 'Unit Test Race',
    type: 'time-trial',
    mapId: 'test',
    timeLimit: 10,
    build() {
      return {
        checkpoints: [
          { x: 0, y: 0, z: 0, radius: 5 },
          { x: 100, y: 0, z: 0, radius: 5 },
          { x: 200, y: 0, z: 0, radius: 5 },
        ],
      };
    },
    ...overrides,
  };
}

const DT = 1 / 60;

describe('MissionRunner', () => {
  it('starts idle and becomes running on start', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    expect(runner.status).toBe(MISSION_STATUS.IDLE);
    runner.start();
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    expect(runner.totalCheckpoints).toBe(3);
  });

  it('emits an event when it starts', () => {
    const bus = new EventBus();
    let started = null;
    bus.on('mission:started', (payload) => {
      started = payload;
    });
    new MissionRunner({ challenge: makeChallenge(), world: fakeWorld(), bus }).start();
    expect(started).not.toBeNull();
    expect(started.checkpoints).toHaveLength(3);
  });

  it('requires the gates to be taken in order', () => {
    const bus = new EventBus();
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld(), bus });
    runner.start();

    // Standing on gate 3 first must not count.
    runner.update(DT, { position: { x: 200, z: 0 }, speedKmh: 0 });
    expect(runner.checkpointIndex).toBe(0);

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 0 });
    expect(runner.checkpointIndex).toBe(1);

    // Gate 3 again — still out of order.
    runner.update(DT, { position: { x: 200, z: 0 }, speedKmh: 0 });
    expect(runner.checkpointIndex).toBe(1);
  });

  it('completes once every gate is passed in order', () => {
    const bus = new EventBus();
    const completed = [];
    bus.on('mission:completed', (payload) => completed.push(payload));

    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld(), bus });
    runner.start();

    for (const x of [0, 100, 200]) {
      runner.update(DT, { position: { x, z: 0 }, speedKmh: 40, damage: 0 });
      // Clear the gate cooldown so the next gate can register immediately.
      runner._gateCooldown = 0;
    }

    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
    expect(completed).toHaveLength(1);
    expect(completed[0].timeSeconds).toBeGreaterThan(0);
    expect(completed[0].score).toBeGreaterThan(0);
  });

  it('fails when the time limit is exceeded', () => {
    const bus = new EventBus();
    const failed = [];
    bus.on('mission:failed', (payload) => failed.push(payload));

    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld(), bus });
    runner.start();
    // Sit still and let the clock run out.
    for (let i = 0; i < 700; i++) runner.update(DT, { position: { x: 500, z: 500 }, speedKmh: 0 });

    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toBe('Out of time');
    expect(failed).toHaveLength(1);
  });

  it('reports time remaining and never goes negative', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    runner.start();
    expect(runner.timeRemaining).toBeCloseTo(10, 5);
    runner.update(12, { position: { x: 999, z: 999 }, speedKmh: 0 });
    expect(runner.timeRemaining).toBe(0);
  });

  it('awards a higher score for finishing faster with less damage', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    runner.start();
    const fast = runner._calculateScore({ damage: 0, speedKmh: 0 });

    const slow = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    slow.start();
    slow.elapsed = 9.5;
    const slowScore = slow._calculateScore({ damage: 80, speedKmh: 0 });

    expect(fast).toBeGreaterThan(slowScore);
    expect(fast).toBeLessThanOrEqual(1000);
    expect(slowScore).toBeGreaterThanOrEqual(0);
  });

  it('supports a speed run objective', () => {
    const challenge = makeChallenge({
      type: 'speed-run',
      targetSpeedKmh: 200,
      timeLimit: 30,
      build: () => ({ checkpoints: [] }),
    });
    const runner = new MissionRunner({ challenge, world: fakeWorld() });
    runner.start();

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 120 });
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    expect(runner.bestSpeedKmh).toBe(120);

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 205 });
    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
  });

  it('tracks landmark discovery for exploration challenges', () => {
    const landmarks = [
      { id: 'a', name: 'A', x: 0, z: 0 },
      { id: 'b', name: 'B', x: 500, z: 0 },
    ];
    const challenge = makeChallenge({
      type: 'exploration',
      timeLimit: null,
      build: () => ({ landmarks: landmarks.map((l) => ({ ...l, radius: 20 })) }),
    });
    const bus = new EventBus();
    const found = [];
    bus.on('mission:landmark', (payload) => found.push(payload.landmark.id));

    const runner = new MissionRunner({ challenge, world: fakeWorld(landmarks), bus });
    runner.start();
    expect(runner.totalCheckpoints).toBe(2);

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 0 });
    expect(found).toEqual(['a']);
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);

    runner.update(DT, { position: { x: 500, z: 0 }, speedKmh: 0 });
    expect(found).toEqual(['a', 'b']);
    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
  });

  it('fails a handling test for spending too long off the asphalt', () => {
    const challenge = makeChallenge({
      type: 'handling',
      timeLimit: 60,
      maxOffRoadSeconds: 0.5,
      build: () => ({ checkpoints: [{ x: 0, y: 0, z: 0, radius: 5 }] }),
    });
    const runner = new MissionRunner({ challenge, world: fakeWorld() });
    runner.start();
    for (let i = 0; i < 60; i++) {
      runner.update(DT, { position: { x: 999, z: 999 }, speedKmh: 30, onSurface: 'grass' });
    }
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/asphalt/i);
  });

  it('provides minimap markers that reflect progress', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    runner.start();
    const markers = runner.minimapMarkers();
    expect(markers).toHaveLength(3);
    expect(markers[0].active).toBe(true);
    expect(markers[1].active).toBe(false);

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 0 });
    const after = runner.minimapMarkers();
    expect(after[1].active).toBe(true);
    expect(after[0].active).toBe(false);
  });

  it('can be restarted cleanly after a failure', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    runner.start();
    for (let i = 0; i < 700; i++) runner.update(DT, { position: { x: 999, z: 999 }, speedKmh: 0 });
    expect(runner.status).toBe(MISSION_STATUS.FAILED);

    runner.start();
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    expect(runner.elapsed).toBe(0);
    expect(runner.checkpointIndex).toBe(0);
    expect(runner.failReason).toBeNull();
  });

  it('does not tick once completed', () => {
    const runner = new MissionRunner({ challenge: makeChallenge(), world: fakeWorld() });
    runner.start();
    for (const x of [0, 100, 200]) {
      runner.update(DT, { position: { x, z: 0 }, speedKmh: 0 });
      runner._gateCooldown = 0;
    }
    const elapsed = runner.elapsed;
    runner.update(5, { position: { x: 0, z: 0 }, speedKmh: 0 });
    expect(runner.elapsed).toBe(elapsed);
  });
});

describe('challenge definitions', () => {
  it('defines nine challenges that are consistent with the vehicle unlocks', () => {
    expect(CHALLENGES.length).toBe(9);
    const ids = new Set();
    for (const challenge of CHALLENGES) {
      expect(ids.has(challenge.id)).toBe(false);
      ids.add(challenge.id);
      expect(challenge.name.length).toBeGreaterThan(0);
      expect(challenge.description.length).toBeGreaterThan(20);
      expect(typeof challenge.build).toBe('function');
      // A challenge may reward nothing (a practice or score challenge) but it
      // must never name a vehicle that does not exist.
      if (challenge.reward) {
        expect(VEHICLES.some((vehicle) => vehicle.id === challenge.reward.vehicleId)).toBe(true);
      }
    }

    // Practice and score challenges deliberately unlock nothing. Asserted explicitly so an
    // accidental missing reward fails here rather than quietly shipping as
    // "well, it has no reward".
    const withoutReward = CHALLENGES.filter((challenge) => !challenge.reward);
    expect(withoutReward.map((challenge) => challenge.id).sort()).toEqual([
      'city-airfield-drift',
      'city-delivery',
      'desert-braking-test',
      'desert-drift-pad',
    ]);
  });

  it('gates every non-starter vehicle behind exactly one challenge', () => {
    const counts = new Map();
    for (const challenge of CHALLENGES) {
      const id = challenge.reward?.vehicleId;
      if (!id) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const vehicleId of ['coupe', 'supercar', 'suv', 'pickup', 'offroad']) {
      // Exactly one, not "at least one": two challenges unlocking the same car
      // would mean one of them has no reason to exist.
      expect(counts.get(vehicleId), `${vehicleId} unlock count`).toBe(1);
    }
  });

  it("builds real checkpoints against each challenge's own map", async () => {
    const { PhysicsWorld } = await import('../src/physics/PhysicsWorld.js');
    const physics = new PhysicsWorld();
    await physics.init();

    // Each challenge must resolve its gates on ITS OWN map. Building every
    // challenge against a single map would hide exactly the failure this test
    // exists to catch: a challenge referencing a road name that no longer exists.
    const worlds = new Map();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const challenge of CHALLENGES) {
      if (!worlds.has(challenge.mapId)) {
        const world = new World({ physics, mapId: challenge.mapId, vegetationDensity: 0 });
        world.build();
        worlds.set(challenge.mapId, world);
      }
      const world = worlds.get(challenge.mapId);
      const built = challenge.build(world);

      if (challenge.type === 'exploration') {
        expect(built.landmarks.length).toBeGreaterThan(0);
        continue;
      }

      expect(built.checkpoints.length, `${challenge.id} produced no checkpoints`).toBeGreaterThan(
        0,
      );
      for (const checkpoint of built.checkpoints) {
        expect(Number.isFinite(checkpoint.x)).toBe(true);
        expect(Number.isFinite(checkpoint.z)).toBe(true);
        expect(checkpoint.radius).toBeGreaterThan(0);
        // A gate must sit on the terrain, not float or sink.
        expect(checkpoint.y).toBeGreaterThan(world.heightAt(checkpoint.x, checkpoint.z) - 2);
      }

      // And the runner must accept it.
      const runner = new MissionRunner({ challenge, world });
      runner.start();
      expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    }

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();

    for (const world of worlds.values()) world.dispose();
    physics.dispose();
  });

  it('refuses to start a gate challenge that has no checkpoints', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = new MissionRunner({
      challenge: makeChallenge({ build: () => ({ checkpoints: [] }) }),
      world: fakeWorld(),
    });
    runner.start();
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/misconfigured/i);
    error.mockRestore();
  });

  it('describes the braking and delivery objectives', () => {
    expect(
      describeObjective({ type: 'braking', minSpeedKmh: 100 }, { brakingPhase: 'approach' }),
    ).toMatch(/100/);
    expect(
      describeObjective(
        { type: 'braking', minSpeedKmh: 100 },
        { brakingPhase: 'stopping', brakingDistance: 42 },
      ),
    ).toMatch(/42 m/);
    const delivery = describeObjective(
      { type: 'delivery', cargo: 'brake components', destinationLabel: 'Eastside Garage' },
      { distanceToTarget: 812 },
    );
    expect(delivery).toMatch(/Eastside Garage/);
    expect(delivery).toMatch(/812/);
  });

  it('looks up challenges by id and returns null for unknown ones', () => {
    expect(getChallenge(CHALLENGES[0].id).id).toBe(CHALLENGES[0].id);
    expect(getChallenge('nope')).toBeNull();
  });
});

describe('braking tests', () => {
  /** A trigger line at the origin and a stop line 100 m further on. */
  const braking = (overrides = {}) => ({
    id: 'unit-braking',
    name: 'Unit Braking',
    type: 'braking',
    mapId: 'test',
    timeLimit: 60,
    minSpeedKmh: 100,
    build: () => ({
      checkpoints: [
        { x: 0, y: 0, z: 0, radius: 10 },
        { x: 100, y: 0, z: 0, radius: 10 },
      ],
    }),
    ...overrides,
  });

  it('fails a run that reaches the trigger line too slowly', () => {
    const runner = new MissionRunner({ challenge: braking(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 40 });
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/slower/i);
  });

  it('waits at the trigger line until the car crosses it', () => {
    const runner = new MissionRunner({ challenge: braking(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: -200, z: 0 }, speedKmh: 0 });
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    expect(runner.brakingPhase).toBe('approach');
    // Not even close, so it must not have failed for being too slow.
    expect(runner.failReason).toBeNull();
  });

  it('fails a run that overshoots the braking zone', () => {
    const runner = new MissionRunner({ challenge: braking(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 130 });
    expect(runner.brakingPhase).toBe('stopping');

    runner.update(DT, { position: { x: 100, z: 0 }, speedKmh: 60 });
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/overshot/i);
  });

  it('completes when the car stops inside the zone, and reports the distance', () => {
    const bus = new EventBus();
    let completed = null;
    bus.on('mission:completed', (payload) => {
      completed = payload;
    });
    const runner = new MissionRunner({ challenge: braking(), world: fakeWorld(), bus });
    runner.start();

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 140 });
    runner.update(DT, { position: { x: 62, z: 0 }, speedKmh: 0 });

    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
    expect(runner.brakingDistance).toBeCloseTo(62, 3);
    // The headline number for a braking test is distance, not time.
    expect(completed.brakingDistance).toBeCloseTo(62, 3);
    expect(completed.score).toBeGreaterThan(0);
  });

  it('counts a stop exactly on the stop line as a success', () => {
    const runner = new MissionRunner({ challenge: braking(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 110 });
    runner.update(DT, { position: { x: 100, z: 0 }, speedKmh: 0 });
    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
  });

  it('still enforces the overall time limit', () => {
    const runner = new MissionRunner({
      challenge: braking({ timeLimit: 5 }),
      world: fakeWorld(),
    });
    runner.start();
    for (let i = 0; i < 400; i++) {
      runner.update(DT, { position: { x: -500, z: 0 }, speedKmh: 0 });
    }
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/time/i);
  });
});

describe('delivery missions', () => {
  const delivery = (overrides = {}) => ({
    id: 'unit-delivery',
    name: 'Unit Delivery',
    type: 'delivery',
    mapId: 'test',
    timeLimit: 60,
    maxDamage: 12,
    cargo: 'brake components',
    destinationLabel: 'Depot',
    build: () => ({ checkpoints: [{ x: 100, y: 0, z: 0, radius: 20 }] }),
    ...overrides,
  });

  it('completes when the destination is reached', () => {
    const runner = new MissionRunner({ challenge: delivery(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 30, damage: 0 });
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);
    runner.update(DT, { position: { x: 100, z: 0 }, speedKmh: 30, damage: 0 });
    expect(runner.status).toBe(MISSION_STATUS.COMPLETED);
  });

  it('fails when the cargo takes more damage than allowed', () => {
    const runner = new MissionRunner({ challenge: delivery(), world: fakeWorld() });
    runner.start();
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 30, damage: 25 });
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
    expect(runner.failReason).toMatch(/cargo/i);
  });

  it('measures damage from the state at the start, not from zero', () => {
    // Turning up in a car that is already bent must not instantly fail the run.
    const runner = new MissionRunner({ challenge: delivery(), world: fakeWorld() });
    runner.start({ damage: 40 });
    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 30, damage: 45 });
    expect(runner.status).toBe(MISSION_STATUS.RUNNING);

    runner.update(DT, { position: { x: 0, z: 0 }, speedKmh: 30, damage: 60 });
    expect(runner.status).toBe(MISSION_STATUS.FAILED);
  });
});

describe('objective text', () => {
  it('describes each objective type in human-readable text', () => {
    const state = {
      checkpointIndex: 3,
      checkpointTotal: 10,
      bestSpeedKmh: 180,
      landmarksVisited: 2,
      landmarksTotal: 5,
      lap: false,
    };
    expect(describeObjective({ type: 'time-trial' }, state)).toMatch(/3 \/ 10/);
    expect(describeObjective({ type: 'speed-run', targetSpeedKmh: 240 }, state)).toMatch(/240/);
    expect(describeObjective({ type: 'exploration' }, state)).toMatch(/2 \/ 5/);
  });
});
