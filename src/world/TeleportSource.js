import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import { WorldObject } from './WorldObject.js';
import { ensurePortalSpark, spawnRing } from './effects.js';

/** Minimum gap (ms) between two warps from the same source (debounce). */
const TELEPORT_LOCK_MS = 600;
/** Defaults when the Tiled object omits these properties. */
const DEFAULT_RADIUS = 44;
const DEFAULT_RETAIN = 0.6;

/**
 * A teleporter entrance: a breathing portal with inward-pulled motes and a
 * sensor body. When a brother enters (mid-flight), the pair warps to this
 * source's destination. The destination is resolved by the manager and set as
 * {@link destination}; each source keeps its own debounce.
 */
export class TeleportSource extends WorldObject {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').WorldObjectDef} def  Uses `radius`, `retain`, `dest`.
   */
  constructor(scene, def) {
    super(scene, def);
    /** Radius (after defaulting). */
    this.radius = def.radius ?? DEFAULT_RADIUS;
    /** Velocity kept through the warp. */
    this.retain = def.retain ?? DEFAULT_RETAIN;
    /** Name of the destination target (or `null` ⇒ first); resolved by manager. */
    this.dest = def.dest ?? def.target ?? null;
    /** @type {import('./TeleportTarget.js').TeleportTarget|null} Set by the manager. */
    this.destination = null;
    /** Wall-clock ms before which further hits are ignored. */
    this._lockUntil = 0;

    const T = Config.anim.teleporter;
    const { x, y } = def;
    const sr = this.radius;

    // Source (entrance) — breathing fill.
    this.gfx = scene.add.circle(x, y, sr, 0x9b59b6, 0.5);
    scene.tweens.add({
      targets: this.gfx,
      fillAlpha: T.pulseAlpha,
      duration: T.pulseDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    // Motes that pop in at random rim points and are pulled to centre.
    ensurePortalSpark(scene);
    // Normalise a mote's spawn position to a centre-relative offset whether
    // Phaser reports it local to the emitter or in world space.
    const offset = (p) => ({
      x: Math.abs(p.x) > sr + 1 ? p.x - x : p.x,
      y: Math.abs(p.y) > sr + 1 ? p.y - y : p.y,
    });
    scene.add
      .particles(x, y, 'portalSpark', {
        lifespan: T.pullLifespan,
        quantity: T.pullQuantity,
        frequency: T.pullFrequency,
        tint: 0xb37feb,
        blendMode: 'ADD',
        scale: { start: 0.85, end: 0 },
        alpha: { start: 1, end: 0 },
        // Spawn on the rim (a circle's getRandomPoint returns an interior point,
        // so supply one that lands on the edge).
        emitZone: {
          type: 'random',
          source: {
            getRandomPoint: (point) => {
              const a = Math.random() * Math.PI * 2;
              point.x = Math.cos(a) * sr;
              point.y = Math.sin(a) * sr;
              return point;
            },
          },
        },
        // Pure inward velocity: straight toward the centre, no swirl.
        speedX: { onEmit: (p) => -offset(p).x * T.pullSpeed },
        speedY: { onEmit: (p) => -offset(p).y * T.pullSpeed },
      })
      .setDepth(2);

    this._circleBody(x, y, sr, true);
  }

  /**
   * Warp the pair to this source's destination, debounced so overlapping the
   * sensor for several frames fires only once.
   *
   * @returns {void}
   */
  onBrotherContact() {
    const dest = this.destination;
    if (!dest) return; // a source with no target is inert
    const now = this.scene.time.now;
    if (now < this._lockUntil) return;
    this._lockUntil = now + TELEPORT_LOCK_MS;

    // Punctuate the warp: a ring collapsing out of the entrance and a fresh ring
    // blooming at the exit so the eye follows source -> target.
    spawnRing(this.scene, this.def.x, this.def.y, this.radius, 0x9b59b6);
    spawnRing(this.scene, dest.point.x, dest.point.y, 18, 0xe67e22);
    sfx.teleport();

    this.scene.brothers.teleport(dest.point, this.retain);
  }
}
