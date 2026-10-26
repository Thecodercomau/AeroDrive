import { test, expect } from '@playwright/test';

/**
 * The production build, served from a hosting sub-path.
 *
 * Every other browser test runs against `vite preview`, which serves the build
 * from the root of a host. That is not how the build is actually deployed:
 * GitHub Pages serves a project at `https://<user>.github.io/<repo>/`, so the
 * entry point is `/<repo>/index.html` and every asset has to resolve relative to
 * it. `base: './'` in `vite.config.js` is what makes that work, and this test is
 * the only thing that checks it does.
 *
 * `tools/serve-dist.mjs` provides the sub-path host (see `playwright.config.js`).
 * It refuses any request outside the mount, so an absolute asset reference fails
 * here loudly rather than silently resolving at the root and passing.
 */

const BOOT_TIMEOUT = 120_000;
const SUBPATH_ORIGIN = 'http://127.0.0.1:4174';
const SUBPATH_URL = `${SUBPATH_ORIGIN}/aerodrive/`;

test('boots and reaches the menu with nothing fetched from the server root', async ({ page }) => {
  const problems = [];
  /** Responses that came from the sub-path host but outside the mount. */
  const outsideMount = [];

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    problems.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText}`),
  );
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(SUBPATH_ORIGIN) && !url.startsWith(SUBPATH_URL)) outsideMount.push(url);
  });

  await page.goto(SUBPATH_URL);

  // A real boot, not just a 200: the game has to load its module graph, build a
  // world and get itself to the menu.
  await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });
  await expect(page.locator('#loading-screen')).toBeHidden();
  expect(await page.evaluate(() => Boolean(window.aerodrive?.world))).toBe(true);
  // The entry point really was the mounted document, not something served at /.
  expect(new URL(page.url()).pathname).toBe('/aerodrive/');

  expect(outsideMount, 'the build reached outside its mount for an asset').toEqual([]);
  expect(problems, 'the browser reported errors').toEqual([]);
});
