import { Config, applyRubberBandDefaults } from '../config.js';
import { Brothers, FACES } from '../Brothers.js';
import { Brother } from '../world/Brother.js';
import { Hazard } from '../world/Hazard.js';
import { sfx } from '../Sfx.js';
import {
  currentLevel,
  currentLevelKey,
  levelCount,
  currentIndex,
  selectLevel,
  activePackName,
  activePackId,
  activePackManifest,
  listPacks,
  loadPackManifest,
  loadPack,
  levelName,
  levelIntro,
} from '../levels.js';
import { introSeen, markIntroSeen, clearIntroSeen } from '../intros.js';
import * as scores from '../scores.js';
import { World } from '../world/World.js';
import { labOpen, setLabOpen, setSkipTitle, setTestMode, testMode } from '../prefs.js';
import * as diag from '../diag.js';
import { Modal } from '../ui/Modal.js';
import { Panel } from '../ui/Panel.js';
import { Menu } from '../ui/Menu.js';
import { Tooltip } from '../ui/Tooltip.js';
import { chipButton } from '../ui/chipButton.js';

/** Body text for the Help modal (plain text; the modal word-wraps it). */
const HELP_TEXT = [
  'Help the brothers, David and Ken, reach the goal in as few turns as possible.',
  'Move: The glowing brother is the one you move. Drag him back and release to slingshot him toward his partner. The two brothers are joined by an elastic band, so they travel together.',
  'Aim: A red X means that spot is blocked (a wall, the edge, or the other brother). Move and try again.',
  'Turns: Each launch uses one turn, then the other brother takes over. Turns left show as "#Left".',
  'Goal: Land a brother at rest inside the goal ring to win.',
  'Camera: mouse wheel or pinch/spread to zoom in and out; drag empty space to pan.',
  'Scoring: "Best" is the turns you had left on a win (higher is better). "Pack" adds up your Bests. "-" means not won yet; "0" is a real score.',
  'Anchor pin adjustment: single-tap for nearest compass point or center, double-tap for center, drag for fine positioning.',
  'Walls block and bounce. Teleporters warp the pair to a matching target. Bombs are hazards: a spinning arrow shows where each will go and how fast; touching one usually ends the game.',
].join('\n\n');

/** Body text for the About modal (plain text; the modal word-wraps it). */
const ABOUT_TEXT =
  'This game was developed by David A. Wheeler based on an idea by his brother Kenneth A. Wheeler. ' +
  'It was built using the Phaser 2D game framework from Phaser Studio Incorporated (MIT license).  Levels were created by the Tiled level editor from Thorbjørn Lindeijer and community (GPL license though that license does not apply to produced levels). AI assistance was provided by Claude Code and Google Gemini. Title screen music is "Don’t Resist the Groove (Ska) Loopable" by Johannes Söllner, 2024 (CC0 license).';

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
 * - RESOLVING: settled; playing the mud-shed wiggle before the turn is decided
 *   (a brief MOVING→AIMING detour — see {@link GameScene#_resolveTurn}). It also
 *   guards against the settle check re-firing every frame during the wiggle.
 *
 * @typedef {'READY'|'PLAYING'|'ENDED'} LevelStatus
 * @typedef {'AIMING'|'MOVING'|'RESOLVING'} TurnPhase
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

    // A restart reuses this scene instance, so uiCamera would still point at the
    // *previous* run's (now discarded) camera while we rebuild the world. Drop it
    // up front so every pre-_setupCameras assignToWorld behaves the same on a
    // restart as it does on a cold boot: a no-op, covered by the snapshot.
    this.uiCamera = null;

    /** The current level model (from Tiled via levels.js). */
    this.level = currentLevel();
    /** Per-level arena size (varies between levels); drives bounds/camera/grid. */
    this.arena = this.level.arena;
    /** Registry key for this level's best result, so packs don't share scores. */
    this._bestKey = `best:${currentLevelKey()}`;

    this._buildArena();
    this._buildFloorGrid();
    // Shared tooltip service: one reused label for every surface (HUD, arena,
    // menu). Built before the World so entities can attach in _enableInfo, and
    // before _setupCameras so its label is in the UI-camera list. Call sites are
    // migrated onto it surface by surface.
    this.tip = new Tooltip(this);
    /** The world: owns every level entity (goals, teleporters, walls); see src/world. */
    this.world = new World(this, this.level);

    this.brothers = new Brothers(this, this.world);

    /** @type {LevelStatus} */
    this.status = 'READY';
    /** @type {TurnPhase} */
    this.phase = 'AIMING';
    this.movesLeft = this.level.moves;
    /** True once the first launch has connected (first snap); gates {@link _kickoff}. */
    this._kickedOff = false;
    // Best winning result = the most turns ever left over on a win. Mirrored in
    // the registry (keyed per level) for fast access during play; seeded from
    // persistent storage below so it survives a full page reload, not just a
    // scene restart.
    /** True between pointerdown-on-launcher and pointerup. */
    this.isAiming = false;
    /** Aim sub-state while `isAiming`: 'idle' (not grabbed), 'grabbed' (pressed,
     *  not yet moved), or 'dragging' (moved). Drives the turn prompt + cursor. */
    this._aimState = 'idle';
    /** Last-shown "aim is blocked" state while dragging (edge-triggers the prompt). */
    this._aimBlocked = false;
    /** Last finger-spread distance while pinch-zooming (0 = not pinching). */
    this._pinchDist = 0;
    /** True between an anchor pointerdown and pointerup while editing its pin. */
    this._pinning = false;
    /** True once a pin press has been promoted to a fine-drag (drives the HUD). */
    this._pinDragging = false;
    /** God mode: the brother currently held by a right-button drag (null = none). */
    this._godDrag = null;
    /** Camera-pan drag state. */
    this._isPanning = false;
    this._panLast = { x: 0, y: 0 };
    /** Open modal overlays (Modal/Menu), innermost last: the top owns all input. */
    this._modalStack = [];
    /** Open modeless overlays (the Lab panel): each owns input only over itself. */
    this._panels = [];
    /** The modeless Lab tuning {@link Panel} (created in _buildDevPanel). Its open
     *  state is persisted in the registry so "Restart level" leaves it in place. */
    this._labPanel = null;
    /** The menu/scoreboard {@link Menu} overlay (created in _buildHud). */
    this._menu = null;
    /** Test mode: relaxes menu click-to-jump to allow any level, and enables
     *  god mode. Persisted in prefs, so it survives a reload, not just a restart. */
    this._testMode = testMode();
    /** HUD icon the attract glow is tracking (null = not attracting). */
    this._attractTarget = null;

    // Seed this level's best from persistent storage so "Best:" and the
    // win-to-advance nav rule survive a page reload (registry is per-session).
    if (!this.registry.has(this._bestKey)) {
      this.registry.set(this._bestKey, scores.bestFor(currentLevelKey()));
    }
    // Cached pack total (sum of bests across this pack) shown in the HUD. It only
    // changes on a new best or when scores are forgotten, so it's recomputed at
    // those points (see _refreshPackBest) — never per frame.
    this._refreshPackBest();

    this._computeLayout(); // sets this._layout + this._hudHeight for the build
    this._buildHud();
    this._wireInput();
    this._wireCollisions();
    this._setupCameras(); // creates cameras + ignore lists, then lays them out
    this._layoutHud(); // position/size every HUD element for the current screen
    // The Lab panel builds its objects lazily (like the menu/modal) so they land
    // after the UI camera's ignore snapshot. Restore a persisted-open panel here.
    if (labOpen()) this._labPanel.show();
    // Reflow on window resize / device rotation. The scale manager is
    // game-level, so remove the listener when the scene shuts down (restart).
    this.scale.on('resize', this._onResize, this);
    this.events.once('shutdown', () => this.scale.off('resize', this._onResize, this));

    // Web Audio only starts on a user gesture. The scene's own pointerdown unlocks
    // it, but HUD icons stopPropagation() (aborting that handler), so the first
    // click on one wouldn't unlock audio. A DOM-level listener sees every press
    // regardless of Phaser's propagation, so audio is ready by the time any sound
    // (e.g. a HUD tick) plays on the following pointerup.
    const canvas = this.game.canvas;
    const unlockAudio = () => sfx.unlock();
    canvas.addEventListener('pointerdown', unlockAudio);
    this.events.once('shutdown', () => canvas.removeEventListener('pointerdown', unlockAudio));
    // Safety net: re-layout next tick in case the final window size only settles
    // after create() (common on mobile when the scale manager reports late).
    this.time.delayedCall(0, () => this._onResize());
    this._refreshHud();
    diag.breadcrumb('game: create', currentLevelKey());
    // The starting conditions of the level, so any later trace can be read
    // against where things began (and which level settings were in force).
    diag.trace('play', 'level start', {
      level: currentLevelKey(),
      name: this.level.name,
      moves: this.movesLeft,
      arena: this.level.arena,
      pinEnabled: this.level.pinEnabled,
      pinResetOn: this.level.pinResetOn,
      ...this.brothers.snapshot(),
    });
    this._maybeShowIntro(); // first look at this level? show its intro (once)
  }

  /**
   * Decide the HUD metrics for the current window size, choosing 1, 2, or 3
   * rows so nothing collides:
   *  - wide   (wide enough that the edge text clears the centred icons; the
   *           threshold is computed from the text width, see _hudTextMetrics):
   *           1 row — turn text and Best/#Left at the edges, icons centred.
   *  - compact(narrower than that, but the two edge texts still fit side by side):
   *           2 rows — the info text on one line (turn left, Best/#Left right),
   *           icons below (kept at their normal size and packed tight — they must
   *           not grow on small screens).
   *  - narrow (narrower still — the two texts would overlap on one row): 3 rows —
   *           state text, then Best/#Left, then icons. This breakpoint, like the
   *           wide one, is computed from the measured text so nothing overlaps.
   * Stores `this._layout` and keeps `this._hudHeight` in sync (input guard, dev
   * panel, camera viewport). Re-run on every resize/rotation (see _onResize).
   *
   * @returns {void}
   */
  _computeLayout() {
    const H = Config.hud;
    const w = this.scale.width;
    const h = this.scale.height;
    const T = this._hudTextMetrics();
    // Wide (1 row): icons centred with the edge text on the same row — each side
    // needs pad + the widest text + a gap, clear of the icon cluster's half-width.
    const clusterHalf = ((5 - 1) / 2) * H.normalGap + H.normalIcon / 2; // 5 icons, wide spacing
    const wideMin = 2 * (H.pad + Math.max(T.wide.turn, T.wide.moves) + 16 + clusterHalf);
    // Compact (2 rows): the turn text (left) and Best/#Left (right) share the top
    // row, so they overlap unless both fit side by side with a gap between; below
    // that we drop to narrow (3 rows), one text per centred row. Measured at the
    // real compact font so the two lines can never collide.
    const compactMin = 2 * H.pad + T.small.turn + T.small.moves + 24; // 24 = min gap between them
    const mode = w >= wideMin ? 'wide' : w >= compactMin ? 'compact' : 'narrow';
    const rows = mode === 'wide' ? 1 : mode === 'narrow' ? 3 : 2;
    // Small screens stack text line(s) above the icon row: compact has one
    // (info on a single line), narrow has two (state, then Best/#Left). These
    // text rows use a tighter height than the icon row (text doesn't need the
    // icon's touch-target height), so they don't waste scarce vertical space.
    const textRows = mode === 'narrow' ? 2 : mode === 'compact' ? 1 : 0;
    const textRow = H.narrowTextRow;
    // The icon row keeps the normal (desktop) icon size on small screens — it must
    // not grow — and uses a tighter row height there so the icons sit close under
    // the text row instead of floating in a tall, touch-sized band.
    const iconRowHeight = mode === 'wide' ? H.rowHeight : H.compactRowHeight;
    const hudHeight = textRows * textRow + iconRowHeight;
    this._layout = {
      w,
      h,
      mode,
      rows,
      rowHeight: iconRowHeight,
      textRow,
      textRows,
      hudHeight,
      iconSize: H.normalIcon,
      gap: H.normalGap,
      pad: H.pad,
    };
    this._hudHeight = this._layout.hudHeight;
  }

  /**
   * Measure the two HUD edge texts — the longest turn prompt and the longest
   * Pack/Best/#Left line — at both font sizes the HUD uses (22px in wide mode,
   * 18px in compact/narrow), cached once. Drives both layout breakpoints in
   * {@link _computeLayout}: the wide one (text vs. the centred icons, 22px) and
   * the compact→narrow one (the two texts vs. each other on one row, 18px), so
   * neither can overlap whatever the font renders to.
   *
   * @returns {{wide:{turn:number, moves:number}, small:{turn:number, moves:number}}}
   */
  _hudTextMetrics() {
    if (!this._hudTextW) {
      const turnStr = "David's turn, can't do that"; // longest turn prompt
      const measure = (size) => {
        const probe = this.add.text(0, 0, '', { fontSize: size }).setVisible(false);
        probe.setText(turnStr);
        const turn = probe.width;
        // The right side is three separate stats with statGap between them; sum the
        // worst-case (two-digit) label widths plus the gaps so the breakpoints match
        // the real group width laid out by _layoutRightGroup.
        let moves = -Config.hud.statGap;
        for (const s of ['Pack: 00', 'Best: 00', '#Left: 00']) {
          probe.setText(s);
          moves += probe.width + Config.hud.statGap;
        }
        probe.destroy();
        return { turn, moves };
      };
      this._hudTextW = { wide: measure('22px'), small: measure('18px') };
    }
    return this._hudTextW;
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
    // Icons sit on a full-height row below any compact text rows (in wide mode
    // there are none, so the icons share the single row with the edge text).
    // Their tooltips are the shared service, positioned on reveal, not here.
    const iconRowY = L.textRows * L.textRow + rh / 2;
    const startX = cx - ((icons.length - 1) * L.gap) / 2;
    icons.forEach((ic, i) => {
      this.tweens.killTweensOf(ic); // drop any in-flight hover scale before re-sizing
      ic.setDisplaySize(L.iconSize, L.iconSize).setPosition(startX + i * L.gap, iconRowY);
      // Remember the layout-driven resting scale so the hover lift is relative to
      // it (and aspect-correct), not an absolute factor.
      ic.setData('baseSX', ic.scaleX);
      ic.setData('baseSY', ic.scaleY);
    });

    // Keep the attract glow on its target icon now that the icon has moved (the
    // ongoing pulse tween only animates scale/alpha, so position is ours to set).
    if (this._attractTarget) this.attractGlow.setPosition(this._attractTarget.x, this._attractTarget.y);

    // Info text. Wide/compact: turn left + Best/#Left right on row 0. Narrow:
    // state text centred on row 0, Best/#Left centred on row 1 (no collision).
    const fontSize = L.mode === 'wide' ? '22px' : '18px';
    this.turnText.setFontSize(fontSize);
    for (const s of [this.packText, this.bestText, this.leftText]) s.setFontSize(fontSize);
    if (L.mode === 'narrow') {
      // Two tight text rows: turn on row 0, the Pack/Best/#Left group on row 1.
      this.turnText.setOrigin(0.5, 0.5).setPosition(cx, L.textRow / 2);
    } else {
      // One row of edge text. Compact: its own tight row above the icons. Wide:
      // shares the single icon row (centred on it).
      const textY = L.mode === 'compact' ? L.textRow / 2 : rh / 2;
      this.turnText.setOrigin(0, 0.5).setPosition(L.pad, textY);
    }
    this._layoutRightGroup(); // position the Pack/Best/#Left stats + their tooltips

    // Banner + backing panel centred; sized/scaled to fit narrow screens.
    const panelW = Math.min(L.w - 2 * L.pad, 520);
    this.bannerPanel.setPosition(cx, L.h / 2).setSize(panelW, L.mode === 'wide' ? 110 : 90);
    this.banner.setPosition(cx, L.h / 2).setFontSize(L.mode === 'wide' ? '52px' : '34px');

    this._layoutDevPanel();
  }

  /**
   * Position the right-hand Pack/Best/#Left stats (and their tooltips) as one
   * group: right-aligned to the edge in wide/compact, centred on its own row in
   * narrow. Laid out right-to-left from each entry's current width, so it reflows
   * as the values change. Each tooltip is centred under its stat, just below the
   * HUD, and clamped to stay on-screen. Called from {@link _layoutHud} (resize)
   * and {@link _refreshHud} (value change).
   *
   * @returns {void}
   */
  _layoutRightGroup() {
    const L = this._layout;
    const gap = Config.hud.statGap; // spacing between the three stats
    const stats = [this.packText, this.bestText, this.leftText];
    const y =
      L.mode === 'narrow' ? L.textRow * 1.5 : L.mode === 'compact' ? L.textRow / 2 : L.rowHeight / 2;
    const total = stats.reduce((s, e) => s + e.width, 0) + gap * (stats.length - 1);
    // Right edge of the group: the HUD edge (wide/compact) or centred (narrow).
    // Each stat's tooltip is the shared service, positioned on reveal, not here.
    let x = L.mode === 'narrow' ? L.w / 2 + total / 2 : L.w - L.pad;
    for (let i = stats.length - 1; i >= 0; i--) {
      stats[i].setOrigin(1, 0.5).setPosition(x, y);
      x -= stats[i].width + gap;
    }
  }

  /**
   * Attach a HUD tooltip to `target` via the shared Tooltip service: anchored
   * centred below the ribbon (a shared baseline, evaluated live so it tracks the
   * 1/2/3-row layout across resizes), and dismissed on release — HUD icons are
   * click-to-act buttons, so a hint that lingers after the click reads as stale.
   * Wording is a string, or a function for labels that change with state.
   *
   * @param {Phaser.GameObjects.GameObject} target
   * @param {string | (() => string)} textOrFn
   * @returns {void}
   */
  _attachHudTip(target, textOrFn) {
    this.tip.attach(target, textOrFn, {
      place: 'anchor',
      anchorY: () => this._hudHeight + 6,
      hideOnUp: true,
      // No HUD tips while an overlay owns the screen (the HUD analog of
      // _infoAllowed). Matters for the menu button, which stays raised and
      // hoverable above the backdrop while the menu is open.
      clip: () => !this._modalOpen && !this._menuOpen,
    });
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
      this.packText,
      this.bestText,
      this.leftText,
      this.restartButton,
      this.attractGlow,
      this.prevButton,
      this.nextButton,
      this.statusIcon,
      this.menuButton,
      this.tip.box,
      this.bannerPanel,
      this.banner,
    ];
    // Split what exists now: the HUD to the UI camera, everything else (the world)
    // to the world camera. Objects created *later* assign themselves explicitly
    // (assignToUI / assignToWorld), so this snapshot only has to cover setup time.
    this.assignToUI(this.hudObjects);
    this.assignToWorld(this.children.list.filter((o) => !this.hudObjects.includes(o)));

    this._layoutCameras(true); // initial viewport/zoom (start fully zoomed out)
  }

  /**
   * Assign a display object (or array) to the fixed UI camera only — the world
   * camera ignores it, so it stays in screen space and never zooms/scrolls with
   * the arena. Use for HUD, overlays, tooltips: anything drawn in UI space.
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToUI(obj) {
    this.cameras.main.ignore(obj);
  }

  /**
   * Assign a display object (or array) to the world camera only — the UI camera
   * ignores it, so a world-space thing created after camera setup (e.g. an effect)
   * doesn't also draw on the fixed HUD camera. Shared world code calls this as
   * `scene.assignToWorld?.(obj)`, a no-op on scenes with no UI camera (the title).
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToWorld(obj) {
    // The UI camera doesn't exist yet while create() builds the World: entity
    // constructors (a Bomb's direction arrow, a glow ring) call this long before
    // _setupCameras runs. That's fine — _setupCameras snapshots everything alive
    // at that moment and assigns it to the world camera — so a missing camera
    // here means "nothing to do yet", not an error.
    this.uiCamera?.ignore(obj);
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
    // Were we fitted to the arena (at the min zoom)? Capture before recomputing.
    // If so, stay fitted across the resize — otherwise shrinking the window drops
    // the min zoom below the current one, so the arena would stay zoomed in and
    // off-centre. A deliberate zoom-in (zoom above min) is preserved.
    const wasFitted = main.zoom <= this._minZoom + 1e-3;
    this._minZoom = Math.min(
      main.width / (this.arena.width + 2 * M),
      main.height / (this.arena.height + 2 * M)
    );
    if (resetZoom || wasFitted || main.zoom < this._minZoom) main.setZoom(this._minZoom);
    this._clampCamera();
  }

  /**
   * Reflow everything to the new window size (window resize / device rotation).
   *
   * @returns {void}
   */
  _onResize() {
    // Guarded: this runs inside Phaser's resize step, so an unhandled throw here
    // kills the render loop (blank/frozen screen). Log it and carry on instead.
    try {
      this._computeLayout();
      this._layoutHud();
      this._layoutCameras(false);
      // An open menu / modal was sized for the old screen; reflow to the new one.
      // A resize or rotation fires a BURST of events, so we respond to the
      // first event (leading throttle),
      // then coalesence later events for a short period of time.
      // This is better for responsiveness than traditional debouncing and/or
      // waitng for things to settle, because
      // that can introduce a perceptable lack of responsiveness.
      // Menu rebuild takes some time, so we handle it specially.
      // The modal is cheap, so reflow it at once for responsiveness.
      if (this._menuOpen) this._scheduleMenuRebuild();
      // Modals are cheap: reflow each at once (rebuild preserves its scroll).
      for (const o of this._modalStack) o.rebuild();
    } catch (e) {
      diag.error('game resize', e);
    }
  }

  /**
   * Throttled menu rebuild: respond to the first resize immediately (leading
   * edge), then coalesce further events into at most one rebuild per ~30ms so a
   * burst (a device rotation, a window drag) stays responsive without thrashing.
   * A trailing tick after the last event captures the settled size.
   *
   * @returns {void}
   */
  _scheduleMenuRebuild() {
    this._menuRebuildPending = true;
    if (this._menuRebuildTimer) return; // already within a throttle window
    const tick = () => {
      if (!this._menuRebuildPending) {
        this._menuRebuildTimer = null; // burst ended
        return;
      }
      this._menuRebuildPending = false;
      if (this._menuOpen) this._menu.rebuild();
      this._menuRebuildTimer = this.time.delayedCall(30, tick);
    };
    tick(); // leading: rebuild now, then throttle
  }

  /**
   * Constrain the world camera in world space. We clamp by hand instead of with
   * Phaser's `setBounds` because, when the arena is smaller than the view (zoomed
   * out so gray shows), `setBounds` pins the arena to an edge rather than
   * centring it. Per axis: if the view is wider than the arena + both margins,
   * centre the arena; otherwise clamp scroll so the view stays within the arena
   * expanded by the margin (up to `M` of gray past any edge). Any zoom, any arena
   * size. Call after every pan/zoom (follow uses its own path during flight).
   *
   * @returns {void}
   */
  _clampCamera() {
    const main = this.cameras.main;
    const halfVW = main.width / 2;
    const halfVH = main.height / 2;
    const [midX, midY] = this._clampedCenter(
      main.scrollX + halfVW,
      main.scrollY + halfVH,
      main.zoom
    );
    main.setScroll(midX - halfVW, midY - halfVH);
  }

  /**
   * Clamp a desired world view-centre for a given zoom to the arena rules: if the
   * view is wider than the arena + both margins on an axis, centre the arena on
   * it; otherwise keep the view within the arena expanded by the margin. Shared
   * by {@link _clampCamera} and the settle reframe ({@link _frameBrothers}).
   *
   * @param {number} cx @param {number} cy @param {number} zoom
   * @returns {[number, number]} The clamped centre.
   */
  _clampedCenter(cx, cy, zoom) {
    const M = Config.zoom.edgeMargin;
    const aw = this.arena.width;
    const ah = this.arena.height;
    const halfSpanX = this.cameras.main.width / zoom / 2; // half the world width in view
    const halfSpanY = this.cameras.main.height / zoom / 2;
    return [
      halfSpanX * 2 >= aw + 2 * M ? aw / 2 : Phaser.Math.Clamp(cx, -M + halfSpanX, aw + M - halfSpanX),
      halfSpanY * 2 >= ah + 2 * M ? ah / 2 : Phaser.Math.Clamp(cy, -M + halfSpanY, ah + M - halfSpanY),
    ];
  }

  /**
   * Frame the settled pair: because Phaser follows only their midpoint (with a
   * deadzone), a ball can end up at/over the edge. Once the shot settles, gently
   * pan + zoom (Phaser's own camera tweens) to a view that fits the whole pair's
   * box — zooming out only as needed (never tighter, never past the fit-all
   * minimum) and centred on them within the arena clamp.
   *
   * @returns {void}
   */
  _frameBrothers() {
    const cam = this.cameras.main;
    const M = Config.zoom.edgeMargin;
    const a = this.brothers.david.go;
    const b = this.brothers.ken.go;
    // If both balls are already fully in view, leave the camera where it is — no
    // needless drift at rest. Only reframe when one ended up at/over the edge.
    const view = cam.worldView;
    const framed = (o) =>
      o.x - o.radius >= view.x &&
      o.x + o.radius <= view.right &&
      o.y - o.radius >= view.y &&
      o.y + o.radius <= view.bottom;
    if (framed(a) && framed(b)) return;

    const fit = Math.min(
      cam.width / (this.brothers.spanWidth + 2 * M),
      cam.height / (this.brothers.spanHeight + 2 * M)
    );
    const zoom = Phaser.Math.Clamp(Math.min(fit, cam.zoom), this._minZoom, Config.zoom.max);
    const [x, y] = this._clampedCenter(this.brothers.x, this.brothers.y, zoom);
    cam.zoomTo(zoom, 300, 'Sine.easeInOut');
    cam.pan(x, y, 300, 'Sine.easeInOut');
  }

  /** Cancel any in-progress settle pan/zoom tween so manual input takes over. */
  _stopCameraGlide() {
    this.cameras.main.panEffect.reset();
    this.cameras.main.zoomEffect.reset();
  }

  /**
   * Ease the zoom out while a shot is in flight so both balls stay in frame —
   * the one thing Phaser's follow can't do (it only pans to a point). Uses the
   * pair's combined span (see Brothers.spanWidth/Height); only ever zooms *out*,
   * never past the fit-everything minimum, and gently so it never jostles.
   *
   * @returns {void}
   */
  _keepBallsInView() {
    if (this._isPanning || this._pinchDist) return; // a manual gesture owns the camera
    const cam = this.cameras.main;
    const M = Config.zoom.edgeMargin;
    const a = this.brothers.david.go;
    const b = this.brothers.ken.go;
    // Axis-aligned box enclosing both balls (radii included).
    const left = Math.min(a.x - a.radius, b.x - b.radius);
    const right = Math.max(a.x + a.radius, b.x + b.radius);
    const top = Math.min(a.y - a.radius, b.y - b.radius);
    const bottom = Math.max(a.y + a.radius, b.y + b.radius);

    // Zoom out (eased) only if the box no longer fits the view.
    let view = cam.worldView;
    if (right - left > view.width || bottom - top > view.height) {
      const fit = Math.min(cam.width / (right - left + 2 * M), cam.height / (bottom - top + 2 * M));
      cam.setZoom(Phaser.Math.Linear(cam.zoom, Math.max(fit, this._minZoom), 0.08));
      view = cam.worldView; // zoom changed the visible area
    }

    // Pan (eased) only when the box crosses a view edge — so a view that already
    // shows both balls (e.g. fully zoomed out) never drifts.
    let dx = 0;
    if (left < view.x) dx = left - view.x;
    else if (right > view.right) dx = right - view.right;
    let dy = 0;
    if (top < view.y) dy = top - view.y;
    else if (bottom > view.bottom) dy = bottom - view.bottom;
    if (dx || dy) cam.setScroll(cam.scrollX + dx * 0.12, cam.scrollY + dy * 0.12);

    this._clampCamera();
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
   * On-screen text: turns remaining, whose turn, the restart button, and the
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

    this.turnText = this.add.text(20, 18, '', { fontSize: '22px' }).setDepth(10).setInteractive();
    // A general explanation of the left-hand entry, revealed on hover/press. Kept
    // deliberately state-agnostic ("play state" covers non-turn conditions like
    // game over).
    this._attachHudTip(this.turnText, 'Active brother and current play state');
    this.turnText.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    // Right-hand stats — Pack / Best / #Left — each its own interactive text with
    // a hover/press tooltip (see _buildHudStat), laid out as a right-aligned group
    // by _layoutRightGroup and filled with values in _refreshHud. The pack name is
    // fixed for the scene (switching packs restarts it), so it's baked in here.
    this.packText = this._buildHudStat(`Total best results of current pack (${activePackName()})`);
    this.bestText = this._buildHudStat(
      'Best result on this level: the most turns ever left when you won'
    );
    this.leftText = this._buildHudStat('Turns left in the current game');

    // Restart button: the clockwise-arrow icon, vertically centred in the
    // ribbon. Clicking opens a confirmation modal (see _showConfirm).
    this.restartButton = this.add
      .image(Config.view.width / 2, h / 2, 'icon-restart')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });

    // The floating name label for hovered/pressed arena entities is the shared
    // Tooltip service (this.tip); Entity._enableInfo attaches to it. This flag
    // suppresses it while dragging the launcher/pin, to keep the aim uncluttered
    // and the launcher's face visible (read by the entity attach's clip).
    this._infoSuppressed = false;

    // The tooltip always reveals on hover/press (even when reset is disabled);
    // brightening and the actual restart only apply when reset is enabled. The
    // label names the current pack + level, computed fresh on each reveal since
    // both can change as the player navigates.
    this._attachHudTip(
      this.restartButton,
      () => `Restart Level (${activePackName()} Level ${currentIndex() + 1})`
    );
    this.restartButton.on('pointerover', () => {
      if (this._resetEnabled()) this._iconLift(this.restartButton);
    });
    this.restartButton.on('pointerout', () => {
      this._iconRest(this.restartButton, this._resetEnabled() ? 0.8 : 0.3, true);
    });
    this.restartButton.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    this.restartButton.on('pointerup', () => {
      if (!this._resetEnabled()) return; // not lit: nothing to reset, no sound
      sfx.tick();
      // After the level is over there's nothing else to do, so skip the
      // confirmation and just restart; mid-play, confirm first.
      if (this.status === 'ENDED') this.scene.restart();
      else this._showConfirm('Restart Level?', () => this.scene.restart());
    });

    // Previous / next level icons flanking reset. Enabled state depends on
    // position in the pack and whether the current level has been won (see
    // _navEnabled); tooltips reveal on hover/press regardless.
    const gap = 44;
    this.prevButton = this._buildNavIcon('prev', Config.view.width / 2 - gap, 'icon-prev', 'Previous level');
    this.nextButton = this._buildNavIcon('next', Config.view.width / 2 + gap, 'icon-next', 'Next level');

    // Read-only lifecycle indicator, right of "next". Its glyph/colour reflect
    // `status` (see _refreshStatusIcon); hover/press reveals the label. It's
    // interactive only for the tooltip — NO hand cursor, so it reads as a
    // status light rather than a button.
    this.statusIcon = this.add
      .image(Config.view.width / 2 + 2 * gap, h / 2, 'icon-ready')
      .setDepth(10)
      .setInteractive();
    // The label reflects `status`; _refreshStatusIcon keeps it current and the
    // tooltip reads it fresh on each reveal.
    this._statusLabel = '';
    this._attachHudTip(this.statusIcon, () => this._statusLabel);
    this.statusIcon.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router

    // Menu button (hamburger): opens the dropdown of less-used options and the
    // pack/level scoreboard. Laid out at the FRONT of the cluster in _layoutHud.
    // Actionable, so it gets a hand cursor.
    this.menuButton = this.add
      .image(Config.view.width / 2 - 2 * gap, h / 2, 'icon-menu')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });
    this._attachHudTip(this.menuButton, 'Open main menu');
    this.menuButton.on('pointerover', () => this._iconLift(this.menuButton));
    this.menuButton.on('pointerout', () => this._iconRest(this.menuButton, 0.8, true));
    this.menuButton.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    this.menuButton.on('pointerup', () => {
      this._toggleMenu(); // open, or close if already showing (button is raised above the backdrop)
    });

    this._buildDevPanel();

    // The menu/scoreboard overlay. Its objects are built lazily on show() (after
    // the UI camera's ignore snapshot); the scene supplies the view content and
    // navigation via these callbacks.
    this._menu = new Menu(this, {
      render: () => this._renderMenuView(),
      onBack: () => this._menuBack(),
      onLayout: () => this._raiseMenuButton(),
    });
    this._menu.onHidden = () => this._onMenuHidden();

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
      .text(Config.view.width / 2, Config.view.height / 2, '', Config.ui.type.banner)
      .setOrigin(0.5)
      .setDepth(10)
      .setShadow(2, 3, '#000000', 6, true, true)
      .setVisible(false);
  }

  /**
   * Build a right-hand HUD stat: an interactive (right-aligned) text with a HUD
   * tooltip revealed on hover or press — mirroring the icon tooltips so the two
   * read the same. The value string and positions are set later (see
   * {@link _refreshHud} / {@link _layoutRightGroup}).
   *
   * @param {string} tooltipText  The explanation shown on hover/press.
   * @returns {Phaser.GameObjects.Text}  the stat text
   */
  _buildHudStat(tooltipText) {
    const stat = this.add
      .text(0, 0, '', Config.ui.type.stat)
      .setOrigin(1, 0.5)
      .setDepth(10)
      .setInteractive();
    this._attachHudTip(stat, tooltipText);
    stat.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    return stat;
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
   * @returns {Phaser.GameObjects.Image}
   */
  _buildNavIcon(dir, x, key, tooltipText) {
    const icon = this.add
      .image(x, this._hudHeight / 2, key)
      .setDepth(10)
      .setInteractive({ useHandCursor: true });
    // Name the target level on reveal (it changes as the player navigates), or
    // "(None)" when there's no such level in this direction.
    this._attachHudTip(icon, () => tooltipText + this._navTargetSuffix(dir));
    icon.on('pointerover', () => {
      if (this._navEnabled(dir)) this._iconLift(icon);
    });
    icon.on('pointerout', () => this._iconRest(icon, this._navEnabled(dir) ? 0.8 : 0.3, true));
    icon.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    icon.on('pointerup', () => this._navClicked(dir));
    return icon;
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
   * (best is non-nil) — you must complete a level to proceed. Test mode lifts
   * the win requirement, so next is usable whenever a later level exists.
   *
   * @param {'prev'|'next'} dir
   * @returns {boolean}
   */
  _navEnabled(dir) {
    if (dir === 'prev') return currentIndex() > 0;
    const hasNext = currentIndex() < levelCount() - 1;
    const wonCurrent = this.registry.get(this._bestKey) != null;
    return hasNext && (wonCurrent || this._testMode);
  }

  /** Dim (gray) the prev/next icons that aren't currently usable. */
  _refreshNavButtons() {
    this._iconRest(this.prevButton, this._navEnabled('prev') ? 0.8 : 0.3, false);
    this._iconRest(this.nextButton, this._navEnabled('next') ? 0.8 : 0.3, false);
  }

  /**
   * Hover-in feedback for a HUD icon: fade to full alpha and lift its scale a
   * touch (`motion.hoverScale`) over the shared motion. The scale channel makes
   * the focused state read clearly — alpha alone (0.8→1) is near its ceiling and
   * too subtle. Relative to the icon's layout-driven resting scale (see layout).
   *
   * @param {Phaser.GameObjects.GameObject} icon @returns {void}
   */
  _iconLift(icon) {
    this.tweens.killTweensOf(icon);
    const f = Config.ui.motion.hoverScale;
    this.tweens.add({
      targets: icon,
      alpha: 1,
      scaleX: (icon.getData('baseSX') ?? icon.scaleX) * f,
      scaleY: (icon.getData('baseSY') ?? icon.scaleY) * f,
      duration: Config.ui.motion.dur,
      ease: Config.ui.motion.ease,
    });
  }

  /**
   * Return a HUD icon to its resting look: `alpha` (0.8 lit / 0.3 dimmed) at the
   * base scale, cancelling any in-flight tween first. `animate` eases it (a
   * hover-out); otherwise it snaps — a state change shouldn't slide.
   *
   * @param {Phaser.GameObjects.GameObject} icon @param {number} alpha
   * @param {boolean} animate @returns {void}
   */
  _iconRest(icon, alpha, animate) {
    this.tweens.killTweensOf(icon);
    const sx = icon.getData('baseSX') ?? icon.scaleX;
    const sy = icon.getData('baseSY') ?? icon.scaleY;
    if (animate) {
      this.tweens.add({
        targets: icon,
        alpha,
        scaleX: sx,
        scaleY: sy,
        duration: Config.ui.motion.dur,
        ease: Config.ui.motion.ease,
      });
    } else {
      icon.setAlpha(alpha).setScale(sx, sy);
    }
  }

  /**
   * Handle a click on a nav icon: no-op if disabled; if a game is in progress
   * (PLAYING) confirm before leaving; otherwise switch level immediately.
   *
   * @param {'prev'|'next'} dir
   * @returns {void}
   */
  _navClicked(dir) {
    if (!this._navEnabled(dir)) return; // not lit: no action, no sound
    sfx.tick();
    const target = currentIndex() + (dir === 'prev' ? -1 : 1);
    if (this.status === 'PLAYING') {
      this._showConfirm('Abandon current game?', () => this._goToLevel(target));
    } else {
      this._goToLevel(target);
    }
  }

  /**
   * Switch to another level in the pack and rebuild the scene for it. Loads the
   * target level first (levels are fetched lazily) so create() has it ready.
   *
   * @param {number} index
   * @returns {Promise<void>}
   */
  async _goToLevel(index) {
    await selectLevel(index);
    this.scene.restart();
  }

  /**
   * Keep the Lab panel fitted to the (possibly resized) screen by rebuilding it
   * in place: re-anchors it below the ribbon and re-fits its scroll viewport to
   * the new height. No-op when closed. Runs on every resize (via {@link _layoutHud}).
   *
   * @returns {void}
   */
  _layoutDevPanel() {
    this._labPanel?.rebuild();
  }

  /**
   * Create the modeless Lab tuning {@link Panel}: rows of -/+ steppers for the
   * slingshot and tether parameters, edited live. Mutating these Config values
   * takes effect immediately — the slingshot reads Config per shot, and the tether
   * is re-synced from Config each frame (see Brothers._applyPullOnlyTether). Values
   * persist across restarts (Config is a module object) but reset on a full page
   * reload, which is the point: find good numbers, then bake them in.
   *
   * Only the Panel object is made here (during _buildHud); its display objects are
   * built lazily on show() so they land after the UI camera's ignore snapshot.
   *
   * @returns {void}
   */
  _buildDevPanel() {
    // Rows come in two kinds. A *number* row steps by `step` (clamped to
    // min/max) and its value can be typed directly. An *options* row cycles a
    // fixed list, so a boolean is just the list [false, true].
    //
    // `obj` is either the object holding `key`, or a function returning it, for
    // targets that don't exist yet or are replaced on every scene restart (the
    // brothers) — the row re-resolves it on each read and shows "--" when it's
    // missing. `onChange` applies a value that isn't picked up automatically.
    this._devSections = [
      {
        heading: 'Slingshot & tether',
        params: [
          { obj: Config.slingshot, key: 'maxSpeed', step: 10, dp: 0, min: 0, desc: 'Launch speed at a full-strength pull.' },
          { obj: Config.slingshot, key: 'minSpeed', step: 5, dp: 0, min: 0, desc: 'Launch-speed floor for the shortest valid pull.' },
          { obj: Config.slingshot, key: 'curve', step: 0.1, dp: 2, min: 0.1, desc: 'Easing exponent; higher softens short/mid pulls (ends fixed).' },
          { obj: Config.slingshot, key: 'maxPull', step: 10, dp: 0, min: 10, desc: 'Furthest the launcher can be stretched from the anchor.' },
          { obj: Config.slingshot, key: 'minPull', step: 2, dp: 0, min: 0, desc: 'Pulls shorter than this count as a mis-click, not a launch.' },
          { obj: Config.tether, key: 'restLength', step: 5, dp: 0, min: 0, desc: 'Tether resting length; beyond it the band pulls them together.' },
          { obj: Config.tether, key: 'stiffness', step: 0.005, dp: 3, min: 0, desc: 'Tether spring strength once stretched past rest length.' },
          { obj: Config.tether, key: 'damping', step: 0.02, dp: 2, min: 0, desc: 'How quickly tether oscillations settle.' },
        ],
      },
      {
        heading: 'Brothers',
        params: [
          { obj: Config.ball, key: 'davidRadiusMult', label: 'David size', step: 0.01, dp: 2, min: 1, max: 2, desc: "David's radius as a multiple of Ken's (1.00-2.00)." },
          { obj: Config.ball, key: 'davidMassMult', label: 'David mass', step: 0.01, dp: 2, min: 1, max: 3, desc: "David's mass as a multiple of Ken's (1.00-3.00)." },
          this._mudTurnsParam('David', () => this.brothers?.david),
          this._mudTurnsParam('Ken', () => this.brothers?.ken),
        ],
      },
      {
        heading: 'Level',
        params: [
          {
            obj: () => this.level,
            key: 'pinEnabled',
            label: 'Pin moving',
            options: [false, true],
            format: (v) => (v ? 'allowed' : 'off'),
            desc: 'Whether the player may drag the anchor\'s aiming pin off-centre.',
            // Turning it off mid-aim would strand an already-placed pin off-centre.
            onChange: (level) => {
              if (!level.pinEnabled) this.brothers?._resetAnchorPin();
            },
          },
          {
            obj: () => this.level,
            key: 'pinResetOn',
            label: 'Pin resets on',
            options: ['impact', 'settle'],
            format: (v) => v,
            desc: 'When a placed pin recentres: at impact (aim-only) or once the balls settle (live off-centre tether).',
          },
        ],
      },
    ];
    this._labPanel = new Panel(this, {
      position: () => ({ x: 12, y: this._hudHeight + 10 }),
      width: 280, // roomy enough that a param's tooltip wraps to ~2 tidy lines
      title: 'Lab tuning',
      build: (view) => this._buildLabBody(view),
    });
    // Closing (via the × or the menu toggle) clears the persisted-open flag.
    this._labPanel.onHidden = () => setLabOpen(false);
  }

  /**
   * Build the "turns left being muddy" row for one brother. The brother is
   * resolved lazily because a scene restart replaces the entity, and the panel
   * outlives it. Writes go through {@link Movable#setMudTurns}, which keeps the
   * splat and the friction consistent with the number.
   *
   * @param {string} name  'David' or 'Ken', for the row label.
   * @param {() => (import('../world/Brother.js').Brother|undefined)} get
   * @returns {object} A param descriptor.
   */
  _mudTurnsParam(name, get) {
    return {
      obj: get,
      key: 'mudTurnsLeft',
      label: `${name} mud turns`,
      step: 1,
      dp: 0,
      min: 0,
      max: 9,
      desc: `Settles of mud left on ${name}. Raise it to muddy him now; drop it to 0 to wash the (non-sticky) mud off.`,
      onChange: (b) => b.setMudTurns(b.mudTurnsLeft),
    };
  }

  /**
   * Resolve a param's target object. Rows bound to a function (the brothers,
   * the level) re-resolve on every read, so they survive a scene restart; the
   * target can legitimately be absent before the world is built.
   *
   * @param {{obj: object|(() => object|undefined)}} param
   * @returns {object|undefined}
   */
  _paramTarget(param) {
    return typeof param.obj === 'function' ? param.obj() : param.obj;
  }

  /**
   * Fill the Lab panel's scroll body (local coords: 0,0 = viewport top-left) with
   * a heading per section, its parameter rows, and the More turns / Reset buttons.
   * Called by the {@link Panel} on each (re)build; returns the body's full height.
   *
   * @param {import('../ui/ScrollView.js').ScrollView} view
   * @returns {number}
   */
  _buildLabBody(view) {
    const w = 280;
    const rowH = 30;
    const headingH = 26;
    // A control ignores its tap when the press that ended on it moved far enough
    // to be a scroll-drag (computed from the press/release distance).
    const moved = (p) => this._labPanel.movedFromPress(p);

    this._devRows = [];
    let y = 14; // half a line of headroom, so the first heading isn't clipped
    for (const section of this._devSections) {
      const heading = this.add
        .text(12, y, section.heading, { ...Config.ui.type.small, color: Config.ui.color.accentText })
        .setOrigin(0, 0.5)
        .setDepth(21);
      view.add([heading]);
      y += headingH;

      for (const param of section.params) {
        const minus = chipButton(this, 24, y, '-', () => this._adjustParam(param, -1), { guard: moved });
        const plus = chipButton(this, w - 24, y, '+', () => this._adjustParam(param, 1), { guard: moved });
        // Click the value to type one directly (number rows) or advance it
        // (options rows) — prompt works on desktop + mobile.
        const value = this.add
          .text(44, y, '', Config.ui.type.small)
          .setOrigin(0, 0.5)
          .setDepth(21);
        const row = { param, value };
        this._setDevRowText(row); // set text before setInteractive so the hit area fits
        value.setInteractive({ useHandCursor: true }).on('pointerup', (pointer) => {
          if (moved(pointer)) return; // release ended a scroll-drag, not a tap
          this._promptParam(param);
        });
        // Explain the parameter on hover/press of any of its controls, via the
        // shared tooltip (anchored below the control, wrapped to ~the panel width).
        for (const ctrl of [minus, value, plus]) {
          this.tip.attach(ctrl, param.desc, { place: 'anchor', maxWidth: w - 20 });
        }
        view.add([minus, value, plus]);
        this._devRows.push(row);
        y += rowH;
      }
    }

    const moreTurnsY = y + 20; // a small gap below the last row
    const resetY = moreTurnsY + 36;
    // "More turns" lets us keep experimenting past a win/loss (see _moreTurns).
    view.add([
      chipButton(this, w / 2, moreTurnsY, 'More turns', () => this._moreTurns(), { guard: moved }),
      chipButton(this, w / 2, resetY, 'Reset parameters', () => this._resetParams(), { guard: moved }),
    ]);

    return resetY + 26; // full height of the scrollable body
  }

  /**
   * Refresh the Lab rows from live state. Rows showing values the *game* moves
   * (a brother's mud turns count down at each settle) would otherwise go stale
   * while the panel sits open, so this runs with the HUD. No-op when closed.
   *
   * @returns {void}
   */
  _refreshLabRows() {
    if (!this._labPanel?.open) return;
    this._devRows?.forEach((r) => this._setDevRowText(r));
  }

  /**
   * Handle a click on a row's value. A number row prompts for a value directly
   * (clamped to its min/max); window.prompt works on desktop and mobile without
   * a DOM input. An options row has nothing to type, so a click just advances it,
   * matching its "+".
   *
   * @param {object} param  A descriptor from {@link _buildDevPanel}.
   * @returns {void}
   */
  _promptParam(param) {
    if (param.options) {
      this._adjustParam(param, 1);
      return;
    }
    const obj = this._paramTarget(param);
    if (!obj) return; // e.g. a brother row before the world exists
    const label = param.label ?? param.key;
    const input = window.prompt(`Set ${label}`, String(obj[param.key]));
    if (input === null) return; // cancelled
    const v = parseFloat(input);
    if (!Number.isFinite(v)) return; // not a number
    obj[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min, v));
    this._applyParam(param, obj);
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
   * Dev helper ("More turns"): grant 6 extra turns so tuning can continue. If
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
      this.world.notifyPlayStart(); // re-arm bombs frozen by the level end
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
   * Update one dev row's "label: value" text from the live value. A row whose
   * target doesn't exist yet (no brothers before the world is built) shows "--"
   * rather than blanking or throwing.
   *
   * @param {{param: object, value: Phaser.GameObjects.Text}} row
   * @returns {void}
   */
  _setDevRowText(row) {
    const { param } = row;
    const label = param.label ?? param.key;
    const obj = this._paramTarget(param);
    if (!obj) {
      row.value.setText(`${label}: --`);
      return;
    }
    const v = obj[param.key];
    row.value.setText(`${label}: ${param.format ? param.format(v) : v.toFixed(param.dp)}`);
  }

  /**
   * Change a parameter by one step: a number row moves by ±`step` (clamped to
   * its min and optional max), an options row advances to the next/previous
   * entry, wrapping. Then apply and refresh.
   *
   * @param {object} param  A descriptor from {@link _buildDevPanel}.
   * @param {number} dir  -1 or +1.
   * @returns {void}
   */
  _adjustParam(param, dir) {
    const obj = this._paramTarget(param);
    if (!obj) return; // e.g. a brother row before the world exists

    if (param.options) {
      const opts = param.options;
      const at = opts.indexOf(obj[param.key]);
      // An unrecognised current value (hand-edited level prop) lands on the first.
      obj[param.key] = at < 0 ? opts[0] : opts[(at + dir + opts.length) % opts.length];
    } else {
      const raw = obj[param.key] + dir * param.step;
      obj[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min, Number(raw.toFixed(param.dp))));
    }
    this._applyParam(param, obj);
  }

  /**
   * Push a just-edited value into the game and refresh every row (one edit can
   * change another row's display — setting mud turns to 0 washes the mud off).
   *
   * @param {object} param @param {object} obj  The resolved target.
   * @returns {void}
   */
  _applyParam(param, obj) {
    // A Lab edit reaches straight into live game state, so it's a prime suspect
    // whenever something goes strange right afterwards. Record the whole world
    // on both sides of the write: the "after" of one edit and the "before" of
    // the next also bracket whatever the *game* did in between.
    const key = param.label ?? param.key;
    const snap = (tag) =>
      diag.trace('lab', `${tag} ${key}`, {
        value: obj[param.key],
        phase: this.phase,
        status: this.status,
        ...(this.brothers ? this.brothers.snapshot() : {}),
      });

    snap('before');
    param.onChange?.(obj);
    this._devRows.forEach((r) => this._setDevRowText(r));
    this.brothers?._applyDavidPhysique(); // apply if this was a David size/mass row
    snap('after');
  }

  /**
   * Show/hide the Lab panel (toggled by the Lab control in the menu, or its own ×).
   * The persisted-open flag is set here on open and cleared by the panel's
   * `onHidden` on close (see _buildDevPanel), so the × path clears it too.
   *
   * @returns {void}
   */
  _toggleDevPanel() {
    if (this._labPanel.open) {
      this._labPanel.hide();
    } else {
      this._labPanel.show();
      setLabOpen(true); // survive scene restarts and reloads
    }
  }

  /**
   * Reset only makes sense once the level has progressed past READY (i.e. it's
   * PLAYING or ENDED). A pristine, not-yet-started level can't be usefully reset
   * — even in test mode, restarting an unstarted game is meaningless.
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
    this._iconRest(this.restartButton, this._resetEnabled() ? 0.8 : 0.3, false);
  }

  /**
   * Update the read-only lifecycle indicator (glyph, colour, tooltip) to match
   * `this.status`. Called wherever the status can change.
   *
   * @returns {void}
   */
  _refreshStatusIcon() {
    const byStatus = {
      READY: { key: 'icon-ready', tint: 0xd6b25e, label: 'Ready: not started' },
      PLAYING: { key: 'icon-playing', tint: 0x7cfc8a, label: 'Playing: in progress' },
      ENDED: { key: 'icon-ended', tint: 0x9aa0a6, label: 'Ended: level finished' },
    };
    const s = byStatus[this.status];
    this.statusIcon.setTexture(s.key).setTint(s.tint);
    this._statusLabel = s.label;
  }

  // --- Overlays (modals, menu, panels) ------------------------------------

  /** @returns {boolean} true while a blocking confirm/message modal is up. The
   *  menu is modal too but tracked on its own (see _menuOpen), so this stays "a
   *  confirm is up" — the meaning the game-input guards below rely on. */
  get _modalOpen() {
    return this._modalStack.length > 0;
  }

  /** @returns {import('../ui/Overlay.js').Overlay|null} the input-owning modal (top of stack). */
  get _activeModal() {
    return this._modalStack.length ? this._modalStack[this._modalStack.length - 1] : null;
  }

  /** @returns {boolean} true while the menu overlay is open. */
  get _menuOpen() {
    return !!this._menu && this._menu.open;
  }

  /**
   * Overlay router hook: an overlay just opened. Any open cancels a camera pan.
   * A modal joins the input-owning stack (and clears any menu scroll-drag left by
   * the press that opened it from a menu row); a modeless panel joins `_panels`;
   * the menu is tracked on its own (`this._menu`), so it needs no list.
   *
   * @param {import('../ui/Overlay.js').Overlay} o @returns {void}
   */
  _overlayOpened(o) {
    this._isPanning = false;
    if (o.role === 'modal') {
      this._modalStack.push(o);
      this._menu?.scrollView?.endDrag(); // opened from a menu row: drop its drag
    } else if (o.role === 'panel') {
      this._panels.push(o);
    }
    // A modal overlay (a confirm or the menu) now owns the screen — clear any
    // HUD/arena tooltip so it can't linger over it. The modeless Lab panel
    // (modal: false) coexists with the game, so it must NOT hide tooltips.
    if (o.modal) this.tip.hide();
  }

  /**
   * Overlay router hook: an overlay closed. Remove it from whichever list holds it
   * (the menu is tracked on its own, so nothing to do there).
   *
   * @param {import('../ui/Overlay.js').Overlay} o @returns {void}
   */
  _overlayClosed(o) {
    const list = o.role === 'modal' ? this._modalStack : o.role === 'panel' ? this._panels : null;
    if (!list) return;
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * A Yes/No confirmation (see {@link Modal.confirm}): `Yes` runs `onYes`, `No`
   * dismisses; both close the modal first.
   *
   * @param {string} message @param {() => void} onYes @returns {void}
   */
  _showConfirm(message, onYes) {
    Modal.confirm(this, message, onYes);
  }

  /**
   * An informational modal (see {@link Modal.info}) with word-wrapped body and a
   * single "OK" that dismisses, then runs the optional `onOk`.
   *
   * @param {string} title @param {string} body @param {() => void} [onOk]
   * @returns {void}
   */
  _showMessage(title, body, onOk) {
    Modal.info(this, title, body, onOk);
  }

  /**
   * Modal/heading title for the current level: always the pack + level number,
   * plus the level's name if it has one (e.g. "Base Level 3 — The Gauntlet").
   *
   * @returns {string}
   */
  _levelTitle() {
    const base = `${activePackName()} Level ${currentIndex() + 1}`;
    const name = levelName(this.level);
    return name ? `${base} — ${name}` : base;
  }

  /**
   * On first arrival at a level, show its intro (if it has one and the player
   * hasn't OK'd it yet). Called at the end of {@link create}, so it also skips on
   * a restart (the flag persists). @returns {void}
   */
  _maybeShowIntro() {
    if (levelIntro(this.level) && !introSeen(currentLevelKey())) this._showLevelIntro();
  }

  /**
   * Show the current level's intro in an info modal; OK marks it seen (only then,
   * so quitting mid-intro re-shows it next time). Used both on first arrival and
   * from the menu's "See level intro". @returns {void}
   */
  _showLevelIntro() {
    const key = currentLevelKey();
    this._showMessage(this._levelTitle(), levelIntro(this.level), () => markIntroSeen(key));
  }

  /**
   * The in-game "Report a problem" dialog: the diagnostics report in a modal
   * consistent with the rest of the UI — the (scrollable) report text, a primary
   * Copy, and OK. Copy uses the clipboard; if that's blocked (e.g. a non-secure
   * context) it falls back to diag's DOM view, whose textarea can be selected and
   * copied by hand.
   *
   * Crash resistance: diag's DOM report (the error banner, `#diag`, the copy
   * fallback) stays the primary, Phaser-independent path — it works when the
   * scene is broken. This modal is only for the healthy in-game path, and if even
   * building it throws we drop to that DOM view.
   *
   * @returns {void}
   */
  _showReport() {
    try {
      const m = new Modal(this, {
        title: 'Problem report',
        subtitle: 'Copy report to clipboard and report',
        body: diag.report(),
        nowrap: true, // a log: left-aligned, scrolls horizontally for long lines
        warn: false,
        buttons: [
          {
            label: 'Copy',
            bg: '#2e7d46',
            onClick: async (btn) => {
              const ok = await diag.copyReport();
              if (!ok) {
                m.hide(); // clipboard blocked: the DOM view lets them select + copy by hand
                diag.showReport();
              } else if (m.open) {
                btn.setText('Copied');
              }
            },
          },
          { label: 'OK', bg: '#3a3a44', onClick: () => m.hide() },
        ],
      });
      m.show();
    } catch (e) {
      // Log (into the very report we're about to show) without firing another
      // banner over it, then fall back to the crash-proof DOM view.
      diag.breadcrumb('report modal failed', e);
      diag.showReport();
    }
  }

  // --- Menu / scoreboard --------------------------------------------------

  /**
   * Toggle the menu from the menu button: open if closed, close if showing.
   *
   * @returns {void}
   */
  _toggleMenu() {
    if (this._activeModal) return; // a confirm is up; let it resolve first
    sfx.tick(); // opening or closing the menu always succeeds
    if (this._menu.open) this._closeMenu();
    else this._openMenu();
  }

  /**
   * Open the menu overlay (no-op if a confirm or the menu is up). Content and
   * navigation come from _renderMenuView (the Menu's `render` callback); the
   * hamburger is restacked against the card by _raiseMenuButton (its `onLayout`).
   *
   * @returns {void}
   */
  _openMenu() {
    if (this._menu.open || this._activeModal) return;
    this._menuView = 'main'; // a fresh open always lands on the main menu
    this._menu.show();
  }

  /** Close the menu overlay (its onHidden restores the hamburger). */
  _closeMenu() {
    this._menu.hide();
  }

  /**
   * Menu `onHidden` hook: restore the hamburger's normal HUD depth/look and cancel
   * any pending throttled rebuild. Runs however the menu closes (× or hamburger).
   *
   * @returns {void}
   */
  _onMenuHidden() {
    this.menuButton.setDepth(10);
    this._iconRest(this.menuButton, 0.8, false);
    this._menuRebuildPending = false;
    if (this._menuRebuildTimer) {
      this._menuRebuildTimer.remove();
      this._menuRebuildTimer = null;
    }
  }

  /**
   * Decide how the hamburger stacks against the open menu card. When the card
   * doesn't reach the button (roomy screens), raise it above the backdrop so a
   * second tap closes the menu (see _toggleMenu). When the card overlaps it (a
   * short screen, where the card nearly fills the height), leave it at its normal
   * HUD depth so the card covers it cleanly instead of the lit icon bleeding on
   * top — closing is via the card's × there. Runs after each menu (re)build (the
   * Menu's `onLayout`), so it tracks resizes/rotations. Restored by _onMenuHidden.
   *
   * @returns {void}
   */
  _raiseMenuButton() {
    const c = this._menu.card;
    const b = this.menuButton.getBounds();
    const covered = Phaser.Geom.Intersects.RectangleToRectangle(
      b,
      new Phaser.Geom.Rectangle(c.x, c.y, c.w, c.h)
    );
    if (covered) {
      // Under the card now: normal depth, and clear any hover state so it can't
      // light up or flash its tooltip through the menu.
      this.menuButton.setDepth(10);
      this._iconRest(this.menuButton, 0.8, false);
      this.tip.hide();
    } else {
      this.menuButton.setDepth(33); // above the depth-30 backdrop so it stays clickable
    }
  }

  /**
   * Re-render the current menu view on the NEXT tick (not inside the current
   * pointer event, which would destroy the row being tapped). Used by the dev
   * toggles and after forgetting scores.
   *
   * @returns {void}
   */
  _rerenderMenu() {
    this.time.delayedCall(0, () => {
      if (this._menu.open) this._renderMenuView();
    });
  }

  /**
   * The Back button's destination, which depends on the current view: Packs
   * Available goes to the main menu; Pack details goes back to whichever view
   * opened it (main menu or Packs Available).
   *
   * @returns {void}
   */
  _menuBack() {
    if (this._menuView === 'detail' && this._detailFrom === 'packs') this._showPacksAvailable();
    else this._showMainMenu();
  }

  /**
   * (Re)draw the current menu view into the menu body. Passed to the {@link Menu}
   * as its `render` callback, so it runs on open, on navigation, and on a resize
   * rebuild (which the Menu makes scroll-preserving).
   *
   * @returns {void}
   */
  _renderMenuView() {
    if (this._menuView === 'detail') this._showPackDetail(this._menuDetail, this._detailFrom);
    else if (this._menuView === 'packs') this._showPacksAvailable();
    else this._showMainMenu();
  }

  /**
   * The main menu view: dev toggles (Lab/Test), Help & About, the current pack's
   * info + Details, and the "All packs" list. Only the current pack's level count
   * is known here (from boot); other packs show just name + total score from
   * local storage (no probing), deferring their level count to Pack details.
   *
   * @returns {void}
   */
  _showMainMenu() {
    if (!this._menu.open) return; // may be deferred (see the Lab/Test toggles)
    this._menuView = 'main';
    this._menu.setTitle('Main Menu');
    this._menu.beginView(false); // no Back here: start the list higher
    let y = 0;

    // Standard menu items first, with About last (as is conventional). Packs
    // Available sits high, right after Help.
    y += this._menu.row(y, 'Help', '›', {
      onTap: () => this._showMessage('How to play', HELP_TEXT),
      tip: 'How to play, and how scoring works.',
    });
    const hasIntro = !!levelIntro(this.level);
    y += this._menu.row(y, 'See level intro', '›', {
      enabled: hasIntro,
      // Re-show the intro: clear its seen flag (so quitting mid-read re-shows it),
      // close the menu, then open it.
      onTap: hasIntro
        ? () => {
            clearIntroSeen(currentLevelKey());
            this._closeMenu();
            this._showLevelIntro();
          }
        : null,
      tip: hasIntro ? "Re-read this level's intro." : 'This level has no intro.',
    });
    y += this._menu.row(y, 'Packs Available', '›', {
      onTap: () => this._showPacksAvailable(),
      tip: 'Browse all packs and their scores; open one to jump between levels.',
    });
    y += this._menu.row(y, 'Show title screen', '›', {
      // Clear the skip flag so this (and the next boot) lands on the title, then
      // switch scenes. Both scenes are always registered (see main.js).
      onTap: () => {
        setSkipTitle(false);
        this.scene.start('title');
      },
      tip: 'Replay the intro title screen.',
    });
    y += this._menu.row(y, 'About', '›', {
      onTap: () => this._showMessage('About', ABOUT_TEXT),
      tip: 'Credits and the tools behind the game.',
    });
    y += this._menu.row(y, 'Report a problem', '›', {
      onTap: () => this._showReport(),
      tip: 'Copy a problem report to send to David.',
    });

    // Everything below About is the "different" stuff: the current-pack section,
    // then the developer-only Lab/Test toggles tucked at the very bottom.
    y += this._menu.divider(y);
    y += this._menu.sectionHeader(y, 'Current pack');
    y += this._packInfoRows(y, activePackName(), levelCount(), true);
    y += this._menu.button(y, 'Details', {
      danger: false,
      onTap: () => this._showPackDetail(activePackManifest(), 'main'),
      tip: 'See every level in this pack and your best on each.',
    });

    if (Config.devTools) {
      y += this._menu.divider(y);
      y += this._menu.toggleRow(
        y,
        {
          label: 'Lab',
          on: this._labPanel.open,
          tip: 'Developer tool: show a panel to live-tune slingshot and physics values.',
          onTap: () => {
            this._toggleDevPanel();
            this._rerenderMenu();
          },
        },
        {
          label: 'Test',
          on: this._testMode,
          tip:
            "Test mode: unlock every level and jump freely, ignoring the normal 'win to advance' rule. " +
            'Also enables god mode; right-drag either brother to move the pair anywhere.',
          onTap: () => {
            this._testMode = !this._testMode;
            setTestMode(this._testMode);
            // Turning Test mode off mid-drag would strand the pair on the pointer.
            if (!this._testMode) this._godDrag = null;
            this._rerenderMenu();
          },
        }
      );
    }

    this._menu.finish(y);
  }

  /**
   * The "Packs Available" view: every known pack with its total best score, from
   * local storage only (no probing). A ★ marks the pack you're currently playing.
   * Tapping a pack opens its details. Scrolls if the list is long. Back returns
   * to the main menu.
   *
   * @returns {Promise<void>}
   */
  async _showPacksAvailable() {
    if (!this._menu.open) return;
    this._menuView = 'packs';
    this._menu.setTitle('Packs Available');
    this._menu.beginView(true); // has Back
    const U = Config.ui;
    let y = 0;
    const packs = await listPacks();
    if (!this._menu.open || this._menuView !== 'packs') return; // closed/changed mid-fetch
    for (const { id, name } of packs) {
      const { total, completed } = scores.packTotal(id);
      const isCurrent = id === activePackId();
      y += this._menu.row(y, isCurrent ? `${name}  ★` : name, completed > 0 ? String(total) : '-', {
        valueColor: U.color.accentText,
        onTap: async () => {
          const m = await loadPackManifest(id);
          if (this._menu.open) this._showPackDetail(m, 'packs');
        },
        tip:
          (isCurrent ? "★ marks the pack you're currently playing. " : '') +
          "Open to see this pack's details. The number is your total best score across it ('-' if you haven't cleared any).",
      });
    }
    this._menu.finish(y);
  }

  /**
   * The current-pack / pack-details info rows: Levels, Completed, Total. `count`
   * is the pack's level count (known); completion/total come from stored scores.
   *
   * @param {number} y0 @param {string} packName @param {number} count
   * @param {boolean} isCurrent  Mark the pack as the one being played.
   * @returns {number} Vertical space consumed.
   */
  _packInfoRows(y0, packName, count, isCurrent) {
    const U = Config.ui;
    const { total, completed } = scores.packTotal(packName);
    // Compact info rows (no touch target needed) to keep the section tight.
    const compact = { rowH: 28, fontSize: '15px' };
    let y = y0;
    y += this._menu.row(y, 'Pack name', packName, {
      ...compact,
      current: isCurrent,
      valueColor: U.color.text,
      tip: isCurrent ? "The name of the pack you're currently playing" : 'The name of this pack',
    });
    // The loaded level lives in this pack (always so from the main menu): name it.
    if (isCurrent) {
      const n = currentIndex() + 1;
      const nm = levelName(this.level);
      y += this._menu.row(y, 'Current level', nm ? `${nm} (${n})` : String(n), {
        ...compact,
        valueColor: U.color.text,
        tip: nm ? `You're on "${nm}" — level ${n} of this pack.` : `You're on level ${n} of this pack.`,
      });
    }
    y += this._menu.row(y, 'Levels', String(count), { ...compact, tip: 'Number of levels in this pack.' });
    y += this._menu.row(y, 'Completed', String(completed), {
      ...compact,
      tip: "Levels in this pack you've cleared at least once.",
    });
    y += this._menu.row(y, 'Pack total', completed > 0 ? String(total) : '-', {
      ...compact,
      valueColor: U.color.accentText,
      tip: "Sum of your best results across this pack (higher is better). '-' means none cleared yet.",
    });
    return y - y0;
  }

  /**
   * Pack details: the pack's info section, then per-level rows (best score, or a
   * lock/dash) with tap-to-jump (gated by {@link _canJump}), then "Forget pack
   * scores". Reached from the main menu's Details button (`from: 'main'`) or a
   * row in Packs Available (`from: 'packs'`); Back returns to wherever it came
   * from (see {@link _menuBack}).
   *
   * @param {{id:string, name:string, levelIds:string[]}} manifest
   * @param {'main'|'packs'} [from]  Which view opened this (for Back).
   * @returns {void}
   */
  _showPackDetail(manifest, from = 'main') {
    this._menuView = 'detail';
    this._menuDetail = manifest;
    this._detailFrom = from;
    this._menu.setTitle('Pack details');
    this._menu.beginView(true); // leave room for the Back button
    const U = Config.ui;
    const isCurrentPack = manifest.id === activePackId();
    let y = 0;

    y += this._menu.sectionHeader(y, 'Pack');
    y += this._packInfoRows(y, manifest.name, manifest.levelIds.length, isCurrentPack);

    y += this._menu.divider(y);
    y += this._menu.sectionHeader(y, 'Levels');
    let hasScores = false;
    manifest.levelIds.forEach((file, i) => {
      const entry = scores.entryFor(`${manifest.id}/${file}`);
      const best = entry ? entry.best : null;
      if (best != null) hasScores = true;
      const allowed = this._canJump(manifest, i);
      // Local date (YYYY-MM-DD) of the best, when recorded (new-format entries).
      const localDate = entry && entry.localDateTime ? entry.localDateTime.slice(0, 10) : null;
      // A number = cleared (its best score); date first so the numbers right-align
      // into a clean column. '-' = available but not cleared; 🔒 = locked.
      const value =
        best != null
          ? localDate
            ? `${localDate}   ${best}`
            : `${best}`
          : allowed
            ? '-'
            : '🔒';
      let tip;
      if (best != null) {
        tip = `Cleared! Your best here is ${best} (turns left when you won; higher is better). Tap to play it again.`;
        if (localDate && entry.timezone) {
          tip += ` Your best score was on ${localDate} in timezone ${entry.timezone}.`;
        }
      } else {
        tip = allowed
          ? 'Not cleared yet. Tap to play this level.'
          : 'Locked: clear the previous level first (or turn on Test mode).';
      }
      y += this._menu.row(y, `Level ${i + 1}`, value, {
        enabled: allowed,
        valueColor: best != null ? U.color.accentText : U.color.textDisabled,
        current: isCurrentPack && i === currentIndex(),
        onTap: allowed ? () => this._jumpToLevel(manifest, i) : null,
        tip,
      });
    });
    // "Forget pack scores" at the bottom of the scrollable list (shaded out when
    // the pack has no scores).
    y += Config.ui.space.sm;
    y += this._menu.button(y, 'Forget pack scores', {
      danger: true,
      enabled: hasScores,
      onTap: () => this._confirmForgetPack(manifest),
      tip: hasScores
        ? "Erase your saved best scores for this pack. This can't be undone."
        : 'No saved scores in this pack to forget yet.',
    });
    this._menu.finish(y);
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
        this._closeMenu();
        selectLevel(0).then(() => this.scene.restart()); // level 0 is already loaded
        return;
      }
      if (inThisPack) {
        this._refreshPackBest(); // scores cleared -> pack total back to "-"
        this._refreshHud(); // -> "Best: -"
      }
      this._showPackDetail(manifest, this._detailFrom); // re-render: scores cleared, button shaded
    });
  }

  /**
   * Recompute the cached pack total shown in the HUD: the sum of best scores
   * across every level in the current pack, or `null` when no level in the pack
   * has a best yet (shown as "-"). Because a level won with 0 turns left counts,
   * the value can be `0` (a real total) as distinct from `null` (nothing won).
   * Call only when a best can have changed (a win, or forgetting scores) — never
   * per frame.
   *
   * @returns {void}
   */
  _refreshPackBest() {
    const { total, completed } = this._packTotal(activePackManifest());
    this._packBest = completed > 0 ? total : null;
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
      await selectLevel(index);
      this.scene.restart();
    };
    if (this.status === 'PLAYING') this._showConfirm('Abandon current game?', proceed);
    else proceed();
  }

  // --- Input --------------------------------------------------------------

  /**
   * Slingshot, pan, and zoom input. The slingshot rides Phaser's own drag
   * system: only the current launcher is draggable (see Brothers._updateDraggable),
   * so a press on it grabs ('gameobjectdown') and 'drag' both reports an
   * offset-corrected position and flips grabbed → aiming — while any other press
   * pans the camera. Wheel and pinch handle zoom.
   *
   * @returns {void}
   */
  _wireInput() {
    this.input.on('pointerdown', (p) => {
      sfx.unlock(); // browsers need a user gesture to start audio
      this._stopCameraGlide(); // any press cancels an in-progress settle pan/zoom
      // A blocking overlay owns input while up (its buttons handle their own
      // taps); a press starts its scroll drag. Confirms sit above the menu.
      if (this._activeModal) {
        this._activeModal.onPointerDown(p);
        return;
      }
      if (this._menuOpen) {
        this._menu.onPointerDown(p);
        return;
      }
      if (this._pinchDist) return; // a two-finger pinch owns the gesture
      if (p.y < this._hudHeight) return; // press is on the HUD ribbon, not the arena
      // A modeless panel (the Lab) owns presses over itself (and starts its own
      // scroll drag); anywhere else falls through to the arena.
      for (const panel of this._panels) if (panel.onPointerDown(p)) return;

      // God mode: a right-press on either ball picks up the pair. Checked before
      // the pan router so the drag doesn't also scroll the camera. A right-press
      // anywhere else falls through and pans, as any other press would.
      if (p.rightButtonDown() && this._godEditable()) {
        const grabbed = this._brotherAt(p.worldX, p.worldY);
        if (grabbed) {
          this._godDrag = grabbed;
          this._isPanning = false;
          sfx.grab();
          diag.trace('god', 'grab', { who: grabbed.def.name, ...this.brothers.snapshot() });
          this._refreshHud(); // -> "God mode: moving the brothers"
          return;
        }
      }

      // A press on the launcher is handled by Phaser's drag system (the
      // 'gameobjectdown' grab + 'drag' handler below), which sets isAiming; a
      // press on the anchor starts a pin gesture (sets `_pinning`); anything
      // else on the board pans the camera.
      if (this.isAiming || this._pinning) return; // a launcher grab / pin gesture just started
      this._isPanning = true;
      this._panLast.x = p.x;
      this._panLast.y = p.y;
    });

    // Grab: a press on the current launcher (Phaser's own hit-testing, so it
    // works across the world/HUD cameras). The drag itself is Phaser's, below.
    this.input.on('gameobjectdown', (p, go) => {
      sfx.unlock(); // fires before scene 'pointerdown', so unlock audio here too
      // The right button belongs to god mode; it must never start an aim or a
      // pin gesture (this fires *before* the scene 'pointerdown' that grabs).
      if (p.rightButtonDown()) return;
      if (this._modalOpen || this._menuOpen || this._pinchDist) return;
      if (this.status === 'ENDED' || this.phase !== 'AIMING') return;
      if (go === this.brothers.launcher.go) {
        this.isAiming = true;
        this._isPanning = false; // never pan while grabbing (guards event ordering)
        this._aimState = 'grabbed';
        this.brothers.beginAim();
        sfx.grab(); // soft "tick" so it's clear the launcher is grabbed
        this._hideCursorForGrab(); // hide cursor (the label still reveals on press — see below)
        this._refreshHud(); // "X's turn, grabbed"
        return;
      }
      // A press on the anchor (when the level allows it) starts a pin gesture —
      // a tap/double-tap snaps the pin, a drag fine-positions it. Like the
      // launcher grab, this fires before the scene 'pointerdown' pan router, so
      // setting `_pinning` here lets that router skip panning (see below).
      if (go === this.brothers.anchor.go && this._pinEditable()) this._beginPinGesture(p);
    });

    this.input.on('pointermove', (p) => {
      // (The arena name label follows the pointer via the Tooltip service's own
      // pointermove listener — no need to reposition it here.)
      if (this._activeModal) {
        this._activeModal.onPointerMove(p); // drives its scroll drag, if any
        return;
      }
      if (this._menuOpen) {
        this._menu.onPointerMove(p); // drives its scroll drag, if any
        return;
      }
      for (const panel of this._panels) if (panel.onPointerMove(p)) return; // its scroll drag, if any
      if (this._godDrag) return this.brothers.godMoveTo(this._godDrag, p.worldX, p.worldY);
      if (this._pinning) return this._updatePinGesture(p); // moving the anchor's pin, not the camera
      if (this.isAiming) return; // Phaser's drag moves the launcher; don't pan
      if (this._isPanning) {
        // Drag the world under the finger: scroll opposite to the move, scaled
        // by zoom. Phaser clamps to the camera bounds in preRender.
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

    // A release *outside* the canvas fires `pointerupoutside`, not `pointerup`, so
    // handle both — otherwise a gesture (an overlay resize/drag, an aim, a pin, a
    // pan) sticks if the pointer leaves the window before the button is released.
    const onPointerUp = (p) => {
      if (this._activeModal) {
        this._activeModal.onPointerUp(p); // ends its scroll drag, if any
        return;
      }
      if (this._menuOpen) {
        this._menu.onPointerUp(p); // ends its scroll drag, if any
        return;
      }
      for (const panel of this._panels) if (panel.onPointerUp(p)) return; // ends its scroll drag
      if (this._godDrag) {
        diag.trace('god', 'drop', { who: this._godDrag.def.name, ...this.brothers.snapshot() });
        this._godDrag = null;
        this._refreshHud(); // back to the normal turn prompt
        return;
      }
      if (this._pinning) {
        this._finishPinGesture(p);
        return;
      }
      this._isPanning = false;
      if (!this.isAiming) return;
      this.isAiming = false;
      this._endGrab();

      // A launch is impossible once the level is over (it may have ended mid-aim,
      // e.g. a bomb strike). Cancel the aim instead of firing "one last launch".
      if (this.status === 'ENDED') {
        this.brothers.cancelAim();
        return;
      }

      const pull = this.brothers.release();
      if (pull < Config.slingshot.minPull) {
        this._refreshHud(); // mis-click: no move spent, back to "drag to aim"
        return;
      }

      this.movesLeft -= 1;
      this.status = 'PLAYING'; // first launch leaves READY; later launches keep PLAYING
      this.phase = 'MOVING';
      // Hazards stay inert (and show their preview arrows) until the shot connects
      // — see _kickoff, fired from the first snap in the collision router.
      this._refreshHud();
    };
    this.input.on('pointerup', onPointerUp);
    this.input.on('pointerupoutside', onPointerUp);

    // Phaser supplies dragX/dragY already offset for where the launcher was
    // grabbed, so the ball tracks the pointer without snapping its centre under
    // it (no jump on the first drag). The first drag is also where we flip from
    // "grabbed" to "aiming" — done here, on the event that reliably fires,
    // rather than on 'dragstart'.
    this.input.on('drag', (_p, go, dragX, dragY) => {
      if (go !== this.brothers.launcher.go || !this.isAiming) return;
      if (this._aimState !== 'dragging') {
        this._aimState = 'dragging';
        // The launcher's label was revealed on press (the only way to see it on
        // touch); now that we're aiming, hide and suppress it so the drag is clean.
        this._infoSuppressed = true;
        this.tip.hide();
        this._refreshHud(); // "X's turn, aiming"
      }
      this.brothers.dragTo(dragX, dragY);
    });

    // Laptop: mouse wheel zooms toward the cursor.
    this.input.on('wheel', (p, _over, _dx, dy) => {
      if (this._activeModal) {
        this._activeModal.onWheel(p, dy); // wheel scrolls the modal body, not the arena
        return;
      }
      if (this._menuOpen) {
        this._menu.onWheel(p, dy); // wheel scrolls the menu list, not the arena
        return;
      }
      for (const panel of this._panels) if (panel.onWheel(p, dy)) return; // scrolls it, not the arena
      const step = Config.zoom.wheelStep;
      this._zoomBy(dy > 0 ? 1 - step : 1 + step, p.x, p.y);
    });

    // Mobile: make a second touch pointer available for pinch (handled in
    // update() so we can track the changing finger spread frame to frame).
    this.input.addPointer(1);
  }

  /**
   * Clear the grab/aim sub-state after a release, mis-click, or pinch-cancel:
   * back to 'idle' and restore the (drag-hidden) cursor. Callers refresh the HUD.
   *
   * @returns {void}
   */
  _endGrab() {
    this._aimState = 'idle';
    this._aimBlocked = false;
    this._infoSuppressed = false;
    // Restore the cursor across every path we hid it through.
    this.input.setDefaultCursor('default');
    const io = this.brothers.launcher.go.input;
    if (io) io.cursor = '';
    this.input.manager.canvas.style.cursor = 'default';
  }

  // --- Anchor pin editing (see pin-plan.md) --------------------------------

  /**
   * God mode (a playtesting tool): with Test mode on, a right-button drag picks
   * up the brothers and puts them anywhere. Blocked while the balls are in
   * flight or resolving, where moving them would fight the physics mid-shot.
   *
   * @returns {boolean}
   */
  _godEditable() {
    return (
      this._testMode &&
      !this._modalOpen &&
      !this._menuOpen &&
      !this._pinchDist &&
      this.phase !== 'MOVING' &&
      this.phase !== 'RESOLVING'
    );
  }

  /**
   * The brother under a world point, or null. Used by god mode instead of
   * Phaser's `gameobjectdown`, which only reports the *draggable* launcher —
   * god mode can grab either ball, including the frozen anchor.
   *
   * @param {number} worldX @param {number} worldY
   * @returns {import('../world/Brother.js').Brother|null}
   */
  _brotherAt(worldX, worldY) {
    if (!this.brothers) return null;
    for (const b of [this.brothers.launcher, this.brothers.anchor]) {
      if (Phaser.Math.Distance.Between(worldX, worldY, b.go.x, b.go.y) <= b.go.radius) return b;
    }
    return null;
  }

  /**
   * Can the anchor's aiming pin be edited right now? The level must allow it,
   * and it's only sensible while the current player is aiming and hasn't grabbed
   * the launcher (editing mid-flight or after the game ends would confuse).
   *
   * @returns {boolean}
   */
  _pinEditable() {
    return (
      this.level.pinEnabled &&
      this.phase === 'AIMING' &&
      !this.isAiming &&
      this.status !== 'ENDED' &&
      !this._modalOpen &&
      !this._menuOpen &&
      !this._pinchDist
    );
  }

  /**
   * Begin a pin gesture on the anchor: snapshot the pin's offset (to revert an
   * over-long drag) and the pointer's press position/time (to tell a tap from a
   * drag, and to run the double-tap window). Movement is tracked in
   * {@link _updatePinGesture}; the gesture resolves in {@link _finishPinGesture}.
   *
   * @param {Phaser.Input.Pointer} p
   * @returns {void}
   */
  _beginPinGesture(p) {
    this._pinning = true;
    this._pinDragging = false;
    this._isPanning = false;
    const b = this.brothers.anchor;
    b.pinDownOffsetX = b.pinOffsetX;
    b.pinDownOffsetY = b.pinOffsetY;
    b.pinDownX = p.x; // screen coords: the tap→drag threshold is a finger-move distance
    b.pinDownY = p.y;
  }

  /**
   * While a pin press moves: promote it to a fine-drag once the finger travels
   * past the threshold (suppressing the name label and switching the HUD to
   * "Moving X's pin"), then track the pin under the pointer — clamped inside the
   * ball by {@link Brother#placePin}. A drag dragged out past
   * `revertRadiusMult × radius` is read as a tooltip request instead: the pin
   * reverts and the gesture ends.
   *
   * @param {Phaser.Input.Pointer} p
   * @returns {void}
   */
  _updatePinGesture(p) {
    const b = this.brothers.anchor;
    if (!this._pinDragging) {
      const moved = Phaser.Math.Distance.Between(p.x, p.y, b.pinDownX, b.pinDownY);
      if (moved < Config.pin.dragThreshold) return; // still might be a tap
      this._pinDragging = true;
      this._infoSuppressed = true; // keep the name label from flashing during the drag
      this.tip.hide();
      this._refreshHud(); // -> "Moving X's pin"
    }
    const wp = this.cameras.main.getWorldPoint(p.x, p.y);
    const ox = wp.x - b.go.x;
    const oy = wp.y - b.go.y;
    if (Math.hypot(ox, oy) > b.go.radius * Config.pin.revertRadiusMult) {
      b.placePin(b.pinDownOffsetX, b.pinDownOffsetY); // over-long: treat as tooltip, revert
      this._endPinGesture();
      return;
    }
    b.placePin(ox, oy);
  }

  /**
   * Resolve a pin gesture on release. A drag has already positioned the pin, so
   * it just ends. A tap (no drag) either recenters the pin — if it lands within
   * the double-tap window of the previous tap — or snaps it to the nearest
   * simple point (centre or one of the 8 compass edges) to the tap location.
   *
   * @param {Phaser.Input.Pointer} p
   * @returns {void}
   */
  _finishPinGesture(p) {
    const b = this.brothers.anchor;
    if (!this._pinDragging) {
      const now = this.time.now;
      if (now - b.lastTapTime <= Config.pin.doubleTapMs) {
        b.placePin(0, 0); // double-tap: recenter
        b.lastTapTime = 0; // consume, so a third tap isn't a second double-tap
      } else {
        const wp = this.cameras.main.getWorldPoint(p.x, p.y);
        this._snapPinToNearest(b, wp.x, wp.y);
        b.lastTapTime = now;
      }
    }
    this._endPinGesture();
  }

  /**
   * Snap the pin to whichever "simple point" — the centre or one of the 8
   * compass-edge points at the ball's radius — is nearest the given world
   * location (where the player tapped on the ball).
   *
   * @param {import('../world/Brother.js').Brother} b
   * @param {number} worldX @param {number} worldY
   * @returns {void}
   */
  _snapPinToNearest(b, worldX, worldY) {
    const tx = worldX - b.go.x;
    const ty = worldY - b.go.y;
    const r = b.go.radius;
    let best = [0, 0]; // centre
    let bestD = tx * tx + ty * ty;
    for (let k = 0; k < 8; k++) {
      const ang = (k * Math.PI) / 4; // 8 compass directions
      const cx = Math.cos(ang) * r;
      const cy = Math.sin(ang) * r;
      const d = (cx - tx) ** 2 + (cy - ty) ** 2;
      if (d < bestD) {
        bestD = d;
        best = [cx, cy];
      }
    }
    b.placePin(best[0], best[1]);
  }

  /** Abort an in-progress pin gesture (e.g. a pinch begins), reverting the pin. */
  _cancelPinGesture() {
    const b = this.brothers.anchor;
    b.placePin(b.pinDownOffsetX, b.pinDownOffsetY);
    this._endPinGesture();
  }

  /** Clear pin-gesture state; if it was a drag, restore the label + HUD. */
  _endPinGesture() {
    this._pinning = false;
    if (this._pinDragging) {
      this._pinDragging = false;
      this._infoSuppressed = false;
      this._refreshHud(); // back to the normal turn prompt
    }
  }

  /**
   * On grabbing the launcher, hide the OS cursor so the ball's face reads clearly
   * (the label still reveals on press — that's the only way to see it on touch;
   * it's hidden later, on drag-start). The cursor is hidden through all of
   * Phaser's paths — the default cursor, the launcher's own hover cursor
   * (re-applied whenever the offset-dragged ball crosses the pointer), and the
   * canvas directly for immediacy — since any one alone gets overridden by the
   * others. Undone in {@link _endGrab}.
   *
   * @returns {void}
   */
  _hideCursorForGrab() {
    this.input.setDefaultCursor('none');
    const io = this.brothers.launcher.go.input;
    if (io) io.cursor = 'none';
    this.input.manager.canvas.style.cursor = 'none';
  }

  /**
   * @returns {boolean} Whether arena entity-info tooltips may show right now —
   * not while a modal or the menu owns the screen, nor during an aim/pin drag
   * (`_infoSuppressed`). Consulted by the entity attach's `clip` in
   * `Entity._enableInfo`.
   */
  get _infoAllowed() {
    return !this._modalOpen && !this._menuOpen && !this._infoSuppressed;
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
    this._stopCameraGlide(); // manual zoom cancels an in-progress settle pan/zoom
    const z0 = cam.zoom;
    const z1 = Phaser.Math.Clamp(z0 * factor, this._minZoom, Config.zoom.max);
    if (z1 === z0) return; // already at a clamp limit: nothing to do (and avoids drift)
    // Keep the world point under (screenX, screenY) fixed across the zoom change.
    // We can't use getWorldPoint for the "after" point: the camera matrix is only
    // rebuilt at render time (preRender), so right after setZoom it still holds the
    // old zoom while cam.zoom is already the new one — a mismatched read that pulls
    // the pivot toward the screen centre. Instead adjust scroll directly.
    //
    // The visible world point maps as worldX = scrollX + width/2 + (screenX - centerX)/zoom
    // (centerX/centerY are the viewport centre in canvas pixels). Holding worldX and
    // screenX fixed as zoom goes z0 -> z1, the width/2 term cancels, leaving:
    const inv = 1 / z0 - 1 / z1;
    const dx = (screenX - cam.centerX) * inv;
    const dy = (screenY - cam.centerY) * inv;
    cam.setZoom(z1);
    cam.setScroll(cam.scrollX + dx, cam.scrollY + dy);
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
    if (this._pinning) this._cancelPinGesture(); // a second finger ends a pin drag (revert)
    if (this.isAiming) {
      this.isAiming = false;
      this.brothers.cancelAim();
      this._endGrab();
      this._refreshHud();
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
      // Nothing in the world reacts before the first launch or after the level
      // ends. Snap and teleport are further gated to flight (MOVING) below; a
      // hazard, by contrast, is lethal on contact in ANY phase while PLAYING.
      if (this.status !== 'PLAYING') return;
      const moving = this.phase === 'MOVING';

      for (const pair of event.pairs) {
        const entA = pair.bodyA.entity;
        const entB = pair.bodyB.entity;
        const aBro = entA instanceof Brother;
        const bBro = entB instanceof Brother;

        // Two brothers colliding: the Hybrid Snap. The pull-only tether lets the
        // pair rest in contact, so this must fire only in flight (MOVING) — never
        // while AIMING, where it would unfreeze the immobile anchor.
        if (aBro && bBro) {
          if (moving) {
            sfx.hit(); // billiard-style click on every brother-on-brother contact
            this.brothers.snap();
            this._kickoff(); // the launcher reached the anchor: hazards go live
          }
          continue;
        }

        // Exactly one brother against something else.
        if (aBro || bBro) {
          const bro = aBro ? entA : entB;
          const other = aBro ? entB : entA;
          const otherBody = aBro ? pair.bodyB : pair.bodyA;
          if (other instanceof Hazard) {
            // A hazard hit ends the level/turn — lethal in any phase. One lethal
            // contact per event is enough; stop scanning this event.
            other.onActorContact(bro);
            break;
          } else if (otherBody.isSensor) {
            // A trigger (teleporter) warps the pair; only in flight, as before.
            // Goals are checked at settle, so their no-op handler does nothing.
            if (moving) other?.onActorContact(bro);
          } else if (moving) {
            sfx.hit(); // brother off a wall or the arena edge — same click, no debounce
            this.brothers.snap(); // hitting a solid also frees the anchor
            this._kickoff(); // shot has connected with the world: hazards go live
          }
          continue;
        }

        // Neither is a brother: a hazard entering a trigger (teleporter) warps
        // itself. Hazard/wall bounces are handled by captureHazardBounce below.
        const hazard = entA instanceof Hazard ? entA : entB instanceof Hazard ? entB : null;
        if (!hazard) continue;
        const otherEnt = hazard === entA ? entB : entA;
        const otherBody = hazard === entA ? pair.bodyB : pair.bodyA;
        if (otherEnt && otherBody.isSensor) otherEnt.onActorContact(hazard);
      }
    });

    // Reflect hazards off solid walls / the arena edge ourselves. Matter's
    // restitution is unreliable for a slow body: below its resting-contact
    // threshold it damps the normal velocity to zero, so the bomb slides along
    // (and sticks to) the wall instead of bouncing. We capture the collision
    // normal — on start AND while the contact persists (a slow bomb lingers) —
    // and the hazard bounces itself after the step (see Hazard.noteBounce/update).
    const captureHazardBounce = (event) => {
      for (const pair of event.pairs) {
        const ea = pair.bodyA.entity;
        const eb = pair.bodyB.entity;
        const hazard = ea instanceof Hazard ? ea : eb instanceof Hazard ? eb : null;
        if (!hazard) continue;
        const otherBody = ea === hazard ? pair.bodyB : pair.bodyA;
        if (otherBody.isSensor) continue; // triggers (teleporter/goal): pass through
        const oe = otherBody.entity;
        if (oe instanceof Brother || oe instanceof Hazard) continue; // handled elsewhere / left to physics
        if (!pair.collision) continue; // no normal to reflect off (defensive)
        hazard.noteBounce(pair.collision.normal, otherBody); // wall or arena edge
      }
    };
    this.matter.world.on('collisionstart', captureHazardBounce);
    this.matter.world.on('collisionactive', captureHazardBounce);
  }

  // --- Per-frame loop -----------------------------------------------------

  /**
   * @param {number} _time
   * @param {number} delta  Milliseconds since the last frame.
   * @returns {void}
   */
  update(_time, delta) {
    // An exception here would escape into Phaser's step and kill the render
    // loop: the game freezes with no banner and no clue why. Catch it, report it
    // once (the log is mirrored to localStorage, so it survives even if nothing
    // draws again), and keep stepping — a wrong frame beats a dead one, and it
    // keeps the "Report a problem" menu reachable.
    try {
      this._update(delta);
    } catch (e) {
      if (!this._updateFailed) {
        this._updateFailed = true;
        diag.trace('play', 'update threw', this.brothers ? this.brothers.snapshot() : {});
        diag.error('game: update', e);
      }
    }
  }

  /**
   * The real per-frame work, called by {@link update} inside its crash guard.
   *
   * @param {number} delta  Milliseconds since the last frame.
   * @returns {void}
   */
  _update(delta) {
    // Advance Matter in fixed sub-steps so fast bodies can't tunnel through thin
    // obstacles (autoUpdate is off; see create() and Config.physics). The frame
    // delta is clamped so a stall doesn't produce huge, unstable steps. Stepping
    // happens first so the rest of the frame sees post-step positions.
    const n = Config.physics.substeps;
    const sub = Math.min(delta, Config.physics.maxFrameDelta) / n;
    for (let i = 0; i < n; i++) this.matter.world.step(sub);

    this.brothers.update();
    // While dragging, echo the "can't launch here" state (the red Xs) in the
    // turn prompt. Edge-triggered so the HUD only refreshes as it flips.
    if (this._aimState === 'dragging' && this.brothers.aimRefused !== this._aimBlocked) {
      this._aimBlocked = this.brothers.aimRefused;
      this._refreshHud(); // "aiming" <-> "can't do that"
    }
    // Tick any dynamic world objects (culled to the view). No-op today, since
    // all current objects are static/tween-driven; here for future types.
    this.world.update({ brothers: this.brothers, view: this.cameras.main.worldView });
    this._updatePinch();

    if (this.status === 'PLAYING' && this.phase === 'MOVING') {
      this._keepBallsInView(); // gently pan/zoom only when a ball nears the edge
      this.brothers.brakeSlowMotion();
      if (this.brothers.isSettled()) this._resolveTurn();
    }
  }

  /**
   * Kickoff: the first launch has connected (the launcher's first impact — the
   * anchor, or a wall). Fired once; brings dynamic hazards to life and clears
   * their pre-launch preview arrows (see World.notifyPlayStart / Hazard). Until
   * now the board stays calm so the player can read the hazard cues and aim.
   *
   * @returns {void}
   */
  _kickoff() {
    if (this._kickedOff) return;
    this._kickedOff = true;
    this.world.notifyPlayStart();
  }

  /**
   * A hazard (bomb) struck a brother. Apply its outcome (the bomb has already
   * played its own burst/boom in {@link import('../world/Bomb.js').Bomb#onActorContact}):
   *  - `gameover` (default): the level ends immediately as a failure.
   *  - `turnend`: undo this turn (both brothers back to their turn-start spots)
   *    and charge a move; if that empties the move count it's an out-of-moves
   *    loss, otherwise a fresh aiming turn begins.
   * No-op unless PLAYING, so a second bomb in the same frame can't double-fire.
   *
   * @param {import('../world/Hazard.js').Hazard} bomb
   * @returns {void}
   */
  hazardStruck(bomb) {
    if (this.status !== 'PLAYING') return;

    if (bomb.mode === 'turnend') {
      this.brothers.resetTurn();
      this.movesLeft -= 1;
      this.phase = 'AIMING';
      if (this.movesLeft <= 0) {
        sfx.lose();
        this._endGame('Out of moves', FACES.lose, '#ff7a6b', false);
        return;
      }
      this._refreshHud();
      return;
    }

    sfx.lose();
    this._endGame('Game over', FACES.lose, '#ff7a6b', false);
  }

  /**
   * Called once both balls have settled (every frame while MOVING, until the
   * phase leaves MOVING). Any muddy brother shimmies FIRST, then we decide the
   * turn ({@link _decideTurn}) — so a win/lose animation follows the shimmy. The
   * `RESOLVING` phase both parks the settle check (so this can't re-fire during
   * the shimmy) and is left by `_decideTurn`. With no mud, `shimmyMud` calls
   * back synchronously and this resolves in one tick, exactly as before.
   *
   * @returns {void}
   */
  _resolveTurn() {
    this._frameBrothers(); // gently zoom/pan so both balls are fully framed at rest
    this.phase = 'RESOLVING'; // re-entry guard + "not MOVING" for the settle check
    this._refreshHud(); // -> "Shaking off mud" while the shimmy plays (if any)
    this.world.notifySettle(); // hazards shed a turn's worth of loose mud (no shimmy)
    this.brothers.shimmyMud(() => this._decideTurn());
  }

  /**
   * Decide the settled turn: win, loss, or hand off to the next turn. Split from
   * {@link _resolveTurn} so it runs only after the mud-shed wiggle has finished.
   *
   * @returns {void}
   */
  _decideTurn() {
    const reached = this.world.firstReached(this.brothers);
    diag.trace('play', 'turn decided', {
      reached: reached?.def?.name ?? reached?.def?.type ?? null,
      movesLeft: this.movesLeft,
      ...this.brothers.snapshot(),
    });
    if (reached) {
      // Record best score (most turns left) if we beat it.
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
      this._refreshPackBest(); // a new best may change the pack total
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
    diag.trace('play', 'level end', {
      won,
      message,
      movesLeft: this.movesLeft,
      level: currentLevelKey(),
      ...this.brothers.snapshot(),
    });
    this.status = 'ENDED';
    this.world.notifyLevelEnd(); // freeze bombs so they can't trigger during the banner
    this.brothers.onLevelEnd(); // turn off the "your move" cues (glow, refusal marks)
    // If the level ends mid-aim (e.g. a bomb strikes a brother while the player
    // is drawing the slingshot), abort the aim: there must be no "one last
    // launch" on the pending pointerup, and no frozen, stretched launcher left
    // under the banner. Done before setBothFaces so the end faces stick (cancelAim
    // resets them to idle).
    if (this.isAiming) {
      this.isAiming = false;
      this._endGrab();
      this.brothers.cancelAim();
    }
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
    if (this._godDrag) {
      // Outranks even "Game Ended": god mode works after the level is over, and
      // the prompt should say what the drag is doing.
      text = 'God mode: moving the brothers';
      color = this._godDrag.color;
    } else if (this.status === 'ENDED') {
      text = 'Game Ended';
      color = '#9aa0a6';
    } else if (this.phase === 'RESOLVING') {
      // The mud-shed shimmy is playing. This phase only lingers while at least
      // one brother is shaking off mud (a mud-free settle passes through it
      // synchronously), and either or both may be shimmying — so a neutral,
      // brother-agnostic white message rather than one launcher's colour.
      text = 'Shaking off mud';
      color = '#ffffff';
    } else if (this.phase === 'MOVING') {
      text = 'Moving';
      color = launcher.color;
    } else if (this._pinDragging) {
      // Unusual swap: the HUD normally names the launcher (the current player),
      // but while fine-dragging the pin it names the ANCHOR whose pin is moving.
      const anchor = this.brothers.anchor;
      text = `Moving ${anchor.name}'s pin`;
      color = anchor.color;
    } else {
      // AIMING: the prompt tracks the grab sub-state (and, while dragging,
      // whether the current spot is launchable).
      const prompt =
        this._aimState === 'dragging'
          ? this._aimBlocked
            ? "can't do that"
            : 'aiming'
          : this._aimState === 'grabbed'
            ? 'grabbed'
            : 'drag to aim';
      text = `${launcher.name}'s turn, ${prompt}`;
      color = launcher.color;
    }
    this.turnText.setText(text).setColor(color);
    const best = this.registry.get(this._bestKey);
    const pack = this._packBest == null ? '-' : this._packBest;
    this.packText.setText(`Pack: ${pack}`);
    this.bestText.setText(`Best: ${best == null ? '-' : best}`);
    this.leftText.setText(`#Left: ${this.movesLeft}`);
    this._layoutRightGroup(); // widths changed -> reflow the group
    this._refreshResetButton();
    this._refreshNavButtons();
    this._refreshStatusIcon();
    this._refreshLabRows(); // the brothers' mud turns tick down as the game runs
  }
}
