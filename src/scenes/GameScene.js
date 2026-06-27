import { Config } from '../config.js';
import { Brothers, FACES } from '../Brothers.js';

/**
 * High-level turn state.
 * - AIMING: waiting for the player to drag the launcher.
 * - MOVING: balls are in motion; we watch for them to settle.
 * - OVER:   level won or lost; a click restarts.
 *
 * @typedef {'AIMING'|'MOVING'|'OVER'} GameState
 */

/**
 * The single gameplay scene. Builds the level, wires input and collisions,
 * and runs the turn / moves state machine. The Brothers pair owns its own
 * physics; this scene orchestrates whose turn it is and win/lose.
 */
export class GameScene extends Phaser.Scene {
  constructor() {
    super('game');
  }

  /**
   * @returns {void}
   */
  create() {
    this._buildArena();
    this._buildFloorGrid();
    this._buildWalls();
    this._buildZones();

    this.brothers = new Brothers(this);

    /** @type {GameState} */
    this.state = 'AIMING';
    this.movesLeft = Config.level.moves;
    /** True between pointerdown-on-launcher and pointerup. */
    this.isAiming = false;
    /** Wall-clock ms before which teleporter hits are ignored (debounce). */
    this.teleportLockUntil = 0;
    /** Last finger-spread distance while pinch-zooming (0 = not pinching). */
    this._pinchDist = 0;
    /** Camera-pan drag state. */
    this._isPanning = false;
    this._panLast = { x: 0, y: 0 };

    this._buildHud();
    this._wireInput();
    this._wireCollisions();
    this._setupCameras();
    this._refreshHud();
  }

  /**
   * A faint grid on the arena floor. Drawn below everything (depth -1) so it
   * reads as the ground and scales with the world when the camera zooms,
   * giving the zoom a visible frame of reference.
   *
   * @returns {void}
   */
  _buildFloorGrid() {
    const { width, height } = Config.view;
    const g = Config.grid;
    const gfx = this.add.graphics().setDepth(-1);
    gfx.lineStyle(1, g.color, g.alpha);
    for (let x = g.size; x < width; x += g.size) gfx.lineBetween(x, 0, x, height);
    for (let y = g.size; y < height; y += g.size) gfx.lineBetween(0, y, width, y);
  }

  /**
   * Split rendering between the zoomable world camera and a fixed UI camera so
   * the HUD never zooms or scrolls with the arena. The main camera is bounded
   * to the arena (so zooming in can't scroll past the edges) and renders
   * everything except the HUD; the UI camera renders only the HUD.
   *
   * @returns {void}
   */
  _setupCameras() {
    const { width, height } = Config.view;
    const main = this.cameras.main;
    main.setBounds(0, 0, width, height);
    main.setZoom(1);

    this.uiCamera = this.cameras.add(0, 0, width, height);

    this.hudObjects = [this.turnText, this.movesText, this.restartButton, this.banner];
    main.ignore(this.hudObjects);
    // The UI camera shows only the HUD: ignore every other display object.
    this.uiCamera.ignore(this.children.list.filter((o) => !this.hudObjects.includes(o)));
  }

  // --- Level construction -------------------------------------------------

  /**
   * Outer walls of the arena.
   *
   * @returns {void}
   */
  _buildArena() {
    this.matter.world.setBounds(0, 0, Config.view.width, Config.view.height, 64);
  }

  /**
   * Generate a small, seamless brick-pattern texture once (offset courses of
   * bricks separated by mortar), so walls can be drawn as tiling sprites at
   * any size without an image asset.
   *
   * @returns {void}
   */
  _makeBrickTexture() {
    if (this.textures.exists('brick')) return;
    const mortar = 0x4a3327;
    const brick = 0xb5651d;
    const bw = 24;
    const bh = 11;
    const tile = bw + 2; // brick + mortar gap
    const w = tile * 2; // two courses wide for the half-brick offset
    const h = (bh + 2) * 2;

    const g = this.add.graphics();
    g.fillStyle(mortar, 1).fillRect(0, 0, w, h);
    g.fillStyle(brick, 1);
    // Course 0: bricks flush to the left.
    g.fillRect(0, 0, bw, bh).fillRect(tile, 0, bw, bh);
    // Course 1: offset half a brick (wraps seamlessly across the tile edge).
    g.fillRect(tile / 2, bh + 2, bw, bh);
    g.fillRect(0, bh + 2, tile / 2 - 2, bh); // left partial
    g.fillRect(tile / 2 + bw, bh + 2, tile / 2 - 2, bh); // right partial
    g.generateTexture('brick', w, h);
    g.destroy();
  }

  /**
   * Short interior brick walls: a tiling-sprite visual plus a matching static
   * Matter body for each entry in `Config.level.walls`. Labelled 'wall' so the
   * collision router leaves them alone (they just deflect the balls).
   *
   * @returns {void}
   */
  _buildWalls() {
    this._makeBrickTexture();
    for (const wall of Config.level.walls) {
      this.add.tileSprite(wall.x, wall.y, wall.width, wall.height, 'brick');
      // A thin dark frame so the wall reads crisply against the background.
      this.add
        .rectangle(wall.x, wall.y, wall.width, wall.height)
        .setStrokeStyle(2, 0x2a1d15, 0.9);
      const body = this.matter.add.rectangle(wall.x, wall.y, wall.width, wall.height, {
        isStatic: true,
        restitution: Config.level.wallRestitution,
      });
      body.label = 'wall';
    }
  }

  /**
   * Destination goal and the teleporter source/target, with their sensors.
   *
   * @returns {void}
   */
  _buildZones() {
    const { destination, teleporter } = Config.level;
    const A = Config.anim;

    // Destination goal — an archery target: concentric green rings at a fixed
    // size (so it reads as a goal, not a collectible) plus a slow-rotating
    // crosshair overlay for life. Rings live in a container so the win burst
    // can pop the whole target at once.
    const R = destination.radius;
    const ringBands = [
      { r: R, color: 0x145a32 }, // dark
      { r: R * 0.78, color: 0x2ecc71 }, // bright
      { r: R * 0.55, color: 0x145a32 }, // dark
      { r: R * 0.33, color: 0x2ecc71 }, // bright
      { r: R * 0.14, color: 0xeafff2 }, // bullseye
    ];
    this.destinationGfx = this.add.container(
      destination.x,
      destination.y,
      ringBands.map((b) => this.add.circle(0, 0, b.r, b.color))
    );
    this.destinationReticle = this._buildReticle(destination.x, destination.y, R);
    this._startDestinationPulse();
    const goal = this.matter.add.circle(destination.x, destination.y, destination.radius, {
      isSensor: true,
      isStatic: true,
    });
    goal.label = 'destination';

    // Teleporter source (entrance) — breathing fill...
    this.teleporterGfx = this.add.circle(
      teleporter.source.x,
      teleporter.source.y,
      teleporter.source.radius,
      0x9b59b6,
      0.5
    );
    this.tweens.add({
      targets: this.teleporterGfx,
      fillAlpha: A.teleporter.pulseAlpha,
      duration: A.teleporter.pulseDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
    // ...plus a slow-rotating ring so the swirl is actually visible.
    const portalRing = this.add
      .circle(teleporter.source.x, teleporter.source.y, teleporter.source.radius * A.teleporter.ringRadiusScale)
      .setStrokeStyle(3, 0x9b59b6, 0.7);
    this.tweens.add({
      targets: portalRing,
      angle: 360,
      duration: A.teleporter.ringRotateDuration,
      repeat: -1,
    });
    const portal = this.matter.add.circle(
      teleporter.source.x,
      teleporter.source.y,
      teleporter.source.radius,
      { isSensor: true, isStatic: true }
    );
    portal.label = 'teleporter';

    // Teleporter target (exit) — visual marker with a calm idle breathe.
    this.targetGfx = this.add
      .rectangle(teleporter.target.x, teleporter.target.y, 70, 70)
      .setStrokeStyle(2, 0xe67e22, 0.6)
      .setAlpha(A.target.idleAlphaLow);
    this.tweens.add({
      targets: this.targetGfx,
      alpha: A.target.idleAlphaHigh,
      duration: A.target.idleDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
  }

  /**
   * One-shot expanding-and-fading ring, used to punctuate teleport-out,
   * teleport-in, and (in a brighter form) a level win.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} radius  Starting radius of the ring.
   * @param {number} color   Stroke colour.
   * @returns {void}
   */
  _spawnRing(x, y, radius, color) {
    const ring = this.add.circle(x, y, radius).setStrokeStyle(3, color, 0.9).setDepth(5);
    this.uiCamera?.ignore(ring); // world effect: keep it off the fixed HUD camera
    this.tweens.add({
      targets: ring,
      scale: Config.anim.ring.growScale,
      alpha: 0,
      duration: Config.anim.ring.duration,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * On-screen text: moves remaining, whose turn, the restart button, and the
   * centre banner.
   *
   * @returns {void}
   */
  _buildHud() {
    this.turnText = this.add.text(20, 18, '', { fontSize: '22px' }).setDepth(10);
    this.movesText = this.add
      .text(Config.view.width - 20, 18, '', { fontSize: '22px', color: '#dddddd' })
      .setOrigin(1, 0)
      .setDepth(10);

    // Restart button: re-runs create(), which resets moves, turn, and the
    // brothers' starting positions. Hover brightens it for affordance.
    this.restartButton = this.add
      .text(Config.view.width / 2, 18, 'Restart level', {
        fontSize: '20px',
        color: '#ffffff',
        backgroundColor: '#444444',
        padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5, 0)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    this.restartButton.on('pointerover', () => this.restartButton.setBackgroundColor('#666666'));
    this.restartButton.on('pointerout', () => this.restartButton.setBackgroundColor('#444444'));
    this.restartButton.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation(); // don't let the click reach the aim/restart router
      this.scene.restart();
    });
    this.banner = this.add
      .text(Config.view.width / 2, Config.view.height / 2, '', {
        fontSize: '48px',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(10);
  }

  // --- Input --------------------------------------------------------------

  /**
   * Slingshot, pan, and zoom input. A drag only aims if it *starts* on the
   * current launcher (a hit-test), so stray presses never fire a launch —
   * those pan the camera instead. Wheel and pinch handle zoom.
   *
   * @returns {void}
   */
  _wireInput() {
    this.input.on('pointerdown', (p) => {
      if (this.state === 'OVER') {
        this.scene.restart();
        return;
      }
      if (this._pinchDist) return; // a two-finger pinch owns the gesture

      // Pressing on the launcher (while aiming) starts a shot; pressing
      // anywhere else on the board pans the camera instead.
      if (this.state === 'AIMING') {
        const l = this.brothers.launcher.go;
        const reach = Config.ball.radius * 1.4; // forgiving for touch
        const w = this.cameras.main.getWorldPoint(p.x, p.y);
        if (Phaser.Math.Distance.Between(w.x, w.y, l.x, l.y) <= reach) {
          this.isAiming = true;
          this.brothers.beginAim();
          return;
        }
      }
      this._isPanning = true;
      this._panLast.x = p.x;
      this._panLast.y = p.y;
    });

    this.input.on('pointermove', (p) => {
      if (this.isAiming) {
        const w = this.cameras.main.getWorldPoint(p.x, p.y);
        this.brothers.dragTo(w.x, w.y);
        return;
      }
      if (this._isPanning) {
        // Drag the world under the finger: scroll opposite to the move,
        // scaled by zoom. Camera bounds clamp it to the arena.
        const cam = this.cameras.main;
        cam.setScroll(
          cam.scrollX - (p.x - this._panLast.x) / cam.zoom,
          cam.scrollY - (p.y - this._panLast.y) / cam.zoom
        );
        this._panLast.x = p.x;
        this._panLast.y = p.y;
      }
    });

    this.input.on('pointerup', () => {
      this._isPanning = false;
      if (!this.isAiming) return;
      this.isAiming = false;

      const pull = this.brothers.release();
      if (pull < Config.slingshot.minPull) return; // mis-click: no move spent

      this.movesLeft -= 1;
      this.state = 'MOVING';
      this._refreshHud();
    });

    // Laptop: mouse wheel zooms toward the cursor.
    this.input.on('wheel', (p, _over, _dx, dy) => {
      const step = Config.zoom.wheelStep;
      this._zoomBy(dy > 0 ? 1 - step : 1 + step, p.x, p.y);
    });

    // Mobile: make a second touch pointer available for pinch (handled in
    // update() so we can track the changing finger spread frame to frame).
    this.input.addPointer(1);
  }

  /**
   * Multiply the camera zoom by `factor` (clamped) while keeping the world
   * point under (`screenX`, `screenY`) fixed, so zoom homes in on the cursor
   * or pinch midpoint rather than the screen centre. Camera bounds keep the
   * view from scrolling past the arena edges.
   *
   * @param {number} factor   Zoom multiplier (>1 in, <1 out).
   * @param {number} screenX  Focal point, screen pixels.
   * @param {number} screenY
   * @returns {void}
   */
  _zoomBy(factor, screenX, screenY) {
    const cam = this.cameras.main;
    const before = cam.getWorldPoint(screenX, screenY);
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, Config.zoom.min, Config.zoom.max));
    const after = cam.getWorldPoint(screenX, screenY);
    cam.setScroll(cam.scrollX + (before.x - after.x), cam.scrollY + (before.y - after.y));
  }

  /**
   * Two-finger pinch zoom. Tracks the spread between the two active touch
   * pointers; the per-frame change in spread drives the zoom about their
   * midpoint. Cancels any in-progress aim so a pinch never fires a shot.
   *
   * @returns {void}
   */
  _updatePinch() {
    const p1 = this.input.pointer1;
    const p2 = this.input.pointer2;
    if (!(p1?.isDown && p2?.isDown)) {
      this._pinchDist = 0;
      return;
    }
    this._isPanning = false; // pinch takes over from a single-finger pan
    if (this.isAiming) {
      this.isAiming = false;
      this.brothers.cancelAim();
    }
    const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    if (this._pinchDist > 0 && dist > 0) {
      this._zoomBy(dist / this._pinchDist, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    }
    this._pinchDist = dist;
  }

  /**
   * Collision routing: brother-on-brother triggers the Hybrid Snap, and a
   * brother touching the teleporter warps the pair. The win check happens at
   * settle time (distance-based), not here, so a fast fly-through doesn't win.
   *
   * @returns {void}
   */
  _wireCollisions() {
    this.matter.world.on('collisionstart', (event) => {
      // Snap and teleport are only meaningful while a shot is in flight. The
      // pull-only tether lets the pair rest in contact, so a contact during
      // AIMING must NOT trigger the snap (it would unfreeze the anchor and let
      // a drag move the brother that's supposed to be immobile).
      if (this.state !== 'MOVING') return;

      for (const pair of event.pairs) {
        const labels = [pair.bodyA.label, pair.bodyB.label];

        if (labels[0] === 'brother' && labels[1] === 'brother') {
          this.brothers.snap();
        } else if (labels.includes('brother') && labels.includes('teleporter')) {
          this._handleTeleport();
        }
      }
    });
  }

  /**
   * Warp the pair, debounced so overlapping the sensor for several frames
   * fires only once.
   *
   * @returns {void}
   */
  _handleTeleport() {
    if (this.time.now < this.teleportLockUntil) return;
    this.teleportLockUntil = this.time.now + 600;

    const { source, target, retainVelocity } = Config.level.teleporter;

    // Punctuate the warp: a ring collapsing out of the entrance and a fresh
    // ring blooming at the exit so the eye follows source -> target.
    this._spawnRing(source.x, source.y, source.radius, 0x9b59b6);
    this._spawnRing(target.x, target.y, 18, 0xe67e22);

    this.brothers.teleport(target, retainVelocity);
  }

  // --- Per-frame loop -----------------------------------------------------

  /**
   * @returns {void}
   */
  update() {
    this.brothers.update();
    this._updatePinch();

    if (this.state === 'MOVING') {
      this.brothers.brakeSlowMotion();
      if (this.brothers.isSettled()) this._resolveTurn();
    }
  }

  /**
   * Called once both balls have settled. Decide win / lose / next turn.
   *
   * @returns {void}
   */
  _resolveTurn() {
    if (this.brothers.anyInside(Config.level.destination)) {
      this._winBurst();
      this._endGame('LEVEL CLEAR!', FACES.win);
      return;
    }
    if (this.movesLeft <= 0) {
      this._endGame('OUT OF MOVES', FACES.lose);
      return;
    }
    this.brothers.swapRoles();
    this.state = 'AIMING';
    this._refreshHud();
  }

  /**
   * Celebratory one-shot at the destination when the level is cleared:
   * a quick scale pop on the goal plus an expanding ring.
   *
   * @returns {void}
   */
  _winBurst() {
    const d = Config.level.destination;
    const a = Config.anim.destination;
    this.tweens.killTweensOf(this.destinationGfx);
    this.destinationGfx.setScale(1);
    // Pop the whole target once. The reticle keeps spinning independently.
    this.tweens.add({
      targets: this.destinationGfx,
      scale: a.winBurstScale,
      duration: a.winBurstDuration,
      ease: 'Back.Out',
      yoyo: true,
    });
    this._spawnRing(d.x, d.y, d.radius, 0x2ecc71);
  }

  /**
   * Build the rotating crosshair/reticle overlay for the target: four ticks
   * around the rim with a gap over the bullseye, plus a thin outer ring. Drawn
   * around its own origin so it rotates cleanly about the target's center.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} radius  The target's outer radius.
   * @returns {Phaser.GameObjects.Graphics}
   */
  _buildReticle(x, y, radius) {
    const inner = radius * 0.85;
    const outer = radius * 1.25;
    const g = this.add.graphics({ x, y });
    g.lineStyle(2, 0xffffff, 0.6);
    g.beginPath();
    g.moveTo(0, -outer);
    g.lineTo(0, -inner);
    g.moveTo(0, inner);
    g.lineTo(0, outer);
    g.moveTo(-outer, 0);
    g.lineTo(-inner, 0);
    g.moveTo(inner, 0);
    g.lineTo(outer, 0);
    g.strokePath();
    g.strokeCircle(0, 0, outer);
    return g;
  }

  /**
   * Start the destination's idle motion: a slow, continuous rotation of the
   * reticle overlay. The target rings themselves stay fixed in size.
   *
   * @returns {void}
   */
  _startDestinationPulse() {
    this.tweens.add({
      targets: this.destinationReticle,
      angle: 360,
      duration: Config.anim.destination.reticleRotateDuration,
      repeat: -1,
    });
  }

  /**
   * Show the end banner and wait for a click to restart.
   *
   * @param {string} message
   * @param {string} face  Emoji shown on both brothers.
   * @returns {void}
   */
  _endGame(message, face) {
    this.state = 'OVER';
    this.brothers.setBothFaces(face);
    this.banner.setText(`${message}\nclick to restart`);
  }

  /**
   * Sync the HUD text to current turn and moves.
   *
   * @returns {void}
   */
  _refreshHud() {
    const launcher = this.brothers.launcher;
    this.turnText.setText(`${launcher.name}'s turn — drag to aim`).setColor(launcher.color);
    this.movesText.setText(`Moves left: ${this.movesLeft}`);
  }
}
