import { test, expect } from '@playwright/test';

/**
 * The WebKit smoke test.
 *
 * Chromium is the only engine the rest of the browser suite covers, and Safari
 * does not use it: WebKit is a genuinely different engine with a different WebGL
 * stack, so \"it works in Chromium\" is not evidence about Safari at all.
 *
 * This is deliberately a *smoke* test rather than a gameplay run. What has to be
 * true for the game to be usable in Safari is that the module graph loads, WebGL
 * context creation succeeds, the world builds, and no error reaches the console.
 * Driving, menus and settings are already covered exhaustively in Chromium, and
 * re-running them here would double the suite's runtime to re-test engine-neutral
 * code.
 *
 * Run it on its own with `npm run test:e2e:webkit`.
 */

const BOOT_TIMEOUT = 180_000;

test('starts, renders and reaches the menu in WebKit', async ({ page }) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/');

  // WebGL has to be real: `main.js` shows a readable failure screen instead of
  // the game when it cannot get a context, so the menu appearing is itself
  // evidence that the context was created.
  await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(page.locator('#loading-screen')).toBeHidden();

  expect(await page.evaluate(() => Boolean(window.aerodrive?.world))).toBe(true);
  expect(await page.evaluate(() => typeof window.aerodrive?.startDriving)).toBe('function');

  const canvas = await page.evaluate(() => {
    const element = document.getElementById('game-canvas');
    const gl = element.getContext('webgl2') ?? element.getContext('webgl');
    return { width: element.width, height: element.height, hasContext: gl !== null };
  });
  expect(canvas.hasContext).toBe(true);
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);

  expect(problems, 'WebKit reported errors').toEqual([]);
});
