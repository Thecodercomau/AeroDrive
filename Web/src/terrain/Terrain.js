import * as THREE from 'three';
import {
  applyRoadFlattening,
  createHeightSampler,
  sampleHeightfield,
  gridIndex,
  gridX,
  gridZ,
  heightAtGrid,
  slopeAtGrid,
  terrainColour,
} from './heightfield.js';

/**
 * Terrain: one generated heightfield drives BOTH the visual mesh and the
 * physics collider.
 *
 * That single-source-of-truth is deliberate. The classic bug in a driving game
 * is a visual hill that is not where the collision hill is, which makes the car
 * appear to drive through the ground. Deriving both from the same Float32Array
 * makes that impossible.
 *
 * The mesh is a single indexed BufferGeometry with vertex colours — no texture
 * fetches, no external assets, and one draw call for the entire landscape.
 */
export class Terrain {
  /**
   * @param {object} options
   * @param {string} options.style Terrain style key (see TERRAIN_STYLES).
   * @param {number|string} options.seed
   * @param {number} options.size Metres across (square, centred on origin).
   * @param {number} options.resolution Grid cells per axis.
   * @param {number} options.vertexSpacing
   * @param {Array<object>} [options.landforms] Hand-placed ridges and gorges.
   */
  constructor({
    style = 'alpine',
    seed = 1337,
    size = 2400,
    resolution = 192,
    landforms = [],
  } = {}) {
    this.sampler = createHeightSampler(style, seed, { landforms });
    this.size = size;
    this.resolution = resolution;
    this.field = sampleHeightfield(this.sampler, { size, resolution });
    this.gridSpacing = size / resolution;

    /** @type {THREE.Mesh|null} */
    this.mesh = null;
    /** @type {import('../physics/PhysicsWorld.js').Collider|null} */
    this.collider = null;
    this.material = null;
  }

  /** Height of the terrain surface at a world position. */
  heightAt(x, z) {
    return heightAtGrid(this.field, x, z);
  }

  /** Slope 0..1 at a world position. */
  slopeAt(x, z) {
    return slopeAtGrid(this.field, x, z, this.gridSpacing);
  }

  /** Direction (radians) of steepest ascent at a world position. */
  gradientDirectionAt(x, z) {
    const d = this.gridSpacing;
    const dx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) / (2 * d);
    const dz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) / (2 * d);
    return Math.atan2(dx, dz);
  }

  /**
   * Flatten the terrain along a road corridor.
   * Must be called BEFORE `buildMesh`/`buildCollider` so both see the change —
   * otherwise the visual ground and the collider would disagree.
   */
  flattenAlongRoad(roadPoints, options) {
    applyRoadFlattening(this.field.heights, this.field, roadPoints, options);
    return this;
  }

  /** Build the visual mesh. One draw call for the whole landscape. */
  buildMesh({ material = null } = {}) {
    const { heights, resolution, size } = this.field;
    const n = resolution + 1;
    const vertexCount = n * n;
    const positions = new Float32Array(vertexCount * 3);
    const colours = new Float32Array(vertexCount * 3);
    const style = { ...this.sampler.style, styleName: this.sampler.styleName };

    // Mesh vertex `(ix, iz)` is placed at `vertexIndex = ix * n + iz`, matching
    // the height-array order so the two can never drift apart.
    for (let ix = 0; ix < n; ix++) {
      const x = gridX(ix, resolution, size);
      for (let iz = 0; iz < n; iz++) {
        const z = gridZ(iz, resolution, size);
        const vertexIndex = ix * n + iz;
        const y = heights[gridIndex(ix, iz, resolution)];

        positions[vertexIndex * 3] = x;
        positions[vertexIndex * 3 + 1] = y;
        positions[vertexIndex * 3 + 2] = z;

        const slope = slopeAtGrid(this.field, x, z, this.gridSpacing);
        const [r, g, b] = terrainColour(y, slope, style);
        colours[vertexIndex * 3] = r;
        colours[vertexIndex * 3 + 1] = g;
        colours[vertexIndex * 3 + 2] = b;
      }
    }

    // Two triangles per cell, wound so the normals face up (+Y).
    const indices = new Uint32Array(resolution * resolution * 6);
    let cursor = 0;
    for (let ix = 0; ix < resolution; ix++) {
      for (let iz = 0; iz < resolution; iz++) {
        const a = ix * n + iz;
        const b = ix * n + iz + 1;
        const c = (ix + 1) * n + iz;
        const d = (ix + 1) * n + iz + 1;
        // (a, c, d) and (a, d, b): counter-clockwise seen from above, which is
        // what gives the terrain an upward-facing normal.
        indices[cursor++] = a;
        indices[cursor++] = d;
        indices[cursor++] = c;
        indices[cursor++] = a;
        indices[cursor++] = b;
        indices[cursor++] = d;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    this.material =
      material ??
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.0,
        flatShading: false,
      });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    return this.mesh;
  }

  /**
   * Build the matching Rapier heightfield collider.
   *
   * Rapier takes the number of subdivisions, so a grid with `resolution` cells
   * per axis is passed as `resolution` and must supply `(resolution + 1)^2`
   * heights — exactly the layout produced by `sampleHeightfield`.
   *
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} physics
   */
  buildCollider(physics, { surface = 'grass', tag = 'terrain' } = {}) {
    const { heights, resolution, size } = this.field;
    // Rapier scales the stored heights by `scale.y`, so we store metres directly
    // by passing 1. `x`/`z` scales set the field's footprint.
    this.collider = physics.addHeightfield(
      resolution,
      resolution,
      heights,
      { x: size, y: 1, z: size },
      { surface, tag },
    );
    return this.collider;
  }

  /** Sample the surface under an (x, z) point, plus its normal. */
  sampleSurface(x, z) {
    const height = this.heightAt(x, z);
    const d = Math.max(this.gridSpacing, 1);
    const hx = this.heightAt(x + d, z) - this.heightAt(x - d, z);
    const hz = this.heightAt(x, z + d) - this.heightAt(x, z - d);
    const normal = new THREE.Vector3(-hx, 2 * d, -hz).normalize();
    return { height, normal };
  }

  /** A position that is safely above the terrain at (x, z). */
  spawnPointAbove(x, z, clearance = 1.1) {
    return { x, y: this.heightAt(x, z) + clearance, z };
  }

  dispose() {
    this.mesh?.geometry?.dispose();
    this.material?.dispose();
    this.mesh = null;
    this.material = null;
    this.collider = null;
  }
}
