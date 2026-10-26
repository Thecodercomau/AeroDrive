import { clamp } from '../utilities/math.js';

/**
 * Pure input mapping.
 *
 * Device events are turned into a normalised control state here, with no DOM
 * access, so the exact same rules can be unit-tested in Node. `InputManager`
 * is responsible only for collecting raw events and calling into these.
 */

/** A neutral control state. */
export function emptyControlState() {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    shiftUp: false,
    shiftDown: false,
    // One-shot actions (true for a single simulation step).
    toggleCamera: false,
    recover: false,
    toggleHeadlights: false,
    horn: false,
  };
}

/**
 * Translate the set of currently-held key codes into a control state.
 *
 * @param {Set<string>|Iterable<string>} pressedKeyCodes
 * @param {Record<string, string[]>} bindings action -> KeyCode[]
 * @returns {ReturnType<typeof emptyControlState>}
 */
export function readKeyboardInput(pressedKeyCodes, bindings) {
  const pressed = pressedKeyCodes instanceof Set ? pressedKeyCodes : new Set(pressedKeyCodes);
  const isHeld = (action) => {
    const codes = bindings?.[action];
    if (!Array.isArray(codes)) return false;
    for (const code of codes) if (pressed.has(code)) return true;
    return false;
  };

  const state = emptyControlState();
  state.throttle = isHeld('accelerate') ? 1 : 0;
  state.brake = isHeld('brake') ? 1 : 0;
  state.handbrake = isHeld('handbrake');
  state.shiftUp = isHeld('shiftUp');
  state.shiftDown = isHeld('shiftDown');
  state.toggleCamera = isHeld('camera');
  state.recover = isHeld('recover');
  state.toggleHeadlights = isHeld('headlights');
  state.horn = isHeld('horn');

  const left = isHeld('steerLeft');
  const right = isHeld('steerRight');
  // Both directions held cancels out (feels better than last-input-wins).
  state.steer = (right ? 1 : 0) - (left ? 1 : 0);

  return state;
}

/** Actions an on-screen touch control may hold. */
export const TOUCH_ACTIONS = Object.freeze([
  'throttle',
  'brake',
  'steerLeft',
  'steerRight',
  'handbrake',
]);

/**
 * Translate the set of held on-screen touch actions into a control state.
 *
 * Touch buttons are binary and can be held simultaneously (one thumb steering,
 * the other on the throttle), so this follows the same rules as the keyboard:
 * opposite steering directions cancel out and the strongest single input wins
 * when the states are merged.
 *
 * @param {Set<string>|Iterable<string>} heldActions
 * @returns {ReturnType<typeof emptyControlState>}
 */
export function readTouchInput(heldActions) {
  const held = heldActions instanceof Set ? heldActions : new Set(heldActions);
  const state = emptyControlState();
  if (held.has('throttle')) state.throttle = 1;
  if (held.has('brake')) state.brake = 1;
  state.handbrake = held.has('handbrake');
  state.steer = (held.has('steerRight') ? 1 : 0) - (held.has('steerLeft') ? 1 : 0);
  return state;
}

/**
 * Read a Gamepad API snapshot into a control state.
 *
 * Standard mapping is assumed (Xbox-style):
 *   axes[0] = left stick X, buttons[7] = right trigger, buttons[6] = left trigger,
 *   buttons[0] = A (camera), buttons[3] = Y (recover), buttons[1] = B (handbrake).
 *
 * @param {Gamepad} pad
 * @param {number} deadzone 0..0.6
 */
export function readGamepadInput(pad, deadzone = 0.12) {
  const state = emptyControlState();
  if (!pad) return state;

  const dz = clamp(deadzone, 0, 0.6);
  const applied = (value) => {
    const v = Number.isFinite(value) ? value : 0;
    return Math.abs(v) < dz ? 0 : v;
  };

  const axes = pad.axes ?? [];
  let steer = applied(axes[0]);
  // Some pads report throttle on invertY (axis 1); we prefer the triggers below.
  const triggerThrottle = pad.buttons?.[7]?.value ?? 0;
  const triggerBrake = pad.buttons?.[6]?.value ?? 0;

  if (triggerThrottle > 0.02 || triggerBrake > 0.02) {
    state.throttle = clamp(triggerThrottle, 0, 1);
    state.brake = clamp(triggerBrake, 0, 1);
  } else {
    // Fallback for pads without analogue triggers (e.g. some PS3-era devices).
    const stickY = applied(axes[1]);
    if (stickY < 0) state.throttle = clamp(-stickY, 0, 1);
    else if (stickY > 0) state.brake = clamp(stickY, 0, 1);
  }

  // Equivalent keyboard buttons so pads without sticks still work.
  if (pad.buttons?.[15]?.pressed) steer = 1;
  if (pad.buttons?.[14]?.pressed) steer = -1;

  state.steer = clamp(steer, -1, 1);
  state.handbrake = Boolean(pad.buttons?.[1]?.pressed) || Boolean(pad.buttons?.[4]?.pressed);
  state.toggleCamera = Boolean(pad.buttons?.[0]?.pressed);
  state.recover = Boolean(pad.buttons?.[3]?.pressed);
  state.horn = Boolean(pad.buttons?.[2]?.pressed);
  return state;
}

/**
 * Combine two control states, taking the strongest input from either source.
 * Keyboard and gamepad are both live at all times; whichever the player pushes
 * harder wins, which is what players expect when a pad is plugged in mid-session.
 */
export function mergeControlStates(a, b) {
  const out = emptyControlState();
  out.throttle = Math.max(a.throttle, b.throttle);
  out.brake = Math.max(a.brake, b.brake);
  out.steer = clamp(Math.abs(a.steer) >= Math.abs(b.steer) ? a.steer : b.steer, -1, 1);
  out.handbrake = a.handbrake || b.handbrake;
  out.shiftUp = a.shiftUp || b.shiftUp;
  out.shiftDown = a.shiftDown || b.shiftDown;
  out.toggleCamera = a.toggleCamera || b.toggleCamera;
  out.recover = a.recover || b.recover;
  out.toggleHeadlights = a.toggleHeadlights || b.toggleHeadlights;
  out.horn = a.horn || b.horn;
  return out;
}

const GAMEPAD_DEADZONE_FALLBACK = 0.12;

/** Find the first connected gamepad in the standard mapping. */
export function pickActiveGamepad(gamepads, preferredIndex = -1) {
  if (!Array.isArray(gamepads) || gamepads.length === 0) return null;
  if (preferredIndex >= 0 && gamepads[preferredIndex]?.connected) {
    return gamepads[preferredIndex];
  }
  for (const pad of gamepads) {
    if (pad?.connected) return pad;
  }
  return null;
}

export { GAMEPAD_DEADZONE_FALLBACK };
