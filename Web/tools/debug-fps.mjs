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
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => {
    const g = window.aerodrive;
    const st = g.loop.stats;
    return {
      fps: +st.fps.toFixed(1),
      frameMs: +st.frameMs.toFixed(1),
      updateMs: +st.updateMs.toFixed(1),
      renderMs: +st.renderMs.toFixed(1),
      subSteps: st.subSteps,
      frames: st.frames,
      speed: +g.vehicle.telemetry.speedKmh.toFixed(1),
      rpm: Math.round(g.vehicle.telemetry.rpm),
      gear: g.vehicle.telemetry.gear,
    };
  });
  console.log(JSON.stringify(s));
}
await browser.close();
