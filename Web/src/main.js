import './styles/main.css';
import { Game } from './app/Game.js';

/**
 * AERODRIVE bootstrap.
 *
 * Keeps three jobs: verify the browser can actually run the game, construct the
 * application, and make sure a failure produces a readable message on screen
 * rather than a blank canvas and a console trace nobody sees.
 */

const VERSION = '0.1.0';

/** Feature-detect the minimum the renderer needs before we build anything. */
function detectCapabilities() {
  const canvas = document.createElement('canvas');
  const gl =
    canvas.getContext('webgl2') ??
    canvas.getContext('webgl') ??
    canvas.getContext('experimental-webgl');

  if (!gl) {
    return {
      ok: false,
      reason:
        'WebGL is not available in this browser. AERODRIVE needs hardware-accelerated WebGL to render the 3D world.',
      hint: 'Enable hardware acceleration in your browser settings, update your graphics drivers, or try a current version of Chrome, Edge, Firefox or Safari.',
    };
  }

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const backend = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown';

  // A rough capability hint used only for the initial graphics preset; a user can
  // always change it in Settings.
  const isSoftware =
    typeof backend === 'string' &&
    /swiftshader|software|llvmpipe|microsoft basic render/i.test(backend);

  return {
    ok: true,
    backend: String(backend),
    isSoftware,
    webgl2: Boolean(gl instanceof WebGL2RenderingContext),
  };
}

/** Replace the loading screen with a readable failure message. */
function reportFatal(title, detail) {
  const loadingLabel = document.getElementById('loading-label');
  const loadingHint = document.getElementById('loading-hint');
  const loadingBar = document.getElementById('loading-bar');
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) loadingScreen.hidden = false;
  if (loadingLabel) loadingLabel.textContent = title;
  if (loadingHint) loadingHint.textContent = detail;
  if (loadingBar) loadingBar.style.width = '0%';
}

async function start() {
  const canvas = document.getElementById('game-canvas');
  const versionElement = document.getElementById('app-version');
  if (versionElement) versionElement.textContent = VERSION;

  if (!canvas) {
    reportFatal('AERODRIVE could not start', 'The game canvas is missing from the page.');
    return;
  }

  const capabilities = detectCapabilities();
  if (!capabilities.ok) {
    reportFatal('AERODRIVE cannot run here', `${capabilities.reason} ${capabilities.hint}`);
    console.error('[AERODRIVE]', capabilities.reason);
    return;
  }
  console.info(
    `[AERODRIVE] v${VERSION} — WebGL${capabilities.webgl2 ? '2' : '1'} backend: ${capabilities.backend}`,
  );

  let game;
  try {
    game = new Game({ canvas });
    // A machine running a software rasteriser starts on Potato regardless of its
    // CPU, so the first impression is "it runs" rather than "it stutters".
    if (capabilities.isSoftware && game.settings.get('preset') === 'low') {
      game.settings.patch({ preset: 'potato' });
      game.settings.flush();
    }
    window.aerodrive = game; // deliberate: handy for debugging and for QA scripts
    await game.boot();
  } catch (error) {
    console.error('[AERODRIVE] Fatal startup error:', error);
    reportFatal(
      'AERODRIVE hit an unexpected error while starting',
      `${error?.message ?? error}. Open the browser console for the full trace.`,
    );
    return;
  }

  // Surface later failures instead of letting the game quietly stop responding.
  window.addEventListener('error', (event) => {
    console.error('[AERODRIVE] Uncaught error:', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[AERODRIVE] Unhandled promise rejection:', event.reason);
    game?.ui?.setStatus?.('An unexpected error occurred — see the console');
  });

  document.addEventListener('aerodrive:play', () => {
    game.startDriving({});
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  void start();
}
