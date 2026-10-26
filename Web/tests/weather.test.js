import { describe, expect, it } from 'vitest';
import {
  WEATHER_KINDS,
  WEATHER_PROFILES,
  advanceWetness,
  applyWeatherToDaylight,
  gripForSurface,
  weatherProfile,
} from '../src/rendering/weather.js';
import { daylightState } from '../src/rendering/daylight.js';

describe('weather profiles', () => {
  it('defines a complete profile for every advertised kind', () => {
    for (const kind of WEATHER_KINDS) {
      const profile = WEATHER_PROFILES[kind];
      expect(profile, kind).toBeDefined();
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.wetnessTarget).toBeGreaterThanOrEqual(0);
      expect(profile.wetnessTarget).toBeLessThanOrEqual(1);
      expect(profile.skyDarken).toBeGreaterThanOrEqual(0);
      expect(profile.sunDimming).toBeGreaterThanOrEqual(0);
      expect(profile.sunDimming).toBeLessThan(1);
    }
  });

  it('ramps monotonically in severity', () => {
    const order = ['clear', 'overcast', 'rain', 'storm'];
    for (let i = 1; i < order.length; i++) {
      expect(WEATHER_PROFILES[order[i]].skyDarken).toBeGreaterThan(
        WEATHER_PROFILES[order[i - 1]].skyDarken,
      );
      expect(WEATHER_PROFILES[order[i]].wetnessTarget).toBeGreaterThanOrEqual(
        WEATHER_PROFILES[order[i - 1]].wetnessTarget,
      );
    }
  });

  it('is dry and silent when clear, and only the storm has lightning', () => {
    expect(WEATHER_PROFILES.clear.rain).toBe(0);
    expect(WEATHER_PROFILES.clear.wetnessTarget).toBe(0);
    expect(WEATHER_PROFILES.clear.thunderRate).toBe(0);
    expect(WEATHER_PROFILES.rain.thunderRate).toBe(0);
    expect(WEATHER_PROFILES.storm.thunderRate).toBeGreaterThan(0);
  });

  it('falls back to clear for an unknown kind', () => {
    expect(weatherProfile('hail').label).toBe(WEATHER_PROFILES.clear.label);
    expect(weatherProfile(undefined).rain).toBe(0);
  });
});

describe('wet grip', () => {
  it('leaves grip untouched when the road is dry', () => {
    for (const surface of ['asphalt', 'grass', 'dirt', 'gravel', 'sand']) {
      expect(gripForSurface(surface, 0)).toBe(1);
    }
  });

  it('takes the most grip from asphalt and the least from sand', () => {
    expect(gripForSurface('asphalt', 1)).toBeCloseTo(0.72, 5);
    expect(gripForSurface('grass', 1)).toBeCloseTo(0.94, 5);
    expect(gripForSurface('asphalt', 1)).toBeLessThan(gripForSurface('dirt', 1));
    expect(gripForSurface('dirt', 1)).toBeLessThan(gripForSurface('sand', 1));
  });

  it('falls monotonically as the road gets wetter', () => {
    let previous = Infinity;
    for (let wetness = 0; wetness <= 1.0001; wetness += 0.1) {
      const grip = gripForSurface('asphalt', wetness);
      expect(grip).toBeLessThanOrEqual(previous + 1e-9);
      expect(grip).toBeGreaterThan(0);
      previous = grip;
    }
  });

  it('handles out-of-range wetness and unknown surfaces safely', () => {
    expect(gripForSurface('asphalt', -5)).toBe(1);
    expect(gripForSurface('asphalt', 12)).toBeCloseTo(0.72, 5);
    const unknown = gripForSurface('moon rock', 1);
    expect(unknown).toBeGreaterThan(0);
    expect(unknown).toBeLessThan(1);
  });
});

describe('wetness ramp', () => {
  it('soaks a dry road toward the target without overshooting', () => {
    let wetness = 0;
    // Ten seconds in: well on the way, but nowhere near done. A road that soaked
    // instantly would make the grip change feel like a trap rather than weather.
    for (let i = 0; i < 600; i++) wetness = advanceWetness(wetness, 1, 1 / 60);
    expect(wetness).toBeGreaterThan(0.4);
    expect(wetness).toBeLessThan(0.75);

    // A minute in, it is as wet as it is going to get.
    for (let i = 0; i < 3000; i++) wetness = advanceWetness(wetness, 1, 1 / 60);
    expect(wetness).toBeGreaterThan(0.95);
    expect(wetness).toBeLessThanOrEqual(1);
  });

  it('dries out more slowly than it soaks', () => {
    const soaked = advanceWetness(1, 0, 5);
    const soakedUp = advanceWetness(0, 1, 5);
    // After the same time, the drying road has retained more of its state than
    // the soaking road has gained.
    expect(soaked).toBeGreaterThan(1 - soakedUp);
  });

  it('never leaves the [0, 1] range', () => {
    let wetness = 0.5;
    for (let i = 0; i < 5000; i++) wetness = advanceWetness(wetness, 1, 1 / 30);
    expect(wetness).toBeLessThanOrEqual(1);
    for (let i = 0; i < 5000; i++) wetness = advanceWetness(wetness, 0, 1 / 30);
    expect(wetness).toBeGreaterThanOrEqual(0);
  });
});

describe('weather applied to the daylight state', () => {
  const noon = daylightState(12, {
    sky: { top: 0x3f7fc4, bottom: 0xc9dced, sun: 0xfff2d5 },
    fog: { colour: 0x9fb6cd },
  });

  it('darkens the sky and the fog', () => {
    const rainy = applyWeatherToDaylight(noon, 'rain');
    expect(rainy.skyTop).toBeLessThan(noon.skyTop);
    expect(rainy.fogColour).toBeLessThan(noon.fogColour);
    expect(rainy.sunIntensity).toBeLessThan(noon.sunIntensity);
    expect(rainy.ambientIntensity).toBeLessThan(noon.ambientIntensity);
  });

  it('hides the stars when the sky is covered', () => {
    const night = daylightState(1, null);
    expect(night.stars).toBeGreaterThan(0);
    expect(applyWeatherToDaylight(night, 'overcast').stars).toBe(0);
  });

  it('leaves clear weather alone', () => {
    const clear = applyWeatherToDaylight(noon, 'clear');
    expect(clear.skyTop).toBe(noon.skyTop);
    expect(clear.sunIntensity).toBeCloseTo(noon.sunIntensity, 6);
  });

  it('keeps every channel in range for every kind', () => {
    for (const kind of WEATHER_KINDS) {
      const state = applyWeatherToDaylight(noon, kind);
      for (const channel of [state.skyTop, state.skyBottom, state.fogColour]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(0xffffff);
      }
    }
  });
});
