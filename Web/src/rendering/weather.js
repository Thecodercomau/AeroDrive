import * as THREE from 'three';
import { clamp, damp } from '../utilities/math.js';
import { createRandom } from '../utilities/random.js';

/**
 * Weather.
 *
 * Split in two on purpose:
 *
 *  - **Profiles and grip are pure data and pure functions.** `gripForSurface`
 *    decides how much of a tyre's grip survives on a wet road, and it can be
 *    unit tested without a renderer. That matters, because a wet road that
 *    silently does *not* reduce grip is the kind of thing that looks fine and
 *    drives wrong.
 *  - **The rain field is one GPU-animated `LineSegments`.** Every drop moves in
 *    the vertex shader from a single `uTime` uniform, so the CPU cost of heavy
 *    rain is zero after setup — which is the only way rain is affordable on the
 *    Potato preset.
 *
 * Wetness is a *ramp*, not a flag: the road keeps its low grip for several
 * seconds after the rain stops, the way a real road does.
 */

export const WEATHER_KINDS = ['clear', 'overcast', 'rain', 'storm'];

export const WEATHER_PROFILES = {
  clear: {
    label: 'Clear',
    rain: 0,
    wetnessTarget: 0,
    skyDarken: 0,
    sunDimming: 0,
    windStrength: 0.3,
    // Probability per second of a lightning strike.
    thunderRate: 0,
    spray: 0,
    // How much of the night sky survives. Kept explicit rather than derived
    // from `skyDarken`, so a starry sky cannot leak through a covered one.
    starVisibility: 1,
  },
  overcast: {
    label: 'Overcast',
    rain: 0,
    wetnessTarget: 0.18,
    skyDarken: 0.34,
    sunDimming: 0.55,
    windStrength: 0.6,
    thunderRate: 0,
    spray: 0,
    starVisibility: 0,
  },
  rain: {
    label: 'Rain',
    rain: 1,
    wetnessTarget: 1,
    skyDarken: 0.55,
    sunDimming: 0.78,
    windStrength: 0.85,
    thunderRate: 0,
    spray: 0.7,
    starVisibility: 0,
  },
  storm: {
    label: 'Thunderstorm',
    rain: 1.55,
    wetnessTarget: 1,
    skyDarken: 0.76,
    sunDimming: 0.92,
    windStrength: 1.3,
    // A strike roughly every 12 s on average.
    thunderRate: 1 / 12,
    spray: 1,
    starVisibility: 0,
  },
};

/** Grip lost to standing water, per surface. Paved surfaces lose the most. */
const WET_GRIP = {
  asphalt: 0.72,
  gravel: 0.86,
  dirt: 0.9,
  grass: 0.94,
  sand: 0.95,
};

/** Seconds for a dry road to become fully soaked, and to dry out again. */
const SOAK_SECONDS = 14;
const DRY_SECONDS = 45;

/** Look up a weather profile, falling back to `clear` for anything unknown. */
export function weatherProfile(kind) {
  return WEATHER_PROFILES[kind] ?? WEATHER_PROFILES.clear;
}

/**
 * The fraction of a surface's grip that survives given how wet it is.
 *
 * `wetness` is 0 (bone dry) to 1 (standing water). Applied to asphalt this is
 * the difference between a car that stops and a car that ploughs on.
 *
 * @param {string} surface Surface key as reported by the world.
 * @param {number} wetness 0..1
 * @returns {number} Multiplier in [0, 1] for the tyre grip.
 */
export function gripForSurface(surface, wetness) {
  const wet = clamp(wetness, 0, 1);
  if (wet <= 0) return 1;
  const floor = WET_GRIP[surface] ?? 0.9;
  return 1 - (1 - floor) * wet;
}

/**
 * Advance a wetness value toward its target.
 * @param {number} wetness Current 0..1
 * @param {number} target Target 0..1
 * @param {number} dt Seconds
 */
export function advanceWetness(wetness, target, dt) {
  const seconds = target > wetness ? SOAK_SECONDS : DRY_SECONDS;
  return damp(clamp(wetness, 0, 1), clamp(target, 0, 1), 1 / seconds, Math.max(0, dt));
}

/**
 * Recolour the sky and fog for the weather.
 *
 * Weather does not replace the time of day — it darkens and desaturates it, so
 * a rainy dawn still looks like dawn.
 *
 * @param {object} daylight Result of `daylightState()`.
 * @param {string} kind Weather key.
 */
export function applyWeatherToDaylight(daylight, kind) {
  const profile = weatherProfile(kind);
  // Each of these is phrased as "1 minus a share of the darkening", so a clear
  // sky is left exactly as the clock made it rather than being dimmed by a
  // constant. (An unconditional factor here is how clear weather ended up 10%
  // darker than a clear sky.)
  const skyTop = 1 - profile.skyDarken * 0.65;
  const skyBottom = 1 - profile.skyDarken * 0.5;
  const fog = 1 - profile.skyDarken * 0.55;
  return {
    ...daylight,
    skyTop: scaleHex(daylight.skyTop, skyTop),
    skyBottom: scaleHex(daylight.skyBottom, skyBottom),
    fogColour: scaleHex(daylight.fogColour, fog),
    sunIntensity: daylight.sunIntensity * (1 - profile.sunDimming),
    ambientIntensity: daylight.ambientIntensity * (1 - profile.skyDarken * 0.35),
    stars: daylight.stars * profile.starVisibility,
  };
}

function scaleHex(hex, factor) {
  const r = Math.max(0, Math.min(255, Math.round(((hex >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((hex >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((hex & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

/* -------------------------------------------------------------------------- */
/*                                rain field                                  */
/* -------------------------------------------------------------------------- */

const RAIN_VERTEX = /* glsl */ `
  attribute float aTail;
  attribute float aSeed;
  uniform float uTime;
  uniform vec3 uCentre;
  uniform vec2 uHalfExtent;
  uniform float uHeight;
  uniform float uSpeed;
  uniform float uWind;
  uniform float uLength;
  uniform float uOpacity;
  varying float vFade;

  void main() {
    vec3 p = position;
    // Fall: wrap within the box so a drop that lands reappears at the top.
    p.y = mod(p.y - uTime * uSpeed * (0.8 + aSeed * 0.4), uHeight);

    // Wind shear grows as the drop falls, and the trailing vertex sits a drop
    // length further down the same path — which is what makes a streak.
    vec3 streak = vec3(uWind * uLength * 0.6, -uLength, uWind * uLength * 0.3);
    vec3 offset = streak * aTail;
    vec3 local = p + offset;

    vec3 world = local + vec3(uCentre.x - uHalfExtent.x, uCentre.y - uHeight * 0.55, uCentre.z - uHalfExtent.y);

    // Fade drops out near the edge of the box so it never reads as a cube.
    float edge = max(abs(local.x - uHalfExtent.x), abs(local.z - uHalfExtent.y)) / max(uHalfExtent.x, 1.0);
    vFade = uOpacity * (1.0 - smoothstep(0.65, 1.0, edge));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const RAIN_FRAGMENT = /* glsl */ `
  varying float vFade;
  uniform vec3 uColour;
  void main() {
    if (vFade <= 0.001) discard;
    gl_FragColor = vec4(uColour, vFade);
  }
`;

/** Rain particle budget per graphics preset. Potato still gets *some* rain. */
const RAIN_BUDGET = { potato: 700, low: 1400, medium: 2600, high: 4200 };

export class Weather {
  /**
   * @param {object} options
   * @param {THREE.Scene} options.scene
   * @param {object} [options.settings]
   */
  constructor({ scene, settings = null }) {
    this.scene = scene;
    this.settings = settings;
    this.kind = settings?.weather ?? 'clear';
    this.profile = weatherProfile(this.kind);
    this.wetness = this.profile.wetnessTarget;
    this.flash = 0;
    this.rng = createRandom('weather');

    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.group.frustumCulled = false;
    scene.add(this.group);

    this.box = { halfX: 34, halfZ: 34, height: 42 };
    this.material = null;
    this.mesh = null;
    this._dropCount = 0;
    this._elapsed = 0;

    this._build(settings?.preset ?? 'low');
  }

  _build(preset) {
    const budget = RAIN_BUDGET[preset] ?? RAIN_BUDGET.low;
    if (this._dropCount === budget && this.mesh) return;

    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this._dropCount = 0;
    }

    const count = budget;
    // Two vertices per drop: head and tail.
    const positions = new Float32Array(count * 2 * 3);
    const tails = new Float32Array(count * 2);
    const seeds = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const x = this.rng() * this.box.halfX * 2;
      const y = this.rng() * this.box.height;
      const z = this.rng() * this.box.halfZ * 2;
      const seed = this.rng();
      for (let v = 0; v < 2; v++) {
        const index = i * 2 + v;
        positions[index * 3] = x;
        positions[index * 3 + 1] = y;
        positions[index * 3 + 2] = z;
        tails[index] = v;
        seeds[index] = seed;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aTail', new THREE.BufferAttribute(tails, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    if (!this.material) {
      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uCentre: { value: new THREE.Vector3() },
          uHalfExtent: { value: new THREE.Vector2(this.box.halfX, this.box.halfZ) },
          uHeight: { value: this.box.height },
          uSpeed: { value: 26 },
          uWind: { value: 0.35 },
          uLength: { value: 1.4 },
          uOpacity: { value: 0 },
          uColour: { value: new THREE.Color(0xbfd4e8) },
        },
        vertexShader: RAIN_VERTEX,
        fragmentShader: RAIN_FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
    }

    this.mesh = new THREE.LineSegments(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'rain';
    this.group.add(this.mesh);
    this._dropCount = count;
  }

  /** Switch weather at runtime. */
  setKind(kind) {
    const profile = weatherProfile(kind);
    this.kind = WEATHER_PROFILES[kind] ? kind : 'clear';
    this.profile = profile;
    return this;
  }

  applySettings(settings) {
    this.settings = settings;
    const previousPreset = this._preset;
    this._preset = settings.preset;
    if (previousPreset !== this._preset) this._build(settings.preset);
    if (settings.weather && settings.weather !== this.kind) this.setKind(settings.weather);
    return this;
  }

  /**
   * Advance weather. Returns the events the caller must react to.
   *
   * @param {number} dt Seconds.
   * @param {THREE.Vector3} cameraPosition
   * @returns {{flash:number, thunder:boolean}}
   */
  update(dt, cameraPosition) {
    this._elapsed += dt;
    this.wetness = advanceWetness(this.wetness, this.profile.wetnessTarget, dt);

    // Lightning: a short bright flash, then thunder a beat later.
    let thunder = false;
    this.flash = Math.max(0, this.flash - dt * 3.2);
    if (this.profile.thunderRate > 0 && this.rng() < this.profile.thunderRate * dt) {
      this.flash = 1;
      this._thunderDelay = 0.6 + this.rng() * 1.6;
    }
    if (this._thunderDelay > 0) {
      this._thunderDelay -= dt;
      if (this._thunderDelay <= 0) {
        this._thunderDelay = 0;
        thunder = true;
      }
    }

    const uniforms = this.material.uniforms;
    uniforms.uTime.value = this._elapsed;
    uniforms.uCentre.value.copy(cameraPosition);
    uniforms.uWind.value = this.profile.windStrength;
    // Heavier rain = longer streaks and more of them visible.
    uniforms.uLength.value = 1.1 + this.profile.rain * 0.6;
    uniforms.uSpeed.value = 22 + this.profile.rain * 8;
    uniforms.uOpacity.value = clamp(this.profile.rain * 0.5, 0, 0.62);

    if (this.mesh) this.mesh.visible = this.profile.rain > 0;
    return { flash: this.flash, thunder };
  }

  /** Multiplier for tyre grip on a surface right now. */
  gripMultiplier(surface) {
    return gripForSurface(surface, this.wetness);
  }

  /** 0..1 spray amount for particles, scaled by speed. */
  sprayAt(speedKmh) {
    if (this.profile.spray <= 0) return 0;
    return this.profile.spray * clamp(speedKmh / 60, 0, 1);
  }

  dispose() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.material?.dispose();
    this.material = null;
    this.scene.remove(this.group);
  }
}
