import { Config } from '../config.js';
import { WorldObject } from './WorldObject.js';
import { spawnRing } from './effects.js';

/** Goal radius when the Tiled object omits a `radius` property. */
const DEFAULT_RADIUS = 60;

/**
 * A goal — an archery target (concentric rings + a slow-rotating reticle) plus a
 * sensor body. Reaching it (a brother at rest inside, checked at settle) clears
 * the level. A level may have several; reaching any one wins.
 */
export class Goal extends WorldObject {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').WorldObjectDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    const R = def.radius ?? DEFAULT_RADIUS;
    /** Outer radius (after defaulting). */
    this.radius = R;
    /** Win zone for the settle-time distance check (see {@link isReached}). */
    this.zone = { x: def.x, y: def.y, radius: R };
    const ringBands = [
      { r: R, color: 0x145a32 }, // dark
      { r: R * 0.78, color: 0x2ecc71 }, // bright
      { r: R * 0.55, color: 0x145a32 }, // dark
      { r: R * 0.33, color: 0x2ecc71 }, // bright
      { r: R * 0.14, color: 0xeafff2 }, // bullseye
    ];
    this.gfx = scene.add.container(
      def.x,
      def.y,
      ringBands.map((b) => scene.add.circle(0, 0, b.r, b.color))
    );
    this.reticle = this._buildReticle(def.x, def.y, R);
    scene.tweens.add({
      targets: this.reticle,
      angle: 360,
      duration: Config.anim.goal.reticleRotateDuration,
      repeat: -1,
    });

    // Sensor body (a goal never blocks movement); tagged for routing, though
    // win is evaluated at settle, not on contact.
    this._circleBody(def.x, def.y, R, true);
  }

  /**
   * Settle-time win check: is either brother resting inside this goal?
   *
   * @param {import('../Brothers.js').Brothers} brothers
   * @returns {boolean}
   */
  isReached(brothers) {
    return brothers.anyInside(this.zone);
  }

  /** Celebratory one-shot when this goal clears the level: scale pop + ring. */
  celebrate() {
    const a = Config.anim.goal;
    this.scene.tweens.killTweensOf(this.gfx);
    this.gfx.setScale(1);
    // Pop the whole target once. The reticle keeps spinning independently.
    this.scene.tweens.add({
      targets: this.gfx,
      scale: a.winBurstScale,
      duration: a.winBurstDuration,
      ease: 'Back.Out',
      yoyo: true,
    });
    spawnRing(this.scene, this.def.x, this.def.y, this.radius, 0x2ecc71);
  }

  /**
   * Build the rotating crosshair/reticle: four ticks around the rim with a gap
   * over the bullseye, plus a thin outer ring, around its own origin so it spins
   * about the target's centre.
   *
   * @param {number} x @param {number} y @param {number} radius
   * @returns {Phaser.GameObjects.Graphics}
   */
  _buildReticle(x, y, radius) {
    const inner = radius * 0.85;
    const outer = radius * 1.25;
    const g = this.scene.add.graphics({ x, y });
    g.lineStyle(2, 0xffffff, 0.6);
    g.beginPath();
    g.moveTo(0, -outer);
    g.lineTo(0, -inner);
    g.moveTo(0, inner);
    g.lineTo(0, outer);
    g.moveTo(-outer, 0);
    g.lineTo(-inner, 0);
    g.moveTo(inner, 0);
    g.lineTo(outer, 0);
    g.strokePath();
    g.strokeCircle(0, 0, outer);
    return g;
  }
}
