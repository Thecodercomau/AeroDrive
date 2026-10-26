import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ParticleField, SkidMarks } from '../src/rendering/effects.js';

/**
 * Effects tests.
 *
 * These run against real three.js geometry objects in Node — no WebGL context is
 * needed to allocate a buffer or write into it, which is exactly why the marks
 * and the particle pool are written as plain data structures rather than as
 * renderer-side objects.
 */

describe('skid marks', () => {
  const point = (x, z) => ({ x, y: 0.1, z });

  it('lays a quad between two contact points', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 4 });
    expect(marks.enabled).toBe(true);
    expect(marks.push(point(0, 0), point(1, 0), 0.2, 1)).toBe(true);
    expect(marks.quadCount).toBe(1);
    marks.dispose();
  });

  it('refuses degenerate and absurd segments', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 4 });
    // The same point twice would produce a zero-area quad.
    expect(marks.push(point(0, 0), point(0, 0), 0.2, 1)).toBe(false);
    // A 15 m jump is a teleport (a vehicle recovery), not a skid.
    expect(marks.push(point(0, 0), point(15, 0), 0.2, 1)).toBe(false);
    expect(marks.push(point(0, 0), { x: NaN, y: 0, z: 0 }, 0.2, 1)).toBe(false);
    expect(marks.quadCount).toBe(0);
    marks.dispose();
  });

  it('recycles the oldest quad once the ring buffer is full', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 3 });
    for (let i = 0; i < 10; i++) {
      marks.push(point(i, 0), point(i + 0.5, 0), 0.2, 1);
    }
    // Everything ever written is counted, but only `maxQuads` quads exist.
    expect(marks.quadCount).toBe(10);
    expect(marks.cursor).toBe(10);
    const positions = marks.geometry.attributes.position.array;
    expect(positions.length).toBe(3 * 6 * 3);
    marks.dispose();
  });

  it('writes vertex colours with an alpha channel so marks fade by intensity', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 2 });
    marks.push(point(0, 0), point(1, 0), 0.2, 1);
    const colour = marks.geometry.attributes.color;
    expect(colour.itemSize).toBe(4);
    expect(colour.array[3]).toBeGreaterThan(0);
    expect(colour.array[3]).toBeLessThanOrEqual(1);
    marks.dispose();
  });

  it('is a complete no-op when the preset disables it', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 0 });
    expect(marks.enabled).toBe(false);
    expect(marks.push(point(0, 0), point(1, 0), 0.2, 1)).toBe(false);
    marks.dispose();
  });

  it('parks every quad off-world when cleared', () => {
    const marks = new SkidMarks({ scene: new THREE.Scene(), maxQuads: 4 });
    marks.push(point(0, 0), point(1, 0), 0.2, 1);
    marks.clear();
    expect(marks.quadCount).toBe(0);
    const positions = marks.geometry.attributes.position.array;
    for (let i = 1; i < positions.length; i += 3) {
      expect(positions[i]).toBe(-2000);
    }
    marks.dispose();
  });
});

describe('particle pool', () => {
  /** Deterministic random so the pool's shape is reproducible. */
  const fixedRandom = () => 0.5;

  it('emits, integrates and expires particles', () => {
    const field = new ParticleField({ scene: new THREE.Scene(), max: 16 });
    field.emit({ position: { x: 0, y: 1, z: 0 }, count: 5, random: fixedRandom });
    field.update(0.016);
    expect(field.live).toBe(5);

    // A long step retires them all.
    field.update(5);
    expect(field.live).toBe(0);
    field.dispose();
  });

  it('never exceeds its budget, recycling the oldest instead', () => {
    const field = new ParticleField({ scene: new THREE.Scene(), max: 8 });
    field.emit({ position: { x: 0, y: 0, z: 0 }, count: 50, random: fixedRandom });
    field.update(0.016);
    expect(field.live).toBe(8);
    expect(field.cursor).toBe(50);
    field.dispose();
  });

  it('moves particles and fades them out over their life', () => {
    const field = new ParticleField({ scene: new THREE.Scene(), max: 4 });
    field.emit({
      position: { x: 0, y: 0, z: 0 },
      count: 1,
      life: 1,
      rise: 2,
      random: fixedRandom,
    });
    field.update(0.1);
    const startY = field.geometry.attributes.position.array[1];
    const startAlpha = field.geometry.attributes.aColour.array[3];

    field.update(0.4);
    expect(field.geometry.attributes.position.array[1]).toBeGreaterThan(startY);
    expect(field.geometry.attributes.aColour.array[3]).toBeLessThan(startAlpha);
    field.dispose();
  });

  it('drops a dead particle out of the world rather than leaving it at the origin', () => {
    const field = new ParticleField({ scene: new THREE.Scene(), max: 4 });
    field.emit({ position: { x: 0, y: 0, z: 0 }, count: 1, life: 0.2, random: fixedRandom });
    field.update(1);
    expect(field.geometry.attributes.position.array[1]).toBe(-2000);
    expect(field.geometry.attributes.aColour.array[3]).toBe(0);
    expect(field.geometry.attributes.aSize.array[0]).toBe(0);
    field.dispose();
  });

  it('clears back to empty', () => {
    const field = new ParticleField({ scene: new THREE.Scene(), max: 8 });
    field.emit({ position: { x: 0, y: 0, z: 0 }, count: 8, random: fixedRandom });
    field.update(0.016);
    field.clear();
    expect(field.live).toBe(0);
    expect(field.cursor).toBe(0);
    field.dispose();
  });
});
