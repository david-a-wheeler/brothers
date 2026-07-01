import { Goal } from './Goal.js';
import { TeleportSource } from './TeleportSource.js';
import { TeleportTarget } from './TeleportTarget.js';
import { Wall } from './Wall.js';

/**
 * Maps a Tiled object class (the level model's `kind`) to its world-object
 * class. This is the *only* place that knows the set of object types — adding a
 * type is one import + one entry here (plus the class itself); the loader stays
 * type-agnostic.
 */
const KINDS = {
  goal: Goal,
  'teleporter-source': TeleportSource,
  'teleporter-target': TeleportTarget,
  wall: Wall,
};

/**
 * Builds and owns every world object in a level from `level.objects`, and gives
 * the scene a few small entry points: the settle-time win check and a culled
 * per-frame tick. Collisions route directly through each body's `worldObject`
 * back-reference, so a source/trigger "just works" when a brother reaches it.
 */
export class WorldObjects {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').Level} level
   */
  constructor(scene, level) {
    this.scene = scene;
    /** @type {import('./WorldObject.js').WorldObject[]} */
    this._all = [];
    /** @type {Goal[]} Win is "reach any goal" (checked at settle). */
    this.goals = [];
    /** Objects that opt into a per-frame update (none today; future dynamics). */
    this._updaters = [];

    for (const def of level.objects) {
      const Cls = KINDS[def.kind];
      if (!Cls) continue; // unknown kind: ignored (forward-compatible)
      const obj = new Cls(scene, def, level);
      this._all.push(obj);
      if (obj.needsUpdate) this._updaters.push(obj);
      if (obj instanceof Goal) this.goals.push(obj);
    }

    this._linkTeleporters();
  }

  /**
   * Point each teleporter source at its destination: the target whose name
   * matches the source's `dest`, or the first target if unnamed/unknown.
   *
   * @returns {void}
   */
  _linkTeleporters() {
    const targets = this._all.filter((o) => o instanceof TeleportTarget);
    if (!targets.length) return;
    const byName = new Map(targets.map((t) => [t.name, t]));
    for (const obj of this._all) {
      if (obj instanceof TeleportSource) {
        obj.destination = byName.get(obj.dest) || targets[0];
      }
    }
  }

  /**
   * Settle-time win check across all goals.
   *
   * @param {import('../Brothers.js').Brothers} brothers
   * @returns {Goal|null} The first goal reached, or null.
   */
  firstReachedGoal(brothers) {
    return this.goals.find((g) => g.isReached(brothers)) || null;
  }

  /**
   * Tick the opt-in dynamic objects, culling those outside the view. No-op while
   * `_updaters` is empty (the case today).
   *
   * @param {{view: Phaser.Geom.Rectangle}} ctx
   * @returns {void}
   */
  update(ctx) {
    for (const obj of this._updaters) {
      const b = obj.bounds();
      if (b && ctx.view && !Phaser.Geom.Intersects.RectangleToRectangle(b, ctx.view)) continue;
      obj.update(ctx);
    }
  }
}
