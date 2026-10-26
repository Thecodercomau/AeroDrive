import { describe, expect, it } from 'vitest';
import {
  emptyControlState,
  mergeControlStates,
  pickActiveGamepad,
  readGamepadInput,
  readKeyboardInput,
  readTouchInput,
} from '../src/input/inputMapping.js';
import { InputManager } from '../src/input/InputManager.js';
import { DEFAULT_BINDINGS } from '../src/settings/settings.js';

/** Build a fake Gamepad with the standard mapping. */
function fakeGamepad({ axes = [0, 0, 0, 0], buttons = {} } = {}) {
  const buttonList = Array.from({ length: 17 }, (_, index) => ({
    pressed: Boolean(buttons[index]?.pressed),
    value: buttons[index]?.value ?? (buttons[index]?.pressed ? 1 : 0),
  }));
  return { axes, buttons: buttonList, connected: true, index: 0, id: 'Fake Pad' };
}

describe('keyboard input mapping', () => {
  it('returns a neutral state for no keys', () => {
    const state = readKeyboardInput(new Set(), DEFAULT_BINDINGS);
    expect(state).toEqual(emptyControlState());
  });

  it('maps the primary WASD bindings', () => {
    expect(readKeyboardInput(new Set(['KeyW']), DEFAULT_BINDINGS).throttle).toBe(1);
    expect(readKeyboardInput(new Set(['KeyS']), DEFAULT_BINDINGS).brake).toBe(1);
    expect(readKeyboardInput(new Set(['KeyA']), DEFAULT_BINDINGS).steer).toBe(-1);
    expect(readKeyboardInput(new Set(['KeyD']), DEFAULT_BINDINGS).steer).toBe(1);
    expect(readKeyboardInput(new Set(['Space']), DEFAULT_BINDINGS).handbrake).toBe(true);
    expect(readKeyboardInput(new Set(['ShiftLeft']), DEFAULT_BINDINGS).shiftUp).toBe(true);
    expect(readKeyboardInput(new Set(['ControlLeft']), DEFAULT_BINDINGS).shiftDown).toBe(true);
  });

  it('also honours the arrow-key alternatives', () => {
    expect(readKeyboardInput(new Set(['ArrowUp']), DEFAULT_BINDINGS).throttle).toBe(1);
    expect(readKeyboardInput(new Set(['ArrowDown']), DEFAULT_BINDINGS).brake).toBe(1);
    expect(readKeyboardInput(new Set(['ArrowLeft']), DEFAULT_BINDINGS).steer).toBe(-1);
    expect(readKeyboardInput(new Set(['ArrowRight']), DEFAULT_BINDINGS).steer).toBe(1);
  });

  it('cancels out when both steering directions are held', () => {
    const state = readKeyboardInput(new Set(['KeyA', 'KeyD']), DEFAULT_BINDINGS);
    expect(state.steer).toBe(0);
  });

  it('latches one-shot actions while the key is held', () => {
    const state = readKeyboardInput(new Set(['KeyC', 'KeyR', 'KeyH']), DEFAULT_BINDINGS);
    expect(state.toggleCamera).toBe(true);
    expect(state.recover).toBe(true);
    expect(state.toggleHeadlights).toBe(true);
  });

  it('survives missing or malformed bindings', () => {
    const state = readKeyboardInput(new Set(['KeyW']), { accelerate: 'KeyW' });
    expect(state.throttle).toBe(0);
    expect(() => readKeyboardInput(['KeyW'], undefined)).not.toThrow();
  });
});

describe('touch input mapping', () => {
  it('returns a neutral state when nothing is held', () => {
    expect(readTouchInput(new Set())).toEqual(emptyControlState());
  });

  it('maps held throttle, brake and handbrake buttons', () => {
    const state = readTouchInput(new Set(['throttle', 'handbrake']));
    expect(state.throttle).toBe(1);
    expect(state.brake).toBe(0);
    expect(state.handbrake).toBe(true);
  });

  it('steers negative for left and positive for right, cancelling both', () => {
    expect(readTouchInput(new Set(['steerLeft'])).steer).toBe(-1);
    expect(readTouchInput(new Set(['steerRight'])).steer).toBe(1);
    expect(readTouchInput(new Set(['steerLeft', 'steerRight'])).steer).toBe(0);
  });

  it('merges with keyboard and gamepad as another live source', () => {
    const touch = readTouchInput(new Set(['brake', 'steerLeft']));
    const merged = mergeControlStates(
      readKeyboardInput(new Set(['KeyW']), DEFAULT_BINDINGS),
      touch,
    );
    expect(merged.throttle).toBe(1);
    expect(merged.brake).toBe(1);
    expect(merged.steer).toBe(-1);
  });
});

describe('gamepad input mapping', () => {
  it('returns a neutral state for a null pad', () => {
    expect(readGamepadInput(null)).toEqual(emptyControlState());
  });

  it('reads the analogue triggers for throttle and brake', () => {
    const pad = fakeGamepad({ buttons: { 7: { value: 0.8 }, 6: { value: 0.4 } } });
    const state = readGamepadInput(pad);
    expect(state.throttle).toBeCloseTo(0.8, 5);
    expect(state.brake).toBeCloseTo(0.4, 5);
  });

  it('falls back to the left stick when the triggers are untouched', () => {
    const forward = readGamepadInput(fakeGamepad({ axes: [0, -0.9] }));
    expect(forward.throttle).toBeCloseTo(0.9, 5);

    const backward = readGamepadInput(fakeGamepad({ axes: [0, 0.7] }));
    expect(backward.brake).toBeCloseTo(0.7, 5);
  });

  it('applies the stick deadzone so a drifting stick does not steer', () => {
    expect(readGamepadInput(fakeGamepad({ axes: [0.03, 0] }), 0.12).steer).toBe(0);
    expect(readGamepadInput(fakeGamepad({ axes: [0.4, 0] }), 0.12).steer).toBeCloseTo(0.4, 5);
  });

  it('reads buttons for handbrake, camera and recovery', () => {
    const pad = fakeGamepad({
      buttons: { 1: { pressed: true }, 0: { pressed: true }, 3: { pressed: true } },
    });
    const state = readGamepadInput(pad);
    expect(state.handbrake).toBe(true);
    expect(state.toggleCamera).toBe(true);
    expect(state.recover).toBe(true);
  });

  it('supports d-pad steering on pads without a usable stick', () => {
    expect(readGamepadInput(fakeGamepad({ buttons: { 15: { pressed: true } } })).steer).toBe(1);
    expect(readGamepadInput(fakeGamepad({ buttons: { 14: { pressed: true } } })).steer).toBe(-1);
  });
});

describe('control state merging', () => {
  it('takes the strongest throttle and the largest steering magnitude', () => {
    const keyboard = { ...emptyControlState(), throttle: 1, steer: -1 };
    const gamepad = { ...emptyControlState(), throttle: 0.3, brake: 0.5, steer: 0.2 };
    const merged = mergeControlStates(keyboard, gamepad);

    expect(merged.throttle).toBe(1);
    expect(merged.brake).toBe(0.5);
    expect(merged.steer).toBe(-1); // keyboard steering is stronger
  });

  it('ORs one-shot and boolean actions', () => {
    const a = { ...emptyControlState(), handbrake: true, recover: false };
    const b = { ...emptyControlState(), handbrake: false, recover: true };
    const merged = mergeControlStates(a, b);
    expect(merged.handbrake).toBe(true);
    expect(merged.recover).toBe(true);
  });
});

describe('one-shot input latches', () => {
  it('fires a held key once, not once per sample', () => {
    const manager = new InputManager({
      target: null,
      getBindings: () => DEFAULT_BINDINGS,
    });
    manager.pressed.add('KeyC');
    manager._latched.toggleCamera = true;

    expect(manager.sample().toggleCamera).toBe(true);
    expect(manager.sample().toggleCamera).toBe(false);
  });
});

describe('gamepad selection', () => {
  it('returns null when nothing is connected', () => {
    expect(pickActiveGamepad([])).toBeNull();
    expect(pickActiveGamepad([{ connected: false }])).toBeNull();
    expect(pickActiveGamepad(null)).toBeNull();
  });

  it('prefers the remembered pad index', () => {
    const first = { connected: true, index: 0, id: 'first' };
    const second = { connected: true, index: 1, id: 'second' };
    expect(pickActiveGamepad([first, second], 1).id).toBe('second');
    // Falls back to any connected pad if the preferred one disappeared.
    expect(pickActiveGamepad([first, { connected: false }], 3).id).toBe('first');
  });
});
