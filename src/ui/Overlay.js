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
    /** Screen-space rects a subclass sets in {@link _build}: the whole card
     *  (for on-screen clamping) and the draggable title strip. Both are shifted
     *  by {@link _translate} when the overlay is dragged. */
    this._windowRect = null;
    this._titleBar = null;
    this._windowDragging = false;
    /** Bottom-edge resize: a subclass opts in by setting `_resizable`, a minimum
     *  card height, and `_relayout(cardH)` (redraw the card + re-fit the body). */
    this._resizable = false;
    this._resizing = false;
    this._minCardH = 120;
    /** @type {((cardH:number)=>void)|null} */
    this._relayout = null;
    /** True while we've overridden the canvas cursor (title/resize hover). */
    this._cursorSet = false;
    /** Full-screen input shield that captures the pointer during a resize /
     *  window-drag, so nothing underneath hovers, highlights, or changes the
     *  cursor (see {@link _grabPointer}). @type {?Phaser.GameObjects.Rectangle} */
    this._shield = null;
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
    this._releasePointer(); // in case it's hidden mid-drag
    if (this._cursorSet) {
      this.scene.input.setDefaultCursor('default'); // don't leave a move/resize cursor behind
      this._cursorSet = false;
    }
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
    // A press on the title bar drags the whole overlay; on the bottom edge,
    // resizes it (like a window).
    if (this._overTitleBar(p)) {
      this._beginWindowDrag(p);
      return true;
    }
    if (this._overResizeEdge(p)) {
      this._beginResize(p);
      return true;
    }
    const sv = this.scrollView;
    if (sv && (sv.scrollMax > 0 || sv.scrollXMax > 0)) {
      if (sv.overScrollbar(p)) {
        sv.beginThumbDrag(p);
        return true;
      }
      if (sv.overHScrollbar(p)) {
        sv.beginHThumbDrag(p);
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
    if (this._windowDragging) {
      this._dragWindow(p);
      return true;
    }
    if (this._resizing) {
      this._doResize(p);
      return true;
    }
    const sv = this.scrollView;
    if (sv && sv.dragging) {
      sv.drag(p);
      return true;
    }
    this._updateHoverCursor(p);
    return this.modal;
  }

  /**
   * Show a windowing cursor while hovering the drag/resize handles: `move` over
   * the title bar, `ns-resize` over the bottom edge. Elsewhere, restore the
   * default once (so a modeless panel doesn't keep a stale cursor over the arena).
   *
   * @param {Phaser.Input.Pointer} p @returns {void}
   */
  _updateHoverCursor(p) {
    const c = this._overResizeEdge(p) ? 'ns-resize' : this._overTitleBar(p) ? 'move' : null;
    if (c) {
      this.scene.input.setDefaultCursor(c);
      this._cursorSet = true;
    } else if (this._cursorSet) {
      this.scene.input.setDefaultCursor('default');
      this._cursorSet = false;
    }
  }

  /** @param {Phaser.Input.Pointer} p @returns {boolean} true if owned. */
  onPointerUp(p) {
    if (this._windowDragging || this._resizing) {
      this._windowDragging = false;
      this._resizing = false;
      this._releasePointer();
      return true;
    }
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
   *   (A resize / window-drag needs no such guard: its shield captures the pointer
   *   so controls never see the gesture — see {@link _grabPointer}.)
   */
  get dragged() {
    return this.scrollView ? this.scrollView.dragged : false;
  }

  /** Region that starts a body drag. Default: the scroll viewport. Override. */
  _overDragArea(p) {
    return this.scrollView ? this.scrollView.overBody(p) : false;
  }

  /** Whole-overlay bounds, for modeless hit-testing / on-screen clamping. */
  _overSelf(p) {
    const r = this._windowRect;
    if (r) return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
    return this._overDragArea(p);
  }

  // --- window dragging ----------------------------------------------------

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is on the draggable title strip (set by the
   *   subclass in {@link _build}; excludes the × so a press there still closes).
   */
  _overTitleBar(p) {
    const t = this._titleBar;
    return !!t && p.x >= t.x && p.x <= t.x + t.w && p.y >= t.y && p.y <= t.y + t.h;
  }

  /** Begin a window drag, recording the grab offset within the card. */
  _beginWindowDrag(p) {
    this._windowDragging = true;
    this._grabX = p.x - this._windowRect.x;
    this._grabY = p.y - this._windowRect.y;
    this._grabPointer('move');
  }

  /** Move the overlay so the grab point follows the pointer, clamped on-screen. */
  _dragWindow(p) {
    const L = this.scene._layout;
    const r = this._windowRect;
    const nx = Phaser.Math.Clamp(p.x - this._grabX, 0, Math.max(0, L.w - r.w));
    const ny = Phaser.Math.Clamp(p.y - this._grabY, 0, Math.max(0, L.h - r.h));
    this._translate(nx - r.x, ny - r.y);
  }

  /**
   * Shift the whole overlay by (dx, dy): every chrome part (except the fixed
   * full-screen backdrop), the scroll viewport, and the window/title rects.
   *
   * @param {number} dx @param {number} dy @returns {void}
   */
  _translate(dx, dy) {
    if (!dx && !dy) return;
    for (const part of this.parts) {
      if (part === this._backdropObj) continue; // full-screen; stays put
      part.x += dx;
      part.y += dy;
    }
    this.scrollView?.translate(dx, dy);
    this._windowRect.x += dx;
    this._windowRect.y += dy;
    if (this._titleBar) {
      this._titleBar.x += dx;
      this._titleBar.y += dy;
    }
    this._afterTranslate(dx, dy);
  }

  // --- bottom-edge resizing (opt-in via `_resizable`) ---------------------

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is on the bottom-edge resize strip (derived
   *   from the current card rect, so it tracks drags and prior resizes).
   */
  _overResizeEdge(p) {
    if (!this._resizable) return false;
    const r = this._windowRect;
    const bottom = r.y + r.h;
    return p.y >= bottom - 8 && p.y <= bottom + 6 && p.x >= r.x && p.x <= r.x + r.w;
  }

  /** Begin a resize, recording the pointer's offset from the bottom edge. */
  _beginResize(p) {
    this._resizing = true;
    this._resizeGrab = this._windowRect.y + this._windowRect.h - p.y;
    this._grabPointer('ns-resize');
  }

  /**
   * Resize the card's height so its bottom follows the pointer, clamped between a
   * minimum and the screen bottom, then re-lay-out via the subclass {@link _relayout}.
   *
   * @param {Phaser.Input.Pointer} p @returns {void}
   */
  _doResize(p) {
    const r = this._windowRect;
    const maxH = this.scene._layout.h - r.y; // keep the bottom on-screen
    const newH = Phaser.Math.Clamp(p.y + this._resizeGrab - r.y, this._minCardH, maxH);
    if (newH === r.h) return;
    r.h = newH;
    this._relayout?.(newH);
  }

  // --- pointer capture (during a resize / window-drag) --------------------

  /**
   * Grab the pointer for the duration of a drag: a transparent, full-screen
   * interactive shield on top of everything, so the controls underneath get no
   * hover, highlight, tap, or cursor change — the gesture stays in one mode
   * regardless of what the pointer passes over. `cursor` holds the drag cursor
   * (e.g. `ns-resize`) since the shield is now the topmost object. The gesture
   * itself is driven by the scene's pointer-move routing, which the shield
   * doesn't intercept.
   *
   * @param {string} cursor @returns {void}
   */
  _grabPointer(cursor) {
    if (this._shield) return;
    const { width, height } = this.scene.scale;
    this._shield = this.scene.add
      .rectangle(0, 0, width, height, 0x000000, 0) // invisible, but hit-tested
      .setOrigin(0, 0)
      .setDepth(9999) // above everything, incl. modals
      .setInteractive({ cursor });
    this.scene.cameras.main.ignore(this._shield); // UI camera only
  }

  /** Release the drag shield. @returns {void} */
  _releasePointer() {
    this._shield?.destroy();
    this._shield = null;
  }

  /**
   * Subclass hook: shift any stored layout coordinates a later re-layout reads, so
   * the overlay stays coherent at its dragged position. Default: nothing.
   *
   * @param {number} dx @param {number} dy @returns {void}
   */
  _afterTranslate(dx, dy) {}
}
