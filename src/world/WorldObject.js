/**
 * Base class for everything the level places in the arena (goals, teleporter
 * sources/targets, walls, and future types). Each subclass owns its own
 * visuals, physics body, and animation, and overrides only the hooks it needs.
 * The manager ({@link WorldObjects}) builds them from the level model, routes
 * collisions to them, evaluates win conditions, and ticks the few that opt into
 * per-frame updates.
 *
 * Hooks (all optional — defaults are inert):
 * - `onBrotherContact()`  — a brother touched this object's body while a shot is
 *   in flight (collisionstart while MOVING). Teleporters use this.
 * - `isReached(brothers)` — settle-time win predicate. Goals use this.
 * - `needsUpdate` + `update(ctx)` — per-frame logic for *dynamic* objects.
 *   Defaults to off, so static objects (today: all of them) cost nothing per
 *   frame. The manager only ticks opt-in objects and culls them by viewport.
 * - `bounds()` — world AABB used for that culling.
 *
 * Game objects and bodies are torn down automatically when the scene restarts,
 * so there is no explicit destroy step.
 */
export class WorldObject {
  /** Set false by subclasses; only `true` objects are ticked each frame. */
  needsUpdate = false;

  /**
   * @param {Phaser.Scene} scene
   * @param {object} def  The level-model entry describing this object.
   */
  constructor(scene, def) {
    this.scene = scene;
    this.def = def;
  }

  /**
   * Create a circular Matter body and tag it with a back-reference so the
   * collision router can find this instance (replaces label-string matching).
   *
   * @param {number} x @param {number} y @param {number} r
   * @param {boolean} [sensor]  True for a pass-through trigger; false for a solid.
   * @param {object} [opts]     Extra Matter body options (e.g. restitution).
   * @returns {MatterJS.BodyType}
   */
  _circleBody(x, y, r, sensor = true, opts = {}) {
    const body = this.scene.matter.add.circle(x, y, r, {
      isSensor: sensor,
      isStatic: true,
      ...opts,
    });
    body.worldObject = this;
    return body;
  }

  /**
   * Create a rectangular Matter body tagged with a back-reference.
   *
   * @param {number} x @param {number} y @param {number} w @param {number} h
   * @param {boolean} [sensor]
   * @param {object} [opts]
   * @returns {MatterJS.BodyType}
   */
  _rectBody(x, y, w, h, sensor = false, opts = {}) {
    const body = this.scene.matter.add.rectangle(x, y, w, h, {
      isSensor: sensor,
      isStatic: true,
      ...opts,
    });
    body.worldObject = this;
    return body;
  }

  // Default hooks — overridden as needed.
  onBrotherContact() {}
  isReached() {
    return false;
  }
  /** @returns {Phaser.Geom.Rectangle|null} World AABB for culling, or null. */
  bounds() {
    return null;
  }
  update() {}
}
