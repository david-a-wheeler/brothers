import { Config } from './config.js';
import { FACES } from './faces.js';
import { sfx } from './Sfx.js';
import { David } from './world/David.js';
import { Ken } from './world/Ken.js';
import { Wall } from './world/Wall.js';

/**
 * Coordinates the David/Ken pair. The two brothers are {@link Brother} entities
 * that the {@link World} builds from the level's `david`/`ken` objects and that
 * own their own bodies and views; this class finds them and drives everything
 * *between* them: the elastic tether, the upright faces' expressions, role
 * swapping, the "Hybrid Snap", settle detection, and teleporting. The scene
 * creates exactly one of these (after the world) and drives it.
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

    /** The elastic band, drawn fresh each frame (see {@link update}). */
    this.band = scene.add.graphics().setDepth(4);

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
    const ring = this.scene.add
      .circle(this.launcher.go.x, this.launcher.go.y, Config.ball.radius + 8, 0xffffff, 0)
      .setDepth(5);
    ring.setStrokeStyle(3, 0xfff2a8, 0.9);

    /** Looping expand-and-fade pulse. Paused while the ring is hidden. */
    this._glowTween = this.scene.tweens.add({
      targets: ring,
      scale: { from: 1, to: 1.5 },
      alpha: { from: 0.8, to: 0 },
      duration: 900,
      ease: 'Sine.easeOut',
      repeat: -1,
    });
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
    const g = this.scene.add.graphics().setDepth(20).setVisible(false);
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

    this.band.clear();
    this.band.lineStyle(4, 0xf3c969, 0.85);
    this.band.lineBetween(this.david.go.x, this.david.go.y, this.ken.go.x, this.ken.go.y);
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
    const gap = Phaser.Math.Distance.Between(
      this.david.go.x,
      this.david.go.y,
      this.ken.go.x,
      this.ken.go.y
    );
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
    const band = new Phaser.Geom.Line(l.x, l.y, a.x, a.y);
    return walls.some(({ def: w }) =>
      Phaser.Geom.Intersects.LineToRectangle(
        band,
        new Phaser.Geom.Rectangle(w.x - w.width / 2, w.y - w.height / 2, w.width, w.height)
      )
    );
  }

  /**
   * Release the slingshot: fire the launcher toward the anchor. The anchor
   * stays frozen until they collide (see {@link snap}).
   *
   * @returns {number} The pull distance in pixels (the scene uses this to
   *   decide whether a real launch happened).
   */
  release() {
    const l = this.launcher.go;
    const a = this.anchor.go;
    const s = Config.slingshot;
    const pull = Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y);

    // Block a too-short pull, OR a release where the ball would start already
    // overlapping something solid (the other brother, a wall, or the board
    // edge). Either way it's not a real launch and costs the player no move.
    if (pull < s.minPull || this._launcherBlocked()) {
      this.cancelAim();
      return 0;
    }

    const angle = Phaser.Math.Angle.Between(l.x, l.y, a.x, a.y);
    // Eased launch between a non-zero floor and the max: normalise the pull and
    // apply a >1 exponent so gentle pulls stay gentle, but `minSpeed` ensures
    // even the shortest valid pull still carries the pair a meaningful distance.
    const t = Phaser.Math.Clamp((pull - s.minPull) / (s.maxPull - s.minPull), 0, 1);
    const speed = s.minSpeed + (s.maxSpeed - s.minSpeed) * Math.pow(t, s.curve);
    this._aiming = false;
    this._refusalXs.forEach((x) => x.setVisible(false));
    sfx.stopBand();
    l.setStatic(false);
    // Matter normalises velocity to per-frame units regardless of sub-step
    // count, so `speed` is passed through unscaled.
    l.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
    this.setExpressions('flight');
    this._hideIndicator();
    return pull;
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
   * End-of-turn handoff: fully stop both balls, swap launcher/anchor, and
   * refreeze the new anchor for the next aim.
   *
   * @returns {void}
   */
  swapRoles() {
    for (const b of [this.david, this.ken]) {
      b.go.setVelocity(0, 0);
      b.go.setAngularVelocity(0);
    }
    [this.launcher, this.anchor] = [this.anchor, this.launcher];
    this.anchor.go.setStatic(true);
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
