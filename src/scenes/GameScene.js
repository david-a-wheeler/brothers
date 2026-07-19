import { Config } from '../config.js';
import { Brothers, FACES } from '../Brothers.js';
import { Brother } from '../world/Brother.js';
import { Hazard } from '../world/Hazard.js';
import { sfx } from '../Sfx.js';
import {
  currentLevel,
  currentLevelKey,
  currentIndex,
  selectLevel,
  activePackName,
  activePackManifest,
  levelName,
  levelIntro,
} from '../levels.js';
import { introSeen, markIntroSeen } from '../intros.js';
import * as scores from '../scores.js';
import { World } from '../world/World.js';
import { KINDS } from '../world/registry.js';
import { labOpen, setTestMode, testMode } from '../prefs.js';
import * as diag from '../diag.js';
import { Modal } from '../ui/Modal.js';
import { CameraRig } from './CameraRig.js';
import { Hud } from '../ui/Hud.js';
import { GameMenu } from '../ui/GameMenu.js';
import { Lab } from '../ui/Lab.js';
import { Tooltip } from '../ui/Tooltip.js';

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

    // Level assets: any world-object class may declare `static preloadAssets`
    // to queue external files for its defs (today: Item images). The level
    // model is already fetched by main.js before the game boots — and by
    // selectLevel before any scene.restart — so it's readable here, and this
    // re-runs on every restart/level switch (each class guards for idempotence).
    const level = currentLevel();
    for (const [kind, Cls] of Object.entries(KINDS)) {
      Cls.preloadAssets?.(
        this,
        level.objects.filter((d) => d.kind === kind)
      );
    }
  }

  /**
   * @returns {void}
   */
  create() {
    // Take over physics stepping so we can sub-step (see update()); Matter's
    // own per-frame step would otherwise run once at the full frame delta.
    this.matter.world.autoUpdate = false;

    // A restart reuses this scene instance, so camRig would still point at the
    // *previous* run's (now discarded) cameras while we rebuild the world. Drop it
    // up front so every pre-rig assignToWorld behaves the same on a restart as it
    // does on a cold boot: a no-op, covered by the rig's snapshot.
    this.camRig = null;

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
    // before the CameraRig so its label is in the UI-camera list. Call sites are
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
    /** The floating name label for hovered/pressed arena entities is the shared
     *  Tooltip service (this.tip); Entity._enableInfo attaches to it. This flag
     *  suppresses it while dragging the launcher/pin, to keep the aim uncluttered
     *  and the launcher's face visible (read by the entity attach's clip). */
    this._infoSuppressed = false;
    /** Last finger-spread distance while pinch-zooming (0 = not pinching). */
    this._pinchDist = 0;
    /** True between an anchor pointerdown and pointerup while editing its pin. */
    this._pinning = false;
    /** True once a pin press has been promoted to a fine-drag (drives the HUD). */
    this._pinDragging = false;
    /** God mode: the brother currently held by a right-button drag (null = none). */
    this._godDrag = null;
    /** Both brothers' positions when that drag began, to revert an illegal drop. */
    this._godStart = null;
    /** Camera-pan drag state. */
    this._isPanning = false;
    this._panLast = { x: 0, y: 0 };
    /** Open modal overlays (Modal/Menu), innermost last: the top owns all input. */
    this._modalStack = [];
    /** Open modeless overlays (the Lab panel): each owns input only over itself. */
    this._panels = [];
    /** Test mode: relaxes menu click-to-jump to allow any level, and enables
     *  god mode. Persisted in prefs, so it survives a reload, not just a restart. */
    this._testMode = testMode();

    // Seed this level's best from persistent storage so "Best:" and the
    // win-to-advance nav rule survive a page reload (registry is per-session).
    if (!this.registry.has(this._bestKey)) {
      this.registry.set(this._bestKey, scores.bestFor(currentLevelKey()));
    }
    // Cached pack total (sum of bests across this pack) shown in the HUD. It only
    // changes on a new best or when scores are forgotten, so it's recomputed at
    // those points (see _refreshPackBest) — never per frame.
    this._refreshPackBest();

    /** The fixed top-of-screen HUD (see {@link Hud}): computes the responsive
     *  layout, then builds every ribbon/banner element. */
    this.hud = new Hud(this);
    // The Lab tuning panel (dev tool). Only its Panel shell is created here; its
    // display objects build lazily on show(), after the UI camera snapshot.
    this.lab = new Lab(this);
    // The menu/scoreboard overlay and its views (see GameMenu). Its objects are
    // built lazily on show(), after the UI camera's ignore snapshot.
    this.gameMenu = new GameMenu(this);
    this._wireInput();
    this._wireCollisions();
    this.camRig = new CameraRig(this); // creates cameras + ignore lists, then lays them out
    this.hud.layout(); // position/size every HUD element for the current screen
    // The Lab panel builds its objects lazily (like the menu/modal) so they land
    // after the UI camera's ignore snapshot. Restore a persisted-open panel here.
    if (labOpen()) this.lab.show();
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
    this.hud.refresh();
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
  /** @returns {object|undefined} The HUD layout metrics ({@link Hud#_computeLayout}).
   *  Overlays (Modal/Menu/Panel) and the cameras size themselves from it, so the
   *  scene keeps this accessor even though the {@link Hud} owns the data. */
  get _layout() {
    return this.hud?._layout;
  }

  /** @returns {number} Height of the HUD ribbon in screen pixels (the input
   *  router's "press is on the HUD, not the arena" guard; the Lab's anchor). */
  get _hudHeight() {
    return this.hud?.height ?? 0;
  }

  /**
   * Assign a display object (or array) to the fixed UI camera only (see
   * {@link CameraRig#assignToUI}). Kept on the scene because overlay/UI code
   * calls it as `scene.assignToUI(obj)`; all such calls happen after the rig
   * exists (overlays build lazily on show).
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToUI(obj) {
    this.camRig?.assignToUI(obj);
  }

  /**
   * Assign a display object (or array) to the world camera only (see
   * {@link CameraRig#assignToWorld}). Kept on the scene because shared world
   * code calls it as `scene.assignToWorld?.(obj)` — a no-op on scenes with no
   * rig (the title), and before the rig exists (covered by its snapshot).
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToWorld(obj) {
    this.camRig?.assignToWorld(obj);
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
   * Reflow everything to the new window size (window resize / device rotation).
   *
   * @returns {void}
   */
  _onResize() {
    // Guarded: this runs inside Phaser's resize step, so an unhandled throw here
    // kills the render loop (blank/frozen screen). Log it and carry on instead.
    try {
      this.hud.relayout();
      this.camRig.layout(false);
      // An open menu / modal was sized for the old screen; reflow to the new one.
      // A resize or rotation fires a BURST of events, so we respond to the
      // first event (leading throttle),
      // then coalesence later events for a short period of time.
      // This is better for responsiveness than traditional debouncing and/or
      // waitng for things to settle, because
      // that can introduce a perceptable lack of responsiveness.
      // Menu rebuild takes some time, so we handle it specially.
      // The modal is cheap, so reflow it at once for responsiveness.
      if (this._menuOpen) this.gameMenu.scheduleRebuild();
      // Modals are cheap: reflow each at once (rebuild preserves its scroll).
      for (const o of this._modalStack) o.rebuild();
    } catch (e) {
      diag.error('game resize', e);
    }
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
      this.hud.clearEndDisplay();
      this.brothers.swapRoles(); // clean next-turn handoff: faces, glow, refreeze
      this.world.notifyPlayStart(); // re-arm bombs frozen by the level end
    }
    this.hud.refresh();
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
    return !!this.gameMenu && this.gameMenu.isOpen;
  }

  /**
   * Overlay router hook: an overlay just opened. Any open cancels a camera pan.
   * A modal joins the input-owning stack (and clears any menu scroll-drag left by
   * the press that opened it from a menu row); a modeless panel joins `_panels`;
   * the menu is tracked on its own (`this.gameMenu`), so it needs no list.
   *
   * @param {import('../ui/Overlay.js').Overlay} o @returns {void}
   */
  _overlayOpened(o) {
    this._isPanning = false;
    if (o.role === 'modal') {
      this._modalStack.push(o);
      this.gameMenu?.menu.scrollView?.endDrag(); // opened from a menu row: drop its drag
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
      this.camRig.stopGlide(); // any press cancels an in-progress settle pan/zoom
      // A blocking overlay owns input while up (its buttons handle their own
      // taps); a press starts its scroll drag. Confirms sit above the menu.
      if (this._activeModal) {
        this._activeModal.onPointerDown(p);
        return;
      }
      if (this._menuOpen) {
        this.gameMenu.menu.onPointerDown(p);
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
          // Where to put them back if the drop turns out to be illegal.
          const { david, ken } = this.brothers;
          this._godStart = {
            david: { x: david.go.x, y: david.go.y },
            ken: { x: ken.go.x, y: ken.go.y },
          };
          // Freeze both balls for the drag, so physics can't shove the ungripped
          // one around or stretch the tether while the pointer moves.
          this.brothers.godBeginDrag();
          this._isPanning = false;
          sfx.grab();
          diag.trace('god', 'grab', { who: grabbed.def.name, ...this.brothers.snapshot() });
          this.hud.refresh(); // -> "God mode: moving the brothers"
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
        this.hud.refresh(); // "X's turn, grabbed"
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
        this.gameMenu.menu.onPointerMove(p); // drives its scroll drag, if any
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
        this.camRig.clamp();
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
        this.gameMenu.menu.onPointerUp(p); // ends its scroll drag, if any
        return;
      }
      for (const panel of this._panels) if (panel.onPointerUp(p)) return; // ends its scroll drag
      if (this._godDrag) {
        // The drag went wherever the pointer went; the drop decides what's legal.
        const outcome = this.brothers.godDrop(this._godDrag, this._godStart);
        diag.trace('god', 'drop', {
          who: this._godDrag.def.name,
          outcome,
          ...this.brothers.snapshot(),
        });
        this._godDrag = null;
        this._godStart = null;
        this.hud.refresh(); // back to the normal turn prompt
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
        this.hud.refresh(); // mis-click: no move spent, back to "drag to aim"
        return;
      }

      this.movesLeft -= 1;
      this.status = 'PLAYING'; // first launch leaves READY; later launches keep PLAYING
      this.phase = 'MOVING';
      // Hazards stay inert (and show their preview arrows) until the shot connects
      // — see _kickoff, fired from the first snap in the collision router.
      this.hud.refresh();
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
        this.hud.refresh(); // "X's turn, aiming"
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
        this.gameMenu.menu.onWheel(p, dy); // wheel scrolls the menu list, not the arena
        return;
      }
      for (const panel of this._panels) if (panel.onWheel(p, dy)) return; // scrolls it, not the arena
      const step = Config.zoom.wheelStep;
      this.camRig.zoomBy(dy > 0 ? 1 - step : 1 + step, p.x, p.y);
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
   * Flip Test mode (driven by the menu's Test toggle). Persisted in prefs, so
   * it survives a reload, not just a restart.
   *
   * @param {boolean} on
   * @returns {void}
   */
  _setTestMode(on) {
    this._testMode = on;
    setTestMode(on);
    // Turning Test mode off mid-drag would strand the pair on the pointer
    // — and possibly inside a wall — so resolve the drop as a release would.
    if (!on && this._godDrag) {
      this.brothers.godDrop(this._godDrag, this._godStart);
      this._godDrag = null;
      this._godStart = null;
    }
  }

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
      this.hud.refresh(); // -> "Moving X's pin"
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
      this.hud.refresh(); // back to the normal turn prompt
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
      this.hud.refresh();
    }
    const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    if (this._pinchDist > 0 && dist > 0) {
      this.camRig.zoomBy(dist / this._pinchDist, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
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
            sfx.oof(); // one of the brothers grunts — a random grunt each time
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
            // A solid/pushable Item reacts to being struck (e.g. collects);
            // a wall's inert default handler ignores this.
            other?.onActorContact(bro);
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
        // A dynamic body (a pushable Item) is not a wall: the physics step
        // shoves it aside, and reflecting the hazard too would double-bounce.
        if (!otherBody.isStatic) continue;
        if (!pair.collision) continue; // no normal to reflect off (defensive)
        hazard.noteBounce(pair.collision.normal, otherBody); // wall, arena edge, or solid Item
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
      this.hud.refresh(); // "aiming" <-> "can't do that"
    }
    // Tick any dynamic world objects (culled to the view). No-op today, since
    // all current objects are static/tween-driven; here for future types.
    this.world.update({ brothers: this.brothers, view: this.cameras.main.worldView });
    this._updatePinch();

    if (this.status === 'PLAYING' && this.phase === 'MOVING') {
      this.camRig.keepBallsInView(); // gently pan/zoom only when a ball nears the edge
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
      this.hud.refresh();
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
    this.camRig.frameBrothers(); // gently zoom/pan so both balls are fully framed at rest
    this.phase = 'RESOLVING'; // re-entry guard + "not MOVING" for the settle check
    this.hud.refresh(); // -> "Shaking off mud" while the shimmy plays (if any)
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
    this.hud.refresh();
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
    this.hud.refresh(); // -> "Game Ended" text, reset enabled, ENDED status icon
    this.hud.showEnd(message, color, won); // banner + attract glow on Next/Restart
  }
}
