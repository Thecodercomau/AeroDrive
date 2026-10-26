import * as THREE from 'three';
import { clamp, damp } from '../utilities/math.js';

/**
 * Camera system.
 *
 * Four in-game modes plus a garage orbit mode:
 *   - `chase`     — smoothed follow camera behind and above the car
 *   - `cockpit`   — driver's eye position from the vehicle definition
 *   - `hood`      — low, forward camera for a sense of speed
 *   - `cinematic` — slow orbiting wide shot
 *
 * The chase camera deliberately does *not* rigidly follow the chassis rotation:
 * it damps position and heading separately, which is what stops the world from
 * appearing to snap sideways every time the car twitches. Mouse look (when
 * pointer is locked) is layered on as an offset so it works in every mode.
 */

export const CAMERA_MODES = ['chase', 'cockpit', 'hood', 'cinematic'];
export const CAMERA_LABELS = {
  chase: 'Chase',
  cockpit: 'Cockpit',
  hood: 'Hood',
  cinematic: 'Cinematic',
};

export class CameraRig {
  constructor({ camera, settings }) {
    this.camera = camera;
    this.settings = settings;
    this.mode = 'chase';
    this.modeIndex = 0;

    this._position = new THREE.Vector3(0, 6, -14);
    this._smoothedLook = new THREE.Vector3();
    this._cinematicAngle = 0;
    this._shake = 0;
    this._shakeOffset = new THREE.Vector3();

    this.mouseYaw = 0;
    this.mousePitch = 0;
  }

  /** Cycle to the next camera mode and return its name. */
  cycle() {
    this.modeIndex = (this.modeIndex + 1) % CAMERA_MODES.length;
    this.mode = CAMERA_MODES[this.modeIndex];
    return this.mode;
  }

  setMode(mode) {
    if (!CAMERA_MODES.includes(mode)) return this.mode;
    this.mode = mode;
    this.modeIndex = CAMERA_MODES.indexOf(mode);
    return this.mode;
  }

  label() {
    return CAMERA_LABELS[this.mode] ?? this.mode;
  }

  /** Add mouse-look delta (pixels) to the camera offset. */
  addLookDelta(deltaX, deltaY) {
    const sensitivity = 0.00022 * (this.settings.get('cameraSensitivity') ?? 1);
    this.mouseYaw = clamp(this.mouseYaw - deltaX * sensitivity, -Math.PI, Math.PI);
    this.mousePitch = clamp(this.mousePitch - deltaY * sensitivity, -0.5, 0.65);
  }

  /** Reset the look offset (used when leaving the car or opening a menu). */
  resetLook() {
    this.mouseYaw = 0;
    this.mousePitch = 0;
  }

  /** Kick the camera (collision feedback). */
  addShake(amount) {
    this._shake = clamp(this._shake + amount, 0, 1.2);
  }

  /**
   * @param {number} dt
   * @param {object} context
   * @param {import('three').Object3D} context.vehicleObject
   * @param {object} context.vehicleDefinition
   * @param {object} context.telemetry
   */
  update(dt, { vehicleObject, vehicleDefinition, telemetry }) {
    if (!vehicleObject) return;

    const positions = vehicleDefinition?.cameraPositions ?? {};
    const speed = telemetry?.speedKmh ?? 0;

    // Decay camera shake rather than cutting it dead, so impacts feel physical.
    this._shake = Math.max(0, this._shake - dt * 2.6);
    const shakeAmount = this._shake * this._shake * 0.4;
    if (shakeAmount > 0.0001) {
      this._shakeOffset.set(
        (Math.random() - 0.5) * shakeAmount,
        (Math.random() - 0.5) * shakeAmount,
        (Math.random() - 0.5) * shakeAmount,
      );
    } else {
      this._shakeOffset.set(0, 0, 0);
    }

    switch (this.mode) {
      case 'cockpit':
        this._updateAttached(dt, vehicleObject, positions.cockpit ?? { x: 0, y: 0.9, z: 0.3 }, 0);
        break;
      case 'hood':
        this._updateAttached(dt, vehicleObject, positions.hood ?? { x: 0, y: 0.9, z: 2 }, 0.1);
        break;
      case 'cinematic':
        this._updateCinematic(dt, vehicleObject);
        break;
      case 'chase':
      default:
        this._updateChase(dt, vehicleObject, positions.chase, speed);
        break;
    }

    this.camera.position.add(this._shakeOffset);
    this.camera.lookAt(this._smoothedLook);
  }

  _updateAttached(dt, vehicleObject, localOffset, lag) {
    const target = new THREE.Vector3(localOffset.x, localOffset.y, localOffset.z);
    vehicleObject.localToWorld(target);

    // A little smoothing in first person keeps small chassis vibrations from
    // making the view unreadable, while staying tight enough to feel attached.
    const smoothing = lag > 0 ? 14 : 26;
    this._position.x = damp(this._position.x, target.x, smoothing, dt);
    this._position.y = damp(this._position.y, target.y, smoothing, dt);
    this._position.z = damp(this._position.z, target.z, smoothing, dt);
    this.camera.position.copy(this._position);

    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(vehicleObject.quaternion);
    const look = target.clone().add(forward.multiplyScalar(12));
    look.y += 0.4 + this.mousePitch * 8;
    if (this.mouseYaw) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        this.mouseYaw,
      );
      const offset = look.clone().sub(target).applyQuaternion(rotation);
      look.copy(target).add(offset);
    }
    this._smoothedLook.lerp(look, clamp(dt * 14, 0, 1));
  }

  _updateChase(dt, vehicleObject, chaseConfig, speed) {
    const config = chaseConfig ?? { distance: 7, height: 3, lookAhead: 4 };
    // Pull the camera back a little at speed for a stronger sense of pace.
    const speedFactor = clamp(speed / 260, 0, 1);
    const distance = config.distance * (1 + speedFactor * 0.35);
    const height = config.height * (1 + speedFactor * 0.12);

    const yaw = this._headingOf(vehicleObject) + this.mouseYaw;
    const targetX = vehicleObject.position.x - Math.sin(yaw) * distance;
    const targetY = vehicleObject.position.y + height;
    const targetZ = vehicleObject.position.z - Math.cos(yaw) * distance;

    // Subtle lag makes cornering feel heavy without inducing motion sickness.
    const stiffness = 7;
    this._position.x = damp(this._position.x, targetX, stiffness, dt);
    this._position.y = damp(this._position.y, targetY, stiffness * 1.4, dt);
    this._position.z = damp(this._position.z, targetZ, stiffness, dt);
    this.camera.position.copy(this._position);

    const ahead = new THREE.Vector3(
      vehicleObject.position.x + Math.sin(yaw) * config.lookAhead,
      vehicleObject.position.y + 1.1 + this.mousePitch * 10,
      vehicleObject.position.z + Math.cos(yaw) * config.lookAhead,
    );
    this._smoothedLook.lerp(ahead, clamp(dt * 9, 0, 1));
  }

  _updateCinematic(dt, vehicleObject) {
    this._cinematicAngle += dt * 0.28;
    const radius = 16;
    const targetX = vehicleObject.position.x + Math.cos(this._cinematicAngle) * radius;
    const targetZ = vehicleObject.position.z + Math.sin(this._cinematicAngle) * radius;
    const targetY = vehicleObject.position.y + 5.5;
    this._position.x = damp(this._position.x, targetX, 2.2, dt);
    this._position.y = damp(this._position.y, targetY, 2.2, dt);
    this._position.z = damp(this._position.z, targetZ, 2.2, dt);
    this.camera.position.copy(this._position);
    this._smoothedLook.lerp(
      vehicleObject.position.clone().setY(vehicleObject.position.y + 0.9),
      clamp(dt * 4, 0, 1),
    );
  }

  /**
   * Orbit the camera around an arbitrary object (garage preview).
   * @param {number} dt
   * @param {THREE.Object3D} object
   * @param {object} options
   */
  updateOrbit(dt, object, { distance = 9, height = 3.4, speed = 0.35, targetHeight = 0.8 } = {}) {
    if (!object) return;
    this._cinematicAngle += dt * speed;
    const px = object.position.x + Math.cos(this._cinematicAngle) * distance;
    const pz = object.position.z + Math.sin(this._cinematicAngle) * distance;
    const py = object.position.y + height;
    this._position.lerp(new THREE.Vector3(px, py, pz), clamp(dt * 3.2, 0, 1));
    this.camera.position.copy(this._position);
    this._smoothedLook.lerp(
      new THREE.Vector3(object.position.x, object.position.y + targetHeight, object.position.z),
      clamp(dt * 5, 0, 1),
    );
    this.camera.lookAt(this._smoothedLook);
  }

  _headingOf(object) {
    // Yaw about +Y from the object's quaternion.
    const q = object.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  /** Snap the camera straight to its target (used after a teleport/reset). */
  snapTo(vehicleObject, definition) {
    this.update(1, { vehicleObject, vehicleDefinition: definition, telemetry: { speedKmh: 0 } });
  }
}
