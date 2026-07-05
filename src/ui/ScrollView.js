/**
 * A reusable scroll viewport: a geometry-masked content container that shifts to
 * scroll, with auto-sizing scrollbar thumbs and drag/wheel input. Vertical by
 * default; horizontal scrolling turns on when {@link layout} is given a content
 * width wider than the viewport (e.g. a no-wrap log). The body drag pans both
 * axes; each scrollbar drags its own.
 *
 * Coordinates are screen pixels. The UI camera these overlays render on sits at
 * scroll 0 / zoom 1, so screen px == mask px == container-local px — no
 * conversion is needed. Children are added in LOCAL coordinates whose origin
 * (0,0) is the top-left of the viewport region (see {@link add}).
 *
 * The owning {@link Overlay} decides the hit regions and forwards pointer/wheel
 * events here; this class owns the scroll math, the thumbs, the drag state, and
 * the tap-vs-drag threshold so none of it is duplicated per panel.
 */
export class ScrollView {
  /**
   * @param {Phaser.Scene} scene
   * @param {{depth:number, scrollbarDepth?:number}} opts
   *   `depth` draws the content; `scrollbarDepth` the thumbs (defaults to `depth`).
   */
  constructor(scene, { depth, scrollbarDepth = depth }) {
    this.scene = scene;
    /** Current scroll offsets (0 = top / left). */
    this.scroll = 0;
    this.scrollX = 0;
    /** Max scroll offsets (0 when the content fits that axis). */
    this.scrollMax = 0;
    this.scrollXMax = 0;
    this._contentH = 0;
    this._contentW = 0;
    this._region = { x: 0, y: 0, w: 0, h: 0 };

    // An off-display-list graphics used purely as the container's clip mask.
    this._maskGfx = scene.make.graphics();
    this.container = scene.add.container(0, 0).setDepth(depth);
    this.container.setMask(this._maskGfx.createGeometryMask());

    // Edge indicators, shown only on overflow (sized by _updateBars): vertical on
    // the right, horizontal along the bottom.
    this.scrollbar = scene.add.rectangle(0, 0, 4, 20, 0xffffff, 0.45).setOrigin(0.5).setDepth(scrollbarDepth).setVisible(false);
    this.hscrollbar = scene.add.rectangle(0, 0, 20, 4, 0xffffff, 0.45).setOrigin(0.5).setDepth(scrollbarDepth).setVisible(false);

    scene.cameras.main.ignore([this.container, this.scrollbar, this.hscrollbar]); // HUD camera only

    // The mask is an off-display-list graphics, so the scene's shutdown won't
    // auto-destroy it (unlike the container/scrollbars). Destroy on shutdown too,
    // so an overlay still open at scene restart doesn't leak one mask per restart.
    this._onShutdown = () => this.destroy();
    scene.events.once('shutdown', this._onShutdown);

    // Drag state. `_mode` is 'body' (content pans with the finger, inverted, in
    // both axes), 'thumb' (vertical thumb tracks the finger), or 'hthumb'
    // (horizontal thumb); `dragged` reports whether the just-ended gesture passed
    // the tap-vs-drag threshold so a control can ignore the tap.
    this._mode = null;
    this._lastX = 0;
    this._lastY = 0;
    this._downX = 0;
    this._downY = 0;
    this.dragged = false;
  }

  /** Display objects the owner keeps for camera-ignore / teardown bookkeeping. */
  get parts() {
    return [this.container, this.scrollbar, this.hscrollbar];
  }

  /** @returns {{x:number,y:number,w:number,h:number}} a copy of the current viewport rect. */
  get region() {
    return { ...this._region };
  }

  /**
   * Re-fit to a new viewport rect, keeping the same content size (e.g. the owning
   * overlay was resized). @param {{x:number,y:number,w:number,h:number}} region
   * @returns {void}
   */
  relayout(region) {
    this.layout({ ...region }, this._contentH, this._contentW);
  }

  /**
   * Add a child in local coordinates (local 0,0 = viewport top-left).
   *
   * @template {Phaser.GameObjects.GameObject} T
   * @param {T|T[]} child @returns {T|T[]} the same child, for chaining.
   */
  add(child) {
    this.container.add(child);
    return child;
  }

  /** Remove and destroy all content (keeps the view itself for reuse). */
  clear() {
    this.container.removeAll(true);
  }

  /**
   * Define the clipped viewport (screen rect), the full content height, and
   * optionally a content width wider than the viewport (enables horizontal
   * scrolling). Re-fits the mask, clamps the scroll, and repositions the
   * container + scrollbars. Call after (re)populating content or on resize.
   *
   * @param {{x:number, y:number, w:number, h:number}} region
   * @param {number} contentH  Full height of the content.
   * @param {number} [contentW]  Full width of the content (defaults to the
   *   viewport width, i.e. no horizontal scroll).
   * @returns {void}
   */
  layout(region, contentH, contentW = region.w) {
    this._region = { ...region };
    this._contentH = contentH;
    this._contentW = contentW;
    this.scrollMax = Math.max(0, contentH - region.h);
    this.scrollXMax = Math.max(0, contentW - region.w);
    this.scroll = Phaser.Math.Clamp(this.scroll, 0, this.scrollMax);
    this.scrollX = Phaser.Math.Clamp(this.scrollX, 0, this.scrollXMax);
    this._maskGfx.clear().fillStyle(0xffffff, 1).fillRect(region.x, region.y, region.w, region.h);
    this.container.setPosition(region.x - this.scrollX, region.y - this.scroll);
    this.scene.cameras.main.ignore(this.container); // re-walk: newly added children too
    this._updateBars();
    this._gateInput();
  }

  /**
   * Shift the content by (dx, dy) screen pixels, clamped to range, repositioning
   * the container, scrollbars, and per-control input.
   *
   * @param {number} dx @param {number} dy @returns {void}
   */
  _applyScroll(dx, dy) {
    this.scrollX = Phaser.Math.Clamp(this.scrollX + dx, 0, this.scrollXMax);
    this.scroll = Phaser.Math.Clamp(this.scroll + dy, 0, this.scrollMax);
    this.container.setPosition(this._region.x - this.scrollX, this._region.y - this.scroll);
    this._updateBars();
    this._gateInput();
  }

  /**
   * Shift the whole viewport (mask, content, scrollbars) by (dx, dy) screen px,
   * keeping the current scroll offsets. Used when the owning overlay is dragged.
   *
   * @param {number} dx @param {number} dy @returns {void}
   */
  translate(dx, dy) {
    this._region.x += dx;
    this._region.y += dy;
    const { x, y, w, h } = this._region;
    this._maskGfx.clear().fillStyle(0xffffff, 1).fillRect(x, y, w, h);
    this.container.setPosition(x - this.scrollX, y - this.scroll);
    this._updateBars();
  }

  /** Scroll vertically by `delta` px, clamped. No-op when it fits. */
  scrollBy(delta) {
    if (this.scrollMax > 0) this._applyScroll(0, delta);
  }

  /** Scroll horizontally by `delta` px, clamped. No-op when it fits. */
  scrollXBy(delta) {
    if (this.scrollXMax > 0) this._applyScroll(delta, 0);
  }

  /**
   * Enable input only on interactive children currently inside the viewport
   * (vertically). A geometry mask hides scrolled-out children but does NOT stop
   * Phaser hit-testing them, so without this an off-view control could intercept a
   * press meant for whatever is behind the (backdrop-less) panel.
   *
   * @returns {void}
   */
  _gateInput() {
    const { y, h } = this._region;
    for (const c of this.container.list) {
      if (!c.input) continue;
      const screenY = this.container.y + c.y;
      c.input.enabled = screenY >= y - 2 && screenY <= y + h + 2;
    }
  }

  /** Size/position both thumbs for the current scroll, hiding either when it fits. */
  _updateBars() {
    const { x, y, w, h } = this._region;
    if (this.scrollMax <= 0) {
      this.scrollbar.setVisible(false);
    } else {
      const thumbH = Math.max(24, h * (h / this._contentH));
      this._thumbH = thumbH;
      const t = this.scroll / this.scrollMax;
      this.scrollbar.setSize(4, thumbH).setPosition(x + w - 3, y + t * (h - thumbH) + thumbH / 2).setVisible(true);
    }
    if (this.scrollXMax <= 0) {
      this.hscrollbar.setVisible(false);
    } else {
      const thumbW = Math.max(24, w * (w / this._contentW));
      this._thumbW = thumbW;
      const tx = this.scrollX / this.scrollXMax;
      this.hscrollbar.setSize(thumbW, 4).setPosition(x + tx * (w - thumbW) + thumbW / 2, y + h - 3).setVisible(true);
    }
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is in the vertical scrollbar grab zone (right
   *   edge) while the content overflows vertically.
   */
  overScrollbar(p) {
    if (this.scrollMax <= 0) return false;
    const { x, y, w, h } = this._region;
    const right = x + w;
    return p.x >= right - 16 && p.x <= right + 6 && p.y >= y && p.y <= y + h;
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is in the horizontal scrollbar grab zone
   *   (bottom edge) while the content overflows horizontally.
   */
  overHScrollbar(p) {
    if (this.scrollXMax <= 0) return false;
    const { x, y, w, h } = this._region;
    const bottom = y + h;
    return p.y >= bottom - 16 && p.y <= bottom + 6 && p.x >= x && p.x <= x + w;
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is inside the clipped viewport.
   */
  overBody(p) {
    const { x, y, w, h } = this._region;
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  }

  /** Start dragging the vertical thumb (call when {@link overScrollbar}). */
  beginThumbDrag(p) {
    this._begin('thumb', p);
  }

  /** Start dragging the horizontal thumb (call when {@link overHScrollbar}). */
  beginHThumbDrag(p) {
    this._begin('hthumb', p);
  }

  /** Start dragging (panning) the content body. */
  beginBodyDrag(p) {
    this._begin('body', p);
  }

  _begin(mode, p) {
    this._mode = mode;
    this._lastX = this._downX = p.x;
    this._lastY = this._downY = p.y;
    this.dragged = false;
  }

  /** @returns {boolean} true while a body/thumb drag is in progress. */
  get dragging() {
    return this._mode !== null;
  }

  /**
   * Continue the active drag. Past a small threshold it counts as a scroll (see
   * {@link dragged}); a thumb drag moves WITH the finger, a body drag inverts and
   * pans both axes.
   *
   * @param {Phaser.Input.Pointer} p @returns {void}
   */
  drag(p) {
    if (!this._mode) return;
    if (Math.abs(p.x - this._downX) > 5 || Math.abs(p.y - this._downY) > 5) this.dragged = true;
    if (this._mode === 'thumb') {
      const range = this._region.h - (this._thumbH || 0);
      if (range > 0) this.scrollBy(((p.y - this._lastY) * this.scrollMax) / range);
    } else if (this._mode === 'hthumb') {
      const range = this._region.w - (this._thumbW || 0);
      if (range > 0) this.scrollXBy(((p.x - this._lastX) * this.scrollXMax) / range);
    } else {
      this._applyScroll(this._lastX - p.x, this._lastY - p.y); // body: natural (inverted)
    }
    this._lastX = p.x;
    this._lastY = p.y;
  }

  /** End the active drag (the {@link dragged} result stays until the next drag). */
  endDrag() {
    this._mode = null;
  }

  /** Scroll from a mouse wheel (`dy` in screen px) — vertical. */
  wheel(dy) {
    this.scrollBy(dy);
  }

  /** Destroy the container (and its children), the mask, and the scrollbars. */
  destroy() {
    if (!this._maskGfx) return; // already destroyed (e.g. hide() then shutdown)
    this.scene.events.off('shutdown', this._onShutdown);
    this.container.clearMask(true);
    this._maskGfx.destroy();
    this.container.destroy();
    this.scrollbar.destroy();
    this.hscrollbar.destroy();
    this._maskGfx = null;
  }
}
