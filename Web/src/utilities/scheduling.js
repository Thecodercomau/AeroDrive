/**
 * Yield control back to the browser for one frame.
 *
 * Used between the expensive phases of world generation so the loading screen
 * can actually paint and respond instead of freezing while 30 000 terrain
 * samples are computed. Falls back to a macrotask timeout where
 * `requestAnimationFrame` does not exist (headless test runs).
 */
export function nextFrame() {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Yield for `count` animation frames. */
export async function waitFrames(count = 1) {
  for (let i = 0; i < count; i++) await nextFrame();
}
