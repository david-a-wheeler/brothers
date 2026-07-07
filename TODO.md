# TODO

Potential items to be done.

## Restart: Show level name if exists

Need to figure out format, make it consistent with prev/next.
Maybe, if there's a name, add a newline and then the name.
For prev/next, remove the parens.

???

## Move band completely below or above

The title page only considers drawing order, not the layer,
because of how the containment system works.
It can't easily draw the same way the "main game" does,
where the elastic band is between the ball and face.

Here's a proposed change to eliminate that inconsistency:
let's just have band be drawn *below* the ball if they're
both pinned to the center (the standard pin),
and if a pin is off-center, draw the balls (including faces), put
the band on top of that, and the pins on the very top.
Then they can be easily consistent; the balls draw themselves, and
the "Brothers" construct draws the band and pin either completely above
or completely below.
