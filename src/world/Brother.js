import { Config, Depth } from '../config.js';
import { Entity } from './Entity.js';

/**
 * One brother: a dynamic circular body with an upright emoji face and a
 * subclass-specific facial feature (David's glasses, Ken's beard). A
 * {@link Entity}, so the {@link World} builds it from the level's `david`/`ken`
 * objects, its body carries `entity` for collision routing, and the pair can be
 * found via `world.byType(David|Ken)`.
 *
 * A Brother owns only *itself* — its body and view. The interaction between the
 * two real brothers (the elastic tether, the slingshot, turn-taking, teleport)
 * lives in {@link Brothers}, which finds them and drives them. Splitting it this
 * way lets a level place extra, non-controlled brothers later (e.g. doppelgänger
 * Kens) that render but aren't part of the slingshot pair.
 *
 * Size and mass are multipliers of the shared base (`Config.ball`): assigning
 * {@link radiusMult} or {@link massMult} reshapes the body immediately, and mass
 * is kept **independent of size** — a bigger brother isn't heavier unless its
 * `massMult` says so.
 */
export class Brother extends Entity {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def  Uses `x`,`y`,`name`, optional `radiusMult`,`massMult`.
   * @param {import('../levels.js').Level} level  For arena bounds (containment).
   */
  constructor(scene, def, level) {
    super(scene, def);
    /** Arena bounds, for per-ball containment (see {@link update}). */
    this._arena = level.arena;
    /** Display name (Tiled name, else the subclass default) — used by the HUD. */
    this.name = def.name || this._defaultName;
    /** CSS colour for this brother's UI text. */
    this.color = this._cssColor;

    const base = Config.ball;
    /** The circle game object + (unless `def.physics === false`) its Matter body. */
    this.go = scene.add.circle(def.x, def.y, base.radius, this._fillColor).setDepth(Depth.ball);
    // A level entity gets a physics body; a visual-only brother (the title-screen
    // demo passes `physics: false`) skips it, so it can be tweened directly and
    // parented freely. Every body-touching path below guards on `this.go.body`.
    if (def.physics !== false) {
      scene.matter.add.gameObject(this.go, {
        shape: { type: 'circle', radius: base.radius },
        restitution: base.restitution,
        frictionAir: base.frictionAir,
      });
      this.go.body.entity = this; // collision routing (replaces the old label 'brother')
    }

    /** Base radius/mass the multipliers scale from (captured before any scaling). */
    this._baseRadius = base.radius;
    this._baseMass = this.go.body?.mass ?? 1;
    this._radiusMult = 1;
    this._massMult = 1;

    /** Upright emoji face; {@link Brothers} sets the actual expression. */
    this.face = scene.add
      .text(def.x, def.y, '🙂', { fontSize: '34px' })
      .setOrigin(0.5)
      .setDepth(Depth.face);

    /** Subclass facial feature (glasses/beard), positioned each frame. */
    this.feature = this._createFeature();

    // Apply the level's authored size/mass. Mass first, so the radius setter's
    // mass re-assertion (Body.scale recomputes mass from area) uses it.
    this.massMult = def.massMult ?? this._defaultMassMult;
    this.radiusMult = def.radiusMult ?? this._defaultRadiusMult;

    // --- Aiming pin (see pin-plan.md) -------------------------------------
    // The pin is stored as an offset from this brother's centre; the launcher
    // is aimed at the anchor's pin instead of its centre. Only the anchor's
    // pin is ever moved, and it recentres at end-of-shot. Rendering (the dot +
    // the tether attaching to it) is driven each frame by {@link Brothers}.
    /** Pin offset from centre, in world pixels. 0,0 = centred (the default). */
    this.pinOffsetX = 0;
    this.pinOffsetY = 0;
    // Gesture-tracking state for the tap/double-tap/drag state machine (the
    // scene's input router fills these on pointerdown; see GameScene).
    /** Pin offset snapshot at pointerdown, so an over-long drag can revert. */
    this.pinDownOffsetX = 0;
    this.pinDownOffsetY = 0;
    /** Pointer *screen* position at pointerdown, for the tap→drag threshold. */
    this.pinDownX = 0;
    this.pinDownY = 0;
    /** When the previous tap completed (scene clock), persisted for double-tap. */
    this.lastTapTime = 0;

    // --- Mud (see mud-plan.md) --------------------------------------------
    // Muddiness is extra air-friction carried on the brother. Sticky and normal
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
    /** Mud-shed shimmy: horizontal offset (px) of the face/feature/splat over the ball. */
    this._mudShimmyX = 0;
    /** Mud splat drawn over the body (under the face); redrawn in {@link _refreshMudLook}. */
    this.mudView = scene.add.graphics().setDepth(Depth.mud);
  }

  /** @returns {number} Absolute world x of the pin (centre + offset). */
  get pinX() {
    return this.go.x + this.pinOffsetX;
  }
  /** @returns {number} Absolute world y of the pin (centre + offset). */
  get pinY() {
    return this.go.y + this.pinOffsetY;
  }
  /** @returns {boolean} True when the pin is off-centre. */
  get pinPlaced() {
    return this.pinOffsetX !== 0 || this.pinOffsetY !== 0;
  }

  /**
   * Move the pin to an offset from centre, clamped inside the ball's radius (the
   * single write path for tap-snap, recenter, and fine-drag — so the clamp lives
   * in one place). Rendering follows each frame from {@link Brothers}.
   *
   * @param {number} offsetX @param {number} offsetY
   * @returns {void}
   */
  placePin(offsetX, offsetY) {
    const r = this.go.radius;
    const d = Math.hypot(offsetX, offsetY);
    if (d > r) {
      offsetX = (offsetX / d) * r;
      offsetY = (offsetY / d) * r;
    }
    this.pinOffsetX = offsetX;
    this.pinOffsetY = offsetY;
  }

  /** Recentre the pin (end-of-shot, or a double-tap). @returns {void} */
  resetPin() {
    this.pinOffsetX = 0;
    this.pinOffsetY = 0;
  }

  /** @returns {number} Current radius as a multiple of the base radius. */
  get radiusMult() {
    return this._radiusMult;
  }

  /**
   * Resize the body (and its visual) to `m` × the base radius, keeping mass
   * independent of size. Matter's `Body.scale` is relative, so we scale from the
   * current radius to the target; it also recomputes mass from area, which we
   * then override back to our own.
   *
   * @param {number} m
   */
  set radiusMult(m) {
    if (m === this._radiusMult) return;
    const target = this._baseRadius * m;
    if (this.go.body) {
      const factor = target / this.go.radius;
      Phaser.Physics.Matter.Matter.Body.scale(this.go.body, factor, factor);
    }
    this.go.radius = target; // resize the visual circle to match
    this._radiusMult = m;
    this._applyMass();
  }

  /** @returns {number} Current mass as a multiple of the base mass. */
  get massMult() {
    return this._massMult;
  }

  /** @param {number} m  Sets mass to `m` × base mass (independent of radius). */
  set massMult(m) {
    this._massMult = m;
    this._applyMass();
  }

  /** @returns {void} */
  _applyMass() {
    if (this.go.body) this.go.setMass(this._baseMass * this._massMult);
  }

  /**
   * Glue the face + feature to the body (kept upright) and keep the ball inside
   * the arena. Driven by {@link Brothers} each frame (Brothers stays needsUpdate
   * = false so the World doesn't also tick it).
   *
   * @returns {void}
   */
  update() {
    this._contain();
    // The mud-shed shimmy slides the face/feature/splat left and right ON TOP of
    // the ball (the body itself stays put); _mudShimmyX is 0 the rest of the time.
    const sx = this._mudShimmyX;
    this.face.setPosition(this.go.x + sx, this.go.y);
    this.face.rotation = 0;
    this._updateFeature();
    if (this.feature && sx) this.feature.x += sx; // slide the glasses/beard along too
    this._updateMudView();
  }

  /**
   * Hard safety net: keep this ball inside the arena. Matter's world-bounds can
   * be tunnelled at high launch speeds, so each frame we clamp a dynamic ball
   * back inside and reflect the offending velocity component (matching the
   * bounce the wall would have given).
   *
   * @returns {void}
   */
  _contain() {
    const body = this.go.body;
    if (!body || body.isStatic) return; // no body / a frozen ball isn't moving anywhere
    const e = Config.ball.restitution;
    const { width, height } = this._arena;
    const r = this.go.radius;
    let { x, y } = this.go;
    let { x: vx, y: vy } = body.velocity;
    let hit = false;
    if (x < r) {
      x = r;
      vx = Math.abs(vx) * e;
      hit = true;
    } else if (x > width - r) {
      x = width - r;
      vx = -Math.abs(vx) * e;
      hit = true;
    }
    if (y < r) {
      y = r;
      vy = Math.abs(vy) * e;
      hit = true;
    } else if (y > height - r) {
      y = height - r;
      vy = -Math.abs(vy) * e;
      hit = true;
    }
    if (hit) {
      this.go.setPosition(x, y);
      this.go.setVelocity(vx, vy);
    }
  }

  /** @param {string} emoji  Set this brother's face. */
  setFace(emoji) {
    this.face.setText(emoji);
  }

  /** @returns {Phaser.GameObjects.Arc} The body circle receives hover/press. */
  interactiveView() {
    return this.go;
  }

  /**
   * Teleporter contact on a single brother warps the whole pair (so they stay
   * together), delegating to {@link Brothers#teleport}. Overrides the inert
   * {@link Entity#onTeleport} default.
   *
   * @param {{x:number, y:number}} dest @param {number} retain
   * @returns {void}
   */
  onTeleport(dest, retain) {
    this.scene.brothers.teleport(dest, retain);
  }

  // --- Mud (see mud-plan.md) ----------------------------------------------

  /** @returns {boolean} Carrying any mud (sticky or loose). */
  get isMuddy() {
    return this.mudStickyViscosity > 0 || this.mudLooseViscosity > 0;
  }

  /** @returns {boolean} Carrying sticky mud (drives the dark look; sheds only in a Cleaner). */
  get isSticky() {
    return this.mudStickyViscosity > 0;
  }

  /**
   * Recompute and store this brother's air-friction from its mud state and the
   * regions currently containing it. The single write path for `frictionAir`,
   * called only on change events (region enter/exit via {@link addRegion}/{@link
   * removeRegion} + a Region's recompute, and {@link shedMudTurn}) — never per frame,
   * because nothing else moves the value between those events.
   *
   * @returns {void}
   */
  _recomputeFriction() {
    if (!this.go.body) return;
    const mud = Math.max(this.mudStickyViscosity, this.mudLooseViscosity);
    let region = 0;
    for (const r of this._activeRegions) region = Math.max(region, r.inViscosity);
    this.go.body.frictionAir = Config.ball.frictionAir + mud + region;
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

  /** Drop a region's while-inside drag when the brother leaves it. */
  removeRegion(region) {
    this._activeRegions.delete(region);
  }

  /**
   * One settle's worth of mud shedding, run at the end of the shimmy. Loose mud
   * lingers for `mudTurnsLeft` more settles: while that's positive, count it down
   * and keep the mud (the brother shimmies but the mud stays); once it hits zero,
   * wash the loose mud off. Sticky mud is never shed here — only a `cleanSticky`
   * Cleaner removes it. Self-contained (settle, not a region, drives it), so it
   * recomputes friction itself. The shimmy is played by
   * {@link import('../Brothers.js').Brothers#shimmyMud}.
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
    const r = this.go.radius;
    const blobs = [
      [-0.45, 0.35, 0.3],
      [0.1, 0.5, 0.34],
      [0.5, 0.25, 0.26],
      [-0.1, 0.05, 0.3],
      [0.35, -0.25, 0.2],
    ];
    for (const [dx, dy, br] of blobs) g.fillCircle(dx * r, dy * r, br * r);
  }

  /** Glue the mud splat to the body, offset by the shed shimmy. @returns {void} */
  _updateMudView() {
    this.mudView.setPosition(this.go.x + this._mudShimmyX, this.go.y);
  }

  // --- Subclass surface (David/Ken override these) ------------------------

  /** @returns {number} 0xRRGGBB body fill. */
  get _fillColor() {
    return 0xffffff;
  }
  /** @returns {string} CSS colour for UI text. */
  get _cssColor() {
    return '#ffffff';
  }
  /** @returns {string} Display name when the Tiled object is unnamed. */
  get _defaultName() {
    return 'Brother';
  }
  /** @returns {number} Radius multiplier when the level doesn't set one. */
  get _defaultRadiusMult() {
    return 1;
  }
  /** @returns {number} Mass multiplier when the level doesn't set one. */
  get _defaultMassMult() {
    return 1;
  }
  /** @returns {Phaser.GameObjects.GameObject|null} The facial feature, or null. */
  _createFeature() {
    return null;
  }
  /** Position/refresh the facial feature over the face. Default: nothing. */
  _updateFeature() {}
}
