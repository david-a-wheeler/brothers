import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import { currentIndex, levelCount, activePackName, levelName } from '../levels.js';

/**
 * The fixed top-of-screen HUD: the ribbon (turn prompt, Pack/Best/#Left stats,
 * nav/restart/menu icons, status flag) plus the end-of-level banner and the
 * attract glow. Owns building, laying out (1/2/3-row responsive breakpoints),
 * and refreshing every HUD element; gameplay state stays on the scene, which
 * this reads (status, phase, movesLeft, aim sub-state) and calls back into for
 * actions (confirms, level navigation, restarts).
 *
 * All objects are created at construction (during the scene's create), so they
 * are covered by the UI camera's ignore snapshot in _setupCameras; the scene
 * exposes them to that snapshot via {@link Hud#objects}.
 */
export class Hud {
  /**
   * @param {import('../scenes/GameScene.js').GameScene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** Cached HUD text measurements (see {@link _hudTextMetrics}). */
    this._hudTextW = null;
    /** HUD icon the attract glow is tracking (null = not attracting). */
    this._attractTarget = null;
    /** The status icon's tooltip label; kept current by _refreshStatusIcon. */
    this._statusLabel = '';
    this._computeLayout(); // sets this._layout + this._hudHeight for the build
    this._build();
  }

  /** @returns {number} Height of the HUD ribbon in screen pixels. */
  get height() {
    return this._hudHeight;
  }

  /**
   * @returns {Phaser.GameObjects.GameObject[]} Every HUD display object, for
   * the UI camera's ignore snapshot (see the scene's _setupCameras).
   */
  get objects() {
    return [
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
      this.levelText,
      this.menuButton,
      this.bannerPanel,
      this.banner,
    ];
  }

  /**
   * Reflow to the current window size: recompute the layout metrics, then
   * position/size every element. Called on resize/rotation (via the scene's
   * _onResize).
   *
   * @returns {void}
   */
  relayout() {
    this._computeLayout();
    this.layout();
  }

  /**
   * Show the end-of-level banner (pop in, then gently breathe) and draw the
   * eye to the appropriate HUD icon: on a win with a next level, Next ("go
   * on"); otherwise Restart ("try again"). Split from the scene's _endGame,
   * which owns the gameplay side of ending a level.
   *
   * @param {string} message @param {string} color  Banner text and colour.
   * @param {boolean} won
   * @returns {void}
   */
  showEnd(message, color, won) {
    // Banner: pop the panel + text in, then let the text gently breathe. No
    // instruction text — an icon animates instead (see _attract).
    this.banner.setText(message).setColor(color);
    for (const o of [this.bannerPanel, this.banner]) o.setScale(0).setVisible(true);
    this.scene.tweens.add({
      targets: [this.bannerPanel, this.banner],
      scale: 1,
      duration: 460,
      ease: 'Back.Out',
      onComplete: () => {
        this.scene.tweens.add({
          targets: this.banner,
          scale: 1.05,
          duration: 950,
          ease: 'Sine.InOut',
          yoyo: true,
          repeat: -1,
        });
      },
    });
    const goNext = won && currentIndex() < levelCount() - 1;
    this._attract(goNext ? this.nextButton : this.restartButton);
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
    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
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
        const probe = this.scene.add.text(0, 0, '', { fontSize: size }).setVisible(false);
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
  layout() {
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
      this.scene.tweens.killTweensOf(ic); // drop any in-flight hover scale before re-sizing
      ic.setDisplaySize(L.iconSize, L.iconSize).setPosition(startX + i * L.gap, iconRowY);
      // Remember the layout-driven resting scale so the hover lift is relative to
      // it (and aspect-correct), not an absolute factor.
      ic.setData('baseSX', ic.scaleX);
      ic.setData('baseSY', ic.scaleY);
    });

    // The level number trails the status flag (the last icon). Both its size and
    // its offset are derived from the icon size rather than hard-coded, so it
    // keeps its relationship to the flag if that size is ever changed. It sits
    // outside the evenly-spaced cluster on purpose: it's a label on the flag,
    // not a sixth icon competing for a slot.
    this.levelText.setFontSize(Math.round(L.iconSize * 0.62));
    this.levelText.setPosition(this.statusIcon.x + L.iconSize * 0.7, iconRowY);

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

    this.scene.lab?.rebuild(); // keep the Lab panel fitted to the resized screen (no-op when closed)
  }

  /**
   * Position the right-hand Pack/Best/#Left stats (and their tooltips) as one
   * group: right-aligned to the edge in wide/compact, centred on its own row in
   * narrow. Laid out right-to-left from each entry's current width, so it reflows
   * as the values change. Each tooltip is centred under its stat, just below the
   * HUD, and clamped to stay on-screen. Called from {@link layout} (resize)
   * and {@link refresh} (value change).
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
    this.scene.tip.attach(target, textOrFn, {
      place: 'anchor',
      anchorY: () => this._hudHeight + 6,
      hideOnUp: true,
      // No HUD tips while an overlay owns the screen (the HUD analog of
      // _infoAllowed). Matters for the menu button, which stays raised and
      // hoverable above the backdrop while the menu is open.
      clip: () => !this.scene._modalOpen && !this.scene._menuOpen,
    });
  }


  /**
   * On-screen text: turns remaining, whose turn, the restart button, and the
   * centre banner.
   *
   * @returns {void}
   */
  _build() {
    // Opaque panel behind the HUD so the arena never shows through the top
    // strip while panning/zooming. Created first (and at depth 9, under the
    // depth-10 HUD text) and rendered by the fixed UI camera, so it always
    // covers the same screen strip regardless of the world camera.
    // Initial positions/sizes here are placeholders; layout() positions and
    // sizes every HUD element authoritatively for the current screen.
    const h = this._hudHeight;
    this.hudBar = this.scene.add
      .rectangle(Config.view.width / 2, h / 2, Config.view.width, h, 0x0e0e12, 1)
      .setDepth(9);
    this.hudBorder = this.scene.add
      .rectangle(Config.view.width / 2, h, Config.view.width, 2, 0x3a3a44, 1)
      .setOrigin(0.5, 1)
      .setDepth(9);

    this.turnText = this.scene.add.text(20, 18, '', { fontSize: '22px' }).setDepth(10).setInteractive();
    // A general explanation of the left-hand entry, revealed on hover/press. Kept
    // deliberately state-agnostic ("play state" covers non-turn conditions like
    // game over).
    this._attachHudTip(this.turnText, 'Active brother and current play state');
    this.turnText.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    // Right-hand stats — Pack / Best / #Left — each its own interactive text with
    // a hover/press tooltip (see _buildHudStat), laid out as a right-aligned group
    // by _layoutRightGroup and filled with values in refresh(). The pack name is
    // fixed for the scene (switching packs restarts it), so it's baked in here.
    this.packText = this._buildHudStat(`Total best results of current pack (${activePackName()})`);
    this.bestText = this._buildHudStat(
      'Best result on this level: the most turns ever left when you won'
    );
    this.leftText = this._buildHudStat('Turns left in the current game');

    // Restart button: the clockwise-arrow icon, vertically centred in the
    // ribbon. Clicking opens a confirmation modal (see _showConfirm).
    this.restartButton = this.scene.add
      .image(Config.view.width / 2, h / 2, 'icon-restart')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });

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
      if (this.scene.status === 'ENDED') this.scene.scene.restart();
      else this.scene._showConfirm('Restart Level?', () => this.scene.scene.restart());
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
    this.statusIcon = this.scene.add
      .image(Config.view.width / 2 + 2 * gap, h / 2, 'icon-ready')
      .setDepth(10)
      .setInteractive();
    // The label reflects `status`; _refreshStatusIcon keeps it current and the
    // tooltip reads it fresh on each reveal.
    this._statusLabel = '';
    this._attachHudTip(this.statusIcon, () => this._statusLabel);
    this.statusIcon.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router

    // The level number, immediately right of the status flag: "which level am I
    // on" is asked far more often than it's answered by the menu. Left-origin so
    // it hangs off the flag rather than being centred on a cluster slot, and it
    // rides the icon row (positioned in layout(), since the icon size varies).
    // Read-only, like the flag: interactive only so it can carry a tooltip.
    this.levelText = this.scene.add
      .text(0, 0, '', Config.ui.type.stat)
      .setOrigin(0, 0.5)
      .setDepth(10)
      .setInteractive();
    this._attachHudTip(this.levelText, () => this._levelLabel());
    this.levelText.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router

    // Menu button (hamburger): opens the dropdown of less-used options and the
    // pack/level scoreboard. Laid out at the FRONT of the cluster in layout().
    // Actionable, so it gets a hand cursor.
    this.menuButton = this.scene.add
      .image(Config.view.width / 2 - 2 * gap, h / 2, 'icon-menu')
      .setDepth(10)
      .setAlpha(0.8)
      .setInteractive({ useHandCursor: true });
    this._attachHudTip(this.menuButton, 'Open main menu');
    this.menuButton.on('pointerover', () => this._iconLift(this.menuButton));
    this.menuButton.on('pointerout', () => this._iconRest(this.menuButton, 0.8, true));
    this.menuButton.on('pointerdown', (_p, _x, _y, e) => e?.stopPropagation()); // don't reach the aim/pan router
    this.menuButton.on('pointerup', () => {
      this.scene.gameMenu.toggle(); // open, or close if already showing (button is raised above the backdrop)
    });

    // A glow ring pulsed on game-over to draw the eye to a HUD icon (restart, or
    // next level on a win); repositioned to the target icon (see _attract).
    this.attractGlow = this.scene.add
      .circle(Config.view.width / 2, h / 2, 22, 0xffffff, 0)
      .setStrokeStyle(3, 0xffd479, 0.9)
      .setDepth(9)
      .setVisible(false);

    // End-of-level banner: a dim backing panel plus bold, shadowed, coloured
    // text. Both hidden until _endGame shows and animates them.
    this.bannerPanel = this.scene.add
      .rectangle(Config.view.width / 2, Config.view.height / 2, 520, 110, 0x000000, 0.55)
      .setOrigin(0.5)
      .setDepth(9)
      .setVisible(false);
    this.banner = this.scene.add
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
   * {@link refresh} / {@link _layoutRightGroup}).
   *
   * @param {string} tooltipText  The explanation shown on hover/press.
   * @returns {Phaser.GameObjects.Text}  the stat text
   */
  _buildHudStat(tooltipText) {
    const stat = this.scene.add
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
    const icon = this.scene.add
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
      const wonCurrent = this.scene.registry.get(this.scene._bestKey) != null;
      if (!wonCurrent && !this.scene._testMode) return ' (Locked)';
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
    const wonCurrent = this.scene.registry.get(this.scene._bestKey) != null;
    return hasNext && (wonCurrent || this.scene._testMode);
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
    this.scene.tweens.killTweensOf(icon);
    const f = Config.ui.motion.hoverScale;
    this.scene.tweens.add({
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
    this.scene.tweens.killTweensOf(icon);
    const sx = icon.getData('baseSX') ?? icon.scaleX;
    const sy = icon.getData('baseSY') ?? icon.scaleY;
    if (animate) {
      this.scene.tweens.add({
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
    if (this.scene.status === 'PLAYING') {
      this.scene._showConfirm('Abandon current game?', () => this.scene._goToLevel(target));
    } else {
      this.scene._goToLevel(target);
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
    return this.scene.status !== 'READY';
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
   * The level-number tooltip: "Pack Base Level 3", plus a second line carrying
   * the level's name when it has one. Computed on each reveal rather than
   * cached, because the pack and level both change as the player navigates.
   *
   * @returns {string}
   */
  _levelLabel() {
    const where = `Pack ${activePackName()} Level ${currentIndex() + 1}`;
    const name = levelName(this.scene.level);
    return name ? `${where},\n${name}` : where;
  }

  /**
   * Update the read-only lifecycle indicator (glyph, colour, tooltip) to match
   * `this.scene.status`. Called wherever the status can change.
   *
   * @returns {void}
   */
  _refreshStatusIcon() {
    const byStatus = {
      READY: { key: 'icon-ready', tint: 0xd6b25e, label: 'Ready: not started' },
      PLAYING: { key: 'icon-playing', tint: 0x7cfc8a, label: 'Playing: in progress' },
      ENDED: { key: 'icon-ended', tint: 0x9aa0a6, label: 'Ended: level finished' },
    };
    const s = byStatus[this.scene.status];
    this.statusIcon.setTexture(s.key).setTint(s.tint);
    this._statusLabel = s.label;
  }


  /**
   * Tear down the end-of-level display: stop and hide the banner, its backing
   * panel, and the attract glow/heartbeat, restoring the highlighted icon to
   * its normal size. Used when resuming play via {@link _moreTurns}.
   *
   * @returns {void}
   */
  clearEndDisplay() {
    this.scene.tweens.killTweensOf([this.banner, this.bannerPanel, this.attractGlow]);
    if (this._attractTarget) {
      this.scene.tweens.killTweensOf(this._attractTarget);
      this._attractTarget = null;
    }
    for (const o of [this.banner, this.bannerPanel, this.attractGlow]) o.setVisible(false);
    this.layout(); // restore the heart-beated icon to its normal size
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
    // the screen position it had when the pulse started. See layout().
    this._attractTarget = icon;
    this.attractGlow
      .setPosition(icon.x, icon.y)
      .setVisible(true)
      .setScale(1)
      .setAlpha(0.9);
    this.scene.tweens.add({
      targets: this.attractGlow,
      scale: 2,
      alpha: 0,
      duration: 950,
      ease: 'Sine.Out',
      repeat: -1,
    });
    this.scene.tweens.add({
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
  refresh() {
    const launcher = this.scene.brothers.launcher;
    // Ended: a neutral "Game Ended". In flight: "Moving" in the launching
    // ball's colour. Otherwise: prompt for the current aimer's turn.
    let text;
    let color;
    if (this.scene._godDrag) {
      // Outranks even "Game Ended": god mode works after the level is over, and
      // the prompt should say what the drag is doing.
      text = 'God mode: moving the brothers';
      color = this.scene._godDrag.color;
    } else if (this.scene.status === 'ENDED') {
      text = 'Game Ended';
      color = '#9aa0a6';
    } else if (this.scene.phase === 'RESOLVING') {
      // The mud-shed shimmy is playing. This phase only lingers while at least
      // one brother is shaking off mud (a mud-free settle passes through it
      // synchronously), and either or both may be shimmying — so a neutral,
      // brother-agnostic white message rather than one launcher's colour.
      text = 'Shaking off mud';
      color = '#ffffff';
    } else if (this.scene.phase === 'MOVING') {
      text = 'Moving';
      color = launcher.color;
    } else if (this.scene._pinDragging) {
      // Unusual swap: the HUD normally names the launcher (the current player),
      // but while fine-dragging the pin it names the ANCHOR whose pin is moving.
      const anchor = this.scene.brothers.anchor;
      text = `Moving ${anchor.name}'s pin`;
      color = anchor.color;
    } else {
      // AIMING: the prompt tracks the grab sub-state (and, while dragging,
      // whether the current spot is launchable).
      const prompt =
        this.scene._aimState === 'dragging'
          ? this.scene._aimBlocked
            ? "can't do that"
            : 'aiming'
          : this.scene._aimState === 'grabbed'
            ? 'grabbed'
            : 'drag to aim';
      text = `${launcher.name}'s turn, ${prompt}`;
      color = launcher.color;
    }
    this.turnText.setText(text).setColor(color);
    const best = this.scene.registry.get(this.scene._bestKey);
    const pack = this.scene._packBest == null ? '-' : this.scene._packBest;
    this.packText.setText(`Pack: ${pack}`);
    this.bestText.setText(`Best: ${best == null ? '-' : best}`);
    this.leftText.setText(`#Left: ${this.scene.movesLeft}`);
    this.levelText.setText(String(currentIndex() + 1));
    this._layoutRightGroup(); // widths changed -> reflow the group
    this._refreshResetButton();
    this._refreshNavButtons();
    this._refreshStatusIcon();
    this.scene.lab?.refreshRows(); // the brothers' mud turns tick down as the game runs
  }
}
