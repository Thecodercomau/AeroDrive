/**
 * Challenge definitions.
 *
 * Every challenge has real success *and* failure conditions, a reward, and
 * restart support. Checkpoints are derived from the built world's road
 * centrelines rather than hard-coded, so a checkpoint always sits on a road you
 * can actually drive along — even if the terrain generator changes.
 *
 * Completion is always a function of the simulation (time, speed, distance,
 * damage, landmarks visited), never a placeholder.
 */

/**
 * One point a given fraction of the way along a road.
 *
 * Used where a checkpoint has to be at a *specific* place on a road rather than
 * evenly spaced across it — a braking zone is useless if its gates move when the
 * road layout is tweaked.
 */
function pointAlongRoad(world, roadName, fraction, { radius = 12 } = {}) {
  const road = world.roads.roads.find((candidate) => candidate.name === roadName);
  if (!road || road.centreline.length === 0) return null;
  const index = Math.round(fraction * (road.centreline.length - 1));
  const point = road.centreline[Math.max(0, Math.min(road.centreline.length - 1, index))];
  return {
    x: point.x,
    y: world.heightAt(point.x, point.z) + 1,
    z: point.z,
    radius,
    index: 0,
  };
}

/** A named service (garage, fuel stop, recovery point) as a mission target. */
function serviceTarget(world, spawnId, { radius = 20 } = {}) {
  const service = world.services?.find((candidate) => candidate.id === spawnId);
  if (!service) return null;
  return {
    x: service.x,
    y: world.heightAt(service.x, service.z) + 1,
    z: service.z,
    radius,
    index: 0,
  };
}

/** Pick evenly spaced points along a road, offset slightly above the surface. */
function checkpointsAlongRoad(world, roadName, count, { radius = 14 } = {}) {
  const road = world.roads.roads.find((candidate) => candidate.name === roadName);
  if (!road) return [];
  const points = road.centreline;
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const index = Math.min(points.length - 1, Math.round(t * (points.length - 1)));
    const point = points[index];
    out.push({
      x: point.x,
      y: world.heightAt(point.x, point.z) + 1,
      z: point.z,
      radius,
      index: i,
    });
  }
  return out;
}

export const CHALLENGES = [
  {
    id: 'alpine-time-trial',
    name: 'Alpine Time Trial',
    type: 'time-trial',
    mapId: 'alpine-valley',
    mapName: 'Alpine Valley',
    description:
      'Thread the valley loop through ten gates against the clock. The road is fast but unforgiving — brake early for the forest section.',
    timeLimit: 190,
    reward: { vehicleId: 'coupe', label: 'Unlocks the Vector GT' },
    spawnId: 'alpine-garage',
    build(world) {
      const checkpoints = checkpointsAlongRoad(world, 'valley-loop', 10, { radius: 15 });
      return { checkpoints };
    },
  },

  {
    id: 'coastal-speed-run',
    name: 'Coastal Speed Run',
    type: 'speed-run',
    mapId: 'coastal-highway',
    mapName: 'Coastal Highway',
    description:
      'Hit 240 km/h on the coastal straight before the road turns inland. Traffic-free and wide open — you have 55 seconds.',
    timeLimit: 55,
    targetSpeedKmh: 240,
    reward: { vehicleId: 'supercar', label: 'Unlocks the Halcyon RS' },
    spawnId: 'coast-reststop-spawn',
    build(world) {
      const checkpoints = checkpointsAlongRoad(world, 'coastal-main', 5, { radius: 22 });
      return { checkpoints };
    },
  },

  {
    id: 'desert-handling',
    name: 'Desert Handling Test',
    type: 'handling',
    mapId: 'desert-proving-grounds',
    mapName: 'Desert Proving Grounds',
    description:
      'One clean lap of the handling circuit. Stay on the asphalt and keep it tidy — the surface is dusty at the edges.',
    timeLimit: 75,
    maxOffRoadSeconds: 6,
    reward: { vehicleId: 'suv', label: 'Unlocks the Ridgeline 4x4' },
    spawnId: 'desert-paddock',
    build(world) {
      // A full lap: gates all the way round the closed circuit.
      const checkpoints = checkpointsAlongRoad(world, 'handling-circuit', 8, { radius: 16 });
      return { checkpoints, lap: true };
    },
  },

  {
    id: 'city-checkpoint',
    name: 'City Checkpoint Race',
    type: 'checkpoint-race',
    mapId: 'modern-city',
    mapName: 'Modern City',
    description:
      'Twelve gates around the downtown blocks, out along the central avenue and back up the north-south street. Mind the intersections.',
    timeLimit: 150,
    reward: { vehicleId: 'pickup', label: 'Unlocks the Boulder 2500' },
    spawnId: 'city-plaza',
    build(world) {
      const checkpoints = checkpointsAlongRoad(world, 'downtown-2nd', 6, { radius: 13 });
      const more = checkpointsAlongRoad(world, 'downtown-ave-b', 6, { radius: 13 });
      // Interleave two streets so the route turns at the centre intersection.
      const merged = [];
      for (let i = 0; i < 6; i++) {
        if (checkpoints[i]) merged.push(checkpoints[i]);
        if (more[i]) merged.push(more[i]);
      }
      return { checkpoints: merged };
    },
  },

  {
    id: 'desert-braking-test',
    name: 'Braking Distance Test',
    type: 'braking',
    mapId: 'desert-proving-grounds',
    mapName: 'Desert Proving Grounds',
    description:
      'Get up to 100 km/h on the speed straight, then stop inside the braking zone. Arrive too slowly, or roll past the stop line, and the run is void.',
    timeLimit: 90,
    minSpeedKmh: 100,
    // No vehicle unlock: every vehicle already has one, and inventing a second
    // reward for the same car would be a lie in the garage UI.
    reward: null,
    spawnId: 'desert-paddock',
    build(world) {
      const trigger = pointAlongRoad(world, 'speed-straight', 0.4, { radius: 16 });
      const stopLine = pointAlongRoad(world, 'speed-straight', 0.47, { radius: 14 });
      if (!trigger || !stopLine) return { checkpoints: [] };
      trigger.index = 0;
      stopLine.index = 1;
      return { checkpoints: [trigger, stopLine] };
    },
  },

  {
    id: 'city-delivery',
    name: 'Parts Delivery',
    type: 'delivery',
    mapId: 'modern-city',
    mapName: 'Modern City',
    description:
      'Collect a crate of brake components at Central Plaza and run it out along Harbour Road to the garage without wrecking the cargo.',
    timeLimit: 130,
    maxDamage: 12,
    cargo: 'brake components',
    destinationLabel: 'Harbour Road Garage',
    reward: null,
    spawnId: 'city-plaza',
    build(world) {
      const destination = serviceTarget(world, 'city-garage', { radius: 20 });
      return { checkpoints: destination ? [destination] : [] };
    },
  },

  {
    id: 'trail-explorer',
    name: 'Trail Explorer',
    type: 'exploration',
    mapId: 'alpine-valley',
    mapName: 'Alpine Valley',
    description:
      'Find all five Alpine Valley landmarks. There is no time limit and no route — just drive and look around.',
    timeLimit: null,
    reward: { vehicleId: 'offroad', label: 'Unlocks the Terra Pro' },
    spawnId: 'alpine-lakehead',
    build(world) {
      return { landmarks: world.landmarks.map((landmark) => ({ ...landmark, radius: 45 })) };
    },
  },

  {
    id: 'desert-drift-pad',
    name: 'Desert Drift Pad',
    type: 'handling',
    mapId: 'desert-proving-grounds',
    mapName: 'Desert Proving Grounds',
    description:
      'Link eight gates around the wide skid pad. Switch on drift mode for looser rear grip and keep every gate on asphalt.',
    timeLimit: 100,
    maxOffRoadSeconds: 8,
    reward: null,
    spawnId: 'desert-skid-pad-spawn',
    build(world) {
      return {
        checkpoints: checkpointsAlongRoad(world, 'desert-drift-pad', 8, { radius: 18 }),
        lap: true,
      };
    },
  },

  {
    id: 'city-airfield-drift',
    name: 'Airfield Drift Loop',
    type: 'handling',
    mapId: 'modern-city',
    mapName: 'Modern City',
    description:
      'Link six gates around the wide terminal apron. Use drift mode to loosen the rear and stay on the tarmac.',
    timeLimit: 90,
    maxOffRoadSeconds: 8,
    reward: null,
    spawnId: 'city-airfield',
    build(world) {
      return {
        checkpoints: checkpointsAlongRoad(world, 'terminal-apron', 6, { radius: 16 }),
        lap: true,
      };
    },
  },
];

const BY_ID = new Map(CHALLENGES.map((challenge) => [challenge.id, challenge]));

export function getChallenge(id) {
  return BY_ID.get(id) ?? null;
}

/** Challenge ids that unlock a given vehicle. */
export function challengesUnlocking(vehicleId) {
  return CHALLENGES.filter((challenge) => challenge.reward?.vehicleId === vehicleId).map(
    (challenge) => challenge.id,
  );
}

/** Human-readable objective line for the HUD. */
export function describeObjective(challenge, state) {
  switch (challenge.type) {
    case 'braking':
      return state.brakingPhase === 'stopping'
        ? `Braking — ${Math.round(state.brakingDistance ?? 0)} m travelled. Stop before the line.`
        : `Reach ${challenge.minSpeedKmh} km/h and cross the trigger line`;
    case 'delivery':
      return Number.isFinite(state.distanceToTarget)
        ? `Deliver ${challenge.cargo ?? 'the cargo'} to ${challenge.destinationLabel ?? 'the depot'} — ${Math.round(state.distanceToTarget)} m`
        : `Deliver ${challenge.cargo ?? 'the cargo'} to ${challenge.destinationLabel ?? 'the depot'}`;
    case 'speed-run':
      return `Reach ${challenge.targetSpeedKmh} km/h — best so far ${Math.round(state.bestSpeedKmh ?? 0)} km/h`;
    case 'exploration':
      return `${state.landmarksVisited ?? 0} / ${state.landmarksTotal ?? 0} landmarks discovered`;
    case 'handling':
      return state.lap
        ? `Lap complete — ${state.checkpointIndex ?? 0} / ${state.checkpointTotal ?? 0} gates`
        : `Gate ${state.checkpointIndex ?? 0} / ${state.checkpointTotal ?? 0}`;
    case 'checkpoint-race':
    case 'time-trial':
    default:
      return `Gate ${state.checkpointIndex ?? 0} / ${state.checkpointTotal ?? 0}`;
  }
}
