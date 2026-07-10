import { Config } from './config.js';
import { GameScene } from './scenes/GameScene.js';
import { TitleScene } from './scenes/TitleScene.js';
import { sfx } from './Sfx.js';
import { currentIndex, listPacks, loadPack, selectLevel } from './levels.js';
import { lastLevel, lastPack, skipTitle } from './prefs.js';
import * as diag from './diag.js';

// Capture errors as early as possible so anything below (incl. pack loading and
// the whole game session) is logged and reportable. See diag.js.
diag.install();
diag.breadcrumb('boot');

// Give every Text the shared UI font by default (Phaser's built-in default is
// Courier). We wrap the `text` factory once — re-registering is a no-op since
// GameObjectFactory.register guards existing types — so `scene.add.text(...)`
// inherits Config.ui.font unless a style passes its own fontFamily (e.g. the
// title's serif). One place to set it; no per-style footgun.
const _factory = Phaser.GameObjects.GameObjectFactory.prototype;
const _text = _factory.text;
_factory.text = function (x, y, text, style) {
  return _text.call(this, x, y, text, { fontFamily: Config.ui.font, ...style });
};

/**
 * Open the pack and level the player left off on, falling back to the default
 * pack's first level. The stored values are only hints: a pack can be renamed
 * or removed and a pack can lose levels between sessions, so every step is
 * allowed to fail and is logged when it does.
 *
 * The last resort deliberately isn't handled here. If even the default pack
 * won't load there is no game to show, so we let the throw escape: boot.js
 * retries with backoff and then replaces the canvas with a Reload button —
 * the "big alert" — rather than leaving a blank screen.
 *
 * @param {Array<{id: string}>} packs  From packs/index.json, in order.
 * @returns {Promise<void>}
 */
async function openLastPlayed(packs) {
  const fallback = packs[0].id; // the default pack: first entry, not a hardcoded name
  const savedPack = lastPack();
  const savedLevel = lastLevel();

  if (savedPack && packs.some((p) => p.id === savedPack)) {
    try {
      await loadPack(savedPack);
      // selectLevel clamps, so a pack that shrank lands on its last level
      // rather than failing. Level 0 is already loaded by loadPack.
      if (savedLevel > 0) await selectLevel(savedLevel);
      diag.breadcrumb('boot: resumed', `${savedPack} level ${currentIndex() + 1}`);
      return;
    } catch (e) {
      diag.error(`boot: can't open ${savedPack} level ${savedLevel + 1}; falling back to ${fallback}`, e);
    }
  } else if (savedPack) {
    diag.breadcrumb('boot: saved pack is gone', `${savedPack} -> ${fallback}`);
  }

  await loadPack(fallback);
}

// Load a pack before the game boots, so the scene has level data ready. Top-level
// await means boot.js's `await import('./main.js')` waits for this, and a failed
// fetch becomes a retry/reload there.
const packs = await listPacks();
await openLastPlayed(packs);

/**
 * Boot the game. `Phaser` is the global from the CDN script in index.html.
 *
 * @type {Phaser.Types.Core.GameConfig}
 */
const gameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  // Auto-retry loading (incl. asset loading) to counter network problems
  loader: {
        maxRetries: 9
  },
  width: Config.view.width,
  height: Config.view.height,
  backgroundColor: Config.view.background,
  // God mode drags with the right button (see GameScene._godEditable), so the
  // browser's context menu would pop up mid-drag. This top-level flag is the
  // one that works: `scene.input.mouse` doesn't exist, so calling
  // `disableContextMenu()` from a scene silently does nothing.
  disableContextMenu: true,
  scale: {
    // RESIZE: the canvas fills the window (#game is 100vw/100vh). The HUD and
    // camera are laid out to the live size in GameScene, so the arena uses the
    // whole screen and the HUD renders at real pixels (see _computeLayout).
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: 0 }, // we use a top-down arena: nothing falls
      debug: false, // flip to true to see physics bodies while tuning
    },
  },
  // Phaser auto-starts the FIRST scene in this list. Both are always registered
  // (so each can start the other); order alone picks the boot destination —
  // title on a first visit, straight to the game once the player has pressed Play
  // (persisted in localStorage; see prefs.js and the menu's "Show title screen").
  scene: skipTitle() ? [GameScene, TitleScene] : [TitleScene, GameScene],
};

const game = new Phaser.Game(gameConfig);

// UNCOMMENT THIS BLOCK TO TEST THE ERROR DIAGNOSTICS.
// This throws an uncaught error ~2.5s after boot so the error
// banner / problem report can be exercised.
// setTimeout(() => {
//   throw new Error('TEST: diagnostics smoke-test error (in main.js)');
// }, 2500);

// Don't burn CPU while the page isn't being shown (hidden tab / minimized
// window). Browsers already throttle requestAnimationFrame for hidden
// tabs, but the Web Audio thread keeps running, so we suspend it; we
// also sleep Phaser's loop explicitly to cover browsers that still fire
// a throttled rAF. The visibilitychange event fires regardless of rAF,
// so we can always wake back up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    sfx.suspend();
    game.loop?.sleep?.();
  } else {
    game.loop?.wake?.();
    sfx.resume();
  }
});
