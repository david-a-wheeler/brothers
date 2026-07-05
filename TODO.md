# TODO

Potential items to be done.

## Bug: dragging overlay size when over button triggers button

When dragging an overlay size at the bottom, *and* the pointer is over a button,
the button's tooltip triggers, and if released, the button is pressed.
During overlay resize (when the mouse cursor has changed to the resize shape),
buttons/menu items shouldn't trigger their tooltips or actions. We *do* want the
scrollbar to emerge/hide as the overlay resizes, but not the active items
within it.

## Make camera assignment explicit (robustness)

**Context.** `GameScene` runs two cameras: the world/main camera (zooms & pans with
the arena) and a fixed UI camera (`uiCamera`, draws the HUD, overlays, and
tooltips). The two-camera split itself is correct and should stay — the arena
and HUD live in genuinely different coordinate spaces (the arena zooms; the HUD
does not).

**The fragility is in how objects are *assigned* to a camera**, not in the split.
Today it's a mix of:
- a one-time snapshot at create time —
  `uiCamera.ignore(this.children.list.filter((o) => !this.hudObjects.includes(o)))`
  (`GameScene._setupCameras`), plus `cameras.main.ignore(this.hudObjects)`; and
- per-surface calls for lazily-built UI — each overlay/panel/scrollview does
  `this.scene.cameras.main.ignore(this.parts)` (see `Menu`, `Modal`, `Panel`,
  `ScrollView`).

This works, but correctness depends on *timing* and *convention*: an object is
assigned correctly only if it existed at the snapshot, or if its owner remembers
to ignore the world camera. A **world** object created after `create()` would
wrongly draw on the UI camera too (it's not in the snapshot's ignore list). No
current code hits this, but it's an implicit invariant waiting to be tripped.

**Proposed improvement.** A single helper that assigns each object to exactly one
camera explicitly, e.g. `assignToWorld(obj)` / `assignToUI(obj)` (each ignores
the *other* camera), called at creation for every display object. Removes the
snapshot-and-convention dance; assignment becomes local and order-independent.

**Priority:** low. Orthogonal to the tooltip consolidation; do it as its own small
change if/when it's worth it.
