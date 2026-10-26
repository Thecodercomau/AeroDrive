import { clamp } from '../utilities/math.js';
import { describeObjective } from './challenges.js';

/**
 * Challenge runtime.
 *
 * Owns the whole lifecycle of one attempt: gates, timer, failure conditions,
 * scoring and restart. It contains no DOM and no input handling, which means a
 * complete race — start, gates, timeout, success — can be driven from a unit
 * test by just calling `update()` in a loop.
 *
 * Statuses: `idle` -> `running` -> `completed` | `failed`.
 */

export const MISSION_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
};

/**
 * Objective types that are progressed by driving through ordered gates.
 * `speed-run` (reach a top speed) and `exploration` (find landmarks) are
 * deliberately excluded: neither has gates, so a zero gate count is normal
 * for them rather than a configuration error.
 */
const GATE_BASED_TYPES = new Set([
  'checkpoint-race',
  'time-trial',
  'handling',
  'braking',
  'delivery',
]);

export class MissionRunner {
  /**
   * @param {object} options
   * @param {object} options.challenge
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ challenge, world, bus = null }) {
    this.challenge = challenge;
    this.world = world;
    this.bus = bus;
    this.reset();
  }

  reset() {
    this.status = MISSION_STATUS.IDLE;
    this.elapsed = 0;
    this.checkpoints = this._buildCheckpoints();
    this.checkpointIndex = 0;
    this.failReason = null;
    this.score = 0;
    this.bestSpeedKmh = 0;
    this.offRoadSeconds = 0;
    this.damageAtStart = 0;
    this.landmarksVisited = new Set();
    this.landmarks = this.challenge.build(this.world).landmarks ?? [];
    this._gateCooldown = 0;
    // Braking-test state: `approach` until the trigger line is crossed above the
    // minimum speed, then `stopping` until the car stops or overshoots.
    this.brakingPhase = 'approach';
    this.brakingDistance = 0;
    this.brakingStart = null;
    /** Last known player position, so the HUD can show a live distance-to-go. */
    this._lastPosition = null;
  }

  _buildCheckpoints() {
    try {
      const built = this.challenge.build(this.world);
      return Array.isArray(built.checkpoints) ? built.checkpoints : [];
    } catch (error) {
      console.warn(
        `[Mission] Could not build checkpoints for ${this.challenge.id}:`,
        error.message,
      );
      return [];
    }
  }

  get totalCheckpoints() {
    if (this.challenge.type === 'exploration') return this.landmarks.length;
    return this.checkpoints.length;
  }

  /** Current objective text for the HUD. */
  objectiveText() {
    return describeObjective(this.challenge, {
      checkpointIndex: this.checkpointIndex,
      checkpointTotal: this.totalCheckpoints,
      bestSpeedKmh: this.bestSpeedKmh,
      landmarksVisited: this.landmarksVisited.size,
      landmarksTotal: this.landmarks.length,
      lap: this.challenge.type === 'handling',
      brakingPhase: this.brakingPhase,
      brakingDistance: this.brakingDistance,
      distanceToTarget: this._distanceToNextTarget(),
    });
  }

  /** Straight-line distance to the current objective, or NaN when there is none. */
  _distanceToNextTarget() {
    const target = this.nextTarget();
    const position = this._lastPosition;
    if (!target || !position) return NaN;
    return Math.hypot(target.x - position.x, target.z - position.z);
  }

  /** Time remaining, or null for untimed challenges. */
  get timeRemaining() {
    if (!Number.isFinite(this.challenge.timeLimit)) return null;
    return Math.max(0, this.challenge.timeLimit - this.elapsed);
  }

  start({ damage = 0 } = {}) {
    this.reset();
    this.damageAtStart = damage;

    // A gate-based challenge with no gates can never be completed, which would
    // present the player with a mission button that does nothing. Fail loudly
    // and visibly instead of letting them drive around a broken objective.
    if (GATE_BASED_TYPES.has(this.challenge.type) && this.checkpoints.length === 0) {
      console.error(
        `[Mission] "${this.challenge.id}" produced no checkpoints on map "${this.world?.map?.id ?? 'unknown'}". ` +
          'Check that its road name exists in that map definition.',
      );
      this.status = MISSION_STATUS.FAILED;
      this.failReason = 'Challenge misconfigured (no checkpoints)';
      this.bus?.emit('mission:failed', {
        challenge: this.challenge,
        reason: this.failReason,
        elapsed: 0,
      });
      return this;
    }

    this.status = MISSION_STATUS.RUNNING;
    this.bus?.emit('mission:started', {
      challenge: this.challenge,
      checkpoints: this.checkpoints,
      landmarks: this.landmarks,
    });
    return this;
  }

  /**
   * Advance the challenge.
   * @param {number} dt seconds
   * @param {object} telemetry Vehicle telemetry snapshot.
   */
  update(dt, telemetry) {
    if (this.status !== MISSION_STATUS.RUNNING || !telemetry) return this.status;

    this.elapsed += dt;
    this._gateCooldown = Math.max(0, this._gateCooldown - dt);
    const position = telemetry.position;
    this._lastPosition = position;

    // Objective-specific progress tracking.
    switch (this.challenge.type) {
      case 'speed-run':
        this.bestSpeedKmh = Math.max(this.bestSpeedKmh, telemetry.speedKmh ?? 0);
        if (this.bestSpeedKmh >= this.challenge.targetSpeedKmh) {
          return this._complete(telemetry);
        }
        break;

      case 'exploration':
        this._trackLandmarks(position);
        if (this.landmarks.length > 0 && this.landmarksVisited.size >= this.landmarks.length) {
          return this._complete(telemetry);
        }
        break;

      case 'handling':
        if (telemetry.onSurface && telemetry.onSurface !== 'asphalt') {
          this.offRoadSeconds += dt;
        }
        if (
          Number.isFinite(this.challenge.maxOffRoadSeconds) &&
          this.offRoadSeconds > this.challenge.maxOffRoadSeconds
        ) {
          return this._fail('Too long off the asphalt');
        }
        this._trackGates(position);
        break;

      case 'delivery':
        // Damage is measured against the state at the start of the run, so
        // arriving in a car that was already bent does not instantly fail it.
        if (
          Number.isFinite(this.challenge.maxDamage) &&
          (telemetry.damage ?? 0) - this.damageAtStart > this.challenge.maxDamage
        ) {
          return this._fail('The cargo was damaged');
        }
        this._trackGates(position);
        break;

      case 'braking':
        this._progressBraking(telemetry);
        if (this.status !== MISSION_STATUS.RUNNING) return this.status;
        break;

      case 'checkpoint-race':
      case 'time-trial':
      default:
        this._trackGates(position);
        break;
    }

    // The time limit applies to every timed challenge; free-roam exploration is
    // the one untimed mode, so it is simply skipped here.
    if (
      this.challenge.type !== 'exploration' &&
      Number.isFinite(this.challenge.timeLimit) &&
      this.elapsed > this.challenge.timeLimit
    ) {
      return this._fail('Out of time');
    }

    return this.status;
  }

  /**
   * The braking test: cross the trigger line above a minimum speed, then stop
   * before the stop line.
   *
   * Both a success *and* two distinct failures are possible — arriving too
   * slowly, and failing to stop in time — which is what makes it a test rather
   * than a target.
   */
  _progressBraking(telemetry) {
    const position = telemetry.position;
    const trigger = this.checkpoints[0];
    const stopLine = this.checkpoints[1];
    if (!position || !trigger) return;

    if (this.brakingPhase === 'approach') {
      if (Math.hypot(trigger.x - position.x, trigger.z - position.z) > trigger.radius) return;
      const minimum = this.challenge.minSpeedKmh ?? 100;
      if ((telemetry.speedKmh ?? 0) < minimum) {
        this._fail(`Slower than ${minimum} km/h at the trigger line`);
        return;
      }
      this.brakingPhase = 'stopping';
      this.brakingStart = { x: position.x, z: position.z };
      this.bus?.emit('mission:checkpoint', {
        challenge: this.challenge,
        index: 1,
        total: 2,
      });
      return;
    }

    this.brakingDistance = Math.hypot(
      position.x - this.brakingStart.x,
      position.z - this.brakingStart.z,
    );

    // Checked before the stop line so that coming to rest exactly on it counts
    // as a success rather than an overshoot.
    if ((telemetry.speedKmh ?? 0) < 1.5) {
      this._complete(telemetry);
      return;
    }
    if (
      stopLine &&
      Math.hypot(stopLine.x - position.x, stopLine.z - position.z) <= stopLine.radius
    ) {
      this._fail('Overshot the braking zone');
    }
  }

  _trackGates(position) {
    if (!position || this._gateCooldown > 0) return;
    const gate = this.checkpoints[this.checkpointIndex];
    if (!gate) return;
    const distance = Math.hypot(gate.x - position.x, gate.z - position.z);
    if (distance > gate.radius) return;

    this.checkpointIndex++;
    // A short cooldown stops a single gate being triggered twice by a jitter.
    this._gateCooldown = 0.35;
    this.bus?.emit('mission:checkpoint', {
      challenge: this.challenge,
      index: this.checkpointIndex,
      total: this.checkpoints.length,
    });

    if (this.checkpointIndex >= this.checkpoints.length) {
      this._complete({ position, speedKmh: this.bestSpeedKmh });
    }
  }

  _trackLandmarks(position) {
    if (!position) return;
    for (const landmark of this.landmarks) {
      if (this.landmarksVisited.has(landmark.id)) continue;
      const distance = Math.hypot(landmark.x - position.x, landmark.z - position.z);
      if (distance <= (landmark.radius ?? 45)) {
        this.landmarksVisited.add(landmark.id);
        this.bus?.emit('mission:landmark', { challenge: this.challenge, landmark });
      }
    }
  }

  _complete(telemetry) {
    this.status = MISSION_STATUS.COMPLETED;
    this.score = this._calculateScore(telemetry);

    // Failing a lap challenge because you drove off the circuit is a separate
    // condition from running out of time, and the player should be told which.
    this.bus?.emit('mission:completed', {
      challenge: this.challenge,
      timeSeconds: Number.isFinite(this.challenge.timeLimit) ? this.elapsed : null,
      score: this.score,
      elapsed: this.elapsed,
      brakingDistance: this.challenge.type === 'braking' ? this.brakingDistance : null,
      reward: this.challenge.reward ?? null,
    });
    return this.status;
  }

  _fail(reason) {
    this.status = MISSION_STATUS.FAILED;
    this.failReason = reason;
    this.bus?.emit('mission:failed', { challenge: this.challenge, reason, elapsed: this.elapsed });
    return this.status;
  }

  /**
   * Score rewards finishing quickly and undamaged. Purely a presentation number —
   * records store the time, which is the objective measure.
   */
  _calculateScore(telemetry) {
    const timeLimit = Number.isFinite(this.challenge.timeLimit)
      ? this.challenge.timeLimit
      : Math.max(this.elapsed, 1);
    const timeBonus = clamp(1 - this.elapsed / (timeLimit * 1.4), 0, 1);
    const damage = clamp(telemetry?.damage ?? 0, 0, 100);
    const damageBonus = 1 - damage / 100;
    return Math.round(1000 * (timeBonus * 0.7 + damageBonus * 0.3));
  }

  /** True when the next gate/objective is worth marking on the minimap. */
  nextTarget() {
    if (this.challenge.type === 'exploration') {
      const pending = this.landmarks.filter((landmark) => !this.landmarksVisited.has(landmark.id));
      return pending.length > 0 ? pending[0] : null;
    }
    return this.checkpoints[this.checkpointIndex] ?? null;
  }

  /** All markers for the minimap. */
  minimapMarkers() {
    const markers = [];
    if (this.challenge.type === 'exploration') {
      for (const landmark of this.landmarks) {
        markers.push({
          x: landmark.x,
          z: landmark.z,
          active: !this.landmarksVisited.has(landmark.id),
          colour: this.landmarksVisited.has(landmark.id)
            ? 'rgba(34,197,94,0.9)'
            : 'rgba(255,209,102,0.9)',
          radius: 6,
        });
      }
      return markers;
    }
    this.checkpoints.forEach((checkpoint, index) => {
      markers.push({
        x: checkpoint.x,
        z: checkpoint.z,
        active: index === this.checkpointIndex,
        colour:
          index < this.checkpointIndex
            ? 'rgba(34,197,94,0.85)'
            : index === this.checkpointIndex
              ? 'rgba(255,90,31,0.95)'
              : 'rgba(255,255,255,0.4)',
        radius: index === this.checkpointIndex ? 7 : 4,
      });
    });
    return markers;
  }
}
