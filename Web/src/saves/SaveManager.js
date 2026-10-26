import {
  defaultProgress,
  discoverLocation,
  isProgressCompatible,
  recordChallengeResult,
  sanitiseProgress,
  unlockVehicle,
} from './progress.js';
import { safeStorage } from '../settings/SettingsStore.js';

const DB_NAME = 'aerodrive';
const DB_VERSION = 1;
const STORE = 'progress';
const RECORD_KEY = 'player';
const LS_FALLBACK_KEY = 'aerodrive.progress';

/**
 * Persists player progress.
 *
 * Uses IndexedDB (structured, larger payloads, off the main-thread blocking
 * path) and transparently falls back to localStorage, then to memory, when
 * IndexedDB is unavailable — private browsing, hardened enterprise profiles, and
 * older embedded browsers all lack it. Every path is wrapped: a storage failure
 * must degrade to "this session isn't saved", never to a broken game.
 */
export class SaveManager {
  /**
   * @param {object} [options]
   * @param {EventBus} [options.bus] Emits `progress:changed` / `progress:saved`.
   */
  constructor({ bus = null, debounceMs = 800 } = {}) {
    this.bus = bus;
    this.debounceMs = debounceMs;
    this.values = defaultProgress();
    this.backend = 'memory';
    this._db = null;
    this._saveTimer = 0;
    this._dirty = false;
    this._closed = false;
  }

  /** Open storage and load existing progress. Safe to call once at startup. */
  async init() {
    try {
      this._db = await openDatabase();
      this.backend = 'indexeddb';
    } catch (error) {
      console.warn('[Save] IndexedDB unavailable, falling back to localStorage:', error.message);
      this._db = null;
      this.backend = safeStorage() ? 'localstorage' : 'memory';
    }

    const raw = await this._readRaw();
    if (raw && isProgressCompatible(raw)) {
      this.values = sanitiseProgress(raw);
    } else if (raw) {
      console.warn('[Save] Save was written by a newer version; starting fresh.');
      this.values = defaultProgress();
    }
    this.bus?.emit('progress:loaded', this.values);
    return this.values;
  }

  async _readRaw() {
    if (this.backend === 'indexeddb' && this._db) {
      try {
        return await idbGet(this._db, RECORD_KEY);
      } catch (error) {
        console.warn('[Save] IndexedDB read failed:', error.message);
      }
    }
    const storage = safeStorage();
    if (storage) {
      try {
        const raw = storage.getItem(LS_FALLBACK_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        console.warn('[Save] localStorage read failed or was corrupt:', error.message);
      }
    }
    return null;
  }

  async _writeRaw(data) {
    if (this.backend === 'indexeddb' && this._db) {
      try {
        await idbPut(this._db, RECORD_KEY, data);
        return true;
      } catch (error) {
        console.warn('[Save] IndexedDB write failed, demoting to localStorage:', error.message);
        this.backend = safeStorage() ? 'localstorage' : 'memory';
      }
    }
    const storage = safeStorage();
    if (storage) {
      try {
        storage.setItem(LS_FALLBACK_KEY, JSON.stringify(data));
        return true;
      } catch (error) {
        console.warn('[Save] localStorage write failed (quota or blocked):', error.message);
      }
    }
    return false;
  }

  /** Replace progress wholesale (used by load/reset). Debounced persist. */
  setProgress(progress) {
    this.values = sanitiseProgress(progress);
    this._dirty = true;
    this._scheduleSave();
    this.bus?.emit('progress:changed', this.values);
    return this.values;
  }

  /**
   * Apply a pure mutation function to progress.
   * @param {(progress: object) => object} mutator
   */
  update(mutator) {
    const next = mutator(this.values);
    return this.setProgress(next);
  }

  recordChallenge(challengeId, result) {
    let summary = null;
    this.update((progress) => {
      const outcome = recordChallengeResult(progress, challengeId, result);
      summary = outcome;
      return outcome.progress;
    });
    return summary;
  }

  unlock(vehicleId) {
    return this.update((progress) => unlockVehicle(progress, vehicleId));
  }

  discover(locationId) {
    let isNew = false;
    this.update((progress) => {
      const outcome = discoverLocation(progress, locationId);
      isNew = outcome.isNew;
      return outcome.progress;
    });
    return isNew;
  }

  markMapVisited(mapId) {
    return this.update((progress) =>
      progress.visitedMaps.includes(mapId)
        ? progress
        : { ...progress, visitedMaps: [...progress.visitedMaps, mapId] },
    );
  }

  addPlaytime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return this.values;
    this.values.playtimeSeconds += seconds;
    this._dirty = true;
    this._scheduleSave();
    return this.values;
  }

  setSelectedVehicle(vehicleId) {
    return this.update((progress) => ({ ...progress, selectedVehicle: vehicleId }));
  }

  setPaint(vehicleId, paintId) {
    return this.update((progress) => ({
      ...progress,
      selectedPaints: { ...progress.selectedPaints, [vehicleId]: paintId },
    }));
  }

  _scheduleSave() {
    if (this.debounceMs <= 0) {
      void this.flush();
      return;
    }
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      void this.flush();
    }, this.debounceMs);
  }

  /** Persist immediately and clear the dirty flag. */
  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = 0;
    }
    if (this._closed) return false;
    const ok = await this._writeRaw(this.values);
    if (ok) {
      this._dirty = false;
      this.bus?.emit('progress:saved', this.values);
    }
    return ok;
  }

  /** Reset all progress. Used behind an explicit confirmation dialog. */
  async reset() {
    this.values = defaultProgress();
    if (this._db) {
      try {
        await idbDelete(this._db, RECORD_KEY);
      } catch (error) {
        console.warn('[Save] IndexedDB reset failed:', error.message);
      }
    }
    const storage = safeStorage();
    if (storage) {
      try {
        storage.removeItem(LS_FALLBACK_KEY);
      } catch (error) {
        console.warn('[Save] localStorage reset failed:', error.message);
      }
    }
    this.bus?.emit('progress:changed', this.values);
    this.bus?.emit('progress:reset', this.values);
    return this.values;
  }

  /** Close the database connection (page unload). */
  async close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = 0;
    }
    await this.flush();
    this._closed = true;
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* already closed */
      }
      this._db = null;
    }
  }
}

/* ----------------------------- IndexedDB helpers ---------------------------- */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    // Some browsers never fire either callback if the user blocks storage.
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB get failed'));
  });
}

function idbPut(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function idbDelete(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
  });
}
