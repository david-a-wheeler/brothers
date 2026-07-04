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
} from '../levels.js';
import * as scores from '../scores.js';
import { World } from '../world/World.js';
import { setSkipTitle } from '../prefs.js';
import * as diag from '../diag.js';

/** Body text for the Help modal (plain text; the modal word-wraps it). */
const HELP_TEXT = [
  'Help the brothers, David and Ken, reach the goal in as few turns as possible.',
  'Move: The glowing brother is the one you move. Drag him back and release to slingshot him toward his partner. The two brothers are joined by an elastic band, so they travel together.',
  'Aim: A red X means that spot is blocked (a wall, the edge, or the other brother). Move and try again.',
  'Turns: Each launch uses one turn, then the other brother takes over. Turns left show as "#Left".',
  'Goal: Land a brother at rest inside the goal ring to win.',
  'Camera: mouse wheel or pinch/spread to zoom in and out; drag empty space to pan.',
  'Scoring: "Best" is the turns you had left on a win (higher is better). "Pack" adds up your Bests. "-" means not won yet; "0" is a real score.',
  'Walls block and bouce. Teleporters warp the pair to a matching target. Bombs are hazards: a spinning arrow shows where each will go and how fast; touching one usually ends the game..',
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
    const tips = [this.packTooltip, this.bestTooltip, this.leftTooltip];
    const y =
      L.mode === 'narrow' ? L.textRow * 1.5 : L.mode === 'compact' ? L.textRow / 2 : L.rowHeight / 2;
    const total = stats.reduce((s, e) => s + e.width, 0) + gap * (stats.length - 1);
    // Right edge of the group: the HUD edge (wide/compact) or centred (narrow).
    let x = L.mode === 'narrow' ? L.w / 2 + total / 2 : L.w - L.pad;
    for (let i = stats.length - 1; i >= 0; i--) {
      stats[i].setOrigin(1, 0.5).setPosition(x, y);
      const center = x - stats[i].width / 2;
      const half = tips[i].width / 2;
      const tx = Phaser.Math.Clamp(center, half + L.pad, L.w - L.pad - half);
      tips[i].setPosition(tx, L.hudHeight + 6);
      x -= stats[i].width + gap;
    }
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
      this.turnTooltip,
      this.packText,
      this.packTooltip,
      this.bestText,
      this.bestTooltip,
      this.leftText,
      this.leftTooltip,
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
      if (this._modalOpen) {
        this._teardownModalParts(); // keeps _modalScroll so the rebuild stays put
        this._buildModal(false);
      }
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
      if (this._menuOpen) this._rebuildMenu();
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
    // game over). Positioned from turnText's live bounds on reveal (its width and
    // placement change with the state string and layout).
    this.turnTooltip = this.add
      .text(0, 0, 'Active brother and current play state', {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    const revealTurnTip = () => {
      const cx = this.turnText.getCenter().x;
      const half = this.turnTooltip.width / 2;
      const L = this._layout;
      const x = Phaser.Math.Clamp(cx, half + L.pad, L.w - L.pad - half);
      this.turnTooltip.setPosition(x, L.hudHeight + 6).setVisible(true);
    };
    const hideTurnTip = () => this.turnTooltip.setVisible(false);
    this.turnText.on('pointerover', revealTurnTip);
    this.turnText.on('pointerout', hideTurnTip);
    this.turnText.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation(); // don't let the press reach the aim/pan router
      revealTurnTip();
    });
    this.turnText.on('pointerup', hideTurnTip);
    // Right-hand stats — Pack / Best / #Left — each its own interactive text with
    // a hover/press tooltip (see _buildHudStat), laid out as a right-aligned group
    // by _layoutRightGroup and filled with values in _refreshHud. The pack name is
    // fixed for the scene (switching packs restarts it), so it's baked in here.
    [this.packText, this.packTooltip] = this._buildHudStat(
      `Total best results of current pack (${activePackName()})`
    );
    [this.bestText, this.bestTooltip] = this._buildHudStat(
      'Best result on this level: the most turns ever left when you won'
    );
    [this.leftText, this.leftTooltip] = this._buildHudStat('Turns left in the current game');

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
    /** Suppress entity-info labels (set while dragging the launcher, to keep the
     *  aim uncluttered and the launcher's face visible). */
    this._infoSuppressed = false;

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
      .text(Config.view.width / 2 - 2 * gap, h + 12, 'Open main menu', {
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
   * Build a right-hand HUD stat: an interactive (right-aligned) text plus a
   * tooltip revealed on hover or press and hidden on out/release — mirroring the
   * icon tooltips so the two read the same. The value string and positions are
   * set later (see {@link _refreshHud} / {@link _layoutRightGroup}).
   *
   * @param {string} tooltipText  The explanation shown on hover/press.
   * @returns {[Phaser.GameObjects.Text, Phaser.GameObjects.Text]}  [stat, tooltip]
   */
  _buildHudStat(tooltipText) {
    const stat = this.add
      .text(0, 0, '', { fontSize: '18px', color: '#dddddd' })
      .setOrigin(1, 0.5)
      .setDepth(10)
      .setInteractive();
    const tip = this.add
      .text(0, 0, tooltipText, {
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000',
        padding: { x: 8, y: 4 },
      })
      .setOrigin(0.5, 0)
      .setDepth(11)
      .setVisible(false);
    const reveal = () => tip.setVisible(true);
    const hide = () => tip.setVisible(false);
    stat.on('pointerover', reveal);
    stat.on('pointerout', hide);
    stat.on('pointerdown', (_p, _x, _y, e) => {
      e?.stopPropagation(); // don't let the press reach the aim/pan router
      reveal();
    });
    stat.on('pointerup', hide);
    return [stat, tip];
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
        .text(x0 + 10, y0 + 8, 'Lab tuning', { fontSize: '14px', color: '#ffd479' })
        .setDepth(21),
      // Close: red, to read differently from the gray "+" steppers. Raised above
      // the menu band (30-34, below modals at 40) so it stays clickable when the
      // menu — which was used to open the Lab — is still up over the panel.
      this._devButton(x0 + w - 20, y0 + 14, '×', () => this._toggleDevPanel(), '#c0392b', '#e74c3c').setDepth(35),
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
    btn.on('pointerup', () => {
      sfx.tick();
      onClick();
    });
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
      READY: { key: 'icon-ready', tint: 0xd6b25e, label: 'Ready: not started' },
      PLAYING: { key: 'icon-playing', tint: 0x7cfc8a, label: 'Playing: in progress' },
      ENDED: { key: 'icon-ended', tint: 0x9aa0a6, label: 'Ended: level finished' },
    };
    const s = byStatus[this.status];
    this.statusIcon.setTexture(s.key).setTint(s.tint);
    this.statusTooltip.setText(s.label);
  }

  /**
   * Open a modal: a dimming backdrop, a rounded panel with a centred title, an
   * optional word-wrapped body, and one or more buttons. The panel auto-sizes to
   * the content (capped to the viewport). Built on the fixed UI camera and on the
   * world camera's ignore list; game input is gated by `_modalOpen` while it's
   * up. Depths (40-42) sit ABOVE the menu (30-33), so a modal opened over the
   * menu is never overdrawn. Used by {@link _showConfirm} and {@link _showMessage}.
   *
   * @param {{title:string, body?:string,
   *   buttons:Array<{label:string, bg:string, onClick:()=>void}>}} opts
   * @returns {void}
   */
  _openModal(spec) {
    if (this._modalOpen) return;
    this._modalOpen = true;
    this._isPanning = false;
    this._modalSpec = spec; // kept so the modal can be rebuilt on resize
    this._modalScroll = 0; // start at the top (a resize rebuild keeps its scroll)
    this._modalDragging = false;
    this._modalScrollbarDragging = false;
    // A modal can open from a menu row (Help/About) while the menu is still up
    // behind it. The pointerdown that opened it set the menu's drag flag, but the
    // pointerup that follows early-returns on _modalOpen and never clears it — so
    // clear it here, or a stray flag would drag the menu after the modal closes.
    this._menuDragging = false;
    this._scrollbarDragging = false;
    // Yes/No confirms bonk (an unusual situation to decide); info modals don't —
    // the tick from the control that opened them is enough.
    if (spec.warn !== false) sfx.bonk();
    this._buildModal(true);
  }

  /**
   * Build the modal's visuals from {@link _modalSpec} and the current layout.
   * Called on open (`animate` = fade in) and again from {@link _onResize} to
   * reflow to a new screen size (`animate` = false, no re-fade).
   *
   * @param {boolean} animate  Fade in (open) vs. appear at once (resize rebuild).
   * @returns {void}
   */
  _buildModal(animate) {
    const { title, body = '', buttons } = this._modalSpec;
    const U = Config.ui;
    const L = this._layout;
    const cx = L.w / 2;
    const cy = L.h / 2;
    const pad = U.space.lg;
    // Confirms stay narrow (a short question); a modal with body text (Help/About)
    // may grow wider on a wide screen so it isn't a tall, narrow column — but
    // still capped so lines don't get uncomfortably long to read.
    const pw = Math.min(body ? 640 : 440, L.w - 2 * L.pad);
    const innerW = pw - 2 * pad;

    // Build the text first so we can measure it and size the panel to fit.
    const titleTxt = this.add
      .text(cx, 0, title, {
        fontSize: '24px',
        color: U.color.text,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: innerW },
      })
      .setOrigin(0.5, 0)
      .setDepth(42);
    let bodyTxt = null;
    if (body) {
      bodyTxt = this.add
        .text(cx, 0, body, {
          ...U.type.body,
          align: 'left',
          lineSpacing: 5,
          wordWrap: { width: innerW },
        })
        .setOrigin(0.5, 0)
        .setDepth(42);
    }

    const btnH = 44;
    const maxPh = L.h - 2 * L.pad;
    // The title and buttons are pinned (always visible); the body lives in a fixed
    // region between them. Everything but the body is the panel's "chrome". If the
    // body fits under the remaining height, the panel shrinks to it (no scroll);
    // otherwise the panel caps at the screen and the body scrolls within its
    // region — so "OK" never gets pushed off. (No font-shrink: the body stays at
    // its normal, readable size and scrolls instead.)
    const chromeH = pad + titleTxt.height + (bodyTxt ? U.space.md : 0) + U.space.lg + btnH + pad;
    const fullBodyH = bodyTxt ? bodyTxt.height : 0;
    const bodyViewH = bodyTxt ? Math.max(0, Math.min(fullBodyH, maxPh - chromeH)) : 0;
    const ph = chromeH + bodyViewH;

    const dim = 0.82;
    const backdrop = this.add
      .rectangle(cx, cy, L.w, L.h, 0x000000, dim)
      .setDepth(40)
      .setInteractive(); // swallow clicks on the dimmed area
    const panel = this.add.graphics().setDepth(41);
    panel.fillStyle(U.color.surface, 1).fillRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, U.radius.card);
    panel.lineStyle(2, U.color.surfaceStroke, 1).strokeRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, U.radius.card);

    const top = cy - ph / 2 + pad;
    titleTxt.setPosition(cx, top);

    // Scrollable body: clip it to its region with a geometry mask and shift it by
    // _modalScroll. The UI camera is at scroll 0 / zoom 1, so screen px == mask px
    // == text-local px (no coordinate conversion), matching the menu's scroll.
    this._modalBody = bodyTxt;
    this._modalScrollbar = null;
    this._modalScrollMax = 0;
    if (bodyTxt) {
      const bodyTop = top + titleTxt.height + U.space.md;
      const innerLeft = cx - pw / 2 + pad;
      const innerRight = cx + pw / 2 - pad;
      this._modalBodyTop = bodyTop;
      this._modalBodyView = bodyViewH;
      this._modalBodyRight = innerRight;
      this._modalBodyRegion = { left: innerLeft, right: innerRight, top: bodyTop, bottom: bodyTop + bodyViewH };
      this._modalScrollMax = Math.max(0, fullBodyH - bodyViewH);
      this._modalScroll = Phaser.Math.Clamp(this._modalScroll, 0, this._modalScrollMax);

      this._modalMaskGfx = this.make.graphics();
      this._modalMaskGfx.fillStyle(0xffffff, 1).fillRect(innerLeft, bodyTop, innerW, bodyViewH);
      bodyTxt.setMask(this._modalMaskGfx.createGeometryMask());
      bodyTxt.setPosition(cx, bodyTop - this._modalScroll);

      // Scrollbar (right edge of the region), shown only on overflow — like the menu.
      this._modalScrollbar = this.add
        .rectangle(innerRight - 3, bodyTop, 4, 20, 0xffffff, 0.45)
        .setOrigin(0.5, 0.5)
        .setDepth(42)
        .setVisible(false);
    }

    const btnObjs = this._layoutModalButtons(cx, cy + ph / 2 - pad - btnH / 2, buttons);

    this._modalParts = [
      backdrop,
      panel,
      titleTxt,
      ...(bodyTxt ? [bodyTxt] : []),
      ...(this._modalScrollbar ? [this._modalScrollbar] : []),
      ...btnObjs,
    ];
    this.cameras.main.ignore(this._modalParts); // HUD-camera only
    this._updateModalScrollbar(); // size/show the thumb (or leave hidden if it fits)

    for (const part of this._modalParts) {
      const to = part === backdrop ? dim : 1;
      if (animate) {
        part.setAlpha(0);
        this.tweens.add({ targets: part, alpha: to, duration: U.motion.dur, ease: U.motion.ease });
      } else {
        part.setAlpha(to); // resize rebuild: appear at once
      }
    }
  }

  /**
   * A Yes/No confirmation. `Yes` runs `onYes` (which typically restarts or calls
   * {@link _hideConfirm}); `No` just dismisses.
   *
   * @param {string} message @param {() => void} onYes @returns {void}
   */
  _showConfirm(message, onYes) {
    this._openModal({
      title: message,
      buttons: [
        { label: 'Yes', bg: '#2e7d46', onClick: onYes },
        { label: 'No', bg: '#555560', onClick: () => this._hideConfirm() },
      ],
    });
  }

  /**
   * An informational modal with word-wrapped body text and a single "OK" button
   * (used for Help / About). `OK` dismisses, then runs the optional `onOk`.
   *
   * @param {string} title @param {string} body @param {() => void} [onOk]
   * @returns {void}
   */
  _showMessage(title, body, onOk) {
    this._openModal({
      title,
      body,
      warn: false, // info-only: no bonk (the opening control already ticked)
      buttons: [
        {
          label: 'OK',
          bg: '#3a3a44',
          onClick: () => {
            this._hideConfirm();
            onOk?.();
          },
        },
      ],
    });
  }

  /**
   * Create the modal's buttons and centre them as a row at `y`.
   *
   * @param {number} cx @param {number} y
   * @param {Array<{label:string, bg:string, onClick:()=>void}>} buttons
   * @returns {Phaser.GameObjects.Text[]}
   */
  _layoutModalButtons(cx, y, buttons) {
    const gap = Config.ui.space.lg;
    const objs = buttons.map((b) => this._modalButton(0, y, b.label, b.bg, b.onClick));
    const total = objs.reduce((s, o) => s + o.width, 0) + gap * (objs.length - 1);
    let x = cx - total / 2;
    objs.forEach((o) => {
      o.setPosition(x + o.width / 2, y);
      x += o.width + gap;
    });
    return objs;
  }

  /**
   * A pill button for a modal: rounded text with a hover lift, a click sound,
   * and a handler. Returned so the caller can position/group/destroy it.
   *
   * @param {number} x @param {number} y @param {string} label
   * @param {string} bg  CSS background colour. @param {() => void} onClick
   * @returns {Phaser.GameObjects.Text}
   */
  _modalButton(x, y, label, bg, onClick) {
    const btn = this.add
      .text(x, y, label, {
        fontSize: '20px',
        color: '#ffffff',
        backgroundColor: bg,
        padding: { x: 24, y: 8 },
      })
      .setOrigin(0.5)
      .setDepth(42) // above the modal panel (41), matching the modal title
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setAlpha(0.85));
    btn.on('pointerout', () => btn.setAlpha(1));
    btn.on('pointerup', () => {
      sfx.tick();
      onClick();
    });
    return btn;
  }

  /**
   * Dismiss the confirmation modal with no other effect.
   *
   * @returns {void}
   */
  _hideConfirm() {
    if (!this._modalParts) return;
    this._teardownModalParts();
    this._modalSpec = null;
    this._modalOpen = false;
  }

  /**
   * Destroy the modal's display objects and its (off-list) body mask, and clear
   * the scroll drag flags. Shared by {@link _hideConfirm} (close) and the resize
   * path in {@link _onResize} (rebuild). Leaves _modalOpen/_modalSpec alone so a
   * rebuild can reuse the spec.
   *
   * @returns {void}
   */
  _teardownModalParts() {
    if (this._modalParts) for (const part of this._modalParts) part.destroy();
    this._modalParts = null;
    if (this._modalMaskGfx) {
      this._modalMaskGfx.destroy();
      this._modalMaskGfx = null;
    }
    this._modalBody = null;
    this._modalScrollbar = null;
    this._modalDragging = false;
    this._modalScrollbarDragging = false;
  }

  /**
   * Scroll the modal body by `delta` screen pixels, clamped to its range, and
   * reposition the text and scrollbar thumb.
   *
   * @param {number} delta @returns {void}
   */
  _modalScrollBy(delta) {
    if (this._modalScrollMax <= 0 || !this._modalBody) return;
    this._modalScroll = Phaser.Math.Clamp(this._modalScroll + delta, 0, this._modalScrollMax);
    this._modalBody.setPosition(this._modalBody.x, this._modalBodyTop - this._modalScroll);
    this._updateModalScrollbar();
  }

  /**
   * Size/position the modal scrollbar thumb for the current scroll, or hide it
   * when the body fits. Mirrors {@link _updateScrollbar} for the menu.
   *
   * @returns {void}
   */
  _updateModalScrollbar() {
    const bar = this._modalScrollbar;
    if (!bar) return;
    if (this._modalScrollMax <= 0) {
      bar.setVisible(false);
      return;
    }
    const viewH = this._modalBodyView;
    const contentH = viewH + this._modalScrollMax; // = full body height
    const thumbH = Math.max(24, viewH * (viewH / contentH));
    this._modalThumbH = thumbH; // for scrollbar-grab mapping (see pointermove)
    const t = this._modalScroll / this._modalScrollMax;
    const y = this._modalBodyTop + t * (viewH - thumbH);
    bar.setSize(4, thumbH).setPosition(this._modalBodyRight - 3, y + thumbH / 2).setVisible(true);
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if the pointer is in the modal scrollbar grab zone
   *   (the right edge of the body region) while the body actually overflows.
   */
  _overModalScrollbar(p) {
    if (this._modalScrollMax <= 0) return false;
    const r = this._modalBodyRight;
    return (
      p.x >= r - 16 && p.x <= r + 6 && p.y >= this._modalBodyTop && p.y <= this._modalBodyTop + this._modalBodyView
    );
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if the pointer is over the scrollable modal body.
   */
  _overModalBody(p) {
    const reg = this._modalBodyRegion;
    if (!reg) return false;
    return p.x >= reg.left && p.x <= reg.right && p.y >= reg.top && p.y <= reg.bottom;
  }

  // --- Menu / scoreboard --------------------------------------------------

  /**
   * Toggle the menu from the menu button: open if closed, close if showing.
   *
   * @returns {void}
   */
  _toggleMenu() {
    if (this._modalOpen) return; // a confirm is up; let it resolve first
    sfx.tick(); // opening or closing the menu always succeeds
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
    this._scrollbarDragging = false;
    this._buildMenuPanel(); // raises the hamburger above the backdrop when it's clear of the card
    this._showMainMenu();
  }

  /**
   * Decide how the hamburger stacks against the open menu card. When the card
   * doesn't reach the button (roomy screens), raise it above the backdrop so a
   * second tap closes the menu (see _toggleMenu). When the card overlaps it (a
   * short screen, where the card nearly fills the height), leave it at its normal
   * HUD depth so the card covers it cleanly instead of the lit icon bleeding on
   * top — closing is via the card's × there. Called from {@link _buildMenuPanel}
   * so it's recomputed on every resize/rotation too. Restored by _closeMenu.
   *
   * @returns {void}
   */
  _raiseMenuButton() {
    const c = this._menuCard;
    const b = this.menuButton.getBounds();
    const covered = Phaser.Geom.Intersects.RectangleToRectangle(
      b,
      new Phaser.Geom.Rectangle(c.x, c.y, c.w, c.h)
    );
    if (covered) {
      // Under the card now: normal depth, and clear any hover state so it can't
      // light up or flash its tooltip through the menu.
      this.menuButton.setDepth(10).setAlpha(0.8);
      this.menuTooltip.setVisible(false);
    } else {
      this.menuButton.setDepth(33); // above the depth-30 backdrop so it stays clickable
    }
  }

  /**
   * Re-render the current menu view on the NEXT tick (not inside the current
   * pointer event, which would destroy the row being tapped and can leave the
   * drag-scroll flag stuck). Also clears the drag flags immediately as a belt.
   *
   * @returns {void}
   */
  _rerenderMenu() {
    this._menuDragging = false;
    this._scrollbarDragging = false;
    this.time.delayedCall(0, () => {
      if (!this._menuOpen) return;
      if (this._menuView === 'detail') this._showPackDetail(this._menuDetail, this._detailFrom);
      else if (this._menuView === 'packs') this._showPacksAvailable();
      else this._showMainMenu();
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
   * Build the menu chrome (modal-style, depth 30-32): a dimming backdrop, a
   * rounded card, a fixed header (title + close, plus Lab/Test toggles when
   * Config.devTools), a hidden Back button, and a mask-clipped scrollable
   * content container. Mirrors _showConfirm's camera/cleanup pattern. The list
   * itself is filled by _showMainMenu / _showPackDetail.
   *
   * @returns {void}
   */
  _buildMenuPanel(animate = true) {
    const U = Config.ui;
    const L = this._layout;
    const cw = Math.min(440, L.w - 2 * L.pad);
    const ch = Math.min(L.h - 2 * L.pad, 560);
    const cx0 = (L.w - cw) / 2;
    const cy0 = (L.h - ch) / 2;
    this._menuCard = { x: cx0, y: cy0, w: cw, h: ch };
    this._raiseMenuButton(); // keep the hamburger clickable-to-close, unless the card covers it

    const backdrop = this.add
      .rectangle(L.w / 2, L.h / 2, L.w, L.h, 0x000000, 0.6)
      .setDepth(30)
      .setInteractive(); // swallow clicks on the dimmed area
    const card = this.add.graphics().setDepth(31);
    card.fillStyle(U.color.surface, 1).fillRoundedRect(cx0, cy0, cw, ch, U.radius.card);
    card.lineStyle(2, U.color.surfaceStroke, 1).strokeRoundedRect(cx0, cy0, cw, ch, U.radius.card);
    // Title text set per view (_showMainMenu / _showPackDetail).
    this._menuTitle = this.add.text(cx0 + 16, cy0 + 16, '', U.type.title).setDepth(32);
    const close = this._devButton(
      cx0 + cw - 20,
      cy0 + 22,
      '×',
      () => this._closeMenu(),
      '#c0392b',
      '#e74c3c'
    ).setDepth(32);

    // Shared menu tooltip (above the content, below modals). Hover/press-driven
    // via _attachTooltip; destroyed with the menu.
    this._uiTip = this.add
      .text(0, 0, '', { fontSize: '14px', color: '#ffffff', backgroundColor: '#000000', padding: { x: 8, y: 5 } })
      .setOrigin(0, 1)
      .setDepth(34)
      .setVisible(false);

    this._menuParts = [backdrop, card, this._menuTitle, close, this._uiTip];
    this._attachTooltip(close, 'Close the menu.');

    this._menuHeaderBottom = cy0 + 46;
    this._menuCardBottom = cy0 + ch;
    this._menuListX = cx0 + 16;
    this._menuListW = cw - 32;
    // Back affordance (only shown in a pack's detail view). The list starts below
    // it there, but higher in the main menu where there's no Back (see
    // _setMenuListArea), so the main menu doesn't waste that space.
    this._menuBackBtn = this._devButton(cx0 + 16, this._menuHeaderBottom + 16, '‹ Back', () =>
      this._menuBack()
    )
      .setOrigin(0, 0.5)
      .setDepth(32)
      .setVisible(false);
    this._attachTooltip(this._menuBackBtn, 'Go back.');
    this._menuParts.push(this._menuBackBtn);

    // Scroll viewport: a geometry mask (off-display-list make.graphics) clips a
    // content container we shift vertically. The uiCamera is at scroll 0/zoom 1,
    // so screen px == mask px == container-local px (no coordinate conversion).
    this._menuScroll = 0;
    this._menuScrollMax = 0;
    this._menuMaskGfx = this.make.graphics();
    this._menuContent = this.add.container(this._menuListX, 0).setDepth(32);
    this._menuContent.setMask(this._menuMaskGfx.createGeometryMask());
    this._menuParts.push(this._menuContent);
    this._setMenuListArea(false); // establishes listTop/H + the mask rect

    // Scrollbar indicator (right edge of the viewport). Shown only when the
    // content overflows; sized/positioned by _updateScrollbar. Not in the
    // content container, so it stays put while the list scrolls.
    this._menuScrollbar = this.add
      .rectangle(this._menuListX + this._menuListW - 3, this._menuListTop, 4, 20, 0xffffff, 0.45)
      .setOrigin(0.5, 0.5)
      .setDepth(32)
      .setVisible(false);
    this._menuParts.push(this._menuScrollbar);

    this.cameras.main.ignore(this._menuParts); // HUD-camera only (like _showConfirm)

    for (const part of this._menuParts) {
      const to = part === backdrop ? 0.6 : 1;
      if (animate) {
        part.setAlpha(0);
        this.tweens.add({ targets: part, alpha: to, duration: 130, ease: 'Sine.Out' });
      } else {
        part.setAlpha(to); // resize rebuild: appear at once
      }
    }
  }

  /**
   * Rebuild the whole menu against the current layout (window resize / device
   * rotation): tear down the old chrome + content, rebuild without animating, and
   * re-run the current view, preserving the view/detail/scroll state. See
   * {@link _finishMenuContent}, which skips its fade and restores the scroll while
   * a rebuild is in progress.
   *
   * @returns {void}
   */
  _rebuildMenu() {
    const savedScroll = this._menuScroll;
    const view = this._menuView;
    const detail = this._menuDetail;
    const from = this._detailFrom;
    // Tear down the current overlay.
    this._menuContent.clearMask(true);
    this._menuMaskGfx.destroy();
    for (const part of this._menuParts) part.destroy();
    this._menuDragging = false;
    this._scrollbarDragging = false;
    // Rebuild chrome (no fade), then repopulate the same view with scroll kept.
    this._buildMenuPanel(false);
    this._restoreScroll = savedScroll; // consumed by _finishMenuContent
    if (view === 'detail') this._showPackDetail(detail, from);
    else if (view === 'packs') this._showPacksAvailable();
    else this._showMainMenu();
  }

  /**
   * Set the scrollable list's vertical area based on whether the Back row is
   * shown: the main menu (no Back) starts higher, reclaiming that space; a pack
   * detail view starts below the Back button. Updates the mask rect and the
   * content origin. Call from each view before populating it.
   *
   * @param {boolean} withBack @returns {void}
   */
  _setMenuListArea(withBack) {
    const listTop = this._menuHeaderBottom + (withBack ? 34 : 10);
    this._menuListTop = listTop;
    // Floor the height so an extremely short screen can't collapse the mask.
    this._menuListH = Math.max(44, this._menuCardBottom - 14 - listTop);
    this._menuMaskGfx
      .clear()
      .fillStyle(0xffffff)
      .fillRect(this._menuListX, listTop, this._menuListW, this._menuListH);
    this._menuContent.y = listTop - this._menuScroll;
  }

  /**
   * The main menu view: dev toggles (Lab/Test), Help & About, the current pack's
   * info + Details, and the "All packs" list. Only the current pack's level count
   * is known here (from boot); other packs show just name + total score from
   * local storage (no probing), deferring their level count to Pack details.
   *
   * @returns {Promise<void>}
   */
  _showMainMenu() {
    if (!this._menuOpen) return; // may be deferred (see the Lab/Test toggles)
    this._menuView = 'main';
    this._menuTitle.setText('Main Menu');
    this._menuBackBtn.setVisible(false);
    this._menuScroll = 0;
    this._setMenuListArea(false); // no Back here: start the list higher
    this._clearMenuContent();
    let y = 0;

    // Standard menu items first, with About last (as is conventional). Packs
    // Available sits high, right after Help.
    y += this._menuRow(y, 'Help', '›', {
      onTap: () => this._showMessage('How to play', HELP_TEXT),
      tip: 'How to play, and how scoring works.',
    });
    y += this._menuRow(y, 'Packs Available', '›', {
      onTap: () => this._showPacksAvailable(),
      tip: 'Browse all packs and their scores; open one to jump between levels.',
    });
    y += this._menuRow(y, 'Show title screen', '›', {
      // Clear the skip flag so this (and the next boot) lands on the title, then
      // switch scenes. Both scenes are always registered (see main.js).
      onTap: () => {
        setSkipTitle(false);
        this.scene.start('title');
      },
      tip: 'Replay the intro title screen.',
    });
    y += this._menuRow(y, 'About', '›', {
      onTap: () => this._showMessage('About', ABOUT_TEXT),
      tip: 'Credits and the tools behind the game.',
    });
    y += this._menuRow(y, 'Report a problem', '›', {
      onTap: () => diag.showReport(),
      tip: 'Copy a problem report to send to David.',
    });

    // Everything below About is the "different" stuff: the current-pack section,
    // then the developer-only Lab/Test toggles tucked at the very bottom.
    y += this._menuDivider(y);
    y += this._menuSectionHeader(y, 'Current pack');
    y += this._packInfoRows(y, activePackName(), levelCount(), true);
    y += this._menuContentButton(y, 'Details', {
      danger: false,
      onTap: () => this._showPackDetail(activePackManifest(), 'main'),
      tip: 'See every level in this pack and your best on each.',
    });

    if (Config.devTools) {
      y += this._menuDivider(y);
      y += this._menuToggleRow(y);
    }

    this._finishMenuContent(y);
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
    if (!this._menuOpen) return;
    this._menuView = 'packs';
    this._menuTitle.setText('Packs Available');
    this._menuBackBtn.setVisible(true);
    this._menuScroll = 0;
    this._setMenuListArea(true); // has Back
    this._clearMenuContent();
    const U = Config.ui;
    let y = 0;
    const packs = await listPacks();
    if (!this._menuOpen || this._menuView !== 'packs') return; // closed/changed mid-fetch
    for (const { id, name } of packs) {
      const { total, completed } = scores.packTotal(id);
      const isCurrent = id === activePackId();
      y += this._menuRow(y, isCurrent ? `${name}  ★` : name, completed > 0 ? String(total) : '-', {
        valueColor: U.color.accentText,
        onTap: async () => {
          const m = await loadPackManifest(id);
          if (this._menuOpen) this._showPackDetail(m, 'packs');
        },
        tip:
          (isCurrent ? "★ marks the pack you're currently playing. " : '') +
          "Open to see this pack's details. The number is your total best score across it ('-' if you haven't cleared any).",
      });
    }
    this._finishMenuContent(y);
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
    y += this._menuRow(y, 'Pack name', packName, {
      ...compact,
      current: isCurrent,
      valueColor: U.color.text,
      tip: isCurrent ? "The name of the pack you're currently playing" : 'The name of this pack',
    });
    y += this._menuRow(y, 'Levels', String(count), { ...compact, tip: 'Number of levels in this pack.' });
    y += this._menuRow(y, 'Completed', String(completed), {
      ...compact,
      tip: "Levels in this pack you've cleared at least once.",
    });
    y += this._menuRow(y, 'Pack total', completed > 0 ? String(total) : '-', {
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
    this._menuTitle.setText('Pack details');
    this._menuBackBtn.setVisible(true);
    this._menuScroll = 0;
    this._setMenuListArea(true); // leave room for the Back button
    this._clearMenuContent();
    const U = Config.ui;
    const isCurrentPack = manifest.id === activePackId();
    let y = 0;

    y += this._menuSectionHeader(y, 'Pack');
    y += this._packInfoRows(y, manifest.name, manifest.levelIds.length, isCurrentPack);

    y += this._menuDivider(y);
    y += this._menuSectionHeader(y, 'Levels');
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
      y += this._menuRow(y, `Level ${i + 1}`, value, {
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
    y += this._menuContentButton(y, 'Forget pack scores', {
      danger: true,
      enabled: hasScores,
      onTap: () => this._confirmForgetPack(manifest),
      tip: hasScores
        ? "Erase your saved best scores for this pack. This can't be undone."
        : 'No saved scores in this pack to forget yet.',
    });
    this._finishMenuContent(y);
  }

  /**
   * A section header row (uppercase, muted) added to the scrollable content.
   *
   * @param {number} y @param {string} text @returns {number} Space consumed.
   */
  _menuSectionHeader(y, text) {
    const t = this.add
      .text(2, y + 16, text.toUpperCase(), Config.ui.type.header)
      .setOrigin(0, 0.5);
    this._menuContent.add(t);
    return 30;
  }

  /**
   * A thin divider rule added to the scrollable content, with padding around it.
   *
   * @param {number} y @returns {number} Space consumed.
   */
  _menuDivider(y) {
    const U = Config.ui;
    const g = this.add
      .rectangle(0, y + U.space.sm, this._menuListW, 1, U.color.divider, U.color.dividerAlpha)
      .setOrigin(0, 0);
    this._menuContent.add(g);
    return U.space.md;
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
        selectLevel(0).then(() => this.scene.restart()); // level 0 is already loaded
        return;
      }
      if (inThisPack) {
        this._refreshPackBest(); // scores cleared -> pack total back to "-"
        this._refreshHud(); // -> "Best: -"
      }
      this._hideConfirm();
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

  /**
   * One menu list row (added to the scrollable content container): a subtle
   * background, a left label, and a right-aligned value. If `onTap` is given the
   * row is interactive (with an off-clip guard, since masks don't clip input).
   *
   * @param {number} localY  Top of the row in container-local space.
   * @param {string} label
   * @param {string} value  Right-aligned value ('' to omit).
   * @param {{onTap?:(()=>void)|null, enabled?:boolean, valueColor?:string,
   *   current?:boolean, tip?:string|null, rowH?:number, fontSize?:string}} [opts]
   * @returns {number} The row height (so callers can advance `y`).
   */
  _menuRow(localY, label, value, opts = {}) {
    const U = Config.ui;
    const {
      onTap = null,
      enabled = true,
      valueColor = U.color.textMuted,
      current = false,
      tip = null,
      rowH = 44, // compact info rows pass a smaller height
      fontSize = '17px',
    } = opts;
    const w = this._menuListW;
    const midY = localY + (rowH - 6) / 2;
    const bg = this.add
      .rectangle(0, localY, w, rowH - 6, U.color.row, U.color.rowAlpha)
      .setOrigin(0, 0);
    const parts = [bg];
    // "You are here" accent bar on the left edge.
    if (current) parts.push(this.add.rectangle(0, localY, 3, rowH - 6, U.color.accent, 1).setOrigin(0, 0));
    parts.push(
      this.add
        .text(14, midY, label, { fontSize, color: enabled ? U.color.text : U.color.textDisabled })
        .setOrigin(0, 0.5)
    );
    if (value) {
      parts.push(
        // Top/bottom padding gives the text canvas room: Phaser under-measures
        // emoji height (✓/★/🔒), so without it the glyph's top is clipped.
        this.add
          .text(w - 12, midY, value, { fontSize, color: valueColor, padding: { top: 6, bottom: 6 } })
          .setOrigin(1, 0.5)
      );
    }
    this._menuContent.add(parts);
    if (onTap || tip) bg.setInteractive(onTap ? { useHandCursor: true } : {});
    if (tip) this._attachTooltip(bg, tip);
    if (onTap) {
      bg.on('pointerover', () => bg.setFillStyle(U.color.row, U.color.rowHoverAlpha));
      bg.on('pointerout', () => bg.setFillStyle(U.color.row, U.color.rowAlpha));
      this._wireTap(bg, onTap);
    }
    return rowH;
  }

  /**
   * Wire a tap handler onto a menu content object, with the shared guards: ignore
   * a scrollbar grab, an off-clip (scrolled-out) press, or a drag-scroll; play the
   * click sound. Used by every tappable menu element.
   *
   * @param {Phaser.GameObjects.GameObject} obj @param {() => void} onTap
   * @returns {void}
   */
  _wireTap(obj, onTap) {
    obj.on('pointerup', (p) => {
      if (this._scrollbarDragging) return; // grabbing the scrollbar, not tapping
      if (p.y < this._menuListTop || p.y > this._menuListTop + this._menuListH) return; // scrolled out
      if (Math.abs(p.y - this._menuDownY) > 6) return; // a drag-scroll, not a tap
      sfx.tick();
      onTap();
    });
  }

  /**
   * A single row holding the Lab and Test dev toggles side by side (each a
   * tappable half with its On/Off state), so they don't cost two full rows.
   *
   * @param {number} localY @returns {number} Row height.
   */
  _menuToggleRow(localY) {
    const U = Config.ui;
    const rowH = 44;
    const half = this._menuListW / 2;
    const midY = localY + (rowH - 6) / 2;
    const cell = (x0, label, on, tip, onTap) => {
      const bg = this.add.rectangle(x0, localY, half - 3, rowH - 6, U.color.row, U.color.rowAlpha).setOrigin(0, 0);
      const lbl = this.add.text(x0 + 12, midY, label, { fontSize: '16px', color: U.color.text }).setOrigin(0, 0.5);
      const val = this.add
        .text(x0 + half - 3 - 12, midY, on ? 'On' : 'Off', {
          fontSize: '16px',
          color: on ? U.color.accentText : U.color.textMuted,
        })
        .setOrigin(1, 0.5);
      this._menuContent.add([bg, lbl, val]);
      bg.setInteractive({ useHandCursor: true });
      this._attachTooltip(bg, tip);
      bg.on('pointerover', () => bg.setFillStyle(U.color.row, U.color.rowHoverAlpha));
      bg.on('pointerout', () => bg.setFillStyle(U.color.row, U.color.rowAlpha));
      this._wireTap(bg, onTap);
    };
    cell(0, 'Lab', this._devOpen, 'Developer tool: show a panel to live-tune slingshot and physics values.', () => {
      this._toggleDevPanel();
      this._rerenderMenu();
    });
    cell(half, 'Test', this._testMode, "Test mode: unlock every level and jump freely, ignoring the normal 'win to advance' rule.", () => {
      this._testMode = !this._testMode;
      this.registry.set('testMode', this._testMode);
      this._rerenderMenu();
    });
    return rowH;
  }

  /**
   * A centered button inside the scrollable content. `danger` styles it red
   * (destructive, e.g. "Forget pack scores"); otherwise neutral gray (e.g.
   * "Details"). Disabled = grayed and inert (a tooltip still shows). Same
   * off-clip / drag-vs-tap guards as _menuRow.
   *
   * @param {number} localY  Top of the button in container-local space.
   * @param {string} label
   * @param {{onTap?:(()=>void)|null, enabled?:boolean, tip?:string|null, danger?:boolean}} [opts]
   * @returns {number} The vertical space the button occupies.
   */
  _menuContentButton(localY, label, opts = {}) {
    const U = Config.ui;
    const { onTap = null, enabled = true, tip = null, danger = false } = opts;
    const h = 32;
    const cx = this._menuListW / 2;
    const midY = localY + h / 2;
    const base = danger ? (enabled ? U.color.danger : U.color.dangerOff) : 0x3a3a44;
    const hover = danger ? U.color.dangerHover : 0x50505a;
    const rect = this.add
      .rectangle(cx, midY, Math.min(240, this._menuListW), h, base, 1)
      .setOrigin(0.5);
    const txt = this.add
      .text(cx, midY, label, { fontSize: '15px', color: enabled ? '#ffffff' : '#777' })
      .setOrigin(0.5);
    this._menuContent.add([rect, txt]);
    const tappable = enabled && onTap;
    if (tappable || tip) rect.setInteractive(tappable ? { useHandCursor: true } : {});
    if (tip) this._attachTooltip(rect, tip);
    if (tappable) {
      rect.on('pointerover', () => rect.setFillStyle(hover, 1));
      rect.on('pointerout', () => rect.setFillStyle(base, 1));
      this._wireTap(rect, onTap);
    }
    return h;
  }

  /**
   * Wire a hover/press tooltip onto an interactive game object, using the shared
   * menu tooltip (`_uiTip`) and the on-screen floating-label placement.
   *
   * @param {Phaser.GameObjects.GameObject} target @param {string} text
   * @returns {void}
   */
  _attachTooltip(target, text) {
    const show = () => this._showUiTip(text);
    const hide = () => this._hideUiTip();
    target.on('pointerover', show);
    target.on('pointerdown', show);
    target.on('pointerout', hide);
    target.on('pointerup', hide);
  }

  /** Show the shared menu tooltip near the pointer, word-wrapped and on-screen. */
  _showUiTip(text) {
    if (!this._uiTip) return;
    const p = this.input.activePointer;
    // Masks don't clip input, so a scrolled-off row's hit area can leak outside
    // the card; only show a tooltip when the pointer is actually over the card.
    if (this._menuCard && !this._overMenuPanel(p)) return;
    const maxW = Math.min(320, this.scale.width - 40);
    this._uiTip.setWordWrapWidth(maxW, true).setText(text).setVisible(true);
    this._placeFloatingLabel(this._uiTip, p.x, p.y);
  }

  /** Hide the shared menu tooltip. */
  _hideUiTip() {
    if (this._uiTip) this._uiTip.setVisible(false);
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
    // On a resize rebuild (_restoreScroll set), keep the prior scroll and don't
    // re-fade; on a normal open/navigation, start at the current scroll and fade.
    const rebuilding = this._restoreScroll != null;
    const target = rebuilding ? this._restoreScroll : this._menuScroll;
    this._restoreScroll = null;
    this._menuScroll = Phaser.Math.Clamp(target, 0, this._menuScrollMax);
    this._menuContent.y = this._menuListTop - this._menuScroll;
    this.cameras.main.ignore(this._menuContent); // re-walk: new children too
    if (!rebuilding) {
      this._menuContent.setAlpha(0);
      this.tweens.add({ targets: this._menuContent, alpha: 1, duration: 150, ease: 'Sine.Out' });
    }
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
    this._menuThumbH = thumbH; // for scrollbar-grab mapping (see _overScrollbar)
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

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if the pointer is in the scrollbar grab zone (the
   *   right edge of the list) while the list actually overflows.
   */
  _overScrollbar(p) {
    if (this._menuScrollMax <= 0) return false;
    const right = this._menuListX + this._menuListW;
    return (
      p.x >= right - 16 &&
      p.x <= right + 6 &&
      p.y >= this._menuListTop &&
      p.y <= this._menuListTop + this._menuListH
    );
  }

  /** Tear down the menu overlay (mirrors _hideConfirm). */
  _closeMenu() {
    if (!this._menuOpen) return;
    this._menuContent.clearMask(true);
    this._menuMaskGfx.destroy();
    for (const part of this._menuParts) part.destroy();
    this._menuParts = null;
    this._menuContent = null;
    this._uiTip = null; // was destroyed with _menuParts
    this._menuOpen = false;
    this._menuDragging = false;
    this._scrollbarDragging = false;
    this._restoreScroll = null;
    this._menuRebuildPending = false;
    if (this._menuRebuildTimer) {
      this._menuRebuildTimer.remove();
      this._menuRebuildTimer = null;
    }
    this.menuButton.setDepth(10).setAlpha(0.8); // restore normal HUD depth/look
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
      if (this._modalOpen) {
        // Modal owns input; its buttons handle their own taps. A press in the body
        // (or on its scrollbar) starts a drag-scroll when the body overflows.
        if (this._modalScrollMax > 0) {
          if (this._overModalScrollbar(p)) {
            this._modalScrollbarDragging = true;
            this._modalDragLastY = p.y;
          } else if (this._overModalBody(p)) {
            this._modalDragging = true;
            this._modalDragLastY = p.y;
          }
        }
        return;
      }
      if (this._menuOpen) {
        // The menu backdrop swallows game input; a press on the list starts a
        // drag-scroll (its own buttons handle their taps). _menuDownY lets a row
        // tell a tap from a drag (see _menuRow).
        this._menuDownY = p.y;
        // Grabbing the scrollbar drags the thumb (direct); grabbing the list body
        // drags the content (natural). Both track from the grab point (no jump).
        if (this._overScrollbar(p)) {
          this._scrollbarDragging = true;
          this._menuDragLastY = p.y;
        } else if (this._overMenuPanel(p)) {
          this._menuDragging = true;
          this._menuDragLastY = p.y;
        }
        return;
      }
      if (this._pinchDist) return; // a two-finger pinch owns the gesture
      if (p.y < this._hudHeight) return; // press is on the HUD ribbon, not the arena
      if (this._overDevPanel(p)) return; // press is on the dev panel

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
      // Keep an open entity-info label floating with the pointer, on-screen.
      if (this._infoEntity) this._placeEntityInfo(p.x, p.y);
      if (this._modalOpen) {
        if (this._modalScrollbarDragging) {
          // Thumb drag: move the thumb WITH the pointer (down -> content down).
          const range = this._modalBodyView - (this._modalThumbH || 0);
          if (range > 0) this._modalScrollBy(((p.y - this._modalDragLastY) * this._modalScrollMax) / range);
          this._modalDragLastY = p.y;
        } else if (this._modalDragging) {
          this._modalScrollBy(this._modalDragLastY - p.y); // content drag: natural (inverted)
          this._modalDragLastY = p.y;
        }
        return;
      }
      if (this._menuOpen) {
        if (this._scrollbarDragging) {
          // Thumb drag: move the thumb WITH the pointer (down -> content down).
          const range = this._menuListH - (this._menuThumbH || 0);
          if (range > 0) this._menuScrollBy(((p.y - this._menuDragLastY) * this._menuScrollMax) / range);
          this._menuDragLastY = p.y;
        } else if (this._menuDragging) {
          this._menuScrollBy(this._menuDragLastY - p.y); // content drag: natural (inverted)
          this._menuDragLastY = p.y;
        }
        return;
      }
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

    this.input.on('pointerup', () => {
      if (this._modalOpen) {
        this._modalDragging = false;
        this._modalScrollbarDragging = false;
        return;
      }
      if (this._menuOpen) {
        this._menuDragging = false;
        this._scrollbarDragging = false;
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
    });

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
        this.hideEntityInfo(this._infoEntity);
        this._refreshHud(); // "X's turn, aiming"
      }
      this.brothers.dragTo(dragX, dragY);
    });

    // Laptop: mouse wheel zooms toward the cursor.
    this.input.on('wheel', (p, _over, _dx, dy) => {
      if (this._modalOpen) {
        this._modalScrollBy(dy); // wheel scrolls the modal body, not the arena
        return;
      }
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
      this.hideEntityInfo(this._infoEntity);
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
   * Show a world entity's info label (its name/class) near the pointer while the
   * player hovers or presses it. The wording comes from the entity
   * ({@link import('../world/Entity.js').Entity#infoText}), so it lives in one
   * place. Called from `Entity._enableInfo`.
   *
   * @param {import('../world/Entity.js').Entity} entity
   * @returns {void}
   */
  showEntityInfo(entity) {
    if (this._modalOpen || this._menuOpen || this._infoSuppressed) return; // suppressed / overlay owns the screen
    const p = this.input.activePointer;
    this._infoEntity = entity;
    // Cap the width and word-wrap so a long name (e.g. "Teleport Target from
    // Region 1 to 2 (Teleporter)") can't be wider than the screen — it uses more
    // lines instead. _placeEntityInfo then keeps the whole box on-screen.
    const maxW = Math.min(360, this.scale.width - 40);
    this.entityInfoText.setWordWrapWidth(maxW, true).setText(entity.infoText()).setVisible(true);
    this._placeEntityInfo(p.x, p.y);
  }

  /** Place the entity info label near the pointer, fully on-screen. */
  _placeEntityInfo(px, py) {
    this._placeFloatingLabel(this.entityInfoText, px, py);
  }

  /**
   * Position an origin-(0,1) label near the pointer but fully on-screen: prefer
   * above-right, flip to the roomier side of an edge (left / below), then clamp
   * so the whole box stays within the viewport. The label's text (and wrap) must
   * already be set so its size is known. Shared by the entity info label and the
   * menu tooltip.
   *
   * @param {Phaser.GameObjects.Text} t
   * @param {number} px @param {number} py  Pointer position (screen px).
   * @returns {void}
   */
  _placeFloatingLabel(t, px, py) {
    const pad = 6;
    const W = this.scale.width;
    const H = this.scale.height;
    const w = t.width; // includes the label's own padding
    const h = t.height;
    let x = px + 14;
    if (x + w > W - pad) x = px - 14 - w; // flip left
    let top = py - 8 - h;
    if (top < pad) top = py + 14; // flip below
    x = Phaser.Math.Clamp(x, pad, Math.max(pad, W - pad - w));
    top = Phaser.Math.Clamp(top, pad, Math.max(pad, H - pad - h));
    t.setPosition(x, top + h); // origin (0,1): position is the box's bottom-left
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
    this._stopCameraGlide(); // manual zoom cancels an in-progress settle pan/zoom
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
   * Called once both balls have settled. Decide win / lose / next turn.
   *
   * @returns {void}
   */
  _resolveTurn() {
    this._frameBrothers(); // gently zoom/pan so both balls are fully framed at rest
    const reached = this.world.firstReached(this.brothers);
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
    if (this.status === 'ENDED') {
      text = 'Game Ended';
      color = '#9aa0a6';
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
  }
}
