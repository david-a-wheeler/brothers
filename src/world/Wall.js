import { WorldObject } from './WorldObject.js';

/**
 * A solid interior wall: a tiling brick visual, a thin dark frame, and a static
 * Matter body. Solid (not a sensor), so a brother striking it triggers the snap
 * via the scene's collision router.
 */
export class Wall extends WorldObject {
  /**
   * @param {Phaser.Scene} scene
   * @param {{x:number, y:number, width:number, height:number}} def
   * @param {number} restitution  Bounce coefficient (per level).
   */
  constructor(scene, def, restitution) {
    super(scene, def);
    Wall.ensureBrickTexture(scene);
    scene.add.tileSprite(def.x, def.y, def.width, def.height, 'brick');
    scene.add.rectangle(def.x, def.y, def.width, def.height).setStrokeStyle(2, 0x2a1d15, 0.9);
    this._rectBody(def.x, def.y, def.width, def.height, false, { restitution });
  }

  /**
   * Generate a small, seamless brick-pattern texture once (offset courses of
   * bricks separated by mortar), so walls tile at any size with no image asset.
   *
   * @param {Phaser.Scene} scene
   * @returns {void}
   */
  static ensureBrickTexture(scene) {
    if (scene.textures.exists('brick')) return;
    const mortar = 0x4a3327;
    const brick = 0xb5651d;
    const bw = 24;
    const bh = 11;
    const tile = bw + 2; // brick + mortar gap
    const w = tile * 2; // two courses wide for the half-brick offset
    const h = (bh + 2) * 2;

    const g = scene.add.graphics();
    g.fillStyle(mortar, 1).fillRect(0, 0, w, h);
    g.fillStyle(brick, 1);
    g.fillRect(0, 0, bw, bh).fillRect(tile, 0, bw, bh); // course 0: flush left
    g.fillRect(tile / 2, bh + 2, bw, bh); // course 1: offset half a brick
    g.fillRect(0, bh + 2, tile / 2 - 2, bh); // left partial
    g.fillRect(tile / 2 + bw, bh + 2, tile / 2 - 2, bh); // right partial
    g.generateTexture('brick', w, h);
    g.destroy();
  }
}
