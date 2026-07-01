import { Config, applyRubberBandDefaults } from '../config.js';
import { Brothers, FACES } from '../Brothers.js';
import { Brother } from '../world/Brother.js';
import { sfx } from '../Sfx.js';
import {
  currentLevel,
  currentLevelKey,
  levelCount,
  currentIndex,
  setLevelIndex,
  activePackName,
  activePackId,
  listPacks,
  loadPackManifest,
  loadPack,
} from '../levels.js';
import * as scores from '../scores.js';
import { World } from '../world/World.js';

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
      'icon-menu': 'list',
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
    /** The world: owns every level entity (goals, teleporters, walls); see src/world. */
    this.world = new World(this, this.level);

    this.brothers = new Brothers(this, this.world);

    /** @type {LevelStatus} */
    this.status = 'READY';
    /** @type {TurnPhase} */
    this.phase = 'AIMING';
    this.movesLeft = this.level.moves;
    // Best winning result = the most moves ever left over on a win. Mirrored in
    // the registry (keyed per level) for fast access during play; seeded from
    // persistent storage below so it survives a full page reload, not just a
    // scene restart.
    /** True between pointerdown-on-launcher and pointerup. */
    this.isAiming = false;
    /** Last finger-spread distance while pinch-zooming (0 = not pinching). */
    this._pinchDist = 0;
    /** Camera-pan drag state. */
    this._isPanning = false;
    this._panLast = { x: 0, y: 0 };
    /** True while the "Restart level?" confirmation modal is open. */
    this._modalOpen = false;
    /** True while the dev parameter-tuning panel is open. Persisted in the
     *  registry so "Restart level" leaves an open lab panel in place. */
    this._devOpen = this.registry.get('devOpen') || false;
    /** True while the menu/scoreboard panel is open. */
    this._menuOpen = false;
    /** Test mode: relaxes menu click-to-jump to allow any level. Persisted in
     *  the registry so it survives scene restarts within a session. */
    this._testMode = this.registry.get('testMode') || false;
    /** HUD icon the attract glow is tracking (null = not attracting). */
    this._attractTarget = null;

    // Seed this level's best from persistent storage so "Best:" and the
    // win-to-advance nav rule survive a page reload (registry is per-session).
    if (!this.registry.has(this._bestKey)) {
      this.registry.set(this._bestKey, scores.bestFor(currentLevelKey()));
    }

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
    // Small screens stack text line(s) above the icon row: compact has one
    // (info on a single line), narrow has two (state, then Best/#Left). These
    // text rows use a tighter height than the icon row (text doesn't need the
    // icon's touch-target height), so they don't waste scarce vertical space.
    const textRows = mode === 'narrow' ? 2 : mode === 'compact' ? 1 : 0;
    const textRow = H.narrowTextRow;
    const hudHeight = textRows * textRow + H.rowHeight;
    this._layout = {
      w,
      h,
      mode,
      rows,
      rowHeight: H.rowHeight,
      textRow,
      textRows,
      hudHeight,
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

    // Opaque ribbon + bottom border span the full width.
    this.hudBar.setPosition(cx, L.hudHeight / 2).setSize(L.w, L.hudHeight);
    this.hudBorder.setPosition(cx, L.hudHeight).setSize(L.w, 2);

    // Icon cluster (menu, prev, restart, next, status) on the last row.
    const icons = [
      this.menuButton,
      this.prevButton,
      this.restartButton,
      this.nextButton,
      this.statusIcon,
    ];
    const tips = [
      this.menuTooltip,
      this.prevTooltip,
      this.restartTooltip,
      this.nextTooltip,
      this.statusTooltip,
    ];
    // Icons sit on a full-height row below any compact text rows (in wide mode
    // there are none, so the icons share the single row with the edge text).
    const iconRowY = L.textRows * L.textRow + rh / 2;
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
      // Two tight text rows: centres at half and one-and-a-half text-row heights.
      this.turnText.setOrigin(0.5, 0.5).setPosition(cx, L.textRow / 2);
      this.movesText.setOrigin(0.5, 0.5).setPosition(cx, L.textRow * 1.5);
    } else {
      // One row of edge text. Compact: its own tight row above the icons. Wide:
      // shares the single icon row (centred on it).
      const textY = L.mode === 'compact' ? L.textRow / 2 : rh / 2;
      this.turnText.setOrigin(0, 0.5).setPosition(L.pad, textY);
      this.movesText.setOrigin(1, 0.5).setPosition(L.w - L.pad, textY);
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
      this.menuButton,
      this.menuTooltip,
      this.entityInfoText,
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

    // Floating label naming whatever world entity the player hovers or presses
    // (wording comes from Entity.infoText; see showEntityInfo). Anchored
    // bottom-left so it floats above-right of the pointer.
    this.entityInfoText = this.add
      .text(0, 0, '', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0, 1)
      .setDepth(11)
      .setVisible(false);
    /** @type {import('../world/Entity.js').Entity|null} Entity whose info is showing. */
    this._infoEntity = null;

    // The tooltip always reveals on hover/press (even when reset is disabled);
    // brightening and the actual restart only apply when reset is enabled. The
    // label names the current pack + level, set fresh on reveal since both can
    // change as the player navigates.
    const showTip = () => {
      this.restartTooltip
        .setText(`Restart Level (${activePackName()} Level ${currentIndex() + 1})`)
        .setVisible(true);
    };
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

    // Menu button (hamburger): opens the dropdown of less-used options and the
    // pack/level scoreboard. Laid out at the FRONT of the cluster in _layoutHud.
    // Actionable, so it gets a hand cursor.
    this.menuButton = this.add
      .image(Config.view.width / 2 - 2 * gap, h / 2, 'icon-menu')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });
    this.menuTooltip = this.add
      .text(Config.view.width / 2 - 2 * gap, h + 12, 'Menu', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    this.menuButton.on('pointerover', () => {
      this.menuButton.setAlpha(1);
      this.menuTooltip.setVisible(true);
    });
    this.menuButton.on('pointerout', () => {
      this.menuButton.setAlpha(0.8);
      this.menuTooltip.setVisible(false);
    });
    this.menuButton.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation();
      this.menuTooltip.setVisible(true);
    });
    this.menuButton.on('pointerup', () => {
      this.menuTooltip.setVisible(false);
      this._toggleMenu(); // open, or close if already showing (button is raised above the backdrop)
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
    // Name the target level on reveal (it changes as the player navigates), or
    // "(None)" when there's no such level in this direction.
    const reveal = () => tip.setText(tooltipText + this._navTargetSuffix(dir)).setVisible(true);
    icon.on('pointerover', () => {
      if (this._navEnabled(dir)) icon.setAlpha(1);
      reveal();
    });
    icon.on('pointerout', () => {
      this._refreshNavButtons();
      tip.setVisible(false);
    });
    icon.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation();
      reveal();
    });
    icon.on('pointerup', () => {
      tip.setVisible(false);
      this._navClicked(dir);
    });
    return [icon, tip];
  }

  /**
   * Tooltip suffix naming the level a nav icon would go to: " (Pack N)", or
   * " (None)" if there's no level in that direction, or " (Locked)" if the
   * next level exists but the current level hasn't been won yet (and we're
   * not in test mode).
   *
   * @param {'prev'|'next'} dir
   * @returns {string}
   */
  _navTargetSuffix(dir) {
    const target = currentIndex() + (dir === 'prev' ? -1 : 1);
    if (target < 0 || target >= levelCount()) return ' (None)';
    if (dir === 'next') {
      const wonCurrent = this.registry.get(this._bestKey) != null;
      if (!wonCurrent && !this._testMode) return ' (Locked)';
    }
    return ` (${activePackName()} Level ${target + 1})`;
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
      { obj: Config.ball, key: 'davidRadiusMult', step: 0.01, dp: 2, min: 1, max: 2, desc: "David's radius as a multiple of Ken's (1.00-2.00)." },
      { obj: Config.ball, key: 'davidMassMult', step: 0.01, dp: 2, min: 1, max: 3, desc: "David's mass as a multiple of Ken's (1.00-3.00)." },
    ];
    const n = this._devParams.length;
    const helpY = y0 + 38 + n * rowH;
    const moreTurnsY = helpY + 54;
    const resetY = moreTurnsY + 36;
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
    // "More turns" lets us keep experimenting past a win/loss (see _moreTurns).
    parts.push(this._devButton(x0 + w / 2, moreTurnsY, 'More turns', () => this._moreTurns()));
    parts.push(this._devButton(x0 + w / 2, resetY, 'Reset parameters', () => this._resetParams()));

    this.devPanelParts = parts;
    // Honour a persisted open state (e.g. after a "Restart level").
    for (const p of parts) p.setVisible(this._devOpen);
  }

  /**
   * Prompt for a direct numeric value for a dev parameter (clamped to its
   * min/max). Uses window.prompt so it works on desktop and mobile without a
   * DOM input.
   *
   * @param {{obj: object, key: string, min: number, max?: number}} param
   * @returns {void}
   */
  _promptParam(param) {
    const input = window.prompt(`Set ${param.key}`, String(param.obj[param.key]));
    if (input === null) return; // cancelled
    const v = parseFloat(input);
    if (!Number.isFinite(v)) return; // not a number
    param.obj[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min, v));
    this._devRows.forEach((r) => this._setDevRowText(r));
    this.brothers?._applyDavidPhysique(); // apply if this was a David size/mass row
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
    this.brothers?._applyDavidPhysique(); // David's size/mass are among the defaults
  }

  /**
   * Dev helper ("More turns"): grant 6 extra moves so tuning can continue. If
   * the level has already ended, resume play — drop the end banner and attract
   * glow, then hand off to a fresh aiming turn — so we can keep experimenting
   * in the same layout instead of restarting.
   *
   * @returns {void}
   */
  _moreTurns() {
    this.movesLeft += 6;
    if (this.status === 'ENDED') {
      this.status = 'PLAYING';
      this.phase = 'AIMING';
      this._clearEndDisplay();
      this.brothers.swapRoles(); // clean next-turn handoff: faces, glow, refreeze
    }
    this._refreshHud();
  }

  /**
   * Tear down the end-of-level display: stop and hide the banner, its backing
   * panel, and the attract glow/heartbeat, restoring the highlighted icon to
   * its normal size. Used when resuming play via {@link _moreTurns}.
   *
   * @returns {void}
   */
  _clearEndDisplay() {
    this.tweens.killTweensOf([this.banner, this.bannerPanel, this.attractGlow]);
    if (this._attractTarget) {
      this.tweens.killTweensOf(this._attractTarget);
      this._attractTarget = null;
    }
    for (const o of [this.banner, this.bannerPanel, this.attractGlow]) o.setVisible(false);
    this._layoutHud(); // restore the heart-beated icon to its normal size
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
   * Step a parameter by ±its step (clamped to its min and optional max), then
   * refresh the rows.
   *
   * @param {{obj: object, key: string, step: number, dp: number, min: number, max?: number}} param
   * @param {number} dir  -1 or +1.
   * @returns {void}
   */
  _adjustParam(param, dir) {
    const raw = param.obj[param.key] + dir * param.step;
    const clamped = Math.min(param.max ?? Infinity, Math.max(param.min, Number(raw.toFixed(param.dp))));
    param.obj[param.key] = clamped;
    this._devRows.forEach((r) => this._setDevRowText(r));
    this.brothers?._applyDavidPhysique(); // apply if this was a David size/mass row
  }

  /**
   * Show/hide the dev panel (toggled by the Lab control in the menu).
   *
   * @returns {void}
   */
  _toggleDevPanel() {
    this._devOpen = !this._devOpen;
    this.registry.set('devOpen', this._devOpen); // survive scene restarts
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

  // --- Menu / scoreboard --------------------------------------------------

  /** @returns {string} Lab toggle button label. */
  _labLabel() {
    return `Lab: ${this._devOpen ? 'On' : 'Off'}`;
  }

  /** @returns {string} Test-mode toggle button label. */
  _testLabel() {
    return `Test: ${this._testMode ? 'On' : 'Off'}`;
  }

  /**
   * Toggle the menu from the menu button: open if closed, close if showing.
   *
   * @returns {void}
   */
  _toggleMenu() {
    if (this._modalOpen) return; // a confirm is up; let it resolve first
    if (this._menuOpen) this._closeMenu();
    else this._openMenu();
  }

  /**
   * Open the menu/scoreboard overlay (no-op if a modal or the menu is up). The
   * menu button is raised above the backdrop so clicking it again closes the
   * menu (see _toggleMenu); _closeMenu restores its normal depth.
   *
   * @returns {void}
   */
  _openMenu() {
    if (this._menuOpen || this._modalOpen) return;
    this._menuOpen = true;
    this._isPanning = false;
    this._menuDragging = false;
    this._buildMenuPanel();
    this.menuButton.setDepth(33); // above the depth-30 backdrop so it stays clickable
    this._showPackList();
  }

  /**
   * Build the menu chrome (modal-style, depth 30-32): a dimming backdrop, a
   * rounded card, a fixed header (title + close, plus Lab/Test toggles when
   * Config.devTools), a hidden Back button, and a mask-clipped scrollable
   * content container. Mirrors _showConfirm's camera/cleanup pattern. The list
   * itself is filled by _showPackList / _showPackDetail.
   *
   * @returns {void}
   */
  _buildMenuPanel() {
    const L = this._layout;
    const cw = Math.min(440, L.w - 2 * L.pad);
    const ch = Math.min(L.h - 2 * L.pad, 560);
    const cx0 = (L.w - cw) / 2;
    const cy0 = (L.h - ch) / 2;
    this._menuCard = { x: cx0, y: cy0, w: cw, h: ch };

    const backdrop = this.add
      .rectangle(L.w / 2, L.h / 2, L.w, L.h, 0x000000, 0.6)
      .setDepth(30)
      .setInteractive(); // swallow clicks on the dimmed area
    const card = this.add.graphics().setDepth(31);
    card.fillStyle(0x23232c, 1).fillRoundedRect(cx0, cy0, cw, ch, 14);
    card.lineStyle(2, 0x4d4d55, 1).strokeRoundedRect(cx0, cy0, cw, ch, 14);
    const title = this.add
      .text(
        cx0 + 16,
        cy0 + 16,
        `${activePackName()} Level ${currentIndex() + 1}/${levelCount()}`,
        { fontSize: '18px', color: '#ffffff', fontStyle: 'bold' }
      )
      .setDepth(32);
    const close = this._devButton(
      cx0 + cw - 20,
      cy0 + 22,
      '×',
      () => this._closeMenu(),
      '#c0392b',
      '#e74c3c'
    ).setDepth(32);

    this._menuParts = [backdrop, card, title, close];

    let headerBottom = cy0 + 46;
    if (Config.devTools) {
      const ty = cy0 + 64;
      const lab = this._devButton(cx0 + 16, ty, this._labLabel(), () => {
        this._toggleDevPanel();
        lab.setText(this._labLabel());
      })
        .setOrigin(0, 0.5)
        .setDepth(32);
      const test = this._devButton(cx0 + 150, ty, this._testLabel(), () => {
        this._testMode = !this._testMode;
        this.registry.set('testMode', this._testMode);
        test.setText(this._testLabel());
        if (this._menuView === 'detail') this._showPackDetail(this._menuDetail);
      })
        .setOrigin(0, 0.5)
        .setDepth(32);
      this._menuParts.push(lab, test);
      headerBottom = ty + 18;
    }

    // Back affordance (only shown in a pack's level view).
    this._menuBackBtn = this._devButton(cx0 + 16, headerBottom + 16, '‹ Back', () =>
      this._showPackList()
    )
      .setOrigin(0, 0.5)
      .setDepth(32)
      .setVisible(false);
    this._menuParts.push(this._menuBackBtn);

    // Scroll viewport: a geometry mask (off-display-list make.graphics) clips a
    // content container we shift vertically. The uiCamera is at scroll 0/zoom 1,
    // so screen px == mask px == container-local px (no coordinate conversion).
    const listTop = headerBottom + 34;
    this._menuListX = cx0 + 16;
    this._menuListW = cw - 32;
    this._menuListTop = listTop;
    // The card is already clamped to the viewport; floor the list height so an
    // extremely short screen can't collapse it to zero/negative (which would
    // break the mask) — at worst it shows ~one row and stays scrollable.
    this._menuListH = Math.max(44, cy0 + ch - 14 - listTop);
    this._menuScroll = 0;
    this._menuScrollMax = 0;

    this._menuMaskGfx = this.make.graphics();
    this._menuMaskGfx
      .fillStyle(0xffffff)
      .fillRect(this._menuListX, listTop, this._menuListW, this._menuListH);
    this._menuContent = this.add.container(this._menuListX, listTop).setDepth(32);
    this._menuContent.setMask(this._menuMaskGfx.createGeometryMask());
    this._menuParts.push(this._menuContent);

    // Scrollbar indicator (right edge of the viewport). Shown only when the
    // content overflows; sized/positioned by _updateScrollbar. Not in the
    // content container, so it stays put while the list scrolls.
    this._menuScrollbar = this.add
      .rectangle(this._menuListX + this._menuListW - 3, listTop, 4, 20, 0xffffff, 0.45)
      .setOrigin(0.5, 0.5)
      .setDepth(32)
      .setVisible(false);
    this._menuParts.push(this._menuScrollbar);

    this.cameras.main.ignore(this._menuParts); // HUD-camera only (like _showConfirm)

    for (const part of this._menuParts) {
      const to = part === backdrop ? 0.6 : 1;
      part.setAlpha(0);
      this.tweens.add({ targets: part, alpha: to, duration: 130, ease: 'Sine.Out' });
    }
  }

  /**
   * View A: list the available packs, each with the player's total score and
   * completed/total count. Tapping a pack opens its per-level view.
   *
   * @returns {Promise<void>}
   */
  async _showPackList() {
    this._menuView = 'packs';
    this._menuBackBtn.setVisible(false);
    this._menuScroll = 0;
    this._clearMenuContent();
    const packs = await listPacks();
    if (!this._menuOpen || this._menuView !== 'packs') return; // closed/changed mid-fetch
    let y = 0;
    for (const { id } of packs) {
      const m = await loadPackManifest(id);
      if (!this._menuOpen || this._menuView !== 'packs') return;
      const { total, completed } = this._packTotal(m);
      this._menuRow(y, m.name, `${total} ★   ${completed}/${m.levelIds.length}`, {
        onTap: () => this._showPackDetail(m),
      });
      y += 44;
    }
    this._finishMenuContent(y);
  }

  /**
   * View B: per-level best scores for a pack. Tapping a level jumps to it,
   * subject to the gating rules (see _canJump); disallowed levels show a lock.
   *
   * @param {{id:string, name:string, levelIds:string[]}} manifest
   * @returns {void}
   */
  _showPackDetail(manifest) {
    this._menuView = 'detail';
    this._menuDetail = manifest;
    this._menuBackBtn.setVisible(true);
    this._menuScroll = 0;
    this._clearMenuContent();
    let y = 0;
    let hasScores = false;
    manifest.levelIds.forEach((file, i) => {
      const best = scores.bestFor(`${manifest.id}/${file}`);
      if (best != null) hasScores = true;
      const allowed = this._canJump(manifest, i);
      const value = best != null ? `✓  ${best} ★` : allowed ? '—' : '🔒';
      this._menuRow(y, `Level ${i + 1}`, value, {
        enabled: allowed,
        valueColor: best != null ? '#ffd479' : '#7a7a85',
        onTap: allowed ? () => this._jumpToLevel(manifest, i) : null,
      });
      y += 44;
    });
    // "Forget pack scores" at the bottom of the scrollable list (shaded out when
    // the pack has no scores). It scrolls with the levels, so it's reachable via
    // the scrollbar/drag when the list overflows.
    y += 10;
    y += this._menuContentButton(y, 'Forget pack scores', {
      enabled: hasScores,
      onTap: () => this._confirmForgetPack(manifest),
    });
    this._finishMenuContent(y);
  }

  /**
   * Confirm, then forget all best scores for a pack. If the player is in that
   * pack, past level 1, and not in test mode, drop them to level 1 (a now-locked
   * later level shouldn't stay loaded once its unlock is forgotten).
   *
   * @param {{id:string, name:string, levelIds:string[]}} manifest
   * @returns {void}
   */
  _confirmForgetPack(manifest) {
    this._showConfirm(`Forget scores for pack ${manifest.name}?`, () => {
      const keys = manifest.levelIds.map((f) => `${manifest.id}/${f}`);
      scores.forget(keys); // clear persisted scores
      const inThisPack = manifest.id === activePackId();
      if (inThisPack) {
        // Also clear the in-memory registry, which cached this session's bests;
        // otherwise the HUD "Best:" (and the restart hydration) would keep
        // showing the old numbers instead of "-".
        for (const k of keys) this.registry.set(`best:${k}`, null);
      }
      if (!this._testMode && inThisPack && currentIndex() > 0) {
        this._hideConfirm();
        this._closeMenu();
        setLevelIndex(0);
        this.scene.restart();
        return;
      }
      if (inThisPack) this._refreshHud(); // -> "Best: -"
      this._hideConfirm();
      this._showPackDetail(manifest); // re-render: scores cleared, button shaded
    });
  }

  /**
   * Total (sum of bests) and completed count for a pack.
   *
   * @param {{id:string, levelIds:string[]}} manifest
   * @returns {{total:number, completed:number}}
   */
  _packTotal(manifest) {
    let total = 0;
    let completed = 0;
    for (const file of manifest.levelIds) {
      const b = scores.bestFor(`${manifest.id}/${file}`);
      if (b != null) {
        total += b;
        completed += 1;
      }
    }
    return { total, completed };
  }

  /**
   * May the player jump to level `i` of `manifest`? Test mode allows any level;
   * otherwise only the first level or one whose predecessor has a best score.
   *
   * @param {{id:string, levelIds:string[]}} manifest
   * @param {number} i
   * @returns {boolean}
   */
  _canJump(manifest, i) {
    if (this._testMode) return true;
    if (i === 0) return true;
    return scores.bestFor(`${manifest.id}/${manifest.levelIds[i - 1]}`) != null;
  }

  /**
   * Jump to a level: confirm first if a game is in progress, then load the pack
   * (only if different) and restart the scene at the chosen level.
   *
   * @param {{id:string}} manifest
   * @param {number} index
   * @returns {void}
   */
  _jumpToLevel(manifest, index) {
    const proceed = async () => {
      this._closeMenu();
      if (manifest.id !== activePackId()) await loadPack(manifest.id);
      setLevelIndex(index);
      this.scene.restart();
    };
    if (this.status === 'PLAYING') this._showConfirm('Abandon current game?', proceed);
    else proceed();
  }

  /**
   * One menu list row (added to the scrollable content container): a subtle
   * background, a left label, and a right-aligned value. If `onTap` is given the
   * row is interactive (with an off-clip guard, since masks don't clip input).
   *
   * @param {number} localY  Top of the row in container-local space.
   * @param {string} label
   * @param {string} value
   * @param {{onTap?:(()=>void)|null, enabled?:boolean, valueColor?:string}} [opts]
   * @returns {void}
   */
  _menuRow(localY, label, value, opts = {}) {
    const { onTap = null, enabled = true, valueColor = '#ffd479' } = opts;
    const rowH = 44;
    const w = this._menuListW;
    const top = this._menuListTop;
    const midY = localY + (rowH - 6) / 2;
    const bg = this.add.rectangle(0, localY, w, rowH - 6, 0xffffff, 0.06).setOrigin(0, 0);
    const labelTxt = this.add
      .text(12, midY, label, { fontSize: '17px', color: enabled ? '#ffffff' : '#7a7a85' })
      .setOrigin(0, 0.5);
    const valueTxt = this.add
      // Top/bottom padding gives the text canvas room: Phaser under-measures
      // emoji height (✓/★/🔒), so without it the glyph's top is clipped.
      .text(w - 12, midY, value, {
        fontSize: '17px',
        color: valueColor,
        padding: { top: 6, bottom: 6 },
      })
      .setOrigin(1, 0.5);
    this._menuContent.add([bg, labelTxt, valueTxt]);
    if (onTap) {
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerover', () => bg.setFillStyle(0xffffff, 0.14));
      bg.on('pointerout', () => bg.setFillStyle(0xffffff, 0.06));
      bg.on('pointerup', (p) => {
        if (p.y < top || p.y > top + this._menuListH) return; // row scrolled out of view
        if (Math.abs(p.y - this._menuDownY) > 6) return; // this was a drag-scroll, not a tap
        onTap();
      });
    }
  }

  /**
   * A centered button inside the scrollable content (e.g. "Forget pack
   * scores"). Destructive-red when enabled, gray when disabled. Same off-clip /
   * drag-vs-tap guards as _menuRow.
   *
   * @param {number} localY  Top of the button in container-local space.
   * @param {string} label
   * @param {{onTap?:(()=>void)|null, enabled?:boolean}} [opts]
   * @returns {number} The vertical space the button occupies.
   */
  _menuContentButton(localY, label, opts = {}) {
    const { onTap = null, enabled = true } = opts;
    const h = 32;
    const top = this._menuListTop;
    const cx = this._menuListW / 2;
    const midY = localY + h / 2;
    const baseColor = enabled ? 0x7a2e2e : 0x33333b; // red when actionable, gray when off
    const rect = this.add
      .rectangle(cx, midY, Math.min(220, this._menuListW), h, baseColor, 1)
      .setOrigin(0.5);
    const txt = this.add
      .text(cx, midY, label, { fontSize: '15px', color: enabled ? '#ffffff' : '#777' })
      .setOrigin(0.5);
    this._menuContent.add([rect, txt]);
    if (enabled && onTap) {
      rect.setInteractive({ useHandCursor: true });
      rect.on('pointerover', () => rect.setFillStyle(0x9b3a3a, 1));
      rect.on('pointerout', () => rect.setFillStyle(baseColor, 1));
      rect.on('pointerup', (p) => {
        if (p.y < top || p.y > top + this._menuListH) return; // scrolled out of view
        if (Math.abs(p.y - this._menuDownY) > 6) return; // a drag-scroll, not a tap
        onTap();
      });
    }
    return h;
  }

  /** Destroy the current list rows (keeps the container + mask). */
  _clearMenuContent() {
    if (this._menuContent) this._menuContent.removeAll(true);
  }

  /**
   * Finalise a populated list: set the scroll range, keep the world camera off
   * the new rows, and fade them in.
   *
   * @param {number} contentH  Total height of the rows just added.
   * @returns {void}
   */
  _finishMenuContent(contentH) {
    if (!this._menuContent) return; // menu closed mid-populate
    this._menuContentH = contentH;
    this._menuScrollMax = Math.max(0, contentH - this._menuListH);
    this._menuScroll = Phaser.Math.Clamp(this._menuScroll, 0, this._menuScrollMax);
    this._menuContent.y = this._menuListTop - this._menuScroll;
    this.cameras.main.ignore(this._menuContent); // re-walk: new children too
    this._menuContent.setAlpha(0);
    this.tweens.add({ targets: this._menuContent, alpha: 1, duration: 150, ease: 'Sine.Out' });
    this._updateScrollbar();
  }

  /**
   * Scroll the list by `delta` screen pixels, clamped to its range.
   *
   * @param {number} delta
   * @returns {void}
   */
  _menuScrollBy(delta) {
    this._menuScroll = Phaser.Math.Clamp(this._menuScroll + delta, 0, this._menuScrollMax);
    this._menuContent.y = this._menuListTop - this._menuScroll;
    this._updateScrollbar();
  }

  /**
   * Size/position the scrollbar thumb for the current scroll, or hide it when
   * the content fits. Gives a clear, draggable-feeling cue that there's more.
   *
   * @returns {void}
   */
  _updateScrollbar() {
    const bar = this._menuScrollbar;
    if (!bar) return;
    if (this._menuScrollMax <= 0) {
      bar.setVisible(false);
      return;
    }
    const viewH = this._menuListH;
    const thumbH = Math.max(24, viewH * (viewH / this._menuContentH));
    const t = this._menuScroll / this._menuScrollMax;
    const y = this._menuListTop + t * (viewH - thumbH);
    bar.setSize(4, thumbH).setPosition(this._menuListX + this._menuListW - 3, y + thumbH / 2).setVisible(true);
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if the pointer is over the open menu card.
   */
  _overMenuPanel(p) {
    const c = this._menuCard;
    return p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
  }

  /** Tear down the menu overlay (mirrors _hideConfirm). */
  _closeMenu() {
    if (!this._menuOpen) return;
    this._menuContent.clearMask(true);
    this._menuMaskGfx.destroy();
    for (const part of this._menuParts) part.destroy();
    this._menuParts = null;
    this._menuContent = null;
    this._menuOpen = false;
    this._menuDragging = false;
    this.menuButton.setDepth(10).setAlpha(0.8); // restore normal HUD depth/look
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
      if (this._menuOpen) {
        // The menu backdrop swallows game input; a press on the list starts a
        // drag-scroll (its own buttons handle their taps). _menuDownY lets a row
        // tell a tap from a drag (see _menuRow).
        this._menuDownY = p.y;
        if (this._overMenuPanel(p)) {
          this._menuDragging = true;
          this._menuDragLastY = p.y;
        }
        return;
      }
      if (this._pinchDist) return; // a two-finger pinch owns the gesture
      if (p.y < this._hudHeight) return; // press is on the HUD ribbon, not the arena
      if (this._overDevPanel(p)) return; // press is on the dev panel

      // Pressing on the launcher (while aiming, and not after the level ends)
      // starts a shot; pressing anywhere else on the board pans the camera.
      if (this.status !== 'ENDED' && this.phase === 'AIMING') {
        const l = this.brothers.launcher.go;
        const reach = l.radius * 1.4; // forgiving for touch; tracks the launcher's size
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
      // Keep an open entity-info label floating with the pointer.
      if (this._infoEntity) this.entityInfoText.setPosition(p.x + 14, p.y - 8);
      if (this._modalOpen) return;
      if (this._menuOpen) {
        if (this._menuDragging) {
          this._menuScrollBy(this._menuDragLastY - p.y);
          this._menuDragLastY = p.y;
        }
        return;
      }
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
      if (this._menuOpen) {
        this._menuDragging = false;
        return;
      }
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
      if (this._menuOpen) {
        this._menuScrollBy(dy); // wheel scrolls the menu list, not the arena
        return;
      }
      const step = Config.zoom.wheelStep;
      this._zoomBy(dy > 0 ? 1 - step : 1 + step, p.x, p.y);
    });

    // Mobile: make a second touch pointer available for pinch (handled in
    // update() so we can track the changing finger spread frame to frame).
    this.input.addPointer(1);
  }

  /**
   * Show a world entity's info label (its name/class) near the pointer while the
   * player hovers or presses it. The wording comes from the entity
   * ({@link import('../world/Entity.js').Entity#infoText}), so it lives in one
   * place. Called from `Entity._enableInfo`.
   *
   * @param {import('../world/Entity.js').Entity} entity
   * @returns {void}
   */
  showEntityInfo(entity) {
    if (this._modalOpen || this._menuOpen) return; // an overlay owns the screen
    const p = this.input.activePointer;
    this._infoEntity = entity;
    this.entityInfoText
      .setText(entity.infoText())
      .setPosition(p.x + 14, p.y - 8)
      .setVisible(true);
  }

  /**
   * Hide the entity info label — but only if `entity` is the one showing, so
   * moving straight from one entity to an adjacent one doesn't flicker.
   *
   * @param {import('../world/Entity.js').Entity} entity
   * @returns {void}
   */
  hideEntityInfo(entity) {
    if (this._infoEntity !== entity) return;
    this._infoEntity = null;
    this.entityInfoText.setVisible(false);
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
   * Collision routing: brother-on-brother triggers the Hybrid Snap; a brother
   * touching a solid (wall/edge) also snaps; a brother entering a trigger object
   * is dispatched to that object via its body's `entity` back-reference
   * (e.g. a teleporter warps the pair). The win check happens at settle time
   * (distance-based, see World.firstReached), not here, so a fast
   * fly-through doesn't win.
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
        const aBro = pair.bodyA.entity instanceof Brother;
        const bBro = pair.bodyB.entity instanceof Brother;

        if (aBro && bBro) {
          sfx.hit(); // billiard-style click on every brother-on-brother contact
          this.brothers.snap();
          continue;
        }
        const other = aBro ? pair.bodyB : bBro ? pair.bodyA : null;
        if (!other) continue; // neither is a brother

        if (other.isSensor) {
          // A trigger object (e.g. teleporter) handles itself; goals are
          // checked at settle, so their no-op handler does nothing here.
          other.entity?.onBrotherContact();
        } else {
          sfx.hit(); // brother off a wall or the arena edge — same click, no debounce
          this.brothers.snap(); // hitting a solid also frees the anchor
        }
      }
    });
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
    // Tick any dynamic world objects (culled to the view). No-op today, since
    // all current objects are static/tween-driven; here for future types.
    this.world.update({ brothers: this.brothers, view: this.cameras.main.worldView });
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
    const reached = this.world.firstReached(this.brothers);
    if (reached) {
      // Record best score (most moves left) if we beat it.
      // Note that "0" is a real best score result, distinct from
      // "never won" (null).
      const best = this.registry.get(this._bestKey);
      let message = 'Level clear!'; // Default success message
      if (best == null) {
        message = 'First time!';
        this.registry.set(this._bestKey, this.movesLeft);
      } else if (this.movesLeft > best) {
        message = 'New best score!';
        this.registry.set(this._bestKey, this.movesLeft);
      }
      scores.recordBest(currentLevelKey(), this.movesLeft); // persist across reloads
      reached.celebrate();
      sfx.win();
      this._endGame(message, FACES.win, '#7cfc8a', true);
      return;
    }
    if (this.movesLeft <= 0) {
      sfx.lose();
      this._endGame('Out of moves', FACES.lose, '#ff7a6b', false);
      return;
    }
    this.brothers.swapRoles();
    this.phase = 'AIMING';
    this._refreshHud();
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
      text = `${launcher.name}'s turn, drag to aim`;
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
