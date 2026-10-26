import * as THREE from 'three';
import { advanceHour, daylightState, wrapHour } from './daylight.js';
import { applyWeatherToDaylight } from './weather.js';

/**
 * Sky, sun, fog and ambient light.
 *
 * The sky is a gradient shader on the inside of a sphere — no cubemap, no
 * texture download, and it costs one draw call. Its star field is a hash in the
 * fragment shader, so night costs nothing extra either.
 *
 * Lighting is deliberately minimal: one directional sun (the only shadow caster)
 * plus a hemisphere fill. Adding real-time lights is the fastest way to make a
 * driving game unplayable on integrated graphics, so the count is capped and
 * driven by the graphics preset.
 *
 * Everything the player sees here is derived from two inputs — the clock and the
 * weather — through the pure functions in `daylight.js` and `weather.js`. That
 * keeps "what does 05:40 look like" testable without a GPU.
 */

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorldPosition;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 uTop;
  uniform vec3 uBottom;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColour;
  uniform float uSunSize;
  uniform float uStars;
  varying vec3 vWorldPosition;

  // Cheap 3D value hash: enough to scatter stars, and deterministic so the same
  // patch of sky looks the same every night.
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    vec3 direction = normalize(vWorldPosition);
    // Vertical gradient with a soft horizon band.
    float h = clamp(direction.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = mix(uBottom, uTop, pow(h, 0.85));

    // Star field: one candidate star per 220-unit cell of direction space.
    if (uStars > 0.001) {
      vec3 cell = floor(direction * 220.0);
      float seed = hash13(cell);
      float threshold = step(0.977, seed);
      vec3 centre = cell + 0.5;
      float distanceToCentre = length(direction * 220.0 - centre);
      float disc = smoothstep(0.42, 0.0, distanceToCentre);
      float aboveHorizon = smoothstep(0.0, 0.2, direction.y);
      float twinkle = 0.65 + 0.35 * hash13(cell + 7.0);
      sky += vec3(0.85, 0.88, 1.0) * disc * threshold * aboveHorizon * uStars * twinkle;
    }

    // Sun (or, at night, the moon's position below the horizon contributes
    // nothing because uSunSize is small and uSunColour is dim).
    float sun = max(dot(direction, normalize(uSunDirection)), 0.0);
    sky += uSunColour * pow(sun, 220.0) * 1.6;
    sky += uSunColour * pow(sun, 8.0) * 0.22 * uSunSize;
    gl_FragColor = vec4(sky, 1.0);
  }
`;

export class Environment {
  /**
   * @param {object} options
   * @param {THREE.Scene} options.scene
   * @param {object} options.map Map definition (provides sky/fog colours).
   * @param {object} options.settings
   * @param {number} [options.hour] Starting clock hour; settings are used when omitted.
   */
  constructor({ scene, map, settings, hour = null }) {
    this.scene = scene;
    this.map = map;
    this.settings = settings;

    this.group = new THREE.Group();
    this.group.name = 'environment';

    const skyColours = map.sky ?? { top: 0x3f7fc4, bottom: 0xc9dced, sun: 0xfff2d5 };
    this.skyUniforms = {
      uTop: { value: new THREE.Color(skyColours.top) },
      uBottom: { value: new THREE.Color(skyColours.bottom) },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.7, -0.5).normalize() },
      uSunColour: { value: new THREE.Color(skyColours.sun) },
      uSunSize: { value: 1 },
      uStars: { value: 0 },
    };
    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.skyMaterial);
    this.sky.name = 'sky';
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // --- Sun --------------------------------------------------------------
    this.sun = new THREE.DirectionalLight(skyColours.sun ?? 0xfff2d5, 2.1);
    this.sun.name = 'sun';
    this.sun.position.set(220, 340, -180);
    this.group.add(this.sun);
    this.group.add(this.sun.target);

    // --- Ambient fill -----------------------------------------------------
    const fogColour = map.fog?.colour ?? 0x9fb6cd;
    this.hemisphere = new THREE.HemisphereLight(
      new THREE.Color(skyColours.top ?? 0x3f7fc4),
      new THREE.Color(fogColour),
      0.85,
    );
    this.hemisphere.name = 'hemisphere';
    this.group.add(this.hemisphere);

    // A very dim reverse-facing light keeps vehicle undersides readable without
    // costing a shadow map.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.22);
    this.fill.position.set(-140, 120, 160);
    this.group.add(this.fill);

    // --- Fog --------------------------------------------------------------
    this.fog = new THREE.Fog(fogColour, map.fog?.near ?? 120, map.fog?.far ?? 1500);
    scene.fog = this.fog;

    // --- Clock ------------------------------------------------------------
    this.hour = wrapHour(hour ?? settings.timeOfDay ?? 10);
    this._settingsHour = settings.timeOfDay ?? 10;
    /** Latest computed lighting state; exposed for the HUD and for tests. */
    this.daylight = daylightState(this.hour, map);

    scene.add(this.group);

    this.applySettings(settings);
    this._applyLighting();
  }

  /** Clock hour, 0..24. */
  get clock() {
    return this.daylight.clock;
  }

  get isNight() {
    return this.daylight.isNight;
  }

  applySettings(settings) {
    this.settings = settings;
    const preset = settings.preset ?? 'low';
    const shadowsOn = settings.shadows !== 'off' && preset !== 'potato';

    this.sun.castShadow = shadowsOn;
    if (shadowsOn) {
      const size = settings.shadows === 'high' ? 4096 : settings.shadows === 'medium' ? 2048 : 1024;
      const camera = this.sun.shadow.camera;
      // The shadow frustum only needs to cover what the player can see, so it is
      // tied to the view distance rather than to the whole map.
      this._shadowExtent = Math.min(Math.max(settings.viewDistance * 0.28, 60), 320);
      camera.left = -this._shadowExtent;
      camera.right = this._shadowExtent;
      camera.top = this._shadowExtent;
      camera.bottom = -this._shadowExtent;
      camera.near = 1;
      camera.far = this._shadowExtent * 4;
      camera.updateProjectionMatrix();
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.bias = -0.0006;
      this.sun.shadow.normalBias = 0.35;
    }

    // Fog far follows the view distance so "draw nothing then pop it in" is
    // hidden by the fade rather than visible as a hard edge.
    this.fog.near = Math.max(40, settings.viewDistance * 0.14);
    this.fog.far = Math.max(this.fog.near + 120, settings.viewDistance);

    // Moving the time-of-day slider sets the clock; the cycle then runs from
    // there. Comparing against the last value we pushed out means an advancing
    // clock is never mistaken for a slider change.
    if (
      Number.isFinite(settings.timeOfDay) &&
      Math.abs(settings.timeOfDay - this._settingsHour) > 1e-4
    ) {
      this._settingsHour = settings.timeOfDay;
      this.hour = wrapHour(settings.timeOfDay);
      this._applyLighting();
    }

    this._applyLighting();
  }

  /**
   * Advance the clock and refresh the lighting.
   *
   * @param {THREE.Vector3} cameraPosition
   * @param {object} [options]
   * @param {number} [options.dt] Seconds since the last call.
   * @param {import('./weather.js').Weather} [options.weather]
   * @param {number} [options.flash] 0..1 lightning flash brightness.
   */
  update(cameraPosition, { dt = 0, weather = null, flash = 0 } = {}) {
    if (this.settings.dayNightCycle && dt > 0) {
      this.hour = advanceHour(this.hour, dt, this.settings.dayLengthMinutes ?? 24);
    }
    this._applyLighting({ weather, flash });

    this.sky.position.copy(cameraPosition);
    this.sky.scale.setScalar(Math.max(200, this.settings.viewDistance * 0.9));

    // Keep the sun (and therefore the shadow frustum) anchored to the player, so
    // shadows exist everywhere on a large map without needing a huge shadow map.
    const extent = this._shadowExtent ?? 120;
    const distance = Math.max(120, extent * 1.8);
    const direction = this.daylight.direction;
    this.sun.position.set(
      cameraPosition.x + direction.x * distance,
      cameraPosition.y + Math.max(0.12, direction.y) * distance,
      cameraPosition.z + direction.z * distance,
    );
    this.sun.target.position.copy(cameraPosition);
    this.sun.target.updateMatrixWorld();
  }

  /** Recompute the sky, sun, fog and ambient from the clock and weather. */
  _applyLighting({ weather = null, flash = 0 } = {}) {
    let state = daylightState(this.hour, this.map);
    if (weather && weather.kind !== 'clear') state = applyWeatherToDaylight(state, weather.kind);
    this.daylight = state;

    this.skyUniforms.uTop.value.setHex(state.skyTop);
    this.skyUniforms.uBottom.value.setHex(state.skyBottom);
    this.skyUniforms.uSunColour.value.setHex(state.sunColour);
    this.skyUniforms.uSunSize.value = state.sunSize;
    this.skyUniforms.uStars.value = state.stars;
    this.skyUniforms.uSunDirection.value
      .set(state.direction.x, state.direction.y, state.direction.z)
      .normalize();

    const preset = this.settings.preset ?? 'low';
    // The flash is added on top of the current level, so a lightning strike is
    // visible at night as well as in daylight.
    const flashBoost = flash > 0 ? flash * 2.2 : 0;
    this.sun.color.setHex(state.sunColour);
    this.sun.intensity = state.sunIntensity + flashBoost * 0.4;
    this.hemisphere.intensity =
      state.ambientIntensity * (preset === 'potato' ? 0.7 : preset === 'low' ? 0.9 : 1);
    this.hemisphere.color.setHex(state.hemisphereSky);
    this.hemisphere.groundColor.setHex(state.hemisphereGround);
    this.fog.color.setHex(state.fogColour);
    this.fill.visible = preset !== 'potato' && !state.isNight;

    // On a GPU with no shadow budget the world would otherwise go pitch black at
    // night, because the hemisphere fill is all that is left.
    if (flash > 0) this.hemisphere.intensity += flash * 1.1;
  }

  dispose() {
    this.sky.geometry.dispose();
    this.skyMaterial.dispose();
    this.scene.fog = null;
    this.group.clear();
    this.scene.remove(this.group);
  }
}
