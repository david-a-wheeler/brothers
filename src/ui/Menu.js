import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import { Overlay } from './Overlay.js';
import { chipButton } from './chipButton.js';

/**
 * The menu / scoreboard overlay: a modal card (backdrop + rounded panel) with a
 * title, close ×, an optional Back button, a shared hover tooltip, and a
 * scrollable list body (via the inherited {@link ScrollView}).
 *
 * This class owns the reusable menu *mechanics* — chrome, scrolling, the row /
 * divider / header / button / toggle builders, tap wiring, and the tooltip. The
 * *views* (which rows, what game data, navigation) live in the scene, wired in
 * through the `render` / `onBack` callbacks: `render` (re)draws the current view
 * into the body, so the same code runs on open, on navigation, and on a resize
 * rebuild.
 *
 * It's modal (blocks the game while up) but the scene tracks it on its own
 * (role 'menu') rather than in the modal stack, so a confirm can still open over
 * it. Depths 30-34 sit below modals (40-42).
 */
export class Menu extends Overlay {
  /**
   * @param {Phaser.Scene} scene
   * @param {{
   *   render: () => (void|Promise<void>),
   *   onBack: () => void,
   *   placeLabel: (label: Phaser.GameObjects.Text, x: number, y: number) => void,
   *   onLayout?: () => void,
   * }} opts  `render` draws the current view; `onBack` handles the Back button;
   *   `placeLabel` positions the tooltip near the pointer; `onLayout` runs after
   *   each (re)build (e.g. to restack the menu button against the card).
   */
  constructor(scene, opts) {
    super(scene, { modal: true, depth: 32 });
    this._opts = opts;
    this.card = { x: 0, y: 0, w: 0, h: 0 };
    // While true (a resize rebuild), a view render keeps its scroll and doesn't
    // re-fade; a normal open/navigation resets to the top and fades in.
    this._preserveScroll = false;
  }

  /** @override */
  get role() {
    return 'menu';
  }

  /** @override — build the card chrome, then draw the current view into it. */
  _build(animate) {
    const U = Config.ui;
    const L = this.scene._layout;
    const add = this.scene.add;
    const cw = Math.min(440, L.w - 2 * L.pad);
    const ch = Math.min(L.h - 2 * L.pad, 560);
    const cx0 = (L.w - cw) / 2;
    const cy0 = (L.h - ch) / 2;
    this.card = { x: cx0, y: cy0, w: cw, h: ch };

    const backdrop = this._backdrop(0.6, 30);
    const card = add.graphics().setDepth(31);
    card.fillStyle(U.color.surface, 1).fillRoundedRect(cx0, cy0, cw, ch, U.radius.card);
    card.lineStyle(2, U.color.surfaceStroke, 1).strokeRoundedRect(cx0, cy0, cw, ch, U.radius.card);
    this._title = add.text(cx0 + 16, cy0 + 16, '', U.type.title).setDepth(32);
    const close = this._closeButton(cx0 + cw - 20, cy0 + 22, 32);

    // Shared hover tooltip (above the content, below modals).
    this._tip = add
      .text(0, 0, '', { fontSize: '14px', color: '#ffffff', backgroundColor: '#000000', padding: { x: 8, y: 5 } })
      .setOrigin(0, 1)
      .setDepth(34)
      .setVisible(false);

    this.parts = [backdrop, card, this._title, close, this._tip];
    this.attachTooltip(close, 'Close the menu.');

    this._headerBottom = cy0 + 46;
    this._cardBottom = cy0 + ch;
    this._listX = cx0 + 16;
    this._listW = cw - 32;
    // Draggable like a window: the card (== this.card) clamps on-screen; the
    // header strip (minus the × zone) is the drag handle.
    this._windowRect = this.card;
    this._titleBar = { x: cx0, y: cy0, w: cw - 44, h: this._headerBottom - cy0 };
    // Back (only shown in a pack's detail / packs view). The list starts below it
    // there, but higher when it's hidden (see beginView) so no space is wasted.
    this._backBtn = chipButton(this.scene, cx0 + 16, this._headerBottom + 16, '‹ Back', () => this._opts.onBack())
      .setOrigin(0, 0.5)
      .setDepth(32)
      .setVisible(false);
    this.attachTooltip(this._backBtn, 'Go back.');
    this.parts.push(this._backBtn);

    this.scene.cameras.main.ignore(this.parts); // HUD camera only
    this._opts.onLayout?.();
    this._fadeIn(animate);
    this._opts.render(); // draw the current view into the (persistent) scroll body
  }

  /** @override — preserve scroll across a resize rebuild (consumed by finish). */
  rebuild() {
    this._preserveScroll = true;
    super.rebuild();
  }

  /** @override — keep the list geometry that beginView/finish read in sync with
   *  the dragged position, so navigating after a drag re-lays-out in place. */
  _afterTranslate(dx, dy) {
    this._headerBottom += dy;
    this._cardBottom += dy;
    this._listX += dx;
  }

  // --- view API (called by the scene's view renderers) --------------------

  /** Set the card's title text. */
  setTitle(text) {
    this._title.setText(text);
  }

  /**
   * Begin drawing a view: show/hide Back (which shifts the list top), clear the
   * old rows, and reset the scroll to the top unless this is a resize rebuild.
   *
   * @param {boolean} withBack @returns {void}
   */
  beginView(withBack) {
    this._backBtn.setVisible(withBack);
    this._listTop = this._headerBottom + (withBack ? 34 : 10);
    // Floor the height so an extremely short screen can't collapse the mask.
    this._listH = Math.max(44, this._cardBottom - 14 - this._listTop);
    if (!this._preserveScroll) this.scrollView.scroll = 0;
    this.scrollView.clear();
  }

  /**
   * Finish a view: set the scroll range for the rows just added, and fade them in
   * (a fresh open/navigation) or snap them (a resize rebuild).
   *
   * @param {number} contentH  Total height of the rows added since {@link beginView}.
   * @returns {void}
   */
  finish(contentH) {
    this.scrollView.layout({ x: this._listX, y: this._listTop, w: this._listW, h: this._listH }, contentH);
    if (!this._preserveScroll) {
      // Fade the freshly-populated list in. Kill any container fade the base
      // _build/_fadeIn already started (its scroll body was still empty then).
      const c = this.scrollView.container;
      this.scene.tweens.killTweensOf(c);
      c.setAlpha(0);
      this.scene.tweens.add({ targets: c, alpha: 1, duration: 150, ease: 'Sine.Out' });
    }
    this._preserveScroll = false;
  }

  // --- list builders (add to the scroll body in local coords) -------------

  /**
   * One list row: a subtle background, a left label, and a right-aligned value.
   * If `onTap` is given the row is interactive.
   *
   * @param {number} localY @param {string} label @param {string} value
   * @param {{onTap?:(()=>void)|null, enabled?:boolean, valueColor?:string,
   *   current?:boolean, tip?:string|null, rowH?:number, fontSize?:string}} [opts]
   * @returns {number} the row height (so callers can advance `y`).
   */
  row(localY, label, value, opts = {}) {
    const U = Config.ui;
    const {
      onTap = null,
      enabled = true,
      valueColor = U.color.textMuted,
      current = false,
      tip = null,
      rowH = 44,
      fontSize = '17px',
    } = opts;
    const add = this.scene.add;
    const w = this._listW;
    const midY = localY + (rowH - 6) / 2;
    const bg = add.rectangle(0, localY, w, rowH - 6, U.color.row, U.color.rowAlpha).setOrigin(0, 0);
    const parts = [bg];
    if (current) parts.push(add.rectangle(0, localY, 3, rowH - 6, U.color.accent, 1).setOrigin(0, 0));
    parts.push(
      add.text(14, midY, label, { fontSize, color: enabled ? U.color.text : U.color.textDisabled }).setOrigin(0, 0.5)
    );
    if (value) {
      parts.push(
        // Top/bottom padding gives the text canvas room: Phaser under-measures
        // emoji height (✓/★/🔒), so without it the glyph's top is clipped.
        add
          .text(w - 12, midY, value, { fontSize, color: valueColor, padding: { top: 6, bottom: 6 } })
          .setOrigin(1, 0.5)
      );
    }
    this.scrollView.add(parts);
    if (onTap || tip) bg.setInteractive(onTap ? { useHandCursor: true } : {});
    if (tip) this.attachTooltip(bg, tip);
    if (onTap) {
      bg.on('pointerover', () => bg.setFillStyle(U.color.row, U.color.rowHoverAlpha));
      bg.on('pointerout', () => bg.setFillStyle(U.color.row, U.color.rowAlpha));
      this.wireTap(bg, onTap);
    }
    return rowH;
  }

  /**
   * A section header row (uppercase, muted).
   *
   * @param {number} localY @param {string} text @returns {number} space consumed.
   */
  sectionHeader(localY, text) {
    const t = this.scene.add.text(2, localY + 16, text.toUpperCase(), Config.ui.type.header).setOrigin(0, 0.5);
    this.scrollView.add(t);
    return 30;
  }

  /**
   * A thin divider rule, with padding around it.
   *
   * @param {number} localY @returns {number} space consumed.
   */
  divider(localY) {
    const U = Config.ui;
    const g = this.scene.add
      .rectangle(0, localY + U.space.sm, this._listW, 1, U.color.divider, U.color.dividerAlpha)
      .setOrigin(0, 0);
    this.scrollView.add(g);
    return U.space.md;
  }

  /**
   * A centered button inside the list. `danger` styles it red (destructive);
   * otherwise neutral gray. Disabled = grayed and inert (a tooltip still shows).
   *
   * @param {number} localY @param {string} label
   * @param {{onTap?:(()=>void)|null, enabled?:boolean, tip?:string|null, danger?:boolean}} [opts]
   * @returns {number} the vertical space the button occupies.
   */
  button(localY, label, opts = {}) {
    const U = Config.ui;
    const { onTap = null, enabled = true, tip = null, danger = false } = opts;
    const add = this.scene.add;
    const h = 32;
    const cx = this._listW / 2;
    const midY = localY + h / 2;
    const base = danger ? (enabled ? U.color.danger : U.color.dangerOff) : 0x3a3a44;
    const hover = danger ? U.color.dangerHover : 0x50505a;
    const rect = add.rectangle(cx, midY, Math.min(240, this._listW), h, base, 1).setOrigin(0.5);
    const txt = add.text(cx, midY, label, { fontSize: '15px', color: enabled ? '#ffffff' : '#777' }).setOrigin(0.5);
    this.scrollView.add([rect, txt]);
    const tappable = enabled && onTap;
    if (tappable || tip) rect.setInteractive(tappable ? { useHandCursor: true } : {});
    if (tip) this.attachTooltip(rect, tip);
    if (tappable) {
      rect.on('pointerover', () => rect.setFillStyle(hover, 1));
      rect.on('pointerout', () => rect.setFillStyle(base, 1));
      this.wireTap(rect, onTap);
    }
    return h;
  }

  /**
   * A single row of two side-by-side on/off toggle cells (so a pair of toggles
   * costs one row, not two).
   *
   * @param {number} localY
   * @param {{label:string, on:boolean, tip:string, onTap:()=>void}} left
   * @param {{label:string, on:boolean, tip:string, onTap:()=>void}} right
   * @returns {number} row height.
   */
  toggleRow(localY, left, right) {
    const U = Config.ui;
    const add = this.scene.add;
    const rowH = 44;
    const half = this._listW / 2;
    const midY = localY + (rowH - 6) / 2;
    const cell = (x0, { label, on, tip, onTap }) => {
      const bg = add.rectangle(x0, localY, half - 3, rowH - 6, U.color.row, U.color.rowAlpha).setOrigin(0, 0);
      const lbl = add.text(x0 + 12, midY, label, { fontSize: '16px', color: U.color.text }).setOrigin(0, 0.5);
      const val = add
        .text(x0 + half - 3 - 12, midY, on ? 'On' : 'Off', {
          fontSize: '16px',
          color: on ? U.color.accentText : U.color.textMuted,
        })
        .setOrigin(1, 0.5);
      this.scrollView.add([bg, lbl, val]);
      bg.setInteractive({ useHandCursor: true });
      this.attachTooltip(bg, tip);
      bg.on('pointerover', () => bg.setFillStyle(U.color.row, U.color.rowHoverAlpha));
      bg.on('pointerout', () => bg.setFillStyle(U.color.row, U.color.rowAlpha));
      this.wireTap(bg, onTap);
    };
    cell(0, left);
    cell(half, right);
    return rowH;
  }

  /**
   * Wire a tap handler onto a list object: ignore the release that ended a
   * scroll-drag (scrolled-out rows are already input-disabled by the ScrollView),
   * play the click sound, then run `onTap`.
   *
   * @param {Phaser.GameObjects.GameObject} obj @param {() => void} onTap @returns {void}
   */
  wireTap(obj, onTap) {
    obj.on('pointerup', () => {
      if (this.dragged) return; // release ended a scroll-drag, not a tap
      sfx.tick();
      onTap();
    });
  }

  // --- tooltip ------------------------------------------------------------

  /**
   * Attach a hover/press tooltip (shared `_tip`) to an interactive object.
   *
   * @param {Phaser.GameObjects.GameObject} target @param {string} text @returns {void}
   */
  attachTooltip(target, text) {
    const show = () => this._showTip(text);
    const hide = () => this._hideTip();
    target.on('pointerover', show).on('pointerdown', show);
    target.on('pointerout', hide).on('pointerup', hide);
  }

  /** Show the shared tooltip near the pointer, word-wrapped and on-screen. */
  _showTip(text) {
    if (!this._tip) return;
    const p = this.scene.input.activePointer;
    // Masks don't clip input, so a scrolled-off row's hit area can leak outside
    // the card; only show a tooltip when the pointer is actually over the card.
    if (!this._overCard(p)) return;
    const maxW = Math.min(320, this.scene.scale.width - 40);
    this._tip.setWordWrapWidth(maxW, true).setText(text).setVisible(true);
    this._opts.placeLabel(this._tip, p.x, p.y);
  }

  /** Hide the shared tooltip. */
  _hideTip() {
    if (this._tip) this._tip.setVisible(false);
  }

  // --- input geometry (Overlay hooks) -------------------------------------

  /** @override — a press anywhere on the card can start a body drag-scroll. */
  _overDragArea(p) {
    return this._overCard(p);
  }

  /** @param {Phaser.Input.Pointer} p @returns {boolean} true if over the card. */
  _overCard(p) {
    const c = this.card;
    return p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h;
  }
}
