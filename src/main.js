import { Config } from './config.js';
import { GameScene } from './scenes/GameScene.js';

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

new Phaser.Game(gameConfig);
