import { Config } from './config.js';
import { GameScene } from './scenes/GameScene.js';
import { sfx } from './Sfx.js';
import { listPacks, loadPack } from './levels.js';

// Load the first pack before the game boots, so the scene has level data ready.
// The starting pack is just the first entry in packs/index.json (no hardcoded
// pack name). Top-level await means boot.js's `await import('./main.js')` waits
// for this, and a failed fetch becomes a retry/reload there.
const packs = await listPacks();
await loadPack(packs[0].id);

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
  scene: [GameScene],
};

const game = new Phaser.Game(gameConfig);

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
