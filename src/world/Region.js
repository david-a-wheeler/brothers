import { Entity } from './Entity.js';

/**
 * Base class for a **body-less shaped area** the level places in the arena
 * ({@link import('./Mud.js').Mud}, {@link import('./Cleaner.js').Cleaner}). Unlike
 * a wall it has no Matter body — a brother passes through it — so it can be any
 * shape, including a concave polygon, that a solid convex body couldn't be.
 *
 * It detects a brother by a **point-in-shape** test on the brother's centre, run
 * each frame from {@link update}, and **edge-triggers** enter/exit by diffing the
 * set of brothers inside against last frame's. A body-less region gets no Matter
 * `collisionstart`/`end`, so this synthesised edge test is how we notice a brother
 * crossing the boundary. Only transitions do work — see {@link _enter}/{@link
 * _exit} — so friction is never recomputed on a frame where nothing changed.
 *
 * Subclasses supply their look ({@link _buildView}, usually via {@link
 * _fillShape}) and their state changes on enter/exit ({@link _entered}/{@link
 * _exited}). A subclass that drags a brother *while inside* (a bog, the water)
 * reports it from {@link inViscosity}; this base then registers/unregisters that
 * transient drag on the brother automatically, so it applies only while inside
 * and is dropped on exit. See mud-plan.md.
 */
export class Region extends Entity {
  /** Ticked every frame so the containment test can run (see {@link update}). */
  needsUpdate = true;

  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def  Normalised shape (see levels.normalizeShape).
   */
  constructor(scene, def) {
    super(scene, def);
    // Polygon vertices resolved to absolute world coords once (used by both the
    // hit-test shape and the fill). Null for non-polygon shapes.
    this._absPoints = def.points
      ? def.points.map((p) => ({ x: def.x + p.x, y: def.y + p.y }))
      : null;
    this._buildShape(def); // sets this._shape + this._containsFn
    /** @type {Set<import('./Brother.js').Brother>} Brothers inside as of last frame. */
    this._inside = new Set();
    /** AABB for view culling (see {@link bounds}). */
    this._aabb = new Phaser.Geom.Rectangle(
      def.x - def.width / 2,
      def.y - def.height / 2,
      def.width,
      def.height
    );
    /** @type {Phaser.GameObjects.GameObject|null} The fill; subclass supplies it. */
    this.view = this._buildView(scene, def);
  }

  /**
   * Build the Phaser.Geom hit-test shape for `def.shape`, plus the matching
   * `Contains` function, both stored for {@link contains}. Falls back to a
   * zero-size rectangle for a point / unknown shape (so it simply never matches).
   *
   * @param {import('../levels.js').EntityDef} def
   * @returns {void}
   */
  _buildShape(def) {
    const G = Phaser.Geom;
    switch (def.shape) {
      case 'circle':
        this._shape = new G.Circle(def.x, def.y, def.width / 2);
        this._containsFn = G.Circle.Contains;
        return;
      case 'ellipse':
        this._shape = new G.Ellipse(def.x, def.y, def.width, def.height);
        this._containsFn = G.Ellipse.Contains;
        return;
      case 'polygon':
      case 'polyline':
        this._shape = new G.Polygon(this._absPoints);
        this._containsFn = G.Polygon.Contains;
        return;
      default: // 'rect' (and the degenerate 'point')
        this._shape = new G.Rectangle(
          def.x - def.width / 2,
          def.y - def.height / 2,
          def.width,
          def.height
        );
        this._containsFn = G.Rectangle.Contains;
    }
  }

  /**
   * @param {number} x @param {number} y
   * @returns {boolean} True if the point is inside this area.
   */
  contains(x, y) {
    return this._containsFn(this._shape, x, y);
  }

  /**
   * Transient drag imparted to a brother WHILE it is inside this area (0 = none).
   * Overridden by subclasses with a while-inside effect (the water, a bog); the
   * value lives on the region, so it never perpetuates once the brother leaves.
   *
   * @returns {number}
   */
  get inViscosity() {
    return 0;
  }

  /**
   * Per-frame: for each brother, test containment and fire {@link _enter}/{@link
   * _exit} only on a transition (crossing the boundary), tracked in {@link
   * _inside}.
   *
   * @param {{brothers: import('../Brothers.js').Brothers}} ctx
   * @returns {void}
   */
  update(ctx) {
    for (const b of [ctx.brothers.david, ctx.brothers.ken]) {
      const inside = this.contains(b.go.x, b.go.y);
      const was = this._inside.has(b);
      if (inside && !was) {
        this._inside.add(b);
        this._enter(b);
      } else if (!inside && was) {
        this._inside.delete(b);
        this._exit(b);
      }
    }
  }

  /**
   * A brother crossed in: apply the subclass's state change, register any
   * while-inside drag, then recompute the brother's friction ONCE.
   *
   * @param {import('./Brother.js').Brother} b @returns {void}
   */
  _enter(b) {
    this._entered(b);
    if (this.inViscosity > 0) b.addRegion(this);
    b._recomputeFriction();
  }

  /**
   * A brother crossed out: undo any subclass exit state, drop the while-inside
   * drag, then recompute friction ONCE. (A persistent effect like mud pickup
   * leaves nothing to undo here — that's the point of it persisting.)
   *
   * @param {import('./Brother.js').Brother} b @returns {void}
   */
  _exit(b) {
    this._exited(b);
    if (this.inViscosity > 0) b.removeRegion(this);
    b._recomputeFriction();
  }

  /**
   * Draw the area as a filled shape into a new Graphics (the shared look for
   * every region; subclasses pass their colour). Uses the same geometry as the
   * hit-test so the fill and the trigger always agree.
   *
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   * @param {{color:number, alpha:number, depth:number}} style
   * @returns {Phaser.GameObjects.Graphics}
   */
  _fillShape(scene, def, { color, alpha, depth }) {
    const g = scene.add.graphics().setDepth(depth);
    g.fillStyle(color, alpha);
    switch (def.shape) {
      case 'circle':
        g.fillCircle(def.x, def.y, def.width / 2);
        break;
      case 'ellipse':
        g.fillEllipse(def.x, def.y, def.width, def.height);
        break;
      case 'polygon':
      case 'polyline':
        g.fillPoints(this._absPoints, true);
        break;
      default:
        g.fillRect(def.x - def.width / 2, def.y - def.height / 2, def.width, def.height);
    }
    return g;
  }

  /**
   * Don't cull while a brother is inside, so an exit is always detected even if
   * the AABB drifts to the view edge. (An occupied region is near the followed
   * centre anyway, so this is belt-and-suspenders.)
   *
   * @returns {Phaser.Geom.Rectangle|null}
   */
  bounds() {
    return this._inside.size ? null : this._aabb;
  }

  // --- Subclass surface ---------------------------------------------------
  /** Persistent state change when a brother enters. Default: none. */
  _entered(_b) {}
  /** State change when a brother exits (rarely needed). Default: none. */
  _exited(_b) {}
  /** Build the fill; default none. Subclasses usually return {@link _fillShape}. */
  _buildView(_scene, _def) {
    return null;
  }

  /** @returns {Phaser.GameObjects.GameObject|null} The fill receives hover/press. */
  interactiveView() {
    return this.view;
  }

  /**
   * A Graphics has no intrinsic size, so give it an explicit hit area matching the
   * region's shape (Goal does the same for its Container). We reuse the very
   * shape + `Contains` used for brother detection: the fill Graphics sits at the
   * origin and is drawn in world coordinates, so the pointer's local coords equal
   * world coords and the same test answers the hover hit-test exactly.
   *
   * @returns {[object, Function]}
   */
  interactiveHitArea() {
    return [this._shape, this._containsFn];
  }
}
