import { EventBus } from '../core/EventBus.js';
import { GameLoop } from '../core/GameLoop.js';
import { PhysicsWorld } from '../physics/PhysicsWorld.js';
import { Renderer } from '../rendering/Renderer.js';
import { Environment } from '../rendering/Environment.js';
import { Weather } from '../rendering/weather.js';
import { DrivingEffects } from '../rendering/DrivingEffects.js';
import { CameraRig } from '../camera/CameraRig.js';
import { InputManager } from '../input/InputManager.js';
import { TouchControls } from '../input/TouchControls.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { SettingsStore } from '../settings/SettingsStore.js';
import { SaveManager } from '../saves/SaveManager.js';
import { World } from '../world/World.js';
import { MAPS, getMap, defaultMapId } from '../world/maps.js';
import { Vehicle } from '../vehicles/Vehicle.js';
import {
  createVehicleModel,
  setBrakeLights,
  setHeadlightGlow,
} from '../vehicles/VehicleFactory.js';
import { resolvePaint } from '../vehicles/paints.js';
import { VEHICLES, getVehicleDefinition, defaultVehicleId } from '../vehicles/definitions.js';
import { CHALLENGES, getChallenge } from '../missions/challenges.js';
import { MissionRunner, MISSION_STATUS } from '../missions/MissionRunner.js';
import { TrafficSystem } from '../ai/TrafficSystem.js';
import { UIManager, formatTime } from '../ui/UIManager.js';
import { HUD } from '../ui/HUD.js';
import { clamp } from '../utilities/math.js';
import { nextFrame } from '../utilities/scheduling.js';

/**
 * Application orchestrator.
 *
 * Owns the subsystems and the state machine that runs them:
 *
 *   boot -> menu -> driving <-> paused
 *               \-> loading (map change)
 *
 * Every side effect a menu can trigger goes through the `actions` facade
 * exposed to the UI, so the DOM layer never reaches into the simulation
 * directly. The fixed-step simulation lives in `update()`; presentation lives in
 * `render()`.
 */

export const GAME_STATE = {
  BOOT: 'boot',
  LOADING: 'loading',
  MENU: 'menu',
  DRIVING: 'driving',
  PAUSED: 'paused',
};

/** How close to a garage or recovery point the car must stop for a free repair. */
export const SERVICE_RADIUS = 24;

export class Game {
  /** @param {object} options @param {HTMLCanvasElement} options.canvas */
  constructor({ canvas }) {
    this.canvas = canvas;
    this.bus = new EventBus();
    this.state = GAME_STATE.BOOT;
    this.settings = new SettingsStore();
    this.saves = new SaveManager({ bus: this.bus });
    this.audio = new AudioEngine({ settings: this.settings });
    this.physics = new PhysicsWorld();

    this.renderer = new Renderer({ canvas, settings: this.settings.values });

    // Weather owns the rain field and the wetness ramp; the driving effects own
    // skid marks and particles. Both are pure presentation and are configured
    // from settings, never from the vehicle.
    this.weather = new Weather({ scene: this.renderer.scene, settings: this.settings.values });
    this.effects = new DrivingEffects({
      scene: this.renderer.scene,
      settings: this.settings.values,
    });

    this.world = null;
    /** @type {Vehicle|null} */
    this.vehicle = null;
    /** @type {MissionRunner|null} */
    this.mission = null;
    /** @type {TrafficSystem|null} */
    this.traffic = null;

    this.environment = null;
    this.actions = this._createActions();
    this.camera = new CameraRig({ camera: this.renderer.camera, settings: this.settings });
    this.hud = new HUD();
    this.ui = new UIManager({
      actions: this.actions,
      settings: this.settings,
      audio: this.audio,
    });
    this.ui.settingsPanel.setActions(this.actions);

    this.input = new InputManager({
      target: canvas,
      getBindings: () => this.settings.get('bindings'),
      getDeadzone: () => this.settings.get('gamepadDeadzone'),
    });
    this.touchControls = new TouchControls({
      input: this.input,
      onPause: () => this.pause(),
    });

    this.loop = new GameLoop({
      update: (dt) => this.update(dt),
      render: (alpha, dt) => this.render(alpha, dt),
      fixedHz: 60,
      fpsLimit: this.settings.get('fpsLimit'),
    });

    this.currentMapId = defaultMapId();
    this.currentVehicleId = defaultVehicleId();
    this.currentPaintId = null;
    this.currentSpawnId = null;
    this.driftMode = false;
    this.showcase = true;

    this._playtimeAccumulator = 0;
    this._unlockAudioOnce = null;
    this._collisionUnsubscribe = null;
    this._impactQueue = 0;
    this._impactPoint = null;
    this._serviceCooldown = 0;
    this._contextLostHandled = false;
    this._lastChallengeId = null;
    this._trafficVoices = [];
    this._audioProfileId = null;
    // The clock lives here rather than in `Environment` because the environment
    // is rebuilt on every map change and the time of day must not jump back to
    // morning when the player switches maps.
    this.clockHour = this.settings.get('timeOfDay') ?? 10;

    this._wireBus();
    this._wireWindowEvents();
    this._wireEdgeTriggeredKeys();
  }

  /* --------------------------------- boot ---------------------------------- */

  /** Boot the game. Resolves once the menu is interactive. */
  async boot() {
    this.ui.showOnly('loading');
    this.ui.setLoading('Preparing simulation…', 0.05, 'Initialising physics engine');

    // Settings first: everything downstream reads from them.
    const settings = this.settings.values;
    await nextFrame();

    await this.saves.init();
    // Transient: saving happens on a debounce and must not overwrite the
    // persistent status line ("… loaded") that boot leaves behind.
    this.bus.on('progress:saved', () => this.ui.setStatus('Progress saved', { transient: true }));

    try {
      await this.physics.init();
    } catch (error) {
      console.error('[Game] Physics initialisation failed:', error);
      this.ui.showFatalError(
        'AERODRIVE could not start its physics engine.',
        'WebAssembly is required. Try a current version of Chrome, Edge, Firefox or Safari.',
      );
      return;
    }
    this.ui.setLoading('Preparing simulation…', 0.25, 'Physics online');

    this.renderer.applySettings(settings);
    this.hud.setWorld(null);

    // Build the selected map so the menu has a live 3D backdrop.
    await this.loadMap(this.currentMapId, {
      showcase: true,
      vehicleId: this._savedVehicleId(),
    });

    this.input.attach();
    this.state = GAME_STATE.MENU;
    this.ui.showOnly('main');
    this.ui.setStatus(`${this.world.map.name} loaded`);
    this.ui.refreshAll();
    this.hud.hide();

    // Audio needs a gesture; arm it once.
    this._armAudioUnlock();

    this.loop.start();
    this.bus.emit('game:ready', { mapId: this.currentMapId });
  }

  _savedVehicleId() {
    const progress = this.saves.values;
    const unlocked = new Set(progress.unlockedVehicles ?? []);
    const selected = progress.selectedVehicle;
    if (selected && unlocked.has(selected)) return selected;
    return defaultVehicleId();
  }

  /**
   * Build a world and place a vehicle in it.
   * @param {string} mapId
   * @param {object} options
   */
  async loadMap(
    mapId,
    { showcase = false, vehicleId = null, spawnId = null, challenge = null } = {},
  ) {
    const map = getMap(mapId);
    if (!map) {
      console.warn(`[Game] Unknown map "${mapId}"; keeping the current world.`);
      return;
    }

    this.state = GAME_STATE.LOADING;
    this.touchControls.hide();
    this.ui.showOnly('loading');
    this.ui.setLoading(`Loading ${map.name}…`, 0.3, 'Generating terrain');

    this._teardownPlayable();
    this.world?.dispose();
    this.world = null;

    await nextFrame();

    const world = new World({
      physics: this.physics,
      mapId,
      vegetationDensity: this.settings.get('vegetationDensity'),
      preset: this.settings.get('preset'),
    });

    // Terrain generation is the single most expensive step in the whole game, so
    // it is yielded around rather than run in one uninterrupted block.
    await world.buildStaged((fraction, label) => {
      this.ui.setLoading(`Loading ${map.name}…`, 0.3 + fraction * 0.55, label);
    });

    this.world = world;
    this.currentMapId = mapId;
    this.renderer.add(world.group);
    this.hud.setWorld(world);
    // Effects and the road's wetness belong to the world, so they are rebound
    // here: skid marks laid on the previous map must not survive into this one.
    this.effects.setWorld(world);
    world.roads.setWetness(this.weather.wetness);

    this.ui.setLoading(`Loading ${map.name}…`, 0.9, 'Preparing vehicle');
    await nextFrame();

    const definition = getVehicleDefinition(vehicleId ?? this._savedVehicleId()) ?? VEHICLES[0];
    const progress = this.saves.values;
    const paintId = progress.selectedPaints?.[definition.id] ?? definition.paint.default;
    this.currentPaintId = paintId;

    const spawn = world.resolveSpawn(spawnId ?? (showcase ? null : map.spawnPoints[0].id));
    const resolvedSpawn = challenge ? world.resolveSpawn(challenge.spawnId) : spawn;

    this.renderer.add(this._createVehicle(definition, resolvedSpawn, paintId));

    // Stream the props around the spawn point before the first frame is shown.
    world.update(this.vehicle.position(), {
      loadDistance: this.settings.get('viewDistance') * 0.55,
    });
    this.saves.markMapVisited(mapId);

    this.showcase = showcase;
    this.camera.setMode(showcase ? 'cinematic' : 'chase');
    this.camera.snapTo(this.vehicle.object3D, definition);

    this.ui.setLoading(`${map.name} ready`, 1, '');
    await nextFrame();
  }

  _createVehicle(definition, spawnPose, paintId) {
    const model = createVehicleModel(definition, paintId);
    this.renderer.add(model);

    const vehicle = new Vehicle({
      physics: this.physics,
      definition,
      spawn: spawnPose,
      heading: spawnPose.heading ?? 0,
      object3D: model,
    });

    this.vehicle = vehicle;
    this.currentVehicleId = definition.id;
    vehicle.setManualTransmission(this.settings.get('transmission') === 'manual');
    vehicle.setDriftMode(this.driftMode);
    this.camera.resetLook();
    this._installCollisionFeedback(vehicle);
    return model;
  }

  /* -------------------------------- lifecycle ------------------------------- */

  _teardownPlayable() {
    this.traffic?.dispose();
    this.traffic = null;
    this.mission = null;
    this._collisionUnsubscribe?.();
    this._collisionUnsubscribe = null;

    if (this.vehicle) {
      this.vehicle.object3D && this.renderer.remove(this.vehicle.object3D);
      this.vehicle.dispose();
      this.vehicle = null;
    }
    for (const id of [...(this._trafficVoices ?? [])]) this.audio.detachPositionalVehicle(id);
    this._trafficVoices = [];
  }

  /** Start driving (free roam or a challenge). */
  startDriving({ challengeId = null, spawnId = null } = {}) {
    if (!this.world) return;
    const challenge = challengeId ? getChallenge(challengeId) : null;

    if (challenge && challenge.mapId !== this.currentMapId) {
      // Challenge lives on another map; load it first, then start.
      void this.loadMap(challenge.mapId, {
        challenge,
        vehicleId: this.currentVehicleId,
        spawnId: challenge.spawnId,
      }).then(() => this.startDriving({ challengeId }));
      return;
    }

    this.showcase = false;
    this.camera.setMode('chase');
    this.camera.snapTo(this.vehicle.object3D, this.vehicle.definition);

    if (spawnId) {
      const pose = this.world.resolveSpawn(spawnId);
      this.vehicle.recover(pose);
      this.currentSpawnId = spawnId;
    }

    // Traffic
    this.traffic?.dispose();
    this.traffic = null;
    const density = this.settings.get('trafficDensity');
    if (density > 0) {
      this.traffic = new TrafficSystem({
        physics: this.physics,
        world: this.world,
        density,
      });
      this.traffic.init();
      this.renderer.add(this.traffic.group);
    }

    this.mission = challenge
      ? new MissionRunner({ challenge, world: this.world, bus: this.bus })
      : null;
    this.mission?.start({ damage: this.vehicle.telemetry.damage });

    this.state = GAME_STATE.DRIVING;
    this.loop.setPaused(false);
    this.input.setEnabled(true);
    this.input.requestPointerLock();
    this.touchControls.show();
    this.ui.hideAll();
    this.hud.show();
    this.ui.setControlsGuideVisible(this.settings.get('showControlGuide'));
    this.audio.resume();

    const mapName = this.world.map.name;
    if (this.mission) {
      this.hud.setObjective(this.mission.challenge.name, this.mission.objectiveText());
      this.hud.toast(`Challenge started: ${this.mission.challenge.name}`, 3);
    } else {
      this.hud.setObjective(null);
      this.hud.toast(`Free roam — ${mapName}`, 2.6);
    }
    this.bus.emit('game:driving', { mapId: this.currentMapId, challengeId });
  }

  pause() {
    if (this.state !== GAME_STATE.DRIVING) return;
    this.state = GAME_STATE.PAUSED;
    this.loop.setPaused(true);
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.touchControls.hide();
    this.audio.setMuted(true);
    this.ui.showOnly('pause');
  }

  resume() {
    if (this.state !== GAME_STATE.PAUSED) return;
    this.state = GAME_STATE.DRIVING;
    this.loop.setPaused(false);
    this.input.setEnabled(true);
    this.input.requestPointerLock();
    this.touchControls.show();
    this.audio.setMuted(false);
    this.ui.hideAll();
    this.hud.show();
  }

  quitToMenu() {
    this._flushProgress();
    this._teardownPlayable();
    this.loop.setPaused(false);
    this.state = GAME_STATE.MENU;
    this.showcase = true;
    this.input.setEnabled(false);
    this.input.exitPointerLock();
    this.touchControls.hide();
    this.audio.setMuted(false);
    this.hud.hide();
    this.ui.setControlsGuideVisible(false);

    // Rebuild a showcase car so the menu has something to look at.
    void this.loadMap(this.currentMapId, {
      showcase: true,
      vehicleId: this.currentVehicleId,
    }).then(() => {
      this.ui.showOnly('main');
      this.ui.refreshAll();
    });
  }

  restartChallenge() {
    if (!this.mission && !this._lastChallengeId) return;
    const challengeId = this.mission?.challenge.id ?? this._lastChallengeId;
    this.loop.setPaused(false);
    this.mission = null;
    this.vehicle.recover(this.world.resolveSpawn(getChallenge(challengeId)?.spawnId));
    this.vehicle.repair();
    this.startDriving({ challengeId });
  }

  /* ------------------------------ settings hook ----------------------------- */

  /** Called whenever settings change from the UI. */
  applySettings(settings) {
    this.renderer.applySettings(settings);
    this.audio.applySettings(settings);
    this.weather.applySettings(settings);
    this.effects.applySettings(settings);
    this.vehicle?.setManualTransmission(settings.transmission === 'manual');
    this.loop.setFpsLimit(settings.fpsLimit);
    this.ui.setControlsGuideVisible(settings.showControlGuide && this.state === GAME_STATE.DRIVING);
    if (this.environment) this.environment.applySettings(settings);
    this.traffic?.setDensity(settings.trafficDensity);
    // `Renderer.applySettings` already re-applies the pixel ratio/render scale,
    // so there is deliberately nothing else to do here.
  }

  /* -------------------------------- actions -------------------------------- */

  _createActions() {
    return {
      quickDrive: () => this.startDriving({ spawnId: this.currentSpawnId }),
      freeRoam: () => this.startDriving({}),
      selectMap: async (mapId) => {
        const resumeDriving = this.state === GAME_STATE.PAUSED;
        await this.loadMap(mapId, {
          showcase: !resumeDriving,
          vehicleId: this.currentVehicleId,
        });
        if (resumeDriving) {
          this.startDriving();
          return;
        }
        this.state = GAME_STATE.MENU;
        this.ui.showOnly('maps');
        this.ui.refreshMaps();
        this.ui.setStatus(`${getMap(mapId)?.name ?? mapId} loaded`);
      },
      selectVehicle: (vehicleId) => {
        this.saves.setSelectedVehicle(vehicleId);
      },
      setVehiclePaint: (vehicleId, paintId) => {
        this.saves.setPaint(vehicleId, paintId);
      },
      previewVehicle: (vehicleId, paintId) => this._previewVehicle(vehicleId, paintId),
      driveSelectedVehicle: () => {
        const { vehicleId, paintId } = this.ui.garage.selection;
        this.saves.setSelectedVehicle(vehicleId);
        if (paintId) this.saves.setPaint(vehicleId, paintId);
        void this._swapVehicle(vehicleId, paintId).then(() => this.startDriving({}));
      },
      startChallenge: (challengeId) => this.startDriving({ challengeId }),
      restartChallenge: () => this.restartChallenge(),
      recover: () => {
        this.vehicle?.recover();
        this.hud.toast('Vehicle recovered', 1.6);
      },
      toggleDrift: () => this._toggleDriftMode(),
      back: () => this._goBack(),
      resume: () => this.resume(),
      quitToMenu: () => this.quitToMenu(),
      requestResetProgress: () => this._confirmResetProgress(),
      applySettings: (settings) => this.applySettings(settings),
      getState: () => this.getState(),
      getWorldMapData: () => this.getWorldMapData(),
    };
  }

  /**
   * Everything the world map screen draws.
   *
   * Read from the live world rather than from the map definition, so what the
   * map shows is what was actually built — including the road network after
   * grading, not the control points that were requested.
   */
  getWorldMapData() {
    if (!this.world) return null;
    const position = this.vehicle ? this.vehicle.position() : null;
    return {
      name: this.world.map.name,
      tagline: this.world.map.tagline,
      bounds: this.world.bounds,
      roads: this.world.minimapRoads({ maxPointsPerRoad: 160 }),
      landmarks: this.world.landmarks,
      services: this.world.services,
      discovered: this.saves.values.discoveredLocations ?? [],
      markers: this.mission ? this.mission.minimapMarkers() : [],
      position: position ? { x: position.x, z: position.z } : null,
      heading: this.vehicle ? this._vehicleHeading() : 0,
    };
  }

  /**
   * Step back one screen.
   *
   * Back has to remember where the player came from rather than assuming the
   * main menu: Settings can be opened from the pause screen mid-drive, and
   * sending the player to the main menu from there would abandon their session.
   */
  async _goBack() {
    switch (this.ui.current) {
      case 'pause':
        this.resume();
        return;
      case 'settings':
      case 'garage':
      case 'maps':
      case 'worldmap':
      case 'challenges':
      case 'credits':
        // These can be reached from the main menu *or* from the pause screen.
        if (this.state === GAME_STATE.PAUSED) {
          this.ui.showOnly('pause');
          return;
        }
        break;
      default:
        break;
    }

    if (this.state === GAME_STATE.DRIVING) {
      this.pause();
      return;
    }
    this.ui.showOnly('main');
    this.ui.refreshAll();
  }

  async _confirmResetProgress() {
    const confirmed = await this.ui.confirm({
      title: 'Reset all progress?',
      body: 'This deletes unlocked vehicles, challenge records and discovered locations on this browser. Settings are kept.',
      confirmLabel: 'Reset progress',
    });
    if (!confirmed) return;
    await this.saves.reset();
    this.ui.refreshAll();
    this.ui.setStatus('Progress reset');
    this.hud.toast('Progress reset', 2.4);
  }

  /** Swap the showcase vehicle without rebuilding the world. */
  async _swapVehicle(vehicleId, paintId = null) {
    const definition = getVehicleDefinition(vehicleId);
    if (!definition || !this.world) return;

    // Capture the pose *before* tearing anything down, otherwise the heading and
    // position we want to restore belong to an object that no longer exists.
    const previousPose = this.vehicle
      ? this.vehicle.position()
      : this.world.resolveSpawn(this.currentSpawnId);
    const heading = this.vehicle ? this.camera._headingOf(this.vehicle.object3D) : 0;

    this._teardownPlayable();
    this._createVehicle(
      definition,
      { x: previousPose.x, y: previousPose.y + 0.4, z: previousPose.z, heading },
      paintId ?? definition.paint.default,
    );
    this.currentPaintId = paintId ?? definition.paint.default;
  }

  _previewVehicle(vehicleId, paintId = null) {
    if (!this.vehicle) return;
    const definition = getVehicleDefinition(vehicleId);
    if (!definition) return;
    // Recolour in place when the shape is the same; otherwise swap the model.
    if (this.vehicle.definition.id === vehicleId) {
      this.vehicle.setPaint(resolvePaint(paintId ?? definition.paint.default).hex);
      return;
    }
    void this._swapVehicle(vehicleId, paintId).then(() => {
      this.showcase = true;
      this.camera.setMode('cinematic');
    });
  }

  getState() {
    return {
      maps: MAPS,
      challenges: CHALLENGES.map((challenge) => ({
        id: challenge.id,
        name: challenge.name,
        description: challenge.description,
        type: challenge.type,
        mapId: challenge.mapId,
        mapName: challenge.mapName,
        timeLimit: challenge.timeLimit,
      })),
      vehicles: VEHICLES,
      progress: this.saves.values,
      settings: this.settings.values,
      currentMapId: this.currentMapId,
      currentVehicleId: this.currentVehicleId,
    };
  }

  /* --------------------------------- events -------------------------------- */

  _wireBus() {
    this.bus.on('mission:checkpoint', ({ index, total }) => {
      this.audio.ui('checkpoint');
      this.hud.toast(`Gate ${index} / ${total}`, 1.2);
    });

    this.bus.on('mission:landmark', ({ landmark }) => {
      this.audio.ui('checkpoint');
      this.hud.toast(`Discovered: ${landmark.name}`, 3);
      this.saves.discover(landmark.id);
    });

    this.bus.on(
      'mission:completed',
      ({ challenge, timeSeconds, score, brakingDistance, reward }) => {
        const summary = this.saves.recordChallenge(challenge.id, {
          completed: true,
          timeSeconds,
          score,
        });
        this.audio.ui('unlock');
        this.hud.setObjective(null);
        // The braking test's interesting number is the distance, not the clock,
        // so it is reported in metres instead of a time.
        const headline = Number.isFinite(brakingDistance)
          ? `${Math.round(brakingDistance)} m to stop`
          : Number.isFinite(timeSeconds)
            ? `Time ${formatTime(timeSeconds)}`
            : '';
        this.hud.toast(`${challenge.name} complete! ${headline} Score ${score}`, 5);
        if (reward?.vehicleId) {
          const wasLocked = !this.saves.values.unlockedVehicles.includes(reward.vehicleId);
          this.saves.unlock(reward.vehicleId);
          if (wasLocked) this.hud.toast(reward.label ?? 'New vehicle unlocked', 5);
        }
        if (summary?.newTimeRecord) this.hud.toast('New personal best!', 4);
        this._lastChallengeId = challenge.id;
        this.ui.refreshAll();
      },
    );

    this.bus.on('mission:failed', ({ challenge, reason }) => {
      this.audio.ui('error');
      this.hud.toast(`${challenge.name} failed — ${reason}. Press R to restart.`, 5);
      this.saves.recordChallenge(challenge.id, { completed: false });
      this._lastChallengeId = challenge.id;
    });

    // Discover landmarks in free roam too, not only during a mission.
    this.bus.on('game:landmark', ({ landmark }) => {
      this.hud.toast(`Discovered: ${landmark.name}`, 3);
    });
  }

  _wireWindowEvents() {
    this.canvas.addEventListener('click', () => {
      if (this.state === GAME_STATE.DRIVING && !this.input.pointerLocked) {
        this.input.requestPointerLock();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === GAME_STATE.DRIVING) this.pause();
        this.audio.suspend();
      } else if (this.state === GAME_STATE.DRIVING) {
        this.audio.resume();
      }
    });

    window.addEventListener('beforeunload', () => {
      this._flushProgress();
    });

    // A lost WebGL context (driver reset, GPU power event) must not leave the
    // player staring at a frozen canvas with no explanation.
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this._contextLostHandled = true;
      this.loop.setPaused(true);
      this.ui.showFatalError(
        'Graphics context lost',
        'The browser released the GPU context. Reload the page to continue.',
      );
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      if (this._contextLostHandled) window.location.reload();
    });
  }

  _armAudioUnlock() {
    if (this._unlockAudioOnce) return;
    this._unlockAudioOnce = () => {
      void this.audio.unlock().then(() => {
        this.audio.applySettings(this.settings.values);
        this.audio.setEngineProfile(getVehicleDefinition(this.currentVehicleId)?.audio);
        this.audio.setAmbience(this.world?.map.ambience ?? 'forest');
      });
      window.removeEventListener('pointerdown', this._unlockAudioOnce);
      window.removeEventListener('keydown', this._unlockAudioOnce);
      this._unlockAudioOnce = null;
    };
    window.addEventListener('pointerdown', this._unlockAudioOnce, { once: false });
    window.addEventListener('keydown', this._unlockAudioOnce, { once: false });
  }

  _installCollisionFeedback(vehicle) {
    this._collisionUnsubscribe = this.physics.onCollision((h1, h2, started) => {
      if (!started) return;
      const involvesPlayer = this.physics.isPlayerCollider(h1) || this.physics.isPlayerCollider(h2);
      if (!involvesPlayer) return;
      const loss = vehicle.telemetry.lastImpact ?? 0;
      if (loss > 3) {
        this._impactQueue = Math.min(1.4, this._impactQueue + loss / 24);
        this._impactPoint = this._approximateContactPoint(h1, h2, vehicle);
      }
    });
  }

  /**
   * Where to put impact debris.
   *
   * Rapier's collision events carry collider handles, not contact points. The
   * other body's origin is a decent stand-in — except for the terrain and road
   * colliders, whose origins sit at the map centre, so anything further than a
   * few metres from the car is rejected in favour of the car itself.
   */
  _approximateContactPoint(h1, h2, vehicle) {
    const carPosition = vehicle.position();
    const otherHandle = this.physics.isPlayerCollider(h1) ? h2 : h1;
    const other = this.physics.colliderPosition(otherHandle);
    if (!other) return { ...carPosition };
    if (Math.hypot(other.x - carPosition.x, other.z - carPosition.z) > 12) {
      return { ...carPosition };
    }
    return {
      x: (other.x + carPosition.x) / 2,
      y: (other.y + carPosition.y) / 2,
      z: (other.z + carPosition.z) / 2,
    };
  }

  _flushProgress() {
    void this.saves.flush();
    this.settings.flush();
  }

  /* ------------------------------ fixed update ------------------------------ */

  update(dt) {
    if (this.state !== GAME_STATE.DRIVING || !this.vehicle || !this.world) return;

    const input = this.input.sample(dt);
    this._handleOneShotActions(input);

    // Wet grip is a property of the surface under the car, not of the car, so it
    // is pushed in before the step that reads it.
    this.vehicle.gripMultiplier = this.weather.gripMultiplier(this.vehicle.telemetry.onSurface);

    // Player vehicle then the world.
    this.vehicle.step(dt, input);
    this.traffic?.update(dt, this.vehicle.position());
    this.physics.step(dt);

    // Read the wheels *after* the step, so marks and dust land where the tyres
    // actually are this frame.
    this.effects.update(dt, { vehicle: this.vehicle, weather: this.weather });

    const telemetry = this.vehicle.telemetry;

    // Collision feedback decayed over time rather than per-event, so a scrape
    // produces one noticeable jolt instead of a machine-gun of them.
    if (this._impactQueue > 0) {
      const amount = this._impactQueue;
      this._impactQueue = Math.max(0, this._impactQueue - dt * 3.2);
      if (amount > 0.35) {
        this.audio.impact(clamp(amount, 0, 1));
        this.camera.addShake(amount * 0.35);
        if (this._impactPoint) {
          this.effects.impact(this._impactPoint, clamp(amount, 0, 1));
          this._impactPoint = null;
        }
      }
    }

    // Suspension thumps when a wheel lands hard.
    const hardestLanding = Math.max(
      ...this.vehicle.wheelStates.map((wheel) => wheel.suspensionForce / 24000),
      0,
    );
    if (hardestLanding > 0.85) this.audio.suspensionHit(hardestLanding - 0.85);

    // Playtime accounting: accumulate and persist every 30 seconds, never per frame.
    this._playtimeAccumulator += dt;
    if (this._playtimeAccumulator >= 30) {
      this.saves.addPlaytime(this._playtimeAccumulator);
      this._playtimeAccumulator = 0;
    }

    // Mission progress
    if (this.mission) {
      const position = this.vehicle.position();
      this.mission.update(dt, {
        position,
        speedKmh: telemetry.speedKmh,
        onSurface: telemetry.onSurface,
        damage: telemetry.damage,
      });
      if (this.mission.status === MISSION_STATUS.RUNNING) {
        this.hud.setObjective(this.mission.challenge.name, this.mission.objectiveText());
      }
    }

    // Free-roam landmark discovery.
    if (!this.mission) {
      const position = this.vehicle.position();
      const landmark = this.world.landmarkNear(position, 60);
      if (landmark && !this.saves.values.discoveredLocations.includes(landmark.id)) {
        this.saves.discover(landmark.id);
        this.bus.emit('game:landmark', { landmark });
      }
    }

    this._updateWorldStreaming();
    this._updateAudio(dt, telemetry);
    this._checkServices(dt);
  }

  /**
   * Free repairs at the garages and recovery points the maps declare.
   *
   * The car has to be essentially stopped: driving past a garage at speed must
   * not silently undo the damage the player just collected.
   */
  _checkServices(dt) {
    this._serviceCooldown = Math.max(0, this._serviceCooldown - dt);
    if (!this.vehicle || !this.world?.services?.length) return;
    const telemetry = this.vehicle.telemetry;
    if (telemetry.damage < 1) return;
    if (telemetry.speedKmh > 5) return;
    if (this._serviceCooldown > 0) return;

    const service = this.world.serviceNear(this.vehicle.position(), SERVICE_RADIUS);
    if (!service) return;

    this.vehicle.repair();
    this._serviceCooldown = 6;
    this.audio.ui('confirm');
    this.hud.toast(`Repaired at ${service.name}`, 2.6);
  }

  _handleOneShotActions(input) {
    if (input.toggleCamera) {
      const label = this.camera.cycle();
      this.hud.toast(`Camera: ${label}`, 1.2);
    }
    if (input.recover) {
      this.vehicle.recover();
      this.hud.toast('Vehicle recovered', 1.6);
    }
    if (input.toggleHeadlights) {
      this.vehicle.headlightsOn = !this.vehicle.headlightsOn;
      setHeadlightGlow(this.vehicle.object3D, this.vehicle.headlightsOn);
      this.hud.toast(`Headlights ${this.vehicle.headlightsOn ? 'on' : 'off'}`, 1.2);
    }
  }

  /**
   * Keys that toggle a setting must fire on the *edge*, not while held — reading
   * `input.pressed` per frame would flip the value 60 times a second.
   */
  _wireEdgeTriggeredKeys() {
    this.input.addKeyListener('keydown', (event) => {
      if (this.state !== GAME_STATE.DRIVING || event.repeat) return;
      const bindings = this.settings.get('bindings') ?? {};
      if ((bindings.toggleGuide ?? []).includes(event.code)) {
        const next = !this.settings.get('showControlGuide');
        this.settings.set('showControlGuide', next);
        this.ui.setControlsGuideVisible(next);
      }
      if ((bindings.togglePerf ?? []).includes(event.code)) {
        this.settings.set('showFps', !this.settings.get('showFps'));
      }
      if ((bindings.toggleDrift ?? []).includes(event.code)) this._toggleDriftMode();
      // Pause is a configurable binding, not a hard-coded key: Escape resets to
      // the browser's own meaning in fullscreen, so players need to be able to
      // move it. The UI manager deliberately ignores Escape while driving, so
      // this is the only place the in-game pause key is handled.
      if ((bindings.pause ?? []).includes(event.code)) {
        this.pause();
      }
    });
  }

  _toggleDriftMode() {
    this.driftMode = !this.driftMode;
    this.vehicle?.setDriftMode(this.driftMode);
    this.hud.setDriftMode(this.driftMode);
    this.hud.toast(`Drift mode ${this.driftMode ? 'on' : 'off'}`, 1.6);
  }

  _updateWorldStreaming() {
    if (!this.world || !this.vehicle) return;
    const viewDistance = this.settings.get('viewDistance');
    this.world.update(this.vehicle.position(), {
      loadDistance: Math.max(250, viewDistance * 0.6),
    });
  }

  _updateAudio(dt, telemetry) {
    if (!this.audio.ready) return;
    const definition = this.vehicle.definition;
    // Only re-send the engine profile when the vehicle actually changes; the
    // audio engine spreads the object and there is no reason to do that per frame.
    if (this._audioProfileId !== definition.id) {
      this._audioProfileId = definition.id;
      this.audio.setEngineProfile(definition.audio);
    }
    this.audio.update(dt, telemetry, { preset: this.settings.get('preset') });
    // Rain is a weather property, not a vehicle one, so it is driven from the
    // sky rather than from telemetry.
    this.audio.setRain(this.weather.profile.rain);

    // Brake lights follow the brake input.
    setBrakeLights(this.vehicle.object3D, telemetry.brake);

    // Positional traffic voices, limited on low presets.
    this._trafficVoices = this._trafficVoices ?? [];
    const snapshots = this.traffic?.audioSnapshots() ?? [];
    const budget = this.settings.get('preset') === 'high' ? 6 : 3;
    for (let i = 0; i < Math.min(snapshots.length, budget); i++) {
      const snapshot = snapshots[i];
      if (!this._trafficVoices.includes(snapshot.id)) {
        const handle = this.audio.attachPositionalVehicle(
          snapshot.id,
          snapshot.definition?.audio ?? {},
        );
        if (handle) this._trafficVoices.push(snapshot.id);
      }
      this.audio.updatePositionalVehicle(snapshot.id, {
        position: snapshot.position,
        rpm: snapshot.rpm,
        load: snapshot.load,
      });
    }

    this.audio.updateListener(this.renderer.camera.position, this.renderer.camera.quaternion);
  }

  /* -------------------------------- render --------------------------------- */

  /**
   * Presentation tick.
   *
   * @param {number} alpha Fraction of the current fixed simulation step that has
   *   already elapsed. The simulation runs at a fixed 60 Hz while rendering runs
   *   at whatever the display manages, so the two clocks drift in and out of
   *   phase; passing `alpha` down to the vehicle is what keeps the car's motion
   *   smooth on a 120 Hz panel instead of snapping between step poses.
   * @param {number} dt Real time since the previous rendered frame.
   */
  render(alpha, dt) {
    if (!this.vehicle || !this.world) {
      this.renderer.render();
      return;
    }

    if (this.state === GAME_STATE.DRIVING) {
      this.camera.update(dt, {
        vehicleObject: this.vehicle.object3D,
        vehicleDefinition: this.vehicle.definition,
        telemetry: this.vehicle.telemetry,
      });
    } else if (this.state === GAME_STATE.MENU || this.state === GAME_STATE.LOADING) {
      this.camera.updateOrbit(dt, this.vehicle.object3D, { distance: 9.5, height: 3.6 });
    }

    if (!this.environment || this.environment.map !== this.world.map) {
      this.environment?.dispose();
      this.environment = new Environment({
        scene: this.renderer.scene,
        map: this.world.map,
        settings: this.settings.values,
        // Carried across map changes so switching maps does not reset the clock.
        hour: this.clockHour,
      });
      this.audio.setAmbience(this.world.map.ambience);
    }

    const weatherEvents = this.weather.update(dt, this.renderer.camera.position);
    if (weatherEvents.thunder) this.audio.thunder();
    this.environment.update(this.renderer.camera.position, {
      dt,
      weather: this.weather,
      flash: weatherEvents.flash,
    });
    this.clockHour = this.environment.hour;
    this.world.roads?.setWetness(this.weather.wetness);

    if (this.state === GAME_STATE.DRIVING) {
      this.vehicle.syncVisual(alpha);
      const position = this.vehicle.position();
      const markers = this.mission ? this.mission.minimapMarkers() : [];
      this.hud.setMarkers(markers);
      this.hud.update(dt, this.vehicle.telemetry, {
        position,
        // The minimap is north-up, so it always needs the car's own heading —
        // not whichever direction the camera happens to be facing.
        heading: this._vehicleHeading(),
        stats: this.renderer.getStats(),
        showPerf: this.settings.get('showFps'),
        preset: this.settings.get('preset'),
        clock: this.environment.clock,
        weather: this.weather.profile.label,
        grip: this.vehicle.gripMultiplier,
        perfData: {
          ...this.loop.stats,
          colliders: this.physics.colliderCount(),
          props: this.world.props?.stats.loadedProps ?? 0,
          chunks: this.world.props?.stats.loadedChunks ?? 0,
          particles: this.effects.liveParticles,
          backend: 'webgl',
        },
      });
    }

    this.renderer.render();
  }

  _vehicleHeading() {
    return this.camera._headingOf(this.vehicle.object3D);
  }

  /* -------------------------------- teardown ------------------------------- */

  dispose() {
    this._flushProgress();
    this.loop.stop();
    this.input.detach();
    this._teardownPlayable();
    this.effects.dispose();
    this.weather.dispose();
    if (this._unlockAudioOnce) {
      window.removeEventListener('pointerdown', this._unlockAudioOnce);
      window.removeEventListener('keydown', this._unlockAudioOnce);
    }
    this.environment?.dispose();
    this.world?.dispose();
    this.audio.dispose();
    this.renderer.dispose();
    this.physics.dispose();
    void this.saves.close();
  }
}

export { nextFrame };
