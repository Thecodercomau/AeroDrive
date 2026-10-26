import { createRandom } from '../utilities/random.js';

/**
 * Map definitions.
 *
 * Each map is pure data: a terrain style, a road layout, a prop theme, spawn
 * points, and named landmarks. `World` and `PropField` turn that data into a
 * playable place, which keeps "what the world is" separate from "how the world
 * is built".
 *
 * Road control points are generated from small parametric loops rather than
 * thousands of hard-coded numbers, so the layouts stay readable and tweakable.
 *
 * ## Landforms, bridges and tunnels
 *
 * The noise fields generate scenery, not civil engineering: their features are
 * hundreds of metres wide, so a road graded against them simply follows them and
 * there is never a place where a road is buried under a hill or spans a gap.
 * A **landform** is one deliberate feature at the 100–250 m scale — a ridge, a
 * headland, a gorge — which is the scale a bridge or a tunnel needs. Roads then
 * *declare* that they want a structure and the terrain decides where it goes
 * (see `src/roads/structures.js`), so the two are never out of step: move a road
 * and the bridge follows it, and a road with nothing to span gets nothing but a
 * console warning rather than a bridge standing on flat ground.
 */

/** A gently wobbling closed loop — the backbone of most maps. */
function loopRoad({ radius, points = 16, wobble = 0.24, seed = 1, scaleX = 1, scaleZ = 1 }) {
  const rand = createRandom(seed);
  const out = [];
  for (let i = 0; i < points; i++) {
    const angle = (i / points) * Math.PI * 2;
    const r = radius * (1 + (rand() - 0.5) * wobble * 2);
    out.push({ x: Math.cos(angle) * r * scaleX, z: Math.sin(angle) * r * scaleZ });
  }
  return out;
}

/**
 * A landform laid ACROSS a road, so the road is guaranteed to cross it.
 *
 * Hand-typed coordinates for a ridge or a gorge would have to be kept in step
 * with a road whose points come out of a generator — and the road wins: if it
 * misses the feature by 60 m, the bridge or tunnel that was asked for simply
 * does not appear. Deriving the feature from the road's own geometry means the
 * two cannot drift apart. The feature runs perpendicular to the road, so the
 * road crosses it square on rather than at a glancing angle that would halve the
 * effective width.
 *
 * @param {Array<{x:number,z:number}>} points Road control points.
 * @param {{at?:number, width:number, height:number, length?:number}} options
 */
function landformAcross(points, { at = 0.5, width, height, length = 600 }) {
  const index = Math.max(0, Math.min(points.length - 1, Math.round(at * (points.length - 1))));
  const before = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 1)];
  const centre = points[index];
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const span = Math.hypot(dx, dz) || 1;
  const px = -dz / span;
  const pz = dx / span;
  return {
    from: { x: centre.x - px * (length / 2), z: centre.z - pz * (length / 2) },
    to: { x: centre.x + px * (length / 2), z: centre.z + pz * (length / 2) },
    width,
    height,
  };
}

/**
 * A position on a road's control points, and the direction of travel there.
 *
 * For props that have to end up *beside a specific road* rather than on the
 * terrain in general — a jump ramp, which is useless unless it is level, on the
 * approach to something, and pointing the way a car arrives. A Catmull-Rom road
 * passes through its control points, so a point taken from them is on the road,
 * and the verge beside it is flattened to the road's grade before props are
 * placed. Deriving the coordinate from the road means moving the road moves the
 * ramp with it.
 *
 * @param {Array<{x:number,z:number}>} points Road control points.
 * @param {{at?:number, offset?:number}} [options] `at` is a fraction along the
 *   road; `offset` is metres to the left of travel (negative goes right).
 */
function rampOnRoad(points, { at = 0.5, offset = 0 } = {}) {
  const index = Math.max(0, Math.min(points.length - 1, Math.round(at * (points.length - 1))));
  const before = points[Math.max(0, index - 1)];
  const after = points[Math.min(points.length - 1, index + 1)];
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const length = Math.hypot(dx, dz) || 1;
  return {
    // Left of travel, matching `lateralVectors` in the structure builder.
    x: points[index].x + (-dz / length) * offset,
    z: points[index].z + (dx / length) * offset,
    heading: Math.atan2(dx, dz),
  };
}

/**
 * A point on another road's own control points.
 *
 * A road that has to *join* a road rather than merely sit near it has to start
 * on that road's geometry. A Catmull-Rom road passes through its control
 * points, so a control point of one road is a point on its surface, and a spur
 * that begins there meets it tarmac-to-tarmac instead of leaving a strip of
 * grass between the two. Deriving the coordinate rather than typing it means
 * moving the parent road moves the junction with it.
 *
 * `tools/probe-road-connectivity.mjs` is what checks this: it reports any road
 * that is a separate piece of network from the rest of its map.
 *
 * @param {Array<{x:number,z:number}>} points The road to join.
 * @param {number} index Which of its control points to use.
 */
function roadPoint(points, index) {
  const at = Math.max(0, Math.min(points.length - 1, Math.round(index)));
  return { x: points[at].x, z: points[at].z };
}

/** A serpentine road crossing the map, with optional hairpin clusters. */
function passRoad({ from, to, bends = 6, amplitude = 160, seed = 2 }) {
  const rand = createRandom(seed);
  const out = [];
  for (let i = 0; i <= bends; i++) {
    const t = i / bends;
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    // Push each control point perpendicular to the overall direction.
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length;
    const nz = dx / length;
    const offset = Math.sin(t * Math.PI * 2.4) * amplitude + (rand() - 0.5) * amplitude * 0.6;
    out.push({ x: x + nx * offset, z: z + nz * offset });
  }
  return out;
}

/**
 * A closed elliptical ring with a little radial wobble: a beltway.
 *
 * Not a circle and not a rectangle — a real bypass bulges around the built-up
 * area it avoids, and the wobble keeps it from reading as a drawn ellipse.
 * `centre` is passed rather than assumed to be the origin because a beltway is
 * almost never concentric with the city it rings.
 */
function ringRoad({ centre, rx, rz, points = 16, wobble = 0.05, seed = 1, phase = 0 }) {
  const rand = createRandom(seed);
  const out = [];
  for (let i = 0; i < points; i++) {
    const angle = phase + (i / points) * Math.PI * 2;
    const jitter = 1 + (rand() - 0.5) * wobble * 2;
    out.push({
      x: centre.x + Math.cos(angle) * rx * jitter,
      z: centre.z + Math.sin(angle) * rz * jitter,
    });
  }
  return out;
}

/**
 * An open arc of a ring — a residential crescent.
 *
 * The shape that separates a suburb from a city grid is that its streets stop:
 * they curve, and they have two ends. Two concentric crescents joined by a short
 * link read as an estate, and no three of its streets cross at one point.
 *
 * @param {{centre:{x:number,z:number}, rx:number, rz:number, start:number,
 *          end:number, points?:number, wobble?:number, seed?:number}} options
 *   `start`/`end` are angles in radians.
 */
function crescentRoad({ centre, rx, rz, start, end, points = 8, wobble = 0.06, seed = 1 }) {
  const rand = createRandom(seed);
  const out = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const angle = start + (end - start) * t;
    const jitter = 1 + (rand() - 0.5) * wobble * 2;
    out.push({
      x: centre.x + Math.cos(angle) * rx * jitter,
      z: centre.z + Math.sin(angle) * rz * jitter,
    });
  }
  return out;
}

/**
 * A dead-straight run of control points.
 *
 * A Catmull-Rom curve through collinear points is a straight line, which is the
 * only acceptable shape for a runway: a curved one is not a runway.
 */
function straightRoad(from, to, { points = 4 } = {}) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 0 : i / (points - 1);
    out.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t });
  }
  return out;
}

/** Move every control point of a generated layout. */
function shiftPoints(points, dx, dz) {
  return points.map((point) => ({ x: point.x + dx, z: point.z + dz }));
}

/** A rounded-rectangle handling circuit. */
function circuitRoad({ halfX = 190, halfZ = 130, corner = 60, seed = 5 }) {
  const points = [];
  const corners = [
    { x: halfX - corner, z: halfZ - corner, start: 0 },
    { x: -(halfX - corner), z: halfZ - corner, start: Math.PI / 2 },
    { x: -(halfX - corner), z: -(halfZ - corner), start: Math.PI },
    { x: halfX - corner, z: -(halfZ - corner), start: (3 * Math.PI) / 2 },
  ];
  for (const c of corners) {
    for (let i = 0; i <= 4; i++) {
      const angle = c.start + (i / 4) * (Math.PI / 2);
      points.push({ x: c.x + Math.cos(angle) * corner, z: c.z + Math.sin(angle) * corner });
    }
  }
  void seed;
  return points;
}

// Road geometry that the landforms are derived from, so a ridge or a gorge is
// always exactly where the road it belongs to runs. Declared here, before the
// maps, because the terrain needs them as much as the roads do.
const ALPINE_LOOP = loopRoad({ radius: 720, points: 18, wobble: 0.22, seed: 11 });
const ALPINE_PASS = passRoad({
  from: { x: -820, z: -240 },
  to: { x: 760, z: 640 },
  bends: 9,
  amplitude: 190,
  seed: 12,
});
const COASTAL_MAIN = passRoad({
  from: { x: -1100, z: 700 },
  to: { x: 1080, z: -500 },
  bends: 10,
  amplitude: 230,
  seed: 21,
});
// Hoisted out of `buildRoads` because the beach access road starts on this loop,
// and a junction has to be derived from the loop rather than typed in beside it.
const COASTAL_HEADLAND = loopRoad({ radius: 340, points: 12, wobble: 0.3, seed: 22, scaleX: 1.4 });
const DESERT_DUNE_TRAIL = passRoad({
  from: { x: -760, z: 420 },
  to: { x: 260, z: 700 },
  bends: 6,
  amplitude: 140,
  seed: 31,
});
// The jump ramp: just off the dune trail's shoulder, facing along it, on the
// stretch the trail spends climbing a dune. The verge is 7.5 m from the centre
// line — set back from the carriageway, but still inside the 13 m corridor the
// road has already levelled, so the ramp sits on flat ground.
const DESERT_JUMP = rampOnRoad(DESERT_DUNE_TRAIL, { at: 0.78, offset: 7.5 });

// Hoisted so the connector below can end on one of the circuit's own control
// points rather than a typed-in coordinate that drifts when the circuit moves.
const DESERT_CIRCUIT = circuitRoad({ halfX: 220, halfZ: 150, corner: 70 });

// The dune trail and handling circuit used to be two separate road networks,
// 283 m apart. Start the link on a dune-trail control point and finish on the
// circuit's north-west corner so both joins land on an existing road surface.
const DESERT_DUNE_LINK = [
  roadPoint(DESERT_DUNE_TRAIL, 3),
  { x: -190, z: 380 },
  { x: -215, z: 285 },
  { x: -175, z: 205 },
  roadPoint(DESERT_CIRCUIT, 5),
];

/* -------------------------------------------------------------------------- */
/*                        Modern City: the new layout                         */
/* -------------------------------------------------------------------------- */

/**
 * The city's roads are laid out as named constants rather than inline in
 * `buildRoads`, because the *landforms* have to be derived from exactly the same
 * geometry. A ridge placed near the beltway by hand would drift off it the
 * moment the beltway moved, and a bridge or tunnel that misses its feature is
 * silently not built.
 */

// A four-lane bypass ringing the built-up area. Wide, fast, and the only road on
// the map that declares a tunnel: it bores through the ridge on the east side.
const CITY_BELTWAY = ringRoad({
  centre: { x: 0, z: -20 },
  rx: 560,
  rz: 470,
  points: 16,
  wobble: 0.05,
  seed: 41,
});

// A tidal creek cutting inland from the bay, crossed by the coast road on a
// viaduct. Placed where nothing else is: the harbour road is 280 m west of it,
// and the beach roads are east of it.
const CITY_COAST = [
  { x: -950, z: 860 },
  { x: -640, z: 900 },
  { x: -320, z: 930 },
  { x: 60, z: 945 },
  { x: 420, z: 935 },
  { x: 700, z: 905 },
  { x: 960, z: 850 },
];

// The runway is straight, 45 m wide and 785 m long, and deliberately outside the
// beltway — an airfield inside a ring road would have nowhere to put its
// approach. It declares a wider grading corridor than any other road, because a
// ribbon is flat across its whole width and 22.5 m of half-width would otherwise
// overhang ground the flattening pass never touched.
const CITY_RUNWAY = straightRoad({ x: -1080, z: -350 }, { x: -430, z: -790 });

// A residential estate: one curving loop of streets with two crescents off it,
// plus a drive back to the beltway.
const CITY_SUBURB_CENTRE = { x: 780, z: -380 };
const CITY_SUBURB_LOOP = shiftPoints(
  loopRoad({ radius: 155, points: 12, wobble: 0.34, seed: 71, scaleX: 1.25 }),
  CITY_SUBURB_CENTRE.x,
  CITY_SUBURB_CENTRE.z,
);

export const MAPS = [
  {
    id: 'alpine-valley',
    name: 'Alpine Valley',
    tagline: 'Mountain passes, forests, and a lake-side loop.',
    description:
      'The flagship map: a 4.5 km valley loop threading between ridged peaks, with a winding mountain pass, forest sections and scenic overlooks. Best all-round driving.',
    terrain: {
      style: 'alpine',
      seed: 'alpine-valley-2026',
      size: 2400,
      resolution: 176,
      // A mountain barrier that the summit pass bores through, and a ravine that
      // the valley loop crosses on a viaduct. Both are laid across their road, so
      // the crossing is certain; where along the road they land, and how long the
      // bridge or tunnel is, is then up to the terrain.
      landforms: [
        landformAcross(ALPINE_PASS, { at: 0.5, width: 115, height: 44, length: 1400 }),
        landformAcross(ALPINE_LOOP, { at: 0.36, width: 165, height: -46, length: 700 }),
      ],
    },
    recommendedVehicle: 'coupe',
    landmarks: [
      { id: 'alpine-lake', name: 'Mirror Lake', x: 250, z: -420 },
      { id: 'alpine-summit', name: 'Eagle Summit', x: -640, z: 520 },
      { id: 'alpine-tunnel', name: 'Ravenscut Gap', x: 120, z: 610 },
      { id: 'alpine-village', name: 'Hollow Vale Village', x: -300, z: -180 },
      { id: 'alpine-overlook', name: 'Valley Overlook', x: 700, z: 180 },
    ],
    spawnPoints: [
      // Spawns sit ON their road rather than beside it, so the level pad carved
      // at build time lands flush with the asphalt and the car always starts on
      // a drivable surface.
      { id: 'alpine-garage', name: 'Hollow Vale Garage', x: -430, z: -310, heading: 2.15 },
      { id: 'alpine-lakehead', name: 'Lakehead Pull-in', x: 250, z: -420, heading: 2.4 },
      { id: 'alpine-summit-park', name: 'Summit Car Park', x: -645, z: 512, heading: -2.3 },
    ],
    props: {
      trees: 1500,
      rocks: 420,
      buildings: 22,
      streetlights: 0,
      signs: 40,
      parkedCars: 0,
      density: 1,
    },
    // Services are declared as *references to spawn points* rather than as their
    // own coordinates. Spawn points are asserted by tests/spawn.test.js to sit on
    // a road, flat and correctly oriented, so a garage defined this way cannot
    // repeat the bug where a garage ended up 280 m from the nearest tarmac.
    services: [
      { spawnId: 'alpine-garage', type: 'garage', name: 'Hollow Vale Garage' },
      { spawnId: 'alpine-summit-park', type: 'recovery', name: 'Eagle Summit Recovery' },
      { spawnId: 'alpine-lakehead', type: 'fuel', name: 'Lakehead Fuel Stop' },
    ],
    ambience: 'forest',
    fog: { colour: 0x9fb6cd, near: 120, far: 1500 },
    sky: { top: 0x3f7fc4, bottom: 0xc9dced, sun: 0xfff2d5 },
    buildRoads() {
      return [
        {
          name: 'valley-loop',
          points: ALPINE_LOOP,
          width: 10,
          closed: true,
          structures: [{ type: 'bridge' }, { type: 'tunnel' }],
        },
        {
          name: 'summit-pass',
          points: ALPINE_PASS,
          width: 8.5,
          structures: [{ type: 'tunnel' }, { type: 'bridge' }],
        },
        {
          // A spur off the loop's south side down to the lake, starting on the
          // loop's own control point nearest the lake — 75 m out, which is the
          // closest the loop comes — so the pull-in is reached off the loop
          // rather than from a road that stops in the trees 140 m short of it.
          name: 'lakeside-spur',
          points: [
            roadPoint(ALPINE_LOOP, 15),
            { x: 260, z: -470 },
            { x: 250, z: -420 },
            { x: 130, z: -320 },
            { x: -40, z: -280 },
          ],
          width: 7.5,
        },
        {
          name: 'forest-trail',
          points: passRoad({
            from: { x: 540, z: -120 },
            to: { x: 320, z: 540 },
            bends: 6,
            amplitude: 90,
            seed: 13,
          }),
          width: 5.5,
          surface: 'dirt',
        },
        {
          // Hollow Vale Village sits off the main loop, so it needs its own road
          // in. Without it the village is an unreachable landmark and its garage
          // spawn strands the player 280 m from the nearest drivable surface.
          // It starts *on* the loop for the same reason: 20 m short of it is
          // still a road the village garage cannot be driven to from.
          name: 'village-spur',
          points: [
            roadPoint(ALPINE_LOOP, 11),
            { x: -540, z: -420 },
            { x: -430, z: -310 },
            { x: -330, z: -215 },
            { x: -250, z: -150 },
          ],
          width: 8,
        },
        {
          // And a short climb from the loop up to the Eagle Summit car park.
          name: 'summit-spur',
          points: [
            { x: -586, z: 449 },
            { x: -620, z: 480 },
            { x: -645, z: 512 },
            { x: -660, z: 560 },
          ],
          width: 7,
        },
      ];
    },
  },

  {
    id: 'coastal-highway',
    name: 'Coastal Highway',
    tagline: 'Long ocean straights and cliff-side curves.',
    description:
      'A fast coastal road hugging a shoreline, with long ocean views, a beach section and a climb into the headland. Suited to high-speed cars.',
    terrain: {
      style: 'coastal',
      seed: 'coastal-highway-2026',
      size: 2800,
      resolution: 176,
      // A headland the highway bores through, and an inlet it crosses on a
      // viaduct — the two features the map brief asks for by name.
      landforms: [
        landformAcross(COASTAL_MAIN, { at: 0.5, width: 130, height: 52, length: 1300 }),
        landformAcross(COASTAL_MAIN, { at: 0.72, width: 185, height: -44, length: 700 }),
      ],
    },
    recommendedVehicle: 'supercar',
    landmarks: [
      { id: 'coast-lighthouse', name: 'Cape Verity Lighthouse', x: -880, z: 640 },
      { id: 'coast-beach', name: 'Sandbar Beach', x: 60, z: -820 },
      { id: 'coast-tunnel', name: 'Cliffside Overlook', x: 520, z: 120 },
      { id: 'coast-reststop', name: 'Halfway Rest Stop', x: -240, z: 380 },
    ],
    spawnPoints: [
      { id: 'coast-reststop-spawn', name: 'Halfway Rest Stop', x: -240, z: 379, heading: 2.05 },
      { id: 'coast-beach-spawn', name: 'Beach Lay-by', x: 60, z: -820, heading: 0.2 },
    ],
    props: {
      trees: 700,
      rocks: 620,
      buildings: 12,
      streetlights: 0,
      signs: 34,
      parkedCars: 0,
      density: 1,
    },
    services: [
      { spawnId: 'coast-reststop-spawn', type: 'fuel', name: 'Halfway Rest Stop' },
      { spawnId: 'coast-beach-spawn', type: 'recovery', name: 'Sandbar Beach Recovery' },
    ],
    ambience: 'coastal',
    fog: { colour: 0xaec7d6, near: 200, far: 2200 },
    sky: { top: 0x2e77b8, bottom: 0xd6e6ef, sun: 0xfff6e0 },
    buildRoads() {
      return [
        {
          name: 'coastal-main',
          points: COASTAL_MAIN,
          width: 11,
          structures: [{ type: 'tunnel' }, { type: 'bridge' }],
        },
        {
          // The beach is reached from the headland loop, and the access road
          // starts on that loop's own control point rather than 300 m away from
          // it: as a loose road it was tarmac with a beach landmark and a spawn
          // point on it that no other road reached.
          name: 'beach-access',
          points: [
            roadPoint(COASTAL_HEADLAND, 8),
            { x: 20, z: -740 },
            { x: 60, z: -820 },
            { x: 150, z: -880 },
          ],
          width: 8,
        },
        {
          name: 'headland-loop',
          points: COASTAL_HEADLAND,
          width: 8,
          closed: true,
        },
        {
          // The rest stop is set back from the highway for the ocean view, so it
          // needs its own access road — otherwise its spawn is a 50 m drive over
          // open grass before the player reaches tarmac.
          name: 'reststop-access',
          points: [
            { x: -285, z: 357 },
            { x: -268, z: 366 },
            { x: -248, z: 374 },
            { x: -228, z: 382 },
          ],
          width: 7,
        },
      ];
    },
  },

  {
    id: 'modern-city',
    name: 'Modern City',
    tagline: 'A ring road, an airfield, suburbs and a bay with beaches.',
    description:
      'A coastal metropolis: a bypass looping the built-up area and boring through Eastgate Ridge, a downtown of avenues crossed by a diagonal, a curving suburban estate, an airfield with a drivable runway, and a shore road out to the beaches on the bay. The busiest of the four maps.',
    terrain: {
      style: 'city',
      seed: 'modern-city-2026',
      size: 2600,
      resolution: 192,
      // Two landforms, both derived from the road that has to cross them: the
      // ridge the beltway tunnels through, and the creek the coast road
      // bridges. The bay itself is a third, hand-placed feature, because a bay
      // is scenery rather than something a road crosses — it is the reason the
      // map has a shoreline at all, and it sits between z = 1040 and the southern
      // edge, which is the only place on the map nothing else wants.
      landforms: [
        // Eastgate Ridge, on the beltway's north-east arc. It is anchored to the
        // SECOND control point rather than the first on purpose: the beltway is a
        // closed loop, so control point 0 and the last sample are the same place,
        // and a feature sitting on that seam is split across both ends of the
        // sample array — the structure resolver searches consecutive samples and
        // can then never see the whole ridge, which is why the tunnel came out
        // unjustified when the ridge was anchored to point 0.
        landformAcross(CITY_BELTWAY, { at: 1 / 15, width: 115, height: 55, length: 240 }),
        landformAcross(CITY_COAST, { at: 4 / 6, width: 150, height: -45, length: 520 }),
        {
          from: { x: -1900, z: 1500 },
          to: { x: 1900, z: 1650 },
          width: 519,
          height: -60,
        },
      ],
    },
    recommendedVehicle: 'sedan',
    landmarks: [
      { id: 'city-downtown', name: 'Central Plaza', x: 0, z: 0 },
      { id: 'city-airfield', name: 'Meridian Airfield', x: -755, z: -570 },
      { id: 'city-suburb', name: 'Willowbrook Estate', x: 780, z: -380 },
      { id: 'city-beach', name: 'Cinder Beach', x: 830, z: 980 },
      { id: 'city-eastgate', name: 'Eastgate Ridge', x: 560, z: -20 },
    ],
    spawnPoints: [
      // The crossing at the middle of downtown, so the player starts on two
      // through routes rather than in a dead end.
      { id: 'city-plaza', name: 'Central Plaza', x: 0, z: 0 },
      { id: 'city-garage', name: 'Harbour Road Garage', x: 138, z: 500 },
      { id: 'city-beach-head', name: 'Cinder Beach Car Park', x: 695, z: 980 },
      { id: 'city-airfield', name: 'Meridian Apron', x: -573, z: -413 },
    ],
    props: {
      trees: 520,
      rocks: 60,
      buildings: 230,
      streetlights: 150,
      signs: 70,
      parkedCars: 130,
      density: 1,
    },
    services: [
      { spawnId: 'city-garage', type: 'garage', name: 'Harbour Road Garage' },
      { spawnId: 'city-plaza', type: 'recovery', name: 'Central Plaza Recovery' },
      { spawnId: 'city-beach-head', type: 'fuel', name: 'Cinder Beach Fuel' },
      { spawnId: 'city-airfield', type: 'recovery', name: 'Meridian Airfield Recovery' },
    ],
    ambience: 'city',
    // Haze over the bay: further out than the old grid's fog, because the sea
    // horizon is the point of the southern half of the map.
    fog: { colour: 0xc9d6dc, near: 240, far: 2400 },
    sky: { top: 0x1d6fb0, bottom: 0xe2ecf1, sun: 0xfff3d6 },
    buildRoads() {
      return [
        {
          name: 'beltway',
          points: CITY_BELTWAY,
          width: 16,
          closed: true,
          structures: [{ type: 'tunnel' }],
        },
        {
          name: 'grand-avenue',
          points: [
            { x: -490, z: 292 },
            { x: -220, z: 130 },
            { x: 40, z: -24 },
            { x: 280, z: -169 },
            { x: 490, z: -292 },
          ],
          width: 15,
        },
        // Downtown: three north-south streets crossing three east-west avenues,
        // with the diagonal laid over them.
        {
          name: 'downtown-1st',
          points: [
            { x: -210, z: -310 },
            { x: -210, z: -90 },
            { x: -210, z: 90 },
            { x: -210, z: 310 },
          ],
          width: 12,
        },
        {
          name: 'downtown-2nd',
          points: [
            { x: 0, z: -350 },
            { x: 0, z: -120 },
            { x: 0, z: 120 },
            { x: 0, z: 350 },
          ],
          width: 13,
        },
        {
          name: 'downtown-3rd',
          points: [
            { x: 215, z: -310 },
            { x: 215, z: -90 },
            { x: 215, z: 90 },
            { x: 215, z: 310 },
          ],
          width: 12,
        },
        {
          name: 'downtown-ave-a',
          points: [
            { x: -310, z: -240 },
            { x: -90, z: -240 },
            { x: 90, z: -240 },
            { x: 310, z: -240 },
          ],
          width: 12,
        },
        {
          name: 'downtown-ave-b',
          points: [
            { x: -340, z: 0 },
            { x: -100, z: 0 },
            { x: 100, z: 0 },
            { x: 340, z: 0 },
          ],
          width: 14,
        },
        {
          name: 'downtown-ave-c',
          points: [
            { x: -310, z: 240 },
            { x: -90, z: 240 },
            { x: 90, z: 240 },
            { x: 310, z: 240 },
          ],
          width: 12,
        },
        // The only way from downtown to the shore, so it crosses most of the
        // map's other roads on the way.
        {
          name: 'harbour-road',
          points: [
            { x: 120, z: -320 },
            { x: 128, z: -80 },
            { x: 132, z: 180 },
            { x: 138, z: 500 },
            { x: 144, z: 810 },
            { x: 145, z: 942 },
          ],
          width: 11,
        },
        {
          name: 'coast-boulevard',
          points: CITY_COAST,
          width: 12,
          structures: [{ type: 'bridge' }],
        },
        {
          name: 'beach-access',
          points: [
            { x: 700, z: 905 },
            { x: 695, z: 980 },
            { x: 680, z: 1050 },
            { x: 670, z: 1070 },
          ],
          width: 8,
        },
        {
          // The promenade loop is deliberately pushed up against the coast
          // boulevard rather than left as an island of tarmac beside it: centred
          // 8 m towards the road, its northern arc crosses the boulevard and the
          // junction is real tarmac-to-tarmac, where 10 m further south it was a
          // loop separated from the only road that reaches it by a strip of sand.
          name: 'beach-promenade',
          points: shiftPoints(
            loopRoad({ radius: 75, points: 10, wobble: 0.2, seed: 72, scaleX: 1.15 }),
            828,
            972,
          ),
          width: 7,
          closed: true,
        },
        // The airfield: a runway, a taxiway that joins it, an apron loop, and the
        // access road from the beltway.
        {
          name: 'runway-14',
          points: CITY_RUNWAY,
          width: 45,
          corridor: 27,
          blend: 16,
        },
        {
          name: 'taxiway-alpha',
          points: [
            { x: -723, z: -390 },
            { x: -760, z: -465 },
            { x: -796, z: -542 },
          ],
          width: 14,
        },
        {
          name: 'terminal-apron',
          points: [
            { x: -723, z: -383 },
            { x: -648, z: -363 },
            { x: -573, z: -383 },
            { x: -573, z: -443 },
            { x: -648, z: -463 },
            { x: -723, z: -443 },
          ],
          width: 20,
          closed: true,
        },
        {
          name: 'airfield-link',
          points: [
            { x: -526, z: -181 },
            { x: -560, z: -260 },
            { x: -590, z: -340 },
            { x: -573, z: -400 },
          ],
          width: 12,
        },
        // Willowbrook: a curving loop, two crescents off it, and a drive back to
        // the beltway. Nothing here is on a grid.
        {
          name: 'willowbrook-loop',
          points: CITY_SUBURB_LOOP,
          width: 8,
          closed: true,
        },
        {
          name: 'willowbrook-drive',
          points: [
            { x: 429, z: -322 },
            { x: 500, z: -370 },
            { x: 550, z: -410 },
            { x: 598, z: -433 },
          ],
          width: 10,
        },
        {
          name: 'willowbrook-crescent',
          points: crescentRoad({
            centre: CITY_SUBURB_CENTRE,
            rx: 250,
            rz: 205,
            start: Math.PI * 1.15,
            end: Math.PI * 1.85,
            points: 9,
            wobble: 0.05,
            seed: 73,
          }),
          width: 7,
        },
      ];
    },
  },

  {
    id: 'desert-proving-grounds',
    name: 'Desert Proving Grounds',
    tagline: 'Dunes, skid pads, and a handling circuit.',
    description:
      'An open test facility: dirt roads through the dunes, a dedicated handling circuit, a skid pad, and a long straight for speed runs. Ideal for learning a new car.',
    terrain: { style: 'desert', seed: 'desert-proving-2026', size: 2200, resolution: 160 },
    recommendedVehicle: 'offroad',
    landmarks: [
      { id: 'desert-skidpad', name: 'Skid Pad', x: -420, z: -420 },
      { id: 'desert-straight', name: 'Speed Straight', x: 640, z: 0 },
      { id: 'desert-ramp', name: 'Jump Ridge', x: DESERT_JUMP.x, z: DESERT_JUMP.z },
      { id: 'desert-dunes', name: 'High Dunes', x: -700, z: 300 },
    ],
    spawnPoints: [
      { id: 'desert-paddock', name: 'Paddock', x: -40, z: -160, heading: 0 },
      // On the paddock-link, at the entrance to the skid pad.
      { id: 'desert-skid-pad-spawn', name: 'Skid Pad Entrance', x: -300, z: -300, heading: 2.36 },
    ],
    props: {
      trees: 30,
      rocks: 520,
      buildings: 16,
      streetlights: 0,
      signs: 46,
      parkedCars: 24,
      density: 0.6,
      // The brief asks for a jump ramp, and "Jump Ridge" is a named landmark,
      // so the ramp is declared rather than scattered: a random ramp points
      // somewhere useless. See `generateProps`.
      ramps: [{ ...DESERT_JUMP }],
    },
    services: [
      { spawnId: 'desert-paddock', type: 'garage', name: 'Paddock Service Bay' },
      { spawnId: 'desert-skid-pad-spawn', type: 'recovery', name: 'Skid Pad Recovery' },
    ],
    ambience: 'desert',
    fog: { colour: 0xd8c49a, near: 150, far: 2000 },
    sky: { top: 0x3f7fc4, bottom: 0xf2ddb4, sun: 0xfff0c0 },
    buildRoads() {
      return [
        {
          name: 'handling-circuit',
          points: DESERT_CIRCUIT,
          width: 12,
          closed: true,
          surface: 'asphalt',
        },
        {
          name: 'speed-straight',
          points: [
            { x: -360, z: 40 },
            { x: 0, z: 20 },
            { x: 380, z: 0 },
            { x: 760, z: -20 },
          ],
          width: 14,
        },
        {
          name: 'dune-trail',
          points: DESERT_DUNE_TRAIL,
          width: 6,
          surface: 'dirt',
        },
        {
          name: 'dune-link',
          points: DESERT_DUNE_LINK,
          width: 7,
          surface: 'dirt',
        },
        {
          name: 'paddock-link',
          points: [
            { x: -40, z: -160 },
            { x: -160, z: -200 },
            { x: -300, z: -300 },
            { x: -420, z: -420 },
          ],
          width: 8,
        },
        {
          name: 'desert-drift-pad',
          points: [
            { x: -420, z: -420 },
            { x: -365, z: -450 },
            { x: -340, z: -510 },
            { x: -365, z: -570 },
            { x: -420, z: -590 },
            { x: -475, z: -570 },
            { x: -500, z: -510 },
            { x: -475, z: -450 },
          ],
          width: 16,
          closed: true,
          surface: 'asphalt',
        },
      ];
    },
  },
];

export const MAP_IDS = MAPS.map((map) => map.id);

const BY_ID = new Map(MAPS.map((map) => [map.id, map]));

export function getMap(id) {
  return BY_ID.get(id) ?? null;
}

export function defaultMapId() {
  return MAPS[0].id;
}
