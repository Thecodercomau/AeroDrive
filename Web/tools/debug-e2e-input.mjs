/**
 * Diagnostic: why does the car not accelerate from keyboard input in a
 * headless browser? Dumps the input pipeline and per-wheel state.
 *
 * Run with the preview server already up:
 *   node tools/debug-e2e-input.mjs
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:4173/');
await page.locator('#screen-main').waitFor({ state: 'visible', timeout: 120000 });

const placement = await page.evaluate(() => {
  const g = window.aerodrive;
  const p = g.vehicle.position();
  const spawn = g.world.spawnPoints[0];
  return {
    state: g.state,
    spawn,
    pose: { x: p.x, y: p.y, z: p.z },
    ground: g.world.heightAt(p.x, p.z),
    heading: g.vehicle.heading ?? null,
    definition: g.vehicle.definition.id,
    drivetrain: g.vehicle.definition.drivetrain,
    spawnPoses: g.world.allSpawnPoses().map((s) => ({ x: s.x, y: s.y, z: s.z })),
  };
});
console.log('placement', JSON.stringify(placement, null, 1));

await page.click('[data-action="quick-drive"]');
await page.locator('#hud').waitFor({ state: 'visible', timeout: 60000 });
console.log('driving; state =', await page.evaluate(() => window.aerodrive.state));

await page.keyboard.down('ArrowUp');
await page.waitForTimeout(4000);

const dump = await page.evaluate(() => {
  const g = window.aerodrive;
  const v = g.vehicle;
  const c = v.controller;
  const wheels = [];
  for (let i = 0; i < c.numWheels(); i++) {
    wheels.push({
      i,
      contact: c.wheelIsInContact(i),
      engineForce: c.wheelEngineForce(i),
      brake: c.wheelBrake(i),
      steer: c.wheelSteering(i),
      slip: c.wheelFrictionSlip(i),
      sideStiffness: c.wheelSideFrictionStiffness(i),
      suspForce: c.wheelSuspensionForce(i),
      suspLen: c.wheelSuspensionLength(i),
      rot: c.wheelRotation(i),
    });
  }
  const lv = v.body.linvel();
  const p = v.position();
  return {
    telemetry: v.telemetry,
    linvel: { x: lv.x, y: lv.y, z: lv.z },
    position: { x: p.x, y: p.y, z: p.z },
    ground: g.world.heightAt(p.x, p.z),
    wheels,
    mass: v.body.mass(),
    asleep: v.body.isSleeping(),
    bodyType: v.body.bodyType(),
  };
});
console.log(JSON.stringify(dump, null, 1));
await browser.close();
