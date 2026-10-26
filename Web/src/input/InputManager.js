import {
  emptyControlState,
  mergeControlStates,
  pickActiveGamepad,
  readGamepadInput,
  readKeyboardInput,
  readTouchInput,
  TOUCH_ACTIONS,
} from './inputMapping.js';

/**
 * Collects raw browser input and exposes a normalised control state each
 * simulation step.
 *
 * Design notes:
 *  - One-shot actions (camera toggle, recover) are latched when the key goes
 *    down and cleared once `consume()` reads them, so a press is never lost
 *    between a slow physics step and a fast key repeat.
 *  - Key state is tracked by `KeyboardEvent.code`, not `key`, so bindings keep
 *    working on non-QWERTY layouts.
 *  - We call `preventDefault()` only for keys we actually bind, so browser
 *    shortcuts (reload, devtools) remain available.
 */
export class InputManager {
  /**
   * @param {object} options
   * @param {HTMLElement} options.target     Element receiving pointer lock / mouse.
   * @param {() => Record<string, string[]>} options.getBindings
   * @param {() => number} [options.getDeadzone]
   */
  constructor({ target, getBindings, getDeadzone = () => 0.12 }) {
    this.target = target;
    this.getBindings = getBindings;
    this.getDeadzone = getDeadzone;

    this.pressed = new Set();
    this.touchActions = new Set();
    this.enabled = true;
    this.pointerLocked = false;

    this._latched = emptyControlState();
    this._gamepadActions = emptyControlState();
    this._lastGamepadState = emptyControlState();
    this._activeGamepadIndex = -1;
    this._listeners = { keydown: [], keyup: [] };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onGamepadConnected = this._onGamepadConnected.bind(this);

    this._bound = false;
    this.leftMouseDown = false;
    this.mouseDelta = { x: 0, y: 0 };
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
  }

  /** Start listening. Safe to call more than once. */
  attach() {
    if (this._bound) return;
    this._bound = true;
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    window.addEventListener('gamepadconnected', this._onGamepadConnected);
    window.addEventListener('mousemove', this._onMouseMove);
    this.target?.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
  }

  detach() {
    if (!this._bound) return;
    this._bound = false;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    window.removeEventListener('gamepadconnected', this._onGamepadConnected);
    window.removeEventListener('mousemove', this._onMouseMove);
    this.target?.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.pressed.clear();
    this.touchActions.clear();
  }

  /** Register an extra handler for raw keydown/keyup (used by the settings UI). */
  addKeyListener(type, handler) {
    if (type !== 'keydown' && type !== 'keyup') {
      throw new Error(`InputManager.addKeyListener: unknown type "${type}"`);
    }
    this._listeners[type].push(handler);
    return () => {
      const list = this._listeners[type];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** When false, bound keys are ignored (menus, text entry). */
  setEnabled(enabled) {
    if (!enabled) {
      this.pressed.clear();
      this.touchActions.clear();
    }
    this.enabled = enabled;
  }

  /**
   * Hold or release one on-screen touch control.
   *
   * The touch UI is only a source of held actions; it never reaches into the
   * vehicle or the game state. Held actions are cleared when input is disabled,
   * so pausing with a thumb on the throttle cannot leave it stuck down.
   *
   * @param {string} action one of `TOUCH_ACTIONS`
   * @param {boolean} active
   */
  setTouchAction(action, active) {
    if (!TOUCH_ACTIONS.includes(action)) {
      throw new Error(`InputManager.setTouchAction: unknown action "${action}"`);
    }
    if (active) this.touchActions.add(action);
    else this.touchActions.delete(action);
  }

  /** Release every held touch control (blur, pause, pointer cancellation). */
  clearTouchActions() {
    this.touchActions.clear();
  }

  requestPointerLock() {
    if (!this.target?.requestPointerLock) return;
    const result = this.target.requestPointerLock();
    // Chrome returns a promise and rejects if the user just exited lock.
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /**
   * Produce the control state for this simulation step.
   * One-shot actions are consumed (cleared) by this call.
   */
  sample(dtSeconds = 1 / 60) {
    void dtSeconds;
    if (!this.enabled) {
      this.mouseDelta.x = 0;
      this.mouseDelta.y = 0;
      return emptyControlState();
    }

    const keyboard = readKeyboardInput(this.pressed, this.getBindings());
    const touch = readTouchInput(this.touchActions);
    const pad = pickActiveGamepad(
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [],
      this._activeGamepadIndex,
    );
    const gamepad = readGamepadInput(pad, this.getDeadzone());

    // Promote gamepad button presses to one-shot latches on the rising edge.
    const rising = (key) => gamepad[key] && !this._lastGamepadState[key];
    if (rising('toggleCamera')) this._latched.toggleCamera = true;
    if (rising('recover')) this._latched.recover = true;
    if (rising('toggleHeadlights')) this._latched.toggleHeadlights = true;
    if (rising('horn')) this._latched.horn = true;
    this._lastGamepadState = gamepad;

    const merged = mergeControlStates(mergeControlStates(keyboard, gamepad), touch);
    merged.shiftUp = keyboard.shiftUp;
    merged.shiftDown = keyboard.shiftDown;

    // One-shot actions come only from the latches. The raw device states mark
    // these actions true for as long as the key/button is held, but a camera
    // toggle or recovery must fire once per press, not once per sample.
    merged.toggleCamera = this._latched.toggleCamera;
    merged.recover = this._latched.recover;
    merged.toggleHeadlights = this._latched.toggleHeadlights;
    merged.horn = this._latched.horn;
    this._latched = emptyControlState();

    this.mouseDelta.x = 0;
    this.mouseDelta.y = 0;
    return merged;
  }

  /** True while any bound key or gamepad button is being held. */
  isAnyControlActive() {
    return this.pressed.size > 0;
  }

  hasGamepad() {
    const pads =
      typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    return Boolean(pickActiveGamepad(pads, this._activeGamepadIndex));
  }

  /* ------------------------------- handlers ------------------------------- */

  _isBoundCode(code) {
    const bindings = this.getBindings();
    if (!bindings) return false;
    for (const codes of Object.values(bindings)) {
      if (Array.isArray(codes) && codes.includes(code)) return true;
    }
    return false;
  }

  _onKeyDown(event) {
    for (const handler of this._listeners.keydown) handler(event);
    if (this._isBoundCode(event.code)) {
      // Stop the page from scrolling on arrows/space while driving.
      event.preventDefault();
    }
    if (!this.enabled) return;
    if (event.repeat) return;

    this.pressed.add(event.code);
    const bindings = this.getBindings() ?? {};
    if ((bindings.camera ?? []).includes(event.code)) this._latched.toggleCamera = true;
    if ((bindings.recover ?? []).includes(event.code)) this._latched.recover = true;
    if ((bindings.headlights ?? []).includes(event.code)) this._latched.toggleHeadlights = true;
    if ((bindings.horn ?? []).includes(event.code)) this._latched.horn = true;
  }

  _onKeyUp(event) {
    for (const handler of this._listeners.keyup) handler(event);
    this.pressed.delete(event.code);
  }

  _onBlur() {
    // Alt-tabbing away must not leave the throttle stuck down.
    this.pressed.clear();
    this.touchActions.clear();
    this.leftMouseDown = false;
  }

  _onGamepadConnected(event) {
    this._activeGamepadIndex = event.gamepad?.index ?? -1;
    console.info(`[Input] Gamepad connected: ${event.gamepad?.id ?? 'unknown'}`);
  }

  _onPointerLockChange() {
    this.pointerLocked = document.pointerLockElement === this.target;
  }

  _onMouseMove(event) {
    if (!this.pointerLocked) return;
    this.mouseDelta.x += event.movementX ?? 0;
    this.mouseDelta.y += event.movementY ?? 0;
  }

  _onMouseDown(event) {
    if (event.button === 0) this.leftMouseDown = true;
  }

  _onMouseUp(event) {
    if (event.button === 0) this.leftMouseDown = false;
  }
}
