import { Config, Depth } from '../config.js';
import * as diag from '../diag.js';
import { activePackName } from '../levels.js';
import { Brother } from './Brother.js';
import { Movable } from './Movable.js';
import { spawnRing } from './effects.js';

/**
 * A level-placed **picture** the brothers can hit — the first world object drawn
 * from an external image file rather than Phaser primitives. The image lives in
 * the pack's `assets/` directory (`packs/<Pack>/assets/<image>`) and is loaded
 * ahead of the scene by {@link Item.preloadAssets}; the Tiled object's rectangle
 * places and *sizes* it (the image is stretched to the rectangle, so authors
 * control the footprint without editing pixels).
 *
 * The hit box is the image's **opaque pixels only** — a transparent background
 * (or holes) never registers, so a star's concave gaps can be rolled through.
 * That rules out a Matter body (convex, no holes), so like a
 * {@link import('./Region.js').Region} the Item is body-less: it point-samples a
 * one-time alpha map of its texture per frame and edge-triggers a hit, and it
 * never blocks movement. Two per-item hit rules (Tiled `brotherCenterHit`):
 * false (default) counts the brother's round body touching an opaque pixel;
 * true demands the brother's *centre* be over one.
 *
 * The long-term design is two ORTHOGONAL per-item axes, so keep them from
 * conflating as behaviors are added:
 * - what the item **is physically** — a future `body` property (none — today's
 *   only value — vs. a solid/pushable Matter body, which would bounce off its
 *   convex approximation while triggers stay pixel-accurate);
 * - what a hit **does** — `onHit`, which stays purely consequential (v1:
 *   `'collect'` — vanish with a gold ring — or `'none'`; a `'hazard'`-style
 *   penalty would slot in here). Never give `onHit` a value that really
 *   describes physicality (a "push" is a body, not a hit consequence).
 * Collection lasts until the next level restart rebuilds the World (a turn
 * reset doesn't — same rule as mud). Item extends {@link Movable} for that
 * future pushable body (a pushed item should behave in mud like any mover);
 * until then it has no body, so every inherited mud accessor's inert default
 * (`mudBody` null, `mudRadius` 0) is already right and none is overridden here.
 */
export class Item extends Movable {
  /** Ticked every frame so the alpha-map hit test can run (see {@link update}). */
  needsUpdate = true;

  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    /** True once collected; the entity then stays tracked but inert until the
     *  next scene restart rebuilds the World (removing it mid-update would
     *  splice the very _updaters list World.update is iterating). */
    this.collected = false;
    /** @type {Set<import('./Movable.js').Movable>} Movers touching as of last frame. */
    this._inside = new Set();
    /** @type {'collect'|'none'} What a hit does (see class doc). */
    this.onHit = this._parseOnHit(def);
    /** True = the brother's centre must be over an opaque pixel, not just his rim. */
    this.brotherCenterHit = def.brotherCenterHit ?? false;

    // Resolve the texture; a missing/unloaded image gets a loud checkerboard
    // placeholder (all-opaque, so the item is still hittable and testable)
    // rather than an invisible, silently-broken object.
    let key = def.image ? Item.textureKey(def.image) : null;
    if (!key || !scene.textures.exists(key)) {
      diag.error(
        `Item "${def.name ?? def.kind}": image ${def.image ? `"${def.image}" not loaded` : 'not set'}` +
          ` — showing placeholder (expected packs/${activePackName()}/assets/${def.image ?? '<image>'})`
      );
      key = ensurePlaceholder(scene);
    }

    // A point-placed (zero-size) object falls back to the image's native size;
    // backfilled onto the def so the AABB and bounds() agree with the visual.
    const frame = scene.textures.get(key).get();
    if (!def.width) def.width = frame.realWidth;
    if (!def.height) def.height = frame.realHeight;
    /** World AABB of the drawn image (also the alpha map's world footprint). */
    this._aabb = new Phaser.Geom.Rectangle(
      def.x - def.width / 2,
      def.y - def.height / 2,
      def.width,
      def.height
    );
    // Culling rect, pre-inflated by the biggest plausible mover radius so a
    // brother can never touch an item that update() skipped as off-view.
    const pad = Config.ball.radius * 2;
    this._cullBounds = new Phaser.Geom.Rectangle(
      this._aabb.x - pad,
      this._aabb.y - pad,
      this._aabb.width + pad * 2,
      this._aabb.height + pad * 2
    );

    // `transparency` (0-100, Tiled-friendly percent) is *visual only* — the hit
    // box always comes from the image's own pixel alpha, never this fade.
    const transparency = Phaser.Math.Clamp(def.transparency ?? 0, 0, 100);
    this.view = scene.add
      .image(def.x, def.y, key)
      .setDisplaySize(def.width, def.height)
      .setAlpha(1 - transparency / 100)
      .setDepth(Depth.item);

    /** The texture's alpha bytes, shared per-texture across items (see below). */
    this._map = alphaMapFor(scene, key);
  }

  /**
   * The game-global texture key for a pack image. Pack-qualified because
   * textures outlive scene restarts *and* pack switches, and two packs may both
   * have a `star.png`.
   *
   * @param {string} image  Bare filename as authored in Tiled.
   * @returns {string}
   */
  static textureKey(image) {
    return `item:${activePackName()}/${image}`;
  }

  /**
   * Queue every Item image of the pending level for load. Called from
   * GameScene.preload() (which re-runs on every restart/level switch, so this
   * covers cold boot and navigation alike); the `textures.exists` guard makes
   * it idempotent. Only bare filenames are accepted — an author path escaping
   * the pack's `assets/` directory is refused loudly.
   *
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef[]} defs  This level's Item defs.
   * @returns {void}
   */
  static preloadAssets(scene, defs) {
    for (const def of defs) {
      const image = def.image;
      if (!image) continue; // constructor reports it and shows the placeholder
      if (image.includes('/') || image.includes('\\') || image.startsWith('.')) {
        diag.error(`Item "${def.name ?? def.kind}": image "${image}" must be a bare filename`);
        continue;
      }
      const key = Item.textureKey(image);
      if (scene.textures.exists(key)) continue;
      // One failed-load reporter per scene (the loader survives restarts, so
      // wiring it per preload would stack duplicates).
      if (!scene._itemLoadErrorWired) {
        scene._itemLoadErrorWired = true;
        scene.load.on('loaderror', (file) => {
          if (String(file.key).startsWith('item:')) {
            diag.error(`Item image failed to load: ${file.url}`);
          }
        });
      }
      scene.load.image(key, `packs/${activePackName()}/assets/${image}`);
    }
  }

  /**
   * Validate the Tiled `onHit` value, surfacing a typo instead of silently
   * doing something the author didn't ask for.
   *
   * @param {import('../levels.js').EntityDef} def
   * @returns {'collect'|'none'}
   */
  _parseOnHit(def) {
    const v = def.onHit ?? 'collect';
    if (v === 'collect' || v === 'none') return v;
    diag.error(`Item "${def.name ?? def.kind}": unknown onHit "${v}" — treating as 'none'`);
    return 'none';
  }

  /**
   * Is this world point over one of the image's solid pixels? Maps the point
   * into the (display-scaled) texture and reads the shared alpha map.
   *
   * @param {number} wx @param {number} wy
   * @returns {boolean}
   */
  _opaqueAt(wx, wy) {
    const { alpha, w, h } = this._map;
    const tx = Math.floor(((wx - this._aabb.x) * w) / this._aabb.width);
    const ty = Math.floor(((wy - this._aabb.y) * h) / this._aabb.height);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    return alpha[ty * w + tx] >= Config.item.alphaThreshold;
  }

  /**
   * Does this mover touch the item's solid pixels, per the item's hit rule?
   * Centre mode is a single sample. Body mode would be exact with an O(r²)
   * pixel sweep of the disc; instead — after a cheap circle-vs-AABB reject — we
   * sample a fixed 13-point pattern (centre, 8 rim points slightly inset, 4 at
   * mid-radius). At brother radius (~30px) that only misses solid slivers
   * narrower than ~15px that also thread both rings — invisible in play, and
   * the alpha threshold already softens the boundary by design.
   *
   * @param {import('./Movable.js').Movable} m
   * @returns {boolean}
   */
  _touches(m) {
    const x = m.mudX;
    const y = m.mudY;
    if (this.brotherCenterHit) return this._opaqueAt(x, y);
    const r = m.mudRadius;
    if (!r) return this._opaqueAt(x, y);
    SCRATCH_CIRCLE.setTo(x, y, r);
    if (!Phaser.Geom.Intersects.CircleToRectangle(SCRATCH_CIRCLE, this._aabb)) return false;
    if (this._opaqueAt(x, y)) return true;
    const rim = r * Config.item.sampleRimInset;
    const mid = r * 0.55;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      if (this._opaqueAt(x + Math.cos(a) * rim, y + Math.sin(a) * rim)) return true;
      // Every second angle also probes the mid ring (4 samples: 0/90/180/270°).
      if (i % 2 === 0 && this._opaqueAt(x + Math.cos(a) * mid, y + Math.sin(a) * mid)) return true;
    }
    return false;
  }

  /**
   * Per-frame: test each mover against the solid pixels and fire {@link _hit}
   * only on the frame it comes into touch (edge-triggered via {@link _inside},
   * the Region pattern). Gated to live play — the same top gate as the Matter
   * collision router — so nothing collects while the board is pristine or
   * during the end-of-level banner; *any* phase within it, so a brother rolling
   * to rest on an item still collects.
   *
   * @returns {void}
   */
  update() {
    if (this.collected) return; // inert husk until the next restart rebuild
    if (this.scene.status !== 'PLAYING') return;
    for (const m of this.world.movables()) {
      if (m instanceof Item) continue; // items don't hit items (incl. self)
      const touching = this._touches(m);
      const was = this._inside.has(m);
      if (touching && !was) {
        this._inside.add(m);
        this._hit(m);
      } else if (!touching && was) {
        this._inside.delete(m);
      }
    }
  }

  /**
   * A mover just came into touch. The single dispatch point for `onHit` — the
   * place a future hit consequence (a `'hazard'` penalty, bombs collecting)
   * plugs in. Physicality is NOT dispatched here: a solid/pushable item is a
   * future `body` property whose response lives on the Matter side (see the
   * class doc). v1: only a brother collects; a bomb rolling over an item is a
   * non-event.
   *
   * @param {import('./Movable.js').Movable} m
   * @returns {void}
   */
  _hit(m) {
    if (this.onHit === 'collect' && m instanceof Brother) this._collect();
  }

  /**
   * Vanish: gold ring + a short grow-and-fade of the image, then the view is
   * destroyed (the tooltip service detaches itself on destroy). The entity
   * object stays in the World's lists as an inert husk — see {@link collected}.
   *
   * @returns {void}
   */
  _collect() {
    if (this.collected) return;
    this.collected = true;
    const C = Config.item;
    const d = this.def;
    spawnRing(this.scene, d.x, d.y, Math.max(d.width, d.height) / 2, C.collectRingColor);
    diag.trace('item', 'collected', { who: d.name ?? 'Item' });
    this.scene.tweens.add({
      targets: this.view,
      scaleX: this.view.scaleX * 1.25,
      scaleY: this.view.scaleY * 1.25,
      alpha: 0,
      duration: C.collectDuration,
      ease: 'Cubic.Out',
      onComplete: () => this.view.destroy(),
    });
  }

  /**
   * Cull only while nothing is touching, so an exit edge is always observed
   * (Region's reasoning); the rect is pre-inflated by a mover radius so a
   * touch can't begin while culled.
   *
   * @returns {Phaser.Geom.Rectangle|null}
   */
  bounds() {
    return this._inside.size ? null : this._cullBounds;
  }

  /** @returns {Phaser.GameObjects.GameObject|null} The image receives hover/press. */
  interactiveView() {
    return this.view;
  }
}

/** @type {Map<string, {alpha: Uint8Array, w: number, h: number}>} Per-texture-key
 *  alpha maps. Module-level (not per-scene) because the textures themselves are
 *  game-global: extracted once per image ever, shared by every item using it,
 *  kept across restarts and pack switches. */
const ALPHA_MAPS = new Map();

/** Scratch for {@link Item#_touches}' pre-check, reused to avoid per-frame allocation. */
const SCRATCH_CIRCLE = new Phaser.Geom.Circle();

/** Key of the generated missing-image placeholder texture. */
const PLACEHOLDER_KEY = 'item:placeholder';

/**
 * Extract (or fetch the cached) alpha bytes of a texture: draw its source image
 * once onto a pooled canvas and keep just the alpha channel. Same-origin pack
 * files, so `getImageData` never taints.
 *
 * @param {Phaser.Scene} scene
 * @param {string} key
 * @returns {{alpha: Uint8Array, w: number, h: number}}
 */
function alphaMapFor(scene, key) {
  let map = ALPHA_MAPS.get(key);
  if (map) return map;
  const src = scene.textures.get(key).getSourceImage();
  const w = src.width;
  const h = src.height;
  const canvas = Phaser.Display.Canvas.CanvasPool.create(scene, w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  Phaser.Display.Canvas.CanvasPool.remove(canvas);
  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  map = { alpha, w, h };
  ALPHA_MAPS.set(key, map);
  return map;
}

/**
 * Generate the loud magenta/white checkerboard shown for a missing image (the
 * classic missing-texture look). Fully opaque, so a placeholder item still
 * hit-tests and plays normally.
 *
 * @param {Phaser.Scene} scene
 * @returns {string} The placeholder's texture key.
 */
function ensurePlaceholder(scene) {
  if (scene.textures.exists(PLACEHOLDER_KEY)) return PLACEHOLDER_KEY;
  const g = scene.add.graphics();
  const sq = 16;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      g.fillStyle((x + y) % 2 ? 0xffffff : 0xff00ff, 1);
      g.fillRect(x * sq, y * sq, sq, sq);
    }
  }
  g.generateTexture(PLACEHOLDER_KEY, sq * 4, sq * 4);
  g.destroy();
  return PLACEHOLDER_KEY;
}
