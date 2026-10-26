/**
 * Small, dependency-free math helpers used across the simulation.
 * Every function here is pure so it can be unit-tested in isolation.
 */

/** Constrain `value` to the inclusive range [min, max]. */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation between `a` and `b` by `t` (not clamped). */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Map `value` from one range to another, clamped to the output range. */
export function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax - inMin === 0) return outMin;
  const t = clamp((value - inMin) / (inMax - inMin), 0, 1);
  return lerp(outMin, outMax, t);
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is the convergence rate; higher converges faster.
 */
export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Division that returns `fallback` instead of Infinity/NaN when the divisor is ~0. */
export function safeDivide(numerator, denominator, fallback = 0) {
  if (Math.abs(denominator) < 1e-9) return fallback;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : fallback;
}

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
/** m/s -> km/h */
export const MS_TO_KMH = 3.6;

export function degToRad(deg) {
  return deg * DEG_TO_RAD;
}

export function radToDeg(rad) {
  return rad * RAD_TO_DEG;
}

/** Wrap an angle in radians into (-PI, PI]. Used for steering/heading maths. */
export function wrapAngle(angle) {
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}
