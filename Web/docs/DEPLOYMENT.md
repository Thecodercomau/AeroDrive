# Deployment

AERODRIVE is a static bundle. There is no backend, no database, and no server-side secret —
single-player free roam needs nothing but a static host.

## Build

```bash
npm ci          # reproducible install from the lockfile
npm run build   # writes dist/
npm run preview # serve dist/ locally on :4173 to check the real artifact
```

`vite.config.js` sets `base: './'`, so the bundle uses **relative** asset paths. The same `dist/`
works from a domain root and from a repository sub-path such as `https://user.github.io/aerodrive/`
with no edits. This is deliberate: it means one artifact can be promoted from a preview URL to a
project page without a rebuild.

The build splits the two heavy vendors into their own chunks (`three`, `rapier`) so a change to
game code does not invalidate them in the browser cache.

### Verify the sub-path case locally

`vite preview` always serves at the root, which is the one case a project page never faces. To serve
the build under a mount prefix instead:

```bash
npm run build
node tools/serve-dist.mjs --port 4174 --mount /aerodrive/
# -> http://127.0.0.1:4174/aerodrive/
```

That fixture serves the same `dist/` under the prefix and **refuses anything outside it**, so an
absolute `/assets/...` reference in the bundle fails loudly instead of quietly resolving at the
root. The browser suite runs exactly this check on every `npm run test:e2e` (see
`tests/e2e/subpath.spec.js`), which is the closest thing to a deployment that can be verified from
this repository.

### What `dist/` contains

```
dist/index.html                        ~15 kB   (3 kB gzip)
dist/assets/index-*.css                ~11 kB   (3 kB gzip)
dist/assets/index-*.js                ~166 kB  (53 kB gzip)  game code
dist/assets/three-*.js                ~556 kB (141 kB gzip)  Three.js
dist/assets/rapier-*.js               ~4.3 MB (1.6 MB gzip)  Rapier + its WASM
dist/favicon.svg
```

The Rapier chunk is large because `rapier3d-compat` inlines its WebAssembly as base64 so it needs
no separate network fetch or MIME configuration. That trade — a bigger first download in exchange
for a working build on any host — is deliberate, and it is why the first load shows a progress
screen rather than a blank canvas. Serve the files **compressed** (Brotli or gzip); every host
below does this automatically.

---

## GitHub Pages

1. Push the repository to GitHub.
2. Either build in CI, or build locally and commit/publish `dist/`:

```bash
npm run build
npx gh-pages -d dist          # or push dist/ to a gh-pages branch yourself
```

3. In **Settings → Pages**, choose the branch and folder (`/` for a `gh-pages` branch).

Because of the relative `base`, project pages (`/repo-name/`) work without further configuration.
If you would rather build in CI, upload `dist/` with `actions/upload-pages-artifact` and deploy with
`actions/deploy-pages`.

## Cloudflare Pages

- **Build command:** `npm ci && npm run build`
- **Build output directory:** `dist`
- **Node version:** set `NODE_VERSION=20` (or newer) in the project's environment variables.

Cloudflare applies Brotli automatically and serves `index.html` for `/`.

## Netlify

`netlify.toml` is not committed because the defaults are sufficient:

- **Build command:** `npm run build`
- **Publish directory:** `dist`

If you add client-side routes later, add a redirect from `/*` to `/index.html` with status `200`;
the current build has a single entry point and does not need one.

## Cache headers (optional, recommended)

Fingerprinted files under `assets/` are content-addressed and can be cached forever; the HTML must
not be.

```
/assets/*   Cache-Control: public, max-age=31536000, immutable
/index.html Cache-Control: public, max-age=0, must-revalidate
```

---

## Verifying a deployment

Do not assume a working local build means a working deployment. After deploying, check:

1. **The page loads and the loading screen finishes.** If it is stuck, the WASM payload is being
   blocked or served with the wrong MIME type — check the network tab for the `rapier-*.js`
   request.
2. **The console is clean.** Any `Failed to load module` means an asset path is wrong; that is the
   one class of bug `base: './'` cannot save you from if you hand-edited `dist/`.
3. **Serve it over HTTPS.** `Pointer Lock` and `Gamepad` require a secure context. `localhost` is
   treated as secure; a plain-HTTP staging URL is not, and mouse-look will silently not work.
4. **Play one full scenario:** Play → accelerate → brake → reverse → `C` to change camera → `Esc`
   to pause → Settings → reload the page → confirm the setting stuck.
5. **Check the deployed URL, not the build directory.** Load the actual HTTPS URL in a real
   browser window.

To run the automated browser suite against a deployment instead of a local build, start the server
yourself and run Playwright against it:

```bash
BASE_URL=https://your-deployment.example npx playwright test
```

(The bundled config expects `http://127.0.0.1:4173`; point `use.baseURL` at your URL or set it via
the environment variable in your own config.)

---

## Updating a deployment

```bash
git pull
npm ci
npm test          # unit + integration
npm run test:e2e  # browser gameplay, builds first
npm run build
# then re-publish dist/ by whatever mechanism the host uses
```

Never deploy a build whose tests have not been run. Never edit files inside `dist/` by hand — it is
generated, and the next build will silently discard your change.

## What is deliberately not here

- **No secrets.** Everything runs in the browser; there is nothing to leak and no `.env` required.
- **No backend.** Nothing here needs one for single-player.
- **No multiplayer.** If it is ever added, it must use an authoritative server and must never let a
  client decide a competitive outcome.
