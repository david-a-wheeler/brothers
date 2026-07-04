I want to make a title screen for this game "Brothers". Please review this plan and comment before we begin.

When the game boots, it should look at the permanent JavaScript storage for key/value pair `skip_title_screen=true`. If the key isn't there, or it's not true, we go to the title screen, else we go directly to the primary game scene.

In the primary gain scene's main menu, add a new menu item "Show title screen >" just before "About". If clicked, it sets `skip_title_screen=false` into the permanent storage (so we can restart later & see the title screen), then goes to the title screen.

When the title screen shows, here's what the player sees:

* The top of the screen shows the word "Brothers" in large letters in an arc, with dynamic active effects that make it interesting to look at *without* making the text hard to read (so the letters don't *move*).
* The middle of the screen has text that explains the premise: "Help the brothers, David and Ken, reach the goal in as few moves as possible."
* Nearer to the bottom the screen goes through an animation loop to briefly illustrate how the game works.
  - At the beginning of the animation loop, David and Ken (brothers) are between the center and left, as their "Brothers" instance including the elastic band. The distance between them is the usual starting distance, and David is furthest left.  David is the selected brother, so he'll have the usual indicator of that. On the right is a "Goal". All of them have their tooltips permanently enabled, so you see "David", "Ken", and "Goal" near them.
  - The system waits for 5 seconds to let players take in the scene.
  - David then pulls back further to the left, in an arc to show that he can go up and down as well as left, while the normal sound effect for stretching plays.
  - David releases straight into Ken, about 5 seconds after starting to pull back. Once they hit, as usual they go to the right together (showing what the elastic band does).
  - Ken settles into the goal at the right, and once settled, as usual the goal shows the win animation. However, the goal does *not* play the win sound effects (we'll be playing music and we don't want to interfere with the music). Note that Ken and David do *not* bounce on the far right, we're trying to keep this simple. 
  - After the objects stay on screen stays for about 5 seconds, all of the animated objects disappear for 5 seconds (including the tooltips). Then the loop repeasts, with the objects reappearing.
* At the bottom of the title screen is a big button that says "Play". On pressup, it sets `skip_title_screen=true` into the permanent storage and goes to the main game menu.

While the title screen is showing, play this music file in a loop (which you'll have to load if you're showing the title screen):
assets/music/don-t-resist-the-groove-ska-loopable-esmFfRGNHc7DKfGHzk6mRE.mp3
I've already added the credits to the creator, it's CC0 licensed.

Make sure it properly responds to resizes, so window resizings / changed orientation is addressed.

Reuse existing code as much as reasonable, including tweaking code to make it more general so you *can* reuse it.

Make it look professional and interesting. We want people to be intrigued enough to continue and start playing.
