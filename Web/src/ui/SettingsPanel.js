import { QUALITY_PRESETS } from '../settings/settings.js';

/**
 * Settings screen.
 *
 * Every control is two-way bound to the `SettingsStore`: moving a slider writes
 * the setting (which persists and immediately reconfigures the engine), and
 * loading a preset writes every affected setting back into the UI. There is no
 * separate "apply" step, and no setting that only changes a label.
 *
 * Key rebinding listens on `window` with `capture: true` so it can claim the
 * keystroke before the game's input handler sees it.
 */

const BINDING_LABELS = {
  accelerate: 'Accelerate',
  brake: 'Brake / Reverse',
  steerLeft: 'Steer left',
  steerRight: 'Steer right',
  handbrake: 'Handbrake',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  camera: 'Change camera',
  recover: 'Recover vehicle',
  headlights: 'Headlights',
  toggleGuide: 'Toggle control guide',
  togglePerf: 'Performance overlay',
  toggleDrift: 'Toggle drift mode',
  horn: 'Horn',
};

const KEY_NAMES = {
  Space: 'Space',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
};

/** Human-readable key names for `KeyboardEvent.code` values. */
export function prettyKey(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return KEY_NAMES[code] ?? code;
}

export class SettingsPanel {
  constructor({ settings, audio, document: doc, onChange }) {
    this.settings = settings;
    this.audio = audio;
    this.doc = doc;
    this.onChange = onChange;
    this._listening = null;
    this._unbinders = [];

    this._wireControls();
    this._wireBindings();
  }

  /* ------------------------------- controls -------------------------------- */

  _wireControls() {
    const controls = [...this.doc.querySelectorAll('[data-setting]')];
    for (const control of controls) {
      const key = control.dataset.setting;

      const handler = () => {
        const value = this._readControl(control);
        this._applySetting(key, value);
      };

      control.addEventListener('input', handler);
      control.addEventListener('change', handler);
      this._unbinders.push(() => {
        control.removeEventListener('input', handler);
        control.removeEventListener('change', handler);
      });
    }

    // A preset change rewrites the graphics settings it owns.
    const presetSelect = this.doc.querySelector('[data-setting="preset"]');
    if (presetSelect) {
      presetSelect.addEventListener('change', () => {
        const preset = QUALITY_PRESETS[presetSelect.value];
        if (!preset) return;
        // The preset only owns graphics keys; audio and controls are preserved.
        this.settings.patch({ ...preset, preset: presetSelect.value });
        this.refresh();
        this.onChange?.(this.settings.values);
        this.audio?.ui('confirm');
      });
    }
  }

  _readControl(control) {
    if (control.type === 'checkbox') return control.checked;
    if (control.type === 'range') return Number(control.value);
    if (control.tagName === 'SELECT') {
      const raw = control.value;
      // Preset/enum values are strings; numeric selects (e.g. fps limit) are not.
      if (control.dataset.setting === 'fpsLimit') return Number(raw);
      return raw;
    }
    return control.value;
  }

  _applySetting(key, value) {
    this.settings.set(key, value);
    this._syncOutputs();
    this.onChange?.(this.settings.values);
  }

  /* ------------------------------ key bindings ----------------------------- */

  _wireBindings() {
    const container = this.doc.getElementById('bindings');
    if (!container) return;
    container.innerHTML = '';

    for (const action of Object.keys(BINDING_LABELS)) {
      const row = this.doc.createElement('div');
      row.className = 'binding';

      const label = this.doc.createElement('span');
      label.textContent = BINDING_LABELS[action];

      const button = this.doc.createElement('button');
      button.type = 'button';
      button.className = 'binding__key';
      button.dataset.action = 'rebind';
      button.dataset.binding = action;
      button.textContent = this._bindingText(action);

      button.addEventListener('click', () => this._beginRebind(action, button));

      row.append(label, button);
      container.appendChild(row);
    }
  }

  _bindingText(action) {
    const codes = this.settings.get('bindings')?.[action] ?? [];
    return codes.map(prettyKey).join(' / ') || '—';
  }

  _beginRebind(action, button) {
    if (this._listening) this._cancelRebind();
    this._listening = { action, button, previous: button.textContent };
    button.dataset.listening = 'true';
    button.textContent = 'Press a key…';
    this.audio?.ui('move');

    this._rebindHandler = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        this._cancelRebind();
        return;
      }
      // Ignore bare modifier presses; they are almost never intended bindings.
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;

      const bindings = { ...(this.settings.get('bindings') ?? {}) };
      const existing = bindings[action] ?? [];

      // Remove this key from every other action so one key cannot do two things.
      for (const other of Object.keys(bindings)) {
        if (other === action) continue;
        bindings[other] = bindings[other].filter((code) => code !== event.code);
      }

      // Primary binding is replaced; the previous primary becomes the secondary
      // alternative (this is what keeps arrow keys *and* WASD working).
      const next = [event.code, ...existing.filter((code) => code !== event.code)].slice(0, 2);
      bindings[action] = next;

      this.settings.set('bindings', bindings);
      this._endRebind();
      this.onChange?.(this.settings.values);
    };

    window.addEventListener('keydown', this._rebindHandler, { capture: true });
  }

  _cancelRebind() {
    if (this._listening) {
      this._listening.button.textContent = this._listening.previous;
      delete this._listening.button.dataset.listening;
    }
    this._endRebind();
  }

  _endRebind() {
    if (this._rebindHandler) {
      window.removeEventListener('keydown', this._rebindHandler, { capture: true });
      this._rebindHandler = null;
    }
    this._listening = null;
    // Re-render so every row reflects the new binding map.
    this._wireBindings();
    this.audio?.ui('confirm');
  }

  /* --------------------------------- state --------------------------------- */

  /** Pull every value out of the store and into the DOM. */
  refresh() {
    const values = this.settings.values;
    for (const control of this.doc.querySelectorAll('[data-setting]')) {
      const key = control.dataset.setting;
      const value = values[key];
      if (value === undefined) continue;
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = String(value);
    }
    this._wireBindings();
    this._syncOutputs();
  }

  /** Write range values into their `<output>` labels. */
  _syncOutputs() {
    for (const output of this.doc.querySelectorAll('[data-output]')) {
      const key = output.dataset.output;
      const raw = this.settings.get(key);
      const value = typeof raw === 'number' ? Math.round(raw * 100) / 100 : raw;
      output.textContent = String(value ?? '—');
    }
  }

  /** Late-bound so the panel does not need a hard dependency on Game. */
  setActions(actions) {
    this.actions = actions;
    const progress = actions?.getState?.()?.progress;
    const summary = this.doc.getElementById('progress-summary');
    if (summary && progress) {
      const completed = Object.values(progress.challenges ?? {}).filter((c) => c.completed).length;
      const minutes = Math.floor((progress.playtimeSeconds ?? 0) / 60);
      summary.textContent =
        `${progress.unlockedVehicles?.length ?? 0} vehicles unlocked · ` +
        `${completed} challenges completed · ` +
        `${progress.discoveredLocations?.length ?? 0} locations discovered · ` +
        `${minutes} minutes played`;
    }
  }

  dispose() {
    for (const unbind of this._unbinders) unbind();
    this._unbinders.length = 0;
    this._cancelRebind();
  }
}
