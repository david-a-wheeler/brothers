import { Config } from '../config.js';

/**
 * Generate the small white spark texture used by teleporter motes (once per
 * scene; both source and target emitters share it).
 *
 * @param {Phaser.Scene} scene
 * @returns {void}
 */
export function ensurePortalSpark(scene) {
  if (scene.textures.exists('portalSpark')) return;
  const g = scene.add.graphics();
  g.fillStyle(0xffffff, 1).fillCircle(4, 4, 3);
  g.generateTexture('portalSpark', 8, 8);
  g.destroy();
}

/**
 * One-shot expanding-and-fading ring, used to punctuate teleport-out,
 * teleport-in, and (in a brighter form) a level win. Shared by the world
 * objects so the visual is defined in one place.
 *
 * @param {Phaser.Scene} scene
 * @param {number} x
 * @param {number} y
 * @param {number} radius  Starting radius of the ring.
 * @param {number} color   Stroke colour.
 * @returns {void}
 */
export function spawnRing(scene, x, y, radius, color) {
  const ring = scene.add.circle(x, y, radius).setStrokeStyle(3, color, 0.9).setDepth(5);
  scene.uiCamera?.ignore(ring); // world effect: keep it off the fixed HUD camera
  scene.tweens.add({
    targets: ring,
    scale: Config.anim.ring.growScale,
    alpha: 0,
    duration: Config.anim.ring.duration,
    ease: 'Cubic.Out',
    onComplete: () => ring.destroy(),
  });
}
