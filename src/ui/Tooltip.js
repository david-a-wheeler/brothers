import { Config } from '../config.js';

/** Px the hand/pointer cursor extends below its hotspot. A target-anchored tip
 *  drops this far below the control's bottom edge, so the cursor can't cover it
 *  no matter where in the control the pointer sits (or moves to) while it's up. */
const CURSOR_CLEARANCE = 24;

/** Fast fade-in/out (ms). Snappy so info still appears promptly. */
const FADE_MS = 120;

/**
 * One shared tooltip for a scene, reused across every surface (HUD icons, arena
 * entities, menu rows, Lab controls). Replaces the ~8 per-anchor HUD `Text`s, the
 * arena's `entityInfoText`, and the menu's own `_tip` — one look
 * (`Config.ui.tooltip`), one behavior home.
 *
 * The tip is a small box: a backing `Graphics` (soft drop shadow + rounded fill +
 * hairline border) with the `Text` on top, wrapped in a `Container` (`this.box`)
 * so it positions, fades, and camera-ignores as a unit. Only one is ever visible
 * (you point at one thing), so a single reused box suffices. `attach` owns the
 * hover/press trigger wiring so callers don't re-spell it; button-state feedback
 * (icon brighten/dim) is deliberately NOT here — callers keep their own hover
 * handlers alongside `attach`.
 *
 * Camera note: the box renders in UI space only. The owning scene must add
 * `tip.box` to its HUD-camera list so the world camera ignores it (see
 * GameScene._setupCameras) — otherwise it would draw in the zoomed world.
 *
 * Placement modes:
 *  - `anchor` (default): centred on the target's x, below it (or at a fixed
 *    `anchorY` baseline, e.g. the HUD ribbon), flipping above / clamping on-screen.
 *  - `pointer`: floats near the pointer (above-right, flips to the roomier side,
 *    clamps on-screen) and follows it while visible.
 *
 * Always-on behaviors (universal, not per-context):
 *  - Anti-flicker: a `hide` from any target other than the one currently showing
 *    is ignored, so moving straight from one target to an adjacent one doesn't
 *    blink.
 *  - Touch-hide: a lifted finger hides the tip (touch has no hover); a mouse
 *    keeps it while still hovering and hides on pointer-out.
 */
export class Tooltip {
  /** @param {Phaser.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    /** @type {typeof Config.ui.tooltip} */
    this._tk = Config.ui.tooltip;

    this.bg = scene.add.graphics();
    this.label = scene.add.text(0, 0, '', {
      fontFamily: this._tk.fontFamily,
      fontSize: this._tk.fontSize,
      color: this._tk.color,
    });
    /** The tip box (shadow + fill + text). Add this to the scene's HUD-camera list. */
    this.box = scene.add
      .container(0, 0, [this.bg, this.label])
      .setDepth(Config.ui.depth.tooltip)
      .setAlpha(0)
      .setVisible(false);

    /** Box size for the current text (set by _layout). */
    this._bw = 0;
    this._bh = 0;
    /** Target that last requested a show (anti-flicker token). @type {?object} */
    this._owner = null;
    /** @type {'anchor'|'pointer'} Placement of the visible tip. */
    this._place = 'anchor';
    /** @type {?(number|(() => number))} Anchor-mode baseline y for the visible tip. */
    this._anchorY = undefined;
    /** @type {?Phaser.GameObjects.GameObject} Anchor-mode target for reposition. */
    this._target = null;
    /** When false, shows are ignored and any visible tip is hidden. */
    this._enabled = true;

    // Keep a pointer-placed tip glued to the moving pointer while it's visible.
    this._onMove = (p) => {
      if (this.box.visible && this._place === 'pointer') this._reposition(p);
    };
    scene.input.on('pointermove', this._onMove);
    scene.events.once('shutdown', () => scene.input.off('pointermove', this._onMove));
  }

  /**
   * Wire hover/press tooltip triggers onto an already-interactive object.
   *
   * @param {Phaser.GameObjects.GameObject} target  Must already be interactive.
   * @param {string | (() => string)} textOrFn  Static text, or a function
   *   returning it fresh on each show (for dynamic labels).
   * @param {{ place?: 'anchor'|'pointer', anchorY?: number|(() => number),
   *           clip?: (p: Phaser.Input.Pointer) => boolean, hideOnUp?: boolean,
   *           maxWidth?: number }} [opts]
   *   `place` — anchor (default) or pointer-follow. `anchorY` — anchor-mode
   *   baseline y: a number, or a function evaluated at show time for a value that
   *   changes with layout (e.g. the HUD height across 1/2/3-row modes); defaults
   *   to the target's bottom edge. `clip` — gate a show to a region (e.g. only
   *   while the pointer is over a scrolling card, whose masked rows keep
   *   interactive hit areas outside the visible card). `hideOnUp` — also hide on a
   *   mouse release (touch always hides on release); used for HUD buttons so the
   *   hint clears when you click. `maxWidth` — cap the word-wrap width (px);
   *   defaults to roughly the screen width.
   * @returns {() => void} detach — removes the wired listeners.
   */
  attach(target, textOrFn, opts = {}) {
    const show = (p) => this._show(target, textOrFn, opts, p ?? this.scene.input.activePointer);
    const out = () => this._hide(target);
    const up = (p) => {
      // Touch has no hover, so a lifted finger always hides. hideOnUp extends that
      // to the mouse — HUD icons are click-to-act buttons whose hint should clear
      // on release rather than linger.
      if (p?.wasTouch || opts.hideOnUp) this._hide(target);
    };
    // If the target is destroyed while its tip shows (e.g. a menu row cleared on
    // navigation, or the close button on close), no pointer-out fires — hide so
    // the shared box doesn't linger.
    const gone = () => this._hide(target);
    target.on('pointerover', show);
    target.on('pointerdown', show);
    target.on('pointerout', out);
    target.on('pointerup', up);
    target.once('destroy', gone);
    return () => {
      target.off('pointerover', show);
      target.off('pointerdown', show);
      target.off('pointerout', out);
      target.off('pointerup', up);
      target.off('destroy', gone);
    };
  }

  /**
   * Suppress or re-allow tooltips (e.g. off while dragging the launcher or while
   * a modal owns the screen). Turning off also hides any visible tip.
   * @param {boolean} on @returns {void}
   */
  setEnabled(on) {
    this._enabled = on;
    if (!on) this._forceHide();
  }

  /**
   * Force-hide any visible tip immediately (no fade), regardless of which target
   * owns it — e.g. when an aim/pin drag starts or an overlay takes the screen.
   * @returns {void}
   */
  hide() {
    this._forceHide();
  }

  // --- internals ------------------------------------------------------------

  /**
   * @param {object} target @param {string | (() => string)} textOrFn
   * @param {object} opts @param {Phaser.Input.Pointer} p
   */
  _show(target, textOrFn, opts, p) {
    if (!this._enabled) return;
    if (opts.clip && !opts.clip(p)) return; // masked hit area leaked outside the region
    const text = typeof textOrFn === 'function' ? textOrFn() : textOrFn;
    this._owner = target;
    this._place = opts.place || 'anchor';
    this._target = target;
    this._anchorY = opts.anchorY;
    const W = this.scene.scale.width;
    const pad = this._tk.padding;
    // Word-wrap so a long label uses more lines instead of running off-screen.
    // `maxWidth` (a box width) lets a caller cap it tighter than the screen; the
    // text wraps inside the box padding.
    const cap = opts.maxWidth ?? (this._place === 'pointer' ? Math.min(360, W - 40) : W - 2 * Config.hud.pad);
    this.label.setWordWrapWidth(Math.max(40, cap - 2 * pad.x), true).setText(text);
    this._layout();
    this._reposition(p);
    this._fadeIn();
  }

  /** Size the box to the wrapped text, draw the backing, and inset the text. */
  _layout() {
    const pad = this._tk.padding;
    this._bw = Math.ceil(this.label.width) + 2 * pad.x;
    this._bh = Math.ceil(this.label.height) + 2 * pad.y;
    this.label.setPosition(pad.x, pad.y);
    this._drawBg();
  }

  /** Redraw the backing graphics for the current box size. */
  _drawBg() {
    const tk = this._tk;
    const g = this.bg;
    const w = this._bw;
    const h = this._bh;
    const r = tk.radius;
    g.clear();
    // Soft drop shadow: stack a few translucent rounded rects, each nudged down,
    // so they accumulate near the box and thin out below (a cheap blur, no FX).
    for (let i = 3; i >= 1; i--) {
      g.fillStyle(tk.shadow.color, tk.shadow.alpha / 3);
      g.fillRoundedRect(0, tk.shadow.y + i * 2, w, h, r);
    }
    g.fillStyle(tk.bg, tk.bgAlpha);
    g.fillRoundedRect(0, 0, w, h, r);
    g.lineStyle(1, tk.border, 1);
    g.strokeRoundedRect(0, 0, w, h, r);
  }

  /** Position the box's top-left per the current placement. @param {Phaser.Input.Pointer} p */
  _reposition(p) {
    const [x, y] = this._place === 'pointer' ? this._placePointer(p.x, p.y) : this._placeAnchor(this._target);
    this.box.setPosition(Math.round(x), Math.round(y));
  }

  /** Fade the box in (interrupting any fade-out). @returns {void} */
  _fadeIn() {
    this.scene.tweens.killTweensOf(this.box);
    this.box.setVisible(true);
    this.scene.tweens.add({ targets: this.box, alpha: 1, duration: FADE_MS, ease: 'Sine.Out' });
  }

  /**
   * Hide with a fade, but only if `target` is the one currently showing — so a
   * stale pointer-out from a target we already left can't kill the new tip.
   * @param {object} target @returns {void}
   */
  _hide(target) {
    if (this._owner !== target) return;
    this._owner = null;
    this.scene.tweens.killTweensOf(this.box);
    this.scene.tweens.add({
      targets: this.box,
      alpha: 0,
      duration: FADE_MS,
      ease: 'Sine.Out',
      onComplete: () => this.box.setVisible(false),
    });
  }

  /** Hide immediately, no fade. @returns {void} */
  _forceHide() {
    this._owner = null;
    this.scene.tweens.killTweensOf(this.box);
    this.box.setVisible(false).setAlpha(0);
  }

  /**
   * Float near the pointer but fully on-screen: prefer above-right, flip to the
   * roomier side of an edge, then clamp. Returns the box's top-left.
   * @param {number} px @param {number} py  Pointer position (screen px).
   * @returns {[number, number]}
   */
  _placePointer(px, py) {
    const pad = 6;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const w = this._bw;
    const h = this._bh;
    let x = px + 14;
    if (x + w > W - pad) x = px - 14 - w; // flip left
    let top = py - 8 - h;
    if (top < pad) top = py + 14; // flip below
    x = Phaser.Math.Clamp(x, pad, Math.max(pad, W - pad - w));
    top = Phaser.Math.Clamp(top, pad, Math.max(pad, H - pad - h));
    return [x, top];
  }

  /**
   * Centre on the target's x, just below it — at `anchorY` if given (a fixed
   * baseline, e.g. the HUD ribbon), else a cursor's-reach below the target's own
   * bottom edge. That clearance is off the control's bottom (not the current
   * pointer), because the tip is placed once and stays up while the pointer roams
   * the hit area — so it must clear wherever the cursor could reach. If there's no
   * room below, flip above (the cursor stays below the pointer, clear of a tip
   * there). Then clamp on-screen. Returns the box's top-left.
   * @param {Phaser.GameObjects.GameObject} target
   * @returns {[number, number]}
   */
  _placeAnchor(target) {
    const pad = Config.hud.pad;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const b = target.getBounds();
    const w = this._bw;
    const h = this._bh;
    const half = w / 2;
    const cx = Phaser.Math.Clamp(b.centerX, half + pad, W - pad - half);
    const anchorY = typeof this._anchorY === 'function' ? this._anchorY() : this._anchorY;
    let top;
    if (anchorY != null) {
      top = anchorY; // fixed baseline (HUD, below the ribbon)
    } else {
      top = b.bottom + CURSOR_CLEARANCE; // below the control and any cursor over it
      if (top + h > H - pad) top = b.top - h; // no room below → flip above (clear of the cursor)
    }
    top = Phaser.Math.Clamp(top, pad, Math.max(pad, H - pad - h));
    return [cx - half, top];
  }
}
