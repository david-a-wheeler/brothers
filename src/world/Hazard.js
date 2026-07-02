import { Config } from '../config.js';
import { Entity } from './Entity.js';

/** Matter's Body namespace (raw-body manipulation; no game object here). */
const Body = Phaser.Physics.Matter.Matter.Body;

/**
 * Base class for a *self-propelled* world object: a dynamic circular body that
 * the physics engine moves and bounces off solids (walls, the arena edge) while
 * passing through sensors (goals, teleporters). It travels at a **constant
 * speed** — {@link update} re-normalises its velocity each frame so glancing
 * hits and Matter's small energy drift never speed it up or slow it down — and
 * it teleports like an actor when it enters a teleporter ({@link onTeleport}).
 *
 * A hazard is **dormant** (its body static) until play begins: the scene calls
 * {@link onPlayStart} on the first launch (via {@link World#notifyPlayStart}),
 * which {@link activate}s it, and {@link onLevelEnd} freezes it again so it stops
 * acting during the end-of-level banner. Because the body is a raw Matter body
 * (not a Phaser game object), the subclass supplies a display object as
 * `this.view` and this base keeps it glued to the body each frame.
 *
 * Concrete behaviour on touching a brother lives in the subclass
 * ({@link onActorContact}); {@link Bomb} is the first, ending the level or the
 * turn. Reads these level-model fields (all defaulted from `Config.bomb`):
 * `speed`, `angle` (degrees), `radius`/`size`, and `mode`
 * (`'gameover'` | `'turnend'`). Custom-art fields (`anim`, `animInfo`, `sound`)
 * are parsed and stored for a later pass but not yet acted on.
 */
export class Hazard extends Entity {
  /** Dynamic entities are ticked every frame (see {@link update}). */
  needsUpdate = true;

  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    const C = Config.bomb;
    /** Circle radius (Tiled `radius`/`size`, else the config default). */
    this.radius = def.radius ?? def.size ?? C.radius;
    /** Constant travel speed (same per-frame units as the slingshot speeds). */
    this.speed = def.speed ?? C.speed;
    /** Initial heading in degrees (0 = +x, 90 = +y/down). */
    this.angleDeg = def.angle ?? 0;
    /** Outcome on hitting a brother: immediate game over, or just end the turn. */
    this.mode = def.mode === 'turnend' ? 'turnend' : 'gameover';

    // Scaffolded custom-art fields: parsed and stored now so level authors can
    // set them; real per-level asset loading is a follow-up (see the plan).
    this.animFile = def.anim ?? null;
    this.animInfo = def.animInfo ?? null;
    this.soundFile = def.sound ?? null;

    /** The dynamic body; starts static (dormant) until {@link activate}. */
    this.body = this._dynCircleBody(def.x, def.y, this.radius, {
      restitution: C.restitution,
    });
    Body.setStatic(this.body, true);

    /** @type {Phaser.GameObjects.GameObject|null} Display object, set by the subclass. */
    this.view = null;
  }

  /**
   * Wake the hazard: make its body dynamic and launch it along `angle` at
   * `speed`. Called when play starts (and again if play resumes via the dev
   * "More turns"). Idempotent enough to re-arm on each call.
   *
   * @returns {void}
   */
  activate() {
    Body.setStatic(this.body, false);
    const a = Phaser.Math.DegToRad(this.angleDeg);
    Body.setVelocity(this.body, { x: Math.cos(a) * this.speed, y: Math.sin(a) * this.speed });
  }

  /** Freeze the hazard (body static) so it stops moving and triggering. */
  deactivate() {
    Body.setStatic(this.body, true);
  }

  /** Begin moving when the level starts play. */
  onPlayStart() {
    this.activate();
  }

  /** Freeze when the level ends so it can't trigger during the banner. */
  onLevelEnd() {
    this.deactivate();
  }

  /**
   * Warp to a destination when this hazard enters a teleporter. Position jumps;
   * direction is kept and {@link update} restores the constant speed next frame
   * (so `retain` only softens the arrival frame — a hazard never speeds up or
   * slows down for good).
   *
   * @param {{x:number, y:number}} dest @param {number} retain
   * @returns {void}
   */
  onTeleport(dest, retain) {
    Body.setPosition(this.body, { x: dest.x, y: dest.y });
    const v = this.body.velocity;
    Body.setVelocity(this.body, { x: v.x * retain, y: v.y * retain });
  }

  /**
   * Per-frame: glue the visual to the body, then re-assert the constant speed
   * (keeping the current direction). Skipped while dormant (static). No view
   * culling — a hazard off-screen must keep moving — so {@link bounds} stays
   * `null` (inherited).
   *
   * @returns {void}
   */
  update() {
    const p = this.body.position;
    this.view?.setPosition(p.x, p.y);
    if (this.body.isStatic) return;
    const v = this.body.velocity;
    const sp = Math.hypot(v.x, v.y);
    if (sp > 1e-6) {
      Body.setVelocity(this.body, { x: (v.x / sp) * this.speed, y: (v.y / sp) * this.speed });
    }
  }

  /** @returns {Phaser.GameObjects.GameObject|null} The subclass's visual gets hover/press. */
  interactiveView() {
    return this.view;
  }
}
