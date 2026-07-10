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

## Review/refind the friction from mud/cleaner/etc

We should review how friction info is stored on each Movable.
We need this to be efficient; we shouldn't need to recalculate things
on every frame.

## Document how to create game levels

Create a markdown file providing instructions on how to create
game levels. Do not assume that the reader knows how to program,
but has played video games before.
Provide specific actions (e.g., type this command, click this, etc.).
Briefly explain/justify steps as you go. Topics to include:

* Setup on a laptop/desktop for Windows, MacOS, and Linux
  - Download/install Tiled (2D level editor)
  - Download/install python (if using serve).
    On Windows, suggest typing "python"
    and using Windows installer primarily because it's clearly not downloading
    malware that way.
  - Download local copy of "Brothers" game including its levels
* Starting up local webserver (and why) - emphasize serve
* Pointing web browser towards it
* Starting up Tiled
  - Loading/editing
  - Briefly explain classes (like Bomb and Mud), properties. Note key 
    Note editor can show them.
  - Etc.
  - Explain you edit and reload on web browser

## Add tests

## Add linting

## Animations for mud (2) and cleaner (2)

## In HUD, after flag show current level number

Tooltip shows pack name + level name + level number.

