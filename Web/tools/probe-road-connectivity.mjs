/**
 * Does every named place on a map have a road to it?
 *
 * A map can look right and still be a set of islands: a road that stops 10 m
 * short of the road that leads to it is invisible on the world map, invisible in
 * a screenshot, and only noticed when a player drives to the place the map
 * promised and has to cross a strip of sand to reach it. This builds the real
 * road network for a map, joins roads whose *surfaces* meet, and reports which
 * component each landmark and spawn point ends up in.
 *
 * Two roads are joined when their centre lines pass within the sum of their
 * half-widths — that is, where one's asphalt actually touches the other's. Set
 * `MARGIN` to allow a few metres of slack and see how much of the network hangs
 * on a near miss:
 *
 *   node tools/probe-road-connectivity.mjs                 # the strict test
 *   MARGIN=5 node tools/probe-road-connectivity.mjs        # with 5 m of slack
 *   node tools/probe-road-connectivity.mjs alpine-valley
 *
 * Exits non-zero when any place is unreachable, so it can be used as a check.
 */
import { PhysicsWorld } from '../src/physics/PhysicsWorld.js';
import { World } from '../src/world/World.js';
import { defaultMapId, getMap } from '../src/world/maps.js';

const mapId = process.argv[2] ?? defaultMapId();
const map = getMap(mapId);
if (!map) throw new Error(`no such map: ${mapId}`);
const margin = Number(process.env.MARGIN ?? 0);

const physics = new PhysicsWorld();
await physics.init();
const world = new World({ physics, mapId, vegetationDensity: 0 });
world.build();

// `road.points` is the raw control polygon; the road the player drives is
// `road.centreline`, which is also what the mesh and the collider are built
// from. Measuring the control polygon instead would report junctions that do
// not exist and miss ones that do.
const roads = world.roads.roads.map((road) => ({
  name: road.name,
  width: road.width ?? 10,
  points: (road.centreline ?? road.points).map((p) => ({ x: p.x, z: p.z })),
}));

const parent = roads.map((_, i) => i);
const find = (i) => {
  let root = i;
  while (parent[root] !== root) root = parent[root];
  while (parent[i] !== root) {
    const next = parent[i];
    parent[i] = root;
    i = next;
  }
  return root;
};
const union = (a, b) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[rb] = ra;
};

/** Distance from a point to a segment, in metres. */
function pointToSegment(px, pz, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSq));
  return Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
}

/**
 * Closest approach between two polylines.
 *
 * The minimum distance between two segments is attained at an endpoint of one
 * of them, so testing every vertex against the other road's segments is exact
 * and needs no segment-to-segment case analysis.
 */
function roadGap(a, b) {
  let best = Infinity;
  let at = null;
  for (let i = 0; i < a.points.length - 1; i++) {
    for (let j = 0; j < b.points.length - 1; j++) {
      for (const [point, segment] of [
        [a.points[i], [b.points[j], b.points[j + 1]]],
        [b.points[j], [a.points[i], a.points[i + 1]]],
      ]) {
        const distance = pointToSegment(point.x, point.z, segment[0], segment[1]);
        if (distance < best) {
          best = distance;
          at = { x: point.x, z: point.z };
        }
      }
    }
  }
  return { gap: best, at };
}

const joins = [];
for (let i = 0; i < roads.length; i++) {
  for (let j = i + 1; j < roads.length; j++) {
    const { gap, at } = roadGap(roads[i], roads[j]);
    if (gap <= (roads[i].width + roads[j].width) / 2 + margin) {
      union(i, j);
      joins.push({
        a: roads[i].name,
        b: roads[j].name,
        gap: +gap.toFixed(1),
        at: `${at.x.toFixed(0)}, ${at.z.toFixed(0)}`,
      });
    }
  }
}

const components = new Map();
roads.forEach((road, i) => {
  const root = find(i);
  if (!components.has(root)) components.set(root, []);
  components.get(root).push(road.name);
});
const ranked = [...components.entries()].sort((a, b) => b[1].length - a[1].length);

console.info(`\n${map.name} (${mapId}) — ${roads.length} roads, ${joins.length} junctions`);
console.info(
  ranked.length === 1
    ? `network: fully connected${margin ? `, ${margin} m of slack` : ''}`
    : `network: ${ranked.length} disconnected pieces${margin ? `, ${margin} m of slack` : ''}`,
);
ranked.forEach(([, names], index) => {
  const label = index === 0 ? 'largest' : `piece ${index + 1}`;
  if (index === 0) {
    console.info(`  ${label}: ${names.join(', ')}`);
    return;
  }
  // How far is this piece from the network, and where? A spur that stops two
  // metres short of the road it belongs to is a different bug from a trail a
  // hundred metres out in the dunes, and the fix is different too.
  let closest = { gap: Infinity, a: null, b: null, at: null };
  for (const name of names) {
    const from = roads.find((road) => road.name === name);
    for (const otherName of ranked[0][1]) {
      const to = roads.find((road) => road.name === otherName);
      const { gap, at } = roadGap(from, to);
      if (gap < closest.gap) closest = { gap, a: name, b: otherName, at };
    }
  }
  console.info(
    `  ${label}: ${names.join(', ')} — nearest road in the network: ${closest.b}, ` +
      `${closest.gap.toFixed(1)} m away at ${closest.at.x.toFixed(0)}, ${closest.at.z.toFixed(0)}`,
  );
});

function nearestRoad(x, z) {
  let best = { name: null, distance: Infinity, index: -1 };
  roads.forEach((road, index) => {
    for (let i = 0; i < road.points.length - 1; i++) {
      const distance = pointToSegment(x, z, road.points[i], road.points[i + 1]);
      if (distance < best.distance) best = { name: road.name, distance, index };
    }
  });
  return best;
}

console.info('\ncan you drive there?');
let unreachable = 0;
const places = [
  ...map.landmarks.map((place) => ({ ...place, kind: 'landmark' })),
  ...map.spawnPoints.map((place) => ({ ...place, kind: 'spawn' })),
];
for (const place of places) {
  const near = nearestRoad(place.x, place.z);
  const reachable = find(near.index) === ranked[0][0];
  if (!reachable) unreachable++;
  console.info(
    `  ${reachable ? 'ok  ' : 'FAIL'} ${place.kind.padEnd(8)} ${place.name.padEnd(22)} ` +
      `nearest road ${String(near.name).padEnd(18)} ${near.distance.toFixed(0).padStart(4)} m` +
      `${reachable ? '' : '   (no road connects to it)'}`,
  );
}

console.info(`\n${unreachable} unreachable place(s)`);
world.dispose();
physics.dispose();
process.exit(unreachable ? 1 : 0);
