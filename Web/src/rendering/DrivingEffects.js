import { SkidMarks, ParticleField, SKID_BUDGET, PARTICLE_BUDGET, MARK_SPACING } from './effects.js';
import { clamp } from '../utilities/math.js';

/**
 * Skid marks, dust, spray and impact smoke, driven by the vehicle's own state.
 *
 * Everything here is a *presentation* consumer: it reads telemetry and wheel
 * contacts and writes pixels. It never touches physics, so a graphics setting
 * that disables it cannot change how the car drives.
 *
 * ## Being honest about "slip"
 *
 * Rapier's raycast vehicle has no per-wheel slip model. There is no tyre force
 * curve to read, so "is this wheel scrubbing?" is inferred from the signals that
 * *are* real: lateral velocity against forward speed, the handbrake, hard
 * braking, and driven-wheel torque at low speed. That is a heuristic, and it is
 * labelled as one. It is good enough to put marks under a car that is visibly
 * sliding, which is the entire requirement.
 */

/** Surfaces that take a visible skid mark. Grass and sand do not. */
const MARKABLE = new Set(['asphalt', 'dirt', 'gravel']);

/** Surfaces that raise dust, and the colour of that dust. */
const DUST_COLOURS = {
  dirt: [0.42, 0.33, 0.22],
  sand: [0.74, 0.66, 0.45],
  gravel: [0.52, 0.5, 0.46],
  grass: [0.29, 0.4, 0.21],
};

const SPRAY_COLOUR = [0.72, 0.78, 0.84];
const IMPACT_COLOUR = [0.62, 0.6, 0.58];

/** Seconds between dust puffs per wheel, by graphics preset. */
const EMIT_INTERVAL = { potato: 0.14, low: 0.09, medium: 0.06, high: 0.045 };

/** Minimum seconds between skid-mark quads from the same wheel. */
const MARK_INTERVAL = 0.02;

export class DrivingEffects {
  /**
   * @param {object} options
   * @param {THREE.Scene} options.scene
   * @param {object} [options.settings]
   */
  constructor({ scene, settings = null }) {
    this.scene = scene;
    this.settings = settings ?? { preset: 'low', skidMarks: true };
    this.world = null;

    this.marks = null;
    this.particles = null;
    this._preset = null;
    this._emitInterval = EMIT_INTERVAL.low;

    /** Per-wheel anchor: the last point a mark was laid from. */
    this._anchor = [null, null, null, null];
    this._emitTimer = [0, 0, 0, 0];
    this._markTimer = [0, 0, 0, 0];
    this._scratch = { x: 0, y: 0, z: 0 };
    this._liveMarks = 0;

    this._build(this.settings.preset);
  }

  _build(preset) {
    this._preset = preset;
    this._emitInterval = EMIT_INTERVAL[preset] ?? EMIT_INTERVAL.low;
    this._disposeFields();

    this.marks = new SkidMarks({
      scene: this.scene,
      maxQuads: SKID_BUDGET[preset] ?? SKID_BUDGET.low,
    });
    // A disabled mark layer must stay a no-op even if a stray call reaches it.
    if (!this.settings.skidMarks) this.marks.maxQuads = 0;

    this.particles = new ParticleField({
      scene: this.scene,
      max: PARTICLE_BUDGET[preset] ?? PARTICLE_BUDGET.low,
    });
  }

  get skidMarksEnabled() {
    return Boolean(this.marks?.enabled);
  }

  /** Number of particles alive after the last update (perf overlay). */
  get liveParticles() {
    return this.particles?.live ?? 0;
  }

  /** Attach a built world and clear everything left over from the last one. */
  setWorld(world) {
    this.world = world;
    this.marks?.clear();
    this.particles?.clear();
    this._resetAnchors();
    return this;
  }

  applySettings(settings) {
    this.settings = settings;
    const changesPreset = settings.preset !== this._preset;
    const changesMarks = Boolean(settings.skidMarks) !== this.skidMarksEnabled;
    if (changesPreset || changesMarks) this._build(settings.preset);
    else if (!settings.skidMarks && this.marks) this.marks.maxQuads = 0;
    return this;
  }

  /**
   * Advance effects by one frame.
   *
   * @param {number} dt Seconds.
   * @param {object} options
   * @param {import('../vehicles/Vehicle.js').Vehicle} options.vehicle
   * @param {import('./weather.js').Weather} [options.weather]
   */
  update(dt, { vehicle = null, weather = null } = {}) {
    // Particles always integrate, so the plume from a car that has just been
    // recovered or swapped still dissipates instead of freezing mid-air.
    this.particles?.update(dt);
    for (let i = 0; i < 4; i++) this._emitTimer[i] = Math.max(0, this._emitTimer[i] - dt);
    for (let i = 0; i < 4; i++) this._markTimer[i] = Math.max(0, this._markTimer[i] - dt);

    if (!vehicle || !this.world || vehicle.disposed) return;

    const telemetry = vehicle.telemetry;
    const speedKmh = telemetry.speedKmh ?? 0;
    const lateral = Math.abs(telemetry.lateralSpeed ?? 0);
    const drivetrain = vehicle.definition.derived.drivetrainFactors;

    for (let i = 0; i < 4; i++) {
      const wheel = vehicle.wheelStates[i];
      if (!wheel?.inContact) {
        this._anchor[i] = null;
        continue;
      }

      const contact = vehicle.wheelWorldPosition(i, this._scratch);
      const surface = wheel.surface ?? 'asphalt';
      const groundY = this.world.heightAt(contact.x, contact.z);
      const point = { x: contact.x, y: groundY + 0.07, z: contact.z };

      const scrub = this._scrubAmount({ i, telemetry, speedKmh, lateral, drivetrain });
      if (scrub > 0.3 && MARKABLE.has(surface) && this.skidMarksEnabled) {
        if (this._anchor[i] && this._markTimer[i] <= 0) {
          const previous = this._anchor[i];
          if (Math.hypot(point.x - previous.x, point.z - previous.z) >= MARK_SPACING) {
            const halfWidth = clamp(vehicle.definition.wheelRadius * 0.75, 0.12, 0.26);
            if (this.marks.push(previous, point, halfWidth, scrub)) this._liveMarks += 1;
            this._anchor[i] = point;
            this._markTimer[i] = MARK_INTERVAL;
          }
        } else {
          this._anchor[i] = point;
        }
      } else {
        this._anchor[i] = point;
      }

      if (this._emitTimer[i] <= 0 && speedKmh > 5) {
        this._emitGroundEffect({ point, surface, speedKmh, weather, index: i });
      }
    }
  }

  /**
   * How hard this wheel is scrubbing, 0..1.
   *
   * See the module comment: this is inferred from real signals rather than read
   * from a tyre model the physics engine does not have.
   */
  _scrubAmount({ i, telemetry, speedKmh, lateral, drivetrain }) {
    if (speedKmh < 4) return 0;
    let scrub = clamp((lateral - 1.1) / 4.5, 0, 1);
    if (telemetry.handbrake && speedKmh > 8) scrub = Math.max(scrub, clamp(speedKmh / 70, 0.35, 1));
    if ((telemetry.brake ?? 0) > 0.55 && speedKmh > 12) scrub = Math.max(scrub, 0.5);
    // Driven wheels spinning up off the line leave marks even with no lateral slip.
    const axle = i < 2 ? 'front' : 'rear';
    if ((telemetry.throttle ?? 0) > 0.65 && speedKmh < 28 && (drivetrain[axle] ?? 0) > 0) {
      scrub = Math.max(scrub, 0.42);
    }
    return scrub;
  }

  _emitGroundEffect({ point, surface, speedKmh, weather, index }) {
    this._emitTimer[index] = this._emitInterval;
    // A wet paved road throws up spray instead of dust — which is the visible
    // half of the wet-handling change, not a separate feature.
    const wet = weather?.wetness ?? 0;
    const spray = weather?.sprayAt(speedKmh) ?? 0;
    const paved = surface === 'asphalt';

    if (paved && wet > 0.25 && spray > 0.08) {
      this.particles.emit({
        position: point,
        count: 2,
        spread: 1.1 + speedKmh * 0.02,
        rise: 0.5,
        colour: SPRAY_COLOUR,
        alpha: 0.36 * spray,
        size: 0.34,
        life: 0.5,
        gravity: -6.5,
        growth: 0.9,
      });
      return;
    }

    const colour = DUST_COLOURS[surface];
    if (!colour || speedKmh < 8) return;
    const strength = clamp(speedKmh / 90, 0.15, 1);
    this.particles.emit({
      position: point,
      count: 1,
      spread: 0.7 + strength,
      rise: 0.7 + strength,
      colour,
      alpha: 0.3 * strength,
      size: 0.42,
      life: 1.1,
      gravity: -1.3,
      growth: 0.7,
    });
  }

  /**
   * A puff of debris at an impact.
   *
   * Rapier's collision events do not carry a contact point, so the caller
   * supplies the contact position it can infer; see `Game._installCollisionFeedback`.
   */
  impact(position, strength = 1) {
    const amount = clamp(strength, 0, 1);
    this.particles?.emit({
      position,
      count: Math.round(4 + amount * 14),
      spread: 2 + amount * 3,
      rise: 0.8 + amount * 1.6,
      colour: IMPACT_COLOUR,
      alpha: 0.32 * (0.4 + amount),
      size: 0.5,
      life: 1,
      gravity: -2.2,
      growth: 1.1,
    });
  }

  _resetAnchors() {
    this._anchor = [null, null, null, null];
    this._emitTimer = [0, 0, 0, 0];
    this._markTimer = [0, 0, 0, 0];
    this._liveMarks = 0;
  }

  _disposeFields() {
    this.marks?.dispose();
    this.particles?.dispose();
    this.marks = null;
    this.particles = null;
  }

  dispose() {
    this._disposeFields();
    this.world = null;
  }
}
