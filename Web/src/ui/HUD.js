import { Minimap } from './minimap.js';
import { clamp, mapRange, MS_TO_KMH } from '../utilities/math.js';

/**
 * In-game HUD.
 *
 * Two rules keep this cheap:
 *  1. **Text is only written when the value changes.** `textContent` assignment
 *     on every frame is a surprisingly common source of layout thrash in browser
 *     games; here each field caches its last value.
 *  2. **The gauges redraw at ~20 Hz, not 60.** A needle moving at 60 Hz looks no
 *     better than one moving at 20 Hz, but costs three times as much.
 */

const SPEEDO_WIDTH = 12;
const MAX_KMH = 300;

export class HUD {
  /**
   * @param {object} options
   * @param {Document} [options.document]
   */
  constructor({ document: doc = globalThis.document } = {}) {
    this.doc = doc;
    this.root = doc.getElementById('hud');
    this.speedCanvas = doc.getElementById('speedometer');
    this.speedCtx = this.speedCanvas.getContext('2d');
    this.minimap = new Minimap(doc.getElementById('minimap'));

    this.elements = {
      speed: doc.getElementById('hud-speed'),
      gear: doc.getElementById('hud-gear'),
      rpm: doc.getElementById('hud-rpm'),
      damage: doc.getElementById('hud-damage'),
      location: doc.getElementById('hud-location'),
      clock: doc.getElementById('hud-clock'),
      weather: doc.getElementById('hud-weather'),
      grip: doc.getElementById('hud-grip'),
      objective: doc.getElementById('hud-objective'),
      objectiveTitle: doc.getElementById('hud-objective-title'),
      objectiveDetail: doc.getElementById('hud-objective-detail'),
      toast: doc.getElementById('hud-toast'),
      driftToggle: doc.getElementById('hud-drift-toggle'),
      offroad: doc.getElementById('offroad-hint'),
      perf: doc.getElementById('perf-overlay'),
      perfText: doc.getElementById('perf-text'),
    };

    this._cache = new Map();
    this._toastTimer = 0;
    this._hudAccumulator = 0;
    this._shownSpeed = 0;
    this._shownRpm = 0;
    this._beaconOn = false;
    this.visible = false;

    // The speedometer canvas is drawn at device resolution so the dial is crisp.
    const ratio = Math.min(doc.defaultView?.devicePixelRatio || 1, 2);
    this._speedRatio = ratio;
    this.speedCanvas.width = 220 * ratio;
    this.speedCanvas.height = 220 * ratio;
    this.speedCtx.scale(ratio, ratio);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this._setText('toast', '', true);
  }

  setWorld(world) {
    this.minimap.setWorld(world);
  }

  setMarkers(markers) {
    this.minimap.setMarkers(markers);
  }

  /** One-shot message, e.g. "New record" or "Discovered: Mirror Lake". */
  toast(message, durationSeconds = 3) {
    const element = this.elements.toast;
    element.textContent = message;
    element.dataset.visible = 'true';
    this._toastTimer = durationSeconds;
  }

  /** Show/hide the persistent objective banner. */
  setObjective(title, detail) {
    if (!title) {
      if (!this.elements.objective.hidden) this.elements.objective.hidden = true;
      return;
    }
    if (this.elements.objective.hidden) this.elements.objective.hidden = false;
    this._setText('objectiveTitle', title);
    this._setText('objectiveDetail', detail ?? '');
  }

  setLocation(name) {
    this._setText('location', name ?? '—');
  }

  setDriftMode(enabled) {
    const button = this.elements.driftToggle;
    if (!button) return;
    button.textContent = enabled ? 'Drift mode: On' : 'Drift mode: Off';
    button.setAttribute('aria-pressed', String(enabled));
  }

  /**
   * Update the HUD. Called every rendered frame, but internally rate-limits the
   * expensive parts.
   *
   * @param {number} dt Seconds since the last update.
   * @param {object} telemetry Vehicle telemetry
   * @param {object} options
   */
  update(
    dt,
    telemetry,
    {
      position,
      heading,
      stats = null,
      showPerf = false,
      perfData = null,
      preset = 'low',
      clock = null,
      weather = null,
      grip = 1,
    } = {},
  ) {
    if (!this.visible || !telemetry) return;

    // Smooth the displayed speed/RPM so the digits are readable rather than a
    // blur of changing numbers.
    this._shownSpeed += (telemetry.speedKmh - this._shownSpeed) * Math.min(1, dt * 12);
    this._shownRpm += (telemetry.rpm - this._shownRpm) * Math.min(1, dt * 14);

    this._setText('speed', String(Math.round(this._shownSpeed)));
    this._setText('gear', telemetry.gearLabel ?? 'N');
    this._setText('rpm', String(Math.round(this._shownRpm)));
    this._setText('damage', `${Math.round(telemetry.damage ?? 0)}%`);
    this.elements.damage.style.color =
      (telemetry.damage ?? 0) > 60 ? '#ef4444' : (telemetry.damage ?? 0) > 25 ? '#f5c518' : '';

    if (clock) this._setText('clock', clock);
    if (weather) this._setText('weather', weather);
    // Grip is only worth showing when it is not 100%: a persistent "100%" is
    // noise, a changing number is information.
    const gripPercent = Math.round(clamp(grip ?? 1, 0, 1) * 100);
    this._setText('grip', gripPercent >= 100 ? '—' : `${gripPercent}%`);
    this.elements.grip.style.color = gripPercent < 75 ? '#f5c518' : '';

    const offRoad = telemetry.onSurface === 'grass' || telemetry.onSurface === 'sand';
    if (offRoad !== this._beaconOn) {
      this._beaconOn = offRoad;
      this.elements.offroad.hidden = !offRoad;
    }

    this._toastTimer = Math.max(0, this._toastTimer - dt);
    if (this._toastTimer === 0 && this.elements.toast.dataset.visible === 'true') {
      this.elements.toast.dataset.visible = 'false';
    }

    // Gauges + minimap at ~20 Hz.
    this._hudAccumulator += dt;
    if (this._hudAccumulator >= 1 / 20) {
      this._hudAccumulator = 0;
      this._drawSpeedometer(this._shownSpeed, this._shownRpm, telemetry.damage ?? 0);
      if (position) this.minimap.render({ position, heading: heading ?? 0 });
    }

    // Performance overlay at ~4 Hz.
    if (showPerf) {
      this.elements.perf.hidden = false;
      this._perfTimer = (this._perfTimer ?? 0) + dt;
      if (this._perfTimer >= 0.25 && perfData) {
        this._perfTimer = 0;
        this.elements.perfText.textContent = [
          `fps        ${perfData.fps.toFixed(0)}`,
          `frame      ${perfData.frameMs.toFixed(1)} ms`,
          `sim        ${perfData.updateMs.toFixed(2)} ms`,
          `render     ${perfData.renderMs.toFixed(2)} ms`,
          `draw calls ${stats?.drawCalls ?? 0}`,
          `triangles  ${((stats?.triangles ?? 0) / 1000).toFixed(0)}k`,
          `geometries ${stats?.geometries ?? 0}`,
          `textures   ${stats?.textures ?? 0}`,
          `colliders  ${perfData.colliders ?? 0}`,
          `props      ${perfData.props ?? 0}`,
          `chunks     ${perfData.chunks ?? 0}`,
          `particles  ${perfData.particles ?? 0}`,
          `preset     ${preset}`,
          `backend    ${perfData.backend ?? 'webgl'}`,
        ].join('\n');
      }
    } else {
      // Per-frame speed/RPM are already handled above; everything else here only
      // runs when the overlay is on, so it costs nothing in normal play.
      this._perfTimer = 0;
      if (!this.elements.perf.hidden) this.elements.perf.hidden = true;
    }
  }

  _setText(key, value, force = false) {
    if (!force && this._cache.get(key) === value) return;
    this._cache.set(key, value);
    const element = this.elements[key];
    if (element) element.textContent = value;
  }

  /** Circular dial: speed arc, RPM arc, damage arc, digital speed. */
  _drawSpeedometer(speedKmh, rpm, damage) {
    const ctx = this.speedCtx;
    const size = 220;
    const centre = size / 2;
    const radius = centre - 18;
    ctx.clearRect(0, 0, size, size);

    const startAngle = Math.PI * 0.75;
    const endAngle = Math.PI * 2.25;
    const total = endAngle - startAngle;

    // Track
    ctx.lineWidth = SPEEDO_WIDTH;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(centre, centre, radius, startAngle, endAngle);
    ctx.stroke();

    // Speed arc
    const speedFraction = clamp(speedKmh / MAX_KMH, 0, 1);
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#ff5a1f');
    gradient.addColorStop(1, '#0ea5e9');
    ctx.strokeStyle = gradient;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(centre, centre, radius, startAngle, startAngle + total * speedFraction);
    ctx.stroke();

    // RPM ring (inner)
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(centre, centre, radius - 12, startAngle, endAngle);
    ctx.stroke();
    const rpmFraction = clamp(mapRange(rpm, 800, 8000, 0, 1), 0, 1);
    ctx.strokeStyle = rpmFraction > 0.86 ? '#ef4444' : 'rgba(245,197,24,0.9)';
    ctx.beginPath();
    ctx.arc(centre, centre, radius - 12, startAngle, startAngle + total * rpmFraction);
    ctx.stroke();

    // Damage arc (thin, outer)
    if (damage > 0.5) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(239,68,68,0.85)';
      ctx.beginPath();
      ctx.arc(
        centre,
        centre,
        radius + 10,
        startAngle,
        startAngle + total * clamp(damage / 100, 0, 1),
      );
      ctx.stroke();
    }

    // Ticks every 50 km/h.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(238,243,248,0.75)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let value = 0; value <= MAX_KMH; value += 50) {
      const angle = startAngle + total * (value / MAX_KMH);
      const inner = radius - 17;
      const outer = radius - 26;
      ctx.beginPath();
      ctx.moveTo(centre + Math.cos(angle) * inner, centre + Math.sin(angle) * inner);
      ctx.lineTo(centre + Math.cos(angle) * outer, centre + Math.sin(angle) * outer);
      ctx.stroke();
      ctx.fillText(
        String(value),
        centre + Math.cos(angle) * (radius - 40),
        centre + Math.sin(angle) * (radius - 40),
      );
    }
    ctx.lineWidth = SPEEDO_WIDTH;
  }

  /** Convert m/s to km/h for callers that only have raw velocity. */
  static toKmh(metresPerSecond) {
    return metresPerSecond * MS_TO_KMH;
  }
}
