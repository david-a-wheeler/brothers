import { Config } from '../config.js';

/**
 * One shared tooltip label for a scene, reused across every surface (HUD icons,
 * arena entities, menu rows). Replaces the ~8 per-anchor HUD `Text`s, the arena's
 * `entityInfoText`, and the menu's own `_tip` — one look (Config.ui.tooltip), one
 * behavior home.
 *
 * Only one tooltip is ever visible (you point at one thing), so a single reused
 * label suffices. `attach` owns the hover/press trigger wiring so callers don't
 * re-spell it; button-state feedback (icon brighten/dim) is deliberately NOT here
 * — callers keep their own hover handlers alongside `attach`.
 *
 * Camera note: the label renders in UI space only. The owning scene must add
 * `tip.label` to its HUD-camera list so the world camera ignores it (see
 * GameScene._setupCameras) — otherwise it would draw in the zoomed world.
 *
 * Placement modes:
 *  - `anchor` (default): centred on the target's x, top at `anchorY`, clamped to
 *    the screen. Reproduces the old _placeHudTip (HUD icons below the ribbon).
 *  - `pointer`: floats near the pointer (above-right, flips to the roomier side,
 *    clamps on-screen) and follows it while visible. Reproduces the old
 *    _placeFloatingLabel (arena + menu).
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
    const t = Config.ui.tooltip;

    /** The single shared label. Add this to the scene's HUD-camera list. */
    this.label = scene.add
      .text(0, 0, '', {
        fontSize: t.fontSize,
        color: t.color,
        backgroundColor: t.backgroundColor,
        padding: { x: t.padding.x, y: t.padding.y },
      })
      .setDepth(Config.ui.depth.tooltip)
      .setVisible(false);

    /** Target that last requested a show (anti-flicker token). @type {?object} */
    this._owner = null;
    /** @type {'anchor'|'pointer'} Placement of the visible tip. */
    this._place = 'anchor';
    /** @type {?number} Anchor-mode baseline y for the visible tip. */
    this._anchorY = undefined;
    /** @type {?Phaser.GameObjects.GameObject} Anchor-mode target for reposition. */
    this._target = null;
    /** When false, shows are ignored and any visible tip is hidden. */
    this._enabled = true;

    // Keep a pointer-placed tip glued to the moving pointer while it's visible.
    this._onMove = (p) => {
      if (this.label.visible && this._place === 'pointer') this._placePointer(p.x, p.y);
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
   * @param {{ place?: 'anchor'|'pointer', anchorY?: number,
   *           clip?: (p: Phaser.Input.Pointer) => boolean }} [opts]
   *   `place` — anchor (default) or pointer-follow. `anchorY` — anchor-mode
   *   baseline y (defaults to the target's bottom edge). `clip` — gate a show to
   *   a region (e.g. only while the pointer is over a scrolling card, whose
   *   masked rows keep interactive hit areas outside the visible card).
   * @returns {() => void} detach — removes the wired listeners.
   */
  attach(target, textOrFn, opts = {}) {
    const show = (p) => this._show(target, textOrFn, opts, p ?? this.scene.input.activePointer);
    const out = () => this._hide(target);
    const up = (p) => {
      if (p?.wasTouch) this._hide(target);
    };
    // If the target is destroyed while its tip shows (e.g. a menu row cleared on
    // navigation, or the close button on close), no pointer-out fires — hide so
    // the shared label doesn't linger.
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
   * Force-hide any visible tip regardless of which target owns it — e.g. when an
   * aim/pin drag starts and the arena label must clear immediately.
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
    // Word-wrap so a long label uses more lines instead of running off-screen.
    const maxW = this._place === 'pointer' ? Math.min(360, W - 40) : W - 2 * Config.hud.pad;
    this.label.setWordWrapWidth(maxW, true).setText(text).setVisible(true);
    if (this._place === 'pointer') this._placePointer(p.x, p.y);
    else this._placeAnchor(target);
  }

  /**
   * Hide, but only if `target` is the one currently showing — so a stale
   * pointer-out from a target we already left can't kill the new tip.
   * @param {object} target @returns {void}
   */
  _hide(target) {
    if (this._owner !== target) return;
    this._forceHide();
  }

  /** Hide unconditionally. @returns {void} */
  _forceHide() {
    this._owner = null;
    this.label.setVisible(false);
  }

  /**
   * Float the label near the pointer but fully on-screen: prefer above-right,
   * flip to the roomier side of an edge, then clamp. (Was _placeFloatingLabel.)
   * @param {number} px @param {number} py  Pointer position (screen px).
   */
  _placePointer(px, py) {
    const pad = 6;
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    this.label.setOrigin(0, 1);
    const w = this.label.width; // includes the label's own padding
    const h = this.label.height;
    let x = px + 14;
    if (x + w > W - pad) x = px - 14 - w; // flip left
    let top = py - 8 - h;
    if (top < pad) top = py + 14; // flip below
    x = Phaser.Math.Clamp(x, pad, Math.max(pad, W - pad - w));
    top = Phaser.Math.Clamp(top, pad, Math.max(pad, H - pad - h));
    this.label.setPosition(x, top + h); // origin (0,1): position is the box's bottom-left
  }

  /**
   * Centre the label on the target's x, top at `anchorY` (or the target's bottom
   * edge), clamped horizontally to the screen. (Was _placeHudTip.)
   * @param {Phaser.GameObjects.GameObject} target
   */
  _placeAnchor(target) {
    const pad = Config.hud.pad;
    const W = this.scene.scale.width;
    const b = target.getBounds();
    this.label.setOrigin(0.5, 0);
    const half = this.label.width / 2;
    const x = Phaser.Math.Clamp(b.centerX, half + pad, W - pad - half);
    this.label.setPosition(x, this._anchorY ?? b.bottom);
  }
}
