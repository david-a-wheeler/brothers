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

/**
 * A translucent "this will move this way, this fast" arrow, general enough for
 * any entity with a heading and a speed (hazards use it as a pre-launch preview).
 * The shaft points along `angleDeg`, starting `offset` px from the entity centre
 * (pass radius + a gap so it sits just outside). The arrowhead spins once per
 * `spinBaseMs / speed` ms — faster entity, faster spin — so relative speeds can
 * be eyeballed. Fill is translucent (see what's underneath) over a dark outline
 * (stays visible on light art). Returns the container; the caller destroys it and
 * should first remove the spin tween via `arrow.getData('spin')`.
 *
 * @param {Phaser.Scene} scene
 * @param {{x:number, y:number, angleDeg:number, speed:number, offset:number}} opts
 * @returns {Phaser.GameObjects.Container}
 */
export function directionArrow(scene, { x, y, angleDeg, speed, offset }) {
  const A = Config.anim.arrow;
  const shaft = scene.add
    .rectangle(offset + A.length / 2, 0, A.length, A.thickness, A.color, A.fillAlpha)
    .setStrokeStyle(A.outlineWidth, A.outlineColor, A.outlineAlpha);
  // Arrowhead drawn around its own origin (points centred so it spins in place),
  // placed at the shaft tip.
  const h = A.headSize;
  const head = scene.add.graphics({ x: offset + A.length, y: 0 });
  head.fillStyle(A.color, A.fillAlpha);
  head.lineStyle(A.outlineWidth, A.outlineColor, A.outlineAlpha);
  head.beginPath();
  head.moveTo(0.9 * h, 0);
  head.lineTo(-0.5 * h, -h);
  head.lineTo(-0.5 * h, h);
  head.closePath();
  head.fillPath();
  head.strokePath();

  const arrow = scene.add
    .container(x, y, [shaft, head])
    .setRotation(Phaser.Math.DegToRad(angleDeg))
    .setDepth(5); // above world objects; translucency still reveals them
  scene.uiCamera?.ignore(arrow); // world-space cue, never on the fixed HUD camera

  const period = Phaser.Math.Clamp(A.spinBaseMs / Math.max(speed, 1e-4), A.spinMinMs, A.spinMaxMs);
  const spin = scene.tweens.add({ targets: head, angle: 360, duration: period, repeat: -1 });
  arrow.setData('spin', spin);
  return arrow;
}
