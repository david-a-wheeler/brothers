import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import {
  currentIndex,
  currentLevelKey,
  levelCount,
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
import { clearIntroSeen } from '../intros.js';
import * as scores from '../scores.js';
import { setSkipTitle } from '../prefs.js';
import { Menu } from './Menu.js';

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
 * The in-game menu and its views: the main menu, the Packs Available list, and
 * the per-pack details/scoreboard. Owns the {@link Menu} overlay shell (which
 * the scene's input routes pointer/wheel events to — see `this.menu`) and every
 * view's rows; game actions (confirms, restarts, test mode, the Lab) call back
 * into the scene, which stays the owner of gameplay state.
 *
 * The Menu's objects are built lazily on show() (after the UI camera's ignore
 * snapshot); this class supplies the view content and navigation callbacks.
 */
export class GameMenu {
  /**
   * @param {import('../scenes/GameScene.js').GameScene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** Which view is showing: 'main', 'packs', or 'detail'. */
    this._view = 'main';
    /** The manifest whose details are showing (view === 'detail'). */
    this._detail = null;
    /** Which view opened the detail view, for Back: 'main' or 'packs'. */
    this._detailFrom = 'main';
    /** Resize-throttle state (see {@link scheduleRebuild}). */
    this._rebuildPending = false;
    this._rebuildTimer = null;

    /** The menu/scoreboard {@link Menu} overlay shell. */
    this.menu = new Menu(scene, {
      render: () => this._renderView(),
      onBack: () => this._back(),
      onLayout: () => this._raiseButton(),
    });
    this.menu.onHidden = () => this._onHidden();
  }

  /** @returns {boolean} true while the menu overlay is open. */
  get isOpen() {
    return this.menu.open;
  }

  /**
   * Toggle the menu from the menu button: open if closed, close if showing.
   *
   * @returns {void}
   */
  toggle() {
    if (this.scene._activeModal) return; // a confirm is up; let it resolve first
    sfx.tick(); // opening or closing the menu always succeeds
    if (this.menu.open) this.close();
    else this.open();
  }

  /**
   * Open the menu overlay (no-op if a confirm or the menu is up). Content and
   * navigation come from _renderView (the Menu's `render` callback); the
   * hamburger is restacked against the card by _raiseButton (its `onLayout`).
   *
   * @returns {void}
   */
  open() {
    if (this.menu.open || this.scene._activeModal) return;
    this._view = 'main'; // a fresh open always lands on the main menu
    this.menu.show();
  }

  /** Close the menu overlay (its onHidden restores the hamburger). */
  close() {
    this.menu.hide();
  }

  /**
   * Throttled menu rebuild for a window resize: respond to the first resize
   * immediately (leading edge), then coalesce further events into at most one
   * rebuild per ~30ms so a burst (a device rotation, a window drag) stays
   * responsive without thrashing. A trailing tick after the last event captures
   * the settled size.
   *
   * @returns {void}
   */
  scheduleRebuild() {
    this._rebuildPending = true;
    if (this._rebuildTimer) return; // already within a throttle window
    const tick = () => {
      if (!this._rebuildPending) {
        this._rebuildTimer = null; // burst ended
        return;
      }
      this._rebuildPending = false;
      if (this.menu.open) this.menu.rebuild();
      this._rebuildTimer = this.scene.time.delayedCall(30, tick);
    };
    tick(); // leading: rebuild now, then throttle
  }

  /**
   * Menu `onHidden` hook: restore the hamburger's normal HUD depth/look and cancel
   * any pending throttled rebuild. Runs however the menu closes (× or hamburger).
   *
   * @returns {void}
   */
  _onHidden() {
    const scene = this.scene;
    scene.hud.menuButton.setDepth(10);
    scene.hud._iconRest(scene.hud.menuButton, 0.8, false);
    this._rebuildPending = false;
    if (this._rebuildTimer) {
      this._rebuildTimer.remove();
      this._rebuildTimer = null;
    }
  }

  /**
   * Decide how the hamburger stacks against the open menu card. When the card
   * doesn't reach the button (roomy screens), raise it above the backdrop so a
   * second tap closes the menu (see {@link toggle}). When the card overlaps it (a
   * short screen, where the card nearly fills the height), leave it at its normal
   * HUD depth so the card covers it cleanly instead of the lit icon bleeding on
   * top — closing is via the card's × there. Runs after each menu (re)build (the
   * Menu's `onLayout`), so it tracks resizes/rotations. Restored by _onHidden.
   *
   * @returns {void}
   */
  _raiseButton() {
    const scene = this.scene;
    const c = this.menu.card;
    const b = scene.hud.menuButton.getBounds();
    const covered = Phaser.Geom.Intersects.RectangleToRectangle(
      b,
      new Phaser.Geom.Rectangle(c.x, c.y, c.w, c.h)
    );
    if (covered) {
      // Under the card now: normal depth, and clear any hover state so it can't
      // light up or flash its tooltip through the menu.
      scene.hud.menuButton.setDepth(10);
      scene.hud._iconRest(scene.hud.menuButton, 0.8, false);
      scene.tip.hide();
    } else {
      scene.hud.menuButton.setDepth(33); // above the depth-30 backdrop so it stays clickable
    }
  }

  /**
   * Re-render the current menu view on the NEXT tick (not inside the current
   * pointer event, which would destroy the row being tapped). Used by the dev
   * toggles and after forgetting scores.
   *
   * @returns {void}
   */
  rerender() {
    this.scene.time.delayedCall(0, () => {
      if (this.menu.open) this._renderView();
    });
  }

  /**
   * The Back button's destination, which depends on the current view: Packs
   * Available goes to the main menu; Pack details goes back to whichever view
   * opened it (main menu or Packs Available).
   *
   * @returns {void}
   */
  _back() {
    if (this._view === 'detail' && this._detailFrom === 'packs') this._showPacksAvailable();
    else this._showMainMenu();
  }

  /**
   * (Re)draw the current menu view into the menu body. Passed to the {@link Menu}
   * as its `render` callback, so it runs on open, on navigation, and on a resize
   * rebuild (which the Menu makes scroll-preserving).
   *
   * @returns {void}
   */
  _renderView() {
    if (this._view === 'detail') this._showPackDetail(this._detail, this._detailFrom);
    else if (this._view === 'packs') this._showPacksAvailable();
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
    if (!this.menu.open) return; // may be deferred (see the Lab/Test toggles)
    const scene = this.scene;
    this._view = 'main';
    this.menu.setTitle('Main Menu');
    this.menu.beginView(false); // no Back here: start the list higher
    let y = 0;

    // Standard menu items first, with About last (as is conventional). Packs
    // Available sits high, right after Help.
    y += this.menu.row(y, 'Help', '›', {
      onTap: () => scene._showMessage('How to play', HELP_TEXT),
      tip: 'How to play, and how scoring works.',
    });
    const hasIntro = !!levelIntro(scene.level);
    y += this.menu.row(y, 'See level intro', '›', {
      enabled: hasIntro,
      // Re-show the intro: clear its seen flag (so quitting mid-read re-shows it),
      // close the menu, then open it.
      onTap: hasIntro
        ? () => {
            clearIntroSeen(currentLevelKey());
            this.close();
            scene._showLevelIntro();
          }
        : null,
      tip: hasIntro ? "Re-read this level's intro." : 'This level has no intro.',
    });
    y += this.menu.row(y, 'Packs Available', '›', {
      onTap: () => this._showPacksAvailable(),
      tip: 'Browse all packs and their scores; open one to jump between levels.',
    });
    y += this.menu.row(y, 'Show title screen', '›', {
      // Clear the skip flag so this (and the next boot) lands on the title, then
      // switch scenes. Both scenes are always registered (see main.js).
      onTap: () => {
        setSkipTitle(false);
        scene.scene.start('title');
      },
      tip: 'Replay the intro title screen.',
    });
    y += this.menu.row(y, 'About', '›', {
      onTap: () => scene._showMessage('About', ABOUT_TEXT),
      tip: 'Credits and the tools behind the game.',
    });
    y += this.menu.row(y, 'Report a problem', '›', {
      onTap: () => scene._showReport(),
      tip: 'Copy a problem report to send to David.',
    });

    // Everything below About is the "different" stuff: the current-pack section,
    // then the developer-only Lab/Test toggles tucked at the very bottom.
    y += this.menu.divider(y);
    y += this.menu.sectionHeader(y, 'Current pack');
    y += this._packInfoRows(y, activePackName(), levelCount(), true);
    y += this.menu.button(y, 'Details', {
      danger: false,
      onTap: () => this._showPackDetail(activePackManifest(), 'main'),
      tip: 'See every level in this pack and your best on each.',
    });

    if (Config.devTools) {
      y += this.menu.divider(y);
      y += this.menu.toggleRow(
        y,
        {
          label: 'Lab',
          on: scene.lab.open,
          tip: 'Developer tool: show a panel to live-tune slingshot and physics values.',
          onTap: () => {
            scene.lab.toggle();
            this.rerender();
          },
        },
        {
          label: 'Test',
          on: scene._testMode,
          tip:
            "Test mode: unlock every level and jump freely, ignoring the normal 'win to advance' rule. " +
            'Also enables god mode; right-drag either brother to move the pair anywhere.',
          onTap: () => {
            scene._setTestMode(!scene._testMode);
            this.rerender();
          },
        }
      );
    }

    this.menu.finish(y);
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
    if (!this.menu.open) return;
    this._view = 'packs';
    this.menu.setTitle('Packs Available');
    this.menu.beginView(true); // has Back
    const U = Config.ui;
    let y = 0;
    const packs = await listPacks();
    if (!this.menu.open || this._view !== 'packs') return; // closed/changed mid-fetch
    for (const { id, name } of packs) {
      const { total, completed } = scores.packTotal(id);
      const isCurrent = id === activePackId();
      y += this.menu.row(y, isCurrent ? `${name}  ★` : name, completed > 0 ? String(total) : '-', {
        valueColor: U.color.accentText,
        onTap: async () => {
          const m = await loadPackManifest(id);
          if (this.menu.open) this._showPackDetail(m, 'packs');
        },
        tip:
          (isCurrent ? "★ marks the pack you're currently playing. " : '') +
          "Open to see this pack's details. The number is your total best score across it ('-' if you haven't cleared any).",
      });
    }
    this.menu.finish(y);
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
    y += this.menu.row(y, 'Pack name', packName, {
      ...compact,
      current: isCurrent,
      valueColor: U.color.text,
      tip: isCurrent ? "The name of the pack you're currently playing" : 'The name of this pack',
    });
    // The loaded level lives in this pack (always so from the main menu): name it.
    if (isCurrent) {
      const n = currentIndex() + 1;
      const nm = levelName(this.scene.level);
      y += this.menu.row(y, 'Current level', nm ? `${nm} (${n})` : String(n), {
        ...compact,
        valueColor: U.color.text,
        tip: nm ? `You're on "${nm}" — level ${n} of this pack.` : `You're on level ${n} of this pack.`,
      });
    }
    y += this.menu.row(y, 'Levels', String(count), { ...compact, tip: 'Number of levels in this pack.' });
    y += this.menu.row(y, 'Completed', String(completed), {
      ...compact,
      tip: "Levels in this pack you've cleared at least once.",
    });
    y += this.menu.row(y, 'Pack total', completed > 0 ? String(total) : '-', {
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
   * from (see {@link _back}).
   *
   * @param {{id:string, name:string, levelIds:string[]}} manifest
   * @param {'main'|'packs'} [from]  Which view opened this (for Back).
   * @returns {void}
   */
  _showPackDetail(manifest, from = 'main') {
    const scene = this.scene;
    this._view = 'detail';
    this._detail = manifest;
    this._detailFrom = from;
    this.menu.setTitle('Pack details');
    this.menu.beginView(true); // leave room for the Back button
    const U = Config.ui;
    const isCurrentPack = manifest.id === activePackId();
    let y = 0;

    y += this.menu.sectionHeader(y, 'Pack');
    y += this._packInfoRows(y, manifest.name, manifest.levelIds.length, isCurrentPack);

    y += this.menu.divider(y);
    y += this.menu.sectionHeader(y, 'Levels');
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
      y += this.menu.row(y, `Level ${i + 1}`, value, {
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
    y += this.menu.button(y, 'Forget pack scores', {
      danger: true,
      enabled: hasScores,
      onTap: () => this._confirmForgetPack(manifest),
      tip: hasScores
        ? "Erase your saved best scores for this pack. This can't be undone."
        : 'No saved scores in this pack to forget yet.',
    });
    this.menu.finish(y);
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
    const scene = this.scene;
    scene._showConfirm(`Forget scores for pack ${manifest.name}?`, () => {
      const keys = manifest.levelIds.map((f) => `${manifest.id}/${f}`);
      scores.forget(keys); // clear persisted scores
      const inThisPack = manifest.id === activePackId();
      if (inThisPack) {
        // Also clear the in-memory registry, which cached this session's bests;
        // otherwise the HUD "Best:" (and the restart hydration) would keep
        // showing the old numbers instead of "-".
        for (const k of keys) scene.registry.set(`best:${k}`, null);
      }
      if (!scene._testMode && inThisPack && currentIndex() > 0) {
        this.close();
        selectLevel(0).then(() => scene.scene.restart()); // level 0 is already loaded
        return;
      }
      if (inThisPack) {
        scene._refreshPackBest(); // scores cleared -> pack total back to "-"
        scene.hud.refresh(); // -> "Best: -"
      }
      this._showPackDetail(manifest, this._detailFrom); // re-render: scores cleared, button shaded
    });
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
    if (this.scene._testMode) return true;
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
    const scene = this.scene;
    const proceed = async () => {
      this.close();
      if (manifest.id !== activePackId()) await loadPack(manifest.id);
      await selectLevel(index);
      scene.scene.restart();
    };
    if (scene.status === 'PLAYING') scene._showConfirm('Abandon current game?', proceed);
    else proceed();
  }
}
