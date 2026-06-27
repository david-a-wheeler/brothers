import { Config } from './config.js';
import { GameScene } from './scenes/GameScene.js';
import { sfx } from './Sfx.js';

/**
 * Boot the game. `Phaser` is the global from the CDN script in index.html.
 *
 * @type {Phaser.Types.Core.GameConfig}
 */
const gameConfig = {
  type: Phaser.AUTO,
  parent: 'game',
  width: Config.view.width,
  height: Config.view.height,
  backgroundColor: Config.view.background,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  physics: {
    default: 'matter',
    matter: {
      gravity: { x: 0, y: 0 }, // top-down arena: nothing falls
      debug: false, // flip to true to see physics bodies while tuning
    },
  },
  scene: [GameScene],
};

const game = new Phaser.Game(gameConfig);

// Don't burn CPU while the page isn't being shown (hidden tab / minimized
// window). Browsers already throttle requestAnimationFrame for hidden tabs, but
// the Web Audio thread keeps running, so we suspend it; we also sleep Phaser's
// loop explicitly to cover browsers that still fire a throttled rAF. The
// visibilitychange event fires regardless of rAF, so we can always wake back up.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    sfx.suspend();
    game.loop?.sleep?.();
  } else {
    game.loop?.wake?.();
    sfx.resume();
  }
});
