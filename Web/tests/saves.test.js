import { describe, expect, it, vi } from 'vitest';
import {
  PROGRESS_VERSION,
  STARTER_VEHICLES,
  defaultProgress,
  discoverLocation,
  isProgressCompatible,
  isVehicleUnlocked,
  recordChallengeResult,
  sanitiseProgress,
  unlockVehicle,
} from '../src/saves/progress.js';
import { SaveManager } from '../src/saves/SaveManager.js';
import { EventBus } from '../src/core/EventBus.js';

describe('progress model', () => {
  it('starts with the starter vehicles unlocked and selected', () => {
    const progress = defaultProgress();
    expect(progress.unlockedVehicles.sort()).toEqual([...STARTER_VEHICLES].sort());
    expect(progress.selectedVehicle).toBe(STARTER_VEHICLES[0]);
    expect(progress.version).toBe(PROGRESS_VERSION);
  });

  it('sanitises hostile or corrupt data without throwing', () => {
    for (const input of [null, 'nope', 7, [], { unlockedVehicles: 'all' }]) {
      const progress = sanitiseProgress(input);
      expect(progress.unlockedVehicles.length).toBeGreaterThanOrEqual(STARTER_VEHICLES.length);
      expect(progress.version).toBe(PROGRESS_VERSION);
    }
  });

  it('can never lock the player out of a starter vehicle', () => {
    const progress = sanitiseProgress({ unlockedVehicles: [] });
    for (const id of STARTER_VEHICLES) {
      expect(isVehicleUnlocked(progress, id)).toBe(true);
    }
  });

  it('repairs a selected vehicle that is not unlocked', () => {
    const progress = sanitiseProgress({
      unlockedVehicles: ['sedan'],
      selectedVehicle: 'supercar',
    });
    expect(progress.unlockedVehicles).toContain(progress.selectedVehicle);
    expect(progress.selectedVehicle).toBe('sedan');
  });

  it('drops malformed challenge records but keeps valid ones', () => {
    const progress = sanitiseProgress({
      challenges: {
        good: { completed: true, bestTimeSeconds: 91.5, bestScore: 800, attempts: 3 },
        bad: 'not an object',
        negative: { bestTimeSeconds: -50, attempts: -4 },
      },
    });
    expect(progress.challenges.good).toEqual({
      completed: true,
      bestTimeSeconds: 91.5,
      bestScore: 800,
      attempts: 3,
    });
    expect(progress.challenges.bad).toBeUndefined();
    expect(progress.challenges.negative.bestTimeSeconds).toBeNull();
    expect(progress.challenges.negative.attempts).toBe(0);
  });

  it('de-duplicates discovered locations and visited maps', () => {
    const progress = sanitiseProgress({
      discoveredLocations: ['a', 'a', 'b', 42],
      visitedMaps: ['m', 'm'],
    });
    expect(progress.discoveredLocations).toEqual(['a', 'b']);
    expect(progress.visitedMaps).toEqual(['m']);
  });

  it('records a first completion as a personal best', () => {
    const outcome = recordChallengeResult(defaultProgress(), 'race', {
      completed: true,
      timeSeconds: 100,
      score: 500,
    });
    expect(outcome.completed).toBe(true);
    expect(outcome.newTimeRecord).toBe(true);
    expect(outcome.newScoreRecord).toBe(true);
    expect(outcome.progress.challenges.race.bestTimeSeconds).toBe(100);
    expect(outcome.progress.challenges.race.attempts).toBe(1);
  });

  it('only replaces a best time when the new time is faster', () => {
    const progress = recordChallengeResult(defaultProgress(), 'race', {
      completed: true,
      timeSeconds: 100,
    }).progress;

    const slower = recordChallengeResult(progress, 'race', { completed: true, timeSeconds: 120 });
    expect(slower.newTimeRecord).toBe(false);
    expect(slower.progress.challenges.race.bestTimeSeconds).toBe(100);
    expect(slower.progress.challenges.race.attempts).toBe(2);

    const faster = recordChallengeResult(slower.progress, 'race', {
      completed: true,
      timeSeconds: 88,
    });
    expect(faster.newTimeRecord).toBe(true);
    expect(faster.progress.challenges.race.bestTimeSeconds).toBe(88);
  });

  it('counts failed attempts without marking the challenge complete', () => {
    const outcome = recordChallengeResult(defaultProgress(), 'race', { completed: false });
    expect(outcome.completed).toBe(false);
    expect(outcome.progress.challenges.race.attempts).toBe(1);
    expect(outcome.progress.challenges.race.bestTimeSeconds).toBeNull();
  });

  it('does not mutate the input progress object', () => {
    const progress = defaultProgress();
    const snapshot = JSON.stringify(progress);
    recordChallengeResult(progress, 'race', { completed: true, timeSeconds: 10 });
    unlockVehicle(progress, 'supercar');
    discoverLocation(progress, 'somewhere');
    expect(JSON.stringify(progress)).toBe(snapshot);
  });

  it('is idempotent about unlocking and discovery', () => {
    const once = unlockVehicle(defaultProgress(), 'coupe');
    const twice = unlockVehicle(once, 'coupe');
    expect(twice.unlockedVehicles.length).toBe(once.unlockedVehicles.length);

    const discovered = discoverLocation(once, 'lake');
    expect(discovered.isNew).toBe(true);
    const again = discoverLocation(discovered.progress, 'lake');
    expect(again.isNew).toBe(false);
    expect(again.progress.discoveredLocations.length).toBe(1);
  });

  it('rejects a save written by a newer version', () => {
    expect(isProgressCompatible({ version: PROGRESS_VERSION + 1 })).toBe(false);
    expect(isProgressCompatible({ version: PROGRESS_VERSION })).toBe(true);
    expect(isProgressCompatible(null)).toBe(false);
  });
});

describe('SaveManager', () => {
  it('falls back to a working backend when IndexedDB is unavailable', async () => {
    // Node has no IndexedDB, which is exactly the fallback path browsers hit in
    // private browsing.
    const saves = new SaveManager({ debounceMs: 0 });
    await saves.init();
    expect(['memory', 'localstorage', 'indexeddb']).toContain(saves.backend);
    expect(saves.values.version).toBe(PROGRESS_VERSION);
    await saves.close();
  });

  it('records challenges, unlocks vehicles and discovers locations', async () => {
    const bus = new EventBus();
    const changed = vi.fn();
    bus.on('progress:changed', changed);
    const saves = new SaveManager({ bus, debounceMs: 0 });
    await saves.init();

    const summary = saves.recordChallenge('test-race', { completed: true, timeSeconds: 42 });
    expect(summary.completed).toBe(true);
    expect(saves.values.challenges['test-race'].bestTimeSeconds).toBe(42);

    saves.unlock('supercar');
    expect(saves.values.unlockedVehicles).toContain('supercar');

    expect(saves.discover('lake')).toBe(true);
    expect(saves.discover('lake')).toBe(false);

    saves.markMapVisited('alpine-valley');
    saves.markMapVisited('alpine-valley');
    expect(saves.values.visitedMaps).toEqual(['alpine-valley']);

    saves.setSelectedVehicle('sedan');
    expect(saves.values.selectedVehicle).toBe('sedan');

    saves.setPaint('sedan', 'racingRed');
    expect(saves.values.selectedPaints.sedan).toBe('racingRed');

    expect(changed).toHaveBeenCalled();
    await saves.close();
  });

  it('accumulates playtime and ignores nonsense values', async () => {
    const saves = new SaveManager({ debounceMs: 0 });
    await saves.init();
    saves.addPlaytime(60);
    saves.addPlaytime(30);
    saves.addPlaytime(-5);
    saves.addPlaytime(Number.NaN);
    expect(saves.values.playtimeSeconds).toBe(90);
    await saves.close();
  });

  it('resets progress back to defaults', async () => {
    const bus = new EventBus();
    const reset = vi.fn();
    bus.on('progress:reset', reset);
    const saves = new SaveManager({ bus, debounceMs: 0 });
    await saves.init();
    saves.unlock('supercar');
    await saves.reset();

    expect(saves.values.unlockedVehicles).toEqual([...STARTER_VEHICLES].sort());
    expect(reset).toHaveBeenCalled();
    await saves.close();
  });
});
