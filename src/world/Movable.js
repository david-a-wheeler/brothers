import { Config, Depth } from '../config.js';
import { Entity } from './Entity.js';

/**
 * Base class for a world object that **moves through the arena** and can pick up
 * mud from a {@link import('./Region.js').Region}: the brothers
 * ({@link import('./Brother.js').Brother}) and the self-propelled hazards
 * ({@link import('./Hazard.js').Hazard}). It owns the entire mud mechanic — the
 * sticky/loose viscosity buckets, the while-inside region drag, the friction
 * recompute, the shed-at-settle countdown, and the mud splat over the body — so
 * both movers behave identically in mud and cleaners (see mud-plan.md). What
 * differs between a brother and a hazard is only *where the body/visual live*
 * and *how the shed is triggered* (a brother animates it with a shimmy; a hazard
 * sheds silently at settle), which the subclasses supply through the hooks at the
 * bottom of this file.
 *
 * The `isMovable = true` marker lets the {@link import('./World.js').World} collect
 * every mover into one list (as it does with `needsUpdate`) without knowing any
 * concrete type, so a Region can point-test them all.
 */
export class Movable extends Entity {
  /** Marks this entity as a mover, so the World indexes it for region detection. */
  isMovable = true;

  /**
   * @param {Phaser.Scene} scene
   * @param {object} def
   */
  constructor(scene, def) {
    super(scene, def);
    // --- Mud (see mud-plan.md) --------------------------------------------
    // Muddiness is extra air-friction carried on the mover. Sticky and normal
    // ("loose") pickups are tracked separately because they outlive differently:
    // loose mud sheds at the next settle; sticky mud persists until washed by a
    // `cleanSticky` Cleaner. Effective mud friction is the max of the two.
    /** Persistent friction from sticky mud (permanent until washed). */
    this.mudStickyViscosity = 0;
    /** Persistent friction from normal mud (shed once its turns run out, or washed). */
    this.mudLooseViscosity = 0;
    /** Extra settles the loose mud lingers before it shakes off (sticky ignores this). */
    this.mudTurnsLeft = 0;
    /** Regions currently imparting a *while-inside* drag (a bog, the water). */
    this._activeRegions = new Set();
    /** Mud splat drawn over the body; redrawn in {@link _refreshMudLook}. */
    this.mudView = scene.add.graphics().setDepth(Depth.mud);
  }

  // --- Mud state ----------------------------------------------------------

  /** @returns {boolean} Carrying any mud (sticky or loose). */
  get isMuddy() {
    return this.mudStickyViscosity > 0 || this.mudLooseViscosity > 0;
  }

  /** @returns {boolean} Carrying sticky mud (drives the dark look; sheds only in a Cleaner). */
  get isSticky() {
    return this.mudStickyViscosity > 0;
  }

  /**
   * Recompute and store this mover's air-friction from its mud state and the
   * regions currently containing it. The single write path for `frictionAir`,
   * called only on change events (region enter/exit via {@link addRegion}/{@link
   * removeRegion} + a Region's recompute, and {@link shedMudTurn}) — never per
   * frame, because nothing else moves the value between those events.
   *
   * (Both movers are genuinely slowed by this: a brother from its own passive
   * air-friction plus mud, a hazard — frictionless by default — purely by the mud
   * it is carrying.)
   *
   * @returns {void}
   */
  _recomputeFriction() {
    const body = this.mudBody;
    if (!body) return;
    const mud = Math.max(this.mudStickyViscosity, this.mudLooseViscosity);
    let region = 0;
    for (const r of this._activeRegions) region = Math.max(region, r.inViscosity);
    body.frictionAir = this._baseFrictionAir + mud + region;
  }

  /**
   * Pick up mud into the sticky or loose bucket, keeping the heavier of what's
   * there and the new value (a lighter puddle can't reduce a heavier one). For
   * non-sticky mud, also keep the longest lingering time (`numberTurns` extra
   * settles before it sheds — see {@link shedMudTurn}); sticky mud never counts
   * down, so it ignores `numberTurns`. State only — the calling {@link
   * import('./Region.js').Region} recomputes friction.
   *
   * @param {number} viscosity @param {boolean} sticky @param {number} numberTurns
   * @returns {void}
   */
  _pickUpMud(viscosity, sticky, numberTurns) {
    if (sticky) {
      this.mudStickyViscosity = Math.max(this.mudStickyViscosity, viscosity);
    } else {
      this.mudLooseViscosity = Math.max(this.mudLooseViscosity, viscosity);
      this.mudTurnsLeft = Math.max(this.mudTurnsLeft, numberTurns);
    }
    this._refreshMudLook();
  }

  /**
   * Wash mud off (a Cleaner entered): loose mud always (and its lingering timer),
   * sticky only when the Cleaner cleans sticky. State only — the Region recomputes
   * friction.
   *
   * @param {boolean} includeSticky @returns {void}
   */
  _wash(includeSticky) {
    this.mudLooseViscosity = 0;
    this.mudTurnsLeft = 0;
    if (includeSticky) this.mudStickyViscosity = 0;
    this._refreshMudLook();
  }

  /** Register a region's while-inside drag (see {@link _recomputeFriction}). */
  addRegion(region) {
    this._activeRegions.add(region);
  }

  /** Drop a region's while-inside drag when the mover leaves it. */
  removeRegion(region) {
    this._activeRegions.delete(region);
  }

  /**
   * One settle's worth of mud shedding. Loose mud lingers for `mudTurnsLeft` more
   * settles: while that's positive, count it down and keep the mud; once it hits
   * zero, wash the loose mud off. Sticky mud is never shed here — only a
   * `cleanSticky` Cleaner removes it. Self-contained (settle, not a region, drives
   * it), so it recomputes friction itself. A brother plays this at the end of its
   * shimmy ({@link import('../Brothers.js').Brothers#shimmyMud}); a hazard runs it
   * silently on {@link import('./Hazard.js').Hazard#onSettle}.
   *
   * @returns {void}
   */
  shedMudTurn() {
    if (this.mudLooseViscosity > 0 && this.mudTurnsLeft > 0) {
      this.mudTurnsLeft -= 1; // still muddy: keep the loose mud one more turn
      return;
    }
    this.mudLooseViscosity = 0;
    this.mudTurnsLeft = 0;
    this._refreshMudLook();
    this._recomputeFriction();
  }

  /**
   * Redraw the mud splat over the body: a scatter of blobs in the current mud
   * colour (dark when sticky), or nothing when clean. Sized to the current
   * radius. Called on mud-state changes, not per frame.
   *
   * @returns {void}
   */
  _refreshMudLook() {
    const g = this.mudView;
    g.clear();
    if (!this.isMuddy) return;
    const C = Config.mud;
    g.fillStyle(this.isSticky ? C.stickyColor : C.color, C.overlayAlpha);
    // Blobs biased to the lower body, as fractions of the radius (dx, dy, size).
    const r = this.mudRadius;
    const blobs = [
      [-0.45, 0.35, 0.3],
      [0.1, 0.5, 0.34],
      [0.5, 0.25, 0.26],
      [-0.1, 0.05, 0.3],
      [0.35, -0.25, 0.2],
    ];
    for (const [dx, dy, br] of blobs) g.fillCircle(dx * r, dy * r, br * r);
  }

  /** Glue the mud splat to the body, offset by any shed shimmy. @returns {void} */
  _updateMudView() {
    this.mudView.setPosition(this.mudX + this.mudShimmyX, this.mudY);
  }

  // --- Subclass surface (Brother/Hazard supply their body/visual model) ----

  /** @returns {MatterJS.BodyType|null} The Matter body to carry mud friction. */
  get mudBody() {
    return null;
  }
  /** @returns {number} Body-centre x (where the splat is glued). */
  get mudX() {
    return this.def.x;
  }
  /** @returns {number} Body-centre y. */
  get mudY() {
    return this.def.y;
  }
  /** @returns {number} Body radius, for sizing the splat. */
  get mudRadius() {
    return 0;
  }
  /** @returns {number} Horizontal splat offset from a shed animation (0 = none). */
  get mudShimmyX() {
    return 0;
  }
  /** @returns {number} Base air-friction the mud/region friction adds onto. */
  get _baseFrictionAir() {
    return 0;
  }
}
