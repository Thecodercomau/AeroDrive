/**
 * Diagnostic: geometry around the vehicle spawn.
 *
 * Symptom: at the "alpine-garage" spawn only one wheel finds ground, the engine
 * free-revs, and the car never moves. This prints the terrain profile under the
 * car and the wheel geometry so the cause is visible rather than guessed.
 *
 * Run with the preview server already up.
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
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:4173/');
await page.locator('#screen-main').waitFor({ state: 'visible', timeout: 120000 });

const report = await page.evaluate(() => {
  const g = window.aerodrive;
  const v = g.vehicle;
  const p = v.position();
  const q = v.body.rotation();

  // Terrain profile in a 12 m grid around the car.
  const profile = [];
  for (let dz = -6; dz <= 6; dz += 2) {
    const row = [];
    for (let dx = -6; dx <= 6; dx += 2) {
      row.push(Number(g.world.heightAt(p.x + dx, p.z + dz).toFixed(2)));
    }
    profile.push(row);
  }

  // Ground reach at each wheel's contact-ray location.
  const controller = v.controller;
  const wheels = [];
  for (let i = 0; i < controller.numWheels(); i++) {
    const hard = controller.wheelHardPoint(i);
    const contact = controller.wheelContactPoint(i);
    const direction = controller.wheelDirectionCs(i);
    wheels.push({
      i,
      hard: hard && { x: +hard.x.toFixed(2), y: +hard.y.toFixed(2), z: +hard.z.toFixed(2) },
      contact: contact && {
        x: +contact.x.toFixed(2),
        y: +contact.y.toFixed(2),
        z: +contact.z.toFixed(2),
      },
      direction,
      radius: controller.wheelRadius(i),
      restLength: controller.wheelSuspensionRestLength(i),
      maxTravel: controller.wheelMaxSuspensionTravel(i),
      inContact: controller.wheelIsInContact(i),
      groundHere: hard ? +g.world.heightAt(hard.x, hard.z).toFixed(2) : null,
      surfaceHere: hard ? g.world.surfaceAt(hard.x, hard.z, 0) : null,
    });
  }

  // Any static collider overlapping the car? Cast a short ray downwards from
  // the chassis centre and report what it hits.
  const ray = g.physics.raycast
    ? g.physics.raycast({ x: p.x, y: p.y + 2, z: p.z }, { x: 0, y: -1, z: 0 }, 12)
    : null;

  return {
    chassisHalfExtents: v.definition.chassisHalfExtents,
    wheelRadius: v.definition.wheelRadius,
    suspension: v.definition.suspension,
    derived: v.definition.derived,
    pose: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) },
    quaternion: { x: +q.x.toFixed(3), y: +q.y.toFixed(3), z: +q.z.toFixed(3), w: +q.w.toFixed(3) },
    groundAtCentre: +g.world.heightAt(p.x, p.z).toFixed(2),
    profile,
    wheels,
    ray: ray && {
      hit: true,
      y: +ray.point.y.toFixed(2),
      distance: +ray.distance.toFixed(2),
      surface: ray.surface,
      tag: ray.tag,
      normalY: +ray.normal.y.toFixed(3),
    },
    spawnPoseResolved: g.world.resolveSpawn('alpine-garage'),
    collideurTag: (() => {
      const t = g.physics.tagOf ? g.physics.tagOf(v.collider.handle) : null;
      return t;
    })(),
  };
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
