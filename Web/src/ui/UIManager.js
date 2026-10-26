import { GaragePanel } from './GaragePanel.js';
import { SettingsPanel } from './SettingsPanel.js';
import { WorldMap } from './worldmap.js';

/**
 * Screen flow and menu input.
 *
 * The DOM is static markup in `index.html`; this class only shows, hides and
 * populates it. That keeps the interface accessible (real buttons, real focus,
 * real tab order) and keeps the 3D render loop completely unaware of menus.
 *
 * Keyboard navigation is implemented explicitly (arrow keys move focus, Escape
 * goes back) rather than relying on the browser default, because a game menu is
 * expected to be fully playable from a controller/keyboard without a mouse.
 */

const SCREENS = {
  loading: 'loading-screen',
  main: 'screen-main',
  garage: 'screen-garage',
  maps: 'screen-maps',
  worldmap: 'screen-worldmap',
  challenges: 'screen-challenges',
  settings: 'screen-settings',
  credits: 'screen-credits',
  pause: 'screen-pause',
  confirm: 'screen-confirm',
};

export class UIManager {
  /**
   * @param {object} options
   * @param {object} options.actions Game action facade.
   * @param {import('../settings/SettingsStore.js').SettingsStore} options.settings
   * @param {import('../audio/AudioEngine.js').AudioEngine} options.audio
   */
  constructor({ actions, settings, audio }) {
    this.actions = actions;
    this.settings = settings;
    this.audio = audio;
    this.doc = globalThis.document;

    this.elements = {};
    for (const [key, id] of Object.entries(SCREENS)) {
      this.elements[key] = this.doc.getElementById(id);
    }
    this.canvas = this.doc.getElementById('game-canvas');
    this.controlsGuide = this.doc.getElementById('controls-guide');
    this.loadingLabel = this.doc.getElementById('loading-label');
    this.loadingBar = this.doc.getElementById('loading-bar');
    this.loadingHint = this.doc.getElementById('loading-hint');
    this.menuStatus = this.doc.getElementById('menu-status');

    this.current = 'loading';
    this.visible = new Set(['loading']);
    this._confirmResolve = null;
    this._persistentStatus = '';
    this._statusTimer = 0;

    this.garage = new GaragePanel({
      actions,
      audio,
      document: this.doc,
    });
    this.worldmap = new WorldMap(this.doc.getElementById('worldmap-canvas'));
    this.settingsPanel = new SettingsPanel({
      settings,
      audio,
      document: this.doc,
      onChange: (settings) => this.actions.applySettings?.(settings),
    });

    this._wireActions();
    this._wireKeyboard();
  }

  /**
   * Show a status message on the main menu (e.g. save warnings).
   *
   * A *transient* message is shown and then the previous persistent message is
   * restored. Without that, the "progress saved" notification — which fires on
   * an 800 ms debounce — silently replaced "Alpine Valley loaded" about a second
   * after the menu appeared, and left it that way for the rest of the session.
   *
   * @param {string} message
   * @param {object} [options]
   * @param {boolean} [options.transient] Restore the previous message afterwards.
   * @param {number} [options.seconds] How long a transient message stays up.
   */
  setStatus(message, { transient = false, seconds = 2.5 } = {}) {
    if (this._statusTimer) {
      clearTimeout(this._statusTimer);
      this._statusTimer = 0;
    }
    if (!transient) {
      this._persistentStatus = message ?? '';
      this._renderStatus();
      return;
    }
    this._renderStatus(message);
    this._statusTimer = setTimeout(
      () => {
        this._statusTimer = 0;
        this._renderStatus();
      },
      Math.max(0.2, seconds) * 1000,
    );
  }

  _renderStatus(override = null) {
    if (!this.menuStatus) return;
    this.menuStatus.textContent = override ?? this._persistentStatus ?? '';
  }

  /* -------------------------------- screens -------------------------------- */

  showOnly(key) {
    for (const [name, element] of Object.entries(this.elements)) {
      if (!element) continue;
      const shouldShow = name === key;
      if (shouldShow) element.hidden = false;
      else element.hidden = true;
    }
    this.current = key;
    if (key) this._focusFirst(key);
  }

  hideAll() {
    for (const element of Object.values(this.elements)) {
      if (element) element.hidden = true;
    }
    this.current = null;
  }

  /** Loading screen progress. */
  setLoading(label, fraction = null, hint = '') {
    if (this.loadingLabel && label) this.loadingLabel.textContent = label;
    if (this.loadingBar && fraction !== null) {
      this.loadingBar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    }
    if (this.loadingHint) this.loadingHint.textContent = hint ?? '';
  }

  /** Show an unrecoverable startup error in place of the loading bar. */
  showFatalError(message, detail = '') {
    this.elements.loading.hidden = false;
    if (this.loadingLabel) this.loadingLabel.textContent = message;
    if (this.loadingHint) this.loadingHint.textContent = detail;
    if (this.loadingBar) this.loadingBar.style.width = '0%';
  }

  setControlsGuideVisible(visible) {
    if (this.controlsGuide) this.controlsGuide.hidden = !visible;
  }

  /* ------------------------------- confirm --------------------------------- */

  /**
   * Modal confirmation. Resolves to true/false.
   * @returns {Promise<boolean>}
   */
  confirm({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm' } = {}) {
    const titleElement = this.doc.getElementById('confirm-title');
    const bodyElement = this.doc.getElementById('confirm-body');
    const yes = this.doc.querySelector('[data-action="confirm-yes"]');
    if (titleElement) titleElement.textContent = title;
    if (bodyElement) bodyElement.textContent = body;
    if (yes && confirmLabel) yes.textContent = confirmLabel;

    this._confirmReturnScreen = this.current;
    this.elements.confirm.hidden = false;
    this.current = 'confirm';
    this._focusFirst('confirm');

    return new Promise((resolve) => {
      this._confirmResolve = resolve;
    });
  }

  _resolveConfirm(value) {
    if (this.elements.confirm) this.elements.confirm.hidden = true;
    this.audio?.ui(value ? 'confirm' : 'back');
    const resolve = this._confirmResolve;
    this._confirmResolve = null;
    if (resolve) resolve(value);
    // Return to whichever screen asked the question.
    if (this._confirmReturnScreen && this.elements[this._confirmReturnScreen]) {
      this.elements[this._confirmReturnScreen].hidden = false;
      this.current = this._confirmReturnScreen;
    }
  }

  /* ------------------------------ menu lists ------------------------------- */

  refreshGarage() {
    this.garage.refresh();
  }

  refreshMaps() {
    const list = this.doc.getElementById('maps-list');
    if (!list) return;
    const { maps, currentMapId, progress } = this.actions.getState();
    list.innerHTML = '';
    for (const map of maps) {
      const item = this.doc.createElement('li');
      const button = this.doc.createElement('button');
      button.className = 'card';
      button.type = 'button';
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(map.id === currentMapId));
      button.innerHTML = `
        <span class="card__title">${escapeHtml(map.name)}</span>
        <span class="card__desc">${escapeHtml(map.tagline ?? '')}</span>
        <span class="card__meta">
          <span class="chip">${escapeHtml(map.terrain.style)}</span>
          <span class="chip">${map.buildRoads().length} roads</span>
          ${map.id === currentMapId ? '<span class="chip chip--done">current map</span>' : ''}
          ${progress?.visitedMaps?.includes(map.id) ? '<span class="chip chip--done">visited</span>' : ''}
        </span>`;
      button.addEventListener('click', () => {
        this.audio?.ui('confirm');
        this.actions.selectMap(map.id);
      });
      item.appendChild(button);
      list.appendChild(item);
    }
  }

  /**
   * Draw the world map and its side panel.
   *
   * Everything shown is read from the *live* built world through the actions
   * facade, so the map cannot disagree with the terrain the player is driving on.
   */
  refreshWorldMap() {
    const data = this.actions.getWorldMapData?.();
    const title = this.doc.getElementById('worldmap-title');
    const name = this.doc.getElementById('worldmap-map-name');
    const summary = this.doc.getElementById('worldmap-summary');
    const legend = this.doc.getElementById('worldmap-legend');
    const locations = this.doc.getElementById('worldmap-locations');

    if (!data) {
      this.worldmap.setData(null).render();
      if (name) name.textContent = 'No world loaded';
      if (summary) summary.textContent = '';
      if (legend) legend.innerHTML = '';
      if (locations) locations.innerHTML = '';
      return;
    }

    this.worldmap.setData(data).render();
    if (title) title.textContent = data.name ?? 'World map';
    if (name) name.textContent = data.name ?? '—';
    if (summary) {
      summary.textContent =
        `${data.roads.length} roads · ${data.landmarks.length} locations · ` +
        `${data.services.length} services`;
    }

    if (legend) {
      legend.innerHTML = '';
      const entries = [
        ['#ffd166', 'Landmark, undiscovered'],
        ['rgba(34,197,94,0.9)', 'Landmark, discovered'],
        ['#38bdf8', 'Garage — free repair'],
        ['#f59e0b', 'Fuel stop'],
        ['#a78bfa', 'Recovery point'],
        ['#ff5a1f', 'You are here'],
      ];
      for (const [colour, text] of entries) {
        const item = this.doc.createElement('li');
        const swatch = this.doc.createElement('span');
        swatch.className = 'legend__swatch';
        swatch.style.background = colour;
        item.append(swatch, this.doc.createTextNode(text));
        legend.appendChild(item);
      }
    }

    if (locations) {
      locations.innerHTML = '';
      const discovered = new Set(data.discovered ?? []);
      const position = data.position;
      const rows = [
        ...data.services.map((service) => ({
          name: service.name,
          x: service.x,
          z: service.z,
          kind: service.type,
        })),
        ...data.landmarks.map((landmark) => ({
          name: landmark.name,
          x: landmark.x,
          z: landmark.z,
          kind: discovered.has(landmark.id) ? 'found' : 'landmark',
        })),
      ];
      if (position) {
        rows.sort(
          (a, b) =>
            Math.hypot(a.x - position.x, a.z - position.z) -
            Math.hypot(b.x - position.x, b.z - position.z),
        );
      }
      for (const row of rows) {
        const item = this.doc.createElement('li');
        const distance = position
          ? `${(Math.hypot(row.x - position.x, row.z - position.z) / 1000).toFixed(1)} km`
          : '';
        item.innerHTML =
          `<span class="legend__kind">${escapeHtml(row.kind)}</span>` +
          `<span class="legend__name">${escapeHtml(row.name)}</span>` +
          `<span class="legend__distance">${escapeHtml(distance)}</span>`;
        locations.appendChild(item);
      }
    }
  }

  refreshChallenges() {
    const list = this.doc.getElementById('challenges-list');
    if (!list) return;
    const { challenges, progress } = this.actions.getState();
    list.innerHTML = '';
    for (const challenge of challenges) {
      const record = progress?.challenges?.[challenge.id];
      const item = this.doc.createElement('li');
      const button = this.doc.createElement('button');
      button.className = 'card';
      button.type = 'button';
      button.setAttribute('role', 'option');
      const subtitle = challenge.description ?? '';
      button.innerHTML = `
        <span class="card__title">${escapeHtml(challenge.name)}</span>
        <span class="card__desc">${escapeHtml(subtitle)}</span>
        <span class="card__meta">
          <span class="chip">${escapeHtml(challenge.mapName ?? challenge.mapId)}</span>
          <span class="chip">${escapeHtml(challenge.type)}</span>
          ${record?.completed ? '<span class="chip chip--done">completed</span>' : ''}
          ${
            Number.isFinite(record?.bestTimeSeconds)
              ? `<span class="chip">best ${formatTime(record.bestTimeSeconds)}</span>`
              : ''
          }
        </span>`;
      button.addEventListener('click', () => {
        this.audio?.ui('confirm');
        this.actions.startChallenge(challenge.id);
      });
      item.appendChild(button);
      list.appendChild(item);
    }
  }

  /* --------------------------------- wiring -------------------------------- */

  _wireActions() {
    const handler = (event) => {
      const target = event.target.closest?.('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      this.audio?.ui(action === 'back' || action === 'confirm-no' ? 'back' : 'move');
      this._dispatch(action, target);
    };
    this.doc.addEventListener('click', handler);
  }

  _dispatch(action, target) {
    switch (action) {
      case 'quick-drive':
        this.actions.quickDrive();
        break;
      case 'free-roam':
        this.actions.freeRoam();
        break;
      case 'open-maps':
        this.refreshMaps();
        this.showOnly('maps');
        break;
      case 'open-worldmap':
        this.refreshWorldMap();
        this.showOnly('worldmap');
        break;
      case 'open-garage':
        this.refreshGarage();
        this.showOnly('garage');
        break;
      case 'open-challenges':
        this.refreshChallenges();
        this.showOnly('challenges');
        break;
      case 'open-settings':
        this.settingsPanel.refresh();
        this.showOnly('settings');
        break;
      case 'open-credits':
        this.showOnly('credits');
        break;
      case 'back':
        this.actions.back();
        break;
      case 'resume':
        this.actions.resume();
        break;
      case 'quit-to-menu':
        this.actions.quitToMenu();
        break;
      case 'recover':
        this.actions.recover();
        break;
      case 'toggle-drift':
        this.actions.toggleDrift();
        break;
      case 'restart-challenge':
        this.actions.restartChallenge();
        break;
      case 'drive-vehicle':
        this.actions.driveSelectedVehicle();
        break;
      case 'reset-progress':
        this.actions.requestResetProgress();
        break;
      case 'confirm-yes':
        this._resolveConfirm(true);
        break;
      case 'confirm-no':
        this._resolveConfirm(false);
        break;
      default:
        console.warn(`[UI] Unhandled action "${action}" on`, target);
    }
  }

  /**
   * Arrow-key focus navigation inside the active screen, plus Escape.
   * Implemented once here so every menu behaves identically.
   */
  _wireKeyboard() {
    this.doc.addEventListener(
      'keydown',
      (event) => {
        if (this.current === 'confirm') {
          if (event.key === 'Escape') {
            event.preventDefault();
            this._resolveConfirm(false);
          }
          return;
        }
        // Only the in-game Escape is handled here; menus are driven by Game.
        if (event.key === 'Escape') {
          const active = this.elements[this.current];
          if (!active) return;
          // Escape only closes menu screens, never the driving view.
          if (this.current !== 'loading' && this.current !== 'main') {
            event.preventDefault();
            this.actions.back();
          }
          return;
        }
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const active = this.elements[this.current];
        if (!active) return;
        const focusable = [
          ...active.querySelectorAll(
            'button:not([disabled]), [href], select, input, [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        event.preventDefault();
        const index = focusable.indexOf(this.doc.activeElement);
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + direction + focusable.length) % focusable.length;
        focusable[next].focus();
        this.audio?.ui('move');
      },
      { capture: false },
    );
  }

  _focusFirst(key) {
    const screen = this.elements[key];
    if (!screen) return;
    const preferred = screen.querySelector('[data-autofocus]');
    const target =
      preferred ??
      screen.querySelector(
        'button:not([disabled]), [href], select, input, [tabindex]:not([tabindex="-1"])',
      );
    if (target instanceof HTMLElement) {
      // Focus without scrolling the page.
      target.focus({ preventScroll: true });
    }
  }

  /** Rebuild everything that depends on saved progress. */
  refreshAll() {
    this.refreshGarage();
    this.refreshMaps();
    this.refreshChallenges();
    this.settingsPanel.refresh();
    // The world map is a full-screen menu that is only ever shown on demand, so
    // it is refreshed when it is opened rather than here.
  }

  get isModalOpen() {
    return this.current !== null && this.current !== 'loading';
  }
}

/** Escape user-controlled text before injecting it into markup. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format seconds as m:ss.mmm */
export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}
