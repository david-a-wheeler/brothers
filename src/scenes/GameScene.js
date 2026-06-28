import { Config, applyRubberBandDefaults } from '../config.js';
import { Brothers, FACES } from '../Brothers.js';
import { sfx } from '../Sfx.js';
import {
  currentLevel,
  currentLevelKey,
  levelCount,
  currentIndex,
  setLevelIndex,
} from '../levels.js';

/**
 * Level state is tracked along two axes.
 *
 * `status` — the level lifecycle:
 * - READY:   not started yet; the board is pristine (no launch made).
 * - PLAYING: in progress.
 * - ENDED:   finished, by a win or a loss.
 *
 * `phase` — the turn phase, only meaningful while PLAYING:
 * - AIMING: waiting for the player to drag/release the launcher.
 * - MOVING: balls are in flight; we watch for them to settle.
 *
 * @typedef {'READY'|'PLAYING'|'ENDED'} LevelStatus
 * @typedef {'AIMING'|'MOVING'} TurnPhase
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
   * Load image assets. Icons are SVGs rasterised at a high size; the HUD then
   * display-sizes them per layout (setDisplaySize) so they stay crisp when
   * enlarged for touch on small screens.
   *
   * @returns {void}
   */
  preload() {
    const icons = {
      'icon-restart': 'arrow-clockwise',
      'icon-prev': 'chevron-left',
      'icon-next': 'chevron-right',
      'icon-ready': 'flag',
      'icon-playing': 'controller',
      'icon-ended': 'flag-fill',
      'icon-beaker': 'beaker',
    };
    for (const [key, name] of Object.entries(icons)) {
      if (!this.textures.exists(key)) {
        this.load.svg(key, `assets/icons/${name}.svg`, { width: 64, height: 64 });
      }
    }
  }

  /**
   * @returns {void}
   */
  create() {
    // Take over physics stepping so we can sub-step (see update()); Matter's
    // own per-frame step would otherwise run once at the full frame delta.
    this.matter.world.autoUpdate = false;

    /** The current level model (from Tiled via levels.js). */
    this.level = currentLevel();
    /** Per-level arena size (varies between levels); drives bounds/camera/grid. */
    this.arena = this.level.arena;
    /** Registry key for this level's best result, so packs don't share scores. */
    this._bestKey = `best:${currentLevelKey()}`;

    this._buildArena();
    this._buildFloorGrid();
    this._buildWalls();
    this._buildZones();

    this.brothers = new Brothers(this, this.level);

    /** @type {LevelStatus} */
    this.status = 'READY';
    /** @type {TurnPhase} */
    this.phase = 'AIMING';
    this.movesLeft = this.level.moves;
    // Best winning result = the most moves ever left over on a win. Kept in the
    // registry (keyed per level) so it survives scene restarts; null until won.
    if (!this.registry.has(this._bestKey)) this.registry.set(this._bestKey, null);
    /** True between pointerdown-on-launcher and pointerup. */
    this.isAiming = false;
    /** Wall-clock ms before which teleporter hits are ignored (debounce). */
    this.teleportLockUntil = 0;
    /** Last finger-spread distance while pinch-zooming (0 = not pinching). */
    this._pinchDist = 0;
    /** Camera-pan drag state. */
    this._isPanning = false;
    this._panLast = { x: 0, y: 0 };
    /** True while the "Restart level?" confirmation modal is open. */
    this._modalOpen = false;
    /** True while the dev parameter-tuning panel is open. */
    this._devOpen = false;
    /** HUD icon the attract glow is tracking (null = not attracting). */
    this._attractTarget = null;

    this._computeLayout(); // sets this._layout + this._hudHeight for the build
    this._buildHud();
    this._wireInput();
    this._wireCollisions();
    this._setupCameras(); // creates cameras + ignore lists, then lays them out
    this._layoutHud(); // position/size every HUD element for the current screen
    // Reflow on window resize / device rotation. The scale manager is
    // game-level, so remove the listener when the scene shuts down (restart).
    this.scale.on('resize', this._onResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this._onResize, this));
    // Safety net: re-layout next tick in case the final window size only settles
    // after create() (common on mobile when the scale manager reports late).
    this.time.delayedCall(0, () => this._onResize());
    this._refreshHud();
  }

  /**
   * Decide the HUD metrics for the current window size, choosing 1, 2, or 3
   * rows so nothing collides:
   *  - wide   (> compactMaxWidth): 1 row — turn text and Best/#Left at the edges,
   *           icons centred between them.
   *  - compact(<= compactMaxWidth): 2 rows — the info text on one line (turn
   *           left, Best/#Left right), icons below; larger touch icons.
   *  - narrow (<= narrowMaxWidth): 3 rows — state text, then Best/#Left, then
   *           icons — so the two texts can't overlap on a phone in portrait.
   * Stores `this._layout` and keeps `this._hudHeight` in sync (input guard, dev
   * panel, camera viewport). Re-run on every resize/rotation (see _onResize).
   *
   * @returns {void}
   */
  _computeLayout() {
    const H = Config.hud;
    const w = this.scale.width;
    const h = this.scale.height;
    const mode = w > H.compactMaxWidth ? 'wide' : w <= H.narrowMaxWidth ? 'narrow' : 'compact';
    const rows = mode === 'wide' ? 1 : mode === 'narrow' ? 3 : 2;
    const touch = mode !== 'wide'; // bigger icons/gaps on small screens
    this._layout = {
      w,
      h,
      mode,
      rows,
      rowHeight: H.rowHeight,
      hudHeight: rows * H.rowHeight,
      iconSize: touch ? H.compactIcon : H.normalIcon,
      gap: touch ? H.compactGap : H.normalGap,
      pad: H.pad,
    };
    this._hudHeight = this._layout.hudHeight;
  }

  /**
   * Position and size every HUD element for `this._layout` (1/2/3 rows; see
   * _computeLayout). Icons always occupy the last row; the text occupies the
   * row(s) above. Re-run whenever the layout changes.
   *
   * @returns {void}
   */
  _layoutHud() {
    const L = this._layout;
    const cx = L.w / 2;
    const rh = L.rowHeight;
    const rowY = (i) => i * rh + rh / 2; // centre Y of row i

    // Opaque ribbon + bottom border span the full width.
    this.hudBar.setPosition(cx, L.hudHeight / 2).setSize(L.w, L.hudHeight);
    this.hudBorder.setPosition(cx, L.hudHeight).setSize(L.w, 2);

    // Icon cluster (prev, restart, next, status, beaker) on the last row.
    const icons = [
      this.prevButton,
      this.restartButton,
      this.nextButton,
      this.statusIcon,
      this.beakerButton,
    ];
    const tips = [
      this.prevTooltip,
      this.restartTooltip,
      this.nextTooltip,
      this.statusTooltip,
      this.beakerTooltip,
    ];
    const iconRowY = rowY(L.rows - 1);
    const startX = cx - ((icons.length - 1) * L.gap) / 2;
    icons.forEach((ic, i) => ic.setDisplaySize(L.iconSize, L.iconSize).setPosition(startX + i * L.gap, iconRowY));
    tips.forEach((tp, i) => tp.setPosition(startX + i * L.gap, L.hudHeight + 6));

    // Keep the attract glow on its target icon now that the icon has moved (the
    // ongoing pulse tween only animates scale/alpha, so position is ours to set).
    if (this._attractTarget) this.attractGlow.setPosition(this._attractTarget.x, this._attractTarget.y);

    // Info text. Wide/compact: turn left + Best/#Left right on row 0. Narrow:
    // state text centred on row 0, Best/#Left centred on row 1 (no collision).
    const fontSize = L.mode === 'wide' ? '22px' : '18px';
    this.turnText.setFontSize(fontSize);
    this.movesText.setFontSize(fontSize);
    if (L.mode === 'narrow') {
      this.turnText.setOrigin(0.5, 0.5).setPosition(cx, rowY(0));
      this.movesText.setOrigin(0.5, 0.5).setPosition(cx, rowY(1));
    } else {
      this.turnText.setOrigin(0, 0.5).setPosition(L.pad, rowY(0));
      this.movesText.setOrigin(1, 0.5).setPosition(L.w - L.pad, rowY(0));
    }

    // Banner + backing panel centred; sized/scaled to fit narrow screens.
    const panelW = Math.min(L.w - 2 * L.pad, 520);
    this.bannerPanel.setPosition(cx, L.h / 2).setSize(panelW, L.mode === 'wide' ? 110 : 90);
    this.banner.setPosition(cx, L.h / 2).setFontSize(L.mode === 'wide' ? '52px' : '34px');

    this._layoutDevPanel();
  }

  /**
   * A faint grid on the arena floor. Drawn below everything (depth -1) so it
   * reads as the ground and scales with the world when the camera zooms,
   * giving the zoom a visible frame of reference.
   *
   * @returns {void}
   */
  _buildFloorGrid() {
    const { width, height } = this.arena;
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
    this.uiCamera = this.cameras.add(0, 0, this._layout.w, this._layout.h);

    this.hudObjects = [
      this.hudBar,
      this.hudBorder,
      this.turnText,
      this.movesText,
      this.restartButton,
      this.restartTooltip,
      this.attractGlow,
      this.prevButton,
      this.prevTooltip,
      this.nextButton,
      this.nextTooltip,
      this.statusIcon,
      this.statusTooltip,
      this.beakerButton,
      this.beakerTooltip,
      ...this.devPanelParts,
      this.bannerPanel,
      this.banner,
    ];
    this.cameras.main.ignore(this.hudObjects);
    // The UI camera shows only the HUD: ignore every other display object.
    this.uiCamera.ignore(this.children.list.filter((o) => !this.hudObjects.includes(o)));

    this._layoutCameras(true); // initial viewport/zoom (start fully zoomed out)
  }

  /**
   * Lay out the cameras for the current screen: the world camera fills the
   * window *below* the HUD strip; the UI camera fills the whole window. The
   * minimum zoom fits the (per-level) arena plus an edge margin into that world
   * viewport. `resetZoom` (initial/level-load) snaps to that fit; otherwise we
   * keep the player's current zoom and only raise it to the new minimum.
   *
   * @param {boolean} [resetZoom]
   * @returns {void}
   */
  _layoutCameras(resetZoom = false) {
    const { w, h, hudHeight } = this._layout;
    const M = Config.zoom.edgeMargin;
    const main = this.cameras.main;
    main.setViewport(0, hudHeight, w, h - hudHeight);
    this.uiCamera.setViewport(0, 0, w, h);
    this._minZoom = Math.min(
      main.width / (this.arena.width + 2 * M),
      main.height / (this.arena.height + 2 * M)
    );
    if (resetZoom || main.zoom < this._minZoom) main.setZoom(this._minZoom);
    this._clampCamera();
  }

  /**
   * Reflow everything to the new window size (window resize / device rotation).
   *
   * @returns {void}
   */
  _onResize() {
    this._computeLayout();
    this._layoutHud();
    this._layoutCameras(false);
  }

  /**
   * Constrain the world camera in world space (Phaser's setBounds clamp is
   * unreliable at fractional zoom — see _setupCameras). The arena may be
   * panned/zoomed freely, but only `edgeMargin` of gray can show past any edge.
   * Per axis: if the view is wider than the arena + both margins (zoomed out),
   * centre the arena; otherwise clamp scroll so the view stays within the arena
   * expanded by the margin (allowing that much overscroll into the gray). Works
   * at any zoom and for any arena size. Call after every zoom or pan change.
   *
   * @returns {void}
   */
  _clampCamera() {
    const main = this.cameras.main;
    const M = Config.zoom.edgeMargin;
    const aw = this.arena.width;
    const ah = this.arena.height;
    // Phaser centres the view on midPoint = scroll + halfViewport (in pixels),
    // spanning width/zoom of world. So we clamp the *midpoint*, then convert
    // back to scroll. Per axis: if the visible span exceeds the arena+margins,
    // centre on the arena; else keep the view edges within the arena expanded
    // by the margin (so up to `M` of gray can show past any edge).
    const halfVW = main.width / 2;
    const halfVH = main.height / 2;
    const halfSpanX = main.width / main.zoom / 2; // half the world width in view
    const halfSpanY = main.height / main.zoom / 2;

    let midX = main.scrollX + halfVW;
    let midY = main.scrollY + halfVH;
    midX =
      halfSpanX * 2 >= aw + 2 * M
        ? aw / 2
        : Phaser.Math.Clamp(midX, -M + halfSpanX, aw + M - halfSpanX);
    midY =
      halfSpanY * 2 >= ah + 2 * M
        ? ah / 2
        : Phaser.Math.Clamp(midY, -M + halfSpanY, ah + M - halfSpanY);

    main.setScroll(midX - halfVW, midY - halfVH);
  }

  // --- Level construction -------------------------------------------------

  /**
   * Outer walls of the arena.
   *
   * @returns {void}
   */
  _buildArena() {
    const { width, height } = this.arena;
    this.matter.world.setBounds(0, 0, width, height, 64);
    // The play-area floor. Drawn below everything; wherever it isn't (the gray
    // canvas clear) reads as "outside the arena" — e.g. the letterbox margins
    // when the arena is fully zoomed out.
    this.add.rectangle(width / 2, height / 2, width, height, Config.view.arenaColor).setDepth(-2);
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
   * Matter body for each wall in the level. Labelled 'wall' so the collision
   * router leaves them alone (they just deflect the balls).
   *
   * @returns {void}
   */
  _buildWalls() {
    this._makeBrickTexture();
    for (const wall of this.level.walls) {
      this.add.tileSprite(wall.x, wall.y, wall.width, wall.height, 'brick');
      // A thin dark frame so the wall reads crisply against the background.
      this.add
        .rectangle(wall.x, wall.y, wall.width, wall.height)
        .setStrokeStyle(2, 0x2a1d15, 0.9);
      const body = this.matter.add.rectangle(wall.x, wall.y, wall.width, wall.height, {
        isStatic: true,
        restitution: this.level.wallRestitution,
      });
      body.label = 'wall';
    }
  }

  /**
   * Build the level's zones. Each is optional — a level may omit either the
   * destination or the teleporter.
   *
   * @returns {void}
   */
  _buildZones() {
    if (this.level.destination) this._buildDestination(this.level.destination);
    if (this.level.teleporter) this._buildTeleporter(this.level.teleporter);
  }

  /**
   * Destination goal — an archery target (concentric rings + a slow-rotating
   * reticle) plus a sensor body, all centred on the goal.
   *
   * @param {{x:number, y:number, radius:number}} destination
   * @returns {void}
   */
  _buildDestination(destination) {
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
  }

  /**
   * Teleporter — a breathing source with inward-pulled motes and a portal
   * sensor, plus an exit marker with outward motes that mirror the source rate.
   *
   * @param {{source:{x:number,y:number,radius:number}, target:{x:number,y:number}}} teleporter
   * @returns {void}
   */
  _buildTeleporter(teleporter) {
    const T = Config.anim.teleporter;
    const { source, target } = teleporter;

    // Source (entrance) — breathing fill...
    this.teleporterGfx = this.add.circle(source.x, source.y, source.radius, 0x9b59b6, 0.5);
    this.tweens.add({
      targets: this.teleporterGfx,
      fillAlpha: T.pulseAlpha,
      duration: T.pulseDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    // ...plus motes that pop in at random rim points and are pulled to centre.
    if (!this.textures.exists('portalSpark')) {
      const g = this.add.graphics();
      g.fillStyle(0xffffff, 1).fillCircle(4, 4, 3);
      g.generateTexture('portalSpark', 8, 8);
      g.destroy();
    }
    const cx = source.x;
    const cy = source.y;
    const sr = source.radius;
    // Normalise a mote's spawn position to a centre-relative offset whether
    // Phaser reports it local to the emitter or in world space.
    const offset = (p) => ({
      x: Math.abs(p.x) > sr + 1 ? p.x - cx : p.x,
      y: Math.abs(p.y) > sr + 1 ? p.y - cy : p.y,
    });
    this.add
      .particles(cx, cy, 'portalSpark', {
        lifespan: T.pullLifespan,
        quantity: T.pullQuantity,
        frequency: T.pullFrequency,
        tint: 0xb37feb,
        blendMode: 'ADD',
        scale: { start: 0.85, end: 0 },
        alpha: { start: 1, end: 0 },
        // Spawn at a random point on the rim (a circle's getRandomPoint returns
        // an interior point, so supply one that lands on the edge).
        emitZone: {
          type: 'random',
          source: {
            getRandomPoint: (point) => {
              const a = Math.random() * Math.PI * 2;
              point.x = Math.cos(a) * sr;
              point.y = Math.sin(a) * sr;
              return point;
            },
          },
        },
        // Pure inward velocity: straight toward the centre, no swirl.
        speedX: { onEmit: (p) => -offset(p).x * T.pullSpeed },
        speedY: { onEmit: (p) => -offset(p).y * T.pullSpeed },
      })
      .setDepth(2);
    const portal = this.matter.add.circle(source.x, source.y, source.radius, {
      isSensor: true,
      isStatic: true,
    });
    portal.label = 'teleporter';

    // Target (exit) — visual marker with a calm idle breathe.
    this.targetGfx = this.add
      .rectangle(target.x, target.y, 70, 70)
      .setStrokeStyle(2, 0xe67e22, 0.6)
      .setAlpha(Config.anim.target.idleAlphaLow);
    this.tweens.add({
      targets: this.targetGfx,
      alpha: Config.anim.target.idleAlphaHigh,
      duration: Config.anim.target.idleDuration,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });

    // Exit motes: the mirror of the source — burst out, decelerate (friction
    // sized to stop as they fade), vanish ~halfway out. Reusing the source's
    // frequency/quantity keeps the exit rate matched to the intake.
    const exitDrag = 1000 / T.exitLifespan; // px/s² per px/s -> v hits 0 at lifespan
    this.add
      .particles(target.x, target.y, 'portalSpark', {
        lifespan: T.exitLifespan,
        quantity: T.pullQuantity,
        frequency: T.pullFrequency,
        tint: 0xe67e22, // orange, matching the destination marker
        blendMode: 'ADD',
        scale: { start: 0.85, end: 0 },
        alpha: { start: 1, end: 0 },
        angle: { min: 0, max: 360 }, // random outward direction
        speed: T.exitSpeed,
        accelerationX: { onEmit: (p) => -p.velocityX * exitDrag },
        accelerationY: { onEmit: (p) => -p.velocityY * exitDrag },
      })
      .setDepth(2);
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
    // Opaque panel behind the HUD so the arena never shows through the top
    // strip while panning/zooming. Created first (and at depth 9, under the
    // depth-10 HUD text) and rendered by the fixed UI camera, so it always
    // covers the same screen strip regardless of the world camera.
    // Initial positions/sizes here are placeholders; _layoutHud() positions and
    // sizes every HUD element authoritatively for the current screen.
    const h = this._hudHeight;
    this.hudBar = this.add
      .rectangle(Config.view.width / 2, h / 2, Config.view.width, h, 0x0e0e12, 1)
      .setDepth(9);
    this.hudBorder = this.add
      .rectangle(Config.view.width / 2, h, Config.view.width, 2, 0x3a3a44, 1)
      .setOrigin(0.5, 1)
      .setDepth(9);

    this.turnText = this.add.text(20, 18, '', { fontSize: '22px' }).setDepth(10);
    this.movesText = this.add
      .text(Config.view.width - 20, 18, '', { fontSize: '22px', color: '#dddddd' })
      .setOrigin(1, 0)
      .setDepth(10);

    // Restart button: the clockwise-arrow icon, vertically centred in the
    // ribbon. Clicking opens a confirmation modal (see _showConfirm).
    this.restartButton = this.add
      .image(Config.view.width / 2, h / 2, 'icon-restart')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });

    // Tooltip shown on hover or press (hidden on release / pointer-out).
    this.restartTooltip = this.add
      .text(Config.view.width / 2, h + 12, 'Restart Level', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);

    // The tooltip always reveals on hover/press (even when reset is disabled);
    // brightening and the actual restart only apply when reset is enabled.
    const showTip = () => this.restartTooltip.setVisible(true);
    const hideTip = () => this.restartTooltip.setVisible(false);
    this.restartButton.on('pointerover', () => {
      if (this._resetEnabled()) this.restartButton.setAlpha(1);
      showTip();
    });
    this.restartButton.on('pointerout', () => {
      this._refreshResetButton();
      hideTip();
    });
    this.restartButton.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation(); // don't let the press reach the aim/pan router
      showTip();
    });
    this.restartButton.on('pointerup', () => {
      hideTip();
      if (!this._resetEnabled()) return; // pristine level: nothing to reset
      // After the level is over there's nothing else to do, so skip the
      // confirmation and just restart; mid-play, confirm first.
      if (this.status === 'ENDED') this.scene.restart();
      else this._showConfirm('Restart Level?', () => this.scene.restart());
    });

    // Previous / next level icons flanking reset. Enabled state depends on
    // position in the pack and whether the current level has been won (see
    // _navEnabled); tooltips reveal on hover/press regardless.
    const gap = 44;
    [this.prevButton, this.prevTooltip] = this._buildNavIcon(
      'prev',
      Config.view.width / 2 - gap,
      'icon-prev',
      'Previous level'
    );
    [this.nextButton, this.nextTooltip] = this._buildNavIcon(
      'next',
      Config.view.width / 2 + gap,
      'icon-next',
      'Next level'
    );

    // Read-only lifecycle indicator, right of "next". Its glyph/colour reflect
    // `status` (see _refreshStatusIcon); hover/press reveals the label. It's
    // interactive only for the tooltip — NO hand cursor, so it reads as a
    // status light rather than a button.
    this.statusIcon = this.add
      .image(Config.view.width / 2 + 2 * gap, h / 2, 'icon-ready')
      .setDepth(10)
      .setInteractive();
    this.statusTooltip = this.add
      .text(Config.view.width / 2 + 2 * gap, h + 12, '', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    this.statusIcon.on('pointerover', () => this.statusTooltip.setVisible(true));
    this.statusIcon.on('pointerout', () => this.statusTooltip.setVisible(false));
    this.statusIcon.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation();
      this.statusTooltip.setVisible(true);
    });
    this.statusIcon.on('pointerup', () => this.statusTooltip.setVisible(false));

    // Dev "beaker": toggles a live parameter-tuning panel. Actionable, so it
    // gets a hand cursor (unlike the read-only status icon).
    this.beakerButton = this.add
      .image(Config.view.width / 2 + 3 * gap, h / 2, 'icon-beaker')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });
    this.beakerTooltip = this.add
      .text(Config.view.width / 2 + 3 * gap, h + 12, 'Tweak parameters', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    this.beakerButton.on('pointerover', () => {
      this.beakerButton.setAlpha(1);
      this.beakerTooltip.setVisible(true);
    });
    this.beakerButton.on('pointerout', () => {
      this.beakerButton.setAlpha(0.8);
      this.beakerTooltip.setVisible(false);
    });
    this.beakerButton.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation();
      this.beakerTooltip.setVisible(true);
    });
    this.beakerButton.on('pointerup', () => {
      this.beakerTooltip.setVisible(false);
      this._toggleDevPanel();
    });

    this._buildDevPanel();

    // A glow ring pulsed on game-over to draw the eye to a HUD icon (restart, or
    // next level on a win); repositioned to the target icon (see _attract).
    this.attractGlow = this.add
      .circle(Config.view.width / 2, h / 2, 22, 0xffffff, 0)
      .setStrokeStyle(3, 0xffd479, 0.9)
      .setDepth(9)
      .setVisible(false);

    // End-of-level banner: a dim backing panel plus bold, shadowed, coloured
    // text. Both hidden until _endGame shows and animates them.
    this.bannerPanel = this.add
      .rectangle(Config.view.width / 2, Config.view.height / 2, 520, 110, 0x000000, 0.55)
      .setOrigin(0.5)
      .setDepth(9)
      .setVisible(false);
    this.banner = this.add
      .text(Config.view.width / 2, Config.view.height / 2, '', {
        fontSize: '52px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setDepth(10)
      .setShadow(2, 3, '#000000', 6, true, true)
      .setVisible(false);
  }

  /**
   * Build a previous/next navigation icon plus its tooltip, centred at `x`.
   * Enabled appearance is driven by {@link _refreshNavButtons}; the tooltip
   * always reveals on hover/press; releasing navigates if enabled (with an
   * "abandon?" confirm while playing — see {@link _navClicked}).
   *
   * @param {'prev'|'next'} dir
   * @param {number} x
   * @param {string} key   Texture key.
   * @param {string} tooltipText
   * @returns {[Phaser.GameObjects.Image, Phaser.GameObjects.Text]}
   */
  _buildNavIcon(dir, x, key, tooltipText) {
    const icon = this.add
      .image(x, this._hudHeight / 2, key)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    const tip = this.add
      .text(x, this._hudHeight + 12, tooltipText, {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    icon.on('pointerover', () => {
      if (this._navEnabled(dir)) icon.setAlpha(1);
      tip.setVisible(true);
    });
    icon.on('pointerout', () => {
      this._refreshNavButtons();
      tip.setVisible(false);
    });
    icon.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation();
      tip.setVisible(true);
    });
    icon.on('pointerup', () => {
      tip.setVisible(false);
      this._navClicked(dir);
    });
    return [icon, tip];
  }

  /**
   * Whether a nav direction is currently usable. Previous needs an earlier
   * level; next needs a later level AND the current level to have been won
   * (best is non-nil) — you must complete a level to proceed.
   *
   * @param {'prev'|'next'} dir
   * @returns {boolean}
   */
  _navEnabled(dir) {
    if (dir === 'prev') return currentIndex() > 0;
    const hasNext = currentIndex() < levelCount() - 1;
    const wonCurrent = this.registry.get(this._bestKey) != null;
    return hasNext && wonCurrent;
  }

  /** Dim (gray) the prev/next icons that aren't currently usable. */
  _refreshNavButtons() {
    this.prevButton.setAlpha(this._navEnabled('prev') ? 0.8 : 0.3);
    this.nextButton.setAlpha(this._navEnabled('next') ? 0.8 : 0.3);
  }

  /**
   * Handle a click on a nav icon: no-op if disabled; if a game is in progress
   * (PLAYING) confirm before leaving; otherwise switch level immediately.
   *
   * @param {'prev'|'next'} dir
   * @returns {void}
   */
  _navClicked(dir) {
    if (!this._navEnabled(dir)) return;
    const target = currentIndex() + (dir === 'prev' ? -1 : 1);
    if (this.status === 'PLAYING') {
      this._showConfirm('Abandon current game?', () => this._goToLevel(target));
    } else {
      this._goToLevel(target);
    }
  }

  /**
   * Switch to another level in the pack and rebuild the scene for it.
   *
   * @param {number} index
   * @returns {void}
   */
  _goToLevel(index) {
    setLevelIndex(index);
    this.scene.restart();
  }

  /**
   * Build the (hidden) dev tuning panel: rows of -/+ steppers for the slingshot
   * and tether parameters, edited live. Mutating these Config values takes
   * effect immediately — the slingshot reads Config per shot, and the tether is
   * re-synced from Config each frame (see Brothers._applyPullOnlyTether).
   * Values persist across restarts (Config is a module object) but reset on a
   * full page reload, which is the point: find good numbers, then bake them in.
   *
   * @returns {void}
   */
  /**
   * Keep the dev panel anchored just below the (possibly resized) ribbon by
   * shifting all its parts vertically. x stays at the left edge.
   *
   * @returns {void}
   */
  _layoutDevPanel() {
    const targetY = this._layout.hudHeight + 10;
    const dy = targetY - this._devY;
    if (dy === 0) return;
    for (const p of this.devPanelParts) p.y += dy;
    this._devBounds.y += dy;
    this._devY = targetY;
  }

  _buildDevPanel() {
    const x0 = 12;
    const y0 = this._hudHeight + 10;
    this._devY = y0; // current top of the panel, shifted by _layoutDevPanel on resize
    const w = 250;
    const rowH = 30;
    this._devParams = [
      { obj: Config.slingshot, key: 'maxSpeed', step: 10, dp: 0, min: 0, desc: 'Launch speed at a full-strength pull.' },
      { obj: Config.slingshot, key: 'minSpeed', step: 5, dp: 0, min: 0, desc: 'Launch-speed floor for the shortest valid pull.' },
      { obj: Config.slingshot, key: 'curve', step: 0.1, dp: 2, min: 0.1, desc: 'Easing exponent; higher softens short/mid pulls (ends fixed).' },
      { obj: Config.slingshot, key: 'maxPull', step: 10, dp: 0, min: 10, desc: 'Furthest the launcher can be stretched from the anchor.' },
      { obj: Config.slingshot, key: 'minPull', step: 2, dp: 0, min: 0, desc: 'Pulls shorter than this count as a mis-click, not a launch.' },
      { obj: Config.tether, key: 'restLength', step: 5, dp: 0, min: 0, desc: 'Tether resting length; beyond it the band pulls them together.' },
      { obj: Config.tether, key: 'stiffness', step: 0.005, dp: 3, min: 0, desc: 'Tether spring strength once stretched past rest length.' },
      { obj: Config.tether, key: 'damping', step: 0.02, dp: 2, min: 0, desc: 'How quickly tether oscillations settle.' },
    ];
    const n = this._devParams.length;
    const helpY = y0 + 38 + n * rowH;
    const resetY = helpY + 54;
    const h = resetY - y0 + 26;
    this._devBounds = { x: x0, y: y0, w, h };

    const parts = [
      this.add.rectangle(x0, y0, w, h, 0x000000, 0.72).setOrigin(0, 0).setDepth(20),
      this.add
        .text(x0 + 10, y0 + 8, 'Rubber-band tuning', { fontSize: '14px', color: '#ffd479' })
        .setDepth(21),
      // Close: red, to read differently from the gray "+" steppers.
      this._devButton(x0 + w - 20, y0 + 14, '×', () => this._toggleDevPanel(), '#c0392b', '#e74c3c'),
    ];

    // Shared explanation line, updated on hover/press of a parameter's controls.
    this._devHelp = this.add
      .text(x0 + 10, helpY, '', { fontSize: '12px', color: '#cccccc', wordWrap: { width: w - 20 } })
      .setDepth(21);

    this._devRows = this._devParams.map((param, i) => {
      const rowY = y0 + 38 + i * rowH;
      const minus = this._devButton(x0 + 24, rowY, '-', () => this._adjustParam(param, -1));
      const plus = this._devButton(x0 + w - 24, rowY, '+', () => this._adjustParam(param, 1));
      // Click the value to type one directly (prompt works desktop + mobile).
      const value = this.add
        .text(x0 + 44, rowY, '', { fontSize: '14px', color: '#ffffff' })
        .setOrigin(0, 0.5)
        .setDepth(21);
      const row = { param, value };
      this._setDevRowText(row); // set text before setInteractive so the hit area fits
      value.setInteractive({ useHandCursor: true }).on('pointerup', () => this._promptParam(param));
      // Show this parameter's explanation while hovering or pressing its controls.
      const showHelp = () => this._devHelp.setText(param.desc);
      const hideHelp = () => this._devHelp.setText('');
      for (const ctrl of [minus, value, plus]) {
        ctrl.on('pointerover', showHelp).on('pointerout', hideHelp);
        ctrl.on('pointerdown', showHelp).on('pointerup', hideHelp);
      }
      parts.push(minus, value, plus);
      return row;
    });

    parts.push(this._devHelp);
    parts.push(this._devButton(x0 + w / 2, resetY, 'Reset', () => this._resetParams()));

    this.devPanelParts = parts;
    for (const p of parts) p.setVisible(false);
  }

  /**
   * Prompt for a direct numeric value for a dev parameter (clamped to its min).
   * Uses window.prompt so it works on desktop and mobile without a DOM input.
   *
   * @param {{obj: object, key: string, min: number}} param
   * @returns {void}
   */
  _promptParam(param) {
    const input = window.prompt(`Set ${param.key}`, String(param.obj[param.key]));
    if (input === null) return; // cancelled
    const v = parseFloat(input);
    if (!Number.isFinite(v)) return; // not a number
    param.obj[param.key] = Math.max(param.min, v);
    this._devRows.forEach((r) => this._setDevRowText(r));
  }

  /**
   * A small button for the dev panel (steppers, close, reset).
   *
   * @param {number} x @param {number} y @param {string} label @param {() => void} onClick
   * @param {string} [bg] Background colour. @param {string} [bgHover] Hover colour.
   * @returns {Phaser.GameObjects.Text}
   */
  _devButton(x, y, label, onClick, bg = '#444444', bgHover = '#666666') {
    const btn = this.add
      .text(x, y, label, {
        fontSize: '16px',
        color: '#ffffff',
        backgroundColor: bg,
        padding: { x: 8, y: 2 },
      })
      .setOrigin(0.5, 0.5)
      .setDepth(21)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setBackgroundColor(bgHover));
    btn.on('pointerout', () => btn.setBackgroundColor(bg));
    btn.on('pointerup', onClick);
    return btn;
  }

  /**
   * Reset the tunable parameters to their defaults (the single source in
   * config.js), then refresh the panel rows.
   *
   * @returns {void}
   */
  _resetParams() {
    applyRubberBandDefaults();
    this._devRows.forEach((r) => this._setDevRowText(r));
  }

  /**
   * Update one dev row's "key: value" label from the live Config value.
   *
   * @param {{param: {obj: object, key: string, dp: number}, value: Phaser.GameObjects.Text}} row
   * @returns {void}
   */
  _setDevRowText(row) {
    const { obj, key, dp } = row.param;
    row.value.setText(`${key}: ${obj[key].toFixed(dp)}`);
  }

  /**
   * Step a parameter by ±its step (clamped to its min), then refresh the rows.
   *
   * @param {{obj: object, key: string, step: number, dp: number, min: number}} param
   * @param {number} dir  -1 or +1.
   * @returns {void}
   */
  _adjustParam(param, dir) {
    const raw = param.obj[param.key] + dir * param.step;
    param.obj[param.key] = Math.max(param.min, Number(raw.toFixed(param.dp)));
    this._devRows.forEach((r) => this._setDevRowText(r));
  }

  /**
   * Show/hide the dev panel (toggled by the beaker icon).
   *
   * @returns {void}
   */
  _toggleDevPanel() {
    this._devOpen = !this._devOpen;
    this._devRows.forEach((r) => this._setDevRowText(r));
    this._devHelp.setText(''); // no stale explanation on open/close
    for (const p of this.devPanelParts) p.setVisible(this._devOpen);
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if the open dev panel sits under the pointer (so the
   *   game's aim/pan router should ignore the press).
   */
  _overDevPanel(p) {
    if (!this._devOpen) return false;
    const b = this._devBounds;
    return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  }

  /**
   * Reset only makes sense once the level has progressed past READY (i.e. it's
   * PLAYING or ENDED). A pristine, not-yet-started level can't be usefully reset.
   *
   * @returns {boolean}
   */
  _resetEnabled() {
    return this.status !== 'READY';
  }

  /**
   * Set the restart icon's resting look: dimmed (grayed) when reset is
   * disabled, normal otherwise. Call whenever that state can change.
   *
   * @returns {void}
   */
  _refreshResetButton() {
    this.restartButton.setAlpha(this._resetEnabled() ? 0.8 : 0.3);
  }

  /**
   * Update the read-only lifecycle indicator (glyph, colour, tooltip) to match
   * `this.status`. Called wherever the status can change.
   *
   * @returns {void}
   */
  _refreshStatusIcon() {
    const byStatus = {
      READY: { key: 'icon-ready', tint: 0xd6b25e, label: 'Ready — not started' },
      PLAYING: { key: 'icon-playing', tint: 0x7cfc8a, label: 'Playing — in progress' },
      ENDED: { key: 'icon-ended', tint: 0x9aa0a6, label: 'Ended — level finished' },
    };
    const s = byStatus[this.status];
    this.statusIcon.setTexture(s.key).setTint(s.tint);
    this.statusTooltip.setText(s.label);
  }

  /**
   * Open a Yes/No confirmation modal: a dimming backdrop plus a panel. Built on
   * the fixed UI camera (so it ignores zoom/pan) and on the world camera's
   * ignore list (so it isn't double-drawn). Game input is gated by `_modalOpen`
   * while it's up. Yes runs `onYes`; No just dismisses.
   *
   * @param {string} message  The question shown in the panel.
   * @param {() => void} onYes  Action to run if the player confirms.
   * @returns {void}
   */
  _showConfirm(message, onYes) {
    if (this._modalOpen) return;
    this._modalOpen = true;
    this._isPanning = false;

    const cx = this._layout.w / 2;
    const cy = this._layout.h / 2;
    const pw = Math.min(380, this._layout.w - 2 * this._layout.pad);
    const ph = 190;

    const backdrop = this.add
      .rectangle(cx, cy, this._layout.w, this._layout.h, 0x000000, 0.6)
      .setDepth(30)
      .setInteractive(); // swallow clicks on the dimmed area
    const panel = this.add.graphics().setDepth(31);
    panel.fillStyle(0x23232c, 1).fillRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, 14);
    panel.lineStyle(2, 0x4d4d55, 1).strokeRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, 14);
    const title = this.add
      .text(cx, cy - 48, message, { fontSize: '28px', color: '#ffffff' })
      .setOrigin(0.5)
      .setDepth(32);
    const yes = this._modalButton(cx - 80, cy + 35, 'Yes', '#2e7d46', onYes);
    const no = this._modalButton(cx + 80, cy + 35, 'No', '#555560', () => this._hideConfirm());

    this._modalParts = [backdrop, panel, title, yes, no];
    this.cameras.main.ignore(this._modalParts); // HUD-camera only

    // Gentle fade-in so it doesn't pop in harshly.
    for (const part of this._modalParts) {
      const to = part === backdrop ? 0.6 : 1;
      part.setAlpha(0);
      this.tweens.add({ targets: part, alpha: to, duration: 130, ease: 'Sine.Out' });
    }
  }

  /**
   * A pill button for the modal: rounded text with a hover lift and a click
   * handler. Returned so the caller can group/ignore/destroy it.
   *
   * @param {number} x
   * @param {number} y
   * @param {string} label
   * @param {string} bg     CSS background colour.
   * @param {() => void} onClick
   * @returns {Phaser.GameObjects.Text}
   */
  _modalButton(x, y, label, bg, onClick) {
    const btn = this.add
      .text(x, y, label, {
        fontSize: '22px',
        color: '#ffffff',
        backgroundColor: bg,
        padding: { x: 26, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(32)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setAlpha(0.85));
    btn.on('pointerout', () => btn.setAlpha(1));
    btn.on('pointerup', onClick);
    return btn;
  }

  /**
   * Dismiss the confirmation modal with no other effect.
   *
   * @returns {void}
   */
  _hideConfirm() {
    if (!this._modalParts) return;
    for (const part of this._modalParts) part.destroy();
    this._modalParts = null;
    this._modalOpen = false;
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
      sfx.unlock(); // browsers need a user gesture to start audio
      if (this._modalOpen) return; // modal owns input; its buttons handle themselves
      if (this._pinchDist) return; // a two-finger pinch owns the gesture
      if (p.y < this._hudHeight) return; // press is on the HUD ribbon, not the arena
      if (this._overDevPanel(p)) return; // press is on the dev panel

      // Pressing on the launcher (while aiming, and not after the level ends)
      // starts a shot; pressing anywhere else on the board pans the camera.
      if (this.status !== 'ENDED' && this.phase === 'AIMING') {
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
      if (this._modalOpen) return;
      if (this.isAiming) {
        const w = this.cameras.main.getWorldPoint(p.x, p.y);
        this.brothers.dragTo(w.x, w.y);
        return;
      }
      if (this._isPanning) {
        // Drag the world under the finger: scroll opposite to the move, scaled
        // by zoom, then clamp/centre to the arena.
        const cam = this.cameras.main;
        cam.setScroll(
          cam.scrollX - (p.x - this._panLast.x) / cam.zoom,
          cam.scrollY - (p.y - this._panLast.y) / cam.zoom
        );
        this._clampCamera();
        this._panLast.x = p.x;
        this._panLast.y = p.y;
      }
    });

    this.input.on('pointerup', () => {
      if (this._modalOpen) return;
      this._isPanning = false;
      if (!this.isAiming) return;
      this.isAiming = false;

      const pull = this.brothers.release();
      if (pull < Config.slingshot.minPull) return; // mis-click: no move spent

      this.movesLeft -= 1;
      this.status = 'PLAYING'; // first launch leaves READY; later launches keep PLAYING
      this.phase = 'MOVING';
      this._refreshHud();
    });

    // Laptop: mouse wheel zooms toward the cursor.
    this.input.on('wheel', (p, _over, _dx, dy) => {
      if (this._modalOpen) return;
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
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, this._minZoom, Config.zoom.max));
    const after = cam.getWorldPoint(screenX, screenY);
    cam.setScroll(cam.scrollX + (before.x - after.x), cam.scrollY + (before.y - after.y));
    this._clampCamera();
  }

  /**
   * Two-finger pinch zoom. Tracks the spread between the two active touch
   * pointers; the per-frame change in spread drives the zoom about their
   * midpoint. Cancels any in-progress aim so a pinch never fires a shot.
   *
   * @returns {void}
   */
  _updatePinch() {
    if (this._modalOpen) return;
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
      // pull-only tether lets the pair rest in contact, so a contact while
      // AIMING must NOT trigger the snap (it would unfreeze the anchor and let
      // a drag move the brother that's supposed to be immobile).
      if (this.status !== 'PLAYING' || this.phase !== 'MOVING') return;

      for (const pair of event.pairs) {
        const labels = [pair.bodyA.label, pair.bodyB.label];

        if (labels[0] === 'brother' && labels[1] === 'brother') {
          sfx.hit(); // billiard-style click on every brother-on-brother contact
          this.brothers.snap();
        } else if (labels.includes('brother') && labels.includes('teleporter')) {
          this._handleTeleport();
        } else if (labels.includes('brother') && !(pair.bodyA.isSensor || pair.bodyB.isSensor)) {
          sfx.hit(); // brother off a wall or the arena edge — same click, no debounce
          this.brothers.snap(); // hitting a solid also frees the anchor
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

    const { source, target, retainVelocity } = this.level.teleporter;

    // Punctuate the warp: a ring collapsing out of the entrance and a fresh
    // ring blooming at the exit so the eye follows source -> target.
    this._spawnRing(source.x, source.y, source.radius, 0x9b59b6);
    this._spawnRing(target.x, target.y, 18, 0xe67e22);
    sfx.teleport();

    this.brothers.teleport(target, retainVelocity);
  }

  // --- Per-frame loop -----------------------------------------------------

  /**
   * @param {number} _time
   * @param {number} delta  Milliseconds since the last frame.
   * @returns {void}
   */
  update(_time, delta) {
    // Advance Matter in fixed sub-steps so fast bodies can't tunnel through thin
    // obstacles (autoUpdate is off; see create() and Config.physics). The frame
    // delta is clamped so a stall doesn't produce huge, unstable steps. Stepping
    // happens first so the rest of the frame sees post-step positions.
    const n = Config.physics.substeps;
    const sub = Math.min(delta, Config.physics.maxFrameDelta) / n;
    for (let i = 0; i < n; i++) this.matter.world.step(sub);

    this.brothers.update();
    this._updatePinch();

    if (this.status === 'PLAYING' && this.phase === 'MOVING') {
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
    if (this.level.destination && this.brothers.anyInside(this.level.destination)) {
      // Record best (most moves left) — note 0 is a real result, distinct from
      // "never won" (null).
      const best = this.registry.get(this._bestKey);
      if (best == null || this.movesLeft > best) this.registry.set(this._bestKey, this.movesLeft);
      this._winBurst();
      sfx.win();
      this._endGame('LEVEL CLEAR!', FACES.win, '#7cfc8a', true);
      return;
    }
    if (this.movesLeft <= 0) {
      sfx.lose();
      this._endGame('OUT OF MOVES', FACES.lose, '#ff7a6b', false);
      return;
    }
    this.brothers.swapRoles();
    this.phase = 'AIMING';
    this._refreshHud();
  }

  /**
   * Celebratory one-shot at the destination when the level is cleared:
   * a quick scale pop on the goal plus an expanding ring.
   *
   * @returns {void}
   */
  _winBurst() {
    const d = this.level.destination;
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
   * Show the end banner. The level stays interactive (pan/zoom still work);
   * restarting is done via the "Restart level" button, not a stray click.
   *
   * @param {string} message
   * @param {string} face  Emoji shown on both brothers.
   * @returns {void}
   */
  _endGame(message, face, color, won) {
    this.status = 'ENDED';
    this.brothers.setBothFaces(face);
    this._refreshHud(); // -> "Game Ended" text, reset enabled, ENDED status icon

    // Banner: pop the panel + text in, then let the text gently breathe. No
    // instruction text — an icon animates instead (see _attract).
    this.banner.setText(message).setColor(color);
    for (const o of [this.bannerPanel, this.banner]) o.setScale(0).setVisible(true);
    this.tweens.add({
      targets: [this.bannerPanel, this.banner],
      scale: 1,
      duration: 460,
      ease: 'Back.Out',
      onComplete: () => {
        this.tweens.add({
          targets: this.banner,
          scale: 1.05,
          duration: 950,
          ease: 'Sine.InOut',
          yoyo: true,
          repeat: -1,
        });
      },
    });

    // On a win with a next level, hint "go on" by drawing the eye to Next;
    // otherwise (loss, or last level) hint "try again" via Restart.
    const goNext = won && currentIndex() < levelCount() - 1;
    this._attract(goNext ? this.nextButton : this.restartButton);
  }

  /**
   * Draw the eye to a HUD icon once the level is over: a glow ring that pulses
   * outward behind it, plus a soft heartbeat on the icon itself. Both loop until
   * the scene restarts/rebuilds (which kills the tweens).
   *
   * @param {Phaser.GameObjects.Image} icon
   * @returns {void}
   */
  _attract(icon) {
    // Remember which icon we're highlighting so the glow follows it across
    // layout changes (window resize / device rotation), instead of sticking to
    // the screen position it had when the pulse started. See _layoutHud.
    this._attractTarget = icon;
    this.attractGlow
      .setPosition(icon.x, icon.y)
      .setVisible(true)
      .setScale(1)
      .setAlpha(0.9);
    this.tweens.add({
      targets: this.attractGlow,
      scale: 2,
      alpha: 0,
      duration: 950,
      ease: 'Sine.Out',
      repeat: -1,
    });
    this.tweens.add({
      targets: icon,
      scale: 1.15,
      duration: 600,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
  }

  /**
   * Sync the HUD text to current turn and moves.
   *
   * @returns {void}
   */
  _refreshHud() {
    const launcher = this.brothers.launcher;
    // Ended: a neutral "Game Ended". In flight: "Moving" in the launching
    // ball's colour. Otherwise: prompt for the current aimer's turn.
    let text;
    let color;
    if (this.status === 'ENDED') {
      text = 'Game Ended';
      color = '#9aa0a6';
    } else if (this.phase === 'MOVING') {
      text = 'Moving';
      color = launcher.color;
    } else {
      text = `${launcher.name}'s turn — drag to aim`;
      color = launcher.color;
    }
    this.turnText.setText(text).setColor(color);
    const best = this.registry.get(this._bestKey);
    this.movesText.setText(`Best: ${best == null ? '-' : best}    #Left: ${this.movesLeft}`);
    this._refreshResetButton();
    this._refreshNavButtons();
    this._refreshStatusIcon();
  }
}
