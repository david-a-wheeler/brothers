import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import { Hazard } from './Hazard.js';
import { spawnRing } from './effects.js';

/**
 * The default hazard: a pool-ball-style black "8" ball with a lit, flickering
 * fuse, bouncing around the arena as a menace to the brothers. On contact with a
 * brother it explodes and — per its {@link Hazard#mode} — either ends the level
 * ("Game over", the default) or just ends the current turn. All motion, bouncing
 * and teleporting come from {@link Hazard}; this subclass only supplies the
 * visual and the on-contact outcome.
 */
export class Bomb extends Hazard {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    const r = this.radius;
    const F = Config.anim.bomb;

    // 8-ball body: a black disc with a small white spot carrying a bold "8".
    const ball = scene.add.circle(0, 0, r, 0x111114);
    const spot = scene.add.circle(0, r * 0.05, r * 0.42, 0xffffff);
    const eight = scene.add
      .text(0, r * 0.05, '8', {
        fontSize: `${Math.round(r * 0.7)}px`,
        color: '#111114',
        fontStyle: 'bold',
      })
      .setOrigin(0.5);
    // Fuse: a short stub rising from the top, tipped by a flickering spark.
    const fuse = scene.add
      .rectangle(0, -r, Math.max(2, r * 0.12), r * 0.5, 0x6b4a2b)
      .setOrigin(0.5, 1);
    /** The spark at the fuse tip; flickered by a looping tween (no per-frame code). */
    this.spark = scene.add.circle(0, -r * 1.5, Math.max(2, r * 0.18), 0xffd479);

    this.view = scene.add.container(def.x, def.y, [ball, spot, eight, fuse, this.spark]).setDepth(4);
    scene.tweens.add({
      targets: this.spark,
      alpha: { from: 1, to: F.sparkAlphaLow },
      scale: { from: 1, to: F.sparkScaleHigh },
      duration: F.sparkFlickerDuration,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.InOut',
    });
  }

  /** A container has no intrinsic size, so give it an explicit circular hit area. */
  interactiveHitArea() {
    return [new Phaser.Geom.Circle(0, 0, this.radius), Phaser.Geom.Circle.Contains];
  }

  /**
   * A brother touched this bomb: burst + boom, then hand the outcome to the
   * scene (which owns level state — game over vs. end-of-turn).
   *
   * @param {import('./Entity.js').Entity} _actor  The brother that made contact.
   * @returns {void}
   */
  onActorContact(_actor) {
    const p = this.body.position;
    spawnRing(this.scene, p.x, p.y, this.radius, Config.anim.bomb.explosionColor);
    sfx.explode();
    this.scene.hazardStruck(this);
  }
}
