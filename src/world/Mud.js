import { Config, Depth } from '../config.js';
import { spawnRing } from './effects.js';
import { Region } from './Region.js';

/**
 * A mud area: a body-less {@link Region} that makes a brother muddy on entry. The
 * pickup is *persistent* — the brother keeps the extra `frictionAir` after it
 * leaves the puddle (until it sheds or is washed), which is the whole mechanic —
 * so this only needs an enter hook, not an exit one.
 *
 * Reads these level-model fields (all defaulted from `Config.mud`):
 * - `viscosity`   — friction picked up on entry (persistent).
 * - `inViscosity` — extra friction only while inside (a "bog"; 0 = none).
 * - `numberTurns` — extra turns the (non-sticky) mud lingers on the brother
 *   before it shakes off at settle (0 = gone after the first shimmy).
 * - `sticky`      — sticky mud is dark and only comes off in a `cleanSticky`
 *   {@link import('./Cleaner.js').Cleaner}, never at settle (≈ infinite turns).
 *
 * See mud-plan.md.
 */
export class Mud extends Region {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.mud.viscosity;
    this._inViscosity = def.inViscosity ?? Config.mud.inViscosity;
    this.sticky = def.sticky ?? false;
    this.numberTurns = def.numberTurns ?? Config.mud.numberTurns;
    this._buildSlosh(scene); // needs this.sticky, so it can't live in _buildView
  }

  /** While-inside extra drag; the Region base registers/drops it on enter/exit. */
  get inViscosity() {
    return this._inViscosity;
  }

  /** Persistent pickup — into the sticky or loose bucket per {@link sticky}. */
  _entered(b) {
    b._pickUpMud(this.viscosity, this.sticky, this.numberTurns);
  }

  _buildView(scene, def) {
    // Runs inside super() — before this.sticky is set — so read the raw def.
    const C = Config.mud;
    return this._fillShape(scene, def, {
      color: def.sticky ? C.stickyColor : C.color,
      alpha: 0.6,
      depth: C.depth,
    });
  }

  /**
   * The slosh: a handful of blobs wandering on slow sine paths, redrawn each
   * visible frame into a Graphics **masked by this puddle's own fill**, so a blob
   * can never leak past the edge — including a concave polygon's, where clamping
   * to the AABB wouldn't be enough.
   *
   * Sticky mud gets a fraction of the amplitude and half the speed. That near
   * stillness is the whole read: it looks thick, and it looks like it isn't going
   * anywhere. Each blob carries its own phase so they don't pulse in unison.
   *
   * @param {Phaser.Scene} scene
   * @returns {void}
   */
  _buildSlosh(scene) {
    const F = Config.anim.mudFx;
    const kind = this.sticky ? F.sticky : F.normal;
    const short = Math.min(this._aabb.width, this._aabb.height);

    /** @type {{x:number, y:number, r:number, phase:number, sway:number}[]} */
    this._blobs = Array.from({ length: F.blobs }, () => {
      const home = this.randomInteriorPoint();
      return {
        x: home.x,
        y: home.y,
        r: Math.max(3, short * F.blobRadiusFrac * (0.6 + Math.random() * 0.7)),
        phase: Math.random() * Math.PI * 2,
        sway: 0.6 + Math.random() * 0.8, // each drifts at its own rate
      };
    });

    this._sloshView = scene.add.graphics().setDepth(Depth.regionFx);
    this._sloshView.setMask(this.view.createGeometryMask());
    scene.assignToWorld?.(this._sloshView);
    this._sloshKind = kind;

    this._plopSchedule(scene);
  }

  /**
   * Redraw the blobs at time `t`. Called only while the puddle is on-screen.
   *
   * @param {number} t  Scene time, ms.
   * @returns {void}
   */
  _drawSlosh(t) {
    const F = Config.anim.mudFx;
    const k = this._sloshKind;
    const g = this._sloshView;
    g.clear();
    g.fillStyle(k.tint, F.blobAlpha);
    for (const b of this._blobs) {
      const a = (t / k.period) * Math.PI * 2 * b.sway + b.phase;
      // Different multipliers on x and y, so a blob traces a slow ellipse rather
      // than sliding back and forth along one line.
      g.fillCircle(b.x + Math.cos(a) * k.amplitude, b.y + Math.sin(a * 0.7) * k.amplitude, b.r);
    }
  }

  /**
   * Queue the next plop at a random interval. Normal mud's dome swells and bursts
   * into a ripple; sticky mud's swells, holds, and sinks back without ever
   * bursting. That difference is the level telling the player, before they ever
   * touch it, that this mud does not let go.
   *
   * @param {Phaser.Scene} scene
   * @returns {void}
   */
  _plopSchedule(scene) {
    const [lo, hi] = this._sloshKind.plopEvery;
    this._plopTimer = scene.time.delayedCall(lo + Math.random() * (hi - lo), () => {
      if (this._plopVisible) this._plop(scene);
      this._plopSchedule(scene); // keep the cycle going even if we skipped one
    });
  }

  /**
   * One plop: a dome swells at a random interior point, then either bursts (a
   * ripple, via the shared {@link spawnRing}) or sinks back.
   *
   * @param {Phaser.Scene} scene
   * @returns {void}
   */
  _plop(scene) {
    const F = Config.anim.mudFx;
    const k = this._sloshKind;
    const at = this.randomInteriorPoint();
    const r = Math.max(4, Math.min(this._aabb.width, this._aabb.height) * F.plopRadiusFrac);

    const dome = scene.add.circle(at.x, at.y, r, k.tint, 0.85).setScale(0).setDepth(Depth.regionFx);
    dome.setMask(this.view.createGeometryMask()); // a dome can't bulge past the edge either
    scene.assignToWorld?.(dome);

    scene.tweens.add({
      targets: dome,
      scale: 1,
      duration: F.plopGrow,
      ease: 'Sine.Out',
      onComplete: () => {
        if (k.plopBursts) {
          spawnRing(scene, at.x, at.y, r, k.tint);
          dome.destroy();
          return;
        }
        // Sticky: hold at full size, then subside. It never releases.
        scene.tweens.add({
          targets: dome,
          scale: 0,
          delay: F.plopHold,
          duration: F.plopFall,
          ease: 'Sine.InOut',
          onComplete: () => dome.destroy(),
        });
      },
    });
  }

  /**
   * Per-frame: the base's mover containment test, then the slosh — but only while
   * the puddle is on-screen. `_plopVisible` also gates the plop timer, so an
   * unwatched puddle isn't quietly spawning domes and rings.
   *
   * @param {{view?: Phaser.Geom.Rectangle}} ctx
   * @returns {void}
   */
  update(ctx) {
    super.update(ctx);
    this._plopVisible = this.inView(ctx);
    if (!this._plopVisible) {
      if (this._sloshView.commandBuffer.length) this._sloshView.clear();
      return;
    }
    this._drawSlosh(this.scene.time.now);
  }

  /**
   * Never cull: {@link update} must keep running so it can notice this puddle
   * leaving the view and stop drawing (and stop plopping).
   *
   * @returns {null}
   */
  bounds() {
    return null;
  }
}
