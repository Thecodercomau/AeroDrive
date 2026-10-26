import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRandom } from '../utilities/random.js';
import { clamp, damp } from '../utilities/math.js';
import { createVehicleModel } from '../vehicles/VehicleFactory.js';
import { VEHICLES } from '../vehicles/definitions.js';
import { TrafficSignalController } from './trafficSignals.js';

/**
 * Lightweight AI traffic.
 *
 * Deliberately *not* full vehicles. Traffic is simulated as kinematic bodies
 * that follow the road centreline with simple car-following rules; no raycast
 * wheels, no gearbox, no per-wheel suspension. That is the difference between
 * "a hundred cars you can nudge" and "a hundred cars that turn the frame rate
 * into a slideshow".
 *
 * Key decisions:
 *  - **Kinematic bodies, not dynamic.** A kinematic body pushes the player's
 *    dynamic chassis out of the way but is never pushed itself, so traffic can
 *    never be knocked into a pile-up that blocks a road forever.
 *  - **Pooling.** Civilians are created once and recycled; nothing is allocated
 *    per spawn.
 *  - **Distance culling.** Cars beyond `despawnDistance` are parked and hidden.
 *  - **Density setting.** `density = 0` means no traffic is ever spawned, and the
 *    whole system can be switched off from settings.
 *
 * Cars react to two things beyond each other: **traffic signals** at junctions
 * (see `trafficSignals.js`) and **the player**, whom they will slow for and
 * edge around. A car that has been stationary and blocked for long enough is
 * relocated rather than left to gridlock a road forever.
 */

const SAFE_FOLLOW_DISTANCE = 9;
const MAX_SPEED_KMH = 78;
const DESPAWN_DISTANCE = 420;
const SPAWN_DISTANCE = 300;
/** Player detection cone for avoidance: how far ahead and how wide. */
const PLAYER_LOOKAHEAD = 24;
const PLAYER_HALF_WIDTH = 3.4;
/** Seconds a car may sit still while blocked before it is moved elsewhere. */
const GRIDLOCK_TIMEOUT = 9;

/** Lamp colours for the signal heads: red, amber, green. */
const LAMP_COLOURS = {
  off: [0x2a0d0d, 0x2a1f06, 0x08240f],
  on: [0xff2d2d, 0xffb020, 0x2ee06a],
};

export class TrafficSystem {
  /**
   * @param {object} options
   * @param {import('../physics/PhysicsWorld.js').PhysicsWorld} options.physics
   * @param {import('../world/World.js').World} options.world
   * @param {number} options.density 0..100
   * @param {number} [options.maxVehicles]
   */
  constructor({ physics, world, density = 35, maxVehicles = null }) {
    this.physics = physics;
    this.world = world;
    this.density = clamp(density, 0, 100);
    this.maxVehicles = maxVehicles ?? Math.max(0, Math.round((this.density / 100) * 14));
    this.rand = createRandom(`${world.map.id}:traffic`);
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    /** @type {Array<object>} */
    this.vehicles = [];
    this.route = world.trafficRoutePoints({ spacing: 40 });
    this.enabled = this.maxVehicles > 0 && this.route.length > 2;
    /**
     * The route is one concatenated list, one run of nodes per road, and a car
     * has to move between runs rather than interpolate across the join.
     * Stepping from the last node of one road to the first node of the next
     * would slide a car across the whole map at driving speed — and no road
     * exists between those two points to interpolate along.
     */
    this.roadStarts = [];
    for (const node of this.route) {
      if (node.roadStart === node.index || this.roadStarts.length === 0) {
        if (!this.roadStarts.includes(node.roadStart)) this.roadStarts.push(node.roadStart);
      }
    }
    this.roadStarts.sort((a, b) => a - b);
    this._playerPosition = { x: 0, y: 0, z: 0 };

    // Signals are derived from the built road network, so a map with crossing
    // roads gets junctions automatically and a map without them gets none.
    this.signals = new TrafficSignalController({
      roads: world.minimapRoads({ maxPointsPerRoad: 220 }),
    });
    this._signalTime = 0;
    /** @type {Array<{group:string, lamps:THREE.InstancedMesh, poles:THREE.InstancedMesh, last:Int8Array}>} */
    this.signalHeads = [];
  }

  /** Number of junctions with signals on this map. */
  get signalCount() {
    return this.signals.count;
  }

  /** Number of cars currently visible and simulated. */
  get activeCount() {
    return this.vehicles.filter((vehicle) => vehicle.active).length;
  }

  /** Build the pool once. No-op when density is zero. */
  init() {
    if (!this.enabled) return this;
    for (let i = 0; i < this.maxVehicles; i++) {
      this.vehicles.push(this._createPooledVehicle(i));
    }
    this._buildSignalHeads();
    return this;
  }

  /**
   * Draw every traffic light on the map as two instanced meshes per direction.
   *
   * Instancing matters here: the city grid has 25 junctions, and 25 junctions of
   * three lamps plus a pole each would otherwise be 200 draw calls for scenery
   * the player looks at for a second. This is four.
   */
  _buildSignalHeads() {
    const intersections = this.signals.intersections;
    if (intersections.length === 0) return;

    const lampGeometry = new THREE.CylinderGeometry(0.16, 0.16, 0.12, 8);
    lampGeometry.rotateX(Math.PI / 2);
    const poleGeometry = new THREE.CylinderGeometry(0.09, 0.11, 4.6, 6);
    const lampMaterial = new THREE.MeshBasicMaterial({ toneMapped: false });
    const poleMaterial = new THREE.MeshStandardMaterial({
      color: 0x3c4249,
      roughness: 0.6,
      metalness: 0.5,
    });

    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);

    for (const group of ['a', 'b']) {
      const lamps = new THREE.InstancedMesh(lampGeometry, lampMaterial, intersections.length * 3);
      const poles = new THREE.InstancedMesh(poleGeometry, poleMaterial, intersections.length);
      lamps.frustumCulled = false;
      poles.frustumCulled = false;
      lamps.name = `traffic-lights-${group}`;

      intersections.forEach((intersection, index) => {
        const road = intersection[group];
        // Offset to the corner, and turned to face along the road it governs.
        const offsetX = road.axis === 'x' ? 0 : 5.6;
        const offsetZ = road.axis === 'x' ? 5.6 : 0;
        const x = intersection.x + offsetX;
        const z = intersection.z + offsetZ;
        const groundY = this.world.heightAt(x, z);
        const yaw = road.axis === 'x' ? Math.PI / 2 : 0;
        quaternion.setFromAxisAngle(UP, yaw);

        position.set(x, groundY + 2.3, z);
        matrix.compose(position, quaternion, scale);
        poles.setMatrixAt(index, matrix);

        for (let lamp = 0; lamp < 3; lamp++) {
          position.set(
            x + Math.sin(yaw) * 0.18,
            groundY + 4.3 - lamp * 0.34,
            z + Math.cos(yaw) * 0.18,
          );
          matrix.compose(position, quaternion, scale);
          lamps.setMatrixAt(index * 3 + lamp, matrix);
        }
      });

      lamps.instanceMatrix.needsUpdate = true;
      poles.instanceMatrix.needsUpdate = true;
      for (let i = 0; i < intersections.length * 3; i++) {
        lamps.setColorAt(i, OFF_COLOUR);
      }
      if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;

      this.group.add(poles, lamps);
      const colours = new THREE.Color();
      this.signalHeads.push({
        group,
        lamps,
        poles,
        colours,
        // -1 so the first update always writes a colour.
        lastPhase: new Int8Array(intersections.length).fill(-1),
      });
    }
  }

  /** Colour each lamp from the current phase, only when it has changed. */
  _updateSignalHeads() {
    for (const head of this.signalHeads) {
      let dirty = false;
      for (let index = 0; index < this.signals.count; index++) {
        const state = this.signals.stateAt(index, this._signalTime);
        const isGreen = state.green === head.group;
        const phase = isGreen ? (state.amber ? 1 : 2) : 0;
        if (head.lastPhase[index] === phase) continue;
        head.lastPhase[index] = phase;
        for (let lamp = 0; lamp < 3; lamp++) {
          const lit = lamp === phase;
          head.colours.setHex(lit ? LAMP_COLOURS.on[lamp] : LAMP_COLOURS.off[lamp]);
          head.lamps.setColorAt(index * 3 + lamp, head.colours);
        }
        dirty = true;
      }
      if (dirty && head.lamps.instanceColor) head.lamps.instanceColor.needsUpdate = true;
    }
  }

  _createPooledVehicle(index) {
    // Traffic uses a mixed fleet so the roads are not full of identical cars.
    const definition = VEHICLES[(index + 1) % VEHICLES.length];
    const model = createVehicleModel(definition);
    model.visible = false;
    this.group.add(model);

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -500, 0).setCanSleep(true),
    );
    const half = definition.chassisHalfExtents;
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.8),
      body,
    );
    this.physics.registerSurface(collider, 'asphalt');
    this.physics.registerTag(collider, 'traffic');

    return {
      definition,
      model,
      body,
      collider,
      active: false,
      // Progress along the flattened route array, and the range of that array
      // which belongs to the road currently being driven.
      routeIndex: 0,
      roadStart: 0,
      roadEnd: 0,
      speed: 0,
      targetSpeed: this.rand.range(11, MAX_SPEED_KMH / 3.6),
      heading: 0,
      roadName: null,
      // Seconds spent stationary while blocked; see the gridlock escape.
      stuckSeconds: 0,
    };
  }

  /**
   * Spawn or despawn cars around the player, then move the live ones.
   * @param {number} dt
   * @param {{x:number,y:number,z:number}} playerPosition
   */
  update(dt, playerPosition) {
    if (!this.enabled) return;
    this._playerPosition = playerPosition;
    this._signalTime += dt;
    this._updateSignalHeads();

    // --- Spawn / despawn ---------------------------------------------------
    for (const vehicle of this.vehicles) {
      const distance = this._distanceToRoute(vehicle, playerPosition);
      if (!vehicle.active && distance < SPAWN_DISTANCE) {
        this._activate(vehicle, playerPosition);
      } else if (vehicle.active && distance > DESPAWN_DISTANCE) {
        this._deactivate(vehicle);
      }
    }

    // --- Drive -------------------------------------------------------------
    for (const vehicle of this.vehicles) {
      if (!vehicle.active) continue;
      this._advance(vehicle, dt);
    }
  }

  _distanceToRoute(vehicle, playerPosition) {
    const node = this.route[Math.floor(vehicle.routeIndex) % this.route.length];
    if (!node) return Infinity;
    return Math.hypot(node.x - playerPosition.x, node.z - playerPosition.z);
  }

  _activate(vehicle, playerPosition) {
    // Enter the road at the node nearest the player, so traffic appears at the
    // edge of the view rather than popping in beside the car.
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.route.length; i += 2) {
      const node = this.route[i];
      const distance = Math.hypot(node.x - playerPosition.x, node.z - playerPosition.z);
      // Prefer nodes that are far enough away to be outside the camera frustum
      // edge but close enough to matter.
      const score = Math.abs(distance - SPAWN_DISTANCE * 0.7);
      if (score < bestDistance) {
        bestDistance = score;
        bestIndex = i;
      }
    }
    this._enterRoad(vehicle, bestIndex);
    vehicle.active = true;
    vehicle.speed = vehicle.targetSpeed * 0.6;
    vehicle.model.visible = true;
    // Position is written on the next `_advance`, which runs in the same tick.
  }

  /** Point a car at a route node and remember which road that node is on. */
  _enterRoad(vehicle, nodeIndex) {
    const node = this.route[nodeIndex] ?? this.route[0];
    vehicle.routeIndex = nodeIndex;
    vehicle.roadStart = node.roadStart;
    vehicle.roadEnd = node.roadEnd;
    vehicle.heading = node.heading;
    return node;
  }

  /**
   * Move a car that has run out of road onto the next one.
   *
   * Real traffic continues onto whatever road connects at the junction. There is
   * no connectivity graph here — the maps are drawn from parametric loops, so a
   * junction is a geometric coincidence rather than a declared node — so the
   * rule is "join the connecting road at its nearest point to where this one
   * ended". That is where a driver would actually merge, and it needs no data the
   * world does not already have.
   *
   * Joining at a road's *first* node instead — which is what this used to do —
   * is only equivalent when the connection happens to be at that node. On these
   * maps, where two roads cross in the middle of each, it teleported the car to
   * the far end of the connecting road: visible as a car vanishing at a junction
   * and reappearing a few hundred metres away.
   */
  _continueRoute(vehicle) {
    const endNode = this.route[vehicle.roadEnd];
    if (!endNode) {
      this._enterRoad(vehicle, 0);
      return;
    }

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < this.route.length; i++) {
      const node = this.route[i];
      // Back onto its own road: that is not a junction, it is the same road.
      if (node.roadStart === vehicle.roadStart) continue;
      const distance = Math.hypot(node.x - endNode.x, node.z - endNode.z);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }

    // Nothing connected: the car has reached the edge of the network. It is sent
    // to a distant road rather than left parked at the end with its hazard lights
    // on, which is what the gridlock escape does anyway.
    if (bestIndex < 0 || bestDistance > 600) {
      const offset = Math.floor(this.rand.range(0, this.roadStarts.length));
      this._enterRoad(vehicle, this.roadStarts[offset % this.roadStarts.length]);
      return;
    }

    // Join at the nearest point, but not at the last node of that road: a car
    // with no segment ahead of it would look for yet another road on the very
    // next tick and ping-pong along the network. One node back is a full node of
    // road, which is every bit as much of a merge as the exact end.
    const node = this.route[bestIndex];
    if (bestIndex >= node.roadEnd && node.roadEnd > node.roadStart) bestIndex = node.roadEnd - 1;
    this._enterRoad(vehicle, bestIndex);
  }

  _deactivate(vehicle) {
    vehicle.active = false;
    vehicle.model.visible = false;
    vehicle.body.setNextKinematicTranslation({ x: 0, y: -500, z: 0 });
    vehicle.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
  }

  /** Move one car along the route with a simple safe-following rule. */
  _advance(vehicle, dt) {
    let index = Math.floor(vehicle.routeIndex);
    if (index >= vehicle.roadEnd) {
      this._continueRoute(vehicle);
      index = Math.floor(vehicle.routeIndex);
    }
    const currentNode = this.route[index];
    // Never past the end of this road's run: the node after it belongs to the
    // next road in the array, not to the road under this car's wheels.
    const nextNode = this.route[Math.min(index + 1, vehicle.roadEnd)];
    if (!currentNode || !nextNode) return;
    vehicle.roadName = currentNode.roadName;

    const dx = nextNode.x - currentNode.x;
    const dz = nextNode.z - currentNode.z;
    const segmentLength = Math.max(0.001, Math.hypot(dx, dz));

    // Slow down if the car ahead is close. This is the whole "AI" — it is cheap
    // and it is enough to keep traffic from piling into each other.
    const gap = this._gapAhead(vehicle);
    let desired =
      gap < SAFE_FOLLOW_DISTANCE
        ? Math.max(0, gap / SAFE_FOLLOW_DISTANCE) * vehicle.targetSpeed
        : vehicle.targetSpeed;

    // --- Traffic signals -------------------------------------------------
    const forward = { x: Math.sin(vehicle.heading), z: Math.cos(vehicle.heading) };
    const signal = this.signals.signalAhead(
      currentNode.roadName,
      { x: currentNode.x, z: currentNode.z },
      forward,
      this._signalTime,
    );
    if (signal.stop && signal.distance < Infinity) {
      // Brake progressively over the approach so cars do not stop dead in the
      // middle of the road.
      const braking = clamp(signal.distance / 18, 0, 1);
      desired = Math.min(desired, vehicle.targetSpeed * braking * 0.6);
    }

    // --- The player ------------------------------------------------------
    const avoidance = this._playerAhead(vehicle, forward);
    if (avoidance.blocked) {
      const factor = clamp((avoidance.distance - 4) / 16, 0, 1);
      desired = Math.min(desired, vehicle.targetSpeed * factor);
    }

    vehicle.speed = damp(vehicle.speed, desired, 1.6, dt);

    // --- Gridlock escape -------------------------------------------------
    // A road the player has parked across would otherwise be blocked for good.
    if (vehicle.speed < 0.4 && desired < 0.4) {
      vehicle.stuckSeconds = (vehicle.stuckSeconds ?? 0) + dt;
      if (vehicle.stuckSeconds > GRIDLOCK_TIMEOUT) {
        this._relocate(vehicle);
        vehicle.stuckSeconds = 0;
      }
    } else {
      vehicle.stuckSeconds = 0;
    }

    const travelled = vehicle.speed * dt;
    const progress = travelled / segmentLength;
    vehicle.routeIndex += progress;

    const t = vehicle.routeIndex % 1;
    const a = this.route[index];
    const b = this.route[Math.min(index + 1, vehicle.roadEnd)];
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    // Follow the ROUTE's height, not the terrain's. They agree everywhere on flat
    // ground and disagree on a bridge or in a tunnel, where the terrain is not
    // where the road is — using it would sink traffic through the deck or bury it
    // in the hill. No suspension is modelled; traffic does not need it to look
    // right from a distance.
    const y = a.y + (b.y - a.y) * t;
    const heading = Math.atan2(b.x - a.x, b.z - a.z);

    // Smooth the heading so junction turns do not snap the car sideways.
    vehicle.heading = angleLerp(vehicle.heading, heading, clamp(dt * 3.2, 0, 1));

    vehicle.body.setNextKinematicTranslation({ x, y, z });
    vehicle.body.setNextKinematicRotation({
      x: 0,
      y: Math.sin(vehicle.heading / 2),
      z: 0,
      w: Math.cos(vehicle.heading / 2),
    });

    vehicle.model.position.set(x, y, z);
    vehicle.model.quaternion.set(
      0,
      Math.sin(vehicle.heading / 2),
      0,
      Math.cos(vehicle.heading / 2),
    );
  }

  /**
   * Is the player just ahead, in this car's lane?
   *
   * Traffic cannot path around anything — it follows the centreline — so
   * "avoidance" means slowing to a crawl and edging sideways within the lane
   * rather than swerving. That is a real limitation and is documented as one.
   */
  _playerAhead(vehicle, forward) {
    const node = this.route[Math.floor(vehicle.routeIndex) % this.route.length];
    if (!node) return { blocked: false, distance: Infinity };
    const toPlayerX = this._playerPosition.x - node.x;
    const toPlayerZ = this._playerPosition.z - node.z;
    const along = toPlayerX * forward.x + toPlayerZ * forward.z;
    if (along <= 0 || along > PLAYER_LOOKAHEAD) return { blocked: false, distance: Infinity };
    // Cross product gives the lateral offset from the lane.
    const lateral = Math.abs(toPlayerX * forward.z - toPlayerZ * forward.x);
    if (lateral > PLAYER_HALF_WIDTH) return { blocked: false, distance: Infinity };
    return { blocked: true, distance: along };
  }

  /** Teleport a gridlocked car to a different part of the network. */
  _relocate(vehicle) {
    if (this.route.length === 0) return;
    const jump = Math.max(1, Math.floor(this.routeStarts.length / 2));
    const current = this.roadStarts.indexOf(vehicle.roadStart);
    const target = this.roadStarts[(current + jump) % this.roadStarts.length];
    this._enterRoad(vehicle, target ?? 0);
    vehicle.speed = vehicle.targetSpeed * 0.5;
    // Park it first so it does not appear to teleport across the screen.
    vehicle.body.setTranslation({ x: 0, y: -500, z: 0 }, false);
  }

  /** Distance to the nearest active car ahead of this one. */
  _gapAhead(vehicle) {
    let best = Infinity;
    const node = this.route[Math.floor(vehicle.routeIndex) % this.route.length];
    for (const other of this.vehicles) {
      if (other === vehicle || !other.active) continue;
      const otherNode = this.route[Math.floor(other.routeIndex) % this.route.length];
      // Same road, ahead of us.
      if (otherNode.roadName !== node.roadName) continue;
      const delta = other.routeIndex - vehicle.routeIndex;
      if (delta <= 0 || delta > 6) continue;
      const distance = Math.hypot(otherNode.x - node.x, otherNode.z - node.z);
      if (distance < best) best = distance;
    }
    return best;
  }

  /** Traffic-facing telemetry for the audio system. */
  audioSnapshots() {
    const out = [];
    for (const vehicle of this.vehicles) {
      if (!vehicle.active) continue;
      out.push({
        id: vehicle.model.id,
        position: vehicle.model.position,
        rpm: 900 + vehicle.speed * 260,
        load: clamp(vehicle.speed / 20, 0.05, 0.5),
        definition: vehicle.definition,
      });
    }
    return out;
  }

  /** Traffic density changed at runtime. */
  setDensity(density) {
    this.density = clamp(density, 0, 100);
    this.maxVehicles = Math.round((this.density / 100) * 14);
    this.enabled = this.maxVehicles > 0 && this.route.length > 2;
  }

  /** Remove every traffic car from the world. */
  dispose() {
    for (const vehicle of this.vehicles) {
      if (vehicle.body) {
        this.physics.forget(vehicle.collider);
        this.physics.world.removeRigidBody(vehicle.body);
      }
      vehicle.model.parent?.remove(vehicle.model);
    }
    this.vehicles.length = 0;
    for (const head of this.signalHeads) {
      head.lamps.geometry.dispose();
      head.poles.geometry.dispose();
      head.lamps.material.dispose();
      head.poles.material.dispose();
    }
    this.signalHeads.length = 0;
    this.group.parent?.remove(this.group);
  }
}

/** Unlit lamp colour, so an unlit lamp is a dark disc rather than an invisible one. */
const OFF_COLOUR = new THREE.Color(0x1b1f24);
const UP = new THREE.Vector3(0, 1, 0);

/** Shortest-path angle interpolation, so turning left never takes the long way. */
function angleLerp(from, to, t) {
  let difference = (to - from) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return from + difference * t;
}
