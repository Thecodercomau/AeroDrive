/**
 * On-screen driving controls for touch devices.
 *
 * The buttons are static markup inside the HUD; this class only owns their
 * press state. It writes held actions into `InputManager`, which is the single
 * place input from keyboard, gamepad and touch is merged, so the vehicle never
 * needs to know which device is being used.
 *
 * Multi-touch matters: one thumb can hold the steering while the other holds
 * the throttle, so each button tracks its own set of pointer ids and a pointer
 * that slides off a button releases that button, not the whole cluster.
 */

const TOUCH_ACTIONS = new Set(['throttle', 'brake', 'steerLeft', 'steerRight', 'handbrake']);

export class TouchControls {
  /**
   * @param {object} options
   * @param {import('./InputManager.js').InputManager} options.input
   * @param {Document} [options.document]
   * @param {() => void} [options.onPause]
   */
  constructor({ input, document: doc = globalThis.document, onPause = null }) {
    this.input = input;
    this.doc = doc;
    this.onPause = onPause;
    this.root = doc?.getElementById('touch-controls') ?? null;
    this.available =
      Boolean(this.root) &&
      (Number(globalThis.navigator?.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in globalThis);
    /** @type {Map<HTMLButtonElement, Set<number>>} */
    this._pointers = new Map();

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    if (!this.available) return;

    this.doc.body?.classList.add('has-touch');
    this._buttons = [...this.root.querySelectorAll('[data-touch-action]')];
    for (const button of this._buttons) {
      this._pointers.set(button, new Set());
      button.addEventListener('pointerdown', this._onPointerDown);
      button.addEventListener('pointerup', this._onPointerUp);
      button.addEventListener('pointercancel', this._onPointerUp);
      button.addEventListener('lostpointercapture', this._onPointerUp);
      button.addEventListener('contextmenu', (event) => event.preventDefault());
    }
    globalThis.addEventListener?.('blur', this._onBlur);
  }

  /** True when this device has a touch interface and the buttons exist. */
  get enabled() {
    return this.available;
  }

  /** Show the controls (only while driving). */
  show() {
    if (!this.available) return;
    this.root.hidden = false;
  }

  /** Hide the controls and release anything still held. */
  hide() {
    if (!this.available) return;
    this.root.hidden = true;
    this._releaseAll();
  }

  /* ------------------------------- pointers ------------------------------- */

  _onPointerDown(event) {
    const button = event.currentTarget;
    const action = button?.dataset?.touchAction;
    if (!action) return;
    event.preventDefault();

    if (action === 'pause') {
      this.onPause?.();
      return;
    }
    if (!TOUCH_ACTIONS.has(action)) return;

    const pointers = this._pointers.get(button);
    pointers.add(event.pointerId);
    try {
      button.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the browser has already cancelled the
      // pointer; the button still works, it just cannot detect a slide-off.
    }
    button.classList.add('is-held');
    button.setAttribute('aria-pressed', 'true');
    this.input.setTouchAction(action, true);
  }

  _onPointerUp(event) {
    const button = event.currentTarget;
    const pointers = this._pointers.get(button);
    if (!pointers) return;
    pointers.delete(event.pointerId);
    if (pointers.size > 0) return;

    const action = button.dataset?.touchAction;
    if (action && TOUCH_ACTIONS.has(action)) this.input.setTouchAction(action, false);
    button.classList.remove('is-held');
    button.setAttribute('aria-pressed', 'false');
  }

  _onBlur() {
    this._releaseAll();
  }

  _releaseAll() {
    for (const [button, pointers] of this._pointers) {
      pointers.clear();
      const action = button.dataset?.touchAction;
      if (action && TOUCH_ACTIONS.has(action)) this.input.setTouchAction(action, false);
      button.classList.remove('is-held');
      button.setAttribute('aria-pressed', 'false');
    }
    this.input.clearTouchActions();
  }
}
