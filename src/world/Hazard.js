import { Config } from '../config.js';
import { Entity } from './Entity.js';
import { directionArrow } from './effects.js';

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
 * A hazard is **dormant** (its body static) until kickoff — the first launch's
 * first impact — when the scene calls {@link onPlayStart} (via
 * {@link World#notifyPlayStart}), which {@link activate}s it and clears its
 * preview arrow; {@link onLevelEnd} freezes it again so it stops acting during
 * the end-of-level banner. While dormant it shows a translucent direction arrow
 * (heading + spin-rate speed cue) so the player can plan before starting.
 * Because the body is a raw Matter body (not a Phaser game object), the subclass
 * supplies a display object as `this.view` and this base keeps it glued to the
 * body each frame.
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

    /**
     * Outward wall normal captured this frame by {@link noteBounce}, consumed in
     * {@link update} to force a clean bounce. Null when not touching a wall.
     * @type {{x:number, y:number}|null}
     */
    this._bounceNormal = null;

    /**
     * Pre-launch preview arrow: shows the heading and (by its spin rate) the
     * speed this hazard will move at, so the player can plan before starting.
     * Cleared at kickoff in {@link onPlayStart}.
     * @type {Phaser.GameObjects.Container|null}
     */
    this._indicator = directionArrow(scene, {
      x: def.x,
      y: def.y,
      angleDeg: this.angleDeg,
      speed: this.speed,
      offset: this.radius + Config.anim.arrow.gap,
    });
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

  /**
   * Kickoff (the first launch has connected): clear the preview arrow and begin
   * moving. Also re-arms on a resumed level (dev "More turns"), where the arrow
   * is already gone.
   */
  onPlayStart() {
    if (this._indicator) {
      const spin = this._indicator.getData('spin');
      if (spin) spin.remove();
      this._indicator.destroy();
      this._indicator = null;
    }
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
   * Record a wall contact for this frame so {@link update} can bounce off it.
   * Matter's own restitution is unreliable here: when a slow body's velocity
   * into a wall is below Matter's resting-contact threshold, the solver damps
   * the normal velocity to zero instead of bouncing, and the body slides along
   * (and eventually sticks to) the wall. We capture the collision normal and
   * reflect ourselves, after the step, so every hazard bounces at any speed.
   *
   * @param {{x:number, y:number}} normal  The pair's collision normal.
   * @param {MatterJS.BodyType} otherBody  The struck body (wall or arena edge).
   * @returns {void}
   */
  noteBounce(normal, otherBody) {
    // Orient the normal to point from the struck body toward this hazard
    // (outward), so update() can tell "into the wall" from "leaving it".
    let nx = normal.x;
    let ny = normal.y;
    const dx = this.body.position.x - otherBody.position.x;
    const dy = this.body.position.y - otherBody.position.y;
    if (nx * dx + ny * dy < 0) {
      nx = -nx;
      ny = -ny;
    }
    this._bounceNormal = { x: nx, y: ny };
  }

  /**
   * Per-frame: glue the visual to the body, bounce off any wall touched this
   * frame (see {@link noteBounce}), then re-assert the constant speed (keeping
   * the resulting direction). Skipped while dormant (static). No view culling —
   * a hazard off-screen must keep moving — so {@link bounds} stays `null`
   * (inherited).
   *
   * @returns {void}
   */
  update() {
    const body = this.body;
    const p = body.position;
    this.view?.setPosition(p.x, p.y);
    if (body.isStatic) return;

    let vx = body.velocity.x;
    let vy = body.velocity.y;

    const n = this._bounceNormal;
    if (n) {
      let dot = vx * n.x + vy * n.y; // velocity component along the outward normal
      if (dot < 0) {
        // Heading into the wall: reflect (angle in == angle out).
        vx -= 2 * dot * n.x;
        vy -= 2 * dot * n.y;
        dot = -dot;
      }
      // Grazing/tangential contact (Matter damped the normal velocity): ensure a
      // real outward component so a slow hazard can't get pinned sliding along.
      const minOut = this.speed * 0.2;
      if (dot < minOut) {
        vx += n.x * (minOut - dot);
        vy += n.y * (minOut - dot);
      }
      this._bounceNormal = null;
    }

    const sp = Math.hypot(vx, vy);
    if (sp > 1e-6) {
      Body.setVelocity(body, { x: (vx / sp) * this.speed, y: (vy / sp) * this.speed });
    }
  }

  /** @returns {Phaser.GameObjects.GameObject|null} The subclass's visual gets hover/press. */
  interactiveView() {
    return this.view;
  }
}
