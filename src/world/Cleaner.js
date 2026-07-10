import { Config, Depth } from '../config.js';
import { ensureBubble } from './effects.js';
import { Region } from './Region.js';

/**
 * A cleaner area (water): a body-less {@link Region} that washes a brother's mud
 * off when it enters. Loose (normal) mud always comes off; sticky mud comes off
 * only if this area sets `cleanSticky`, so a plain puddle of water rinses off
 * ordinary mud but leaves sticky mud stuck.
 *
 * Its own `viscosity` is a small drag that applies ONLY while the brother is
 * inside (the {@link Region} base wires this up via {@link inViscosity}); it lives
 * on the area, never on the brother, so it doesn't perpetuate after exit.
 *
 * It bubbles (see {@link _buildBubbles}), and the *ultra* cleaner (`cleanSticky`)
 * fizzes: more bubbles, faster, paler, additively blended. That's the only cue
 * the player has that this water is the one that takes sticky mud off.
 *
 * Reads (defaulted from `Config.cleaner`): `viscosity`, and `cleanSticky` (bool).
 * See mud-plan.md.
 */
export class Cleaner extends Region {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.cleaner.viscosity;
    this.cleanSticky = def.cleanSticky ?? false;
    this._buildBubbles(scene);
  }

  /** The Cleaner's whole friction effect is transient (while-inside only). */
  get inViscosity() {
    return this.viscosity ?? Config.cleaner.viscosity;
  }

  /** Strip mud on entry: loose always, sticky only when this area cleans sticky. */
  _entered(b) {
    b._wash(this.cleanSticky);
  }

  _buildView(scene, def) {
    return this._fillShape(scene, def, {
      color: Config.cleaner.color,
      alpha: 0.4, // translucent, so it reads as water
      depth: Config.cleaner.depth,
    });
  }

  /**
   * Bubbles rising from inside the water and popping at its surface.
   *
   * The pop needs no code: a `deathZone` kills a particle by asking a source
   * object whether it `contains` the particle's world position, and *this region
   * is exactly that object*. With `type: 'onLeave'`, a bubble dies the instant it
   * crosses the boundary, whatever the shape — including a concave polygon, where
   * "the surface" isn't a single line. Phaser tests `particle.worldPosition`, so
   * the emitter is anchored at the origin and the spawn zone yields world points.
   *
   * @param {Phaser.Scene} scene
   * @returns {void}
   */
  _buildBubbles(scene) {
    ensureBubble(scene);
    const C = Config.anim.cleanerFx;
    const kind = this.cleanSticky ? C.ultra : C.normal;

    this.bubbles = scene.add
      .particles(0, 0, 'cleanerBubble', {
        lifespan: C.lifespan,
        frequency: kind.frequency,
        quantity: kind.quantity,
        maxAliveParticles: kind.maxAlive,
        tint: kind.tint,
        ...(kind.additive ? { blendMode: 'ADD' } : {}),
        scale: { min: kind.scale[0], max: kind.scale[1] },
        alpha: { start: 0.9, end: 0.35 }, // thins as it rises, then the surface takes it
        speedY: { min: -kind.speed[1], max: -kind.speed[0] }, // negative y is up
        speedX: { min: -C.wobble, max: C.wobble }, // a little wander, so they aren't columns
        emitZone: {
          type: 'random',
          source: { getRandomPoint: (point) => Object.assign(point, this.randomInteriorPoint()) },
        },
        // The whole pop mechanic, in one line.
        deathZone: { type: 'onLeave', source: this },
      })
      .setDepth(Depth.regionFx);

    /** Emitters run whether or not anyone is looking; {@link update} gates them. */
    this._bubblesOn = true;
    scene.assignToWorld?.(this.bubbles); // a world effect: keep it off the HUD camera
  }

  /**
   * Per-frame: the base's mover containment test, plus pausing the emitter while
   * this puddle is off-screen. An emitter belongs to the scene, not to us, so it
   * would happily go on bubbling into a puddle nobody can see.
   *
   * @param {{view?: Phaser.Geom.Rectangle}} ctx
   * @returns {void}
   */
  update(ctx) {
    super.update(ctx);
    const visible = this.inView(ctx);
    if (visible === this._bubblesOn) return; // edge-triggered: no per-frame churn
    this._bubblesOn = visible;
    if (visible) this.bubbles.start();
    else this.bubbles.stop();
  }

  /**
   * Never cull, so {@link update} keeps being called and can notice this puddle
   * leaving the view. The containment test it then runs is a couple of point
   * tests, far cheaper than the bubbling we're suppressing.
   *
   * @returns {null}
   */
  bounds() {
    return null;
  }
}
