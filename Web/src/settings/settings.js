/**
 * Settings schema, defaults, quality presets, and validation.
 *
 * All functions here are pure so they can be unit-tested without a browser.
 * The store persists whatever `sanitiseSettings()` returns, which guarantees a
 * corrupted or partially-written localStorage entry can never crash startup.
 */

export const SETTINGS_VERSION = 1;

export const DEFAULT_BINDINGS = {
  accelerate: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  steerLeft: ['KeyA', 'ArrowLeft'],
  steerRight: ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  shiftUp: ['ShiftLeft', 'ShiftRight'],
  shiftDown: ['ControlLeft', 'ControlRight'],
  camera: ['KeyC'],
  recover: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  headlights: ['KeyH'],
  toggleGuide: ['KeyM'],
  togglePerf: ['F3'],
  toggleDrift: ['KeyG'],
  horn: ['KeyF'],
};

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  preset: 'low',

  // Graphics
  renderScale: 0.85,
  viewDistance: 700,
  shadows: 'low',
  antialias: 'off',
  textureQuality: 'low',
  vegetationDensity: 45,
  trafficDensity: 25,
  fpsLimit: 0,
  showFps: false,

  // Audio
  masterVolume: 80,
  engineVolume: 75,
  effectsVolume: 70,
  ambienceVolume: 55,

  // Controls
  bindings: { ...DEFAULT_BINDINGS },
  gamepadDeadzone: 0.12,
  cameraSensitivity: 1,

  // Driving
  transmission: 'auto',

  // World
  // `timeOfDay` is a clock hour (9.5 = 09:30). The cycle advances it while
  // driving at the speed set by `dayLengthMinutes`.
  timeOfDay: 10,
  dayNightCycle: true,
  dayLengthMinutes: 24,
  weather: 'clear',

  // Presentation
  showControlGuide: true,
  units: 'metric',
  skidMarks: true,
};

/**
 * Graphics presets. Each preset is a *partial* settings patch applied on top of
 * the defaults. Lower presets are tuned so the game stays playable on
 * integrated graphics and older dual-core laptops.
 */
export const QUALITY_PRESETS = {
  potato: {
    preset: 'potato',
    renderScale: 0.6,
    viewDistance: 350,
    shadows: 'off',
    antialias: 'off',
    textureQuality: 'low',
    vegetationDensity: 15,
    trafficDensity: 0,
    // Environmental *effects* are the first thing to go on a weak machine: skid
    // marks grow without bound in memory. Weather itself is deliberately not set
    // here — that is the player's choice, not a quality level, so only its
    // particle budget scales with the preset.
    skidMarks: false,
  },
  low: {
    preset: 'low',
    renderScale: 0.85,
    viewDistance: 700,
    shadows: 'low',
    antialias: 'off',
    textureQuality: 'low',
    vegetationDensity: 45,
    trafficDensity: 25,
    skidMarks: true,
  },
  medium: {
    preset: 'medium',
    renderScale: 1,
    viewDistance: 1400,
    shadows: 'medium',
    antialias: 'fxaa',
    textureQuality: 'medium',
    vegetationDensity: 75,
    trafficDensity: 50,
    skidMarks: true,
  },
  high: {
    preset: 'high',
    renderScale: 1,
    viewDistance: 2600,
    shadows: 'high',
    antialias: 'msaa',
    textureQuality: 'high',
    vegetationDensity: 100,
    trafficDensity: 70,
    skidMarks: true,
  },
};

export const PRESET_NAMES = Object.keys(QUALITY_PRESETS);

/** Settings derived from the active preset, then overridden by explicit values. */
export function applyPreset(settings, presetName) {
  const preset = QUALITY_PRESETS[presetName];
  if (!preset) return { ...settings };
  return { ...settings, ...preset };
}

const ENUMS = {
  preset: PRESET_NAMES,
  shadows: ['off', 'low', 'medium', 'high'],
  antialias: ['off', 'fxaa', 'msaa'],
  textureQuality: ['low', 'medium', 'high'],
  units: ['metric', 'imperial'],
  transmission: ['auto', 'manual'],
  weather: ['clear', 'overcast', 'rain', 'storm'],
};

const RANGES = {
  renderScale: [0.4, 1],
  viewDistance: [150, 4000],
  vegetationDensity: [0, 100],
  trafficDensity: [0, 100],
  fpsLimit: [0, 240],
  masterVolume: [0, 100],
  engineVolume: [0, 100],
  effectsVolume: [0, 100],
  ambienceVolume: [0, 100],
  gamepadDeadzone: [0, 0.6],
  cameraSensitivity: [0.1, 5],
  // 24 is deliberately excluded from the range so a stored value can never wrap
  // to midnight; the cycle wraps internally instead.
  timeOfDay: [0, 23.99],
  dayLengthMinutes: [1, 240],
};

const BOOLEANS = ['showFps', 'showControlGuide', 'dayNightCycle', 'skidMarks'];

function isValidKeyCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9]+$/.test(code) && code.length <= 24;
}

/**
 * Coerce arbitrary input into a valid settings object.
 * Unknown keys are dropped, out-of-range numbers are clamped, and invalid
 * enum values fall back to the default. Never throws.
 */
export function sanitiseSettings(raw) {
  const out = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_BINDINGS } };
  if (!raw || typeof raw !== 'object') return out;

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'bindings' || key === 'version') continue;
    const value = raw[key];
    if (value === undefined) continue;

    if (key in ENUMS) {
      if (ENUMS[key].includes(value)) out[key] = value;
      continue;
    }
    if (key in RANGES) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        const [min, max] = RANGES[key];
        out[key] = Math.min(max, Math.max(min, num));
      }
      continue;
    }
    if (BOOLEANS.includes(key)) {
      out[key] = Boolean(value);
      continue;
    }
  }

  // Bindings: keep only valid key codes, fall back to defaults per action.
  if (raw.bindings && typeof raw.bindings === 'object') {
    for (const action of Object.keys(DEFAULT_BINDINGS)) {
      const codes = raw.bindings[action];
      if (Array.isArray(codes)) {
        const valid = codes.filter(isValidKeyCode);
        if (valid.length > 0) out.bindings[action] = [...new Set(valid)];
      }
    }
  }

  out.version = SETTINGS_VERSION;
  return out;
}

/**
 * Migrate an older settings payload to the current version.
 * Returns the input unchanged when already current, which keeps this cheap.
 */
export function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let data = raw;
  // v0 -> v1: `bindings` used to be a flat array of strings per action; the
  // shape is identical, only the version marker was missing.
  if (data.version === undefined) data = { ...data, version: 1 };
  if (data.version !== SETTINGS_VERSION) data = { ...data, version: SETTINGS_VERSION };
  return data;
}

/** Convenience: sanitise any stored payload after migration. */
export function loadSettingsFrom(raw) {
  return sanitiseSettings(migrateSettings(raw));
}
