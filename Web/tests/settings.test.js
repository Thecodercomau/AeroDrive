import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  PRESET_NAMES,
  SETTINGS_VERSION,
  QUALITY_PRESETS,
  applyPreset,
  loadSettingsFrom,
  migrateSettings,
  sanitiseSettings,
} from '../src/settings/settings.js';
import { SettingsStore } from '../src/settings/SettingsStore.js';

/** Minimal in-memory Storage implementation for tests. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
  };
}

describe('settings schema', () => {
  it('returns defaults for garbage input instead of throwing', () => {
    for (const input of [null, undefined, 42, 'nope', [], { preset: 999 }]) {
      const result = sanitiseSettings(input);
      expect(result.preset).toBe(DEFAULT_SETTINGS.preset);
      expect(result.version).toBe(SETTINGS_VERSION);
    }
  });

  it('clamps numeric settings into their valid range', () => {
    const result = sanitiseSettings({
      renderScale: 99,
      viewDistance: -10,
      masterVolume: 500,
      vegetationDensity: -5,
      cameraSensitivity: 0,
    });
    expect(result.renderScale).toBe(1);
    expect(result.viewDistance).toBe(150);
    expect(result.masterVolume).toBe(100);
    expect(result.vegetationDensity).toBe(0);
    expect(result.cameraSensitivity).toBe(0.1);
  });

  it('rejects unknown enum values but keeps valid ones', () => {
    const result = sanitiseSettings({ preset: 'ultra', shadows: 'medium', antialias: 'yes' });
    expect(result.preset).toBe(DEFAULT_SETTINGS.preset);
    expect(result.shadows).toBe('medium');
    expect(result.antialias).toBe(DEFAULT_SETTINGS.antialias);
  });

  it('drops unknown keys entirely', () => {
    const result = sanitiseSettings({ notASetting: true, alsoNot: 'x' });
    expect(result).not.toHaveProperty('notASetting');
    expect(result).not.toHaveProperty('alsoNot');
  });

  it('keeps only valid key codes in bindings and never empties an action', () => {
    const result = sanitiseSettings({
      bindings: {
        accelerate: ['KeyW', 'not a key!', ''],
        brake: [],
        steerLeft: 123,
      },
    });
    expect(result.bindings.accelerate).toEqual(['KeyW']);
    // An empty or invalid list falls back to the default rather than leaving a
    // control with no key at all.
    expect(result.bindings.brake).toEqual(DEFAULT_BINDINGS.brake);
    expect(result.bindings.steerLeft).toEqual(DEFAULT_BINDINGS.steerLeft);
  });

  it('de-duplicates repeated key codes', () => {
    const result = sanitiseSettings({ bindings: { accelerate: ['KeyW', 'KeyW'] } });
    expect(result.bindings.accelerate).toEqual(['KeyW']);
  });

  it('binds pause to Escape and KeyP, and lets the player rebind it', () => {
    // Pause must be reachable without a mouse on the very first launch.
    expect(DEFAULT_BINDINGS.pause).toContain('Escape');
    expect(DEFAULT_BINDINGS.pause).toContain('KeyP');

    const rebound = sanitiseSettings({ bindings: { pause: ['KeyQ'] } });
    expect(rebound.bindings.pause).toEqual(['KeyQ']);
  });

  it('includes a rebindable drift-mode toggle', () => {
    expect(DEFAULT_BINDINGS.toggleDrift).toEqual(['KeyG']);
    expect(sanitiseSettings({ bindings: { toggleDrift: ['KeyT'] } }).bindings.toggleDrift).toEqual([
      'KeyT',
    ]);
  });

  it('covers every action in DEFAULT_BINDINGS with at least one key', () => {
    // A binding that sanitises down to an empty list would leave a control that
    // can never be pressed, so every default must survive a round trip.
    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
      expect(codes.length, `${action} has no default key`).toBeGreaterThan(0);
      expect(sanitiseSettings({}).bindings[action]).toEqual(codes);
    }
  });

  it('migrates an unversioned payload to the current version', () => {
    const migrated = migrateSettings({ preset: 'high' });
    expect(migrated.version).toBe(SETTINGS_VERSION);
    const loaded = loadSettingsFrom({ preset: 'high' });
    expect(loaded.preset).toBe('high');
  });

  it('defines a complete preset for every name, all with valid enums', () => {
    expect(PRESET_NAMES.length).toBe(4);
    for (const name of PRESET_NAMES) {
      const preset = QUALITY_PRESETS[name];
      expect(preset.preset).toBe(name);
      const sanitised = sanitiseSettings({ ...DEFAULT_SETTINGS, ...preset });
      expect(sanitised.preset).toBe(name);
      // A preset must not be silently discarding values it sets.
      expect(sanitised.renderScale).toBe(preset.renderScale);
      expect(sanitised.shadows).toBe(preset.shadows);
    }
  });

  it('orders presets by increasing cost', () => {
    expect(QUALITY_PRESETS.potato.viewDistance).toBeLessThan(QUALITY_PRESETS.low.viewDistance);
    expect(QUALITY_PRESETS.low.viewDistance).toBeLessThan(QUALITY_PRESETS.medium.viewDistance);
    expect(QUALITY_PRESETS.medium.viewDistance).toBeLessThan(QUALITY_PRESETS.high.viewDistance);
    expect(QUALITY_PRESETS.potato.vegetationDensity).toBeLessThan(
      QUALITY_PRESETS.high.vegetationDensity,
    );
  });

  it('applies a preset on top of existing settings without clearing other keys', () => {
    const custom = { ...DEFAULT_SETTINGS, masterVolume: 33 };
    const result = applyPreset(custom, 'high');
    expect(result.viewDistance).toBe(QUALITY_PRESETS.high.viewDistance);
    expect(result.masterVolume).toBe(33);
  });

  it('leaves settings untouched for an unknown preset name', () => {
    const result = applyPreset({ preset: 'low', masterVolume: 10 }, 'nonexistent');
    expect(result.preset).toBe('low');
    expect(result.masterVolume).toBe(10);
  });
});

describe('SettingsStore persistence', () => {
  it('starts from defaults when storage is empty', () => {
    const store = new SettingsStore({ storage: memoryStorage(), debounceMs: 0 });
    expect(store.get('preset')).toBe(DEFAULT_SETTINGS.preset);
    expect(store.get('renderScale')).toBe(0.85);
    expect(store.get('viewDistance')).toBe(700);
    expect(store.get('antialias')).toBe('off');
    expect(store.get('textureQuality')).toBe('low');
  });

  it('persists changes and reads them back', () => {
    const storage = memoryStorage();
    const first = new SettingsStore({ storage, debounceMs: 0 });
    first.set('masterVolume', 42);
    first.set('shadows', 'high');
    first.flush();

    const second = new SettingsStore({ storage, debounceMs: 0 });
    expect(second.get('masterVolume')).toBe(42);
    expect(second.get('shadows')).toBe('high');
  });

  it('recovers from corrupt stored JSON without throwing', () => {
    const storage = memoryStorage();
    storage.setItem('aerodrive.settings', '{not valid json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SettingsStore({ storage, debounceMs: 0 });
    expect(store.get('preset')).toBe(DEFAULT_SETTINGS.preset);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('survives a storage backend that throws on every write', () => {
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new SettingsStore({ storage: hostile, debounceMs: 0 });
    expect(() => store.set('masterVolume', 5)).not.toThrow();
    expect(store.get('masterVolume')).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('works with no storage at all (memory only)', () => {
    const store = new SettingsStore({ storage: null, debounceMs: 0 });
    store.set('engineVolume', 12);
    expect(store.get('engineVolume')).toBe(12);
    expect(() => store.flush()).not.toThrow();
  });

  it('notifies subscribers and returns an unsubscribe function', () => {
    const store = new SettingsStore({ storage: memoryStorage(), debounceMs: 0 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.patch({ masterVolume: 61 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][2]).toEqual({ masterVolume: 61 });

    unsubscribe();
    store.patch({ masterVolume: 62 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps working when a subscriber throws', () => {
    const store = new SettingsStore({ storage: memoryStorage(), debounceMs: 0 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    const good = vi.fn();
    store.subscribe(good);

    expect(() => store.patch({ masterVolume: 20 })).not.toThrow();
    expect(good).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('restores defaults on reset and clears storage', () => {
    const storage = memoryStorage();
    const store = new SettingsStore({ storage, debounceMs: 0 });
    store.set('masterVolume', 5);
    store.flush();
    expect(storage.getItem('aerodrive.settings')).not.toBeNull();

    store.reset();
    expect(store.get('masterVolume')).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(storage.getItem('aerodrive.settings')).toBeNull();
  });

  it('applies a quality preset while preserving audio settings', () => {
    const store = new SettingsStore({ storage: memoryStorage(), debounceMs: 0 });
    store.set('ambienceVolume', 17);
    store.applyQualityPreset('potato');
    expect(store.get('preset')).toBe('potato');
    expect(store.get('renderScale')).toBe(QUALITY_PRESETS.potato.renderScale);
    expect(store.get('ambienceVolume')).toBe(17);
  });
});
