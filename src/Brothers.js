import { Config, Depth } from './config.js';
import * as diag from './diag.js';
import { FACES } from './faces.js';
import { sfx } from './Sfx.js';
import { David } from './world/David.js';
import { Ken } from './world/Ken.js';
import { Wall } from './world/Wall.js';
import { drawBand, pulsingGlow } from './world/effects.js';

/**
 * The face a brother wears while wiggling mud off at settle (see
 * {@link Brothers#shimmyMud}). One knob — change it to restyle the shed.
 */
const MUD_SHED_FACE = FACES.dizzy;

/**
 * Coordinates the David/Ken pair. The two brothers are {@link Brother} entities
 * that the {@link World} builds from the level's `david`/`ken` objects and that
 * own their own bodies and views; this class finds them and drives everything
 * *between* them: the elastic tether, the upright faces' expressions, role
 * swapping, the "Hybrid Snap", settle detection, and teleporting. The scene
 * creates exactly one of these (after the world) and drives it.
 *
 * A pair coordinator, not a placed world object, so it is *not* an {@link Entity}
 * — but it shares the level lifecycle, which it opts into by convention (see
 * {@link import('./lifecycle.js').LevelParticipant}) rather than by inheritance.
 *
 * @implements {import('./lifecycle.js').LevelParticipant}
 */
export class Brothers {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('./world/World.js').World} world  Holds the entities + level.
   */
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    /** Arena bounds, for the aim-legality geometry. */
    this._arena = world.level.arena;

    // Find the two real brothers among the world's entities. A level normally
    // has one of each; if it has extras (future doppelgängers), prefer the ones
    // the designer named "David"/"Ken".
    this.david = this._pick(world.byType(David), 'David');
    this.ken = this._pick(world.byType(Ken), 'Ken');

    /** @type {import('./world/Brother.js').Brother} The brother being slingshotted. */
    this.launcher = this.david;
    /** @type {import('./world/Brother.js').Brother} The frozen brother that unfreezes on impact. */
    this.anchor = this.ken;

    /**
     * The elastic band, drawn fresh each frame (see {@link update}). Its depth is
     * toggled in {@link update}: {@link Depth.bandBelow} when the brothers are
     * centred (behind the balls, a slingshot look — and matching the title demo),
     * or {@link Depth.bandAbove} when a pin is placed (over the whole brother, so
     * the off-centre attachment stays legible).
     */
    this.band = scene.add.graphics().setDepth(Depth.bandBelow);

    /** The pin dot(s), drawn each frame above the (lifted) band (see {@link update}). */
    this.pins = scene.add.graphics().setDepth(Depth.pin);

    /** Pulsing halo ring marking whichever ball can currently be moved. */
    this._glow = this._createGlow();

    /** True while the player is dragging the launcher to aim. */
    this._aiming = false;
    /** True while the current aim can't be launched; refreshed each frame in {@link update}. */
    this.aimRefused = false;
    /**
     * Red "X" over EACH brother when the current aim can't be fired. Both are
     * marked (not just the launcher) so the cue stays visible even when a
     * finger covers the ball being dragged.
     */
    this._refusalXs = [this._createRefusalX(), this._createRefusalX()];

    /** Consecutive slow frames, for debounced settle detection. */
    this._settleFrames = 0;

    // The tether: a soft, damped spring with a non-zero rest length. Kept as
    // a reference because we make it *pull-only* each frame (see {@link update}):
    // a Matter constraint normally pushes when squeezed below its rest length,
    // which would fling the brothers apart when placed close together.
    const t = Config.tether;
    this._tether = scene.matter.add.constraint(
      this.david.go.body,
      this.ken.go.body,
      t.restLength,
      t.stiffness,
      { damping: t.damping }
    );

    this.anchor.go.setStatic(true);
    this.anchor.go.setRotation(0); // keep the static anchor axis-aligned (pin offsets are world-axis)
    this.setExpressions('idle');
    this._indicateLauncher();
    this._updateDraggable();
    this.markTurnStart(); // level-start positions, for a 'turn ends' hazard reset
  }

  /**
   * Mark only the current launcher as draggable (the bodies are already
   * interactive for their info labels). Phaser's drag system then owns the aim
   * gesture — hit-testing, the grab offset, and per-frame position — so the
   * scene just consumes its drag events. Re-run on every role swap.
   *
   * @returns {void}
   */
  _updateDraggable() {
    this.scene.input.setDraggable(this.launcher.go, true);
    this.scene.input.setDraggable(this.anchor.go, false);
  }

  /**
   * Choose the controlled brother from the candidates of one kind: the one whose
   * Tiled name matches, else the first placed.
   *
   * @param {import('./world/Brother.js').Brother[]} list
   * @param {string} name
   * @returns {import('./world/Brother.js').Brother}
   */
  _pick(list, name) {
    return list.find((b) => b.def.name === name) || list[0];
  }

  /**
   * Push the lab's live David size/mass multipliers onto the David entity (whose
   * accessors reshape the body). Called at construction-time defaults via the
   * entity itself, and again whenever the lab changes a value (see
   * GameScene._adjustParam/_promptParam/_resetParams).
   *
   * @returns {void}
   */
  _applyDavidPhysique() {
    this.david.radiusMult = Config.ball.davidRadiusMult;
    this.david.massMult = Config.ball.davidMassMult;
  }

  /**
   * Build the pulsing halo ring: a stroked circle that repeatedly expands
   * and fades out to draw the eye to the movable ball. Positioned each frame
   * by {@link update}.
   *
   * @returns {Phaser.GameObjects.Arc}
   */
  _createGlow() {
    const ring = pulsingGlow(
      this.scene,
      this.launcher.go.x,
      this.launcher.go.y,
      Config.ball.radius + 8
    ).setDepth(Depth.glow);
    /** Looping expand-and-fade pulse. Paused while the ring is hidden. */
    this._glowTween = ring.getData('pulse');
    return ring;
  }

  /**
   * Build the red "X" overlay shown over the launcher while aiming whenever a
   * launch would currently be refused. Drawn around its own origin (so it can
   * be re-centred on the launcher each frame) and on top of everything; hidden
   * until {@link update} decides to show it.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createRefusalX() {
    const d = Config.ball.radius * 0.8;
    const g = this.scene.add.graphics().setDepth(Depth.refusal).setVisible(false);
    g.lineStyle(5, 0xff2b2b, 1);
    g.beginPath();
    g.moveTo(-d, -d);
    g.lineTo(d, d);
    g.moveTo(-d, d);
    g.lineTo(d, -d);
    g.strokePath();
    return g;
  }

  /**
   * Point the glow at the current launcher and (re)start its pulse.
   *
   * @returns {void}
   */
  _indicateLauncher() {
    this._glow.radius = this.launcher.go.radius + 8; // fit the (possibly larger) launcher
    this._glow.setVisible(true);
    this._glowTween.resume();
  }

  /**
   * Hide the glow while nothing is draggable (balls in motion).
   *
   * @returns {void}
   */
  _hideIndicator() {
    this._glow.setVisible(false);
    this._glowTween.pause();
  }

  /**
   * The level has ended (win or loss, for any reason). Turn off every turn cue so
   * nothing keeps signalling "it's your move" after the game is over: the launcher
   * glow and any refusal marks. Mirrors the {@link Entity#onLevelEnd} hook so the
   * scene can shut the pair down the same way it does world entities.
   *
   * @returns {void}
   */
  onLevelEnd() {
    this._hideIndicator();
    this._refusalXs.forEach((x) => x.setVisible(false));
  }

  /**
   * Per-frame: let each brother glue its own face/feature and stay in-arena,
   * then draw the pair-level bits (tether band + sound, glow, refusal Xs). Call
   * once per frame from the scene's update.
   *
   * @returns {void}
   */
  update() {
    this._applyPullOnlyTether();
    this.david.update();
    this.ken.update();
    this._checkBrothersPresent();

    // Keep the glow ring centred on the movable ball (its scale is tweened).
    this._glow.setPosition(this.launcher.go.x, this.launcher.go.y);

    // While aiming, flag an unlaunchable position with a red X over BOTH balls
    // (so it shows even under the finger dragging one of them). Exposed as
    // {@link aimRefused} so the scene can echo it in the turn prompt.
    const refuse = this._aiming && this._launcherBlocked();
    /** True while the current aim can't be launched (drives the refusal Xs). */
    this.aimRefused = refuse;
    const balls = [this.launcher.go, this.anchor.go];
    this._refusalXs.forEach((x, i) => {
      x.setVisible(refuse);
      if (refuse) x.setPosition(balls[i].x, balls[i].y);
    });

    // Drive the stretching-band friction sound every frame so a held draw goes
    // silent (it only makes noise while the length is actually changing).
    if (this._aiming) {
      const gap = Phaser.Math.Distance.Between(
        this.anchor.go.x,
        this.anchor.go.y,
        this.launcher.go.x,
        this.launcher.go.y
      );
      const rest = Config.tether.restLength;
      sfx.updateBand((gap - rest) / (Config.slingshot.maxPull - rest));
    }

    // Draw the tether to each brother's PIN (the launcher's is always centre, so
    // this one path covers both the normal centre-to-centre band and a pinned,
    // off-centre one). Centred, the band sits BELOW the balls (behind the bodies —
    // a slingshot look that matches the title demo); when a pin is placed, lift it
    // ABOVE the whole brother (with the pin dot above that) so the off-centre
    // attach stays legible.
    const pinned = this.david.pinPlaced || this.ken.pinPlaced;
    this.band.setDepth(pinned ? Depth.bandAbove : Depth.bandBelow);
    drawBand(this.band, this.david.pinX, this.david.pinY, this.ken.pinX, this.ken.pinY);
    this._drawPins();
  }

  /**
   * Draw the small near-black pin dot on each brother whose pin is off-centre
   * (both, if both are placed — a placed pin on either end reads more clearly on
   * a phone, where a finger hides much of a ball). Above the band; see
   * {@link Config.pin}.
   *
   * @returns {void}
   */
  _drawPins() {
    const g = this.pins;
    g.clear();
    const { color, radius } = Config.pin;
    for (const b of [this.david, this.ken]) {
      if (!b.pinPlaced) continue;
      g.fillStyle(color, 1);
      g.fillCircle(b.pinX, b.pinY, radius);
    }
  }

  /**
   * Make the tether behave like an elastic band / rope instead of a two-sided
   * spring: it should resist *stretching* past its rest length but never push
   * the brothers apart when they're closer than that. A Matter constraint is
   * symmetric, so we simply zero its stiffness whenever the current gap is at
   * or below the rest length, and restore it once they're stretched apart.
   * (Solid-body collision already keeps the balls from overlapping up close.)
   *
   * @returns {void}
   */
  _applyPullOnlyTether() {
    const t = Config.tether;
    // In 'settle' mode the constraint attaches at the anchor's pin, so the slack
    // test must measure between the actual attach points (launcher centre →
    // anchor pin); otherwise it's the usual centre-to-centre gap.
    const live = this.world.level.pinResetOn === 'settle';
    const ax = live ? this.anchor.pinX : this.anchor.go.x;
    const ay = live ? this.anchor.pinY : this.anchor.go.y;
    const gap = Phaser.Math.Distance.Between(this.launcher.go.x, this.launcher.go.y, ax, ay);
    // Re-sync length/damping from Config each frame so live dev-panel tweaks
    // (and not just stiffness) take effect on the existing constraint.
    this._tether.length = t.restLength;
    this._tether.damping = t.damping;
    this._tether.stiffness = gap > t.restLength ? t.stiffness : 0;
  }

  /**
   * Set both faces from a role-relative state (launcher vs. anchor).
   *
   * @param {'idle'|'drag'|'flight'} state
   * @returns {void}
   */
  setExpressions(state) {
    this.launcher.setFace(FACES[state].launcher);
    this.anchor.setFace(FACES[state].anchor);
  }

  /**
   * Set both faces to the same emoji (impact flash, win, lose, dizzy).
   *
   * @param {string} emoji
   * @returns {void}
   */
  setBothFaces(emoji) {
    this.david.setFace(emoji);
    this.ken.setFace(emoji);
  }

  /**
   * Freeze the launcher so it can be dragged cleanly while the player aims.
   *
   * @returns {void}
   */
  beginAim() {
    // Remember the resting spot so a blocked/aborted release can snap back to
    // it instead of leaving the ball wherever it was dragged.
    this._aimStart = { x: this.launcher.go.x, y: this.launcher.go.y };
    this._aiming = true;
    this.launcher.go.setStatic(true);
    this.setExpressions('drag');
    sfx.startBand();
  }

  /**
   * Move the launcher to a pulled-back position, clamped to `maxPull` so it
   * cannot be stretched arbitrarily far from the anchor.
   *
   * @param {number} x  Pointer world x.
   * @param {number} y  Pointer world y.
   * @returns {void}
   */
  dragTo(x, y) {
    const a = this.anchor.go;
    const max = Config.slingshot.maxPull;
    if (Phaser.Math.Distance.Between(a.x, a.y, x, y) > max) {
      const angle = Phaser.Math.Angle.Between(a.x, a.y, x, y);
      x = a.x + Math.cos(angle) * max;
      y = a.y + Math.sin(angle) * max;
    }
    this.launcher.go.setPosition(x, y);
  }

  /**
   * Abort an aim without firing (pull was too short). Restores the launcher
   * to a normal dynamic body and resets faces.
   *
   * @returns {void}
   */
  cancelAim() {
    if (this._aimStart) {
      this.launcher.go.setPosition(this._aimStart.x, this._aimStart.y);
    }
    this._aiming = false;
    this._refusalXs.forEach((x) => x.setVisible(false));
    sfx.stopBand();
    this.launcher.go.setStatic(false);
    this.launcher.go.setVelocity(0, 0);
    this.setExpressions('idle');
  }

  /**
   * Is the current aim illegal to launch? Checked with plain geometry (no
   * Matter query). Four ways a shot is refused:
   *  - any part of the launcher is outside the arena;
   *  - it's overlapping the other brother;
   *  - it's sitting on a wall;
   *  - the elastic band (the launcher -> anchor line, which the ball flies
   *    roughly along) *touches* a wall. A band that only passes near a wall
   *    without touching it is allowed.
   * The goal and teleporter aren't checked — they're non-solid,
   * so resting on or firing across them is fine.
   *
   * @returns {boolean}
   */
  _launcherBlocked() {
    const l = this.launcher.go;
    const a = this.anchor.go;
    const r = l.radius; // launcher's own radius (David and Ken can differ)
    const { width, height } = this._arena;
    // Walls come straight from the world (single source of truth): each Wall
    // entity's def carries its centre + size.
    const walls = this.world.byType(Wall);

    // Poking past an arena edge?
    if (l.x < r || l.x > width - r || l.y < r || l.y > height - r) return true;

    // Overlapping the other brother? (sum of both radii)
    if (Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y) < r + a.radius) return true;

    // Sitting on a wall (closest-point circle/rectangle overlap)?
    const onWall = walls.some(({ def: w }) => {
      const nx = Phaser.Math.Clamp(l.x, w.x - w.width / 2, w.x + w.width / 2);
      const ny = Phaser.Math.Clamp(l.y, w.y - w.height / 2, w.y + w.height / 2);
      return Phaser.Math.Distance.Between(l.x, l.y, nx, ny) < r;
    });
    if (onWall) return true;

    // Does the elastic band itself touch a wall? Tested against the *actual*
    // wall rectangle (no inflation), so a band that merely passes close by — but
    // doesn't touch — is allowed. Both balls being clear is already covered by
    // the launcher checks above and by the band's endpoints sitting on them.
    // The band ends at the anchor's PIN (where the ball actually flies), not its
    // centre, so an off-centre pin is validated along its real line.
    const band = new Phaser.Geom.Line(l.x, l.y, this.anchor.pinX, this.anchor.pinY);
    return walls.some(({ def: w }) =>
      Phaser.Geom.Intersects.LineToRectangle(
        band,
        new Phaser.Geom.Rectangle(w.x - w.width / 2, w.y - w.height / 2, w.width, w.height)
      )
    );
  }

  /**
   * Release the slingshot: fire the launcher toward the anchor's PIN (its centre
   * unless the player moved the pin off-centre — see pin-plan.md). The anchor
   * stays frozen until they collide (see {@link snap}).
   *
   * @returns {number} The pull distance in pixels (the scene uses this to
   *   decide whether a real launch happened).
   */
  release() {
    const l = this.launcher.go;
    const anchor = this.anchor;
    const s = Config.slingshot;
    // Aim at the pin, not the centre: the pull magnitude (→ power) and the fire
    // angle are both measured launcher → pin, so an off-centre pin bends the
    // shot and changes its strength.
    const pull = Phaser.Math.Distance.Between(l.x, l.y, anchor.pinX, anchor.pinY);

    // Block a too-short pull, OR a release where the ball would start already
    // overlapping something solid (the other brother, a wall, or the board
    // edge). Either way it's not a real launch and costs the player no move.
    if (pull < s.minPull || this._launcherBlocked()) {
      this.cancelAim();
      return 0;
    }

    const angle = Phaser.Math.Angle.Between(l.x, l.y, anchor.pinX, anchor.pinY);
    // Eased launch between a non-zero floor and the max: normalise the pull and
    // apply a >1 exponent so gentle pulls stay gentle, but `minSpeed` ensures
    // even the shortest valid pull still carries the pair a meaningful distance.
    const t = Phaser.Math.Clamp((pull - s.minPull) / (s.maxPull - s.minPull), 0, 1);
    const speed = s.minSpeed + (s.maxSpeed - s.minSpeed) * Math.pow(t, s.curve);
    this._aiming = false;
    this._refusalXs.forEach((x) => x.setVisible(false));
    sfx.stopBand();
    // In 'settle' mode the pin also becomes a live, off-centre tether attachment
    // for the whole flight (the anchor is axis-aligned while static, so the
    // world offset is usable directly as the body-local constraint point).
    if (this.world.level.pinResetOn === 'settle' && anchor.pinPlaced) {
      this._setAnchorTetherPoint(anchor.pinOffsetX, anchor.pinOffsetY);
    }
    l.setStatic(false);
    // Matter normalises velocity to per-frame units regardless of sub-step
    // count, so `speed` is passed through unscaled.
    l.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    this.setExpressions('flight');
    this._hideIndicator();
    diag.trace('play', 'launch', {
      pull: Math.round(pull),
      speed: +speed.toFixed(1),
      angle: +Phaser.Math.RadToDeg(angle).toFixed(1),
      pinPlaced: anchor.pinPlaced,
      ...this.snapshot(),
    });
    return pull;
  }

  /**
   * Point the tether's anchor-side attachment at an offset from the anchor's
   * centre (body-local px), leaving the launcher side at centre. Which of the
   * constraint's two points is the anchor's depends on the current role, since
   * the David/Ken bodies are fixed as bodyA/bodyB but the roles swap.
   *
   * @param {number} offsetX @param {number} offsetY
   * @returns {void}
   */
  _setAnchorTetherPoint(offsetX, offsetY) {
    const pt = { x: offsetX, y: offsetY };
    const zero = { x: 0, y: 0 };
    if (this.anchor.go.body === this._tether.bodyA) {
      this._tether.pointA = pt;
      this._tether.pointB = zero;
    } else {
      this._tether.pointB = pt;
      this._tether.pointA = zero;
    }
  }

  /** Return both tether attach points to the bodies' centres. @returns {void} */
  _clearTetherPoints() {
    this._tether.pointA = { x: 0, y: 0 };
    this._tether.pointB = { x: 0, y: 0 };
  }

  /** Recentre the anchor's pin and drop any off-centre tether attach. @returns {void} */
  _resetAnchorPin() {
    this.anchor.resetPin();
    this._clearTetherPoints();
  }

  /**
   * The Hybrid Snap. Called when the two brothers collide: unfreeze the
   * anchor at the instant of impact so momentum transfers. No-op if the
   * anchor is already dynamic (they've collided more than once).
   *
   * NOTE: Matter fires `collisionstart` after contact detection, so the
   * unfreeze takes full effect from the next step. This is the riskiest
   * mechanic in the game and the first thing to retune if the snap feels
   * off (see plan.md, Phase 3).
   *
   * @returns {void}
   */
  snap() {
    if (!this.anchor.go.body.isStatic) return;
    this.anchor.go.setStatic(false);
    // In 'impact' mode the pin was aim-only; recentre it now so the rest of the
    // shot is centre-based. ('settle' mode keeps it live until the balls rest.)
    if (this.world.level.pinResetOn === 'impact') this._resetAnchorPin();
    this.setBothFaces(FACES.collision);
    this.scene.time.delayedCall(150, () => this.setExpressions('flight'));
  }

  /**
   * Shorten the slow crawl at the end of a shot: any ball already moving
   * slowly (below `brakeSpeed`) gets extra velocity damping each frame, so it
   * reaches rest — and the turn ends — sooner. Faster motion is above the
   * threshold and left alone, so launches and bounces feel unchanged. Call
   * once per frame while the shot is in flight.
   *
   * @returns {void}
   */
  brakeSlowMotion() {
    const { brakeSpeed, brakeFactor } = Config.settle;
    for (const b of [this.david, this.ken]) {
      const body = b.go.body;
      // body.speed is already per-frame (Matter normalises it), so no sub-step
      // scaling is needed here or in isSettled().
      if (body.isStatic || body.speed === 0 || body.speed >= brakeSpeed) continue;
      b.go.setVelocity(body.velocity.x * brakeFactor, body.velocity.y * brakeFactor);
      b.go.setAngularVelocity(body.angularVelocity * brakeFactor);
    }
  }

  /**
   * Debounced settle test. Call once per frame while the balls are moving.
   *
   * @returns {boolean} true once both balls have stayed slow long enough.
   */
  isSettled() {
    const { speedThreshold, frames } = Config.settle;
    const slow =
      this.david.go.body.speed < speedThreshold && this.ken.go.body.speed < speedThreshold;
    this._settleFrames = slow ? this._settleFrames + 1 : 0;
    return this._settleFrames >= frames;
  }

  /**
   * Compact state of one brother for the diagnostics log — everything we'd want
   * to know about a ball that "disappeared": where it is, whether it's drawable,
   * whether it still has a body, and what mud/physics it carries.
   *
   * @param {import('./world/Brother.js').Brother} b
   * @returns {object}
   */
  _snapOne(b) {
    const body = b.go.body;
    return {
      x: Math.round(b.go.x),
      y: Math.round(b.go.y),
      r: Math.round(b.go.radius),
      vis: b.go.visible,
      active: b.go.active,
      alpha: +b.go.alpha.toFixed(2),
      body: !!body,
      static: body ? body.isStatic : null,
      speed: body ? +body.speed.toFixed(2) : null,
      fa: body ? +body.frictionAir.toFixed(4) : null,
      mass: body ? +body.mass.toFixed(2) : null,
      muddy: b.isMuddy,
      sticky: b.isSticky,
      turns: b.mudTurnsLeft,
    };
  }

  /**
   * Both brothers, their roles, and the camera — the state worth attaching to
   * any trace about a turn, a launch, or a Lab edit. Public so the scene can
   * fold it into its own traces rather than reaching into the brothers itself.
   *
   * @returns {object}
   */
  snapshot() {
    const cam = this.scene.cameras.main;
    return {
      david: this._snapOne(this.david),
      ken: this._snapOne(this.ken),
      launcher: this.launcher?.def.name,
      anchor: this.anchor?.def.name,
      cam: { x: Math.round(cam.scrollX), y: Math.round(cam.scrollY), zoom: +cam.zoom.toFixed(3) },
    };
  }

  /**
   * Watchdog for the "a brother vanished" class of bug: every frame, check that
   * both balls are still drawable, still have a body, and still hold finite
   * coordinates somewhere near the arena. A brother can leave the *view* legally
   * (the camera pans), so this tests the model, not visibility on screen.
   *
   * Reports once per scene — this runs per frame, and a stuck NaN would other-
   * wise flood the log and the banner. The snapshot in the entry is the evidence
   * we were missing when this went unreproducible.
   *
   * @returns {void}
   */
  _checkBrothersPresent() {
    if (this._vanishReported) return;
    const arena = this.david._arena;
    // Generous: a legitimately fast ball can briefly overshoot before _contain
    // clamps it, so only a wild value (or a non-finite one) counts as gone.
    const slack = Math.max(arena.width, arena.height);
    for (const b of [this.david, this.ken]) {
      const missing =
        !b.go.body ||
        !b.go.active ||
        !b.go.visible ||
        b.go.alpha === 0 ||
        !Number.isFinite(b.go.x) ||
        !Number.isFinite(b.go.y) ||
        b.go.x < -slack ||
        b.go.x > arena.width + slack ||
        b.go.y < -slack ||
        b.go.y > arena.height + slack;
      if (!missing) continue;
      this._vanishReported = true;
      diag.trace('brothers', 'vanished', this.snapshot());
      diag.error(
        `brothers: ${b.def.name} is gone (no body, hidden, or off the arena)`,
        new Error(JSON.stringify(this.snapshot()))
      );
      return;
    }
  }

  /**
   * At settle, EVERY muddy brother — loose or sticky — shimmies to try to shake
   * the mud off, then `onDone` fires once all shimmies finish (so the caller can
   * run the win/lose animation *after* the shimmy). Both brothers are checked
   * every turn: any that {@link Brother#isMuddy} shimmies. What the shimmy sheds
   * is decided at its end by {@link Brother#shedMudTurn}: loose mud lingers for
   * its remaining turns (so it may take several shimmies before it comes off),
   * and sticky mud never sheds here — so the ball's look updates only when mud
   * actually leaves. If neither brother is muddy, `onDone` fires immediately
   * (synchronously), so a mud-free turn resolves exactly as before. See
   * mud-plan.md.
   *
   * @param {() => void} onDone
   * @returns {void}
   */
  shimmyMud(onDone) {
    const muddy = [this.david, this.ken].filter((b) => b.isMuddy);
    diag.trace('play', 'settle', { shimmying: muddy.map((b) => b.def.name), ...this.snapshot() });
    if (!muddy.length) {
      onDone();
      return;
    }
    let pending = muddy.length;
    const { amplitude, cycles, duration } = Config.mud.wiggle;
    for (const b of muddy) {
      const prevFace = b.face.text;
      b.setFace(MUD_SHED_FACE);
      // A quick left/right slide of the face on top of the ball, `cycles` times.
      // A sine drives it, so it starts and ends centred (no pop); the body stays
      // put — only the face/feature/splat move (see Brother.update / _mudShimmyX).
      const p = { t: 0 };
      this.scene.tweens.add({
        targets: p,
        t: 1,
        duration,
        ease: 'Linear',
        onUpdate: () => {
          b._mudShimmyX = amplitude * Math.sin(p.t * Math.PI * 2 * cycles);
        },
        onComplete: () => {
          b._mudShimmyX = 0;
          b.shedMudTurn(); // count down / shed loose mud now (sticky stays) → look may update
          b.setFace(prevFace);
          // The turn can only advance once every shimmy lands here; if one never
          // does, the game sits in RESOLVING forever, so record each arrival.
          diag.trace('play', 'shimmy done', { who: b.def.name, pending: pending - 1, turns: b.mudTurnsLeft });
          if (--pending === 0) onDone(); // decide the turn once all shimmies finish
        },
      });
    }
  }

  /**
   * End-of-turn handoff: fully stop both balls, swap launcher/anchor, and
   * refreeze the new anchor for the next aim.
   *
   * @returns {void}
   */
  swapRoles() {
    // In 'settle' mode the pin stayed live through the flight; the balls are now
    // at rest, so recentre it (and drop the off-centre tether attach) here. In
    // 'impact' mode it was already recentred at the snap — this is then a no-op.
    this._resetAnchorPin();
    for (const b of [this.david, this.ken]) {
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
    [this.launcher, this.anchor] = [this.anchor, this.launcher];
    this.anchor.go.setStatic(true);
    this.anchor.go.setRotation(0); // keep the static anchor axis-aligned (pin offsets are world-axis)
    this.launcher.go.setStatic(false);
    this._settleFrames = 0;
    this.setExpressions('idle');
    this._indicateLauncher();
    this._updateDraggable(); // the new launcher is now the draggable one
    this.markTurnStart(); // the balls are at rest here: this is the new turn's start
  }

  /**
   * Snapshot both brothers' resting positions as the start of the current turn,
   * so a 'turn ends' hazard penalty can restore them (see {@link resetTurn}).
   * Called whenever a fresh turn begins at rest (construction and every
   * {@link swapRoles}).
   *
   * @returns {void}
   */
  markTurnStart() {
    this._turnStart = {
      david: { x: this.david.go.x, y: this.david.go.y },
      ken: { x: this.ken.go.x, y: this.ken.go.y },
    };
  }

  /**
   * Undo the current turn: stop both brothers, return them to the positions
   * captured at the start of this turn, and re-arm the SAME launcher for a fresh
   * aim (roles unchanged). Used by the 'turn ends' hazard outcome, which also
   * charges a move (see GameScene.hazardStruck).
   *
   * @returns {void}
   */
  resetTurn() {
    if (!this._turnStart) return;
    for (const b of [this.david, this.ken]) {
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
    this.david.go.setPosition(this._turnStart.david.x, this._turnStart.david.y);
    this.ken.go.setPosition(this._turnStart.ken.x, this._turnStart.ken.y);
    this.anchor.go.setStatic(true);
    this.launcher.go.setStatic(false);
    this._settleFrames = 0;
    this._aiming = false;
    this._refusalXs.forEach((x) => x.setVisible(false));
    this.setExpressions('idle');
    this._indicateLauncher();
    this._updateDraggable();
  }

  /**
   * Teleport both brothers as a package, preserving their relative offset so
   * they don't overlap, and damping their velocity on the way out.
   *
   * @param {{x:number, y:number}} target  Where David lands.
   * @param {number} retain  Fraction of velocity kept (e.g. 0.6).
   * @returns {void}
   */
  teleport(target, retain) {
    const dx = this.ken.go.x - this.david.go.x;
    const dy = this.ken.go.y - this.david.go.y;

    this.david.go.setPosition(target.x, target.y);
    this.ken.go.setPosition(target.x + dx, target.y + dy);

    for (const b of [this.david, this.ken]) {
      const v = b.go.body.velocity;
      b.go.setVelocity(v.x * retain, v.y * retain);
    }
    this.setBothFaces(FACES.dizzy);
  }

  /**
   * God mode: drag the pair as a package so `grabbed` follows the pointer,
   * keeping their relative offset. Both are stopped dead — a placed ball that
   * kept its velocity would shoot off the moment the drag ended.
   *
   * *While dragging*, nothing but the arena edge constrains them: they sail over
   * walls and bombs freely. Legality is decided only when they're dropped (see
   * {@link godDrop}), so the drag itself never fights the pointer. The pair is
   * clamped as a unit, so the offset holds even along an edge, and neither ball
   * can end up outside the arena where it would be unrecoverable (and would trip
   * {@link _checkBrothersPresent}).
   *
   * Roles are untouched: the anchor stays static, the launcher stays dynamic, so
   * the next aim behaves normally from wherever they were dropped.
   *
   * @param {import('./world/Brother.js').Brother} grabbed  The brother under the pointer.
   * @param {number} x @param {number} y  Target world position for `grabbed`.
   * @returns {void}
   */
  godMoveTo(grabbed, x, y) {
    const arena = this.david._arena;
    let dx = x - grabbed.go.x;
    let dy = y - grabbed.go.y;
    // Shrink the move until it's legal for both brothers, rather than clamping
    // each separately (which would change their offset and stretch the tether).
    for (const b of [this.david, this.ken]) {
      const r = b.go.radius;
      dx = Phaser.Math.Clamp(dx, r - b.go.x, arena.width - r - b.go.x);
      dy = Phaser.Math.Clamp(dy, r - b.go.y, arena.height - r - b.go.y);
    }
    for (const b of [this.david, this.ken]) {
      b.go.setPosition(b.go.x + dx, b.go.y + dy);
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
  }

  /**
   * Begin a god-mode drag: freeze BOTH brothers solid.
   *
   * Matter keeps stepping while the player drags. The ungripped brother is the
   * launcher, and it's dynamic — so walls shove it out of the way, the tether
   * spring hauls on it, and it lags or snaps away from the brother in hand
   * (the "really long band"). Repositioning it every pointer move can't win
   * against a simulation running between those moves. Making both bodies static
   * takes them out of the simulation entirely: no collision response, no spring
   * force, and the pair's offset is whatever {@link godMoveTo} says it is.
   *
   * {@link godDrop} thaws them back into their roles.
   *
   * @returns {void}
   */
  godBeginDrag() {
    for (const b of [this.david, this.ken]) {
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
      b.go.setStatic(true);
    }
  }

  /**
   * Undo {@link godBeginDrag}: the anchor stays frozen (as it always is between
   * turns) and the launcher goes back to being dynamic, at rest. Roles never
   * changed, so this just restores the normal aiming state.
   *
   * @returns {void}
   */
  _godThaw() {
    this.anchor.go.setStatic(true);
    this.anchor.go.setRotation(0); // pin offsets are world-axis; keep it aligned
    this.launcher.go.setStatic(false);
    for (const b of [this.david, this.ken]) {
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
  }

  /**
   * Every body a brother can't be inside: solid (non-sensor) and not a brother.
   * Sensors — goals, teleporters, mud and cleaner regions — are things you're
   * *meant* to sit in, so they never block a drop.
   *
   * @returns {MatterJS.BodyType[]}
   */
  _solidBodies() {
    const own = new Set([this.david.go.body, this.ken.go.body]);
    return this.scene.matter.world.localWorld.bodies.filter((b) => !b.isSensor && !own.has(b));
  }

  /** Would a ball of radius `r` centred here overlap something solid? @returns {boolean} */
  _overlapsSolid(x, y, r, solids) {
    const M = Phaser.Physics.Matter.Matter;
    // A throwaway probe body: never added to the world, just used for the query.
    return M.Query.collides(M.Bodies.circle(x, y, r), solids).length > 0;
  }

  /** Is a solid body straddling the straight line between these two points? @returns {boolean} */
  _solidBetween(a, b, solids) {
    const M = Phaser.Physics.Matter.Matter;
    return M.Query.ray(solids, a, b, 2).length > 0;
  }

  /** Is `(x, y)` fully inside the arena for a ball of radius `r`? @returns {boolean} */
  _insideArena(x, y, r) {
    const a = this.david._arena;
    return x >= r && y >= r && x <= a.width - r && y <= a.height - r;
  }

  /**
   * May `b` rest at `(x, y)` while its partner sits at `partner`? It must be in
   * the arena, clear of solids, and able to "see" its partner — a wall between
   * the two would leave them tethered through it.
   *
   * @returns {boolean}
   */
  _legalSpot(b, x, y, partner, solids) {
    return (
      this._insideArena(x, y, b.go.radius) &&
      !this._overlapsSolid(x, y, b.go.radius, solids) &&
      !this._solidBetween({ x, y }, { x: partner.go.x, y: partner.go.y }, solids)
    );
  }

  /**
   * Hunt for a legal spot for `other`, sweeping a full circle around `grabbed`
   * at their current separation. Angles are tried alternating outward from where
   * `other` already is (+10°, -10°, +20°, …), so the nudge is the smallest one
   * that works and the pair keeps roughly the orientation the player dragged.
   *
   * @returns {{x:number, y:number}|null} null when nowhere on the circle is legal.
   */
  _findSpotAround(grabbed, other, solids) {
    const dx = other.go.x - grabbed.go.x;
    const dy = other.go.y - grabbed.go.y;
    // Never search closer than touching, or they'd be dropped overlapping.
    const d = Math.max(Math.hypot(dx, dy), grabbed.go.radius + other.go.radius + 1);
    const base = Math.atan2(dy, dx);
    const steps = 36; // 10° apart: fine enough to slip through a doorway
    for (let i = 1; i <= steps; i++) {
      const k = Math.ceil(i / 2) * (i % 2 ? 1 : -1); // +1, -1, +2, -2, …
      const a = base + (k * 2 * Math.PI) / steps;
      const x = grabbed.go.x + Math.cos(a) * d;
      const y = grabbed.go.y + Math.sin(a) * d;
      if (this._legalSpot(other, x, y, grabbed, solids)) return { x, y };
    }
    return null;
  }

  /** Put both brothers back where the drag began, at rest. @returns {void} */
  _godRevert(start) {
    for (const [b, p] of [
      [this.david, start.david],
      [this.ken, start.ken],
    ]) {
      b.go.setPosition(p.x, p.y);
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
  }

  /**
   * Decide where a god-mode drag actually leaves the brothers. The gripped
   * brother keeps wherever it was dropped, unless that's inside something solid.
   * The other keeps its dragged spot if that's legal; failing that we nudge it
   * around the gripped one; failing that the whole move is undone. Reverting
   * both (not just one) keeps their relative position meaningful — dropping one
   * brother into a wall shouldn't silently teleport only his brother.
   *
   * @param {import('./world/Brother.js').Brother} grabbed
   * @param {{david:{x:number,y:number}, ken:{x:number,y:number}}} start  Positions at grab.
   * @returns {string} What happened, for the HUD and the trace log.
   */
  godDrop(grabbed, start) {
    const outcome = this._godResolveDrop(grabbed, start);
    this._godThaw(); // whatever we decided, the balls stop being god-frozen
    return outcome;
  }

  /**
   * Work out where the drop leaves the brothers (see {@link godDrop}), without
   * touching their frozen/dynamic state.
   *
   * @returns {string}
   */
  _godResolveDrop(grabbed, start) {
    const other = grabbed === this.david ? this.ken : this.david;
    const solids = this._solidBodies();

    // The gripped brother lands where the player let go — the whole point of god
    // mode — but not inside a wall or a bomb.
    if (
      !this._insideArena(grabbed.go.x, grabbed.go.y, grabbed.go.radius) ||
      this._overlapsSolid(grabbed.go.x, grabbed.go.y, grabbed.go.radius, solids)
    ) {
      this._godRevert(start);
      return 'blocked';
    }

    if (this._legalSpot(other, other.go.x, other.go.y, grabbed, solids)) return 'placed';

    const spot = this._findSpotAround(grabbed, other, solids);
    if (spot) {
      other.go.setPosition(spot.x, spot.y);
      other.go.setVelocity(0, 0);
      other.go.setAngularVelocity(0);
      return 'nudged';
    }

    this._godRevert(start);
    return 'no room';
  }

  /**
   * @param {{x:number, y:number, radius:number}} zone
   * @returns {boolean} true if either brother is resting inside the zone.
   */
  anyInside(zone) {
    return [this.david, this.ken].some(
      (b) => Phaser.Math.Distance.Between(b.go.x, b.go.y, zone.x, zone.y) <= zone.radius
    );
  }

  // --- Camera follow target -----------------------------------------------
  // Phaser's camera.startFollow reads `.x`/`.y` off its target each frame, so
  // the pair can be followed directly: these report the midpoint. `spanWidth`/
  // `spanHeight` give the box enclosing both balls (radii included) for a
  // fit-to-view zoom, which follow can't do on its own.

  /** @returns {number} Midpoint x of the two balls (camera follow target). */
  get x() {
    return (this.david.go.x + this.ken.go.x) / 2;
  }

  /** @returns {number} Midpoint y of the two balls (camera follow target). */
  get y() {
    return (this.david.go.y + this.ken.go.y) / 2;
  }

  /** @returns {number} Width of the box enclosing both balls, radii included. */
  get spanWidth() {
    const a = this.david.go;
    const b = this.ken.go;
    return Math.max(a.x + a.radius, b.x + b.radius) - Math.min(a.x - a.radius, b.x - b.radius);
  }

  /** @returns {number} Height of the box enclosing both balls, radii included. */
  get spanHeight() {
    const a = this.david.go;
    const b = this.ken.go;
    return Math.max(a.y + a.radius, b.y + b.radius) - Math.min(a.y - a.radius, b.y - b.radius);
  }
}

export { FACES };
