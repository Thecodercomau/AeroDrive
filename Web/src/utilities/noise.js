import { hash2D } from './random.js';
import { lerp } from './math.js';

/**
 * Seeded 2D value noise with smooth (quintic) interpolation.
 *
 * Value noise is chosen over Perlin/simplex because it is tiny, allocation-free
 * on the hot path, and deterministic — all of which matter for a terrain
 * generator that must run identically on a low-end laptop and in a unit test.
 */
export function createNoise2D(seed = 1337) {
  const s = (typeof seed === 'string' ? hashStringToInt(seed) : seed) >>> 0;

  // Quintic fade keeps the first derivative continuous, avoiding visible
  // "blocky" banding in the terrain.
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  function noise(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);

    const n00 = hash2D(s, x0, y0);
    const n10 = hash2D(s, x0 + 1, y0);
    const n01 = hash2D(s, x0, y0 + 1);
    const n11 = hash2D(s, x0 + 1, y0 + 1);

    const top = lerp(n00, n10, fx);
    const bottom = lerp(n01, n11, fx);
    return lerp(top, bottom, fy);
  }

  /**
   * Fractal brownian motion: sum several octaves of noise.
   * Returns a value in [0, 1].
   */
  noise.fbm = (
    x,
    y,
    { octaves = 4, frequency = 1, amplitude = 1, lacunarity = 2, gain = 0.5 } = {},
  ) => {
    let sum = 0;
    let norm = 0;
    let freq = frequency;
    let amp = amplitude;
    for (let i = 0; i < octaves; i++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  };

  /**
   * Ridged multifractal — produces sharp crests, ideal for mountain ranges.
   * Returns a value in [0, 1].
   */
  noise.ridged = (x, y, { octaves = 4, frequency = 1, lacunarity = 2, gain = 0.5 } = {}) => {
    let sum = 0;
    let norm = 0;
    let freq = frequency;
    let amp = 1;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise(x * freq, y * freq) * 2 - 1);
      sum += n * n * amp;
      norm += amp;
      freq *= lacunarity;
      amp *= gain;
    }
    return norm > 0 ? sum / norm : 0;
  };

  return noise;
}

function hashStringToInt(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
