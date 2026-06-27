import { Config } from './config.js';

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

    for (const b of [this.david, this.ken]) {
      b.face.setPosition(b.go.x, b.go.y);
      b.face.rotation = 0;
    }

    // Keep the glow ring centred on the movable ball (its scale is tweened).
    this._glow.setPosition(this.launcher.go.x, this.launcher.go.y);

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
    this.launcher.go.setStatic(true);
    this.setExpressions('drag');
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
    this.launcher.go.setStatic(false);
    this.launcher.go.setVelocity(0, 0);
    this.setExpressions('idle');
  }

  /**
   * Would launching from the current pulled-back spot start the ball already
   * overlapping something solid? Checked with plain geometry (no Matter query)
   * against the three kinds of solid thing: the arena edges, the other
   * brother, and the interior walls. The destination goal and teleporter are
   * deliberately not checked — they're non-solid, so resting on them is fine.
   *
   * @returns {boolean}
   */
  _launcherBlocked() {
    const l = this.launcher.go;
    const r = Config.ball.radius;
    const { width, height } = Config.view;

    // Poking past an arena edge?
    if (l.x < r || l.x > width - r || l.y < r || l.y > height - r) return true;

    // Overlapping the other brother?
    const a = this.anchor.go;
    if (Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y) < r * 2) return true;

    // Overlapping any interior wall (closest-point circle/rectangle test)?
    return Config.level.walls.some((w) => {
      const nx = Phaser.Math.Clamp(l.x, w.x - w.width / 2, w.x + w.width / 2);
      const ny = Phaser.Math.Clamp(l.y, w.y - w.height / 2, w.y + w.height / 2);
      return Phaser.Math.Distance.Between(l.x, l.y, nx, ny) < r;
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
