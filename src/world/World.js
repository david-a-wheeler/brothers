import { KINDS } from './registry.js';

/** Shared read-only empty result for {@link World#byType} misses. */
const EMPTY = [];

/**
 * Builds and owns every world object in a level, and acts as a neutral registry
 * the objects query through — it holds *no* per-type knowledge. It keeps the
 * flat list of objects plus a class → objects index (so a type's members are
 * found in O(1)), gives each object a reference to the world (`setup`), routes
 * the settle-time win check generically, and ticks the few objects that opt into
 * per-frame updates. Collisions route directly through each body's `entity`
 * back-reference, so a source/trigger "just works" when a brother reaches it.
 */
export class World {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').Level} level
   */
  constructor(scene, level) {
    this.scene = scene;
    /** The level model this world was built from (arena bounds, etc.). */
    this.level = level;
    /** @type {import('./Entity.js').Entity[]} Every object, in build order. */
    this._all = [];
    /** @type {Map<Function, import('./Entity.js').Entity[]>} Class → its members. */
    this._byType = new Map();
    /** Objects that opt into a per-frame update (none today; future dynamics). */
    this._updaters = [];

    // Build every object first (bookkeeping only), then run setup once the whole
    // world exists — so a setup may search for anything it interacts with.
    for (const def of level.objects) {
      const Cls = KINDS[def.kind];
      if (!Cls) continue; // unknown kind: ignored (forward-compatible)
      this._track(new Cls(scene, def, level));
    }
    for (const obj of this._all) obj.setup(this);
  }

  /**
   * Index an object into the world's data structures — WITHOUT running its
   * `setup`. Used during the initial build so setup can be deferred until every
   * object exists (see the constructor). Runtime callers should use {@link add}.
   *
   * @param {import('./Entity.js').Entity} obj
   * @returns {import('./Entity.js').Entity} The same object.
   */
  _track(obj) {
    this._all.push(obj);
    const bucket = this._byType.get(obj.constructor);
    if (bucket) bucket.push(obj);
    else this._byType.set(obj.constructor, [obj]);
    if (obj.needsUpdate) this._updaters.push(obj);
    return obj;
  }

  /**
   * Add an object at runtime: index it, then set it up immediately (the world
   * already exists for a late arrival, so it can resolve references at once).
   *
   * @param {import('./Entity.js').Entity} obj
   * @returns {import('./Entity.js').Entity} The same object.
   */
  add(obj) {
    this._track(obj);
    obj.setup(this);
    return obj;
  }

  /**
   * Remove an object from the world's bookkeeping (reverses {@link _track}).
   *
   * @param {import('./Entity.js').Entity} obj
   * @returns {void}
   */
  remove(obj) {
    const drop = (arr) => {
      const i = arr.indexOf(obj);
      if (i >= 0) arr.splice(i, 1);
    };
    drop(this._all);
    const bucket = this._byType.get(obj.constructor);
    if (bucket) drop(bucket);
    if (obj.needsUpdate) drop(this._updaters);
  }

  /**
   * Every object of a given class (e.g. `byType(TeleporterTarget)`), so objects can
   * find the peers they interact with. The returned array is the live internal
   * list — treat it as read-only.
   *
   * @param {Function} Cls  An {@link Entity} subclass.
   * @returns {import('./Entity.js').Entity[]}
   */
  byType(Cls) {
    return this._byType.get(Cls) || EMPTY;
  }

  /**
   * Broadcast that play has started (the first launch). Dynamic objects
   * (hazards) begin moving; static ones ignore it. Also used to re-arm on a
   * resume (dev "More turns").
   *
   * @returns {void}
   */
  notifyPlayStart() {
    for (const o of this._all) o.onPlayStart();
  }

  /**
   * Broadcast that the level has ended (win or loss) so dynamic objects freeze
   * and stop triggering during the end-of-level banner.
   *
   * @returns {void}
   */
  notifyLevelEnd() {
    for (const o of this._all) o.onLevelEnd();
  }

  /**
   * Settle-time win check: the first object whose win predicate is satisfied.
   * Generic — any object type may define a win via `isReached` (goals do today).
   *
   * @param {import('../Brothers.js').Brothers} brothers
   * @returns {import('./Entity.js').Entity|null}
   */
  firstReached(brothers) {
    return this._all.find((o) => o.isReached(brothers)) || null;
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
