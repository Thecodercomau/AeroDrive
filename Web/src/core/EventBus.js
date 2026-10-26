/**
 * Minimal synchronous event bus.
 *
 * Used to keep subsystems (HUD, audio, missions, saves) from importing each
 * other directly. Handlers are copied before dispatch so a handler may
 * subscribe or unsubscribe while an event is being delivered without
 * corrupting iteration.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /** Subscribe to `event`. Returns an unsubscribe function. */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on("${event}") expects a function`);
    }
    let set = this._handlers.get(event);
    if (!set) {
      set = new Set();
      this._handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe to the next occurrence of `event` only. */
  once(event, handler) {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._handlers.delete(event);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (error) {
        // A failing listener must never take down the game loop.
        console.error(`[EventBus] handler for "${event}" threw:`, error);
      }
    }
  }

  /** Remove all handlers (optionally only for one event). */
  clear(event) {
    if (event === undefined) this._handlers.clear();
    else this._handlers.delete(event);
  }
}
