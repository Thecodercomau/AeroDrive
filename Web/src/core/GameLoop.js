import { clamp } from '../utilities/math.js';

/**
 * Fixed-timestep game loop with a separate render callback.
 *
 * Physics and gameplay always advance in exact `1 / fixedHz` steps, which is
 * essential for a stable vehicle simulation: identical inputs must produce
 * identical motion regardless of monitor refresh rate. Rendering happens once
 * per animation frame and receives the leftover accumulator time as `alpha`,
 * which can be used to interpolate visuals between physics states.
 *
 * The loop degrades gracefully: if the machine cannot keep up, the number of
 * catch-up physics steps per frame is capped (default 5) so the simulation
 * slows down rather than entering a "death spiral" of unbounded catch-up.
 */
export class GameLoop {
  /**
   * @param {object} options
   * @param {(dt: number) => void} options.update   Fixed-step simulation tick.
   * @param {(alpha: number, dt: number) => void} options.render Presentation tick.
   * @param {number} [options.fixedHz]   Simulation frequency (default 60 Hz).
   * @param {number} [options.maxSubSteps] Catch-up cap per frame.
   * @param {number} [options.fpsLimit]  Optional render cap (0 = unlimited).
   */
  constructor({ update, render, fixedHz = 60, maxSubSteps = 5, fpsLimit = 0 }) {
    this.fixedDt = 1 / fixedHz;
    this.update = update;
    this.render = render;
    this.maxSubSteps = maxSubSteps;

    this.running = false;
    this.paused = false;

    this._accumulator = 0;
    this._lastTime = 0;
    this._rafId = 0;
    this._fpsLimit = fpsLimit;
    this._minFrameTime = fpsLimit > 0 ? 1000 / fpsLimit : 0;
    this._frameBudgetMs = 0;

    // Frame statistics, exposed for the performance overlay.
    this.stats = {
      fps: 0,
      frameMs: 0,
      updateMs: 0,
      renderMs: 0,
      subSteps: 0,
      frames: 0,
    };

    // Bound once so we can pass a stable reference to rAF.
    this._tick = this._tick.bind(this);
  }

  setFpsLimit(fpsLimit) {
    this._fpsLimit = fpsLimit;
    this._minFrameTime = fpsLimit > 0 ? 1000 / fpsLimit : 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this._lastTime = performance.now();
    this._accumulator = 0;
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /**
   * Pause simulation and rendering while keeping the loop registered.
   * Used by the pause menu so the world visibly freezes but the page stays
   * responsive to DOM events.
   */
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    // Discard accumulated time so unpausing does not fast-forward the world.
    this._accumulator = 0;
    this._lastTime = performance.now();
  }

  _tick(now) {
    if (!this.running) return;

    let frameTime = now - this._lastTime;
    this._lastTime = now;

    // Optional frame limiter: skip rendering entirely if we are ahead of budget.
    if (this._minFrameTime > 0 && frameTime < this._minFrameTime) {
      this._rafId = requestAnimationFrame(this._tick);
      return;
    }

    // Guard against huge deltas after a tab switch / breakpoint.
    frameTime = clamp(frameTime, 0, 250);
    const frameStart = now;

    if (!this.paused) {
      this._accumulator += frameTime / 1000;
      let steps = 0;
      const updateStart = performance.now();
      while (this._accumulator >= this.fixedDt && steps < this.maxSubSteps) {
        this.update(this.fixedDt);
        this._accumulator -= this.fixedDt;
        steps++;
      }
      // If we hit the cap, drop the remaining backlog rather than spiralling.
      if (steps >= this.maxSubSteps) this._accumulator = 0;
      this.stats.updateMs = performance.now() - updateStart;
      this.stats.subSteps = steps;
    }

    const renderStart = performance.now();
    this.render(this._accumulator / this.fixedDt, frameTime / 1000);
    this.stats.renderMs = performance.now() - renderStart;

    // Smooth the reported frame time so the overlay does not flicker.
    const frameMs = performance.now() - frameStart;
    this.stats.frameMs = this.stats.frameMs * 0.9 + frameMs * 0.1;
    this.stats.fps = this.stats.frameMs > 0 ? 1000 / this.stats.frameMs : 0;
    this.stats.frames++;

    this._rafId = requestAnimationFrame(this._tick);
  }
}
