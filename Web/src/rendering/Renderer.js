import * as THREE from 'three';

/**
 * Renderer wrapper.
 *
 * Owns the WebGLRenderer, the camera, and everything that changes when the
 * player moves a graphics slider. Two rules shape it:
 *
 *  - **Settings must change real behaviour.** `applySettings` translates every
 *    graphics setting into an actual renderer/material/scene change rather than
 *    only storing a value.
 *  - **Nothing expensive by default.** Shadows, MSAA and high pixel ratios are
 *    opt-in; the default path is the one that runs acceptably on integrated
 *    graphics.
 */

/** Per-preset constants that do not come straight from the settings object. */
const PRESET_DETAIL = {
  potato: { shadowMapSize: 0, pixelRatioCap: 1, fogBoost: 0.65, maxLights: 0 },
  low: { shadowMapSize: 1024, pixelRatioCap: 1, fogBoost: 0.85, maxLights: 1 },
  medium: { shadowMapSize: 2048, pixelRatioCap: 1.5, fogBoost: 1, maxLights: 2 },
  high: { shadowMapSize: 4096, pixelRatioCap: 2, fogBoost: 1.15, maxLights: 4 },
};

export class Renderer {
  /**
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas
   * @param {object} options.settings Sanitised settings object.
   */
  constructor({ canvas, settings }) {
    this.canvas = canvas;
    this.settings = settings;
    this.detail = PRESET_DETAIL[settings.preset] ?? PRESET_DETAIL.low;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled explicitly below; MSAA needs a new context
      alpha: false,
      powerPreference: settings.preset === 'high' ? 'high-performance' : 'default',
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0x0b0f14, 1);
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = settings.preset === 'high' ? 1.05 : 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = true;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      64,
      window.innerWidth / window.innerHeight,
      0.2,
      Math.max(300, settings.viewDistance),
    );
    this.camera.position.set(0, 6, -14);

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this.applySettings(settings);
    this._onResize();
  }

  /** The active scene. */
  get activeScene() {
    return this.scene;
  }

  get width() {
    return this.renderer.domElement.width;
  }

  get height() {
    return this.renderer.domElement.height;
  }

  /**
   * Apply graphics settings. Cheap to call on every change; expensive switches
   * (MSAA) are reported back so the caller can decide whether to reload.
   */
  applySettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    this.detail = PRESET_DETAIL[settings.preset] ?? PRESET_DETAIL.low;

    // Camera far plane follows the view distance so the near/far ratio stays
    // sane (a huge ratio is a classic source of z-fighting on road markings).
    this.camera.far = Math.max(200, settings.viewDistance);
    this.camera.near = Math.max(0.1, settings.viewDistance / 4000);
    this.camera.updateProjectionMatrix();

    const shadowsEnabled = settings.shadows !== 'off' && this.detail.shadowMapSize > 0;
    this.renderer.shadowMap.enabled = shadowsEnabled;
    if (shadowsEnabled) {
      this.renderer.shadowMap.type =
        settings.shadows === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    }

    this._applyPixelRatio();
    this.msaaSupported = settings.antialias === 'msaa';
    this.msaaChanged = previous.antialias !== settings.antialias;
    return this;
  }

  _applyPixelRatio() {
    const cap = this.detail.pixelRatioCap;
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // Render scale multiplies the *internal* resolution: dropping to 0.6 is the
    // single most effective lever on a very weak GPU.
    const ratio = Math.min(devicePixelRatio, cap) * this.settings.renderScale;
    this.renderer.setPixelRatio(Math.max(0.35, ratio));
    this._onResize();
  }

  _onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Add an object to the active scene. */
  add(object) {
    this.scene.add(object);
  }

  remove(object) {
    this.scene.remove(object);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Draw-call / triangle counters for the performance overlay. */
  getStats() {
    const info = this.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  }

  /** True when the context has been lost (driver reset, GPU reset, tab suspend). */
  get contextLost() {
    return this.renderer.getContext().isContextLost();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
