import { describe, expect, it } from 'vitest';
import {
  HOURS_PER_DAY,
  advanceHour,
  blendThree,
  daylightState,
  formatClock,
  sunDirectionAt,
  sunElevationAt,
  wrapHour,
} from '../src/rendering/daylight.js';

const MAP = {
  sky: { top: 0x3f7fc4, bottom: 0xc9dced, sun: 0xfff2d5 },
  fog: { colour: 0x9fb6cd },
};

describe('solar position', () => {
  it('rises in the east, peaks at noon and sets in the west', () => {
    expect(sunDirectionAt(6).y).toBeCloseTo(0, 2);
    expect(sunDirectionAt(6).x).toBeGreaterThan(0.9);

    const noon = sunDirectionAt(12);
    expect(noon.y).toBeGreaterThan(0.9);
    expect(noon.y).toBe(Math.max(...[9, 12, 15].map((hour) => sunElevationAt(hour))));

    expect(sunDirectionAt(18).y).toBeCloseTo(0, 2);
    expect(sunDirectionAt(18).x).toBeLessThan(-0.9);
  });

  it('is below the horizon at midnight', () => {
    expect(sunDirectionAt(0).y).toBeLessThan(-0.9);
    expect(sunDirectionAt(23).y).toBeLessThan(0);
  });

  it('always returns a unit vector', () => {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const { x, y, z } = sunDirectionAt(hour);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
  });

  it('never runs exactly along a world axis', () => {
    // A sun exactly on an axis makes shadow acne worse and flat-lights the roads.
    expect(Math.abs(sunDirectionAt(6).z)).toBeGreaterThan(0.05);
    expect(Math.abs(sunDirectionAt(12).z)).toBeGreaterThan(0.05);
  });
});

describe('clock arithmetic', () => {
  it('wraps hours into [0, 24)', () => {
    expect(wrapHour(25)).toBeCloseTo(1);
    expect(wrapHour(-1)).toBeCloseTo(23);
    expect(wrapHour(0)).toBe(0);
    expect(wrapHour(HOURS_PER_DAY)).toBe(0);
  });

  it('survives nonsense input instead of producing NaN', () => {
    for (const input of [NaN, undefined, null, Infinity, 'noon']) {
      expect(Number.isFinite(wrapHour(input))).toBe(true);
    }
  });

  it('advances a full day in `dayLengthMinutes` real minutes', () => {
    expect(advanceHour(0, 720, 24)).toBeCloseTo(12, 3);
    expect(advanceHour(0, 24 * 60, 24)).toBeCloseTo(0, 3);
    // A faster cycle covers the day sooner.
    expect(advanceHour(0, 72, 2.4)).toBeCloseTo(12, 3);
  });

  it('does not move backwards, and ignores a nonsense day length', () => {
    expect(advanceHour(5, -10, 24)).toBeCloseTo(5);
    expect(advanceHour(5, 0, 24)).toBeCloseTo(5);
    expect(advanceHour(0, 720, 0)).toBeCloseTo(12, 3);
    expect(advanceHour(0, 720, Number.NaN)).toBeCloseTo(12, 3);
  });

  it('formats a clock reading', () => {
    expect(formatClock(9.5)).toBe('09:30');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(23.999)).toBe('23:59');
  });
});

describe('daylight state', () => {
  it('is dark, starry and headlight-worthy at night', () => {
    const night = daylightState(1, MAP);
    expect(night.isNight).toBe(true);
    expect(night.stars).toBeGreaterThan(0.5);
    expect(night.headlightsRecommended).toBe(true);
    expect(night.sunIntensity).toBeLessThan(0.2);
  });

  it('is bright and lit at midday', () => {
    const day = daylightState(12, MAP);
    expect(day.isNight).toBe(false);
    expect(day.stars).toBe(0);
    expect(day.headlightsRecommended).toBe(false);
    expect(day.sunIntensity).toBeGreaterThan(1.5);
    expect(day.ambientIntensity).toBeGreaterThan(0.7);
  });

  it('keeps each map’s own daytime palette', () => {
    // A desert noon must not look like an alpine noon.
    const day = daylightState(12, MAP);
    expect(day.skyTop).toBe(MAP.sky.top);
    expect(day.skyBottom).toBe(MAP.sky.bottom);
    expect(day.fogColour).toBe(MAP.fog.colour);
  });

  it('falls back to sensible colours without a map', () => {
    const day = daylightState(12, null);
    expect(day.skyTop).toBeGreaterThan(0);
    expect(day.fogColour).toBeGreaterThan(0);
  });

  it('brightens continuously through dawn, with no step between frames', () => {
    // The whole point of the three-mood blend. Stepping at a realistic frame
    // cadence matters: a coarser sweep would hide a discontinuity that a player
    // would see as a flicker.
    let previous = daylightState(4, MAP);
    let biggestJump = 0;
    const stepHours = 1 / 3600; // one second of a 24-hour day
    for (let hour = 4; hour <= 8; hour += stepHours) {
      const current = daylightState(hour, MAP);
      biggestJump = Math.max(biggestJump, Math.abs(current.sunIntensity - previous.sunIntensity));
      // Brightness must never fall as the sun rises.
      expect(current.sunIntensity).toBeGreaterThanOrEqual(previous.sunIntensity - 1e-9);
      previous = current;
    }
    expect(biggestJump).toBeLessThan(0.005);
  });

  it('darkens through dusk and then settles at the night floor', () => {
    const evening = [17, 18, 19, 22].map((hour) => daylightState(hour, MAP).sunIntensity);
    // Strictly darker through the transition...
    expect(evening[1]).toBeLessThan(evening[0]);
    expect(evening[2]).toBeLessThan(evening[1]);
    // ...and then it flattens at the night floor rather than going negative.
    expect(evening[3]).toBeLessThanOrEqual(evening[2]);
    expect(evening[3]).toBeGreaterThan(0);
    expect(daylightState(22, MAP).isNight).toBe(true);
  });

  it('reports the clock reading it was asked about', () => {
    expect(daylightState(7.25, MAP).clock).toBe('07:15');
  });
});

describe('colour blending', () => {
  it('returns the endpoint colours at the extremes', () => {
    expect(blendThree(0xff0000, 0x00ff00, 0x0000ff, { night: 1, twilight: 0, day: 0 })).toBe(
      0xff0000,
    );
    expect(blendThree(0xff0000, 0x00ff00, 0x0000ff, { night: 0, twilight: 0, day: 1 })).toBe(
      0x0000ff,
    );
  });

  it('blends channels independently', () => {
    const mixed = blendThree(0x000000, 0x000000, 0xffffff, {
      night: 0.5,
      twilight: 0.25,
      day: 0.25,
    });
    expect((mixed >> 16) & 0xff).toBe(64);
    expect((mixed >> 8) & 0xff).toBe(64);
    expect(mixed & 0xff).toBe(64);
  });
});
