# TODO

Potential items to be done.

## Restart: Show level name if exists

Need to figure out format, make it consistent with prev/next.
Maybe, if there's a name, add a newline and then the name.
For prev/next, remove the parens.

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

## Split up GameScene

The GameScene is huge. It includes a lot of mechanisms for the HUD,
menus, etc., as well as gameplay arena. That means that when we're
trying to improve something, the human or AI has to read a lot.
Is there a logical way to split it into smaller files?
Maybe HUD, menus/overlays, and the game arena?
Identify options for re-architecting, with pros and cons for each.

## Improve lab screen

The "lab" panel should let you view
some more the current parameters for each brother
and change them (it already does this for size).
At the least, turns left being muddy.

The lab should let you change the level setting on whether or not
pin moving is allowed, or if the pin continues to exist after the
launch completes and the launcher hits the anchor.

This means the lab *must* support scrolling (as well as bottom resizing
and moving as it currently does) to handle all those parameters.

## God mode

We need to make a god mode to make playtesting easier. I'm open to ideas.
One: if "testing" mode is on, you can right-click on a brothers pair
and move them anywhere.

## Review/refind the friction from mud/cleaner/etc

We should review how friction info is stored on each Movable.
We need this to be efficient; we shouldn't need to recalculate things
on every frame.
