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

## Level graduation requirement of pack count

A level may *optionally* include a "minimum pack score to graduate
to the next level". If the user completes a level, but doesn't have
at least the graduation score, then the user can only advance in test mode.
The "next level" will block with a different message, something
like "pack score must be at least XY".

This means that we can be a little generous with specific levels, yet
some levels can be pickier, like a "boss battle".
By storing the data on the level going *from*,
we don't need to load the next level just to learn the requirement.
This also justifies why we show the pack score at all times.

## Fix zoom

Zoom *works*, but it seems to zoom in on the "wrong place".
I don't know what the convention is... is it to zoom on the pointer
if present? What about pinch/expand?

Find out what the convention for zoom in/out is, and then
determine if we follow those conventions. If not, what would it
take to implement them?

## Split up GameScene

The GameScene is huge. It includes a lot of mechanisms for the HUD,
menus, etc., as well as gameplay arena. That means that when we're
trying to improve something, the human or AI has to read a lot.
Is there a logical way to split it into smaller files?
Maybe HUD, menus/overlays, and the game arena?
Identify options for re-architecting, with pros and cons for each.

