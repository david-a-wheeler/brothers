import { Config } from './config.js';
import { sfx } from './Sfx.js';

/**
 * Emoji faces per game state. Faces float on top of the physics bodies and
 * are kept upright, so they stay legible no matter how the balls spin.
 * Mirrors the expression matrix in plan.md section 3.
 */
const FACES = {
  idle: { launcher: '😃', anchor: '🤨' },
  drag: { launcher: '😤', anchor: '😳' },
  flight: { launcher: '🚀', anchor: '😨' },
  collision: '💥',
  dizzy: '🌀',
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
   */
  constructor(scene) {
    this.scene = scene;

    this.david = this._createBrother('David', '#3aa0ff', 0x3aa0ff, Config.level.david);
    this.ken = this._createBrother('Ken', '#ff5a4d', 0xff5a4d, Config.level.ken);

    /** @type {Brother} The brother currently being slingshotted. */
    this.launcher = this.david;
    /** @type {Brother} The frozen brother that unfreezes on impact. */
    this.anchor = this.ken;

    /** The elastic band, drawn fresh each frame (see {@link update}). */
    this.band = scene.add.graphics();

    /** Pulsing halo ring marking whichever ball can currently be moved. */
    this._glow = this._createGlow();

    // Faces are created after the band and glow so they render on top.
    this.david.face = this._createFace(Config.level.david, FACES.idle.launcher);
    this.ken.face = this._createFace(Config.level.ken, FACES.idle.anchor);

    /** True while the player is dragging the launcher to aim. */
    this._aiming = false;
    /** Red "X" shown over the launcher when the current aim can't be fired. */
    this._refusalX = this._createRefusalX();

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
   * Create one brother's circular body.
   *
   * @param {string} name
   * @param {string} cssColor   Colour for UI text.
   * @param {number} fillColor  0xRRGGBB fill for the circle.
   * @param {{x:number, y:number}} pos
   * @returns {Brother}
   */
  _createBrother(name, cssColor, fillColor, pos) {
    const r = Config.ball.radius;
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

    // Keep the glow ring centred on the movable ball (its scale is tweened).
    this._glow.setPosition(this.launcher.go.x, this.launcher.go.y);

    // While aiming, flag an unlaunchable position with a red X over the ball.
    const refuse = this._aiming && this._launcherBlocked();
    this._refusalX.setVisible(refuse);
    if (refuse) this._refusalX.setPosition(this.launcher.go.x, this.launcher.go.y);

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
    const gap = Phaser.Math.Distance.Between(
      this.david.go.x,
      this.david.go.y,
      this.ken.go.x,
      this.ken.go.y
    );
    this._tether.stiffness = gap > Config.tether.restLength ? Config.tether.stiffness : 0;
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
    const r = Config.ball.radius;
    const e = Config.ball.restitution;
    const { width, height } = Config.view;
    for (const b of [this.david, this.ken]) {
      const body = b.go.body;
      if (body.isStatic) continue; // a frozen ball isn't moving anywhere

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

    // Drive the stretching-band sound from how far it's drawn past rest length.
    const gap = Phaser.Math.Distance.Between(a.x, a.y, x, y);
    const rest = Config.tether.restLength;
    sfx.updateBand((gap - rest) / (max - rest));
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
    this._refusalX.setVisible(false);
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
   *  - the launch *path* (launcher -> anchor, i.e. the elastic) crosses an
   *    interior wall. The ball flies roughly along the elastic, so a wall in
   *    the line of fire would mean a clipped, chaotic shot — even though the
   *    launcher itself sits in open space. Each wall is inflated by the ball
   *    radius so a path that merely grazes a wall edge is caught too.
   * The destination goal and teleporter aren't checked — they're non-solid,
   * so resting on or firing across them is fine.
   *
   * @returns {boolean}
   */
  _launcherBlocked() {
    const l = this.launcher.go;
    const a = this.anchor.go;
    const r = Config.ball.radius;
    const { width, height } = Config.view;

    // Poking past an arena edge?
    if (l.x < r || l.x > width - r || l.y < r || l.y > height - r) return true;

    // Overlapping the other brother?
    if (Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y) < r * 2) return true;

    // Sitting on a wall (closest-point circle/rectangle overlap)?
    const onWall = Config.level.walls.some((w) => {
      const nx = Phaser.Math.Clamp(l.x, w.x - w.width / 2, w.x + w.width / 2);
      const ny = Phaser.Math.Clamp(l.y, w.y - w.height / 2, w.y + w.height / 2);
      return Phaser.Math.Distance.Between(l.x, l.y, nx, ny) < r;
    });
    if (onWall) return true;

    // Elastic / flight path crossing a wall (rectangle inflated by the radius)?
    const path = new Phaser.Geom.Line(l.x, l.y, a.x, a.y);
    return Config.level.walls.some((w) => {
      const rect = new Phaser.Geom.Rectangle(
        w.x - w.width / 2 - r,
        w.y - w.height / 2 - r,
        w.width + r * 2,
        w.height + r * 2
      );
      return Phaser.Geom.Intersects.LineToRectangle(path, rect);
    });
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
    // Eased launch: normalise the pull, then apply a >1 exponent so gentle
    // pulls stay gentle while a full draw still hits hard.
    const t = Phaser.Math.Clamp((pull - s.minPull) / (s.maxPull - s.minPull), 0, 1);
    const speed = s.maxSpeed * Math.pow(t, s.curve);
    this._aiming = false;
    this._refusalX.setVisible(false);
    sfx.stopBand();
    l.setStatic(false);
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
