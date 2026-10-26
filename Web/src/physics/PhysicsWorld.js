import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Wrapper around the Rapier world.
 *
 * Responsibilities:
 *  - Own the WASM initialisation so nothing else has to know about it.
 *  - Track a "surface type" per collider (asphalt / dirt / grass / sand) so the
 *    vehicle can look up grip for the ground it is actually on. Rapier has no
 *    user-data slot on colliders, so we key a Map by collider handle.
 *  - Provide the small set of helpers the world builder needs, and expose
 *    collision events for the audio system.
 */

/** Surface identifiers used for grip lookups and audio. */
export const SURFACES = {
  ASPHALT: 'asphalt',
  DIRT: 'dirt',
  GRASS: 'grass',
  SAND: 'sand',
};

export class PhysicsWorld {
  constructor() {
    /** @type {RAPIER.World|null} */
    this.world = null;
    this.RAPIER = RAPIER;
    this.events = null;
    this.initialised = false;

    /** @type {Map<number, string>} collider handle -> surface id */
    this._surfaceByHandle = new Map();
    /** @type {Map<number, string>} collider handle -> logical tag (e.g. 'prop:tree') */
    this._tagByHandle = new Map();
    /** @type {Array<(handle1:number, handle2:number, started:boolean)=>void>} */
    this._collisionListeners = [];
    /** Handles of colliders that belong to the player, used to filter events. */
    this._playerHandles = new Set();

    this._gravity = { x: 0, y: -9.81, z: 0 };
    // Reusable vectors: allocating these per raycast would churn the GC.
    this._rayOrigin = { x: 0, y: 0, z: 0 };
    this._rayDir = { x: 0, y: -1, z: 0 };
  }

  /** Initialise the WASM module. Must be awaited before anything else. */
  async init() {
    if (this.initialised) return this;
    await RAPIER.init();
    this.world = new RAPIER.World(this._gravity);
    this.world.timestep = 1 / 60;
    // Two extra solver iterations meaningfully improve wheel contact stability
    // at a cost that is negligible for the object counts we simulate.
    this.world.numSolverIterations = 6;
    this.events = new RAPIER.EventQueue(true);
    this.initialised = true;
    return this;
  }

  setGravity(x, y, z) {
    this._gravity = { x, y, z };
    if (this.world) this.world.gravity = { x, y, z };
  }

  /**
   * Step the simulation once so the broad-phase and query pipeline match the
   * colliders that were just added.
   *
   * Rapier only rebuilds those structures inside `step()`, so a raycast issued
   * immediately after creating colliders hits nothing at all. Calling this once
   * after building a world makes the first `recover()` / ground probe correct.
   */
  syncQueries() {
    if (!this.world) return;
    this.world.step(this.events);
    if (this.events) {
      this.events.drainCollisionEvents(() => {});
      this.events.drainContactForceEvents(() => {});
    }
  }

  /** Advance the simulation by exactly `dt` seconds. */
  step(dt) {
    if (!this.world) return;
    this.world.timestep = dt;
    this.world.step(this.events);
    if (this.events) {
      this.events.drainCollisionEvents((h1, h2, started) => {
        for (const listener of this._collisionListeners) {
          try {
            listener(h1, h2, started);
          } catch (error) {
            console.error('[Physics] collision listener threw:', error);
          }
        }
      });
      // Contact-force events are drained even when unused: leaving them queued
      // would make the queue grow without bound across a long session.
      this.events.drainContactForceEvents(() => {});
    }
  }

  /* ------------------------------- creation ------------------------------- */

  /**
   * Create a fixed (non-moving) collider from a descriptor.
   * @returns {RAPIER.Collider}
   */
  addStatic(desc, { surface = SURFACES.ASPHALT, tag = 'static' } = {}) {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const collider = this.world.createCollider(desc, body);
    this.registerSurface(collider, surface);
    this.registerTag(collider, tag);
    return collider;
  }

  /**
   * Build a heightfield collider — the terrain.
   *
   * `nrows`/`ncols` are subdivision counts: the height array must hold exactly
   * `(nrows + 1) * (ncols + 1)` values, and Rapier reads `heights[i + j * (nrows + 1)]`
   * with `i` indexing rows along +X and `j` indexing columns along +Z. This is
   * asserted against a real Rapier heightfield by tests/terrain.test.js.
   *
   * @param {number} nrows Subdivisions along +X (the height matrix has nrows+1 rows).
   * @param {number} ncols Subdivisions along +Z (the height matrix has ncols+1 columns).
   * @param {Float32Array} heights `(nrows + 1) * (ncols + 1)` heights, in metres.
   * @param {{x:number,y:number,z:number}} scale Footprint and height scale.
   */
  addHeightfield(nrows, ncols, heights, scale, { surface = SURFACES.GRASS, tag = 'terrain' } = {}) {
    const expected = (nrows + 1) * (ncols + 1);
    if (heights.length !== expected) {
      throw new Error(
        `addHeightfield: expected ${expected} heights for a ${nrows}x${ncols} grid ` +
          `(${nrows + 1} x ${ncols + 1} samples), received ${heights.length}`,
      );
    }
    // The flags argument MUST be passed explicitly: the WASM binding converts it
    // straight to a u32 and panics on `undefined`. FIX_INTERNAL_EDGES smooths
    // contact normals across cell boundaries, which removes the phantom bumps a
    // vehicle otherwise feels when driving across a heightfield grid line.
    const desc = RAPIER.ColliderDesc.heightfield(
      nrows,
      ncols,
      heights,
      scale,
      RAPIER.HeightFieldFlags.FIX_INTERNAL_EDGES,
    )
      .setFriction(0.9)
      .setRestitution(0.0);
    return this.addStatic(desc, { surface, tag });
  }

  /** Build a static triangle mesh collider from raw geometry (roads, bridges). */
  addTrimesh(vertices, indices, { surface = SURFACES.ASPHALT, tag = 'mesh' } = {}) {
    if (indices.length === 0) return null;
    // Flags are explicit for the same reason as the heightfield, and they also
    // clean up any degenerate triangles the ribbon sweep may have produced.
    const flags =
      RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES |
      RAPIER.TriMeshFlags.DELETE_DEGENERATE_TRIANGLES |
      RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES;
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices, flags).setFriction(0.95);
    return this.addStatic(desc, { surface, tag });
  }

  addStaticBox(halfExtents, position, rotation, options = {}) {
    const desc = RAPIER.ColliderDesc.cuboid(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z,
    ).setTranslation(position.x, position.y, position.z);
    if (rotation) desc.setRotation(rotation);
    return this.addStatic(desc, options);
  }

  /* ------------------------------- metadata ------------------------------- */

  registerSurface(collider, surface) {
    if (collider && surface) this._surfaceByHandle.set(collider.handle, surface);
    return collider;
  }

  registerTag(collider, tag) {
    if (collider && tag) this._tagByHandle.set(collider.handle, tag);
    return collider;
  }

  markPlayerCollider(collider) {
    if (collider) this._playerHandles.add(collider.handle);
  }

  isPlayerCollider(handle) {
    return this._playerHandles.has(handle);
  }

  surfaceOf(handle) {
    return this._surfaceByHandle.get(handle) ?? SURFACES.ASPHALT;
  }

  tagOf(handle) {
    return this._tagByHandle.get(handle) ?? 'unknown';
  }

  /**
   * World position of a collider, or null when the handle is not live.
   *
   * Rapier's collision events carry collider *handles*, not contact points, so
   * this is how the impact effects get somewhere sensible to spawn: the midpoint
   * between the two bodies that collided is a good enough stand-in for the
   * contact, and far better than spawning debris at the car's centre.
   */
  colliderPosition(handle) {
    if (!this.world) return null;
    try {
      const collider = this.world.getCollider(handle);
      return collider ? collider.translation() : null;
    } catch {
      return null;
    }
  }

  /** Forget all metadata for a collider (called when a chunk unloads). */
  forget(collider) {
    if (!collider) return;
    this._surfaceByHandle.delete(collider.handle);
    this._tagByHandle.delete(collider.handle);
    this._playerHandles.delete(collider.handle);
  }

  /** Remove a collider and its rigid body from the simulation. */
  removeCollider(collider) {
    if (!collider) return;
    const body = collider.parent();
    this.forget(collider);
    this.world.removeCollider(collider, true);
    if (body && body.isFixed()) {
      // Static props own their body 1:1 with the collider, so clean it up too.
      this.world.removeRigidBody(body);
    }
  }

  onCollision(listener) {
    this._collisionListeners.push(listener);
    return () => {
      const index = this._collisionListeners.indexOf(listener);
      if (index >= 0) this._collisionListeners.splice(index, 1);
    };
  }

  /* -------------------------------- queries ------------------------------- */

  /**
   * Cast a ray downward (or along an arbitrary direction) and return the hit.
   * Returns null when nothing is hit.
   */
  raycast(origin, direction, maxDistance, excludeCollider = null) {
    if (!this.world) return null;
    this._rayOrigin.x = origin.x;
    this._rayOrigin.y = origin.y;
    this._rayOrigin.z = origin.z;
    const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
    this._rayDir.x = direction.x / len;
    this._rayDir.y = direction.y / len;
    this._rayDir.z = direction.z / len;

    const ray = new RAPIER.Ray(this._rayOrigin, this._rayDir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      undefined,
      excludeCollider ?? undefined,
    );
    if (!hit) return null;

    const distance = hit.timeOfImpact;
    return {
      distance,
      collider: hit.collider,
      handle: hit.collider?.handle,
      surface: this.surfaceOf(hit.collider?.handle),
      tag: this.tagOf(hit.collider?.handle),
      point: {
        x: origin.x + this._rayDir.x * distance,
        y: origin.y + this._rayDir.y * distance,
        z: origin.z + this._rayDir.z * distance,
      },
      normal: hit.normal
        ? { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z }
        : { x: 0, y: 1, z: 0 },
    };
  }

  /** Number of colliders currently in the world (used by the perf overlay). */
  colliderCount() {
    return this.world ? this.world.colliders.len() : 0;
  }

  bodyCount() {
    return this.world ? this.world.bodies.len() : 0;
  }

  /** Tear everything down and release WASM memory. */
  dispose() {
    this._collisionListeners.length = 0;
    this._surfaceByHandle.clear();
    this._tagByHandle.clear();
    this._playerHandles.clear();
    if (this.world) {
      this.world.free();
      this.world = null;
    }
    this.events = null;
    this.initialised = false;
  }
}
