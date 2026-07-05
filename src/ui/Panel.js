import { Config } from '../config.js';
import { Overlay } from './Overlay.js';

/**
 * A modeless, anchored panel (e.g. the Lab tuning panel). Unlike {@link Modal} /
 * the menu it lays no backdrop and coexists with the game: it owns input only
 * over itself, so presses elsewhere still reach the arena. Chrome is a
 * semi-opaque rectangle, a title, and a "×" close; the body scrolls via the
 * inherited {@link ScrollView}, and the viewport auto-fits the screen height so
 * a short display can still reach every control by scrolling.
 *
 * The caller supplies the title, anchor, width, and a `build(view)` callback
 * that fills the scroll body (in local coords) and returns its full height —
 * keeping panel-specific, scene-coupled content out of this generic shell.
 */
export class Panel extends Overlay {
  /**
   * @param {Phaser.Scene} scene
   * @param {{
   *   position: () => {x:number, y:number},
   *   width: number,
   *   title: string,
   *   build: (view: import('./ScrollView.js').ScrollView) => number,
   *   headerH?: number, depth?: number, closeDepth?: number, bottomMargin?: number,
   * }} opts  `position` (recomputed each build) anchors the top-left; `build`
   *   populates the body and returns its full content height. `depth` draws the
   *   backdrop (title/body at depth+1, scrollbar depth+2); `closeDepth` raises the
   *   × above other chrome (e.g. the menu that toggles this panel).
   */
  constructor(scene, opts) {
    const depth = opts.depth ?? 20;
    super(scene, { modal: false, depth: depth + 1, scrollbarDepth: depth + 2 });
    this._opts = {
      headerH: 30,
      bgDepth: depth,
      titleDepth: depth + 1,
      closeDepth: opts.closeDepth ?? 35,
      bottomMargin: 8,
      ...opts,
    };
  }

  /** @override */
  _build(animate) {
    const o = this._opts;
    const { x, y } = o.position();
    const w = o.width;
    const add = this.scene.add;
    const contentTop = y + o.headerH;

    // Chrome: a semi-opaque backing rect (sized once the viewport is known), a
    // title, and a red × (raised above the menu band so it stays clickable when
    // the menu that toggled this panel is still up over it).
    const bg = add.rectangle(x, y, w, 100, 0x000000, 0.72).setOrigin(0, 0).setDepth(o.bgDepth);
    const title = add
      .text(x + 10, y + 8, o.title, { ...Config.ui.type.small, color: Config.ui.color.accentText })
      .setDepth(o.titleDepth);
    const close = this._closeButton(x + w - 20, y + 14, o.closeDepth);
    this.parts = [bg, title, close];

    // Fill the scroll body (local coords: 0,0 = viewport top-left) and get its
    // full height, then fit the viewport to the space above the bottom edge —
    // shrinking to the content when it fits, capping and scrolling when it doesn't.
    const contentH = o.build(this.scrollView);
    const avail = this.scene._layout.h - o.bottomMargin - contentTop;
    const viewH = Math.max(60, Math.min(contentH, avail));

    bg.setSize(w, o.headerH + viewH);
    // Draggable like a window: the whole panel clamps on-screen (also the
    // modeless hit-test, via Overlay._overSelf); the header strip (minus the ×
    // zone) is the drag handle.
    this._windowRect = { x, y, w, h: o.headerH + viewH };
    this._titleBar = { x, y, w: w - 40, h: o.headerH };
    this.scrollView.layout({ x, y: contentTop, w, h: viewH }, contentH);

    // Resizable by the bottom edge: grow/shrink the backing rect and the viewport.
    this._resizable = true;
    this._minCardH = o.headerH + 60;
    this._relayout = (cardH) => {
      bg.setSize(w, cardH);
      const rg = this.scrollView.region;
      this.scrollView.relayout({ x: rg.x, y: rg.y, w: rg.w, h: cardH - o.headerH });
    };

    this.scene.assignToUI(this.parts);
    this._fadeIn(animate);
  }
}
