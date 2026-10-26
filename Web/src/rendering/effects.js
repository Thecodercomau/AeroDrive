import * as THREE from 'three';

/**
 * Tyre skid marks and dust / spray / impact particles.
 *
 * Both are pooled and preallocated to a fixed budget chosen by the graphics
 * preset, because the alternative — allocating a mesh per skid mark or a
 * particle object per grain of dust — is exactly how a driving game turns into
 * a garbage-collection slideshow. Nothing here allocates after construction:
 * marks are written into a ring buffer of quads, and particles are recycled from
 * a fixed array.
 *
 * The marks themselves are *not* decals projected onto the road. They are flat
 * quads laid at the terrain height along the contact path, which is cheap and
 * indistinguishable from a decal when the road is flat — which, after the road
 * grading pass, it always is.
 */

/** Marks in the ring buffer, per graphics preset. */
const SKID_BUDGET = { potato: 0, low: 420, medium: 760, high: 1200 };
/** Particles in the pool, per graphics preset. */
const PARTICLE_BUDGET = { potato: 180, low: 380, medium: 720, high: 1200 };

/** Emit a new mark quad once the wheel has travelled this far. */
const MARK_SPACING = 0.4;
/** How dark a full-intensity mark is. */
const MARK_DARKNESS = 0.075;

export class SkidMarks {
  /**
   * @param {object} options
   * @param {THREE.Scene} options.scene
   * @param {number} [options.maxQuads]
   */
  constructor({ scene, maxQuads = 760 }) {
    this.maxQuads = maxQuads;
    this.cursor = 0;
    this.written = 0;

    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(Math.max(1, maxQuads) * 6 * 3);
    this.colours = new Float32Array(Math.max(1, maxQuads) * 6 * 4);
    // Park everything far below the world so unwritten quads are invisible
    // without needing a draw-range trick.
    for (let i = 0; i < this.positions.length; i += 3) this.positions[i + 1] = -2000;
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colours, 4));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Marks sit a few centimetres above the road; the offset keeps them from
      // z-fighting with it at distance where the depth buffer is coarse.
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'skid-marks';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  get enabled() {
    return this.maxQuads > 0;
  }

  /** Number of quads written since the last reset (for tests and the overlay). */
  get quadCount() {
    return this.written;
  }

  /**
   * Lay one quad between two points on the ground.
   *
   * @param {{x:number,y:number,z:number}} from Previous contact point.
   * @param {{x:number,y:number,z:number}} to Current contact point.
   * @param {number} halfWidth Half the tyre width.
   * @param {number} intensity 0..1 — how hard the tyre was scrubbing.
   * @returns {boolean} True when a quad was written.
   */
  push(from, to, halfWidth = 0.16, intensity = 1) {
    if (!this.enabled) return false;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (!Number.isFinite(length) || length < 1e-3 || length > 12) return false;

    const nx = (-dz / length) * halfWidth;
    const nz = (dx / length) * halfWidth;
    const shade = MARK_DARKNESS + (1 - MARK_DARKNESS) * (1 - clamp01(intensity));
    const alpha = 0.15 + 0.45 * clamp01(intensity);

    const quad = [
      { x: from.x - nx, y: from.y, z: from.z - nz },
      { x: from.x + nx, y: from.y, z: from.z + nz },
      { x: to.x + nx, y: to.y, z: to.z + nz },
      { x: to.x + nx, y: to.y, z: to.z + nz },
      { x: to.x - nx, y: to.y, z: to.z - nz },
      { x: from.x - nx, y: from.y, z: from.z - nz },
    ];

    const quadIndex = this.cursor % this.maxQuads;
    const base = quadIndex * 6;
    quad.forEach((vertex, i) => {
      const p = (base + i) * 3;
      this.positions[p] = vertex.x;
      this.positions[p + 1] = vertex.y;
      this.positions[p + 2] = vertex.z;
      const c = (base + i) * 4;
      this.colours[c] = shade;
      this.colours[c + 1] = shade;
      this.colours[c + 2] = shade;
      this.colours[c + 3] = alpha;
    });

    this.cursor += 1;
    this.written += 1;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    return true;
  }

  /** Wipe every mark (map change, vehicle recovery). */
  clear() {
    for (let i = 0; i < this.positions.length; i += 3) this.positions[i + 1] = -2000;
    this.cursor = 0;
    this.written = 0;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* -------------------------------------------------------------------------- */
/*                              particle pool                                 */
/* -------------------------------------------------------------------------- */

const PARTICLE_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColour;
  uniform float uScale;
  varying vec4 vColour;
  void main() {
    vColour = aColour;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = max(1.0, aSize * uScale / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  varying vec4 vColour;
  void main() {
    // Round the square sprite off, and feather the edge so particles fade rather
    // than pop.
    vec2 offset = gl_PointCoord - vec2(0.5);
    float distanceSquared = dot(offset, offset);
    if (distanceSquared > 0.25) discard;
    float alpha = vColour.a * (1.0 - distanceSquared * 4.0);
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(vColour.rgb, alpha);
  }
`;

export class ParticleField {
  /**
   * @param {object} options
   * @param {THREE.Scene} options.scene
   * @param {number} [options.max]
   */
  constructor({ scene, max = 720 }) {
    this.max = Math.max(1, max);
    this.cursor = 0;
    this.live = 0;

    this.positions = new Float32Array(this.max * 3);
    this.colours = new Float32Array(this.max * 4);
    this.sizes = new Float32Array(this.max);
    this._velocity = new Float32Array(this.max * 3);
    this._life = new Float32Array(this.max);
    this._maxLife = new Float32Array(this.max);
    this._gravity = new Float32Array(this.max);
    this._drag = new Float32Array(this.max);
    this._growth = new Float32Array(this.max);
    for (let i = 0; i < this.max; i++) this.positions[i * 3 + 1] = -2000;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aColour', new THREE.BufferAttribute(this.colours, 4));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 320 } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Points(this.geometry, this.material);
    this.mesh.name = 'particles';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /**
   * Spawn `count` particles in a puff.
   *
   * @param {object} options
   * @param {{x:number,y:number,z:number}} options.position Origin.
   * @param {number} [options.count]
   * @param {number} [options.spread] Lateral spread in m/s.
   * @param {number} [options.rise] Upward bias in m/s.
   * @param {[number,number,number]} [options.colour] Linear RGB.
   * @param {number} [options.alpha]
   * @param {number} [options.size] Point size in world units.
   * @param {number} [options.life] Seconds.
   * @param {number} [options.gravity]
   * @param {number} [options.growth] Size growth per second.
   * @param {() => number} [options.random]
   */
  emit({
    position,
    count = 1,
    spread = 0.8,
    rise = 1.2,
    colour = [0.55, 0.5, 0.42],
    alpha = 0.5,
    size = 0.5,
    life = 1.2,
    gravity = -1.6,
    growth = 0.6,
    random = Math.random,
  }) {
    for (let i = 0; i < count; i++) {
      const index = this.cursor % this.max;
      this.cursor += 1;
      const p = index * 3;
      this.positions[p] = position.x + (random() - 0.5) * 0.6;
      this.positions[p + 1] = position.y + (random() - 0.5) * 0.3;
      this.positions[p + 2] = position.z + (random() - 0.5) * 0.6;
      this._velocity[p] = (random() - 0.5) * spread * 2;
      this._velocity[p + 1] = rise * (0.4 + random() * 0.8);
      this._velocity[p + 2] = (random() - 0.5) * spread * 2;
      const c = index * 4;
      this.colours[c] = colour[0];
      this.colours[c + 1] = colour[1];
      this.colours[c + 2] = colour[2];
      this.colours[c + 3] = alpha;
      this.sizes[index] = size * (0.6 + random() * 0.8);
      this._life[index] = life * (0.7 + random() * 0.6);
      this._maxLife[index] = this._life[index];
      this._gravity[index] = gravity;
      this._drag[index] = 1.6 + random();
      this._growth[index] = growth;
    }
    this._markDirty();
  }

  /**
   * Integrate every live particle.
   *
   * Sub-stepped: a frame hitch (a tab restore, a map load, a long GC pause) can
   * hand this a step of several hundred milliseconds, and integrating that in
   * one Euler step makes every particle in the pool jump — and makes the
   * gravity term blow through the upward velocity, so dust falls instead of
   * rising. Capping the step fixes that without changing normal frames, which
   * are already shorter than the cap and therefore take a single step.
   */
  update(dt) {
    const total = Math.max(0, dt);
    const steps = Math.min(4, Math.max(1, Math.ceil(total / 0.05)));
    for (let i = 0; i < steps; i++) this._integrate(total / steps);
  }

  _integrate(dt) {
    let live = 0;
    for (let i = 0; i < this.max; i++) {
      if (this._life[i] <= 0) continue;
      this._life[i] -= dt;
      const p = i * 3;
      if (this._life[i] <= 0) {
        this.colours[i * 4 + 3] = 0;
        this.sizes[i] = 0;
        this.positions[p + 1] = -2000;
        continue;
      }
      live += 1;
      const decay = Math.max(0, 1 - this._drag[i] * dt);
      this._velocity[p] *= decay;
      this._velocity[p + 1] = this._velocity[p + 1] * decay + this._gravity[i] * dt;
      this._velocity[p + 2] *= decay;
      this.positions[p] += this._velocity[p] * dt;
      this.positions[p + 1] += this._velocity[p + 1] * dt;
      this.positions[p + 2] += this._velocity[p + 2] * dt;
      const t = this._life[i] / this._maxLife[i];
      this.colours[i * 4 + 3] = 0.55 * t * t;
      this.sizes[i] += this._growth[i] * dt;
    }
    this.live = live;
    this._markDirty();
  }

  _markDirty() {
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColour.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.max; i++) {
      this._life[i] = 0;
      this.colours[i * 4 + 3] = 0;
      this.sizes[i] = 0;
      this.positions[i * 3 + 1] = -2000;
    }
    this.cursor = 0;
    this.live = 0;
    this._markDirty();
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export { SKID_BUDGET, PARTICLE_BUDGET, MARK_SPACING };
