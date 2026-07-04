# Anchor pin plan

We're going to add a "pin" to allow more flexible aiming in Brothers.

Normally, the elastic band connecting the brothers is always pinned
to their respective centers.
However, when NOT moving, the anchor brother's pin can now be moved
to another location on the brother. During launch, the moving brother
will be attracted to the *pin* location (which might not be the center,
though the center is the default).

Here's a draft summary for the help info:
You can adjust the anchor brother's pin before launch;
single-tap for compass point/center, double-tap for center,
and drag for fine positioning.

The "Brother" class will have new runtime properties:

- `pin_x`, `pin_y`: Number, default 0.
  x,y offset of pin from brother center.
- `pin_placed`: Predicate (method returning boolean value).
  Returns true if the `pin` on this Brother is placed.
  Functionally, it returns true if there's a nonzero offset,
  `((pin_x !== 0) || (pin_y !== 0))`.

For now: Once the launching brother hits the anchor brother, the pin
of the anchoro snaps back to center during movement. That is, on hit,
the anchor brother's `pin_x=0` and `pin_y=0`, and we don't need to add
the offset to the elastic band during motion.
This lets us ignore questions like "won't the ball spin?".
We may revisit that decision.

User interface: Currently, pointerdown on an anchor reveals a tooltip
(name), pointerup or exit removes the tooltip. That continues.

In addition, the anchor brother now responds to new events:

- A single tap (pointerdown+pointerup, up to a conventional amount of
  time separating those events) will set the pin to the
  nearest `simple pin point`, which is `center` and the 8 compass point
  edges of the brother (north, northeast, east, etc.).
- A double-tap will set the pin at the center (default).
  After the pin is set, it will have its view adjusted (see below).
  This means a single tap must record (on the relevant brother) some
  previous event time information, as usual (use the usual 350ms measure
  for double-tap).
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
  1.5 the brother radius, the drag ends and the pin reverts to its
  position before the pin. We may want more Brother properties like
  `original_pin_x`, `original_pin_y` where we record the pin position
  on pointerdown, so we can do this.

Display:

- Zoom allowances:
  We now need to be able to greatly zoom in to see a brother in fine detail.
  Allow zooming in to show default-size Ken (the smaller brother)
  covering most of the screen.
- Pin and elastic band: If `pin_placed` (not center), the elastic band and
  pin must be visible: the elastic band is higher (drawn later) than the face,
  and the pin is higher (drawn later) than the elastic band.
  If `pin_placed` is not true (centered), then the elastic band is drawn
  *under* the face (the face is drawn later) so we can see the face.
  Let's not worry about the physics of this :-).
. The pin is a nearly-black circle that's small, slighly wider than
  the elastic band.

This design doesn't let you select a pin *outside* the anchor ball radius.
We *could* allow it and add more flexibility later, but we might need to
draw some "extenders" fromo the ball to try to justify it.
