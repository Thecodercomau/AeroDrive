import { createNoise2D } from '../utilities/noise.js';
import { clamp, lerp } from '../utilities/math.js';

/**
 * Terrain height generation.
 *
 * Everything here is pure: given a style and a seed, the same terrain comes out
 * every time. That matters for three reasons — a bug is reproducible, the
 * physics heightfield and the visual mesh are guaranteed to agree because they
 * are derived from one source, and the generator can be unit-tested without a
 * browser.
 *
 * Grid layout — this is Rapier's heightfield memory order, and it is **not**
 * row-major in X. Rapier stores `heights[iz + ix * (resolution + 1)]`, i.e. the
 * fastest-varying index walks **Z** and the slower index walks **X**. The field
 * spans `size` metres centred on the origin:
 *   x = (ix / resolution - 0.5) * size
 *   z = (iz / resolution - 0.5) * size
 *
 * Getting this backwards silently transposes the whole landscape, so it is
 * asserted directly against a real Rapier heightfield in tests/terrain.test.js;
 * if a future Rapier release changes the convention that test fails loudly
 * instead of the terrain quietly rotating 90 degrees.
 */

/** Terrain styles, one per planned map. */
export const TERRAIN_STYLES = {
  alpine: {
    amplitude: 92,
    baseFrequency: 0.0016,
    octaves: 5,
    ridged: 0.68,
    // Valley carving keeps a broad drivable floor between the peaks.
    valleyStrength: 0.45,
    // Metres of fine surface detail (see `createHeightSampler`).
    roughness: 1.7,
    roughnessFrequency: 0.02,
    colours: {
      low: [0.24, 0.42, 0.2],
      mid: [0.33, 0.4, 0.24],
      high: [0.45, 0.43, 0.4],
      rock: [0.34, 0.33, 0.32],
      peak: [0.95, 0.96, 0.98],
      sand: [0.7, 0.66, 0.52],
    },
  },
  coastal: {
    amplitude: 34,
    baseFrequency: 0.0022,
    octaves: 4,
    ridged: 0.22,
    valleyStrength: 0.2,
    roughness: 0.9,
    roughnessFrequency: 0.03,
    seaLevel: -6,
    colours: {
      low: [0.78, 0.72, 0.5],
      mid: [0.36, 0.46, 0.28],
      high: [0.46, 0.45, 0.42],
      rock: [0.42, 0.4, 0.37],
      peak: [0.9, 0.9, 0.88],
      sand: [0.86, 0.79, 0.58],
    },
  },
  city: {
    amplitude: 7,
    baseFrequency: 0.0015,
    octaves: 2,
    ridged: 0.05,
    valleyStrength: 0.1,
    roughness: 0.3,
    roughnessFrequency: 0.01,
    // The city is built on a bay: a wide, shallow sea to the south. Declaring a
    // sea level does two things at once — `World` puts a water plane at it, and
    // `terrainColour` switches to the sand-to-inland gradient, so the shore is
    // beach sand and the ground greens up as it rises. Before this the map was
    // flat grey in every direction; now it has a coast.
    seaLevel: -1.5,
    colours: {
      // Bright dry sand on the shore, parkland green inland, warm grey rock on
      // the cut faces of the ridge.
      low: [0.34, 0.46, 0.29],
      mid: [0.31, 0.43, 0.26],
      high: [0.38, 0.47, 0.3],
      rock: [0.45, 0.42, 0.38],
      peak: [0.52, 0.5, 0.46],
      sand: [0.88, 0.8, 0.58],
    },
  },
  desert: {
    amplitude: 26,
    baseFrequency: 0.0026,
    octaves: 3,
    ridged: 0.12,
    valleyStrength: 0.15,
    roughness: 0.8,
    roughnessFrequency: 0.012,
    colours: {
      low: [0.85, 0.72, 0.46],
      mid: [0.79, 0.63, 0.38],
      high: [0.72, 0.56, 0.36],
      rock: [0.55, 0.44, 0.33],
      peak: [0.9, 0.82, 0.66],
      sand: [0.9, 0.78, 0.52],
    },
  },
};

/**
 * Height added by one hand-placed landform: a ridge, a gorge, a headland.
 *
 * The noise fields generate landforms hundreds of metres wide, which is the
 * right scale for scenery but the wrong scale for road engineering: a road that
 * is graded against them simply follows them, so there is never a place where a
 * road is buried under a hill or spans a gap. A landform is one deliberate
 * feature at the 100–250 m scale, which is exactly the scale a bridge or a
 * tunnel needs.
 *
 * A raised cosine across the crest: 1 at the centreline of the feature, 0 at
 * `width` metres away, smooth at both ends so there is no seam to see. A
 * negative `height` digs a gorge instead of raising a ridge, using the same
 * shape.
 *
 * @param {number} x
 * @param {number} z
 * @param {{from:{x:number,z:number}, to:{x:number,z:number}, width:number, height:number}} landform
 */
export function landformHeight(x, z, { from, to, width, height }) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSq = dx * dx + dz * dz || 1;
  const t = clamp(((x - from.x) * dx + (z - from.z) * dz) / lengthSq, 0, 1);
  const distance = Math.hypot(x - (from.x + dx * t), z - (from.z + dz * t));
  if (distance >= width) return 0;
  return height * 0.5 * (1 + Math.cos((Math.PI * distance) / width));
}

/**
 * Create a continuous height function for a terrain style.
 * @param {string} styleName
 * @param {number|string} seed
 * @param {{landforms?:Array<object>}} [options]
 */
export function createHeightSampler(styleName = 'alpine', seed = 1337, { landforms = [] } = {}) {
  const style = TERRAIN_STYLES[styleName] ?? TERRAIN_STYLES.alpine;
  const noise = createNoise2D(seed);
  const features = Array.isArray(landforms) ? landforms : [];

  const heightAt = (x, z) => {
    // Broad landform: fbm gives rolling shape, ridged gives mountain crests.
    const rolling = noise.fbm(x, z, {
      octaves: style.octaves,
      frequency: style.baseFrequency,
      lacunarity: 2.05,
      gain: 0.5,
    });
    const ridged = noise.ridged(x, z, {
      octaves: Math.max(2, style.octaves - 1),
      frequency: style.baseFrequency * 1.15,
      lacunarity: 2.2,
      gain: 0.5,
    });

    let h = lerp(rolling, ridged, style.ridged);

    // Carve a valley: push low ground lower and leave high ground alone so
    // there is always a flat-ish floor to build roads and drive on.
    const valley = Math.pow(clamp(h, 0, 1), 0.85);
    h = lerp(h, valley, 1 - style.valleyStrength);

    let height = h * style.amplitude;

    // Fine surface detail, added in METRES rather than as a fraction of the
    // landform's amplitude. Scaling this by amplitude was a real bug: on an
    // alpine map it produced ~25 m of relief every 50 m, i.e. a mountainside
    // between every pair of road samples, which made road grades impossible and
    // beached every vehicle that spawned off the flattened corridor. Detail is
    // meant to be what you feel through the suspension, not what you crash into.
    const detail = noise.fbm(x + 500, z - 500, {
      octaves: 3,
      frequency: style.roughnessFrequency,
      gain: 0.45,
    });
    height += (detail - 0.5) * style.roughness;

    for (const landform of features) height += landformHeight(x, z, landform);

    return height;
  };

  return { style, styleName, heightAt, seed, landforms: features };
}

/**
 * Sample a sampler onto a square grid.
 * @returns {{ heights: Float32Array, resolution: number, size: number }}
 */
export function sampleHeightfield(sampler, { size = 2000, resolution = 192 } = {}) {
  const n = resolution + 1;
  const heights = new Float32Array(n * n);
  for (let ix = 0; ix < n; ix++) {
    const x = gridX(ix, resolution, size);
    for (let iz = 0; iz < n; iz++) {
      const z = gridZ(iz, resolution, size);
      heights[gridIndex(ix, iz, resolution)] = sampler.heightAt(x, z);
    }
  }
  return { heights, resolution, size };
}

/**
 * Index into the height array for a grid sample.
 * `ix` indexes along +X, `iz` indexes along +Z; Z varies fastest in memory.
 */
export function gridIndex(ix, iz, resolution) {
  return iz + ix * (resolution + 1);
}

export function gridX(ix, resolution, size) {
  return (ix / resolution - 0.5) * size;
}

export function gridZ(iz, resolution, size) {
  return (iz / resolution - 0.5) * size;
}

/**
 * Bilinearly interpolated height at an arbitrary world position.
 * Used for placing props and for spawning vehicles on the ground.
 */
export function heightAtGrid(field, x, z) {
  const { heights, resolution, size } = field;
  const fx = clamp((x / size + 0.5) * resolution, 0, resolution);
  const fz = clamp((z / size + 0.5) * resolution, 0, resolution);
  const ix0 = Math.min(resolution - 1, Math.floor(fx));
  const iz0 = Math.min(resolution - 1, Math.floor(fz));
  const tx = fx - ix0;
  const tz = fz - iz0;

  const h00 = heights[gridIndex(ix0, iz0, resolution)];
  const h10 = heights[gridIndex(ix0 + 1, iz0, resolution)];
  const h01 = heights[gridIndex(ix0, iz0 + 1, resolution)];
  const h11 = heights[gridIndex(ix0 + 1, iz0 + 1, resolution)];

  return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
}

/** Approximate surface slope (0 = flat, 1 = vertical) at a world position. */
export function slopeAtGrid(field, x, z, sampleDistance = 4) {
  const h = heightAtGrid(field, x, z);
  const hx = heightAtGrid(field, x + sampleDistance, z);
  const hz = heightAtGrid(field, x, z + sampleDistance);
  const dx = (hx - h) / sampleDistance;
  const dz = (hz - h) / sampleDistance;
  const gradient = Math.hypot(dx, dz);
  // gradient 0 -> 0, gradient >= 1 -> 1
  return clamp(gradient, 0, 1);
}

/**
 * Flatten the terrain along a road corridor so the road ribbon sits on solid,
 * level ground instead of floating over bumps.
 *
 * For every grid vertex within `corridor` metres of the road centreline, the
 * height is blended toward the road's local height. Blending (rather than
 * snapping) keeps the cut-and-fill looking like an engineered road rather than
 * a trench.
 *
 * A road point may carry its own `corridor`/`blend`, which wins over the
 * argument defaults. Structure spans use this: a tunnel needs a *narrower*
 * corridor than open road so the trench it is cut into stays tight around the
 * portal, and the approaches to a bridge need a narrower one so the embankment
 * does not fill the valley the bridge is there to cross.
 *
 * @param {Float32Array} heights Mutated in place.
 * @param {{resolution:number, size:number}} field
 * @param {Array<{x:number, z:number, y:number, corridor?:number, blend?:number}>} roadPoints
 *   Road centreline samples.
 * @param {{corridor?:number, blend?:number}} [options]
 */
export function applyRoadFlattening(
  heights,
  { resolution, size },
  roadPoints,
  { corridor = 12, blend = 7 } = {},
) {
  if (!Array.isArray(roadPoints) || roadPoints.length === 0) return heights;

  /** Reach of one point: its own override, or the defaults. */
  const reachOf = (point) => (point.corridor ?? corridor) + (point.blend ?? blend);

  // Bucket the road points into a coarse spatial hash so we do not test every
  // grid vertex against every road sample (that would be ~25M distance checks
  // on a 257x257 grid, which is a visible stall during loading).
  let cellSize = Math.max(corridor + blend, 10);
  for (const point of roadPoints) cellSize = Math.max(cellSize, reachOf(point));
  const buckets = new Map();
  const keyOf = (x, z) =>
    `${Math.floor((x + size / 2) / cellSize)},${Math.floor((z + size / 2) / cellSize)}`;

  for (let index = 0; index < roadPoints.length; index++) {
    const point = roadPoints[index];
    const cx = Math.floor((point.x + size / 2) / cellSize);
    const cz = Math.floor((point.z + size / 2) / cellSize);
    // Register in the 3x3 neighbourhood so lookups only need one bucket read.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${cx + dx},${cz + dz}`;
        let list = buckets.get(key);
        if (!list) {
          list = [];
          buckets.set(key, list);
        }
        list.push(point);
      }
    }
  }

  const n = resolution + 1;
  const maxReach = Math.max(corridor + blend, ...roadPoints.map(reachOf));
  const maxReachSq = maxReach * maxReach;

  for (let ix = 0; ix < n; ix++) {
    const x = gridX(ix, resolution, size);
    for (let iz = 0; iz < n; iz++) {
      const z = gridZ(iz, resolution, size);
      const candidates = buckets.get(keyOf(x, z));
      if (!candidates) continue;

      let bestDistanceSq = Infinity;
      let bestPoint = null;
      for (const point of candidates) {
        const dx = point.x - x;
        const dz = point.z - z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestPoint = point;
        }
      }
      if (!bestPoint || bestDistanceSq > maxReachSq) continue;

      // The nearest sample decides the target height AND how far the grading
      // reaches, so a narrow structure span cannot be widened by a neighbouring
      // point that has a broader corridor.
      const pointCorridor = bestPoint.corridor ?? corridor;
      const pointBlend = bestPoint.blend ?? blend;
      const distance = Math.sqrt(bestDistanceSq);
      if (distance > pointCorridor + pointBlend) continue;

      // Full flattening inside the corridor, smooth falloff beyond it.
      const t =
        distance <= pointCorridor ? 1 : 1 - (distance - pointCorridor) / Math.max(pointBlend, 1e-6);
      const index = gridIndex(ix, iz, resolution);
      heights[index] = lerp(heights[index], bestPoint.y, clamp(t, 0, 1));
    }
  }

  return heights;
}

/**
 * Flatten a circular pad of terrain to a fixed height.
 *
 * A vehicle spawn is only usable if the ground under it is flat. Dropping a car
 * onto a slope makes it slide sideways with two wheels off the ground while the
 * engine free-revs, which reads to the player as "the game is broken". This
 * carves a level apron — a garage forecourt, a lay-by, a car park — before the
 * mesh and collider are generated, so both see the flat ground.
 *
 * The pad is blended rather than stamped so the surrounding terrain slopes
 * naturally into it instead of forming a cliff edge.
 *
 * @param {Float32Array} heights Mutated in place.
 * @param {{resolution:number, size:number}} field
 * @param {Array<{x:number, z:number, y:number}>} pads Target surface height per pad.
 * @param {{radius?:number, blend?:number}} [options]
 */
export function applySpawnPads(
  heights,
  { resolution, size },
  pads,
  { radius = 10, blend = 7 } = {},
) {
  if (!Array.isArray(pads) || pads.length === 0) return heights;

  const n = resolution + 1;
  const maxDistance = radius + blend;
  const maxDistanceSq = maxDistance * maxDistance;

  for (let ix = 0; ix < n; ix++) {
    const x = gridX(ix, resolution, size);
    for (let iz = 0; iz < n; iz++) {
      const z = gridZ(iz, resolution, size);

      // Nearest pad wins. Overlapping pads are possible in a dense village, and
      // averaging them would leave a dip between the two.
      let bestDistanceSq = Infinity;
      let bestHeight = 0;
      for (const pad of pads) {
        const dx = pad.x - x;
        const dz = pad.z - z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestHeight = pad.y;
        }
      }
      if (bestDistanceSq > maxDistanceSq) continue;

      const distance = Math.sqrt(bestDistanceSq);
      const t = distance <= radius ? 1 : 1 - (distance - radius) / blend;
      const index = gridIndex(ix, iz, resolution);
      heights[index] = lerp(heights[index], bestHeight, clamp(t, 0, 1));
    }
  }

  return heights;
}

/** Vertex colours for a terrain vertex, given height and slope. */
export function terrainColour(height, slope, style, palette = null) {
  const colours = palette ??
    style?.colours ?? {
      low: [0.29, 0.45, 0.24],
      mid: [0.36, 0.4, 0.26],
      high: [0.45, 0.44, 0.43],
      rock: [0.36, 0.35, 0.34],
      peak: [0.94, 0.95, 0.97],
      sand: [0.84, 0.76, 0.55],
    };
  const amplitude = style?.amplitude ?? 80;
  const normalised = clamp(height / Math.max(amplitude, 1), 0, 1.2);
  const rocky = clamp(slope * 1.5, 0, 1);

  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  let base;
  if (style?.styleName === 'desert' || style?.seaLevel !== undefined) {
    base = mix(colours.sand, colours.mid, clamp(normalised * 1.4, 0, 1));
  } else if (normalised < 0.35) {
    base = mix(colours.low, colours.mid, normalised / 0.35);
  } else if (normalised < 0.72) {
    base = mix(colours.mid, colours.high, (normalised - 0.35) / 0.37);
  } else {
    base = mix(colours.high, colours.peak, (normalised - 0.72) / 0.28);
  }

  return mix(base, colours.rock, rocky);
}
