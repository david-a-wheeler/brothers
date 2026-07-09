# Mud plan

We're going to add **mud** to Brothers: shaped areas on the board that make a
brother passing through them *muddy*. A muddy brother drags — it carries extra
air-friction, so it decelerates and settles faster than a clean brother — and
that drag **persists after it leaves the puddle**, until it's shed (or washed).

We also add **Cleaner** areas (water) that wash a brother clean.

This plan covers how to **detect a brother in an area of any shape**, how each
area carries its **own properties** (so one puddle can be sticky and another
not), and how muddiness lives **on the brother** so it survives leaving the area.

Seed notes: [TODO.md](TODO.md) (`## Mud`). This plan expands them and folds in the
design decisions taken since. It depends on the shape-normalizing loader change
in [§2](#2-prerequisite-shape-aware-level-loader-srclevelsjs) — worth landing on
its own first.

## What mud & cleaner do (the mechanic)

**Mud areas** (Tiled class `Mud`):

- **Regions, not solids.** Brothers pass through; they don't bounce off.
- **Make the enterer muddy.** When a brother's *centre* crosses into a mud area,
  it picks up that area's mud: a `viscosity` of extra air-friction that **stays
  applied after it exits**. That lingering drag is the point.
- **Optional extra drag *while inside*.** A mud area may also carry an
  `inViscosity` that applies only while the brother is *in* it and is dropped
  when it leaves (e.g. a deep bog that's heavy to cross but leaves the same mud
  on you as a shallow one). Default 0 — most puddles won't use it.
- **Lingering (`numberTurns`).** *Normal* mud clings for `numberTurns` **extra
  turns** before the brother shakes it off — the brother **wiggles left/right** at
  rest each turn it's muddy, and the mud only comes off once its turns run out.
  `0` = gone after the first shimmy; `1` = two shimmies; default `2` = three.
  *Sticky* mud is dark and **never comes off** on its own (≈ infinite
  `numberTurns`).
- **Sticky is durable, loose is transient.** Sticky and non-sticky ("loose")
  pickup viscosity are tracked **separately** on the brother, because they have
  different lifetimes: loose mud shakes off after its `numberTurns` run out (a
  countdown reset upward on each pickup); sticky mud persists until washed. Loose
  mud can never reduce or remove sticky mud — that's "once sticky, other mud
  doesn't change it." A *second* sticky puddle **can** raise the sticky level (all
  three — sticky viscosity, loose viscosity, loose turns — combine by `max`).

**Cleaner areas** (Tiled class `Cleaner`, looks like water):

- **Wash clean.** When a brother's centre enters a Cleaner, its **loose** mud is
  removed at once. **Sticky** mud is removed *only* if the Cleaner has
  `cleanSticky` set — a plain Cleaner rinses off ordinary mud but leaves sticky
  mud stuck; a dedicated `cleanSticky` Cleaner strips everything.
- **Small transient drag while inside.** Water has a little drag too, but it's a
  property of the **Cleaner, not stored on the brother**: it applies only while
  inside and vanishes the instant the brother leaves (same `inViscosity`
  mechanism as a mud bog, above). Default is very small.

### Decisions locked in

- **Centre-in-shape** detection (a brother counts as "in" once its centre crosses
  the edge; no radius inflation).
- Mud/cleaner touch **`frictionAir` only** — never mass, never restitution.
- **Max** combines viscosities within each category (heaviest loose puddle this
  turn; heaviest sticky puddle ever). Effective persistent mud =
  `max(stickyViscosity, looseViscosity)`.
- **Mud and Cleaner areas never overlap** (a level-editing mistake if they do); we
  don't handle a brother being in both at once.
- The shed **wiggle plays first**, *then* the win/lose animation.

---

## Architecture: regions detect, the mover owns state, friction is event-driven

> **Update (Movable refactor).** The mud *state + logic* originally written on
> `Brother` now lives on a shared base **`Movable` (`src/world/Movable.js`)**, and
> both `Brother` and `Hazard` (bombs) extend it — so a bomb gets muddy, rinses in
> a cleaner, and sheds at settle exactly like a brother. `Movable` reaches each
> subclass's differing body/visual model through a few accessor getters
> (`mudBody`, `mudX`, `mudY`, `mudRadius`, `mudShimmyX`, `_baseFrictionAir`).
> Regions detect **every mover**, not just the two brothers: the `World` collects
> anything advertising `isMovable` into `world.movables()` (no per-type knowledge,
> same trick as `needsUpdate`), and `Region.update` point-tests that list. A
> brother animates the shed with its shimmy; a hazard sheds silently on
> `onSettle` (broadcast by `World.notifySettle` from `_resolveTurn`). Hazards were
> also changed to be **frictionless coasters** (launch speed, then physics) rather
> than re-asserting a constant speed each frame, so mud's `frictionAir` genuinely
> slows them — a wall bounce is made loss-less in `Hazard.update` so only mud
> changes a hazard's pace. Where this doc says "brother" below, read "mover".

Two halves:

1. **Regions** (`Mud`, `Cleaner`) — body-less shaped areas. Each frame they run a
   cheap point-in-shape test and **edge-detect** enter/exit transitions. They
   don't compute physics; they call methods on the mover.
2. **Mover state** (`Movable`) — persistent sticky/loose mud viscosity, the set of
   regions currently imparting transient (while-inside) drag, the visual, and (on
   brothers) the shed animation.

**Friction is recomputed only on events, never per frame.** `frictionAir`
depends solely on the brother's mud state and which regions currently contain it
— both change *only* at region enter/exit and at settle. So we
recompute-and-store `body.frictionAir` (`Brother._recomputeFriction`) at exactly
those moments and leave it untouched in between. Concretely, friction changes on:

1. **enter a Mud** → add persistent pickup (+ register its `inViscosity` if any)
2. **enter a Cleaner** → strip loose mud (+ sticky if `cleanSticky`) + register
   its transient `inViscosity`
3. **exit a region with `inViscosity`** → drop that transient drag
4. **settle** → shed loose mud

Note a plain Mud (no `inViscosity`) needs no *exit* event — its pickup is
persistent. Only a region with a *while-inside* effect (any Cleaner, an
`inViscosity` bog) needs exit.

The per-frame work is just the containment test, which never touches the body; it
exists only because a body-less region (our price for concave shapes) has no
Matter sensor to hand us enter/exit for free — so we synthesize those by diffing
"inside this frame vs last." (Convex-only shapes could use Matter sensors +
`collisionstart/end`, but that forbids concave puddles and needs a `collisionend`
path the router lacks — so we keep body-less + the edge test, uniform for all
shapes.)

---

## 1. Detection: shapes + edge-triggered containment

Areas support **rectangles, ellipses, circles, and arbitrary (incl. concave)
polygons**. No Matter body — a per-frame **point-in-shape** test on the brother's
centre, using the exact Phaser test per shape:

| `def.shape` | Geom object | Contains test |
|-------------|-------------|---------------|
| `rect`      | `Phaser.Geom.Rectangle` | `Rectangle.Contains` |
| `ellipse`   | `Phaser.Geom.Ellipse`   | `Ellipse.Contains` |
| `circle`    | `Phaser.Geom.Circle`    | `Circle.Contains` |
| `polygon`   | `Phaser.Geom.Polygon`   | `Polygon.Contains` |

Build the Geom shape **once** per region and reuse it. **Edge-detect** by keeping
the set of brothers inside last frame; act only on transitions (see the `Region`
base in [§3](#3-region-base-class-srcworldregionjs)). A brother *placed* inside an
area registers as an enter on its first in-view frame — no special-casing.

---

## 2. Prerequisite: shape-aware level loader (`src/levels.js`)

Detection needs the shape geometry, which the loader currently **discards**.
`loadTiledLevel` records only the bbox centre + `width`/`height` (object loop
around `src/levels.js:102`), so every Tiled shape collapses to a rectangle, and a
Tiled *polygon* (no `width`/`height`; `x,y` is an arbitrary origin, not a centre)
would be silently mis-placed.

Fix generically (not mud-specific — any future non-rect entity benefits). Add
`normalizeShape(o)`, called from the object loop, returning a normalized,
**center-based** descriptor:

```
{
  shape:  'rect' | 'ellipse' | 'circle' | 'polygon' | 'polyline' | 'point',
  x, y,           // centre of the shape's AABB (uniform meaning for every shape)
  width, height,  // AABB size
  points,         // polygon/polyline only: vertices RELATIVE TO (x,y)
}
```

- **rect / ellipse / point** — as today: `x = o.x + w/2`, `y = o.y + h/2`. Set
  `shape` from Tiled flags (`o.ellipse` → `ellipse`, `o.point` → `point`, else
  `rect`); treat an ellipse with `w === h` as `circle`.
- **polygon / polyline** — read `o.polygon` / `o.polyline` (`{x,y}` relative to
  `o.x,o.y`). Compute the AABB from `origin + each vertex`; set `x,y` to the AABB
  centre, `width,height` to its size, and store `points` **relative to that
  centre** (so a consumer builds `new Phaser.Geom.Polygon(points)` hanging off
  `def.x,def.y`, matching how a `Goal`'s circle hangs off its centre).

Keep center-based (Matter and every existing entity treat `def.x,def.y` as a
centre). Ignore Tiled `rotation` (document: bake a tilt into polygon vertices).
No Y flip (both y-down). Keep it defaulted/forward-compatible: unrecognized shape
data still yields a `rect` from the bbox. **Regression-test** the packs for
byte-identical existing defs (only the new fields added).

---

## 3. Region base class (`src/world/Region.js`, new)

Shared machinery for `Mud` and `Cleaner`: shape build, containment, AABB bounds,
the edge-triggered loop, and the generic transient-drag (`inViscosity`) plumbing.
Subclasses supply the look and their enter/exit state changes. (`Region` is
abstract — not in the registry.)

```js
import { Entity } from './Entity.js';

export class Region extends Entity {
  needsUpdate = true; // ticked by World.update for the containment test only

  constructor(scene, def) {
    super(scene, def);
    this._shape = this._buildShape(def);          // positioned Phaser.Geom.*
    this._inside = new Set();                      // brothers inside last frame
    this._aabb = new Phaser.Geom.Rectangle(
      def.x - def.width / 2, def.y - def.height / 2, def.width, def.height);
    this.view = this._buildView(scene, def);       // subclass fill
  }

  _buildShape(def) { /* rect | ellipse | circle | polygon (points→absolute) */ }
  contains(x, y) { /* dispatch on def.shape → Geom.*.Contains */ }

  /** Transient drag imparted WHILE a brother is inside (0 = none). Subclass. */
  get inViscosity() { return 0; }

  update(ctx) {
    for (const b of [ctx.brothers.david, ctx.brothers.ken]) {
      const inside = this.contains(b.go.x, b.go.y);
      const was = this._inside.has(b);
      if (inside && !was) { this._inside.add(b); this._enter(b); }
      else if (!inside && was) { this._inside.delete(b); this._exit(b); }
    }
  }

  _enter(b) {
    this._entered(b);                            // subclass: mud pickup / wash (no recompute)
    if (this.inViscosity > 0) b.addRegion(this); // register while-inside drag
    b._recomputeFriction();                      // single recompute per event
  }
  _exit(b) {
    this._exited(b);
    if (this.inViscosity > 0) b.removeRegion(this);
    b._recomputeFriction();
  }

  // Never cull while a brother is inside, so an exit is always detected even if
  // the AABB scrolls to the view edge (belt-and-suspenders — an occupied region
  // is near the followed centre anyway).
  bounds() { return this._inside.size ? null : this._aabb; }

  _entered(_b) {}   // subclass: persistent state change on enter
  _exited(_b) {}    // subclass: persistent state change on exit (rarely needed)
  _buildView(_s, _d) { return null; }
  interactiveView() { return this.view; }
  // A Graphics has no intrinsic size, so hand the info-label wiring an explicit
  // hit area — reuse the shape + Contains (world coords; the fill sits at the
  // origin, so pointer-local == world). Without this, hover tooltips never fire.
  interactiveHitArea() { return [this._shape, this._containsFn]; }
}
```

Register concrete subclasses in `src/world/registry.js`: add `Mud` and `Cleaner`
to `CLASSES` (the Tiled Class string is the JS class name verbatim).

---

## 4. `Mud` entity (`src/world/Mud.js`, new)

```js
import { Config } from '../config.js';
import { Region } from './Region.js';

export class Mud extends Region {
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.mud.viscosity;        // persistent pickup
    this._inViscosity = def.inViscosity ?? Config.mud.inViscosity; // extra WHILE inside
    this.numberTurns = def.numberTurns ?? Config.mud.numberTurns;  // extra turns it lingers
    this.sticky = def.sticky ?? false;
  }
  get inViscosity() { return this._inViscosity; }         // Region drops it on exit
  _entered(b) { b._pickUpMud(this.viscosity, this.sticky, this.numberTurns); } // persistent
  _buildView(scene, def) { /* filled shape; Config.mud.color vs stickyColor */ }
}
```

## 5. `Cleaner` entity (`src/world/Cleaner.js`, new)

```js
import { Config } from '../config.js';
import { Region } from './Region.js';

export class Cleaner extends Region {
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.cleaner.viscosity; // transient only
    this.cleanSticky = def.cleanSticky ?? false; // also strip sticky mud?
  }
  get inViscosity() { return this.viscosity; }  // whole effect is while-inside
  _entered(b) { b._wash(this.cleanSticky); }    // loose always; sticky iff cleanSticky
  _buildView(scene, def) { /* watery-blue translucent fill; Config.cleaner.color */ }
}
```

Because the Cleaner's viscosity is read off the region via `inViscosity` (not
copied onto the brother), it genuinely can't perpetuate: the brother only holds
*membership*, dropped on exit.

---

## 6. Brother state + friction (`src/world/Brother.js`)

### State

```js
// persistent (survive leaving a mud area):
this.mudStickyViscosity = 0; // sticky mud; permanent until washed (max over pickups)
this.mudLooseViscosity  = 0; // normal mud; shed once its turns run out, or washed
this.mudTurnsLeft       = 0; // extra settles loose mud lingers (max over pickups)
// transient region membership (drag applies only while inside):
this._activeRegions = new Set(); // regions with inViscosity currently containing me
// shed animation:
this._mudShimmyX = 0;            // horizontal offset (px) of the face/feature/splat
```

Derived: `get isMuddy(){ return this.mudStickyViscosity > 0 || this.mudLooseViscosity > 0; }`
and `get isSticky(){ return this.mudStickyViscosity > 0; }`.

### The one friction formula (recomputed only on events)

```js
_recomputeFriction() {
  if (!this.go.body) return;
  const mud = Math.max(this.mudStickyViscosity, this.mudLooseViscosity);
  let region = 0;
  for (const r of this._activeRegions) region = Math.max(region, r.inViscosity);
  this.go.body.frictionAir = Config.ball.frictionAir + mud + region;
}
```

(With no Mud/Cleaner overlap, `_activeRegions` holds at most one region in
practice; `max` is just robustness.)

### State mutators + membership (called by `Region._enter/_exit`, which recompute)

```js
_pickUpMud(v, sticky, numberTurns) {           // Mud enter (persistent)
  if (sticky) {
    this.mudStickyViscosity = Math.max(this.mudStickyViscosity, v);
  } else {
    this.mudLooseViscosity = Math.max(this.mudLooseViscosity, v);
    this.mudTurnsLeft = Math.max(this.mudTurnsLeft, numberTurns); // lingering timer
  }
  this._refreshMudLook();
}
_wash(includeSticky) {                         // Cleaner enter: loose always; sticky opt-in
  this.mudLooseViscosity = 0;
  this.mudTurnsLeft = 0;
  if (includeSticky) this.mudStickyViscosity = 0;
  this._refreshMudLook();
}
addRegion(r)    { this._activeRegions.add(r); }
removeRegion(r) { this._activeRegions.delete(r); }
```

`_pickUpMud` / `_wash` intentionally **don't** recompute — `Region._enter/_exit`
do a single recompute after adjusting both state and membership. The one
self-contained one is `shedMudTurn`, driven from settle rather than a region: it
counts the lingering timer down and only sheds the loose mud once it expires.

```js
shedMudTurn() {                                // one settle's shed step (sticky untouched)
  if (this.mudLooseViscosity > 0 && this.mudTurnsLeft > 0) {
    this.mudTurnsLeft -= 1;                     // still muddy: keep it one more turn
    return;
  }
  this.mudLooseViscosity = 0;
  this.mudTurnsLeft = 0;
  this._refreshMudLook();
  this._recomputeFriction();
}
```

**No per-frame friction write and no scene-side commit** — `body.frictionAir` is
touched only by `_recomputeFriction`, reached solely from region enter/exit and
`shedMudTurn`.

### Visual (muddy look)

`this.mudView` — a splat overlay owned by the brother, positioned each frame like
the facial feature. `_refreshMudLook()` shows/hides + tints it: dark
(`Config.mud.stickyColor`) if `isSticky`, else brown (`Config.mud.color`), hidden
if not `isMuddy`. `_updateMudView()` glues it to `this.go`.

Wire the shed shimmy into `update()` (`src/world/Brother.js:178`) as a horizontal
offset of the face/feature/splat over the (stationary) body:

```js
update() {
  this._contain();
  const sx = this._mudShimmyX;              // 0 except during the shed shimmy
  this.face.setPosition(this.go.x + sx, this.go.y);
  this.face.rotation = 0;
  this._updateFeature();
  if (this.feature && sx) this.feature.x += sx; // glasses/beard slide along too
  this._updateMudView();                    // splat offset by sx
}
```

The shimmy is an *offset* the shed tween drives (not a body move), applied each
frame after `_updateFeature` repositions the feature to the body — so it slides
the whole face group left/right while the ball stays put.

---

## 7. Settle: shimmy, then decide the turn

Every turn, at settle, **both brothers are checked** and **any muddy one** (loose
*or* sticky) shimmies to try to shake the mud off — and the shimmy must come
**before** the win/lose animation. So the turn decision is *deferred* until the
shimmy finishes. What the shimmy sheds is decided at its end
({@link Brother#shedMudTurn}): loose mud lingers for its remaining `numberTurns`
(counted down each settle) and only comes off once they run out; sticky mud never
sheds here — so a brother keeps shimmying (and stays muddy) every turn until its
loose timer expires, and a sticky one shimmies forever until washed.

Settle is detected in the update loop (`src/scenes/GameScene.js:2436`), which
calls `_resolveTurn` **every frame** while `status === 'PLAYING' && phase ===
'MOVING'`. So deferring needs a re-entry guard, and the cleanest one is a new
`phase` value that drops out of that check:

```js
// src/scenes/GameScene.js
_resolveTurn() {
  this._frameBrothers();
  this.phase = 'RESOLVING';                 // park the MOVING settle-check (re-entry guard)
  // Any muddy brother shimmies first; decide the turn only once the shimmies
  // finish (or immediately if none) — so the win/lose animation follows.
  this.brothers.shimmyMud(() => this._decideTurn());
}

// _decideTurn holds the former _resolveTurn body: firstReached → win/celebrate/
// _endGame; else out-of-moves → lose; else swapRoles + phase = 'AIMING'.
```

`RESOLVING` is a MOVING-only detour: `phase` returns to `'AIMING'` on the continue
branch, and the win/lose branches leave `status === 'PLAYING'` (so the settle
check can't re-fire regardless). Add `RESOLVING` to the phase state notes at
`src/scenes/GameScene.js:60`.

```js
// src/Brothers.js
const MUD_SHED_FACE = FACES.dizzy; // ← single knob: the face shown mid-shimmy

/**
 * Every muddy brother (loose OR sticky) shimmies, then `onDone` fires once all
 * finish. The mud shakes off only AT THE END of the shimmy (loose sheds, sticky
 * stays), so the look updates after the shake. If none is muddy, `onDone` fires
 * immediately (synchronously), so a mud-free turn resolves exactly as before.
 */
shimmyMud(onDone) {
  const muddy = [this.david, this.ken].filter((b) => b.isMuddy);
  if (!muddy.length) { onDone(); return; }
  let pending = muddy.length;
  const { amplitude, cycles, duration } = Config.mud.wiggle;
  for (const b of muddy) {
    const prevFace = b.face.text;
    b.setFace(MUD_SHED_FACE);
    // Slide the face left/right over the ball `cycles` times. A sine keeps it
    // centred at start/end (no pop); only the visuals move, not the body.
    const p = { t: 0 };
    this.scene.tweens.add({
      targets: p, t: 1, duration, ease: 'Linear',
      onUpdate: () => { b._mudShimmyX = amplitude * Math.sin(p.t * Math.PI * 2 * cycles); },
      onComplete: () => {
        b._mudShimmyX = 0;
        b.shedMudTurn();                 // count down / shed loose now (sticky stays) → look may update
        b.setFace(prevFace);
        if (--pending === 0) onDone();   // decide the turn after all shimmies done
      },
    });
  }
}
```

Design points:

- **Every turn, both brothers:** the check is `b.isMuddy` (loose OR sticky), so a
  sticky brother shimmies on *every* settle (and keeps its mud), not just the turn
  it picked it up. A clean brother isn't muddy, so it doesn't shimmy.
- **Sequence is guaranteed:** the whole decision (score, `celebrate`, `_endGame`,
  or `swapRoles`) runs from `onDone`, i.e. after the shimmy — so a win pop always
  follows the shake. If neither brother is muddy, `onDone` fires the same tick and
  behaviour is unchanged.
- **Shed AFTER the shimmy.** `shedMudTurn` is called in the tween's `onComplete`,
  not up front, so any look change happens at the *end* of the shake (once the
  timer expires, loose flies off; sticky stays; while it's still lingering, the
  shimmy plays but nothing changes). Friction is still correct in time for the next
  launch, which can't start until `onDone` → `_decideTurn` hands off the turn.
- **Face is a named constant** (`MUD_SHED_FACE`) — one line to change. It restores
  the prior face on complete; `_decideTurn` (win/lose/next) then sets the outcome
  face the same tick, so there's no visible clash.
- **Don't move the physics body.** The "left/right" shimmy is a horizontal
  *translation of the visuals* (`_mudShimmyX` → face/feature/splat), never a move
  of `go` — the ball stays put while the face group slides on top of it, reading
  as a quick shake to fling the mud off.

---

## 8. Config tunables (`src/config.js`)

Add next to `ball` / `bomb` / `settle` (around `src/config.js:163`):

```js
mud: {
  viscosity: 0.08,        // default persistent pickup (base frictionAir is 0.025)
  inViscosity: 0,         // default extra drag WHILE inside (0 = none; opt-in per area)
  numberTurns: 2,         // default extra turns normal mud lingers before it sheds
  color: 0x6b4423,        // normal mud fill (brown)
  stickyColor: 0x2a1a0e,  // sticky mud fill (near-black brown)
  overlayAlpha: 0.85,     // muddy-brother splat strength
  depth: 0,               // below brothers (depth 3) & walls; above background
  wiggle: { amplitude: 9, cycles: 2, duration: 400 }, // shed shimmy: px each way, oscillations, ms
},
cleaner: {
  viscosity: 0.01,        // very small transient drag while in the water
  color: 0x3aa0d8,        // watery blue (translucent fill)
  depth: 0,
},
```

`MUD_SHED_FACE` lives as a constant in `src/Brothers.js` (references `FACES`), not
here, to avoid a config→faces import. Tune `viscosity` by feel: base `0.025` is a
long glide; `0.08` a clear grab, `0.15`+ heavy sludge; cleaner stays tiny.

---

## 9. Level authoring (Tiled)

- Draw a **rectangle, ellipse, or polygon** object; set its **Class** to `Mud` or
  `Cleaner`. Concave polygons are fine.
- Mud properties: `viscosity` (float; omit → `Config.mud.viscosity`),
  `inViscosity` (float, extra while inside; omit → 0), `numberTurns` (int, extra
  turns it lingers; omit → `Config.mud.numberTurns` = 2), `sticky` (bool; omit →
  false), optional `name` (hover label).
- Cleaner properties: `viscosity` (float; omit → `Config.cleaner.viscosity`),
  `cleanSticky` (bool; omit → false — off means it leaves sticky mud stuck),
  optional `name`.
- A circle is an ellipse with equal width/height (loader tags it `circle`).
- Don't use Tiled object *rotation* (ignored — bake angle into polygon vertices).
- **Don't overlap a Mud and a Cleaner** — unsupported (a brother in both at once
  is undefined).

---

## 10. Open questions / future

- **Entry splash** — a one-shot SFX/particle on `_entered` (Mud splat, Cleaner
  splash) is easy now that enter/exit are real events; optional polish.
- **Wash animation** — the Cleaner strips mud instantly; a brief splash or a fade
  of `mudView` could soften it; cosmetic, later.
- **Muddy affecting mass/bounce** — explicitly out of scope (friction only).

---

## 11. Implementation checklist (file by file)

1. **`src/levels.js`** — `normalizeShape(o)`; emit `shape` + `points` (+ AABB
   centre/size) from the object loop. Regression-test packs. *(Land first.)*
2. **`src/config.js`** — add `mud` and `cleaner` blocks (§8).
3. **`src/world/Region.js`** *(new)* — shape build, `contains`, edge-triggered
   `update`, `inViscosity` getter, `_enter`/`_exit` (membership + recompute),
   `_entered`/`_exited`/`_buildView` hooks, `bounds`, and `interactiveView` +
   `interactiveHitArea` (the Graphics needs an explicit hit area for hover) (§3).
4. **`src/world/Mud.js`** *(new)* — `_entered → _pickUpMud`, `inViscosity` getter,
   brown/dark fill (§4).
5. **`src/world/Cleaner.js`** *(new)* — `_entered → _wash`, `inViscosity =
   viscosity`, watery fill (§5).
6. **`src/world/registry.js`** — add `Mud`, `Cleaner` to `CLASSES`.
7. **`src/world/Brother.js`** — sticky/loose viscosity + `mudTurnsLeft` +
   `_activeRegions` + `_mudShimmyX` state; `_pickUpMud`, `_wash`, `addRegion`,
   `removeRegion`, `shedMudTurn`, `_recomputeFriction`, `isMuddy`/`isSticky`;
   `mudView` + `_updateMudView`/`_refreshMudLook`; `_mudShimmyX` into `update()` (§6).
8. **`src/Brothers.js`** — `MUD_SHED_FACE` constant + `shimmyMud(onDone)` (§7).
9. **`src/scenes/GameScene.js`** — split `_resolveTurn` into a guarded shell
   (`phase = 'RESOLVING'`, then `shimmyMud(() => this._decideTurn())`) and
   `_decideTurn` (former body); note `RESOLVING` at `:60` (§7).
10. **Test level** — a normal `Mud`, a sticky `Mud`, an `inViscosity` bog, and a
    `Cleaner` in a pack level; verify pickup, max, sticky persistence + raise,
    wash, while-inside drag, and shed-then-win headlessly per
    [how-to-debug.md](how-to-debug.md).

No unit tests exist yet, and `node --check` only parses — verify in the browser
(reload the tab) and with the headless rig.
