import { clamp, degToRad } from '../utilities/math.js';

/**
 * Vehicle definition schema, defaults, and validation.
 *
 * Every drivable vehicle in the game is described by one of these objects.
 * Keeping the schema explicit (rather than loose literals scattered through the
 * code) means the garage UI, the physics builder, and the tests all agree on
 * what a vehicle *is*, and that a typo in a definition is caught loudly instead
 * of silently producing a car that cannot move.
 */

export const VEHICLE_CLASSES = [
  'hatchback',
  'sedan',
  'coupe',
  'supercar',
  'suv',
  'pickup',
  'offroad',
];

export const DRIVETRAINS = ['fwd', 'rwd', 'awd'];

/** Base definition with every field present and sane. */
export const VEHICLE_DEFAULTS = {
  id: 'unnamed',
  name: 'Unnamed Vehicle',
  klass: 'sedan',
  description: '',
  credit: 'Procedurally modelled in-engine, no external assets.',

  // --- Body ---------------------------------------------------------------
  massKg: 1300,
  // Local-space offset of the centre of mass from the chassis origin.
  centreOfMass: { x: 0, y: -0.35, z: 0 },
  chassisHalfExtents: { x: 0.9, y: 0.45, z: 2.1 },
  // Collider used for the body: a single box keeps contacts cheap and stable.
  colliderFriction: 0.6,
  colliderRestitution: 0.08,
  // Velocity damping is not a stability aid: Rapier applies it to the whole
  // body every step. 0.06 removed ~1790 N at highway speed and capped cars
  // far below their rated top speed. Keep it tiny; aero drag does the work.
  linearDamping: 0.005,
  angularDamping: 0.35,

  // --- Wheels -------------------------------------------------------------
  wheelRadius: 0.33,
  wheelWidth: 0.24,
  wheelbase: 2.6, // front axle to rear axle
  trackWidth: 1.55, // left wheel to right wheel
  wheelInsetY: -0.05, // wheel centre relative to chassis origin

  // --- Suspension ---------------------------------------------------------
  suspension: {
    restLength: 0.34,
    stiffness: 32,
    compression: 0.7,
    relaxation: 0.9,
    maxTravel: 0.22,
    maxForce: 22000,
  },

  // --- Tyres --------------------------------------------------------------
  tyre: {
    frictionSlip: 2.2,
    sideFrictionStiffness: 1.1,
    // Multipliers applied to frictionSlip per surface type.
    surfaceGrip: { asphalt: 1, dirt: 0.72, grass: 0.55, sand: 0.48 },
  },

  // --- Drivetrain ---------------------------------------------------------
  drivetrain: 'rwd',
  engine: {
    idleRpm: 850,
    redlineRpm: 6800,
    shiftUpRpm: 6200,
    shiftDownRpm: 2200,
    shiftTime: 0.26,
    forwardRatios: [3.4, 2.1, 1.5, 1.15, 0.92, 0.76],
    reverseRatio: 3.3,
    finalDrive: 3.6,
    // [rpm, newton-metres], ascending by rpm.
    torqueCurve: [
      [800, 120],
      [2500, 210],
      [4200, 235],
      [6000, 200],
      [6800, 150],
    ],
  },

  // --- Brakes / steering --------------------------------------------------
  brakes: {
    maxBrake: 7200, // brake force in newtons per wheel before brake bias
    handbrakeFactor: 3.2, // multiplier on the rear wheels
    brakeBias: 0.62, // fraction of braking force to the front axle
  },
  steering: {
    maxAngleDeg: 34,
    // Steering authority is reduced as speed rises so the car does not snap
    // sideways at 200 km/h.
    speedFalloff: 0.55,
    falloffSpeedKmh: 190,
    maxSteerRateDegPerSec: 220,
    returnRateDegPerSec: 320,
  },

  // --- Aero / handling ----------------------------------------------------
  aero: {
    dragCoefficient: 0.32,
    downforce: 0.6,
    rollingResistance: 0.014,
  },

  // --- Assistance ---------------------------------------------------------
  assists: {
    tractionControl: 0.35, // 0 = off, 1 = very aggressive
    abs: true,
    stability: 0.25,
  },

  // --- Presentation -------------------------------------------------------
  paint: {
    default: 'factory',
    palette: [
      'factory',
      'racingRed',
      'midnightBlue',
      'pearlWhite',
      'sunburstYellow',
      'forestGreen',
      'graphite',
    ],
  },
  headlights: {
    colour: 0xfff2d0,
    intensity: 1.6,
    distance: 90,
    // Local-space offsets for the two lamp units.
    offsets: [
      { x: -0.6, y: 0.42, z: 2.0 },
      { x: 0.6, y: 0.42, z: 2.0 },
    ],
  },
  cameraPositions: {
    chase: { distance: 7.2, height: 3.1, lookAhead: 4 },
    cockpit: { x: -0.3, y: 0.4, z: 0.1 },
    hood: { x: 0, y: 0.24, z: 2.1 },
  },
  audio: {
    // Engine note shaping: `noteOffset` is a semitone offset applied to the
    // synthesised engine tone so each vehicle sounds distinct.
    cylinders: 4,
    noteOffset: 0,
    idleGain: 0.28,
    maxGain: 0.62,
  },

  // --- Stats shown in the garage -----------------------------------------
  stats: {
    powerHp: 180,
    topSpeedKmh: 210,
    zeroTo100: 8.2,
  },
};

/** Read the axle torque split for a drivetrain layout. @returns {{front:number, rear:number}} */
export function drivetrainFactors(drivetrain) {
  switch (drivetrain) {
    case 'fwd':
      return { front: 1, rear: 0 };
    case 'awd':
      return { front: 0.5, rear: 0.5 };
    case 'rwd':
    default:
      return { front: 0, rear: 1 };
  }
}

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validate a vehicle definition.
 * Returns `{ valid, errors }` — never throws, so a bad mod file cannot crash
 * the game at load time.
 */
export function validateVehicleConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['definition must be an object'] };
  }

  if (typeof config.id !== 'string' || config.id.length === 0) errors.push('id is required');
  if (typeof config.name !== 'string' || config.name.length === 0) errors.push('name is required');
  if (!VEHICLE_CLASSES.includes(config.klass)) {
    errors.push(`klass must be one of ${VEHICLE_CLASSES.join(', ')}`);
  }
  if (!DRIVETRAINS.includes(config.drivetrain)) {
    errors.push(`drivetrain must be one of ${DRIVETRAINS.join(', ')}`);
  }
  if (!isFinitePositive(config.massKg)) errors.push('massKg must be a positive number');
  if (!isFinitePositive(config.wheelRadius)) errors.push('wheelRadius must be a positive number');
  if (!isFinitePositive(config.wheelbase)) errors.push('wheelbase must be a positive number');
  if (!isFinitePositive(config.trackWidth)) errors.push('trackWidth must be a positive number');

  for (const axis of ['x', 'y', 'z']) {
    if (!isFinitePositive(config.chassisHalfExtents?.[axis])) {
      errors.push(`chassisHalfExtents.${axis} must be a positive number`);
    }
  }

  const suspension = config.suspension ?? {};
  for (const key of ['restLength', 'stiffness', 'maxTravel', 'maxForce']) {
    if (!isFinitePositive(suspension[key])) errors.push(`suspension.${key} must be > 0`);
  }

  const engine = config.engine ?? {};
  if (!isFinitePositive(engine.idleRpm)) errors.push('engine.idleRpm must be > 0');
  if (!isFinitePositive(engine.redlineRpm)) errors.push('engine.redlineRpm must be > 0');
  if (
    isFinitePositive(engine.idleRpm) &&
    isFinitePositive(engine.redlineRpm) &&
    engine.idleRpm >= engine.redlineRpm
  ) {
    errors.push('engine.idleRpm must be below engine.redlineRpm');
  }
  if (!Array.isArray(engine.forwardRatios) || engine.forwardRatios.length === 0) {
    errors.push('engine.forwardRatios must be a non-empty array');
  } else if (engine.forwardRatios.some((r) => !isFinitePositive(r))) {
    errors.push('engine.forwardRatios entries must all be > 0');
  }
  if (!Array.isArray(engine.torqueCurve) || engine.torqueCurve.length < 2) {
    errors.push('engine.torqueCurve must contain at least two [rpm, torque] points');
  } else {
    for (const point of engine.torqueCurve) {
      if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
        errors.push('engine.torqueCurve points must be [rpm, torque] number pairs');
        break;
      }
    }
  }

  if (!isFinitePositive(config.steering?.maxAngleDeg)) {
    errors.push('steering.maxAngleDeg must be > 0');
  }
  if (!isFinitePositive(config.brakes?.maxBrake)) {
    errors.push('brakes.maxBrake must be > 0');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Merge a partial definition over the defaults and fill in derived values.
 * Throws only on a definition that is structurally invalid, so programming
 * mistakes surface during development rather than at runtime mid-race.
 */
export function normaliseVehicleConfig(partial) {
  const merged = {
    ...VEHICLE_DEFAULTS,
    ...partial,
    suspension: { ...VEHICLE_DEFAULTS.suspension, ...(partial.suspension ?? {}) },
    tyre: {
      ...VEHICLE_DEFAULTS.tyre,
      ...(partial.tyre ?? {}),
      surfaceGrip: {
        ...VEHICLE_DEFAULTS.tyre.surfaceGrip,
        ...(partial.tyre?.surfaceGrip ?? {}),
      },
    },
    engine: {
      ...VEHICLE_DEFAULTS.engine,
      ...(partial.engine ?? {}),
      forwardRatios: partial.engine?.forwardRatios ?? VEHICLE_DEFAULTS.engine.forwardRatios,
      torqueCurve: partial.engine?.torqueCurve ?? VEHICLE_DEFAULTS.engine.torqueCurve,
    },
    brakes: { ...VEHICLE_DEFAULTS.brakes, ...(partial.brakes ?? {}) },
    steering: { ...VEHICLE_DEFAULTS.steering, ...(partial.steering ?? {}) },
    aero: { ...VEHICLE_DEFAULTS.aero, ...(partial.aero ?? {}) },
    assists: { ...VEHICLE_DEFAULTS.assists, ...(partial.assists ?? {}) },
    paint: {
      ...VEHICLE_DEFAULTS.paint,
      ...(partial.paint ?? {}),
      palette: partial.paint?.palette ?? VEHICLE_DEFAULTS.paint.palette,
    },
    cameraPositions: {
      ...VEHICLE_DEFAULTS.cameraPositions,
      ...(partial.cameraPositions ?? {}),
    },
    audio: { ...VEHICLE_DEFAULTS.audio, ...(partial.audio ?? {}) },
    stats: { ...VEHICLE_DEFAULTS.stats, ...(partial.stats ?? {}) },
  };

  // Derived: the wheel connection points are always consistent with the
  // wheelbase/track, so a definition never has to repeat them.
  merged.derived = {
    halfWheelbase: merged.wheelbase / 2,
    halfTrack: merged.trackWidth / 2,
    maxSteerRadians: degToRad(clamp(merged.steering.maxAngleDeg, 5, 60)),
    drivetrainFactors: drivetrainFactors(merged.drivetrain),
  };

  const { valid, errors } = validateVehicleConfig(merged);
  if (!valid) {
    throw new Error(`Invalid vehicle definition "${merged.id}":\n  - ${errors.join('\n  - ')}`);
  }
  return merged;
}

/**
 * Steering angle for a given speed.
 *
 * At low speed the driver gets the full lock; as speed builds the maximum angle
 * is progressively reduced. Without this, a full-lock input at 180 km/h produces
 * an instant spin that no amount of player skill can catch.
 *
 * @param {number} steerInput -1..1
 * @param {number} speedKmh
 * @param {{ maxAngleDeg: number, falloffSpeedKmh: number, speedFalloff: number }} steering
 * @returns {number} radians
 */
export function steeringAngleForSpeed(steerInput, speedKmh, steering) {
  const maxAngle = degToRad(clamp(steering.maxAngleDeg, 1, 60));
  const falloffSpeed = Math.max(1, steering.falloffSpeedKmh);
  const t = clamp(Math.abs(speedKmh) / falloffSpeed, 0, 1);
  const falloff = 1 - clamp(steering.speedFalloff, 0, 0.95) * t;
  return clamp(steerInput, -1, 1) * maxAngle * falloff;
}
