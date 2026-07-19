import { Config, Depth } from '../config.js';
import * as diag from '../diag.js';
import { sfx } from '../Sfx.js';
import { activePackName } from '../levels.js';
import { Brother } from './Brother.js';
import { Movable } from './Movable.js';
import { spawnRing } from './effects.js';

/** Matter's Body namespace (raw-body manipulation, as in Hazard). */
const Body = Phaser.Physics.Matter.Matter.Body;

/**
 * A level-placed **picture** the brothers can hit — the first world object drawn
 * from an external image file rather than Phaser primitives. The image lives in
 * the pack's `assets/` directory (`packs/<Pack>/assets/<image>`) and is loaded
 * ahead of the scene by {@link Item.preloadAssets}; the Tiled object's rectangle
 * places and *sizes* it (the image is stretched to the rectangle, so authors
 * control the footprint without editing pixels).
 *
 * Two ORTHOGONAL per-item axes (never conflate them as behaviors grow):
 *
 * - **`body`** — what the item is physically. `'none'` (default): body-less,
 *   like a {@link import('./Region.js').Region} — nothing bounces off it, and
 *   its hit box is the image's **opaque pixels only**, point-sampled per frame
 *   from a one-time alpha map of the texture (a transparent background or
 *   holes never registers, so a star's concave gaps can be rolled through —
 *   something a Matter body, being convex, could never express).
 *   `'solid'`/`'pushable'`: a real Matter body — the **convex hull of the
 *   opaque pixels** — that brothers and bombs bounce off. `'solid'` is fixed
 *   in place (bombs wall-reflect off it); `'pushable'` is dynamic: it gets
 *   shoved, slides to rest under air friction, and behaves in mud like any
 *   mover (which is why Item extends {@link Movable}). With a body, hits
 *   arrive physically — the scene's collision router calls
 *   {@link onActorContact} — and the pixel rule no longer gates them: contact
 *   happens at the hull, which spans the concave gaps.
 * - **`onHit`** — what a hit does, purely consequential: `'collect'` (vanish
 *   with a gold ring + chime; lasts until the next level restart rebuilds the
 *   World — a turn reset doesn't, same rule as mud) or `'none'`; a
 *   `'hazard'`-style penalty would slot in here. Never give `onHit` a value
 *   that really describes physicality.
 *
 * `brotherCenterHit` refines *body-less* hit testing only (false, the default:
 * the brother's round body touching an opaque pixel counts; true: his centre
 * must be over one). With a body it is meaningless — the body blocks entry —
 * so setting both is refused loudly.
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
    /** @type {'none'|'solid'|'pushable'} What the item is physically (see class doc). */
    this.bodyMode = this._parseBody(def);
    /** True = the brother's centre must be over an opaque pixel, not just his rim. */
    this.brotherCenterHit = def.brotherCenterHit ?? false;
    if (this.brotherCenterHit && this.bodyMode !== 'none') {
      diag.error(
        `Item "${def.name ?? def.kind}": brotherCenterHit only applies with body 'none' — ignored`
      );
      this.brotherCenterHit = false;
    }

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

    /** @type {MatterJS.BodyType|null} The hull body (solid/pushable modes only). */
    this.body = this.bodyMode === 'none' ? null : this._buildBody();
  }

  /**
   * Build the Matter body for a solid/pushable item: the convex hull of the
   * image's solid pixels, scaled to the drawn size — so what you bounce off is
   * the tightest convex fit of what you see. `fromVertices` places the body's
   * centre of MASS at the given point, so we aim it at (image centre + hull
   * centroid); the hull outline then lands exactly over the drawn image, and
   * {@link _glueView} walks the same offset back each frame. A degenerate hull
   * (a fully transparent or sliver image) falls back to the image rectangle.
   *
   * @returns {MatterJS.BodyType}
   */
  _buildBody() {
    const d = this.def;
    const opts = {
      isStatic: this.bodyMode === 'solid',
      friction: 0,
      frictionStatic: 0,
      frictionAir: Config.item.frictionAir,
      restitution: Config.item.restitution,
    };
    let body = null;
    const hull = hullFor(this._map);
    if (hull.length >= 3) {
      const sx = d.width / this._map.w;
      const sy = d.height / this._map.h;
      // Texture-space hull -> world-scale coordinates local to the image centre.
      const verts = hull.map((p) => ({ x: p.x * sx - d.width / 2, y: p.y * sy - d.height / 2 }));
      /** Hull centre of mass, in image-centre-local coords (the view-glue offset). */
      this._com = polygonCentroid(verts);
      try {
        body = this.scene.matter.add.fromVertices(d.x + this._com.x, d.y + this._com.y, [verts], opts);
      } catch (e) {
        diag.error(`Item "${d.name ?? d.kind}": hull body failed — using the image rectangle`, e);
        body = null;
      }
    }
    if (!body) {
      this._com = { x: 0, y: 0 };
      body = this.scene.matter.add.rectangle(d.x, d.y, d.width, d.height, opts);
    }
    body.entity = this; // collision-router back-reference, as Entity's helpers do
    return body;
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
   * Validate the Tiled `body` value, surfacing a typo instead of silently
   * doing something the author didn't ask for.
   *
   * @param {import('../levels.js').EntityDef} def
   * @returns {'none'|'solid'|'pushable'}
   */
  _parseBody(def) {
    const v = def.body ?? 'none';
    if (v === 'none' || v === 'solid' || v === 'pushable') return v;
    diag.error(`Item "${def.name ?? def.kind}": unknown body "${v}" — treating as 'none'`);
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
   * Per-frame. Physical modes: contact detection is the collision router's job,
   * so ours is only teardown after a collect (removing the body inside the very
   * collision event that collected it would mutate the world mid-step; the next
   * frame is safe) and keeping a pushable body's visual glued. Body-less mode:
   * test each mover against the solid pixels and fire {@link _hit} only on the
   * frame it comes into touch (edge-triggered via {@link _inside}, the Region
   * pattern), gated to live play — the same top gate as the collision router —
   * so nothing collects while the board is pristine or during the end-of-level
   * banner; *any* phase within it, so a brother rolling to rest on an item
   * still collects.
   *
   * @returns {void}
   */
  update() {
    if (this.collected) {
      if (this.body) {
        this.scene.matter.world.remove(this.body); // deferred from _collect
        this.body = null;
      }
      return; // inert husk until the next restart rebuild
    }
    if (this.body) {
      if (!this.body.isStatic) this._glueView();
      return;
    }
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
   * Physical contact (solid/pushable only): the scene's collision router found
   * a brother against this item's body and dispatches it here — the same
   * consequence path as a body-less pixel touch. `collisionstart` fires once
   * per new contact, so this is naturally edge-triggered.
   *
   * @param {import('./Entity.js').Entity} actor
   * @returns {void}
   */
  onActorContact(actor) {
    this._hit(actor);
  }

  /**
   * Keep the visual (and any mud splat) glued to a pushable body. The body's
   * origin is the hull's centre of mass, not the image centre, so walk the
   * {@link _buildBody} offset back through the current rotation.
   *
   * @returns {void}
   */
  _glueView() {
    const p = this.body.position;
    const a = this.body.angle;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ox = -this._com.x;
    const oy = -this._com.y;
    this.view.setPosition(p.x + ox * c - oy * s, p.y + ox * s + oy * c);
    this.view.setRotation(a);
    this._updateMudView();
  }

  /**
   * Re-arm a pushable body when play (re)starts — only needed after a dev
   * "More turns" resume unfroze the level, since the body is dynamic from
   * construction. No-op for solid/body-less items.
   * @returns {void}
   */
  onPlayStart() {
    if (this.body && this.bodyMode === 'pushable') Body.setStatic(this.body, false);
  }

  /** Freeze a pushable body so it stops sliding during the end-of-level banner. */
  onLevelEnd() {
    if (this.body && this.bodyMode === 'pushable') Body.setStatic(this.body, true);
  }

  /** Shed a settle's worth of loose mud, silently — the Hazard rule. */
  onSettle() {
    if (this.isMuddy) this.shedMudTurn();
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
    // Stop blocking immediately (a plain flag is safe mid-collision-event);
    // the body itself is removed on the next update(), outside the step.
    if (this.body) this.body.isSensor = true;
    const C = Config.item;
    const d = this.def;
    spawnRing(this.scene, d.x, d.y, Math.max(d.width, d.height) / 2, C.collectRingColor);
    sfx.collect();
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
   * Body-less: cull only while nothing is touching, so an exit edge is always
   * observed (Region's reasoning); the rect is pre-inflated by a mover radius
   * so a touch can't begin while culled. A body item is never culled — a
   * pushable must glue its view every frame wherever it is, and a collected
   * body needs its deferred-removal tick.
   *
   * @returns {Phaser.Geom.Rectangle|null}
   */
  bounds() {
    if (this.body) return null;
    return this._inside.size ? null : this._cullBounds;
  }

  /** @returns {Phaser.GameObjects.GameObject|null} The image receives hover/press. */
  interactiveView() {
    return this.view;
  }

  // --- Mud accessors: live only for a pushable body (see Movable). A solid or
  // body-less item never moves, so mud drag would be meaningless on it — but a
  // Region may still splat one that is *placed* inside mud, which is harmless
  // (and reads fine: a thing lying in a puddle looks muddy).

  /** @returns {MatterJS.BodyType|null} The body that carries mud friction. */
  get mudBody() {
    return this.bodyMode === 'pushable' ? this.body : null;
  }
  /** @returns {number} Body-centre x (falls back to the placed centre). */
  get mudX() {
    return this.body ? this.body.position.x : this.def.x;
  }
  /** @returns {number} Body-centre y. */
  get mudY() {
    return this.body ? this.body.position.y : this.def.y;
  }
  /** @returns {number} Splat sizing radius: half the smaller drawn side. */
  get mudRadius() {
    return Math.min(this.def.width, this.def.height) / 2;
  }
  /** @returns {number} Base air-friction mud adds onto — what makes a push settle. */
  get _baseFrictionAir() {
    return Config.item.frictionAir;
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
 * The convex hull of a texture's solid pixels, in texture coordinates, cached
 * on the alpha-map object (one hull per image ever; each body item scales it
 * to its own drawn size). Boundary candidates are the corners of each row's
 * leftmost and rightmost solid texels — so the hull bounds whole pixels — fed
 * to a monotone-chain hull. Uses the same alpha threshold as hit testing, so
 * what you bounce off agrees with what registers a body-less touch.
 *
 * @param {{alpha: Uint8Array, w: number, h: number, hull?: {x:number,y:number}[]}} map
 * @returns {{x:number, y:number}[]}
 */
function hullFor(map) {
  if (map.hull) return map.hull;
  const pts = [];
  for (let y = 0; y < map.h; y++) {
    let min = -1;
    let max = -1;
    for (let x = 0; x < map.w; x++) {
      if (map.alpha[y * map.w + x] >= Config.item.alphaThreshold) {
        if (min < 0) min = x;
        max = x;
      }
    }
    if (min >= 0) {
      pts.push({ x: min, y }, { x: min, y: y + 1 }, { x: max + 1, y }, { x: max + 1, y: y + 1 });
    }
  }
  map.hull = convexHull(pts);
  return map.hull;
}

/**
 * Andrew's monotone-chain convex hull. Strict turns only (collinear points are
 * dropped), so the hull is as few vertices as possible for the physics engine.
 *
 * @param {{x:number, y:number}[]} pts
 * @returns {{x:number, y:number}[]} Hull vertices, or fewer than 3 points if degenerate.
 */
function convexHull(pts) {
  if (pts.length < 3) return pts;
  const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const chain = (input) => {
    const out = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop(); // endpoint duplicates the other chain's start
    return out;
  };
  return chain(sorted).concat(chain(sorted.slice().reverse()));
}

/**
 * Area-weighted centroid of a polygon (the standard shoelace-based formula —
 * the same centre Matter uses to place a body built from these vertices).
 *
 * @param {{x:number, y:number}[]} verts
 * @returns {{x:number, y:number}}
 */
function polygonCentroid(verts) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < verts.length; i++) {
    const p = verts[i];
    const q = verts[(i + 1) % verts.length];
    const cr = p.x * q.y - q.x * p.y;
    area += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-6) return { x: 0, y: 0 };
  return { x: cx / (6 * area), y: cy / (6 * area) };
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
