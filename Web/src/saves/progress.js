/**
 * Player progression model.
 *
 * Kept pure and separate from storage so the rules (which challenge unlocks
 * which vehicle, how best-times are recorded) can be unit-tested directly and
 * so a corrupted save can be sanitised without touching I/O.
 */

export const PROGRESS_VERSION = 1;

/** Vehicles available from the very first launch. */
export const STARTER_VEHICLES = ['hatchback', 'sedan'];

export function defaultProgress() {
  return {
    version: PROGRESS_VERSION,
    unlockedVehicles: [...STARTER_VEHICLES],
    selectedVehicle: STARTER_VEHICLES[0],
    selectedPaints: {},
    // challengeId -> { completed, bestTimeSeconds, bestScore, attempts }
    challenges: {},
    // Ids of landmarks the player has driven near.
    discoveredLocations: [],
    // Ids of maps the player has entered.
    visitedMaps: [],
    playtimeSeconds: 0,
  };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce arbitrary stored data into a valid progress object. Never throws. */
export function sanitiseProgress(raw) {
  const base = defaultProgress();
  if (!isPlainObject(raw)) return base;

  const out = { ...base };
  out.unlockedVehicles = Array.isArray(raw.unlockedVehicles)
    ? raw.unlockedVehicles.filter((id) => typeof id === 'string')
    : base.unlockedVehicles;
  // The starters can never be locked out, otherwise a bad save bricks the game.
  for (const id of STARTER_VEHICLES) {
    if (!out.unlockedVehicles.includes(id)) out.unlockedVehicles.push(id);
  }

  out.selectedVehicle =
    typeof raw.selectedVehicle === 'string' && out.unlockedVehicles.includes(raw.selectedVehicle)
      ? raw.selectedVehicle
      : out.unlockedVehicles[0];

  out.selectedPaints = {};
  if (isPlainObject(raw.selectedPaints)) {
    for (const [vehicleId, paint] of Object.entries(raw.selectedPaints)) {
      if (typeof paint === 'string') out.selectedPaints[vehicleId] = paint;
    }
  }

  out.challenges = {};
  if (isPlainObject(raw.challenges)) {
    for (const [id, record] of Object.entries(raw.challenges)) {
      if (!isPlainObject(record)) continue;
      out.challenges[id] = {
        completed: Boolean(record.completed),
        // A best time must be strictly positive: zero or negative means the data
        // is corrupt, and displaying "best 0.00s" would be worse than showing
        // no record at all.
        bestTimeSeconds:
          Number.isFinite(record.bestTimeSeconds) && record.bestTimeSeconds > 0
            ? record.bestTimeSeconds
            : null,
        bestScore: Number.isFinite(record.bestScore) ? record.bestScore : null,
        attempts: Number.isFinite(record.attempts) ? Math.max(0, Math.floor(record.attempts)) : 0,
      };
    }
  }

  out.discoveredLocations = Array.isArray(raw.discoveredLocations)
    ? [...new Set(raw.discoveredLocations.filter((id) => typeof id === 'string'))]
    : [];
  out.visitedMaps = Array.isArray(raw.visitedMaps)
    ? [...new Set(raw.visitedMaps.filter((id) => typeof id === 'string'))]
    : [];
  out.playtimeSeconds = Number.isFinite(raw.playtimeSeconds) ? Math.max(0, raw.playtimeSeconds) : 0;

  out.version = PROGRESS_VERSION;
  return out;
}

/**
 * Record the outcome of a challenge attempt.
 * Returns a new progress object plus a summary of what changed, so the UI can
 * announce "New record!" without re-deriving it.
 *
 * @param {object} progress
 * @param {string} challengeId
 * @param {{ completed: boolean, timeSeconds?: number|null, score?: number|null }} result
 */
export function recordChallengeResult(progress, challengeId, result) {
  const next = { ...progress, challenges: { ...progress.challenges } };
  const previous = next.challenges[challengeId] ?? {
    completed: false,
    bestTimeSeconds: null,
    bestScore: null,
    attempts: 0,
  };

  const entry = {
    completed: previous.completed || Boolean(result.completed),
    bestTimeSeconds: previous.bestTimeSeconds,
    bestScore: previous.bestScore,
    attempts: previous.attempts + 1,
  };

  let newTimeRecord = false;
  let newScoreRecord = false;

  if (result.completed && Number.isFinite(result.timeSeconds) && result.timeSeconds > 0) {
    const t = result.timeSeconds;
    if (entry.bestTimeSeconds === null || t < entry.bestTimeSeconds) {
      entry.bestTimeSeconds = t;
      newTimeRecord = true;
    }
  }
  if (Number.isFinite(result.score)) {
    if (entry.bestScore === null || result.score > entry.bestScore) {
      entry.bestScore = result.score;
      newScoreRecord = true;
    }
  }

  next.challenges[challengeId] = entry;
  return { progress: next, newTimeRecord, newScoreRecord, completed: entry.completed };
}

/** Return a new progress object with `vehicleId` unlocked. */
export function unlockVehicle(progress, vehicleId) {
  if (progress.unlockedVehicles.includes(vehicleId)) return progress;
  return { ...progress, unlockedVehicles: [...progress.unlockedVehicles, vehicleId] };
}

export function isVehicleUnlocked(progress, vehicleId) {
  return progress.unlockedVehicles.includes(vehicleId);
}

/** Mark a location as discovered. Returns { progress, isNew }. */
export function discoverLocation(progress, locationId) {
  if (progress.discoveredLocations.includes(locationId)) {
    return { progress, isNew: false };
  }
  return {
    progress: {
      ...progress,
      discoveredLocations: [...progress.discoveredLocations, locationId],
    },
    isNew: true,
  };
}

/** Compatibility check used when loading a save written by a newer build. */
export function isProgressCompatible(raw) {
  return isPlainObject(raw) && (raw.version ?? PROGRESS_VERSION) <= PROGRESS_VERSION;
}
