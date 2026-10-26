import { DEFAULT_SETTINGS, loadSettingsFrom, applyPreset } from './settings.js';

const STORAGE_KEY = 'aerodrive.settings';

/**
 * Persisted settings with change notifications.
 *
 * Writing is debounced and never happens per frame: the game changes a handful
 * of settings at a time (slider drags), and hammering localStorage on every
 * `input` event both stutters the UI and risks quota errors.
 *
 * Storage access is wrapped because it can legitimately throw: Safari private
 * browsing historically threw on `setItem`, and enterprise policies can disable
 * storage entirely. In those cases the game must keep running with in-memory
 * settings rather than fail to boot.
 */
export class SettingsStore {
  /**
   * @param {object} [options]
   * @param {Storage|null} [options.storage] Injectable for tests.
   * @param {number} [options.debounceMs]
   */
  constructor({ storage = safeStorage(), debounceMs = 250 } = {}) {
    this.storage = storage;
    this.debounceMs = debounceMs;
    this._listeners = new Set();
    this._saveTimer = 0;
    this._pendingMerge = null;
    this.values = this._read();
  }

  _read() {
    if (!this.storage) return { ...DEFAULT_SETTINGS };
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return loadSettingsFrom(JSON.parse(raw));
    } catch (error) {
      // Corrupt JSON or blocked storage — fall back to defaults, never throw.
      console.warn('[Settings] Could not read stored settings, using defaults:', error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get(key) {
    return this.values[key];
  }

  /** Apply several changes at once, then persist and notify once. */
  patch(changes) {
    const previous = this.values;
    this.values = loadSettingsFrom({ ...this.values, ...changes });
    this._scheduleSave();
    for (const listener of [...this._listeners]) {
      try {
        listener(this.values, previous, changes);
      } catch (error) {
        console.error('[Settings] listener threw:', error);
      }
    }
    return this.values;
  }

  set(key, value) {
    return this.patch({ [key]: value });
  }

  /** Re-apply a graphics preset, preserving audio/controls. */
  applyQualityPreset(name) {
    return this.patch(applyPreset({}, name));
  }

  /** Restore defaults and clear the stored entry. */
  reset() {
    this.values = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings } };
    this._cancelSave();
    if (this.storage) {
      try {
        this.storage.removeItem(STORAGE_KEY);
      } catch (error) {
        console.warn('[Settings] Could not clear stored settings:', error);
      }
    }
    for (const listener of [...this._listeners]) listener(this.values, this.values, {});
    return this.values;
  }

  /** Force an immediate write (used before quitting to the main menu). */
  flush() {
    this._cancelSave();
    this._write();
  }

  _scheduleSave() {
    if (this.debounceMs <= 0) {
      this._write();
      return;
    }
    this._cancelSave();
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      this._write();
    }, this.debounceMs);
  }

  _cancelSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = 0;
    }
  }

  _write() {
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch (error) {
      console.warn('[Settings] Could not persist settings (storage unavailable or full):', error);
    }
  }
}

/** Return a working Storage object, or null when storage is unavailable. */
export function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__aerodrive_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
