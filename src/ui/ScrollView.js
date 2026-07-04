/**
 * A reusable vertical scroll viewport: a geometry-masked content container that
 * shifts vertically, with an auto-sizing scrollbar thumb and drag/wheel input.
 *
 * Coordinates are screen pixels. The UI camera these overlays render on sits at
 * scroll 0 / zoom 1, so screen px == mask px == container-local px — no
 * conversion is needed. Children are added in LOCAL coordinates whose origin
 * (0,0) is the top-left of the viewport region (see {@link add}).
 *
 * The owning {@link Overlay} decides the hit regions and forwards pointer/wheel
 * events here; this class owns the scroll math, the thumb, the drag state, and
 * the tap-vs-drag threshold so none of it is duplicated per panel.
 */
export class ScrollView {
  /**
   * @param {Phaser.Scene} scene
   * @param {{depth:number, scrollbarDepth?:number}} opts
   *   `depth` draws the content; `scrollbarDepth` the thumb (defaults to `depth`).
   */
  constructor(scene, { depth, scrollbarDepth = depth }) {
    this.scene = scene;
    /** Current scroll offset (0 = top). */
    this.scroll = 0;
    /** Max scroll offset (0 when the content fits). */
    this.scrollMax = 0;
    this._contentH = 0;
    this._region = { x: 0, y: 0, w: 0, h: 0 };

    // An off-display-list graphics used purely as the container's clip mask.
    this._maskGfx = scene.make.graphics();
    this.container = scene.add.container(0, 0).setDepth(depth);
    this.container.setMask(this._maskGfx.createGeometryMask());

    // Right-edge indicator, shown only on overflow (sized by _updateBar).
    this.scrollbar = scene.add
      .rectangle(0, 0, 4, 20, 0xffffff, 0.45)
      .setOrigin(0.5, 0.5)
      .setDepth(scrollbarDepth)
      .setVisible(false);

    scene.cameras.main.ignore([this.container, this.scrollbar]); // HUD camera only

    // Drag state. `_mode` is 'body' (content drags with the finger, inverted) or
    // 'thumb' (thumb tracks the finger); `dragged` reports whether the just-ended
    // gesture passed the tap-vs-drag threshold so a control can ignore the tap.
    this._mode = null;
    this._lastY = 0;
    this._downY = 0;
    this.dragged = false;
  }

  /** Display objects the owner keeps for camera-ignore / teardown bookkeeping. */
  get parts() {
    return [this.container, this.scrollbar];
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
   * Define the clipped viewport (screen rect) and the full content height, then
   * re-fit the mask, clamp the scroll, and reposition the container + scrollbar.
   * Call after (re)populating content or on resize.
   *
   * @param {{x:number, y:number, w:number, h:number}} region
   * @param {number} contentH  Full height of the content added to the container.
   * @returns {void}
   */
  layout(region, contentH) {
    this._region = { ...region };
    this._contentH = contentH;
    this.scrollMax = Math.max(0, contentH - region.h);
    this.scroll = Phaser.Math.Clamp(this.scroll, 0, this.scrollMax);
    this._maskGfx.clear().fillStyle(0xffffff, 1).fillRect(region.x, region.y, region.w, region.h);
    this.container.setPosition(region.x, region.y - this.scroll);
    this.scene.cameras.main.ignore(this.container); // re-walk: newly added children too
    this._updateBar();
  }

  /**
   * Scroll by `delta` screen pixels, clamped to range. No-op when content fits.
   *
   * @param {number} delta @returns {void}
   */
  scrollBy(delta) {
    if (this.scrollMax <= 0) return;
    this.scroll = Phaser.Math.Clamp(this.scroll + delta, 0, this.scrollMax);
    this.container.y = this._region.y - this.scroll;
    this._updateBar();
  }

  /** Size/position the thumb for the current scroll, or hide it when it fits. */
  _updateBar() {
    const bar = this.scrollbar;
    if (this.scrollMax <= 0) {
      bar.setVisible(false);
      return;
    }
    const { x, y, w, h } = this._region;
    const thumbH = Math.max(24, h * (h / this._contentH));
    this._thumbH = thumbH;
    const t = this.scroll / this.scrollMax;
    bar.setSize(4, thumbH).setPosition(x + w - 3, y + t * (h - thumbH) + thumbH / 2).setVisible(true);
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is in the scrollbar grab zone (right edge)
   *   while the content actually overflows.
   */
  overScrollbar(p) {
    if (this.scrollMax <= 0) return false;
    const { x, y, w, h } = this._region;
    const right = x + w;
    return p.x >= right - 16 && p.x <= right + 6 && p.y >= y && p.y <= y + h;
  }

  /**
   * @param {Phaser.Input.Pointer} p
   * @returns {boolean} true if `p` is inside the clipped viewport.
   */
  overBody(p) {
    const { x, y, w, h } = this._region;
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
  }

  /** Start dragging the thumb (call when {@link overScrollbar}). */
  beginThumbDrag(p) {
    this._mode = 'thumb';
    this._lastY = this._downY = p.y;
    this.dragged = false;
  }

  /** Start dragging the content body. */
  beginBodyDrag(p) {
    this._mode = 'body';
    this._lastY = this._downY = p.y;
    this.dragged = false;
  }

  /** @returns {boolean} true while a body/thumb drag is in progress. */
  get dragging() {
    return this._mode !== null;
  }

  /**
   * Continue the active drag. Past a small threshold it counts as a scroll (see
   * {@link dragged}); a thumb drag moves WITH the finger, a body drag inverts.
   *
   * @param {Phaser.Input.Pointer} p @returns {void}
   */
  drag(p) {
    if (!this._mode) return;
    if (Math.abs(p.y - this._downY) > 5) this.dragged = true;
    if (this._mode === 'thumb') {
      const range = this._region.h - (this._thumbH || 0);
      if (range > 0) this.scrollBy(((p.y - this._lastY) * this.scrollMax) / range);
    } else {
      this.scrollBy(this._lastY - p.y);
    }
    this._lastY = p.y;
  }

  /** End the active drag (the {@link dragged} result stays until the next drag). */
  endDrag() {
    this._mode = null;
  }

  /** Scroll from a mouse wheel (`dy` in screen px). */
  wheel(dy) {
    this.scrollBy(dy);
  }

  /** Destroy the container (and its children), the mask, and the scrollbar. */
  destroy() {
    this.container.clearMask(true);
    this._maskGfx.destroy();
    this.container.destroy();
    this.scrollbar.destroy();
    this._maskGfx = null;
  }
}
