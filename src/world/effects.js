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
 * Draw the elastic tether line between two points into an existing Graphics.
 * The single source of the band's look (width/colour/alpha), shared by the live
 * game ({@link import('../Brothers.js').Brothers}) and the title-screen demo so
 * they always match. Clears the graphics first, so call it once per frame.
 *
 * @param {Phaser.GameObjects.Graphics} g
 * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
 * @returns {void}
 */
export function drawBand(g, x1, y1, x2, y2) {
  g.clear();
  g.lineStyle(4, 0xf3c969, 0.85);
  g.lineBetween(x1, y1, x2, y2);
}

/**
 * A pulsing halo ring that draws the eye to the movable ball — the "it's your
 * move" cue on the launcher, reused by the title-screen demo. A stroked circle
 * that repeatedly expands and fades; its looping tween is attached as data
 * `'pulse'` so the caller can pause/resume it. Position it each frame.
 *
 * @param {Phaser.Scene} scene
 * @param {number} x @param {number} y @param {number} radius
 * @returns {Phaser.GameObjects.Arc}
 */
export function pulsingGlow(scene, x, y, radius) {
  const ring = scene.add.circle(x, y, radius, 0xffffff, 0).setDepth(5);
  ring.setStrokeStyle(3, 0xfff2a8, 0.9);
  const pulse = scene.tweens.add({
    targets: ring,
    scale: { from: 1, to: 1.5 },
    alpha: { from: 0.8, to: 0 },
    duration: 900,
    ease: 'Sine.easeOut',
    repeat: -1,
  });
  ring.setData('pulse', pulse);
  return ring;
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
  // Arrowhead: a flat triangular blade with its tip forward on the shaft axis, so
  // the arrow always points the right way. We fake spinning it about the shaft
  // axis in 3D by oscillating only its width (scaleY): full when face-on, a thin
  // spike when edge-on. The tip sits on the axis (y = 0), so scaling never moves
  // it; the base corners (at x = 0) are what sweep in and out.
  const head = scene.add.graphics({ x: offset + A.length, y: 0 });
  head.fillStyle(A.color, A.fillAlpha);
  head.lineStyle(A.outlineWidth, A.outlineColor, A.outlineAlpha);
  head.beginPath();
  head.moveTo(A.headLength, 0); // tip, forward along the shaft
  head.lineTo(0, -A.headHalfWidth); // base corner
  head.lineTo(0, A.headHalfWidth); // base corner
  head.closePath();
  head.fillPath();
  head.strokePath();

  const arrow = scene.add
    .container(x, y, [shaft, head])
    .setRotation(Phaser.Math.DegToRad(angleDeg))
    .setDepth(5); // above world objects; translucency still reveals them
  scene.uiCamera?.ignore(arrow); // world-space cue, never on the fixed HUD camera

  // scaleY 1 -> -1 under Sine.InOut + yoyo traces a cosine, so the blade appears
  // to rotate steadily about the shaft axis (passing edge-on at scaleY 0, then
  // showing its back face). Faster hazard -> shorter half-turn -> faster spin
  // (a full revolution takes ~2 * duration).
  const duration = Phaser.Math.Clamp(A.spinBaseMs / Math.max(speed, 1e-4), A.spinMinMs, A.spinMaxMs);
  const spin = scene.tweens.add({
    targets: head,
    scaleY: { from: 1, to: -1 },
    duration,
    ease: 'Sine.InOut',
    yoyo: true,
    repeat: -1,
  });
  arrow.setData('spin', spin);
  return arrow;
}
