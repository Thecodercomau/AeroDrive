import { defineConfig } from 'vite';

// AERODRIVE — Vite configuration.
//
// `base: './'` makes the production build portable: it works from a domain root
// (Cloudflare Pages / Netlify) *and* from a repository sub-path (GitHub Pages),
// so the same build artifact can be deployed anywhere without edits.
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Split the two heavy vendors so a change to game code does not
        // invalidate the (large) engine/physics chunks in the browser cache.
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Rapier's WASM build needs a moment to instantiate on cold start.
    testTimeout: 30000,
  },
});
