import { test, expect } from '@playwright/test';

/**
 * AERODRIVE end-to-end gameplay walkthrough.
 *
 * This suite drives the *real* production bundle in a real browser and executes
 * the gameplay scenarios from the specification:
 *
 *   1. start the game             8. open/close the pause menu
 *   2. select a vehicle           9. change settings
 *   3. accelerate and steer      10. reload the page
 *   4. brake and reverse         11. verify settings persisted
 *   5. collide with an object    12. weather, wet grip, skid marks, time of day
 *   6. recover the vehicle       13. draw the world map
 *   7. change camera views       14. list and start a challenge
 *                                 15. drive over a bridge and through a tunnel
 *
 * Headless Chromium renders through SwiftShader (software WebGL), so a boot
 * takes tens of seconds rather than the ~2 s a GPU machine needs. All tests
 * therefore share one loaded page instead of re-booting per assertion.
 */

const BOOT_TIMEOUT = 120_000;
const DRIVE_TIMEOUT = 60_000;

/** Console/page errors accumulated across the run, tagged with the test that saw them. */
const problems = [];

function watchForErrors(page) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // A refused pointer-lock request is the browser refusing a gesture-less
    // request, not a game fault — `requestPointerLock` promises are caught in
    // InputManager, so anything reaching here is worth reporting instead.
    problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
}

/** Assert no browser error has been observed, and reset the buffer. */
function expectCleanConsole(testInfo) {
  const snapshot = problems.splice(0, problems.length);
  expect(snapshot, `browser reported errors during "${testInfo.title}"`).toEqual([]);
}

/** Read a live value out of the game's debug handle. */
function game(page, expression) {
  return page.evaluate(`(() => { const g = window.aerodrive; return ${expression}; })()`);
}

/**
 * Yaw of the car's visual model, in radians.
 *
 * The chassis is a right-handed body facing +Z, so the quaternion's yaw about
 * the world Y axis is the same formula the camera rig uses to follow it.
 */
function yaw(page) {
  return page.evaluate(() => {
    const q = window.aerodrive.vehicle.object3D.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('AERODRIVE gameplay', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {import('@playwright/test').Page} */
  let page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    watchForErrors(page);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('1. starts the game and reaches the main menu', async ({}, testInfo) => {
    await page.goto('/');

    // The loading screen must resolve into the menu on its own, with no fatal
    // error message left behind.
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect(page.locator('#loading-screen')).toBeHidden();

    // Retrying, not sampled once: the status line also carries transient
    // notifications ("progress saved" arrives on an 800 ms debounce and clears
    // itself), so a single read can legitimately catch one of those instead of
    // the persistent "… loaded" message underneath it.
    await expect(page.locator('#menu-status')).toHaveText(/loaded/i, { timeout: 15_000 });

    // The debug handle the QA scripts use must exist and be a live Game.
    expect(await game(page, 'typeof g.boot')).toBe('function');
    expect(await game(page, 'g.world !== null')).toBe(true);
    expect(await game(page, 'g.vehicle !== null')).toBe(true);

    // WebGL must actually be rendering into the canvas, not a 0x0 backing store.
    const canvas = await page.evaluate(() => {
      const element = document.getElementById('game-canvas');
      return { width: element.width, height: element.height };
    });
    expect(canvas.width).toBeGreaterThan(0);
    expect(canvas.height).toBeGreaterThan(0);

    await page.click('[data-action="open-maps"]');
    await expect(page.locator('#screen-maps')).toBeVisible();
    await page.locator('#maps-list button').filter({ hasText: 'Modern City' }).click();
    await expect(page.locator('#screen-maps')).toBeVisible({ timeout: BOOT_TIMEOUT });
    await expect
      .poll(() => game(page, 'g.world.map.id'), { timeout: BOOT_TIMEOUT })
      .toBe('modern-city');
    expect(await game(page, 'g.state')).toBe('menu');
    await page.click('#screen-maps [data-action="back"]');
    await expect(page.locator('#screen-main')).toBeVisible();

    expectCleanConsole(testInfo);
  });

  test('toggles drift mode with the key and HUD button', async ({}, testInfo) => {
    await page.click('[data-action="free-roam"]');
    await expect(page.locator('#hud')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    const driftButton = page.locator('#hud-drift-toggle');
    await expect(driftButton).toHaveAttribute('aria-pressed', 'false');

    await page.keyboard.press('KeyG');
    await expect(driftButton).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => game(page, 'g.vehicle.driftMode')).toBe(true);

    await driftButton.click();
    await expect(driftButton).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => game(page, 'g.vehicle.driftMode')).toBe(false);

    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    await page.click('#screen-pause [data-action="quit-to-menu"]');
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    expectCleanConsole(testInfo);
  });

  test('switches the whole map from the pause menu', async ({}, testInfo) => {
    await page.click('[data-action="free-roam"]');
    await expect(page.locator('#hud')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();

    await page.click('#screen-pause [data-action="open-maps"]');
    await expect(page.locator('#screen-maps')).toBeVisible();
    await page.locator('#maps-list button').filter({ hasText: 'Coastal Highway' }).click();
    await expect(page.locator('#screen-maps')).toBeHidden({ timeout: BOOT_TIMEOUT });
    await expect
      .poll(() => game(page, 'g.world?.map?.id ?? null'), { timeout: BOOT_TIMEOUT })
      .toBe('coastal-highway');
    await expect.poll(() => game(page, 'g.state'), { timeout: BOOT_TIMEOUT }).toBe('driving');
    expect(await game(page, 'g.state')).toBe('driving');

    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    await page.click('#screen-pause [data-action="quit-to-menu"]');
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });

    expectCleanConsole(testInfo);
  });

  test('2. selects a vehicle in the garage', async ({}, testInfo) => {
    await page.click('[data-action="open-garage"]');
    await expect(page.locator('#screen-garage')).toBeVisible(); // Every vehicle category is listed, including the ones still locked.
    const cards = page.locator('#garage-list [role="option"]');
    expect(await cards.count()).toBeGreaterThanOrEqual(7);

    // Pick a *drivable* vehicle that is not the current one. Locked cards are
    // disabled by design, so they are filtered out rather than clicked.
    const targetId = await page.evaluate(async () => {
      const g = window.aerodrive;
      const active = g.currentVehicleId;
      const unlocked = new Set(g.saves.values.unlockedVehicles);
      const options = [...document.querySelectorAll('#garage-list [role="option"]')];
      const card = options.find(
        (option) =>
          !option.disabled &&
          unlocked.has(option.dataset.vehicleId) &&
          option.dataset.vehicleId !== active,
      );
      return card?.dataset.vehicleId ?? null;
    });
    expect(targetId, 'no second unlocked vehicle in the garage').not.toBeNull();

    await page.click(`#garage-list [data-vehicle-id="${targetId}"]`);
    await expect(page.locator('#garage-name')).not.toHaveText('—');

    await page.click('[data-action="drive-vehicle"]');

    // Entering the world from the garage loads the model and starts free roam.
    await expect(page.locator('#hud')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    await expect
      .poll(() => game(page, 'g.currentVehicleId'), { timeout: DRIVE_TIMEOUT })
      .toBe(targetId);
    expect(await game(page, 'g.state')).toBe('driving');
    await expect(page.locator('#screen-main')).toBeHidden();

    expectCleanConsole(testInfo);
  });

  test('3. accelerates and steers the car on the map', async ({}, testInfo) => {
    // A software rasteriser runs this at single-digit FPS, so any assertion
    // phrased in wall-clock seconds would be measuring SwiftShader rather than
    // the game. Everything below waits on *simulated* progress instead.
    const odometerStart = await game(page, 'g.vehicle.telemetry.odometer');

    await page.keyboard.down('ArrowUp');
    await expect
      .poll(() => game(page, 'g.vehicle.telemetry.speedKmh'), {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeGreaterThan(10);

    // The HUD must reflect the same number the simulation reports.
    const shown = Number(await page.locator('#hud-speed').textContent());
    expect(shown).toBeGreaterThan(5);

    // Steering must change the heading, not just the wheels.
    const headingBefore = await yaw(page);
    await page.keyboard.down('ArrowLeft');
    await expect
      .poll(async () => Math.abs((await yaw(page)) - headingBefore), {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeGreaterThan(0.15);
    await page.keyboard.up('ArrowLeft');
    await page.keyboard.up('ArrowUp');

    // The car must have actually covered ground, not just spun its wheels.
    await expect
      .poll(async () => (await game(page, 'g.vehicle.telemetry.odometer')) - odometerStart, {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeGreaterThan(20);

    // The car must still be on the ground, not sunk through the terrain.
    const groundGap = await page.evaluate(() => {
      const g = window.aerodrive;
      const p = g.vehicle.position();
      return p.y - g.world.heightAt(p.x, p.z);
    });
    expect(groundGap).toBeGreaterThan(-2);
    expect(groundGap).toBeLessThan(5);

    expectCleanConsole(testInfo);
  });

  test('4. brakes, then reverses', async ({}, testInfo) => {
    // Held on the brake, the car must come to rest and then select reverse.
    //
    // Those two outcomes arrive within one poll interval of each other — the gearbox
    // engages reverse the moment the wheels stop — so polling for "speed below 2 km/h"
    // alone is a race: the reverse drive can lift the car back over 2 km/h before the
    // next sample. The poll therefore accepts either a near-zero speed or an already
    // engaged reverse gear, and the assertions below pin down which one happened.
    await page.keyboard.down('ArrowDown');
    await expect
      .poll(
        async () => {
          const gear = await page.locator('#hud-gear').textContent();
          if (gear === 'R') return -1;
          return Math.abs(await game(page, 'g.vehicle.telemetry.forwardSpeed'));
        },
        { timeout: DRIVE_TIMEOUT, intervals: [200] },
      )
      .toBeLessThan(2);

    // Reverse must select and actually drive the car backwards (negative forward speed).
    await expect
      .poll(() => game(page, 'g.vehicle.telemetry.forwardSpeed'), {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeLessThan(-1);
    const gear = await page.locator('#hud-gear').textContent();
    expect(gear).toBe('R');
    await page.keyboard.up('ArrowDown');

    await expect
      .poll(() => game(page, 'g.vehicle.telemetry.speedKmh'), {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeLessThan(2);

    expectCleanConsole(testInfo);
  });

  test('5. collides with the world without falling through it', async ({}, testInfo) => {
    // Drive forward long enough to reach roadside geometry and any obstacles.
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(6000);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => {
      const g = window.aerodrive;
      const p = g.vehicle.position();
      return {
        finite: Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
        aboveGround: p.y - g.world.heightAt(p.x, p.z) > -3,
        damage: g.vehicle.telemetry.damage,
      };
    });
    expect(after.finite).toBe(true);
    expect(after.aboveGround).toBe(true);
    expect(after.damage).toBeGreaterThanOrEqual(0);
    expect(after.damage).toBeLessThanOrEqual(100);

    expectCleanConsole(testInfo);
  });

  test('6. recovers the vehicle with R', async ({}, testInfo) => {
    await page.keyboard.press('KeyR');
    await expect
      .poll(() => game(page, 'g.vehicle.telemetry.speedKmh'), {
        timeout: DRIVE_TIMEOUT,
        intervals: [200],
      })
      .toBeLessThan(3);

    const upright = await page.evaluate(() => {
      const g = window.aerodrive;
      const p = g.vehicle.position();
      return {
        gap: p.y - g.world.heightAt(p.x, p.z),
        damage: g.vehicle.telemetry.damage,
      };
    });
    // Recovery places the car above the road and repairs it.
    expect(upright.gap).toBeGreaterThan(-2);
    expect(upright.gap).toBeLessThan(3);

    expectCleanConsole(testInfo);
  });

  test('7. cycles the camera views with C', async ({}, testInfo) => {
    const first = await game(page, 'g.camera.mode');
    const modes = [first];

    // C is edge-triggered and sampled once per frame. At the single-digit frame
    // rates a software rasteriser manages, two presses inside one frame would
    // collapse into one toggle, so each press is confirmed before the next.
    for (let i = 0; i < 4; i++) {
      const previous = modes[modes.length - 1];
      await page.keyboard.press('KeyC');
      await expect.poll(() => game(page, 'g.camera.mode')).not.toBe(previous);
      modes.push(await game(page, 'g.camera.mode'));
    }

    // Every camera mode in the rig must be reachable by tapping C, and the cycle
    // must return to where it started.
    const unique = new Set(modes);
    expect(unique.size).toBeGreaterThanOrEqual(4);
    expect(unique.has('chase')).toBe(true);
    expect(modes[modes.length - 1]).toBe(first);

    // The cockpit eye must sit under the roofline rather than floating over the
    // car, and the player's model must carry the cabin that the camera looks
    // through. Traffic deliberately does not build this extra geometry.
    const cabin = await page.evaluate(() => {
      const g = window.aerodrive;
      const body = g.vehicle.object3D.userData.bodyMesh;
      body.geometry.computeBoundingBox();
      return {
        eyeY: g.vehicle.definition.cameraPositions.cockpit.y,
        roofY: body.geometry.boundingBox.max.y,
        interior: Boolean(g.vehicle.object3D.userData.interior),
      };
    });
    expect(cabin.eyeY).toBeLessThan(cabin.roofY);
    expect(cabin.interior).toBe(true);

    expectCleanConsole(testInfo);
  });

  test('7b. honks once per press, not once per frame while held', async ({}, testInfo) => {
    await page.evaluate(() => {
      const g = window.aerodrive;
      window.__hornCount = 0;
      const original = g.audio.horn.bind(g.audio);
      g.audio.horn = () => {
        window.__hornCount += 1;
        original();
      };
    });

    await page.keyboard.down('KeyF');
    await page.waitForTimeout(600);
    await page.keyboard.up('KeyF');
    expect(await game(page, 'window.__hornCount')).toBe(1);

    await page.keyboard.press('KeyF');
    await expect.poll(() => game(page, 'window.__hornCount')).toBe(2);

    expectCleanConsole(testInfo);
  });

  test('8. opens and closes the pause menu', async ({}, testInfo) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    expect(await game(page, 'g.state')).toBe('paused');

    // Pausing must stop the simulation, not just cover the screen.
    const speedAtPause = await game(page, 'g.vehicle.telemetry.speedKmh');
    await page.waitForTimeout(1200);
    expect(await game(page, 'g.vehicle.telemetry.speedKmh')).toBeCloseTo(speedAtPause, 3);

    await page.click('[data-action="resume"]');
    await expect(page.locator('#screen-pause')).toBeHidden();
    expect(await game(page, 'g.state')).toBe('driving');

    expectCleanConsole(testInfo);
  });

  test('9. changes settings and applies them to the renderer', async ({}, testInfo) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    // Several screens carry an `open-settings` button, and the hidden ones are
    // still in the DOM — scope the click to the screen that is actually open.
    await page.click('#screen-pause [data-action="open-settings"]');
    await expect(page.locator('#screen-settings')).toBeVisible();

    await page.selectOption('[data-setting="preset"]', 'potato');
    await page.locator('[data-setting="trafficDensity"]').fill('0');
    await page.locator('[data-setting="viewDistance"]').fill('400');

    // Settings must reach the live systems, not just the form.
    await expect.poll(() => game(page, "g.settings.get('preset')")).toBe('potato');
    await expect.poll(() => game(page, "g.settings.get('trafficDensity')")).toBe(0);
    await expect.poll(() => game(page, 'g.renderer.settings.renderScale')).toBeLessThanOrEqual(0.7);
    expect(await game(page, 'g.renderer.settings.shadows')).toBe('off');
    // The camera's far plane follows the view distance so the near/far ratio
    // stays sane. `g.camera` is the rig; the projection camera lives on the
    // renderer.
    expect(await game(page, 'g.renderer.camera.far')).toBeLessThanOrEqual(400);

    // And they must reach storage so a reload keeps them. Read the raw entry
    // rather than the live store, or this would pass even if persisting had
    // silently stopped working. Writes are debounced, hence the poll.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('aerodrive.settings');
            return raw ? JSON.parse(raw).preset : null;
          }),
        { timeout: 10_000 },
      )
      .toBe('potato');

    expectCleanConsole(testInfo);
  });

  test('10. persists settings and progress across a reload', async ({}, testInfo) => {
    await page.click('#screen-settings [data-action="back"]');
    await expect(page.locator('#screen-pause')).toBeVisible();
    await page.click('#screen-pause [data-action="quit-to-menu"]');
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: DRIVE_TIMEOUT });

    const vehicleBefore = await game(page, 'g.currentVehicleId');
    const visitedBefore = await game(page, 'g.saves.values.visitedMaps.length');

    await page.reload();
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: BOOT_TIMEOUT });

    expect(await game(page, "g.settings.get('preset')")).toBe('potato');
    expect(await game(page, "g.settings.get('trafficDensity')")).toBe(0);
    // The vehicle chosen in the garage and the discovered map must survive too.
    expect(await game(page, 'g.saves.values.selectedVehicle')).toBe(vehicleBefore);
    expect(await game(page, 'g.saves.values.visitedMaps.length')).toBeGreaterThanOrEqual(
      visitedBefore,
    );

    expectCleanConsole(testInfo);
  });

  test('11. applies weather, wet grip, skid marks and the time of day', async ({}, testInfo) => {
    // Scenario 9 left the preset on Potato, which disables skid marks and
    // traffic. Low keeps them on while still being survivable on a software
    // rasteriser.
    await page.click('[data-action="open-settings"]');
    await expect(page.locator('#screen-settings')).toBeVisible();
    await page.selectOption('[data-setting="preset"]', 'low');
    await page.selectOption('[data-setting="weather"]', 'rain');
    await page.selectOption('[data-setting="transmission"]', 'manual');
    await page.locator('[data-setting="timeOfDay"]').fill('21');
    await page.click('#screen-settings [data-action="back"]');
    await expect(page.locator('#screen-main')).toBeVisible();

    // Every one of those must be a real state change, not a form value.
    await expect.poll(() => game(page, 'g.settings.get("weather")')).toBe('rain');
    await expect.poll(() => game(page, 'g.weather.kind')).toBe('rain');
    await expect.poll(() => game(page, 'g.settings.get("transmission")')).toBe('manual');
    await expect.poll(() => game(page, 'g.settings.get("timeOfDay")')).toBe(21);

    await page.click('[data-action="quick-drive"]');
    await expect.poll(() => game(page, 'g.state'), { timeout: DRIVE_TIMEOUT }).toBe('driving');

    // The manual gearbox setting has to reach the vehicle that was already built.
    expect(await game(page, 'g.vehicle.gearbox.manual')).toBe(true);

    // The sky must be night, allowing for the clock running on while we assert.
    await expect
      .poll(() => game(page, 'parseInt(g.environment.daylight.clock, 10)'), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(20);
    expect(await game(page, 'g.environment.daylight.isNight')).toBe(true);

    // Rain soaks the road: grip under the car must drop, and the road material
    // must darken with it.
    await expect
      .poll(() => game(page, 'g.weather.wetness'), { timeout: 90_000 })
      .toBeGreaterThan(0.3);
    await expect
      .poll(() => game(page, 'g.vehicle.gripMultiplier'), { timeout: 30_000 })
      .toBeLessThan(1);
    expect(await game(page, 'g.world.roads.wetness')).toBeGreaterThan(0);

    // Now make it skid, and check the marks are really laid down.
    await page.keyboard.down('w');
    await page.waitForTimeout(4000);
    await page.keyboard.down('Space');
    await page.waitForTimeout(3000);
    await page.keyboard.up('Space');
    await page.keyboard.up('w');

    await expect
      .poll(() => game(page, 'g.effects.marks.quadCount'), { timeout: 60_000 })
      .toBeGreaterThan(0);
    expect(await game(page, 'g.effects.skidMarksEnabled')).toBe(true);

    expectCleanConsole(testInfo);
  });

  test('12. draws a world map from the live world', async ({}, testInfo) => {
    await page.keyboard.press('Escape');
    await expect(page.locator('#screen-pause')).toBeVisible();
    await page.click('#screen-pause [data-action="open-worldmap"]');
    await expect(page.locator('#screen-worldmap')).toBeVisible();

    // The canvas must actually have been painted, not left blank — the map is
    // drawn on demand and a mistake there produces an empty rectangle that no
    // unit test would notice.
    const paintedSamples = await page.evaluate(() => {
      const canvas = document.getElementById('worldmap-canvas');
      const context = canvas.getContext('2d');
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let bright = 0;
      for (let i = 0; i < data.length; i += 40) {
        if (data[i] + data[i + 1] + data[i + 2] > 30) bright += 1;
      }
      return bright;
    });
    expect(paintedSamples).toBeGreaterThan(0);

    // And the side panel must be populated from the built world.
    await expect(page.locator('#worldmap-summary')).toHaveText(/roads/i);
    expect(await page.locator('#worldmap-locations li').count()).toBeGreaterThan(2);
    const listed = await page.locator('#worldmap-locations').textContent();
    expect(listed).toMatch(/Garage|Recovery|Fuel/);

    await page.click('#screen-worldmap [data-action="back"]');
    await expect(page.locator('#screen-pause')).toBeVisible();
    expectCleanConsole(testInfo);
  });

  test('13. lists and starts the braking-distance challenge', async ({}, testInfo) => {
    await page.click('#screen-pause [data-action="quit-to-menu"]');
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    await page.click('[data-action="open-challenges"]');
    await expect(page.locator('#screen-challenges')).toBeVisible();

    const cards = page.locator('#challenges-list [role="option"]');
    expect(await cards.count()).toBe(9);
    const listText = await page.locator('#challenges-list').textContent();
    expect(listText).toMatch(/Braking Distance Test/);
    expect(listText).toMatch(/Parts Delivery/);

    // Starting one must load its map and put a live objective on the HUD rather
    // than leaving a button that does nothing.
    await page.click('#screen-challenges [role="option"]:has-text("Braking Distance Test")');
    await expect.poll(() => game(page, 'g.state'), { timeout: BOOT_TIMEOUT }).toBe('driving');
    expect(await game(page, 'g.mission && g.mission.challenge.id')).toBe('desert-braking-test');
    expect(await game(page, 'g.mission.status')).toBe('running');
    await expect(page.locator('#hud-objective')).toBeVisible();
    await expect(page.locator('#hud-objective-detail')).toHaveText(/100/);

    expectCleanConsole(testInfo);
  });

  test('14. drives over a bridge and through a tunnel', async ({}, testInfo) => {
    // Structures are the one part of the world where the road is NOT on the
    // ground: a deck is metres above it and a bore is metres under it. Every
    // claim about them is a physics claim, so it is checked in the browser — a
    // unit test can prove the geometry exists, only this can prove the car
    // stands on it.
    // The suite shares one booted page, but this scenario is also runnable on its
    // own, so wait for a live game before touching the state machine.
    await expect
      .poll(() => game(page, 'g ? g.state : null'), { timeout: BOOT_TIMEOUT })
      .toMatch(/^(menu|driving|paused)$/);

    // Back to the menu first, whatever state the previous scenario left behind.
    if ((await game(page, 'g.state')) !== 'menu') {
      await page.keyboard.press('Escape');
      await expect(page.locator('#screen-pause')).toBeVisible({ timeout: DRIVE_TIMEOUT });
      await page.click('#screen-pause [data-action="quit-to-menu"]');
    }
    await expect(page.locator('#screen-main')).toBeVisible({ timeout: DRIVE_TIMEOUT });
    await page.evaluate(() => window.aerodrive.loadMap('alpine-valley', {}));
    await expect
      .poll(() => game(page, 'g.world && g.world.map.id'), { timeout: BOOT_TIMEOUT })
      .toBe('alpine-valley');
    await page.evaluate(() => window.aerodrive.startDriving({}));
    await expect.poll(() => game(page, 'g.state'), { timeout: BOOT_TIMEOUT }).toBe('driving');

    const built = await game(
      page,
      `({
        stats: g.world.structures.stats,
        // Meshes only: the group also carries the tunnels' point lights, which
        // have no geometry at all.
        meshes: g.world.structures.group.children
          .filter((child) => child.isMesh)
          .map((child) => ({
            name: child.name,
            triangles: child.geometry.index ? child.geometry.index.count / 3 : 0,
          })),
        lights: g.world.structures.group.children.filter((child) => child.isPointLight).length,
      })`,
    );
    expect(built.stats.bridges).toBeGreaterThan(0);
    expect(built.stats.tunnels).toBeGreaterThan(0);
    // A deck, two parapets, a tube, a lamp strip and two portals per structure.
    expect(built.meshes.length).toBeGreaterThan(built.stats.bridges * 2 + built.stats.tunnels * 3);
    for (const mesh of built.meshes) expect(mesh.triangles).toBeGreaterThan(2);
    expect(built.meshes.some((mesh) => mesh.name.includes('tunnel-shell'))).toBe(true);
    expect(built.meshes.some((mesh) => mesh.name.includes('bridge-deck'))).toBe(true);

    // And the tunnel interior is lit by actual lights, not merely painted with an
    // emissive strip. Gated by the graphics preset, so this is asserted on the
    // low preset the suite runs at, where it must still be true.
    expect(built.lights).toBe(built.stats.lights);
    expect(built.lights).toBeGreaterThan(0);

    /** Drop the car at the midpoint of a structure and let the suspension settle. */
    const drop = (type) =>
      page.evaluate((wanted) => {
        const g = window.aerodrive;
        const span = g.world.roads.allStructures().find((entry) => entry.type === wanted);
        const road = span.road;
        const midpoint = road.centreline[Math.round((span.startIndex + span.endIndex) / 2)];
        g.vehicle.recover({
          x: midpoint.x,
          y: midpoint.y + 1.6,
          z: midpoint.z,
          heading: road.directionAt(midpoint),
        });
        return {
          roadName: road.name,
          roadY: midpoint.y,
          groundY: g.world.heightAt(midpoint.x, midpoint.z),
          length: span.length,
        };
      }, type);

    const settle = (roadY) =>
      expect
        .poll(async () => Math.abs((await game(page, 'g.vehicle.position().y')) - roadY), {
          timeout: DRIVE_TIMEOUT,
          intervals: [250],
        })
        .toBeLessThan(3);

    // --- The bridge: the car stands on the deck, not on the valley floor -------
    const bridge = await drop('bridge');
    expect(bridge.length).toBeGreaterThan(20);
    // The deck really is over a gap, or this proves nothing.
    expect(bridge.roadY - bridge.groundY).toBeGreaterThan(2);
    await settle(bridge.roadY);
    // And once it has settled, the ground under it is still the valley floor.
    const afterBridge = await page.evaluate(() => {
      const p = window.aerodrive.vehicle.position();
      return p.y - window.aerodrive.world.heightAt(p.x, p.z);
    });
    expect(afterBridge).toBeGreaterThan(2);

    // --- The tunnel: the car stays on the road under the hill -----------------
    const tunnel = await drop('tunnel');
    expect(tunnel.length).toBeGreaterThan(20);
    // The hill really is over the road, or this proves nothing.
    expect(tunnel.groundY - tunnel.roadY).toBeGreaterThan(4);
    await settle(tunnel.roadY);
    // The heightfield must not push a car out of a hill it is underneath: the
    // car is inside the terrain and must simply stay there, on the road.
    const afterTunnel = await page.evaluate(() => {
      const g = window.aerodrive;
      const p = g.vehicle.position();
      return { above: g.world.heightAt(p.x, p.z) - p.y, speed: g.vehicle.telemetry.speedKmh };
    });
    expect(afterTunnel.above).toBeGreaterThan(4);

    // The car can drive out of it: a short burst of throttle moves it along the
    // bore without it being ejected through the ceiling.
    const start = await game(page, 'g.vehicle.telemetry.odometer');
    await page.keyboard.down('ArrowUp');
    await expect
      .poll(async () => (await game(page, 'g.vehicle.telemetry.odometer')) - start, {
        timeout: DRIVE_TIMEOUT,
        intervals: [250],
      })
      .toBeGreaterThan(10);
    await page.keyboard.up('ArrowUp');
    expect(await game(page, 'g.vehicle.telemetry.damage')).toBeLessThan(0.4);

    expectCleanConsole(testInfo);
  });
});
