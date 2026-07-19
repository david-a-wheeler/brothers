import { Config } from '../config.js';

/**
 * The scene's two-camera rendering rig and every camera behaviour: the world
 * camera (pans, zooms, bounded to the arena) and the fixed UI camera (renders
 * only the HUD), plus the arena clamp, wheel/pinch zoom-about-a-point, the
 * in-flight keep-both-balls-in-view follow, and the settle reframe.
 *
 * Split rendering between the zoomable world camera and a fixed UI camera so
 * the HUD never zooms or scrolls with the arena. The main camera is bounded
 * to the arena (so zooming in can't scroll past the edges) and renders
 * everything except the HUD; the UI camera renders only the HUD.
 *
 * Constructed after the world and HUD exist (it snapshots them onto their
 * cameras); world/UI code reaches it through the scene's assignToUI /
 * assignToWorld forwarders, which no-op before it exists.
 */
export class CameraRig {
  /**
   * @param {import('./GameScene.js').GameScene} scene
   */
  constructor(scene) {
    this.scene = scene;
    /** The fixed screen-space camera; it renders only the HUD. */
    this.uiCamera = scene.cameras.add(0, 0, scene._layout.w, scene._layout.h);

    const hudObjects = [...scene.hud.objects, scene.tip.box];
    // Split what exists now: the HUD to the UI camera, everything else (the world)
    // to the world camera. Objects created *later* assign themselves explicitly
    // (assignToUI / assignToWorld, via the scene's forwarders), so this snapshot
    // only has to cover setup time.
    this.assignToUI(hudObjects);
    this.assignToWorld(scene.children.list.filter((o) => !hudObjects.includes(o)));

    this.layout(true); // initial viewport/zoom (start fully zoomed out)
  }

  /**
   * Assign a display object (or array) to the fixed UI camera only — the world
   * camera ignores it, so it stays in screen space and never zooms/scrolls with
   * the arena. Use for HUD, overlays, tooltips: anything drawn in UI space.
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToUI(obj) {
    this.scene.cameras.main.ignore(obj);
  }

  /**
   * Assign a display object (or array) to the world camera only — the UI camera
   * ignores it, so a world-space thing created after camera setup (e.g. an effect)
   * doesn't also draw on the fixed HUD camera. Shared world code calls this as
   * `scene.assignToWorld?.(obj)`, a no-op on scenes with no UI camera (the title).
   *
   * @param {Phaser.GameObjects.GameObject|Phaser.GameObjects.GameObject[]} obj
   * @returns {void}
   */
  assignToWorld(obj) {
    // The rig doesn't exist yet while create() builds the World: entity
    // constructors (a Bomb's direction arrow, a glow ring) run long before the
    // rig's constructor. That's fine — the constructor snapshots everything alive
    // at that moment and assigns it to the world camera — so a pre-rig call is
    // "nothing to do yet", not an error (the scene's forwarder no-ops it).
    this.uiCamera?.ignore(obj);
  }

  /**
   * Lay out the cameras for the current screen: the world camera fills the
   * window *below* the HUD strip; the UI camera fills the whole window. The
   * minimum zoom fits the (per-level) arena plus an edge margin into that world
   * viewport. `resetZoom` (initial/level-load) snaps to that fit; otherwise we
   * keep the player's current zoom and only raise it to the new minimum.
   *
   * @param {boolean} [resetZoom]
   * @returns {void}
   */
  layout(resetZoom = false) {
    const { w, h, hudHeight } = this.scene._layout;
    const M = Config.zoom.edgeMargin;
    const main = this.scene.cameras.main;
    main.setViewport(0, hudHeight, w, h - hudHeight);
    this.uiCamera.setViewport(0, 0, w, h);
    // Were we fitted to the arena (at the min zoom)? Capture before recomputing.
    // If so, stay fitted across the resize — otherwise shrinking the window drops
    // the min zoom below the current one, so the arena would stay zoomed in and
    // off-centre. A deliberate zoom-in (zoom above min) is preserved.
    const wasFitted = main.zoom <= this._minZoom + 1e-3;
    this._minZoom = Math.min(
      main.width / (this.scene.arena.width + 2 * M),
      main.height / (this.scene.arena.height + 2 * M)
    );
    if (resetZoom || wasFitted || main.zoom < this._minZoom) main.setZoom(this._minZoom);
    this.clamp();
  }

  /**
   * Constrain the world camera in world space. We clamp by hand instead of with
   * Phaser's `setBounds` because, when the arena is smaller than the view (zoomed
   * out so gray shows), `setBounds` pins the arena to an edge rather than
   * centring it. Per axis: if the view is wider than the arena + both margins,
   * centre the arena; otherwise clamp scroll so the view stays within the arena
   * expanded by the margin (up to `M` of gray past any edge). Any zoom, any arena
   * size. Call after every pan/zoom (follow uses its own path during flight).
   *
   * @returns {void}
   */
  clamp() {
    const main = this.scene.cameras.main;
    const halfVW = main.width / 2;
    const halfVH = main.height / 2;
    const [midX, midY] = this._clampedCenter(
      main.scrollX + halfVW,
      main.scrollY + halfVH,
      main.zoom
    );
    main.setScroll(midX - halfVW, midY - halfVH);
  }

  /**
   * Clamp a desired world view-centre for a given zoom to the arena rules: if the
   * view is wider than the arena + both margins on an axis, centre the arena on
   * it; otherwise keep the view within the arena expanded by the margin. Shared
   * by {@link clamp} and the settle reframe ({@link frameBrothers}).
   *
   * @param {number} cx @param {number} cy @param {number} zoom
   * @returns {[number, number]} The clamped centre.
   */
  _clampedCenter(cx, cy, zoom) {
    const M = Config.zoom.edgeMargin;
    const aw = this.scene.arena.width;
    const ah = this.scene.arena.height;
    const halfSpanX = this.scene.cameras.main.width / zoom / 2; // half the world width in view
    const halfSpanY = this.scene.cameras.main.height / zoom / 2;
    return [
      halfSpanX * 2 >= aw + 2 * M ? aw / 2 : Phaser.Math.Clamp(cx, -M + halfSpanX, aw + M - halfSpanX),
      halfSpanY * 2 >= ah + 2 * M ? ah / 2 : Phaser.Math.Clamp(cy, -M + halfSpanY, ah + M - halfSpanY),
    ];
  }

  /**
   * Frame the settled pair: because Phaser follows only their midpoint (with a
   * deadzone), a ball can end up at/over the edge. Once the shot settles, gently
   * pan + zoom (Phaser's own camera tweens) to a view that fits the whole pair's
   * box — zooming out only as needed (never tighter, never past the fit-all
   * minimum) and centred on them within the arena clamp.
   *
   * @returns {void}
   */
  frameBrothers() {
    const cam = this.scene.cameras.main;
    const M = Config.zoom.edgeMargin;
    const a = this.scene.brothers.david.go;
    const b = this.scene.brothers.ken.go;
    // If both balls are already fully in view, leave the camera where it is — no
    // needless drift at rest. Only reframe when one ended up at/over the edge.
    const view = cam.worldView;
    const framed = (o) =>
      o.x - o.radius >= view.x &&
      o.x + o.radius <= view.right &&
      o.y - o.radius >= view.y &&
      o.y + o.radius <= view.bottom;
    if (framed(a) && framed(b)) return;

    const fit = Math.min(
      cam.width / (this.scene.brothers.spanWidth + 2 * M),
      cam.height / (this.scene.brothers.spanHeight + 2 * M)
    );
    const zoom = Phaser.Math.Clamp(Math.min(fit, cam.zoom), this._minZoom, Config.zoom.max);
    const [x, y] = this._clampedCenter(this.scene.brothers.x, this.scene.brothers.y, zoom);
    cam.zoomTo(zoom, 300, 'Sine.easeInOut');
    cam.pan(x, y, 300, 'Sine.easeInOut');
  }

  /** Cancel any in-progress settle pan/zoom tween so manual input takes over. */
  stopGlide() {
    this.scene.cameras.main.panEffect.reset();
    this.scene.cameras.main.zoomEffect.reset();
  }

  /**
   * Ease the zoom out while a shot is in flight so both balls stay in frame —
   * the one thing Phaser's follow can't do (it only pans to a point). Uses the
   * pair's combined span (see Brothers.spanWidth/Height); only ever zooms *out*,
   * never past the fit-everything minimum, and gently so it never jostles.
   *
   * @returns {void}
   */
  keepBallsInView() {
    if (this.scene._isPanning || this.scene._pinchDist) return; // a manual gesture owns the camera
    const cam = this.scene.cameras.main;
    const M = Config.zoom.edgeMargin;
    const a = this.scene.brothers.david.go;
    const b = this.scene.brothers.ken.go;
    // Axis-aligned box enclosing both balls (radii included).
    const left = Math.min(a.x - a.radius, b.x - b.radius);
    const right = Math.max(a.x + a.radius, b.x + b.radius);
    const top = Math.min(a.y - a.radius, b.y - b.radius);
    const bottom = Math.max(a.y + a.radius, b.y + b.radius);

    // Zoom out (eased) only if the box no longer fits the view.
    let view = cam.worldView;
    if (right - left > view.width || bottom - top > view.height) {
      const fit = Math.min(cam.width / (right - left + 2 * M), cam.height / (bottom - top + 2 * M));
      cam.setZoom(Phaser.Math.Linear(cam.zoom, Math.max(fit, this._minZoom), 0.08));
      view = cam.worldView; // zoom changed the visible area
    }

    // Pan (eased) only when the box crosses a view edge — so a view that already
    // shows both balls (e.g. fully zoomed out) never drifts.
    let dx = 0;
    if (left < view.x) dx = left - view.x;
    else if (right > view.right) dx = right - view.right;
    let dy = 0;
    if (top < view.y) dy = top - view.y;
    else if (bottom > view.bottom) dy = bottom - view.bottom;
    if (dx || dy) cam.setScroll(cam.scrollX + dx * 0.12, cam.scrollY + dy * 0.12);

    this.clamp();
  }

  /**
   * Multiply the camera zoom by `factor` (clamped) while keeping the world
   * point under (`screenX`, `screenY`) fixed, so zoom homes in on the cursor
   * or pinch midpoint rather than the screen centre. Camera bounds keep the
   * view from scrolling past the arena edges.
   *
   * @param {number} factor   Zoom multiplier (>1 in, <1 out).
   * @param {number} screenX  Focal point, screen pixels.
   * @param {number} screenY
   * @returns {void}
   */
  zoomBy(factor, screenX, screenY) {
    const cam = this.scene.cameras.main;
    this.stopGlide(); // manual zoom cancels an in-progress settle pan/zoom
    const z0 = cam.zoom;
    const z1 = Phaser.Math.Clamp(z0 * factor, this._minZoom, Config.zoom.max);
    if (z1 === z0) return; // already at a clamp limit: nothing to do (and avoids drift)
    // Keep the world point under (screenX, screenY) fixed across the zoom change.
    // We can't use getWorldPoint for the "after" point: the camera matrix is only
    // rebuilt at render time (preRender), so right after setZoom it still holds the
    // old zoom while cam.zoom is already the new one — a mismatched read that pulls
    // the pivot toward the screen centre. Instead adjust scroll directly.
    //
    // The visible world point maps as worldX = scrollX + width/2 + (screenX - centerX)/zoom
    // (centerX/centerY are the viewport centre in canvas pixels). Holding worldX and
    // screenX fixed as zoom goes z0 -> z1, the width/2 term cancels, leaving:
    const inv = 1 / z0 - 1 / z1;
    const dx = (screenX - cam.centerX) * inv;
    const dy = (screenY - cam.centerY) * inv;
    cam.setZoom(z1);
    cam.setScroll(cam.scrollX + dx, cam.scrollY + dy);
    this.clamp();
  }
}
