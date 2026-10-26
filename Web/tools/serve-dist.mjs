#!/usr/bin/env node
/**
 * Serve the production build under a URL prefix.
 *
 * `vite preview` only ever serves `dist/` from the root of a host, so it cannot
 * answer the question a deployment actually raises: does the build still work
 * when it is mounted at `/some-repo/` instead of `/`? GitHub Pages serves every
 * project that way, and one absolute `/assets/...` reference anywhere in the
 * bundle would break it while looking perfectly fine at the root.
 *
 * This exists to be that host, locally:
 *
 * ```bash
 * npm run build
 * node tools/serve-dist.mjs --port 4174 --mount /aerodrive/
 * # -> http://127.0.0.1:4174/aerodrive/
 * ```
 *
 * It is deliberately tiny and dependency-free — it is a test fixture, not a web
 * server. Requests outside the mount are refused rather than quietly served, so
 * a piece of the build that reaches for the root really does fail here.
 *
 * Options:
 *   --root <dir>    Directory to serve. Default `dist`.
 *   --port <n>      Port to listen on. Default 4174.
 *   --mount <path>  URL prefix, with or without slashes. Default `/aerodrive/`.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const root = resolve(option('--root', 'dist'));
const port = Number(option('--port', '4174'));
const prefix = `/${option('--mount', '/aerodrive/').replace(/^\/+|\/+$/g, '')}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

async function fileFor(relative) {
  const target = join(root, normalize(relative));
  const resolved = resolve(target);
  // Refuse anything that climbs out of the build directory.
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  try {
    const info = await stat(resolved);
    return info.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);

  if (!pathname.startsWith(prefix)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`This server only serves ${prefix} — "${pathname}" is outside the mount.\n`);
    return;
  }

  const relative = pathname.slice(prefix.length);
  // A directory request is the app's entry point; a single-page app answers any
  // unknown path with its shell too.
  const candidates =
    relative === '' || relative.endsWith('/') ? ['index.html'] : [relative, 'index.html'];

  for (const candidate of candidates) {
    const file = await fileFor(candidate);
    if (!file) continue;
    const info = await stat(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(response);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(`Not found in the build: ${relative}\n`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[serve-dist] serving ${root} at http://127.0.0.1:${port}${prefix}`);
});
