/**
 * Deterministic pseudo-random number generation.
 *
 * The world generator must produce the *same* terrain and prop layout every
 * time it runs, both so bugs are reproducible and so unit tests can assert on
 * generated output. `Math.random()` cannot do that, so we ship our own.
 */

/** Hash a string into a 32-bit unsigned integer (xfnv1a). */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Create a seeded generator. Returns a function producing floats in [0, 1).
 * Uses mulberry32 — small, fast, and good enough for procedural content.
 */
export function createRandom(seed = 1337) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
  if (a === 0) a = 0x9e3779b9;

  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  next.int = (min, max) => min + Math.floor(next() * (max - min + 1));
  next.range = (min, max) => min + next() * (max - min);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.chance = (probability) => next() < probability;
  return next;
}

/** Convert a 2D integer coordinate plus seed into a stable [0,1) value. */
export function hash2D(seed, x, y) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
