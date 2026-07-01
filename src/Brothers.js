import { Config } from './config.js';
import { sfx } from './Sfx.js';

/**
 * Emoji faces per game state. Faces float on top of the physics bodies and
 * are kept upright, so they stay legible no matter how the balls spin.
 */
const FACES = {
  idle: { launcher: '😃', anchor: '🤨' },
  drag: { launcher: '😏', anchor: '😳' },
  flight: { launcher: '😁', anchor: '😨' },
  collision: '😬',
  dizzy: '😖',
  win: '😎',
  lose: '😭',
};

/**
 * @typedef {Object} Brother
 * @property {string} name        Display name ("David" / "Ken").
 * @property {string} color       CSS colour for this brother's UI text.
 * @property {Phaser.GameObjects.Arc} go    The circle game object + Matter body.
 * @property {Phaser.GameObjects.Text} face The emoji face, locked upright.
 */

/**
 * Owns the David/Ken pair: their bodies, the elastic tether, the upright
 * faces, role swapping, the "Hybrid Snap", settle detection, and teleporting.
 * The scene creates exactly one of these and drives it.
 */
export class Brothers {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('./levels.js').Level} level  Spawns, walls, and arena bounds.
   */
  constructor(scene, level) {
    this.scene = scene;
    /** Level data this pair lives in (spawns/objects/arena). */
    this._level = level;
    /**
     * Wall rectangles (centre `x,y` + `width,height`) pulled once from the
     * generic object list — used by the aim-blocking geometry. The world layer
     * owns wall *rendering/physics*; this is just the collision math for legal
     * launches, so it only needs the shapes.
     */
    this._walls = (level.objects || []).filter((o) => o.kind === 'wall');

    // Ken is the baseline; David is sized/massed relative to him. Radii are set
    // at creation; masses (and live lab tweaks to David) are applied just below.
    const kenRadius = Config.ball.radius * (level.kenRadiusMult ?? 1);
    const davidRadius = kenRadius * Config.ball.davidRadiusMult * (level.davidRadiusMult ?? 1);
    this.david = this._createBrother('David', '#3aa0ff', 0x3aa0ff, level.david, davidRadius);
    this.ken = this._createBrother('Ken', '#ff5a4d', 0xff5a4d, level.ken, kenRadius);

    // Ken's mass: his natural (area-based) mass, scaled by the level. David's
    // mass is derived from Ken's in _applyDavidPhysique (called here + per frame
    // so the lab's David sliders take effect live).
    this._kenRadius = kenRadius;
    this._kenMass = this.ken.go.body.mass * (level.kenMassMult ?? 1);
    this.ken.go.setMass(this._kenMass);
    this._davidRadius = davidRadius; // body already created at this radius
    this._davidMass = NaN; // force the first mass apply
    this._applyDavidPhysique();

    /** @type {Brother} The brother currently being slingshotted. */
    this.launcher = this.david;
    /** @type {Brother} The frozen brother that unfreezes on impact. */
    this.anchor = this.ken;

    /** The elastic band, drawn fresh each frame (see {@link update}). */
    this.band = scene.add.graphics();

    /** Pulsing halo ring marking whichever ball can currently be moved. */
    this._glow = this._createGlow();

    // Faces are created after the band and glow so they render on top.
    this.david.face = this._createFace(level.david, FACES.idle.launcher);
    this.ken.face = this._createFace(level.ken, FACES.idle.anchor);

    /** David's rectangular glasses, overlaid on his face (see {@link update}). */
    this._davidGlasses = this._createGlasses();
    /** Ken's mustache, overlaid on his face (see {@link update}). */
    this._kenMustache = this._createMustache();

    /** True while the player is dragging the launcher to aim. */
    this._aiming = false;
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
  }

  /**
   * Create one brother's circular body at the given radius.
   *
   * @param {string} name
   * @param {string} cssColor   Colour for UI text.
   * @param {number} fillColor  0xRRGGBB fill for the circle.
   * @param {{x:number, y:number}} pos
   * @param {number} r          Body/visual radius.
   * @returns {Brother}
   */
  _createBrother(name, cssColor, fillColor, pos, r) {
    const go = this.scene.add.circle(pos.x, pos.y, r, fillColor);
    this.scene.matter.add.gameObject(go, {
      shape: { type: 'circle', radius: r },
      restitution: Config.ball.restitution,
      frictionAir: Config.ball.frictionAir,
    });
    go.body.label = 'brother';
    return { name, color: cssColor, go, face: /** @type {*} */ (null) };
  }

  /**
   * Set David's radius and mass from the lab's Config.ball.davidRadiusMult /
   * davidMassMult (and this level's David multipliers), both relative to Ken.
   * Called once at construction and again whenever the lab changes a value (see
   * GameScene._adjustParam/_promptParam/_resetParams) — not per frame. A no-op
   * when nothing changed.
   *
   * @returns {void}
   */
  _applyDavidPhysique() {
    const lvl = this._level;
    const targetR = this._kenRadius * Config.ball.davidRadiusMult * (lvl.davidRadiusMult ?? 1);
    const targetM = this._kenMass * Config.ball.davidMassMult * (lvl.davidMassMult ?? 1);
    let massDirty = targetM !== this._davidMass;
    if (Math.abs(targetR - this._davidRadius) > 1e-3) {
      const factor = targetR / this._davidRadius;
      Phaser.Physics.Matter.Matter.Body.scale(this.david.go.body, factor, factor);
      this.david.go.radius = targetR; // resize the visual circle to match
      this._davidRadius = targetR;
      massDirty = true; // Body.scale recomputes mass from area; restore ours
    }
    if (massDirty) {
      this.david.go.setMass(targetM);
      this._davidMass = targetM;
    }
  }

  /**
   * Create an upright emoji face.
   *
   * @param {{x:number, y:number}} pos
   * @param {string} emoji
   * @returns {Phaser.GameObjects.Text}
   */
  _createFace(pos, emoji) {
    return this.scene.add
      .text(pos.x, pos.y, emoji, { fontSize: '34px' })
      .setOrigin(0.5);
  }

  /**
   * Build David's glasses: two black rectangular lens frames (wider than tall)
   * joined by a bridge, drawn around their own origin so {@link update} can sit
   * them over the eyes. Lenses are open frames, so the emoji's eyes/eyebrows
   * still show through. Hidden on the win face (it already has shades).
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createGlasses() {
    const g = this.scene.add.graphics();
    g.lineStyle(2, 0x000000, 1);
    g.strokeRoundedRect(-12.5, -4, 11, 7, 2); // left lens
    g.strokeRoundedRect(1.5, -4, 11, 7, 2); // right lens
    g.lineBetween(-1.5, -0.5, 1.5, -0.5); // bridge
    return g;
  }

  /**
   * Build Ken's mustache: two black lobes (wider than tall) meeting at the
   * centre, drawn around their own origin so {@link update} can sit them above
   * his mouth. Shown on every expression.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createMustache() {
    const g = this.scene.add.graphics();
    g.fillStyle(0x000000, 1);
    g.fillEllipse(-5, 0, 10, 3); // left half
    g.fillEllipse(5, 0, 10, 3); // right half
    return g;
  }

  /**
   * Build the pulsing halo ring: a stroked circle that repeatedly expands
   * and fades out to draw the eye to the movable ball. Positioned each frame
   * by {@link update}.
   *
   * @returns {Phaser.GameObjects.Arc}
   */
  _createGlow() {
    const ring = this.scene.add.circle(
      this.launcher.go.x,
      this.launcher.go.y,
      Config.ball.radius + 8,
      0xffffff,
      0 // fillAlpha 0: we only want the stroke
    );
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
   * Glue faces to bodies (kept upright) and redraw the tether. Call once
   * per frame from the scene's update.
   *
   * @returns {void}
   */
  update() {
    this._applyPullOnlyTether();
    this._containInArena();

    for (const b of [this.david, this.ken]) {
      b.face.setPosition(b.go.x, b.go.y);
      b.face.rotation = 0;
    }

    // David wears rectangular glasses over his eyes on every expression except
    // the win face (😎), which already has shades.
    this._davidGlasses.setPosition(this.david.go.x, this.david.go.y - 7);
    this._davidGlasses.setVisible(this.david.face.text !== FACES.win);

    // Ken sports a mustache above his mouth on every expression.
    this._kenMustache.setPosition(this.ken.go.x, this.ken.go.y + 1);

    // Keep the glow ring centred on the movable ball (its scale is tweened).
    this._glow.setPosition(this.launcher.go.x, this.launcher.go.y);

    // While aiming, flag an unlaunchable position with a red X over BOTH balls
    // (so it shows even under the finger dragging one of them).
    const refuse = this._aiming && this._launcherBlocked();
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
   * Hard safety net: keep both balls inside the arena no matter what. Matter's
   * world-bounds walls can be tunnelled through at high launch speeds (a fast
   * ball can jump clean past them in a single step), so each frame we clamp any
   * dynamic ball back inside the play area and reflect the offending velocity
   * component — matching the bounce the wall would have given — so it never
   * escapes and still rebounds naturally.
   *
   * @returns {void}
   */
  _containInArena() {
    const e = Config.ball.restitution;
    const { width, height } = this._level.arena;
    for (const b of [this.david, this.ken]) {
      const body = b.go.body;
      if (body.isStatic) continue; // a frozen ball isn't moving anywhere

      const r = b.go.radius; // brothers can differ in size (David is bigger)
      let { x, y } = b.go;
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
        b.go.setPosition(x, y);
        b.go.setVelocity(vx, vy);
      }
    }
  }

  /**
   * Set both faces from a role-relative state (launcher vs. anchor).
   *
   * @param {'idle'|'drag'|'flight'} state
   * @returns {void}
   */
  setExpressions(state) {
    this.launcher.face.setText(FACES[state].launcher);
    this.anchor.face.setText(FACES[state].anchor);
  }

  /**
   * Set both faces to the same emoji (impact flash, win, lose, dizzy).
   *
   * @param {string} emoji
   * @returns {void}
   */
  setBothFaces(emoji) {
    this.david.face.setText(emoji);
    this.ken.face.setText(emoji);
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
    const { width, height } = this._level.arena;
    const walls = this._walls;

    // Poking past an arena edge?
    if (l.x < r || l.x > width - r || l.y < r || l.y > height - r) return true;

    // Overlapping the other brother? (sum of both radii)
    if (Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y) < r + a.radius) return true;

    // Sitting on a wall (closest-point circle/rectangle overlap)?
    const onWall = walls.some((w) => {
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
    return walls.some((w) =>
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
}

export { FACES };
