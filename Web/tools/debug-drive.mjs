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
await page.goto('http://127.0.0.1:4173/');
await page.locator('#screen-main').waitFor({ state: 'visible', timeout: 120000 });
await page.click('[data-action="quick-drive"]');
await page.locator('#hud').waitFor({ state: 'visible', timeout: 60000 });
await page.keyboard.down('ArrowUp');
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const g = window.aerodrive;
    const v = g.vehicle;
    const p = v.position();
    const t = v.telemetry;
    return {
      speed: +t.speedKmh.toFixed(1),
      fwd: +t.forwardSpeed.toFixed(2),
      accel: +t.acceleration.toFixed(2),
      rpm: Math.round(t.rpm),
      gear: t.gear,
      surface: t.onSurface,
      slip: +t.wheelSlip.toFixed(2),
      x: +p.x.toFixed(1),
      y: +p.y.toFixed(1),
      z: +p.z.toFixed(1),
      ground: +g.world.heightAt(p.x, p.z).toFixed(1),
      grade: +(p.y - g.world.heightAt(p.x, p.z)).toFixed(2),
    };
  });
  console.log(JSON.stringify(s));
}
await browser.close();
