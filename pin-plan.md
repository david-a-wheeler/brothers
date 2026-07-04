# Anchor pin plan

We're going to add a "pin" to allow more flexible aiming in Brothers.

Normally, the elastic band connecting the brothers is always pinned
to their respective centers.
However, when NOT moving, the anchor brother's pin can now be moved
to another location on the brother. During launch, the moving brother
will be attracted to the *pin* location (which might not be the center,
though the center is the default).

## What the pin actually does (the gameplay mechanic)

This is **not** cosmetic. Moving the pin changes the shot:

- During aiming and release — that is, *until the two balls collide* —
  the launcher is aimed at / pulled toward `anchor.center + pin_offset`
  instead of the anchor's center. Because the launcher then strikes the
  anchor's circular body **off-center**, the impact sends the anchor off
  in a different direction. The pin therefore gives the player control
  over the anchor's follow-through direction, an axis of control that
  dragging the launcher alone does not provide (drag only sets
  angle-to-center plus power).
- When the two balls collide, the pin returns to center (`pin_x=0`,
  `pin_y=0`), and from that point on the elastic band/motion uses the
  centers as usual. This "returns to center on collision" behavior lets
  us ignore questions like "won't the ball spin?"; we may revisit it
  after playtesting. The earlier note about "ignoring motion" was only
  ever about *after* the collision — before the collision the pin
  position definitely matters.

Here's a draft summary for the help info:
You can adjust the anchor brother's pin before launch;
single-tap for compass point/center, double-tap for center,
and drag for fine positioning.

## New Brother properties

The "Brother" class stores the pin as an **offset** from its center, and
exposes convenience getters for the pin's **absolute world position** so
call sites don't each redo `center + offset` (and don't mix the two up).
Names are camelCase to match the rest of the codebase (`radiusMult`,
`massMult`, `interactiveView`, …).

Stored pin state (offsets, default 0):

- `pinOffsetX`, `pinOffsetY`: Number, default 0.
  x,y offset of the pin from the brother's center. This is what we snap,
  drag, and reset.

Derived accessors (getters, read-only):

- `get pinX()` → `this.go.x + this.pinOffsetX`
  Absolute world x of the pin. `pinY` likewise.
  These plug straight into the Phaser math the launch code already uses,
  e.g. `Phaser.Math.Angle.Between(l.x, l.y, a.pinX, a.pinY)`.
- `get pinPlaced()` → `this.pinOffsetX !== 0 || this.pinOffsetY !== 0`.
  True when the pin is off-center.

No **setters** for `pinX`/`pinY`. Every pin write has to do the same
three things — set the offset, clamp it into the radius (see the 1.5×
rule below), and trigger the "adjust view" refresh (depth swap + redraw)
— and it's all naturally in *offset* space, while a `set pinX` would be
absolute and do none of that (and invite setting x and y separately, a
half-placed intermediate frame). So funnel every write through one method
instead:

- `placePin(offsetX, offsetY)`: clamp the offset into the radius, store
  it in `pinOffsetX`/`pinOffsetY`, and refresh the view. All three
  gestures call it — tap → `placePin(compassOffsetX, compassOffsetY)`;
  double-tap / center → `placePin(0, 0)`; drag →
  `placePin(px - this.go.x, py - this.go.y)`.

(No `pinPoint()` object-returning helper for now — the scalar getters
feed the math calls directly, and allocating an `{x,y}` each frame in
`drawBand` would just be churn. Add it later if a call site wants a point.)

Gesture-tracking state (set on `pointerdown`, for the tap/double-tap/drag
state machine). Keep the pin-revert snapshot separate from the pointer
timing — they answer different questions:

- `pinDownOffsetX`, `pinDownOffsetY`: Number.
  The *pin's* offset at `pointerdown`, so an over-long drag (see below)
  can revert to where the pin was before the gesture.
- `pinDownX`, `pinDownY`: Number.
  The *pointer's* world position at `pointerdown`, to measure drag
  distance — both the small threshold that promotes a press to a drag and
  the 1.5×-radius distance that ends/reverts it.
- `pinDownTime`: Number (`this.scene.time.now`).
  When this press started — needed to run the 350 ms double-tap window
  and to tell a long-press from a quick tap.
- `lastTapTime`: Number.
  Time of the previous completed tap, persisted across presses; a new tap
  within 350 ms of it is the double-tap. (Without a recorded time there's
  no way to detect either the double-tap or a long-press.)

## Effect on the launch (where the mechanic lives)

The pin has to feed into the launch code, or placing it changes nothing:

- Release aims at the pin. `Brothers.release()` currently computes its
  fire angle and pull distance from the launcher to the *anchor center*
  (`Phaser.Math.Angle.Between(l.x, l.y, a.x, a.y)` /
  `Phaser.Math.Distance.Between(l.x, l.y, a.x, a.y)`). These must instead
  target the anchor's pin — pass `a.pinX, a.pinY` (which already resolve
  to `center + offset`) in place of `a.x, a.y`.
- The block check follows the pin. `Brothers._launcherBlocked()` tests
  the launcher→anchor line against walls; that line must also end at the
  pin, not the anchor center.
- Once the balls collide, the pin snaps back to center (above), so the
  Hybrid Snap and post-collision motion are unchanged.

## User interface

Currently, pointerdown on an anchor reveals a tooltip
(name), pointerup or exit removes the tooltip. That continues.

In addition, the anchor brother now responds to new events:

- A single tap (pointerdown+pointerup, up to a conventional amount of
  time separating those events) will set the pin to the
  nearest `simple pin point`, which is `center` and the 8 compass point
  edges of the brother (north, northeast, east, etc.). "Nearest" means
  nearest of those 9 points to the **tap location on the ball**: a tap
  near the top snaps to north, a tap near the middle snaps to center.
- A double-tap will set the pin at the center (default).
  After the pin is set, it will have its view adjusted (see below).
  This means a single tap must record (on the relevant brother) some
  previous event time information, as usual (use the usual 350ms measure
  for double-tap).
  Double-tap is intentionally not very discoverable; it will be noted in
  the help, and users who don't know it can always reach center with a
  single tap near the middle.
- A drag (pointerdown plus nontrivial pointer movement) begins
  fine-grained positioning of the pin.
  The pin and the elastic band become visible over the face and facial features
  (drawn afterwards on a higher layer) during dragging with the pin.
  During drag, the pin moves to the dragging pointer position *but* always
  stays within the anchor brother's radius. If the point is outside the
  radius, up to 1.5x anchor radius, then the pin moves to the edge of the
  brother (at its radius) at the angle of the dragging pointer in relation
  to the center of the brother.

  Note that dragging *could* also indicate a tooltip view request,
  especially from a touchscreen. Therefore, if a drag is ever more than
  1.5x the brother radius, the drag ends and the pin reverts to its
  position before the gesture (`original_pin_x`, `original_pin_y`,
  recorded on pointerdown). This 1.5x rule is a deliberate balance of
  reversibility and ease of use. (A stationary long-press with no
  movement can reasonably be treated as just a tooltip request; we may
  revisit both of these after playtesting.)

### Input plumbing (how this coexists with the existing router)

The scene's input router (`src/scenes/GameScene.js`) currently treats a
press on anything that isn't the launcher as a camera pan: the scene
`pointerdown` handler (~line 2560) sets `_isPanning = true` unless
`isAiming` is already set, and the launcher escapes this only because
`gameobjectdown` (~line 2608) sets `isAiming` first and `pointerdown`
bails on `if (this.isAiming) return`.

- An anchor press must **no longer pan the camera**, exactly the way a
  launcher press doesn't. Mirror the existing guard: when a press lands
  on the anchor and we're in the pin-editing state, set a flag (e.g.
  `_pinning`) that the `pointerdown` pan branch respects, so panning
  never starts.
- We want drag behavior on the anchor, but we do **not** have to make
  the anchor an actual Phaser draggable object. Two options:
  - (a) Track the pin gesture manually via the scene `pointermove`
    handler (~line 2622) between the anchor's `pointerdown` and
    `pointerup`.
  - (b) Make the anchor draggable and branch inside the existing
    `gameobjectdown` (~2608) and `drag` (~2706) handlers, which today
    hard-check `go === launcher.go`.
  Prefer **(a)**: it's cleaner because it avoids entangling pin-drag with
  the launcher's aim-drag code path (and the `_updateDraggable()` /
  launcher-only assumptions baked into the drag handlers).
- Single-tap / double-tap / drag on the same ball need a small
  per-Brother **state machine** (down time for the 350ms double-tap
  window, a movement threshold to promote a press to a drag, and the
  `original_pin_*` snapshot). Reuse the launcher's `_infoSuppressed`
  trick (`GameScene.js`, set around line 2712) so the name label doesn't
  flash while a pin drag is in progress.

The anchor's info-label wiring already lives in `Entity._enableInfo()`
(`src/world/Entity.js`), which attaches `pointerover`/`pointerdown` to
show and `pointerout`/`pointerup` to hide. The pin handling layers on top
of the anchor's interactive view (`Brother.interactiveView()` returns
`this.go`).

## Display

- Zoom allowances:
  We now need to be able to greatly zoom in to see a brother in fine detail.
  Allow zooming in to show default-size Ken (the smaller brother)
  covering most of the screen. This is raising `Config.zoom.max` (min
  zoom is arena-fit and separate). This is a *manual* allowance — a player
  who wants fine pin control can zoom in themselves.
- Auto-focus is questionable — probably don't do it (at least not
  aggressively). Zooming the camera in onto the anchor when pin-editing
  begins would make fine placement easier, **but** the pin's whole point
  is to aim the anchor's follow-through, and both that trajectory and the
  launcher live *away* from the anchor. Zooming in tight would hide
  exactly the context the player needs to judge the shot. So:
  - Default: leave the camera where it is; rely on the manual zoom
    allowance above for anyone who wants a closer look.
  - If we do any automated framing at all, it must keep **both**
    brothers (and ideally the space between them, where the shot travels)
    in view — a gentle nudge, not a tight zoom onto the anchor. The scene
    already has camera pan/zoom helpers used for settle/flight framing
    (and `_clampCamera()`) that frame the pair's box; reuse that rather
    than framing the anchor alone.
  - Decide after playtesting whether even the gentle version helps or
    just fights the player's own zoom.
- Pin and elastic band: draw the tether from the launcher center to the
  anchor **pin** at all times (this is what makes the pin legible — the
  player sees the band actually attach at the offset point and
  understands why the trajectory shifts). If `pin_placed` (not center),
  the elastic band and pin must be visible: the elastic band is higher
  (drawn later) than the face, and the pin is higher (drawn later) than
  the elastic band. If `pin_placed` is not true (centered), then the
  elastic band is drawn *under* the face (the face is drawn later) so we
  can see the face. Let's not worry about the physics of this. :-)

  It's fine for the band to show the pin on *both* brothers; on
  smartphones that makes the status more obvious (a finger hides much of
  a ball).

  Current depth stack for reference: ball circle `3`, band `4`, face `6`,
  facial feature (David's glasses / Ken's beard) `7`. So "pin placed ⇒
  band+pin above the face" means raising the band above `7` and drawing
  the pin above the band (e.g. band `8`, pin `9`) while editing/placed,
  and restoring band to `4` when centered. Note the band is a single
  graphics object for the pair (`Brothers.band`, drawn each frame by
  `drawBand(...)` from `Brothers.update()`), so raising it lifts the
  whole tether over both faces — which is the desired behavior here.

- The pin is a nearly-black circle that's small, slightly wider than
  the elastic band.

This design doesn't let you select a pin *outside* the anchor ball radius.
We *could* allow it and add more flexibility later, but we might need to
draw some "extenders" from the ball to try to justify it.

## Key files and methods

- `src/world/Brother.js` — `pinOffsetX`/`pinOffsetY` state;
  `pinX`/`pinY`/`pinPlaced` read-only getters; `placePin(offsetX,
  offsetY)` write funnel (clamp + refresh); gesture-tracking fields
  `pinDownOffsetX/Y`, `pinDownX/Y`, `pinDownTime`, `lastTapTime`;
  `interactiveView()` (returns `this.go`); the per-Brother
  tap/double-tap/drag state machine.
- `src/Brothers.js` — `release()` (aim at the pin), `_launcherBlocked()`
  (block line ends at the pin), the tether constraint + `drawBand(...)`
  called from `update()` (draw band to the pin, depth toggling),
  `_updateDraggable()` (launcher-only draggable assumption to keep in
  mind), and the snap/collision path that resets the pin to center.
- `src/scenes/GameScene.js` — the input router: `pointerdown` (~2560,
  add the `_pinning` guard so the anchor doesn't pan), `pointermove`
  (~2622, option (a) pin-drag tracking), `pointerup` (~2664),
  `gameobjectdown` (~2608) and `drag` (~2706) if we ever choose option
  (b); `_infoSuppressed`/`_infoEntity` label handling; `Config.zoom.max`
  (manual deep-zoom allowance); the existing pair-framing camera
  pan/zoom helpers + `_clampCamera()` *only if* we add gentle
  both-brothers-in-view framing (see Display — probably skip auto-focus).
- `src/world/Entity.js` — `_enableInfo()` (existing tooltip wiring the
  pin handling layers onto).
- `src/config.js` — `Config.zoom` (raise `max`), `Config.ball`,
  `Config.tether`; add pin appearance constants (pin color/size).
