import { Config } from '../config.js';
import { ScrollView } from './ScrollView.js';
import { chipButton } from './chipButton.js';

/**
 * Base class for on-screen overlays (modals, the menu, the modeless Lab panel).
 * Owns the shared lifecycle (show / rebuild-on-resize / hide), a {@link ScrollView}
 * for the scrollable body, the camera discipline, and pointer/wheel routing.
 * Subclasses implement {@link _build} to draw their chrome and fill the body —
 * "the top" you grab; everything else is inherited.
 *
 * Rendering rides the scene's fixed UI camera (the world camera ignores every
 * part). `modal` overlays lay a full-screen backdrop and own all input while up;
 * modeless ones (the Lab panel) coexist with the game and own input only over
 * themselves. The scene's overlay router (see GameScene._overlayOpened) forwards
 * input here.
 */
export class Overlay {
  /**
   * @param {Phaser.Scene} scene
   * @param {{modal?:boolean, depth:number, scrollbarDepth?:number}} opts
   *   `modal` (default true) blocks the rest of the UI; `depth` draws the body,
   *   `scrollbarDepth` the thumb (defaults to `depth`).
   */
  constructor(scene, opts) {
    this.scene = scene;
    this.modal = opts.modal !== false;
    this._depth = opts.depth;
    this._scrollbarDepth = opts.scrollbarDepth;
    /** True between {@link show} and {@link hide}. */
    this.open = false;
    /** @type {ScrollView|null} */
    this.scrollView = null;
    /** Chrome objects rebuilt on each {@link _build} (not the ScrollView's). */
    this.parts = [];
    this._backdropObj = null;
    this._backdropAlpha = 1;
  }

  /**
   * How the scene's router files this overlay: 'modal' (blocking, joins the modal
   * stack), 'panel' (modeless, joins `_panels`), or 'menu' (tracked on its own).
   * @returns {'modal'|'panel'|'menu'}
   */
  get role() {
    return this.modal ? 'modal' : 'panel';
  }

  // --- lifecycle ----------------------------------------------------------

  /** Open the overlay (idempotent). Creates the scroll view, builds, registers. */
  show() {
    if (this.open) return this;
    this.open = true;
    this.scrollView = new ScrollView(this.scene, {
      depth: this._depth,
      scrollbarDepth: this._scrollbarDepth ?? this._depth,
    });
    this._build(true);
    this.scene._overlayOpened(this);
    return this;
  }

  /** Close and destroy the overlay. */
  hide() {
    if (!this.open) return;
    this._teardownParts();
    if (this.scrollView) {
      this.scrollView.destroy();
      this.scrollView = null;
    }
    this.open = false;
    this.scene._overlayClosed(this);
    this.onHidden?.();
  }

  /** Rebuild against the current layout (resize/rotation), preserving scroll. */
  rebuild() {
    if (!this.open) return;
    this._teardownParts();
    this.scrollView.clear();
    this._build(false);
  }

  /** Destroy the chrome parts; keep the ScrollView (and its scroll) for reuse. */
  _teardownParts() {
    for (const p of this.parts) p.destroy();
    this.parts = [];
    this._backdropObj = null;
  }

  /**
   * Subclass hook: create chrome (pushed into {@link parts}), populate
   * {@link scrollView}, call `this.scrollView.layout(region, contentH)`, then
   * {@link _fadeIn}. Runs on {@link show} (`animate`) and {@link rebuild} (not).
   *
   * @param {boolean} animate @returns {void} @abstract
   */
  _build(animate) {
    throw new Error(`${this.constructor.name} must implement _build()`);
  }

  // --- chrome helpers -----------------------------------------------------

  /**
   * A full-screen dimming backdrop that swallows clicks on the world beneath.
   * Remembers its alpha so {@link _fadeIn} restores it (not opaque). Caller pushes
   * the result into {@link parts}.
   *
   * @param {number} alpha @param {number} depth @returns {Phaser.GameObjects.Rectangle}
   */
  _backdrop(alpha, depth) {
    const L = this.scene._layout;
    const bd = this.scene.add
      .rectangle(L.w / 2, L.h / 2, L.w, L.h, 0x000000, alpha)
      .setDepth(depth)
      .setInteractive();
    this._backdropObj = bd;
    this._backdropAlpha = alpha;
    return bd;
  }

  /**
   * A standard red top-right close "×", wired to hide this overlay. The caller
   * positions it (each subclass knows its own chrome geometry) and pushes it into
   * {@link parts}. On a Yes/No modal, dismissing this way is the cancel ("No")
   * path — {@link hide} runs no affirmative action.
   *
   * @param {number} x @param {number} y @param {number} depth
   * @returns {Phaser.GameObjects.Text}
   */
  _closeButton(x, y, depth) {
    return chipButton(this.scene, x, y, '×', () => this.hide(), { bg: '#c0392b', bgHover: '#e74c3c' }).setDepth(depth);
  }

  /**
   * Fade the chrome + scroll view in on {@link show}; snap them on {@link rebuild}.
   * The backdrop fades to its own (partial) alpha, everything else to 1.
   *
   * @param {boolean} animate @returns {void}
   */
  _fadeIn(animate) {
    const M = Config.ui.motion;
    const targets = [...this.parts, ...(this.scrollView ? this.scrollView.parts : [])];
    for (const part of targets) {
      const to = part === this._backdropObj ? this._backdropAlpha : 1;
      if (animate) {
        part.setAlpha(0);
        this.scene.tweens.add({ targets: part, alpha: to, duration: M.dur, ease: M.ease });
      } else {
        part.setAlpha(to);
      }
    }
  }

  // --- input (called by the scene's overlay router) -----------------------

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if this overlay owns the press (scene must not pan).
   */
  onPointerDown(p) {
    const sv = this.scrollView;
    if (sv && sv.scrollMax > 0) {
      if (sv.overScrollbar(p)) {
        sv.beginThumbDrag(p);
        return true;
      }
      if (this._overDragArea(p)) {
        sv.beginBodyDrag(p);
        return true;
      }
    }
    // Modal overlays swallow every press; modeless panels own only their own area.
    return this.modal || this._overSelf(p);
  }

  /** @param {Phaser.Input.Pointer} p @returns {boolean} true if owned. */
  onPointerMove(p) {
    const sv = this.scrollView;
    if (sv && sv.dragging) {
      sv.drag(p);
      return true;
    }
    return this.modal;
  }

  /** @param {Phaser.Input.Pointer} p @returns {boolean} true if owned. */
  onPointerUp(p) {
    const sv = this.scrollView;
    if (sv && sv.dragging) {
      sv.endDrag();
      return true;
    }
    return this.modal;
  }

  /** @param {Phaser.Input.Pointer} p @param {number} dy @returns {boolean} true if owned. */
  onWheel(p, dy) {
    if (this.modal || this._overSelf(p)) {
      this.scrollView?.wheel(dy);
      return true;
    }
    return false;
  }

  /**
   * @returns {boolean} true if the just-ended pointer gesture was a scroll drag,
   *   so a control under the finger can ignore the tap (see {@link ScrollView.dragged}).
   */
  get dragged() {
    return this.scrollView ? this.scrollView.dragged : false;
  }

  /** Region that starts a body drag. Default: the scroll viewport. Override. */
  _overDragArea(p) {
    return this.scrollView ? this.scrollView.overBody(p) : false;
  }

  /** Whole-overlay bounds, for modeless hit-testing. Default: the drag area. */
  _overSelf(p) {
    return this._overDragArea(p);
  }
}
