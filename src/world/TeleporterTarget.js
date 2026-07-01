import { Config } from '../config.js';
import { Entity } from './Entity.js';
import { ensurePortalSpark } from './effects.js';

/**
 * A teleporter exit: a calmly breathing marker with outward-bursting motes that
 * mirror a teleporter's intake. It has no body — a {@link Teleporter} references
 * it by name and warps the pair to its {@link point}. One target may serve many
 * teleporters.
 */
export class TeleporterTarget extends Entity {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def  Uses `name`, `x`, `y`.
   */
  constructor(scene, def) {
    super(scene, def);
    /** Tiled name a teleporter's `target` property selects this destination by. */
    this.name = def.name;
    /** Where the pair lands. */
    this.point = { x: def.x, y: def.y };

    const T = Config.anim.teleporter;

    // Exit marker — orange frame with a calm idle breathe.
    this.gfx = scene.add
      .rectangle(def.x, def.y, 70, 70)
      .setStrokeStyle(2, 0xe67e22, 0.6)
      .setAlpha(Config.anim.target.idleAlphaLow);
    scene.tweens.add({
      targets: this.gfx,
      alpha: Config.anim.target.idleAlphaHigh,
      duration: Config.anim.target.idleDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    // Exit motes: burst out, decelerate (friction sized to stop as they fade),
    // vanish ~halfway out. Reusing the source's frequency/quantity keeps the
    // exit rate matched to the intake.
    ensurePortalSpark(scene);
    const exitDrag = 1000 / T.exitLifespan; // px/s² per px/s -> v hits 0 at lifespan
    scene.add
      .particles(def.x, def.y, 'portalSpark', {
        lifespan: T.exitLifespan,
        quantity: T.pullQuantity,
        frequency: T.pullFrequency,
        tint: 0xe67e22, // orange, matching the marker
        blendMode: 'ADD',
        scale: { start: 0.85, end: 0 },
        alpha: { start: 1, end: 0 },
        angle: { min: 0, max: 360 }, // random outward direction
        speed: T.exitSpeed,
        accelerationX: { onEmit: (p) => -p.velocityX * exitDrag },
        accelerationY: { onEmit: (p) => -p.velocityY * exitDrag },
      })
      .setDepth(2);
  }

  /** @returns {Phaser.GameObjects.Rectangle} The exit marker receives hover/press. */
  interactiveView() {
    return this.gfx;
  }
}
