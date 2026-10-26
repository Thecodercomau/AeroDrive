import { normaliseVehicleConfig } from './vehicleConfig.js';

/**
 * The AERODRIVE vehicle fleet.
 *
 * Each entry is a *partial* definition; `normaliseVehicleConfig` fills in the
 * rest of the schema. The numbers are hand-tuned so every vehicle has a
 * genuinely different character (mass, grip, gear spread, steering response)
 * rather than being a recolour of the same car.
 *
 * All geometry is generated procedurally by the game — no external models.
 */

/** @type {Array<object>} */
export const VEHICLE_DEFINITIONS = [
  {
    id: 'hatchback',
    name: 'Kestrel 1.4',
    klass: 'hatchback',
    description: 'Light, cheap, and eager. The friendliest way to learn the map.',
    wheelbase: 2.45,
    trackWidth: 1.46,
    massKg: 1080,
    chassisHalfExtents: { x: 0.86, y: 0.62, z: 1.95 },
    centreOfMass: { x: 0, y: -0.42, z: 0.1 },
    wheelRadius: 0.31,
    suspension: {
      restLength: 0.36,
      stiffness: 58,
      compression: 1.5,
      relaxation: 2.4,
      maxTravel: 0.2,
      maxForce: 26000,
    },
    tyre: {
      frictionSlip: 1.85,
      sideFrictionStiffness: 1.0,
      surfaceGrip: { asphalt: 1, dirt: 0.78, grass: 0.6, sand: 0.52 },
    },
    drivetrain: 'fwd',
    engine: {
      idleRpm: 820,
      redlineRpm: 6200,
      shiftUpRpm: 5600,
      shiftDownRpm: 2000,
      shiftTime: 0.34,
      forwardRatios: [3.6, 2.1, 1.4, 1.05, 0.82],
      reverseRatio: 3.5,
      finalDrive: 3.9,
      torqueCurve: [
        [800, 78],
        [2200, 118],
        [3800, 128],
        [5400, 112],
        [6200, 88],
      ],
    },
    brakes: { maxBrake: 20, handbrakeFactor: 3.0, brakeBias: 0.68 },
    steering: {
      maxAngleDeg: 36,
      speedFalloff: 0.5,
      falloffSpeedKmh: 150,
      maxSteerRateDegPerSec: 260,
    },
    aero: { dragCoefficient: 0.31, downforce: 0.35, rollingResistance: 0.016 },
    assists: { tractionControl: 0.45, abs: true, stability: 0.3 },
    stats: { powerHp: 108, topSpeedKmh: 190, zeroTo100: 10.4 },
    paint: {
      default: 'racingRed',
      palette: ['factory', 'racingRed', 'sunburstYellow', 'pearlWhite', 'forestGreen'],
    },
    audio: { cylinders: 4, noteOffset: 4, idleGain: 0.24, maxGain: 0.52 },
    cameraPositions: {
      chase: { distance: 6.4, height: 2.7, lookAhead: 3.6 },
      cockpit: { x: 0, y: 0.92, z: 0.45 },
    },
  },

  {
    id: 'sedan',
    name: 'Meridian 2.0T',
    klass: 'sedan',
    description: 'Composed executive cruiser. Stable at speed, comfortable on gravel.',
    wheelbase: 2.83,
    trackWidth: 1.58,
    massKg: 1490,
    chassisHalfExtents: { x: 0.9, y: 0.63, z: 2.32 },
    centreOfMass: { x: 0, y: -0.4, z: 0.05 },
    wheelRadius: 0.34,
    suspension: {
      restLength: 0.36,
      stiffness: 50,
      compression: 1.7,
      relaxation: 2.6,
      maxTravel: 0.22,
      maxForce: 30000,
    },
    tyre: {
      frictionSlip: 2.1,
      sideFrictionStiffness: 1.05,
      surfaceGrip: { asphalt: 1, dirt: 0.7, grass: 0.52, sand: 0.44 },
    },
    drivetrain: 'rwd',
    engine: {
      idleRpm: 780,
      redlineRpm: 6600,
      shiftUpRpm: 6000,
      shiftDownRpm: 2100,
      shiftTime: 0.26,
      forwardRatios: [3.5, 2.2, 1.55, 1.18, 0.94, 0.78],
      reverseRatio: 3.4,
      finalDrive: 3.5,
      torqueCurve: [
        [800, 140],
        [2000, 240],
        [3000, 290],
        [4600, 300],
        [6200, 250],
        [6600, 200],
      ],
    },
    brakes: { maxBrake: 26, handbrakeFactor: 2.6, brakeBias: 0.64 },
    steering: {
      maxAngleDeg: 33,
      speedFalloff: 0.52,
      falloffSpeedKmh: 170,
      maxSteerRateDegPerSec: 240,
    },
    aero: { dragCoefficient: 0.3, downforce: 0.45, rollingResistance: 0.013 },
    assists: { tractionControl: 0.4, abs: true, stability: 0.28 },
    stats: { powerHp: 245, topSpeedKmh: 240, zeroTo100: 6.4 },
    paint: {
      default: 'graphite',
      palette: ['factory', 'graphite', 'midnightBlue', 'pearlWhite', 'forestGreen'],
    },
    audio: { cylinders: 6, noteOffset: 0, idleGain: 0.26, maxGain: 0.56 },
    cameraPositions: {
      chase: { distance: 7.0, height: 3.0, lookAhead: 4.0 },
      cockpit: { x: 0, y: 0.95, z: 0.3 },
    },
  },

  {
    id: 'coupe',
    name: 'Vector GT',
    klass: 'coupe',
    description: 'Rear-drive sports coupe. Balanced, talkative chassis with real grip.',
    wheelbase: 2.7,
    trackWidth: 1.62,
    massKg: 1340,
    chassisHalfExtents: { x: 0.92, y: 0.55, z: 2.15 },
    centreOfMass: { x: 0, y: -0.38, z: -0.15 },
    wheelRadius: 0.34,
    suspension: {
      restLength: 0.32,
      stiffness: 68,
      compression: 1.9,
      relaxation: 2.9,
      maxTravel: 0.18,
      maxForce: 32000,
    },
    tyre: {
      frictionSlip: 2.55,
      sideFrictionStiffness: 1.25,
      surfaceGrip: { asphalt: 1, dirt: 0.6, grass: 0.45, sand: 0.4 },
    },
    drivetrain: 'rwd',
    engine: {
      idleRpm: 900,
      redlineRpm: 7600,
      shiftUpRpm: 7200,
      shiftDownRpm: 2600,
      shiftTime: 0.18,
      forwardRatios: [3.2, 2.05, 1.5, 1.2, 1.0, 0.85],
      reverseRatio: 3.2,
      finalDrive: 3.7,
      torqueCurve: [
        [900, 150],
        [2400, 300],
        [4200, 390],
        [5800, 395],
        [7200, 320],
        [7600, 260],
      ],
    },
    brakes: { maxBrake: 30, handbrakeFactor: 2.2, brakeBias: 0.61 },
    steering: {
      maxAngleDeg: 32,
      speedFalloff: 0.58,
      falloffSpeedKmh: 200,
      maxSteerRateDegPerSec: 260,
    },
    aero: { dragCoefficient: 0.33, downforce: 0.9, rollingResistance: 0.012 },
    assists: { tractionControl: 0.3, abs: true, stability: 0.2 },
    stats: { powerHp: 380, topSpeedKmh: 275, zeroTo100: 4.6 },
    paint: {
      default: 'sunburstYellow',
      palette: ['sunburstYellow', 'racingRed', 'midnightBlue', 'pearlWhite', 'graphite'],
    },
    audio: { cylinders: 6, noteOffset: -2, idleGain: 0.3, maxGain: 0.66 },
    cameraPositions: {
      chase: { distance: 6.8, height: 2.8, lookAhead: 4.2 },
      cockpit: { x: 0, y: 0.82, z: 0.15 },
      hood: { x: 0, y: 0.92, z: 1.9 },
    },
  },

  {
    id: 'supercar',
    name: 'Halcyon RS',
    klass: 'supercar',
    description: 'All-wheel-drive hypercar. Enormous grip, unforgiving of impatience.',
    wheelbase: 2.65,
    trackWidth: 1.7,
    massKg: 1450,
    chassisHalfExtents: { x: 1.02, y: 0.48, z: 2.2 },
    centreOfMass: { x: 0, y: -0.34, z: -0.25 },
    wheelRadius: 0.35,
    suspension: {
      restLength: 0.28,
      stiffness: 88,
      compression: 2.2,
      relaxation: 3.4,
      maxTravel: 0.15,
      maxForce: 38000,
    },
    tyre: {
      frictionSlip: 3.05,
      sideFrictionStiffness: 1.4,
      surfaceGrip: { asphalt: 1, dirt: 0.5, grass: 0.36, sand: 0.32 },
    },
    drivetrain: 'awd',
    engine: {
      idleRpm: 1100,
      redlineRpm: 8800,
      shiftUpRpm: 8400,
      shiftDownRpm: 3200,
      shiftTime: 0.1,
      forwardRatios: [3.0, 2.0, 1.5, 1.2, 1.0, 0.88, 0.78],
      reverseRatio: 3.0,
      finalDrive: 3.9,
      torqueCurve: [
        [1100, 220],
        [3000, 480],
        [5200, 620],
        [7000, 640],
        [8400, 560],
        [8800, 460],
      ],
    },
    brakes: { maxBrake: 38, handbrakeFactor: 1.9, brakeBias: 0.6 },
    steering: {
      maxAngleDeg: 28,
      speedFalloff: 0.66,
      falloffSpeedKmh: 220,
      maxSteerRateDegPerSec: 280,
    },
    aero: { dragCoefficient: 0.34, downforce: 1.9, rollingResistance: 0.011 },
    assists: { tractionControl: 0.45, abs: true, stability: 0.35 },
    stats: { powerHp: 740, topSpeedKmh: 330, zeroTo100: 2.9 },
    paint: {
      default: 'racingRed',
      palette: ['racingRed', 'burntOrange', 'pearlWhite', 'graphite', 'midnightBlue'],
    },
    audio: { cylinders: 8, noteOffset: -5, idleGain: 0.32, maxGain: 0.72 },
    cameraPositions: {
      chase: { distance: 6.6, height: 2.6, lookAhead: 4.6 },
      cockpit: { x: 0, y: 0.72, z: 0.1 },
      hood: { x: 0, y: 0.8, z: 2.0 },
    },
  },

  {
    id: 'suv',
    name: 'Ridgeline 4x4',
    klass: 'suv',
    description: 'Tall, heavy, and unbothered by rough ground. Body roll is real.',
    wheelbase: 2.95,
    trackWidth: 1.68,
    massKg: 2150,
    chassisHalfExtents: { x: 1.0, y: 0.82, z: 2.45 },
    centreOfMass: { x: 0, y: -0.28, z: 0.05 },
    wheelRadius: 0.4,
    suspension: {
      restLength: 0.48,
      stiffness: 40,
      compression: 1.6,
      relaxation: 2.3,
      maxTravel: 0.3,
      maxForce: 34000,
    },
    tyre: {
      frictionSlip: 2.0,
      sideFrictionStiffness: 0.95,
      surfaceGrip: { asphalt: 0.95, dirt: 0.85, grass: 0.72, sand: 0.62 },
    },
    drivetrain: 'awd',
    engine: {
      idleRpm: 700,
      redlineRpm: 5200,
      shiftUpRpm: 4700,
      shiftDownRpm: 1800,
      shiftTime: 0.36,
      forwardRatios: [3.9, 2.3, 1.55, 1.15, 0.88],
      reverseRatio: 3.8,
      finalDrive: 3.9,
      torqueCurve: [
        [700, 260],
        [1600, 420],
        [2800, 480],
        [4000, 460],
        [5200, 380],
      ],
    },
    brakes: { maxBrake: 28, handbrakeFactor: 2.4, brakeBias: 0.62 },
    steering: {
      maxAngleDeg: 34,
      speedFalloff: 0.44,
      falloffSpeedKmh: 140,
      maxSteerRateDegPerSec: 200,
    },
    aero: { dragCoefficient: 0.43, downforce: 0.25, rollingResistance: 0.019 },
    assists: { tractionControl: 0.55, abs: true, stability: 0.4 },
    stats: { powerHp: 300, topSpeedKmh: 210, zeroTo100: 7.4 },
    paint: {
      default: 'forestGreen',
      palette: ['forestGreen', 'olive', 'graphite', 'pearlWhite', 'sand'],
    },
    audio: { cylinders: 6, noteOffset: 6, idleGain: 0.3, maxGain: 0.58 },
    cameraPositions: {
      chase: { distance: 7.6, height: 3.6, lookAhead: 4.0 },
      cockpit: { x: 0, y: 1.15, z: 0.4 },
    },
  },

  {
    id: 'pickup',
    name: 'Boulder 2500',
    klass: 'pickup',
    description: 'Long-wheelbase workhorse. Slow to turn, impossible to upset.',
    wheelbase: 3.35,
    trackWidth: 1.72,
    massKg: 2380,
    chassisHalfExtents: { x: 1.02, y: 0.72, z: 2.75 },
    centreOfMass: { x: 0, y: -0.24, z: 0.35 },
    wheelRadius: 0.42,
    suspension: {
      restLength: 0.5,
      stiffness: 38,
      compression: 1.5,
      relaxation: 2.2,
      maxTravel: 0.32,
      maxForce: 36000,
    },
    tyre: {
      frictionSlip: 1.95,
      sideFrictionStiffness: 0.9,
      surfaceGrip: { asphalt: 0.94, dirt: 0.88, grass: 0.75, sand: 0.68 },
    },
    drivetrain: 'rwd',
    engine: {
      idleRpm: 650,
      redlineRpm: 4800,
      shiftUpRpm: 4300,
      shiftDownRpm: 1700,
      shiftTime: 0.42,
      forwardRatios: [4.2, 2.4, 1.6, 1.15, 0.86],
      reverseRatio: 4.0,
      finalDrive: 4.1,
      torqueCurve: [
        [650, 320],
        [1500, 520],
        [2600, 600],
        [3600, 580],
        [4800, 470],
      ],
    },
    brakes: { maxBrake: 30, handbrakeFactor: 2.8, brakeBias: 0.6 },
    steering: {
      maxAngleDeg: 33,
      speedFalloff: 0.4,
      falloffSpeedKmh: 130,
      maxSteerRateDegPerSec: 180,
    },
    aero: { dragCoefficient: 0.48, downforce: 0.2, rollingResistance: 0.021 },
    assists: { tractionControl: 0.5, abs: true, stability: 0.38 },
    stats: { powerHp: 360, topSpeedKmh: 195, zeroTo100: 8.6 },
    paint: {
      default: 'burntOrange',
      palette: ['burntOrange', 'graphite', 'pearlWhite', 'olive', 'sand'],
    },
    audio: { cylinders: 8, noteOffset: 8, idleGain: 0.3, maxGain: 0.6 },
    cameraPositions: {
      chase: { distance: 8.0, height: 3.7, lookAhead: 4.2 },
      cockpit: { x: 0, y: 1.2, z: 0.6 },
    },
  },

  {
    id: 'offroad',
    name: 'Terra Pro',
    klass: 'offroad',
    description: 'Soft long-travel suspension and lockers. Built for trails, not tarmac.',
    wheelbase: 2.6,
    trackWidth: 1.66,
    massKg: 1980,
    chassisHalfExtents: { x: 0.98, y: 0.78, z: 2.15 },
    centreOfMass: { x: 0, y: -0.42, z: 0 },
    wheelRadius: 0.44,
    suspension: {
      restLength: 0.62,
      stiffness: 34,
      compression: 1.4,
      relaxation: 2.0,
      maxTravel: 0.42,
      maxForce: 32000,
    },
    tyre: {
      frictionSlip: 2.3,
      sideFrictionStiffness: 1.0,
      surfaceGrip: { asphalt: 0.88, dirt: 0.95, grass: 0.85, sand: 0.8 },
    },
    drivetrain: 'awd',
    engine: {
      idleRpm: 750,
      redlineRpm: 5000,
      shiftUpRpm: 4500,
      shiftDownRpm: 1900,
      shiftTime: 0.38,
      forwardRatios: [4.0, 2.35, 1.55, 1.12, 0.85],
      reverseRatio: 4.2,
      finalDrive: 4.3,
      torqueCurve: [
        [750, 280],
        [1800, 470],
        [3000, 520],
        [4000, 500],
        [5000, 420],
      ],
    },
    brakes: { maxBrake: 26, handbrakeFactor: 2.0, brakeBias: 0.58 },
    steering: {
      maxAngleDeg: 40,
      speedFalloff: 0.42,
      falloffSpeedKmh: 120,
      maxSteerRateDegPerSec: 190,
    },
    aero: { dragCoefficient: 0.5, downforce: 0.15, rollingResistance: 0.024 },
    assists: { tractionControl: 0.2, abs: true, stability: 0.3 },
    stats: { powerHp: 320, topSpeedKmh: 175, zeroTo100: 9.2 },
    paint: {
      default: 'olive',
      palette: ['olive', 'forestGreen', 'sand', 'graphite', 'burntOrange'],
    },
    audio: { cylinders: 6, noteOffset: 10, idleGain: 0.32, maxGain: 0.62 },
    cameraPositions: {
      chase: { distance: 7.4, height: 3.4, lookAhead: 4.0 },
      cockpit: { x: 0, y: 1.05, z: 0.3 },
    },
  },
];

/** Which challenge unlocks each vehicle (starter vehicles are never gated). */
export const VEHICLE_UNLOCK_RULES = {
  coupe: { challengeId: 'alpine-time-trial', label: 'Win the Alpine Time Trial' },
  supercar: { challengeId: 'coastal-speed-run', label: 'Beat the Coastal Speed Run' },
  suv: { challengeId: 'desert-handling', label: 'Clear the Desert Handling Test' },
  pickup: { challengeId: 'city-checkpoint', label: 'Finish the City Checkpoint Race' },
  offroad: { challengeId: 'trail-explorer', label: 'Complete the Trail Explorer run' },
};

/** All definitions, validated and normalised. Built once at module load. */
export const VEHICLES = VEHICLE_DEFINITIONS.map((definition) => normaliseVehicleConfig(definition));

const BY_ID = new Map(VEHICLES.map((vehicle) => [vehicle.id, vehicle]));

/** Look up a normalised vehicle definition by id. Returns null when unknown. */
export function getVehicleDefinition(id) {
  return BY_ID.get(id) ?? null;
}

/** The definition the player starts with. */
export function defaultVehicleId() {
  return VEHICLES[0].id;
}
