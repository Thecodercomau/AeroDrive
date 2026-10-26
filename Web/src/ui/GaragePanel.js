import { VEHICLES, VEHICLE_UNLOCK_RULES } from '../vehicles/definitions.js';
import { PAINTS } from '../vehicles/paints.js';
import { escapeHtml } from './UIManager.js';

/**
 * Garage: choose a vehicle, read its spec sheet, change its paint.
 *
 * Renders only inside its own screen. Locked vehicles are shown but disabled
 * with the unlock requirement visible, so the player can see what is available
 * rather than being left to guess why a car is missing.
 */
export class GaragePanel {
  constructor({ actions, audio, document: doc }) {
    this.actions = actions;
    this.audio = audio;
    this.doc = doc;
    this.list = doc.getElementById('garage-list');
    this.name = doc.getElementById('garage-name');
    this.klass = doc.getElementById('garage-class');
    this.specs = doc.getElementById('garage-specs');
    this.paints = doc.getElementById('garage-paints');

    /** Currently previewed vehicle (may differ from the saved selection). */
    this.previewId = null;
    this.previewPaint = null;
  }

  refresh() {
    const { progress } = this.actions.getState();
    const unlocked = new Set(progress?.unlockedVehicles ?? []);
    const selected = progress?.selectedVehicle ?? VEHICLES[0].id;

    if (!this.previewId || !unlocked.has(this.previewId)) {
      this.previewId = unlocked.has(selected) ? selected : VEHICLES[0].id;
    }
    this.previewPaint = progress?.selectedPaints?.[this.previewId] ?? null;

    this.list.innerHTML = '';
    for (const vehicle of VEHICLES) {
      const isUnlocked = unlocked.has(vehicle.id);
      const rule = VEHICLE_UNLOCK_RULES[vehicle.id];
      const item = this.doc.createElement('li');
      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'vehicle-card';
      button.setAttribute('role', 'option');
      // Keeps the DOM self-describing: the selected card can be identified
      // without relying on its position in the list.
      button.dataset.vehicleId = vehicle.id;
      button.setAttribute('aria-selected', String(vehicle.id === this.previewId));
      if (!isUnlocked) button.disabled = true;
      button.innerHTML = `
        <span class="vehicle-card__name">${escapeHtml(vehicle.name)}</span>
        <span class="vehicle-card__meta">${escapeHtml(vehicle.klass)} · ${vehicle.stats.powerHp} hp · ${vehicle.stats.topSpeedKmh} km/h</span>
        ${isUnlocked ? '' : `<span class="vehicle-card__meta">🔒 ${escapeHtml(rule?.label ?? 'Locked')}</span>`}`;

      button.addEventListener('click', () => {
        this.previewId = vehicle.id;
        this.previewPaint = this.actions.getState().progress?.selectedPaints?.[vehicle.id] ?? null;
        this.audio?.ui('move');
        this.refresh();
        this.actions.previewVehicle?.(vehicle.id, this.previewPaint);
      });

      item.appendChild(button);
      this.list.appendChild(item);
    }

    this._renderDetail();
  }

  _renderDetail() {
    const vehicle = VEHICLES.find((candidate) => candidate.id === this.previewId) ?? VEHICLES[0];
    const unlocked = new Set(this.actions.getState().progress?.unlockedVehicles ?? []);

    this.name.textContent = vehicle.name;
    this.klass.textContent = `${vehicle.klass} · ${vehicle.description}`;

    const drivetrainLabel =
      vehicle.drivetrain === 'awd'
        ? 'All-wheel drive'
        : vehicle.drivetrain === 'fwd'
          ? 'Front-wheel drive'
          : 'Rear-wheel drive';

    const rows = [
      ['Power', `${vehicle.stats.powerHp} hp`],
      ['Top speed', `${vehicle.stats.topSpeedKmh} km/h`],
      ['0–100 km/h', `${vehicle.stats.zeroTo100.toFixed(1)} s`],
      ['Mass', `${Math.round(vehicle.massKg)} kg`],
      ['Drivetrain', drivetrainLabel],
      ['Gears', `${vehicle.engine.forwardRatios.length}-speed automatic`],
      ['Redline', `${vehicle.engine.redlineRpm} rpm`],
      ['Wheelbase', `${vehicle.wheelbase.toFixed(2)} m`],
      ['Grip', vehicle.tyre.frictionSlip.toFixed(2)],
      ['Steering lock', `${vehicle.steering.maxAngleDeg}°`],
    ];
    this.specs.innerHTML = rows
      .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
      .join('');

    this.paints.innerHTML = '';
    for (const paintId of vehicle.paint.palette) {
      const paint = PAINTS[paintId];
      if (!paint) continue;
      const swatch = this.doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.title = paint.label;
      swatch.setAttribute('aria-label', `Paint: ${paint.label}`);
      swatch.setAttribute(
        'aria-pressed',
        String(paintId === (this.previewPaint ?? vehicle.paint.default)),
      );
      swatch.style.background = `#${paint.hex.toString(16).padStart(6, '0')}`;
      swatch.addEventListener('click', () => {
        this.previewPaint = paintId;
        this.audio?.ui('move');
        this.actions.setVehiclePaint(vehicle.id, paintId);
        this.refresh();
        this.actions.previewVehicle?.(vehicle.id, paintId);
      });
      this.paints.appendChild(swatch);
    }

    const driveButton = this.doc.querySelector('[data-action="drive-vehicle"]');
    if (driveButton) {
      driveButton.disabled = !unlocked.has(vehicle.id);
      driveButton.textContent = unlocked.has(vehicle.id)
        ? 'Drive this vehicle'
        : 'Locked — finish a challenge to unlock';
    }
  }

  /** The vehicle currently previewed in the garage. */
  get selection() {
    return { vehicleId: this.previewId, paintId: this.previewPaint };
  }
}
