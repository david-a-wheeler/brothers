/**
 * Base class for everything the level places in the arena (goals, teleporter
 * sources/targets, walls, and future types). Each subclass owns its own
 * visuals, physics body, and animation, and overrides only the hooks it needs.
 * The manager ({@link World}) builds them from the level model, routes
 * collisions to them, evaluates win conditions, and ticks the few that opt into
 * per-frame updates.
 *
 * The hooks below are the entire contract between a world object and the rest of
 * the game. Every subclass is driven purely through them, and the base defaults
 * are all inert, so a subclass overrides only the ones it cares about and
 * inherits do-nothing behaviour for the rest. The two ways the world reacts to
 * the brothers are deliberately split by *timing*:
 *
 * - `setup(world)` — **one-time initialisation, run once after every object in
 *   the level has been created.** The default stores `this.world = world`, so
 *   every object can reach the manager (and thus its peers) later. Because it
 *   runs post-build, a subclass may override it to search the world —
 *   `world.byType(SomeClass)` — for objects it interacts with, resolving those
 *   references eagerly here or leaving the lookup lazy (a teleporter resolves
 *   lazily, at trigger time, so it always sees the current world). Override as
 *   `setup(world) { super.setup(world); … }` to keep the `this.world` default.
 *
 * - `onBrotherContact()` — **fired the instant a brother's body overlaps this
 *   object's sensor body, mid-flight** (Matter `collisionstart` while the shot
 *   phase is MOVING; the scene's collision router looks up the struck body's
 *   `entity` and calls this). Use it for triggers that must act *on touch*,
 *   before the balls settle — e.g. a teleporter warps the pair the moment they
 *   enter. Only sensor (pass-through) bodies get here; solid bodies (walls) are
 *   handled by the scene as a snap and never call this. May fire on several
 *   consecutive frames while the overlap persists, so a subclass that must act
 *   once per pass debounces itself (see Teleporter). Default: no-op.
 *
 * - `isReached(brothers)` — **a settle-time predicate, polled once after both
 *   balls have come to rest** (from `World.firstReached`, called in
 *   `_resolveTurn`). Not tied to a physics contact: it asks a geometric
 *   question ("is a brother at rest inside my zone?") via `brothers.anyInside`.
 *   Return `true` to signal this object's win condition is met — the manager
 *   wins the level on the first object that does (goals today, but any type may
 *   define one). Use this (not `onBrotherContact`) for anything decided by where
 *   the balls *end up*, not what they touched in flight. When it wins, the
 *   manager calls `celebrate()` on that object. Default: returns `false`.
 *
 * - `needsUpdate` + `update(ctx)` — **opt-in per-frame tick for *dynamic*
 *   objects** (moving hazards, timed gates, …). Static objects leave
 *   `needsUpdate = false` (its default) and are never ticked, so they cost
 *   nothing per frame — today every object is static, so this path is dormant.
 *   Set `needsUpdate = true` to be added to the manager's updater list; then
 *   `update(ctx)` runs each frame with `ctx = { brothers, view }` (`view` is the
 *   camera's world-space `Geom.Rectangle`). The manager skips the call when the
 *   object's `bounds()` lies outside `view`, so off-screen objects are free.
 *
 * - `bounds()` — **the world-space AABB used to cull `update`.** Return a
 *   `Phaser.Geom.Rectangle` covering the object so the manager can test it
 *   against the viewport; return `null` (the default) to always tick when
 *   `needsUpdate` is set (no culling). Only consulted for objects that opt into
 *   updates.
 *
 * Game objects and bodies are torn down automatically when the scene restarts,
 * so there is no explicit destroy step.
 */
export class Entity {
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
    body.entity = this;
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
    body.entity = this;
    return body;
  }

  // Default hooks — all inert; subclasses override only what they need. See the
  // class doc-comment above for exactly when each is called and by whom.

  /**
   * One-time init after the whole world exists. Default: keep a world reference
   * so peers can be found later, and wire the hover/press info label. Override as
   * `setup(world) { super.setup(world); … }`.
   * @param {import('./World.js').World} world
   */
  setup(world) {
    this.world = world;
    this._enableInfo();
  }

  // --- Info label (hover / press) -----------------------------------------

  /**
   * Human-readable form of this entity's class, for display. Takes the internal
   * class name and inserts a space before each interior capital, so
   * `TeleporterTarget` reads "Teleporter Target" and `Goal` stays "Goal". Its own
   * method (and text-only) so it can be localized later.
   *
   * @returns {string}
   */
  displayedClassName() {
    return this.constructor.name.replace(/[A-Z]/g, (ch, i) => (i === 0 ? ch : ' ' + ch));
  }

  /**
   * The label shown while the player hovers or presses this entity. An entity
   * with no name — or whose name equals its class (ignoring case) — shows just
   * the displayed class name; a distinctly named one shows
   * "Name (Displayed Class Name)". Its own method so wording lives in one place
   * and can be localized later.
   *
   * @returns {string}
   */
  infoText() {
    const cls = this.displayedClassName();
    const name = this.def.name;
    if (!name || name.toLowerCase() === this.constructor.name.toLowerCase()) return cls;
    return `${name} (${cls})`;
  }

  /**
   * The game object that should receive hover/press for the info label, or
   * `null` for an entity with no pickable view (then no label is wired).
   * Subclasses return their primary visual.
   *
   * @returns {Phaser.GameObjects.GameObject|null}
   */
  interactiveView() {
    return null;
  }

  /**
   * Optional `[hitArea, callback]` for `setInteractive` when the view needs an
   * explicit shape (e.g. a Container, which has no intrinsic size). `null` uses
   * the view's own bounds.
   *
   * @returns {[object, Function]|null}
   */
  interactiveHitArea() {
    return null;
  }

  /**
   * Make this entity's view reveal its {@link infoText} on hover (mouse) or
   * press (touch), and hide it on out/release. Wired once, in {@link setup}.
   *
   * @returns {void}
   */
  _enableInfo() {
    const view = this.interactiveView();
    if (!view) return;
    const hit = this.interactiveHitArea();
    if (hit) view.setInteractive(hit[0], hit[1]);
    else view.setInteractive();
    view.on('pointerover', () => this.scene.showEntityInfo(this));
    view.on('pointerdown', () => this.scene.showEntityInfo(this));
    view.on('pointerout', () => this.scene.hideEntityInfo(this));
    // A mouse still hovering after release keeps the label (pointerout hides it);
    // a touch has no hover, so a lifted finger hides it here.
    view.on('pointerup', (pointer) => {
      if (pointer.wasTouch) this.scene.hideEntityInfo(this);
    });
  }

  /** Mid-flight sensor touch. Default: do nothing. */
  onBrotherContact() {}

  /**
   * Settle-time win predicate.
   * @param {import('../Brothers.js').Brothers} _brothers
   * @returns {boolean} Default: `false` (never a win).
   */
  isReached(_brothers) {
    return false;
  }

  /** @returns {Phaser.Geom.Rectangle|null} World AABB for culling, or `null` (no culling). */
  bounds() {
    return null;
  }

  /**
   * Per-frame tick (only when `needsUpdate` is true). Default: do nothing.
   * @param {{brothers: import('../Brothers.js').Brothers, view: Phaser.Geom.Rectangle}} _ctx
   */
  update(_ctx) {}

  /** Celebratory one-shot when this object wins the level. Default: do nothing. */
  celebrate() {}
}
