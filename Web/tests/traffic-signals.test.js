import { describe, expect, it } from 'vitest';
import { TrafficSignalController, findIntersections, roadAxis } from '../src/ai/trafficSignals.js';

/** A straight road with samples every `step` metres. */
function straight(name, from, to, step = 5) {
  const points = [];
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const count = Math.max(2, Math.round(length / step));
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
  }
  return { name, width: 11, surface: 'asphalt', points };
}

const CROSS = [
  straight('east-west', { x: -200, z: 0 }, { x: 200, z: 0 }),
  straight('north-south', { x: 0, z: -200 }, { x: 0, z: 200 }),
];

describe('road axis', () => {
  it('identifies the direction a road runs', () => {
    expect(roadAxis(straight('a', { x: -50, z: 0 }, { x: 50, z: 0 }).points)).toBe('x');
    expect(roadAxis(straight('b', { x: 0, z: -50 }, { x: 0, z: 50 }).points)).toBe('z');
  });

  it('does not crash on a degenerate road', () => {
    expect(['x', 'z']).toContain(roadAxis([]));
    expect(['x', 'z']).toContain(roadAxis([{ x: 1, z: 1 }]));
  });
});

describe('intersection detection', () => {
  it('finds the crossing of two perpendicular roads', () => {
    const found = findIntersections(CROSS);
    expect(found).toHaveLength(1);
    expect(found[0].x).toBeCloseTo(0, 0);
    expect(found[0].z).toBeCloseTo(0, 0);
    expect(new Set([found[0].a.name, found[0].b.name])).toEqual(
      new Set(['east-west', 'north-south']),
    );
  });

  it('ignores parallel roads that never cross', () => {
    const parallel = [
      straight('a', { x: -100, z: -20 }, { x: 100, z: -20 }),
      straight('b', { x: -100, z: 20 }, { x: 100, z: 20 }),
    ];
    expect(findIntersections(parallel)).toHaveLength(0);
  });

  it('ignores roads that are far apart', () => {
    const distant = [
      straight('a', { x: -100, z: 0 }, { x: 100, z: 0 }),
      straight('b', { x: -100, z: 400 }, { x: 100, z: 400 }),
    ];
    expect(findIntersections(distant)).toHaveLength(0);
  });

  it('reports one junction per crossing, not a cluster', () => {
    // A grid produces 3x3 = 9 crossings, and the dedupe must not turn each of
    // them into a pile of near-identical intersections.
    const grid = [];
    for (const x of [-100, 0, 100]) {
      grid.push(straight(`ns-${x}`, { x, z: -150 }, { x, z: 150 }));
    }
    for (const z of [-100, 0, 100]) {
      grid.push(straight(`ew-${z}`, { x: -150, z }, { x: 150, z }));
    }
    expect(findIntersections(grid)).toHaveLength(9);
  });

  it('finds nothing on a map with a single road', () => {
    expect(findIntersections([CROSS[0]])).toHaveLength(0);
    expect(findIntersections([])).toHaveLength(0);
  });
});

describe('signal timing', () => {
  const controller = new TrafficSignalController({ roads: CROSS });

  it('builds one signal for the crossing', () => {
    expect(controller.count).toBe(1);
  });

  it('gives exactly one direction green at a time', () => {
    for (let time = 0; time < 60; time += 0.5) {
      const state = controller.stateAt(0, time);
      expect(['a', 'b']).toContain(state.green);
      expect(Number.isFinite(state.timeToChange)).toBe(true);
      expect(state.timeToChange).toBeGreaterThanOrEqual(0);
      expect(state.timeToChange).toBeLessThanOrEqual(controller.cycle / 2 + 1e-6);
    }
  });

  it('alternates between the two directions over a cycle', () => {
    const seen = new Set();
    for (let time = 0; time < controller.cycle; time += 0.25) {
      seen.add(controller.stateAt(0, time).green);
    }
    expect(seen.size).toBe(2);
  });

  it('is deterministic for the same moment', () => {
    expect(controller.stateAt(0, 7.3)).toEqual(controller.stateAt(0, 7.3));

    // And periodic: the same phase comes round again a cycle later. Compared
    // with a tolerance because the phase is a float modulo, so the countdown
    // differs in its last bits rather than in any way a player could see.
    const now = controller.stateAt(0, 7.3);
    const nextCycle = controller.stateAt(0, 7.3 + controller.cycle);
    expect(nextCycle.green).toBe(now.green);
    expect(nextCycle.amber).toBe(now.amber);
    expect(nextCycle.timeToChange).toBeCloseTo(now.timeToChange, 6);
  });

  it('shows amber only as a phase change approaches', () => {
    let sawAmber = false;
    for (let time = 0; time < controller.cycle * 2; time += 0.1) {
      const state = controller.stateAt(0, time);
      if (state.amber) {
        sawAmber = true;
        // Amber is the tail of a phase, never the start of one.
        expect(state.timeToChange).toBeLessThanOrEqual(controller.amber + 1e-6);
      } else {
        expect(state.timeToChange).toBeGreaterThan(controller.amber - 1e-6);
      }
    }
    expect(sawAmber).toBe(true);
  });

  it('returns a safe default for an unknown intersection', () => {
    const state = controller.stateAt(99, 3);
    expect(state.green).toBe('a');
    expect(state.timeToChange).toBe(Infinity);
  });
});

describe('approaching a signal', () => {
  const controller = new TrafficSignalController({ roads: CROSS });
  const eastward = { x: 1, z: 0 };
  const northward = { x: 0, z: 1 };

  /** Find a moment when the given group has green. */
  function timeWhenGreen(group) {
    for (let time = 0; time < controller.cycle * 2; time += 0.1) {
      const state = controller.stateAt(0, time);
      if (state.green === group && !state.amber) return time;
    }
    throw new Error(`no green found for group ${group}`);
  }

  it('holds a car whose road is red and releases the one that is green', () => {
    const greenA = timeWhenGreen('a');
    // `east-west` is group a, `north-south` is group b.
    const approach = { x: -20, z: 0 };
    const released = controller.signalAhead('east-west', approach, eastward, greenA);
    expect(released.stop).toBe(false);
    expect(released.distance).toBeCloseTo(20, 0);

    const held = controller.signalAhead('north-south', { x: 0, z: -20 }, northward, greenA);
    expect(held.stop).toBe(true);
  });

  it('ignores a junction behind the car', () => {
    const greenA = timeWhenGreen('a');
    const drivingAway = controller.signalAhead('east-west', { x: 20, z: 0 }, eastward, greenA);
    expect(drivingAway.stop).toBe(false);
    expect(drivingAway.distance).toBe(Infinity);
  });

  it('does not look further ahead than its configured stop distance', () => {
    const greenB = timeWhenGreen('b');
    const far = controller.signalAhead('north-south', { x: 0, z: -150 }, northward, greenB);
    expect(far.stop).toBe(false);
  });

  it('reports no signal at all on a road with no junctions', () => {
    const lonely = new TrafficSignalController({ roads: [CROSS[0]] });
    const result = lonely.signalAhead('east-west', { x: -50, z: 0 }, eastward, 1);
    expect(result.stop).toBe(false);
    expect(result.distance).toBe(Infinity);
  });
});
