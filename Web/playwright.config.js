import { defineConfig, devices } from '@playwright/test';

/**
 * AERODRIVE end-to-end configuration.
 *
 * These tests deliberately run against the **production build** served by
 * `vite preview`, not the dev server. A dev server can paper over problems that
 * only appear after bundling, minification, and code splitting — which is
 * exactly where a WebAssembly-heavy game like this tends to break.
 *
 * Run with:  npm run test:e2e           (builds first, then serves `dist/`)
 *            npm run test:e2e:webkit    (Safari's engine, smoke test only)
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Software WebGL plus a full world build is slow; be patient rather than flaky.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      // Chromium runs the whole gameplay suite; the smoke test is WebKit's, and
      // running it twice would cost a boot to prove nothing new.
      testIgnore: /webkit-smoke\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        // Chromium-specific, and deliberately not global: these flags mean
        // nothing to WebKit, which is not a Chromium fork.
        launchOptions: {
          args: [
            // Headless Chromium has no GPU, so force a software rasteriser.
            // ANGLE's SwiftShader backend is the only way to get a real WebGL
            // context here.
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--disable-gpu-sandbox',
          ],
        },
      },
    },
    {
      // Safari's engine, which the gameplay suite cannot cover: no amount of
      // Chromium testing says anything about WebKit's WebGL stack. Held to one
      // smoke test so the browser matrix does not double the suite's runtime.
      name: 'webkit',
      testMatch: /webkit-smoke\.spec\.js/,
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: [
    {
      command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The same production build, served from a hosting sub-path. `vite
      // preview` always serves at the root, which is the one case a deployment
      // never faces — GitHub Pages puts every project under `/<repo>/`. See
      // `tests/e2e/subpath.spec.js`.
      command: 'node tools/serve-dist.mjs --port 4174 --mount /aerodrive/',
      url: 'http://127.0.0.1:4174/aerodrive/',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
