import * as THREE from 'three';
import { Terrain } from '../terrain/Terrain.js';
import { applySpawnPads, TERRAIN_STYLES } from '../terrain/heightfield.js';
import { RoadNetwork, createRoadTexture } from '../roads/RoadNetwork.js';
import { buildRoadStructures } from '../roads/structures.js';
import { PropField } from './props.js';
import { getMap } from './maps.js';
import { nextFrame } from '../utilities/scheduling.js';

/**
 * A built, playable map.
 *
 * `World` owns the terrain, the road network, the streamed prop field, the
 * landmarks and the spawn points, and exposes the queries the rest of the game
 * needs (height, surface, safe spawn, nearest landmark). Nothing in here knows
 * about rendering quality presets or missions — those are layered on top.
 *
 * Build order matters and is enforced here:
 *   1. generate terrain heightfield
 *   2. project roads onto the terrain
 *   3. flatten the terrain along the road corridor
 *   4. carve a level pad under every spawn point
 *   5. build the terrain mesh + collider (both see the flattened heights)
 *   6. build road meshes + colliders
 *   7. scatter and stream props
 *
 * Step 4 runs before step 5 for the same reason step 3 does: the visual mesh
 * and the physics collider are generated from one height array, so any shaping
 * must happen while there is still a single source of truth.
 */
export class World {
  /**
   * @param {object} options
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} options.physics
   * @param {string} options.mapId
   * @param {number} options.vegetationDensity 0..100
   * @param {string} [options.preset] Graphics preset name. Only used to budget
   *   tunnel lights; everything else about the world is preset-independent.
   */
  constructor({ physics, mapId, vegetationDensity = 100, preset = 'low' }) {
    this.physics = physics;
    this.map = getMap(mapId);
    if (!this.map) throw new Error(`World: unknown map id "${mapId}"`);

    this.vegetationDensity = vegetationDensity;
    this.preset = preset;
    this.group = new THREE.Group();
    this.group.name = `world:${this.map.id}`;

    /** @type {Terrain|null} */
    this.terrain = null;
    /** @type {RoadNetwork|null} */
    this.roads = null;
    /** @type {PropField|null} */
    this.props = null;
    this.roadTexture = null;
    /** @type {THREE.Mesh|null} Sea plane, only on maps with a sea level. */
    this.water = null;
    /** @type {ReturnType<typeof buildRoadStructures>|null} Bridges and tunnels. */
    this.structures = null;
    this.landmarks = this.map.landmarks.map((landmark) => ({ ...landmark }));
    this.spawnPoints = this.map.spawnPoints.map((spawn) => ({ ...spawn }));

    // Radius of the level apron carved under each spawn point. Big enough for a
    // pickup to turn around on, small enough to read as a forecourt rather than
    // a flattened scar on the landscape.
    this.spawnPadRadius = 11;
    this.built = false;
    this.bounds = {
      min: -this.map.terrain.size / 2 + 60,
      max: this.map.terrain.size / 2 - 60,
    };

    /**
     * Garages, fuel stops and recovery points.
     *
     * Each one is defined by the id of a spawn point it shares a position with,
     * which means the spawn tests — flat ground, on a road, facing along it —
     * cover the services for free. A service whose spawn point does not exist is
     * dropped loudly rather than silently placed at the origin.
     */
    this.services = this._resolveServices();
  }

  _resolveServices() {
    const out = [];
    for (const service of this.map.services ?? []) {
      const spawn = this.spawnPoints.find((candidate) => candidate.id === service.spawnId);
      if (!spawn) {
        console.warn(
          `[World] Service "${service.id ?? service.name}" on map "${this.map.id}" references ` +
            `unknown spawn point "${service.spawnId}" and was dropped.`,
        );
        continue;
      }
      out.push({
        id: service.spawnId,
        name: service.name,
        type: service.type ?? 'garage',
        x: spawn.x,
        z: spawn.z,
      });
    }
    return out;
  }

  /* --------------------------------- build -------------------------------- */

  /** Build the whole world synchronously. Safe to call once. */
  build() {
    this._phaseTerrain();
    this._phaseRoads();
    this._phaseProps();
    this._finish();
    return this;
  }

  /**
   * Build the world in stages, yielding to the browser between them.
   *
   * Terrain generation is the single most expensive operation in the game (tens
   * of thousands of noise samples, followed by a road-corridor flattening pass).
   * Running it in one uninterrupted block would freeze the tab and prevent the
   * loading screen from painting, so the browser gets a frame between phases.
   *
   * @param {(fraction: number, label: string) => void} [onProgress]
   */
  async buildStaged(onProgress) {
    const step = async (fraction, label, work) => {
      onProgress?.(fraction, label);
      await nextFrame();
      work();
      await nextFrame();
    };

    await step(0, 'Generating terrain', () => this._phaseTerrain());
    await step(0.35, 'Laying the road network', () => this._phaseRoads());
    await step(0.62, 'Scattering vegetation and buildings', () => this._phaseProps());
    await step(0.92, 'Waking physics', () => this._finish());
    onProgress?.(1, 'Ready');
    return this;
  }

  /** Phase 1+2: generate the terrain, project the roads onto it, then cut the road in. */
  _phaseTerrain() {
    const { map } = this;
    this.terrain = new Terrain({
      style: map.terrain.style,
      seed: map.terrain.seed,
      size: map.terrain.size,
      resolution: map.terrain.resolution,
      landforms: map.terrain.landforms ?? [],
    });

    this.roads = new RoadNetwork();
    for (const definition of map.buildRoads()) {
      this.roads.add(definition);
    }
    this.roads.projectAll((x, z) => this.terrain.heightAt(x, z), {
      segments: Math.max(160, Math.round(map.terrain.size / 10)),
      surfaceOffset: 0.06,
    });

    // Bridges and tunnels have to be resolved while the terrain is still
    // natural: a bridge is lifted above the ground it spans, and that decision
    // needs the untouched heightfield. This also lifts the road itself, so it
    // must happen before anything samples the road's height — the flattening
    // pass below, the spawn pads, the road mesh and the road collider.
    this.roads.resolveStructures((x, z) => this.terrain.heightAt(x, z));

    // Flatten the terrain into the road corridor *before* the mesh or the
    // collider are built, so both see the cut-and-fill. `flattenPoints` is not
    // the whole centreline: it drops the samples inside a bridge span and asks
    // for a narrower corridor inside a tunnel.
    this.terrain.flattenAlongRoad(this.roads.flattenPoints(), {
      corridor: 13,
      blend: 16,
    });

    this._carveSpawnPads();
  }

  /**
   * Level the ground under every spawn point.
   *
   * The target height is simply the terrain height at the spawn *after* the road
   * flattening pass, which means a garage beside a road is levelled to the road
   * it serves while a remote car park is levelled to the land it sits on. No
   * second height query is needed, and the two passes cannot disagree.
   */
  _carveSpawnPads() {
    const pads = this.spawnPoints.map((spawn) => ({
      x: spawn.x,
      z: spawn.z,
      y: this.terrain.heightAt(spawn.x, spawn.z),
    }));

    applySpawnPads(this.terrain.field.heights, this.terrain.field, pads, {
      radius: this.spawnPadRadius,
      blend: 8,
    });

    this._alignSpawnHeadings();
  }

  /**
   * Face every spawn along the road it sits on.
   *
   * A car parked across the asphalt accelerates straight off it. Deriving the
   * heading from the road tangent means a map author can move a road — or a
   * spawn — without having to hand-recalculate the angle, and it cannot silently
   * end up 90 degrees out.
   */
  _alignSpawnHeadings() {
    for (const spawn of this.spawnPoints) {
      const nearest = this.roads.nearestRoad(spawn.x, spawn.z);
      // Well clear of any road: the map's own heading is the only meaningful one.
      if (!nearest.road || nearest.distance > 12) continue;
      const heading = nearest.road.directionAt(spawn);
      if (Number.isFinite(heading)) spawn.heading = heading;
    }
  }

  /** Phase 3: terrain visuals + collision, then the road surfaces. */
  _phaseRoads() {
    const { map } = this;
    this.group.add(this.terrain.buildMesh());
    this.terrain.buildCollider(this.physics, {
      surface: map.terrain.style === 'desert' ? 'sand' : 'grass',
      tag: 'terrain',
    });

    this.roadTexture = createRoadTexture();
    this.roads.buildMeshes({ scene: this.group, texture: this.roadTexture });
    this.roads.buildColliders(this.physics);

    // Bridges and tunnels are decoration plus a few extra colliders on top of
    // the road network; they can only be built once the road geometries exist.
    this.structures = buildRoadStructures({
      roads: this.roads,
      physics: this.physics,
      preset: this.preset,
    });
    this.group.add(this.structures.group);

    this._buildWater();
  }

  /**
   * A flat sea for maps whose terrain style declares a sea level.
   *
   * One plane at that height. There is no reflection, no refraction and no wave
   * simulation, because a reflective water surface is one of the most expensive
   * things a real-time renderer can do and this is scenery seen from the road.
   * The shore is simply where the terrain rises above the plane.
   *
   * The plane is deliberately non-colliding: a car that drives into it keeps
   * going, which is a known limitation rather than a hidden one — see
   * `docs/KNOWN-ISSUES.md`.
   */
  _buildWater() {
    const style = TERRAIN_STYLES[this.map.terrain.style];
    if (!style || style.seaLevel === undefined) return;

    const geometry = new THREE.PlaneGeometry(this.map.terrain.size, this.map.terrain.size);
    geometry.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x2a5f7f,
        roughness: 0.18,
        metalness: 0.15,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
    );
    this.water.name = 'water';
    this.water.position.set(0, style.seaLevel, 0);
    this.group.add(this.water);
  }

  /** Phase 4: props. They are streamed in around the player later, not all at once. */
  _phaseProps() {
    this.props = new PropField({
      map: this.map,
      terrain: this.terrain,
      roads: this.roads,
      physics: this.physics,
      vegetationDensity: this.vegetationDensity,
    });
    this.group.add(this.props.group);
  }

  _finish() {
    // Make the broad-phase/query pipeline match the colliders we just created,
    // so the very first ground probe or recovery raycast works.
    this.physics.syncQueries();
    this.built = true;
  }

  /** Called every frame with the player position to stream props in and out. */
  update(playerPosition, { loadDistance = 700 } = {}) {
    if (!this.built || !this.props) return;
    this.props.update(playerPosition, { loadDistance });
  }

  /* -------------------------------- queries ------------------------------- */

  /** Terrain height at a world position (0 when the world is not built). */
  heightAt(x, z) {
    return this.terrain ? this.terrain.heightAt(x, z) : 0;
  }

  slopeAt(x, z) {
    return this.terrain ? this.terrain.slopeAt(x, z) : 0;
  }

  /**
   * Surface type at a world position.
   * Roads and their immediate surroundings read as asphalt; steep terrain reads
   * as its base material.
   */
  surfaceAt(x, z, radius = 6) {
    if (!this.roads) return 'grass';
    const nearest = this.roads.nearestRoad(x, z);
    if (nearest.road && nearest.distance <= nearest.road.width / 2 + radius) {
      return nearest.road.surface ?? 'asphalt';
    }
    const style = this.map.terrain.style;
    if (style === 'desert') return 'sand';
    if (this.slopeAt(x, z) > 0.55) return 'dirt';
    return 'grass';
  }

  /** A spawn pose on the ground at (x, z), upright and slightly above the surface. */
  spawnPose(x, z, heading = 0, clearance = 1.2) {
    const clampedX = Math.max(this.bounds.min, Math.min(this.bounds.max, x));
    const clampedZ = Math.max(this.bounds.min, Math.min(this.bounds.max, z));
    return {
      x: clampedX,
      y: this.heightAt(clampedX, clampedZ) + clearance,
      z: clampedZ,
      heading,
    };
  }

  /** Resolve one of the map's named spawn points (falls back to the first). */
  resolveSpawn(spawnId = null) {
    const spawn =
      this.spawnPoints.find((candidate) => candidate.id === spawnId) ?? this.spawnPoints[0];
    return this.spawnPose(spawn.x, spawn.z, spawn.heading ?? 0);
  }

  /** Every spawn pose — used by traffic to place vehicles off-screen. */
  allSpawnPoses() {
    return this.spawnPoints.map((spawn) => this.spawnPose(spawn.x, spawn.z, spawn.heading ?? 0));
  }

  /**
   * The nearest garage / fuel / recovery service within `radius`, or null.
   *
   * Used for free repairs at a garage and as a delivery destination. Kept as a
   * plain distance scan: there are two or three services per map, so anything
   * cleverer would cost more than it saves.
   *
   * @param {{x:number,z:number}} position
   * @param {number} radius Metres.
   */
  serviceNear(position, radius = 22) {
    let best = null;
    let bestDistance = radius;
    for (const service of this.services) {
      const distance = Math.hypot(service.x - position.x, service.z - position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = service;
      }
    }
    return best;
  }

  /**
   * The first landmark within `radius` of a position, or null.
   * Used for discovery notifications and exploration rewards.
   */
  landmarkNear(position, radius = 60) {
    let best = null;
    let bestDistance = radius;
    for (const landmark of this.landmarks) {
      const distance = Math.hypot(landmark.x - position.x, landmark.z - position.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = landmark;
      }
    }
    return best;
  }

  /**
   * A list of road control points suitable for a minimap, decimated so the
   * minimap does not draw thousands of segments.
   */
  minimapRoads({ maxPointsPerRoad = 60 } = {}) {
    if (!this.roads) return [];
    return this.roads.roads.map((road) => {
      const points = road.centreline;
      const stride = Math.max(1, Math.floor(points.length / maxPointsPerRoad));
      const decimated = [];
      for (let i = 0; i < points.length; i += stride) {
        decimated.push({ x: points[i].x, z: points[i].z });
      }
      const last = points[points.length - 1];
      if (last) decimated.push({ x: last.x, z: last.z });
      return {
        name: road.name,
        width: road.width,
        // `surface` matters to every consumer: the minimap and world map colour
        // dirt roads differently, and the traffic signal finder uses these
        // descriptors too. Leaving it out made `road.surface === 'dirt'` false
        // everywhere, which quietly mis-coloured every trail.
        surface: road.surface ?? 'asphalt',
        points: decimated,
      };
    });
  }

  /**
   * A deterministic set of positions along the roads, for traffic spawning.
   *
   * Each node carries the ROAD's height, not the terrain's. They are the same
   * thing everywhere except on a bridge, where the terrain is the valley floor
   * and using it would drive traffic through the gap under the deck.
   */
  trafficRoutePoints({ spacing = 45 } = {}) {
    if (!this.roads) return [];
    const out = [];
    for (const [roadIndex, road] of this.roads.roads.entries()) {
      const points = road.centreline;
      const stride = Math.max(1, Math.round(spacing / 6));
      const roadNodes = [];
      for (let i = 0; i < points.length; i += stride) {
        const next = points[Math.min(points.length - 1, i + 1)];
        const heading = Math.atan2(next.x - points[i].x, next.z - points[i].z);
        out.push({
          x: points[i].x,
          y: points[i].y + 1,
          z: points[i].z,
          heading,
          roadName: road.name,
          roadIndex,
          closed: road.closed,
          index: i,
        });
        roadNodes.push(out.length - 1);
      }
      // Remembered so traffic can find the two ends of this road and move to
      // another one instead of interpolating across the map between roads.
      for (const nodeIndex of roadNodes) {
        out[nodeIndex].roadStart = roadNodes[0];
        out[nodeIndex].roadEnd = roadNodes[roadNodes.length - 1];
      }
    }
    return out;
  }

  /* -------------------------------- teardown ------------------------------ */

  dispose() {
    this.props?.dispose();
    this.structures?.dispose();
    this.structures = null;
    this.roads?.dispose();
    this.terrain?.dispose();
    this.roadTexture?.dispose();
    if (this.water) {
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.water = null;
    }
    this.group.clear();
    this.group.parent?.remove(this.group);
    this.props = null;
    this.roads = null;
    this.terrain = null;
    this.built = false;
  }
}
