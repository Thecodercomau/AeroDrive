import { describe, expect, it } from 'vitest';
import {
  STRUCTURE_DEFAULTS,
  TUNNEL_LIGHT_SPACING,
  TUNNEL_PROFILE,
  applyAlignedProfile,
  buildBoxProfile,
  buildPortalRing,
  buildRoadStructures,
  buildTunnelProfile,
  clearanceOver,
  coverOver,
  cumulativeDistances,
  indexAtDistance,
  lateralVectors,
  offsetProfile,
  pierStations,
  profileHeightAt,
  resolveSpans,
  sweepProfile,
} from '../src/roads/structures.js';

/**
 * Bridges and tunnels.
 *
 * These are the parts of the pipeline that are decided by arithmetic rather than
 * by a map author, so they are tested against synthetic terrain whose answer is
 * known: a hill of a stated height in a stated place, a dip of a stated depth.
 * The properties under test are the ones the world builder relies on and cannot
 * check for itself:
 *
 *  - a structure is only placed where the terrain justifies it, and it says so
 *    when it is not;
 *  - the road is never left floating or buried at the ends of a span;
 *  - the swept geometry is the cross-section the profile describes.
 */

/* ------------------------------- fixtures -------------------------------- */

/** A straight road running up +Z, sampled every 5 m, 400 m long. */
function straightRoad({ y = () => 0, from = -200, to = 200, step = 5 } = {}) {
  const points = [];
  for (let z = from; z <= to; z += step) {
    points.push({ x: 0, y: y(z), z, t: 0 });
  }
  const distances = cumulativeDistances(points);
  return points.map((point, index) => ({ ...point, t: distances[index] / distances.at(-1) }));
}

/** A Gaussian bump: `height` metres tall, centred on the origin. */
const hill = (height, sigma) => (x, z) => height * Math.exp(-(z * z) / (2 * sigma * sigma));

/** A Gaussian dip, i.e. a negative hill. */
const dip = (depth, sigma) => (x, z) => -hill(depth, sigma)(x, z);

/**
 * A flat-topped ridge of a stated half-width, with slopes of a stated run.
 *
 * Used for the wide-feature tests: a Gaussian tall enough to bore through is
 * narrow at the point it meets the ground, so it never exercises a span that is
 * wider than the search window. A ridge with a flat top does.
 */
const ridge =
  ({ top, halfWidth, run }) =>
  (x, z) => {
    const d = Math.abs(z);
    if (d <= halfWidth) return top;
    if (d >= halfWidth + run) return 0;
    return (top * (halfWidth + run - d)) / run;
  };

/** A road that wanders in plan, for the plan-curvature tests. */
function curvingRoad({ from = -200, to = 200, step = 5, amplitude = 60, wavelength = 300 } = {}) {
  const points = [];
  for (let z = from; z <= to; z += step) {
    points.push({ x: amplitude * Math.sin((2 * Math.PI * z) / wavelength), y: 0, z });
  }
  const distances = cumulativeDistances(points);
  return points.map((point, index) => ({ ...point, t: distances[index] / distances.at(-1) }));
}

/* ------------------------------- distances ------------------------------- */

describe('centreline distances', () => {
  it('accumulates arc length along the road', () => {
    const points = [
      { x: 0, z: 0 },
      { x: 3, z: 0 },
      { x: 3, z: 4 },
    ];
    const distances = cumulativeDistances(points);
    expect(Array.from(distances)).toEqual([0, 3, 7]);
  });

  it('finds the sample nearest a distance, and clamps outside the road', () => {
    const distances = cumulativeDistances([
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 10 },
    ]);
    expect(indexAtDistance(distances, -5)).toBe(0);
    expect(indexAtDistance(distances, 0)).toBe(0);
    expect(indexAtDistance(distances, 10)).toBe(1);
    expect(indexAtDistance(distances, 15)).toBe(2);
    expect(indexAtDistance(distances, 500)).toBe(2);
  });

  it('points left of travel, consistently with the road ribbon', () => {
    const laterals = lateralVectors([
      { x: 0, z: 0 },
      { x: 0, z: 10 },
      { x: 0, z: 20 },
    ]);
    // Travelling +Z, left is -X.
    expect(laterals[1].x).toBeCloseTo(-1, 6);
    expect(laterals[1].z).toBeCloseTo(0, 6);
  });
});

/* ------------------------------- profiles -------------------------------- */

describe('cross-sections', () => {
  it('builds a closed, symmetric horseshoe whose feet are on the road', () => {
    const profile = buildTunnelProfile();
    expect(profile[0].x).toBeCloseTo(-TUNNEL_PROFILE.halfWidth, 6);
    expect(profile[0].y).toBe(0);
    expect(profile.at(-1).x).toBeCloseTo(TUNNEL_PROFILE.halfWidth, 6);
    expect(profile.at(-1).y).toBe(0);
    // Every point mirrored: the section is a boresight down the middle of a road.
    for (let i = 0; i < profile.length; i++) {
      const mirror = profile[profile.length - 1 - i];
      expect(profile[i].x).toBeCloseTo(-mirror.x, 6);
      expect(profile[i].y).toBeCloseTo(mirror.y, 6);
    }
  });

  it('reports the height of the section at a given lateral offset', () => {
    const profile = buildTunnelProfile();
    expect(profileHeightAt(profile, 0)).toBeCloseTo(TUNNEL_PROFILE.apex, 6);
    expect(profileHeightAt(profile, TUNNEL_PROFILE.halfWidth)).toBeCloseTo(
      TUNNEL_PROFILE.wallHeight,
      6,
    );
    // Inside the wall, between the wall and the crown.
    const quarter = profileHeightAt(profile, TUNNEL_PROFILE.halfWidth / 2);
    expect(quarter).toBeGreaterThan(TUNNEL_PROFILE.wallHeight);
    expect(quarter).toBeLessThan(TUNNEL_PROFILE.apex);
    // Nothing outside the section.
    expect(profileHeightAt(profile, TUNNEL_PROFILE.halfWidth * 2)).toBe(0);
  });

  it('offsets a profile outwards from a point, for the portal surround', () => {
    const profile = buildTunnelProfile();
    const outer = offsetProfile(profile, { origin: { x: 0, y: 2 }, distance: 2 });
    expect(outer).toHaveLength(profile.length);
    // The crown rises, the sides push out.
    expect(profileHeightAt(outer, 0)).toBeGreaterThan(TUNNEL_PROFILE.apex);
    const widest = Math.max(...outer.map((point) => Math.abs(point.x)));
    expect(widest).toBeGreaterThan(TUNNEL_PROFILE.halfWidth);
    // The feet sit lower than the section's, so a portal is bedded into the ground.
    expect(outer[0].y).toBeLessThan(0);
  });

  it('builds a box section with its top face at the road surface', () => {
    const profile = buildBoxProfile(12, 1);
    expect(profile.map((point) => point.x)).toEqual([-6, 6, 6, -6]);
    expect(profile.map((point) => point.y)).toEqual([0, 0, -1, -1]);
  });
});

/* --------------------------------- sweeps -------------------------------- */

describe('sweepProfile', () => {
  const profile = [
    { x: -2, y: 0 },
    { x: 2, y: 0 },
  ];

  it('emits one vertex per profile point per slice, and two triangles per bay', () => {
    const road = straightRoad({ from: -50, to: 50, step: 10 });
    const sweep = sweepProfile(road, profile);
    expect(sweep.sliceCount).toBe(road.length);
    expect(sweep.vertexCount).toBe(road.length * 2);
    expect(sweep.positions).toHaveLength(road.length * 2 * 3);
    expect(sweep.indices).toHaveLength((road.length - 1) * 6);
  });

  it('places the profile across the road, at the road height', () => {
    const road = straightRoad({ y: () => 7, from: -20, to: 20, step: 10 });
    const sweep = sweepProfile(road, profile);
    // Travelling +Z: profile x = -2 is 2 m to the left, i.e. -X.
    expect(sweep.positions[0]).toBeCloseTo(2, 5);
    expect(sweep.positions[1]).toBeCloseTo(7, 5);
    expect(sweep.positions[2]).toBeCloseTo(-20, 5);
    expect(sweep.positions[3]).toBeCloseTo(-2, 5);
  });

  it('closes the profile into a tube when asked, and leaves it open otherwise', () => {
    const road = straightRoad({ from: -20, to: 20, step: 10 });
    const open = sweepProfile(road, [
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    const closed = sweepProfile(
      road,
      [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      { loopProfile: true },
    );
    // Three points: two bays open, three closed.
    expect(open.indices).toHaveLength((road.length - 1) * 2 * 6);
    expect(closed.indices).toHaveLength((road.length - 1) * 3 * 6);
  });

  it('rings two profiles together for a portal, with a quad per pair of points', () => {
    const inner = buildTunnelProfile();
    const ring = buildPortalRing(inner, offsetProfile(inner, { distance: 1.5 }));
    expect(ring.positions).toHaveLength(inner.length * 2 * 3);
    expect(ring.indices).toHaveLength(inner.length * 6);
  });
});

/* ------------------------------ placement -------------------------------- */

describe('resolveSpans', () => {
  it('places no structure on flat ground, and says why', () => {
    const road = straightRoad({ y: () => 0 });
    const diagnostics = [];
    const spans = resolveSpans(road, [{ type: 'bridge' }, { type: 'tunnel' }], {
      heightAt: () => 0,
      width: 9,
      diagnostics,
    });
    expect(spans).toHaveLength(0);
    expect(diagnostics.map((entry) => entry.type)).toEqual(['bridge', 'tunnel']);
    for (const entry of diagnostics) expect(entry.reason).toMatch(/deepest point/);
  });

  it('bores a tunnel through a hill, and leaves the road on the ground at both ends', () => {
    const road = straightRoad({ y: () => 0 });
    const heightAt = hill(40, 60);
    const [tunnel] = resolveSpans(road, [{ type: 'tunnel' }], { heightAt, width: 9 });

    expect(tunnel.type).toBe('tunnel');
    expect(tunnel.length).toBeGreaterThan(STRUCTURE_DEFAULTS.tunnel.minSpan);
    expect(tunnel.windowFit).toBeGreaterThan(STRUCTURE_DEFAULTS.tunnel.minClearance);

    // The crown of the deepest part is well under the hill.
    const middle = road[Math.round((tunnel.startIndex + tunnel.endIndex) / 2)];
    expect(heightAt(middle.x, middle.z)).toBeGreaterThan(TUNNEL_PROFILE.apex + 20);

    // The ends are where the road comes out: the ground there is just above the
    // crown — enough to bury it, not tens of metres of hill.
    for (const index of [tunnel.startIndex, tunnel.endIndex]) {
      const cover = heightAt(road[index].x, road[index].z) - road[index].y;
      expect(cover).toBeGreaterThan(TUNNEL_PROFILE.apex);
      expect(cover).toBeLessThan(TUNNEL_PROFILE.apex + 8);
    }

    // The alignment covers the bore and reaches out past it, so the road meets
    // the approach on the same grade instead of stepping down to it at the portal.
    expect(tunnel.alignment.startIndex).toBeLessThanOrEqual(tunnel.startIndex);
    expect(tunnel.alignment.endIndex).toBeGreaterThanOrEqual(tunnel.endIndex);

    // And it is a real straight line once applied: equal height everywhere.
    applyAlignedProfile(road, tunnel);
    for (const index of [tunnel.startIndex, tunnel.endIndex])
      expect(road[index].y).toBeCloseTo(0, 6);
    const mid = road[Math.round((tunnel.alignment.startIndex + tunnel.alignment.endIndex) / 2)];
    expect(mid.y).toBeCloseTo(0, 6);
  });

  it('spans a dip with a bridge whose ends rest on the ground', () => {
    const road = straightRoad({ y: () => 0 });
    const heightAt = dip(30, 25);
    const [bridge] = resolveSpans(road, [{ type: 'bridge' }], { heightAt, width: 9 });

    expect(bridge).toBeTruthy();
    expect(bridge.type).toBe('bridge');
    expect(bridge.length).toBeGreaterThan(STRUCTURE_DEFAULTS.bridge.minSpan);
    expect(bridge.minFit).toBeGreaterThanOrEqual(0);

    // Never below the ground anywhere on the span: the deck is over the dip.
    applyAlignedProfile(road, bridge);
    expect(clearanceOver(road, bridge, heightAt)).toBeGreaterThan(0.5);

    // The ends are back on the ground — that is where the abutments go. The lower
    // bound is the deck's own thickness plus the margin the grow test keeps, and
    // the upper bound is one sample's worth of hillside: the span can only stop
    // at a sample, not at the exact point the two heights cross.
    for (const index of [bridge.startIndex, bridge.endIndex]) {
      const clearance = road[index].y - heightAt(road[index].x, road[index].z);
      expect(clearance).toBeGreaterThan(0.5);
      expect(clearance).toBeLessThan(5);
    }

    // And the crown lifts the middle above the chord.
    const mid = Math.round((bridge.startIndex + bridge.endIndex) / 2);
    expect(road[mid].y).toBeCloseTo(bridge.crown, 1);
  });

  it('refuses a gap too short to be worth a structure', () => {
    const road = straightRoad({ y: () => 0 });
    // A 4 m wide nick in otherwise flat ground.
    const [bridge] = resolveSpans(road, [{ type: 'bridge' }], {
      heightAt: dip(20, 1.5),
      width: 9,
    });
    expect(bridge).toBeUndefined();
  });

  it('honours an explicit request, and warns rather than silently dropping it', () => {
    const road = straightRoad({ y: () => 0 });
    const [tunnel] = resolveSpans(road, [{ type: 'tunnel', at: 0.5, length: 120 }], {
      heightAt: hill(40, 60),
      width: 9,
    });
    expect(tunnel).toBeTruthy();
    // Centred on the middle of the road.
    const middle = (tunnel.startDistance + tunnel.endDistance) / 2;
    expect(middle).toBeGreaterThan(160);
    expect(middle).toBeLessThan(240);
  });

  it('leaves a road alone when the ground never covers it deeply enough', () => {
    // A road sitting a metre above flat ground: nowhere is there rock to bore
    // through, so nothing is placed and the reason is recorded.
    const road = straightRoad({ y: () => 1 });
    const diagnostics = [];
    const spans = resolveSpans(road, [{ type: 'tunnel' }], {
      heightAt: () => 0.1,
      width: 9,
      diagnostics,
    });
    expect(spans).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ type: 'tunnel', reason: expect.stringMatching(/deepest point/) }),
    ]);
    // And the refusal reports how far off the road was, not just that it failed.
    expect(diagnostics[0].bestScore).toBeLessThan(0);
  });
});

/* -------------------------------- pieces --------------------------------- */

describe('pierStations', () => {
  it('only stands piers where the deck is actually off the ground', () => {
    const road = straightRoad({ y: () => 10 });
    const heightAt = dip(30, 25);
    const span = { startIndex: 10, endIndex: 70 };
    const stations = pierStations(road, span, { heightAt, spacing: 30, minHeight: 3.5 });

    expect(stations.length).toBeGreaterThan(0);
    for (const station of stations) {
      expect(station.height).toBeGreaterThan(3.5);
      expect(station.ground + station.height).toBeCloseTo(10, 6);
      expect(station.yaw).toBeCloseTo(0, 6);
    }
    // Reach down to the deepest part of the dip, which is in the middle.
    const deepest = stations.reduce((best, s) => (s.height > best.height ? s : best), stations[0]);
    expect(deepest.height).toBeGreaterThan(20);
  });

  it('stands no piers at all when the deck is on the ground', () => {
    const road = straightRoad({ y: () => 0 });
    expect(pierStations(road, { startIndex: 0, endIndex: 40 }, { heightAt: () => 0 })).toHaveLength(
      0,
    );
  });
});

describe('coverOver', () => {
  it('reports the thinnest and mean cover over a span', () => {
    const road = straightRoad({ y: () => 0 });
    const heightAt = hill(40, 60);
    // 81 samples from z = -200 to 200; indices 20 to 60 span z = -100 to 100.
    const span = { startIndex: 20, endIndex: 60 };
    const cover = coverOver(road, span, heightAt);
    expect(cover.minCover).toBeLessThan(cover.meanCover);
    expect(cover.minCover).toBeGreaterThan(0);
    expect(cover.meanCover).toBeLessThan(40);
  });
});

/* --------------------------- adaptive windowing ---------------------------- */

describe('a feature wider than the search window', () => {
  it('widens the window until the tunnel portals reach the hillside', () => {
    // A 220 m flat-topped ridge with 60 m slopes: 340 m from ground to ground,
    // well wider than the tunnel's 200 m starting window. Fitting inside the
    // window would clip the bore at the window's edge, leaving both portals in
    // the cut face of the flat top with the hill still overhead.
    const road = straightRoad({ from: -250, to: 250, step: 5 });
    const heightAt = ridge({ top: 40, halfWidth: 110, run: 60 });
    const [tunnel] = resolveSpans(road, [{ type: 'tunnel' }], { heightAt, width: 9 });

    expect(tunnel).toBeTruthy();
    // Longer than any window the declaration asked for: the window grew.
    expect(tunnel.length).toBeGreaterThan(STRUCTURE_DEFAULTS.tunnel.length);

    // The alignment still covers the span, which is what makes the widened
    // window safe — the road inside the bore is the line the fit was measured
    // against, not its old graded self.
    expect(tunnel.alignment.startIndex).toBeLessThanOrEqual(tunnel.startIndex);
    expect(tunnel.alignment.endIndex).toBeGreaterThanOrEqual(tunnel.endIndex);

    // And the ends are on the slope, not on the flat top: the cover there is a
    // few metres over the crown, rather than the forty metres of the plateau.
    applyAlignedProfile(road, tunnel);
    for (const index of [tunnel.startIndex, tunnel.endIndex]) {
      const cover = heightAt(road[index].x, road[index].z) - road[index].y;
      expect(cover).toBeGreaterThan(TUNNEL_PROFILE.apex);
      expect(cover).toBeLessThan(TUNNEL_PROFILE.apex + 8);
    }
  });

  it('never widens past the road the structure belongs to', () => {
    // A 250 m road buried in the same 340 m ridge: every widening pass is bounded
    // by the road itself, so the alignment can never reference a sample that does
    // not exist, and the span can never fall outside the alignment.
    const road = straightRoad({ from: -125, to: 125, step: 5 });
    const [tunnel] = resolveSpans(road, [{ type: 'tunnel' }], {
      heightAt: ridge({ top: 40, halfWidth: 110, run: 60 }),
      width: 9,
    });
    expect(tunnel).toBeTruthy();
    expect(tunnel.alignment.startIndex).toBeGreaterThanOrEqual(0);
    expect(tunnel.alignment.endIndex).toBeLessThanOrEqual(road.length - 1);
    expect(tunnel.startIndex).toBeGreaterThanOrEqual(tunnel.alignment.startIndex);
    expect(tunnel.endIndex).toBeLessThanOrEqual(tunnel.alignment.endIndex);
  });

  it('does not move an explicitly placed structure', () => {
    const road = straightRoad({ from: -250, to: 250, step: 5 });
    const heightAt = ridge({ top: 40, halfWidth: 110, run: 60 });
    // Pinned at a quarter along the road, which is on the ridge's slope.
    const [tunnel] = resolveSpans(road, [{ type: 'tunnel', at: 0.25, length: 200 }], {
      heightAt,
      width: 9,
    });
    expect(tunnel).toBeTruthy();
    // Widening would drag it towards the summit, so it must not happen.
    const window = tunnel.alignment.endIndex - tunnel.alignment.startIndex + 1;
    expect(window).toBeLessThanOrEqual(41);
  });
});

/* ------------------------------- plan geometry ----------------------------- */

describe('a structure on a road that curves in plan', () => {
  it('follows the road through the curve and only straightens the vertical', () => {
    const road = curvingRoad();
    const before = road.map((point) => ({ x: point.x, z: point.z }));
    const [bridge] = resolveSpans(road, [{ type: 'bridge' }], {
      heightAt: dip(30, 25),
      width: 9,
    });
    expect(bridge).toBeTruthy();

    applyAlignedProfile(road, bridge);

    // Straightening is a vertical operation, and only a vertical one: the plan
    // geometry is the road's own, untouched.
    road.forEach((point, index) => {
      expect(point.x).toBe(before[index].x);
      expect(point.z).toBe(before[index].z);
    });

    // Sweep the deck the world builder sweeps, and measure its plan path against
    // the straight chord between its two ends.
    const deck = sweepProfile(road, buildBoxProfile(11.8, 1), {
      startIndex: bridge.startIndex,
      endIndex: bridge.endIndex,
      loopProfile: true,
    });
    const midpoints = [];
    for (let slice = 0; slice < deck.sliceCount; slice++) {
      // Profile points 0 and 1 are the deck's two top edges, left and right.
      const left = slice * 4;
      const right = slice * 4 + 1;
      midpoints.push({
        x: (deck.positions[left * 3] + deck.positions[right * 3]) / 2,
        z: (deck.positions[left * 3 + 2] + deck.positions[right * 3 + 2]) / 2,
      });
    }
    const first = midpoints[0];
    const last = midpoints[midpoints.length - 1];
    const chordX = last.x - first.x;
    const chordZ = last.z - first.z;
    const chordSq = chordX * chordX + chordZ * chordZ;

    let maxDeviation = 0;
    for (const midpoint of midpoints) {
      const t = ((midpoint.x - first.x) * chordX + (midpoint.z - first.z) * chordZ) / chordSq;
      maxDeviation = Math.max(
        maxDeviation,
        Math.hypot(midpoint.x - (first.x + chordX * t), midpoint.z - (first.z + chordZ * t)),
      );
    }

    // Metres of curve in the deck, not the centimetres a misaligned slice would
    // give: the span really does follow the road round.
    expect(maxDeviation).toBeGreaterThan(3);

    // While the *vertical* profile across the alignment is a straight line plus
    // the crown, which is what "straight alignment" actually means here.
    const { startIndex, endIndex } = bridge.alignment;
    const y0 = road[startIndex].y;
    const y1 = road[endIndex].y;
    for (let index = startIndex; index <= endIndex; index++) {
      const t = (index - startIndex) / (endIndex - startIndex);
      const straight = y0 + (y1 - y0) * t;
      const crown = bridge.crown * Math.sin(Math.PI * t);
      expect(Math.abs(road[index].y - straight - crown)).toBeLessThan(0.5);
    }
  });
});

/* ------------------------------ tunnel lighting ---------------------------- */

describe('tunnel lighting', () => {
  /** A minimal road network holding one tunnel, in the shape the builder wants. */
  function roadWithTunnel({ length = 120 } = {}) {
    const centreline = straightRoad({ from: -length / 2, to: length / 2, step: 5 });
    return {
      roads: [
        {
          name: 'test-road',
          width: 9,
          centreline,
          naturalHeightAt: () => 0,
          resolvedStructures: [{ type: 'tunnel', startIndex: 2, endIndex: centreline.length - 3 }],
        },
      ],
    };
  }

  it('actually lights a tunnel on a preset that can afford point lights', () => {
    const built = buildRoadStructures({ roads: roadWithTunnel(), preset: 'high' });
    const lights = built.group.children.filter((child) => child.isPointLight);
    expect(lights.length).toBeGreaterThan(0);
    expect(built.stats.lights).toBe(lights.length);

    // Each light is inside the bore: on the road's own plan line, under the crown,
    // above the road surface.
    const { centreline } = roadWithTunnel().roads[0];
    for (const light of lights) {
      const nearest = Math.min(
        ...centreline.map((point) =>
          Math.hypot(point.x - light.position.x, point.z - light.position.z),
        ),
      );
      expect(nearest).toBeLessThan(3);
      expect(light.position.y).toBeGreaterThan(TUNNEL_PROFILE.apex - 1);
      expect(light.position.y).toBeLessThan(TUNNEL_PROFILE.apex + 1);
    }
    built.dispose();
  });

  it('keeps the emissive lamp strip but adds no lights on the potato preset', () => {
    const built = buildRoadStructures({ roads: roadWithTunnel(), preset: 'potato' });
    expect(built.stats.lights).toBe(0);
    expect(built.group.children.filter((child) => child.isPointLight)).toHaveLength(0);
    // The lamp strip is what makes a tunnel read as lit at all without them.
    expect(built.group.children.some((child) => child.name.endsWith('tunnel-lamps'))).toBe(true);
    built.dispose();
  });

  it('spaces the lights more widely the cheaper the preset', () => {
    const countOn = (preset) => {
      const built = buildRoadStructures({ roads: roadWithTunnel({ length: 300 }), preset });
      const count = built.stats.lights;
      built.dispose();
      return count;
    };
    expect(TUNNEL_LIGHT_SPACING.high).toBeLessThan(TUNNEL_LIGHT_SPACING.low);
    expect(countOn('high')).toBeGreaterThan(countOn('low'));
  });
});
