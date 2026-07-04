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
- The pin returns to center at the end of the shot. *When* — and, with
  it, *whether the pin affects the physics during flight* — is a **level
  parameter** `pinResetOn` (default `'impact'`), plumbed like `moves` /
  `wallRestitution` (`levels.js`: `pinResetOn: mapProps.pinResetOn ??
  DEFAULTS.pinResetOn`). The two modes are meaningfully different, not
  just different timings:
  - `'impact'` (default): the pin only retargets the launch impulse (see
    "Effect on the launch"); the Matter tether constraint is never
    touched (stays center-to-center). Reset the instant the balls
    collide, in `Brothers.snap()`. From then on band + motion use the
    centers as usual, so we can ignore "won't the ball spin?".
  - `'settle'`: the pin *also* becomes a live, off-center **tether
    attachment** for the whole flight, and only resets when the balls
    come to rest, in `Brothers.swapRoles()` (end-of-turn handoff). This
    is the variant I want — the reason to wait is to change the physics,
    not just the visuals.

  ### Pin as a Matter constraint (the `'settle'` mode)

  The tether is already a Matter constraint with `pointA` (launcher side)
  and `pointB` (anchor side), each body-local, default `{0,0}` = center.
  Attaching to the pin is `this._tether.pointB = { x: pinOffsetX, y:
  pinOffsetY }`, and reset is `pointB = {0,0}`. The API is trivial; the
  care is in three spots:

  - **Local vs. world frame.** `pointB` is body-local and rotates with
    the anchor's body angle, while `pinOffset` is captured in world axes
    at placement. Cleanest fix: force the *static* anchor's body `angle =
    0` while it's the anchor (the face is redrawn upright every frame, so
    zero visual cost) — then `pinOffset` is directly usable as `pointB`.
    Otherwise rotate the offset by `-body.angle`.
  - **Pull-only gap.** `Brothers._applyPullOnlyTether()` measures the gap
    center-to-center to decide when the band goes slack; with an
    off-center attach it should measure attach-point → attach-point
    (launcher center → `anchor.pinX`/`pinY`).
  - **Deliberate spin, so budget tuning.** An off-center pull applies
    torque — the anchor swings/tumbles as it's reeled in. That's the
    payoff (real curved motion), but it injects angular energy into a
    system whose Hybrid Snap is "the riskiest mechanic in the game"
    (`snap()` note). The wiring is small; expect to playtest/tune the
    feel, and its interaction with the snap.

  Both modes share the same `Brother.resetPin()` (zero the offsets, reset
  `pointB` to `{0,0}`, refresh the view), with a guarded call in *both*
  `snap()` (fires when `pinResetOn === 'impact'`) and `swapRoles()`
  (fires when `'settle'`). The earlier note about "ignoring motion" was
  only ever about *after* the reset — before it, the pin position matters
  (and in `'settle'` it matters mechanically all the way to rest).

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

## Settled decisions / assumptions

Recorded so we don't have to re-derive them if we start over:

- **Build in one pass.** Normally we'd stage this (mechanic + tap-snap
  first, then free-drag/zoom polish), but as an exception we're building
  the whole plan carefully in one go, not incrementally.
- **Two level parameters gate the feature.** `pinEnabled` (default
  `true`) turns pin control on/off for the level; `pinResetOn` (default
  `'impact'`) picks the reset timing / physics mode. Both plumbed like
  `moves`.
- **Editing gate.** With pin control enabled, the anchor's pin is
  editable only when `level.pinEnabled && phase === 'AIMING' && !isAiming
  && status !== 'ENDED'` (see User interface).
- **Reset timing is a level parameter, and picks the physics mode.**
  `pinResetOn` (default `'impact'`) is per-level like `moves`.
  `'impact'` = aim-retarget only, reset in `snap()`. `'settle'` = pin is
  also a live off-center tether attachment (`_tether.pointB`) through the
  flight, reset in `swapRoles()`. One `resetPin()` serves both. (See "Pin
  as a Matter constraint" for the local-frame / pull-only / spin details.)
- **Band drawing generalizes.** `drawBand` becomes
  `drawBand(g, david.pinX, david.pinY, ken.pinX, ken.pinY)` — the
  launcher's pin is always center, so one code path draws both the normal
  (center-to-center) and pinned tether; no launcher/anchor special-case.
- **Block check is mostly center-based.** In `_launcherBlocked`, the
  overlap-with-the-other-brother test stays center-to-center (it's about
  the physical circular bodies), and the launcher's arena-containment
  test is unchanged. *Only* the wall/band line retargets to the pin.
- **Power follows the pin (intended).** Pull distance is now measured
  launcher→pin, so offsetting the pin changes power as well as angle.
  This is a deliberate side effect we're keeping; revisit only if
  playtesting says power should stay center-based.
- **Pinch aborts a pin drag.** A second touch (pinch-zoom, guarded by
  `_pinchDist`) takes over the gesture and cancels any in-progress pin
  drag.

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
- The pin is reset to center at end-of-shot (on impact or on settle — see
  the `pinResetOn` level parameter above), so motion ultimately returns
  to center-based behavior. In `'impact'` mode the aim retarget is the
  *only* physics effect; in `'settle'` mode the pin is additionally a live
  tether attachment through the flight (see "Pin as a Matter constraint").

## User interface

Currently, pointerdown on an anchor reveals a tooltip
(name), pointerup or exit removes the tooltip. That continues.

**When is the pin editable?** First, the level must allow it at all: a
`pinEnabled` level parameter (default `true`, plumbed like `moves`) gates
the whole feature, so a level can turn pin control off (e.g. a tutorial,
or a level designed around center-only aiming). When off, the anchor
behaves exactly as today — tooltip only, no tap/double-tap/drag pin
handling, no band/pin overlay. When on, the pin is editable only while
it's the current player's aim and the launcher hasn't been grabbed —
concretely `level.pinEnabled && phase === 'AIMING' && !isAiming &&
status !== 'ENDED'`. Editing at any other time (mid-flight, after the
game ends) would be confusing. Because the pin resets at end-of-shot,
each new turn's anchor starts centered.

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

  While a fine-drag is in progress, the HUD status message changes to
  **"Moving <anchor.name>'s pin"**, rendered in the **anchor's** color —
  note the unusual swap: the HUD normally shows the *launcher* (the
  current player), but during pin-drag it shows the *anchor* whose pin is
  being moved. Implement as a new aim sub-state in `_refreshHud()`
  (`GameScene.js`) — e.g. a `_aimState === 'pinning'` branch (or a
  dedicated flag) checked before the normal AIMING prompt, reading
  `this.brothers.anchor.name` / `.color` instead of the launcher's.

  Note that dragging *could* also indicate a tooltip view request,
  especially from a touchscreen. Therefore, if a drag is ever more than
  1.5x the brother radius, the drag ends and the pin reverts to its
  position before the gesture (`pinDownOffsetX`, `pinDownOffsetY`,
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
  offsetY)` write funnel (clamp + refresh); `resetPin()` (zero offsets +
  refresh); gesture-tracking fields `pinDownOffsetX/Y`, `pinDownX/Y`,
  `pinDownTime`, `lastTapTime`; `interactiveView()` (returns `this.go`);
  the per-Brother tap/double-tap/drag state machine.
- `src/Brothers.js` — `release()` (aim at the pin), `_launcherBlocked()`
  (block line ends at the pin), the tether constraint + `drawBand(...)`
  called from `update()` (draw band to the pin, depth toggling),
  `_updateDraggable()` (launcher-only draggable assumption to keep in
  mind); `'settle'` mode also sets `_tether.pointB` to the pin offset and
  adjusts `_applyPullOnlyTether()` to measure attach-point→attach-point
  (plus zero the static anchor's body `angle`); the end-of-shot reset: a
  guarded `anchor.resetPin()` in *both* `snap()` (`pinResetOn ===
  'impact'`) and `swapRoles()` (`pinResetOn === 'settle'`).
- `src/scenes/GameScene.js` — the input router: `pointerdown` (~2560,
  add the `_pinning` guard so the anchor doesn't pan), `pointermove`
  (~2622, option (a) pin-drag tracking), `pointerup` (~2664),
  `gameobjectdown` (~2608) and `drag` (~2706) if we ever choose option
  (b); `_aimState`/`_refreshHud()` (new `'pinning'` sub-state → "Moving
  <anchor.name>'s pin" in the anchor's color); `_infoSuppressed`/
  `_infoEntity` label handling; `Config.zoom.max` (manual deep-zoom
  allowance); the existing pair-framing camera pan/zoom helpers +
  `_clampCamera()` *only if* we add gentle both-brothers-in-view framing
  (see Display — probably skip auto-focus).
- `src/world/Entity.js` — `_enableInfo()` (existing tooltip wiring the
  pin handling layers onto).
- `src/config.js` — `Config.zoom` (raise `max`), `Config.ball`,
  `Config.tether`; new `Config.pin` (appearance: color, size).
- `src/levels.js` — new level parameters read from `mapProps` alongside
  `moves` / `wallRestitution`, added to the `Level` typedef:
  `pinEnabled` (`DEFAULTS.pinEnabled` = `true`) and `pinResetOn`
  (`'impact' | 'settle'`, `DEFAULTS.pinResetOn` = `'impact'`).
