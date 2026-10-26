import { test, expect } from '@playwright/test';

/**
 * The touch-control path.
 *
 * The game is a website, so a phone or tablet has to be able to drive it. This
 * boots the production build with a touch-capable, phone-sized viewport and
 * holds the on-screen throttle long enough to move the car — a button that only
 * *looks* enabled is the exact failure mode a DOM-presence assertion would miss.
 */

const BOOT_TIMEOUT = 120_000;
const DRIVE_TIMEOUT = 60_000;

test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 },
});

test('shows touch controls and drives with the on-screen throttle', async ({ page }) => {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

  await page.goto('/');
  await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });

  await page.click('[data-action="quick-drive"]');
  await expect(page.locator('#hud')).toBeVisible({ timeout: DRIVE_TIMEOUT });

  const controls = page.locator('#touch-controls');
  await expect(controls).toBeVisible();
  await expect(page.locator('#touch-controls [data-touch-action="throttle"]')).toBeVisible();
  await expect(page.locator('#touch-controls [data-touch-action="brake"]')).toBeVisible();
  await expect(page.locator('#touch-controls [data-touch-action="steerLeft"]')).toBeVisible();
  await expect(page.locator('#touch-controls [data-touch-action="steerRight"]')).toBeVisible();
  await expect(page.locator('#touch-controls [data-touch-action="handbrake"]')).toBeVisible();

  // Desktop-only panels make room for the thumb controls.
  await expect(page.locator('.hud__stats')).toBeHidden();

  const throttle = page.locator('#touch-controls [data-touch-action="throttle"]');
  const pointer = { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true };
  await throttle.dispatchEvent('pointerdown', pointer);

  await expect
    .poll(() => page.evaluate(() => window.aerodrive?.vehicle?.telemetry?.speedKmh ?? 0), {
      timeout: 45_000,
      intervals: [200, 400, 800],
    })
    .toBeGreaterThan(5);

  await throttle.dispatchEvent('pointerup', pointer);

  // Pausing from the touch HUD must hide the driving controls and open the menu.
  await page
    .locator('#touch-controls [data-touch-action="pause"]')
    .dispatchEvent('pointerdown', pointer);
  await expect(page.locator('#screen-pause')).toBeVisible({ timeout: DRIVE_TIMEOUT });
  await expect(controls).toBeHidden();

  expect(problems, 'the browser reported errors').toEqual([]);
});
