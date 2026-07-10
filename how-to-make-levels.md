# How to make Brothers levels

This guide shows you how to build and edit levels for **Brothers**. You don't
need to know how to program. If you've played video games and can install a
program and copy a file, you have everything you need.

A level is just a picture you draw in a free program called **Tiled**: you place
the two brothers, a goal, some walls, and whatever obstacles you like. You save
the file, click reload in your web browser, and you're playing it.

**Time to first level: about 30 minutes**, most of which is installing things.

---

## Table of contents

1. [Install the three things you need](#1-install-the-three-things-you-need)
2. [Start the game on your own computer](#2-start-the-game-on-your-own-computer)
3. [Open a real level and look around](#3-open-a-real-level-and-look-around)
4. [The edit-and-reload loop](#4-the-edit-and-reload-loop)
5. [What you can put in a level](#5-what-you-can-put-in-a-level)
6. [Level-wide settings](#6-level-wide-settings)
7. [Make your own level from scratch](#7-make-your-own-level-from-scratch)
8. [Tips, traps, and playtesting](#8-tips-traps-and-playtesting)
9. [When something goes wrong](#9-when-something-goes-wrong)

---

## 1. Install the three things you need

You need **Tiled** (to draw levels), **Python** (to run the game on your own
computer), and **the game itself**.

### 1a. Tiled — the level editor

Tiled is a free, open-source editor for 2D game levels. Levels are stored in
Tiled's own file format, so this is the program that opens them.

Go to **<https://www.mapeditor.org/>** and click the download button.

- **Windows** — download the installer (`.exe`) and run it. Click through the
  prompts, accepting the defaults.
- **macOS** — download the `.dmg`, open it, and drag **Tiled** into your
  Applications folder. The first time you open it, macOS may say it's from an
  unidentified developer: right-click the app icon and choose **Open**, then
  **Open** again in the dialog. (You only have to do this once.)
- **Linux** — the download page offers an AppImage. Download it, then make it
  runnable and start it:

  ```bash
  chmod +x Tiled-*.AppImage
  ./Tiled-*.AppImage
  ```

  Or install it from your distribution: `sudo apt install tiled` on Debian and
  Ubuntu, `sudo dnf install tiled` on Fedora.

### 1b. Python — to run the game locally

You need Python only to run the little web server that serves the game to your
browser. (Section 2 explains why a web server is needed at all.)

- **Windows** — open the **Start menu**, type `cmd`, and press Enter to open a
  command prompt. In it, type:

  ```
  python
  ```

  and press Enter. If Python isn't installed, Windows opens the **Microsoft
  Store** page for Python. Click **Get** / **Install**. This route is worth
  preferring because you can *see* the download is coming from Microsoft's own
  store, rather than from a website you'd have to trust. When it finishes, close
  the command prompt, open a new one, and type `python` again — you should see
  something like `Python 3.12.0` and a `>>>` prompt. Type `exit()` and press
  Enter to leave it.

- **macOS** — open **Terminal** (press ⌘+Space, type `Terminal`, press Enter)
  and type:

  ```bash
  python3 --version
  ```

  If you see a version number, you're done. If not, macOS will offer to install
  the developer tools — accept — or get Python from <https://www.python.org/>.

- **Linux** — Python 3 is almost certainly already installed. Check with:

  ```bash
  python3 --version
  ```

### 1c. The game itself

Download the game's files to your computer.

Go to **<https://github.com/david-a-wheeler/brothers>**, click the green
**Code** button, and choose **Download ZIP**. Unzip it somewhere you'll
remember — your Desktop or Documents folder is fine. You'll end up with a folder
named something like `brothers-main`.

> If you already use `git`, `git clone https://github.com/david-a-wheeler/brothers.git`
> does the same thing and makes it easier to get updates later.

Inside that folder you'll see a `packs` folder. That's where levels live:

```
packs/
  index.json        <- the list of level packs
  Base/             <- a pack: the main set of levels
    level1.tmj      <- the first level
    level2.tmj
    level3.tmj
    level4.tmj
  Big/
    level1.tmj
```

A **pack** is a folder of levels. A **level** is one `.tmj` file. The numbers
must start at `1` and count up with no gaps — that's how the game finds them.

---

## 2. Start the game on your own computer

### Why you can't just double-click the game

The game is built from many small files that the browser loads as it goes.
These files have various formats, including JavaScript using ES modules.

Unfortunately, Browsers refuse to run such programs if you try
to open a page directly from your storage (a `file://`
address), as a security rule. So the game must be handed
to the browser by a *web server*,
even though that server is running right there on your own machine.

### Start the server

You *could* set up any web server on your system.
However, that can be a pain, because web servers are usually
optimized for serving pages to the web as a whole.
"Trivial" web servers often fail to serve pages rapidly enough for our uses.

To solve this, the game comes with a small server called `serve`.
It's optimized for local testing, while protecting against nosy attackers.
It requires a password to log in, and even then it won't serve files
outside the directories starting from its current one.
By default, it only responds to your own computer.
In short, it will let you easily test without becoming a security hazard.

To start it open a terminal (Windows:
**Start menu → type `cmd` → Enter**; macOS: **Terminal**; Linux: your terminal),
then move into the game folder and start it.

**Windows:**

```
cd Desktop\brothers-main
python serve
```

**macOS and Linux:**

```bash
cd ~/Desktop/brothers-main
./serve
```

The first time it runs, it prints a password in a big box:

```
======================================================================
 🔑 A NEW WEB SERVER PASSWORD HAS BEEN GENERATED 🔑
 PASSWORD: qLFiixnGRYXG
======================================================================
```

**Copy that password somewhere safe.** It is printed *once and never again*.
(It's there so that if you're on shared wifi, nobody else on the network can
poke at the files on your computer. If you lose it, delete the file named
`.password` in the game folder and restart `serve` — it'll make a new one.)

The server then says:

```
Serving http://127.0.0.1:8000/  (Ctrl+C to stop)
```

Leave that window open. The server runs until you press **Ctrl+C** in it.

### Point your browser at it

Open your web browser and go to:

```
http://localhost:8000
```

Note: use `http:` and not `https:`.

You'll be asked for the password. Paste it in. The game appears. Press **Play**.

> **Tip:** `./serve` remembers the address and port you last used, in a file
> called `.serve-defaults`. Plain `./serve` from then on picks up where you left
> off.

---

## 3. Open a real level and look around

**Before you change anything, open a finished level and see how it's put
together.** Everything in the next sections will make far more sense once you've
seen a real one.

### Step 1: open the project file first

In Tiled, choose **File → Open Project…**, navigate to the game folder, and open
**`brothers.tiled-project`**.

Do this before opening any level. This one file teaches Tiled about the game: it
gives you a menu of the things you're allowed to place (Bomb, Mud, Wall, …),
fills in sensible starting values for each, and shows a plain-English
description of every setting right there in the editor. Without it you'd be
typing names from memory.

### Step 2: open level 1

Choose **File → Open…** and open `packs/Base/level1.tmj`.

You're looking at a level named "Goal and teleporter". Try this:

1. Click the **David** circle. The **Properties** panel (left side, bottom)
   shows its **Class** is `David` and its **Name** is `David`.
2. Click one of the long thin rectangles. Its Class is `Wall`. Its position and
   size *are* the wall — there's nothing else to set.
3. Click the **Goal**. Its Class is `Goal`, and it has a `radius` property of
   `60`. That's how close a brother must stop to win.
4. Click an empty part of the map (not on any object). The Properties panel now
   shows the **map's** own properties: `moves`, `name`, `intro`,
   `wallRestitution`. These are the level's settings.
5. Hover over any property name. Tiled shows the description of what it does.

Now open **`packs/Base/level4.tmj`**, "Muddy waters". It shows off the shapes:
mud drawn as an *ellipse*, sticky mud drawn as a *polygon*, and two cleaners.
Click each one and read its properties.

That's the whole idea. A level is objects with a Class, and a handful of
settings on the map.

---

## 4. The edit-and-reload loop

This is the rhythm you'll use for everything else:

1. **Change something in Tiled.** For example, in `level1.tmj`, drag the Goal to
   a different spot.
2. **Save it**: **Ctrl+S** (macOS: **⌘+S**).
3. **Switch to your browser and reload the page** (**Ctrl+R**, or **⌘+R** on
   macOS, or click the reload button).
4. The level is now different. Play it.

You do **not** need to restart the server. It reads the file from disk every
time your browser asks for it, and it tells the browser never to keep a copy.
Just save, reload, play.

> **You do have to reload, though.** Once the game has read a level, it keeps it
> in memory until the page is reloaded — so restarting the level, or leaving and
> coming back to it, will *not* pick up your edit. Reload the page.

---

## 5. What you can put in a level

To place something: click the **Insert Point** tool (or **Insert Rectangle**,
**Insert Ellipse**, **Insert Polygon**) in the toolbar, click on the map, then in
the **Properties** panel set its **Class** using the dropdown.

Most things are **points** — you just say *where*. Walls, mud, and cleaners are
**shapes** — you draw their actual size.

### The brothers — `David` and `Ken`

**Place one of each, and set the Name of each to `David` and `Ken`.**

Strictly, a level with a single unnamed David and a single unnamed Ken
still works. If there's one David, and one Ken, the game will use them.
Name them anyway. It reads better in Tiled, where you can see
at a glance which circle is which, and it's the difference between working and
not if you ever place another brother as a *dummy brother* (a lifeless
doppelgänger for the player to bounce off). Name them, and adding a dummy later
just works.

| Property | What it does | Default |
| --- | --- | --- |
| `radiusMult` | How big he is, as a multiple of the base size | David `1.2`, Ken `1.0` |
| `massMult` | How heavy he is. Independent of size — a small heavy brother is allowed | David `1.2`, Ken `1.0` |

Draw them as **points**.

### `Goal` — how you win

The level is won when a brother comes to **rest** inside a goal. Not passes
through it — stops in it.

| Property | What it does | Default |
| --- | --- | --- |
| `radius` | How close (in pixels) a brother must stop to count | `60` |

Draw as a **point**. You may place several goals; reaching *any* one wins.

### `Wall` — solid obstacles

Draw as a **rectangle**. Its position and size are the wall; there's nothing
else to set. How bouncy walls are is a level-wide setting (`wallRestitution`,
see below), not a per-wall one. Place as many as you like.

### `Bomb` — a moving menace

A black pool-ball "8" that drifts around the arena bouncing off walls. It sits
still, showing an arrow of where it's about to go, until your first shot
connects — then it starts moving. If it touches a brother, it explodes.

| Property | What it does | Default |
| --- | --- | --- |
| `speed` | How fast it travels, forever (it never slows down). A full-strength launch is about `220`, so `15` crosses the arena in roughly a second | `15` |
| `angle` | Which way it starts moving, in degrees. `0` = right, `90` = down, `180` = left, `270` = up | `0` |
| `radius` | Its size in pixels | `22` |
| `mode` | `gameover` ends the level; `turnend` just costs the player that turn | `gameover` |

Draw as a **point**. Place as many as you like.

### `Teleporter` and `TeleporterTarget` — warps

A brother who flies into a **Teleporter** is whisked, with his brother, to a
**TeleporterTarget**.

`Teleporter`:

| Property | What it does | Default |
| --- | --- | --- |
| `radius` | How big the entrance is | `44` |
| `retain` | How much speed survives the trip, `0` to `1`. `0.6` keeps 60% | `0.6` |
| `target` | The **Name** of the TeleporterTarget to arrive at. Leave blank to use the first target in the level | blank |

`TeleporterTarget` has no properties — just give it a **Name**, and refer to that
name from a Teleporter's `target`. Several teleporters may share one target.

Draw both as **points**.

### `Mud` — slows a brother down

A brother whose **centre** crosses mud picks it up and carries it, getting
draggier, even after he leaves the puddle. He shakes it off over the next few
turns.

| Property | What it does | Default |
| --- | --- | --- |
| `viscosity` | How much drag it adds. The base is `0.025`, so `0.08` is a big change. The heaviest mud a brother has picked up is the one that counts | `0.08` |
| `inViscosity` | *Extra* drag that applies only while he's inside it — makes a deep bog. `0` = none | `0` |
| `numberTurns` | How many **extra** turns the mud clings before he shakes it off. `0` = gone after one shake, `2` = three shakes | `2` |
| `sticky` | Permanent, dark mud. Never shakes off; only a Cleaner with `cleanSticky` removes it | `false` |

Draw as a **rectangle**, **ellipse**, or **polygon**. A polygon may be concave
(a horseshoe is fine). A circle is just an ellipse with equal width and height.

### `Cleaner` — water that washes mud off

A brother whose **centre** enters a cleaner is instantly rinsed of normal mud.

| Property | What it does | Default |
| --- | --- | --- |
| `viscosity` | A small drag that applies **only** while he's in the water and never follows him out | `0.03` |
| `cleanSticky` | Also removes *sticky* mud. Without this, sticky mud survives a dip | `false` |

Draw as a **rectangle**, **ellipse**, or **polygon**.

> **Do not overlap a Mud with a Cleaner.** What happens is undefined, and not in
> an interesting way.

---

## 6. Level-wide settings

Click an empty part of the map, so no object is selected. The **Properties**
panel now shows the map itself. To get all of these with their descriptions, set
the map's **Class** to `Level`.

| Property | What it does | Default |
| --- | --- | --- |
| `name` | The level's title, shown in the game | — |
| `intro` | A sentence or two shown once, the first time the level is played. Use it to teach whatever the level is about | — |
| `moves` | How many shots the player gets | `6` |
| `wallRestitution` | How bouncy every wall is, `0` to `1`. `0` is a dead thud; `1` never loses energy | `0.6` |
| `pinEnabled` | Whether the player may drag the aiming pin off-centre before a shot | `true` |
| `pinResetOn` | `impact` — the pin only bends the launch and recentres when the balls collide. `settle` — the pin stays a live off-centre tether for the whole flight, so the pair curves and spins | `impact` |

**The arena is simply the map's size.** Set it with **Map → Map Properties…**;
the size is `width × height` in tiles times the tile size. The existing levels
are 32×24 tiles of 32×32 pixels, i.e. 1024×768 pixels.

---

## 7. Make your own level from scratch

The easiest and safest start is to copy a level you like.

1. In your file manager, go to `packs/Base/`.
2. Copy `level4.tmj` and rename the copy **`level5.tmj`**.

   The names must be `level1.tmj`, `level2.tmj`, … with **no gaps**. The game
   looks for `level5.tmj` only if `level4.tmj` exists. A missing number hides
   every level after it.

3. In Tiled, open your new `level5.tmj`.
4. Click an empty part of the map and change `name` to something of your own,
   and `intro` to a sentence explaining your idea.
5. Delete what you don't want (select it, press **Delete**), move what you do,
   and add new pieces from section 5.
6. **Save** (Ctrl+S), then **reload the browser**.

To reach your level in the game: open the game's **menu** (top right), turn on
**Test**, and then click any level to jump straight to it. Test mode lets you
skip to any level without finishing the earlier ones.

### A good first level

Try to build a level with one idea in it:

- David and Ken in one corner.
- A goal in the far corner.
- A wall across the middle with a gap, so the player has to bank a shot or thread
  the needle.
- `moves` set to `4`, so it's tight but fair.

Play it. If you clear it on the first try without thinking, make it harder. If
you can't clear it in ten tries, make it easier.

---

## 8. Tips, traps, and playtesting

**The brothers are tied together.** Every shot slings one brother at the other.
Where the *pair* ends up is what matters. Levels that ignore this — a narrow slot
only one brother fits through — are frustrating rather than clever.

**Rotation is ignored.** If you rotate an object in Tiled, the game ignores the
rotation and uses the upright shape. Walls in particular are always upright
rectangles. To suggest a diagonal, step several small walls like a staircase.
Mud and cleaners *can* be any shape, because you draw them as polygons — put the
slant in the polygon's corners.

**A brother must come to rest in the goal.** Flying through at speed doesn't win.
A goal placed where a brother can only ever scream past is a goal nobody reaches.
Mud near the goal is a classic way to make a fast approach land.

**Mud and cleaners trigger on the brother's centre**, not on the edge of his
circle. A puddle narrower than a brother won't do much.

**Bombs don't move until your first shot connects.** Until then the player sees
a preview arrow. This is deliberate: it lets the player plan. Placing a bomb
right on top of the brothers is therefore not a trap, it's a guaranteed loss.

**The `intro` text is the tutorial.** Levels teach. If your level is the first to
use sticky mud, say so in the `intro`.

**Test mode and the Lab.** In the game's menu, **Test** unlocks every level for
jumping around. Turn Test on and you also get **god mode**: right-click either
brother and drag the pair anywhere in the arena, to try a shot from a specific
spot without playing up to it. The menu's **Lab** panel lets you tweak the
physics live, which is handy for feeling out whether a level is hard because of
the layout or because of the launch settings.

---

## 9. When something goes wrong

**"My new level doesn't show up."**
Check the file name. It must be `levelN.tmj` with no gap in the numbers, in a
pack folder under `packs/`. Then reload the browser page — a level is only read
from disk once per page load.

**"The browser says the page can't be reached."**
The server isn't running. Go back to the terminal window and start `./serve`
again (Windows: `python serve`). Check the address matches what it printed,
usually `http://localhost:8000`.

**"It's asking for a password and I've lost it."**
Delete the file `.password` in the game folder, then start `serve` again. It
prints a brand new one.

**"I typed `https://` and got a wall of gibberish."**
Use `http://`, without the `s`. The local server doesn't speak `https`. Recent
versions of `serve` will notice and tell you so.

**"The game says something went wrong."**
The game caught a bug. Click **Copy problem report** and send it to David —
that report says exactly what happened. Your level file is fine; it's the game
that got confused.

**"My level loads but the wrong brother moves."**
If you've placed more than one `David` (or more than one `Ken`), the game picks
the one whose **Name** is exactly `David` — capital D. With several to choose
from and none named, it picks whichever it happens to find first. One of each,
named, avoids the whole question.

**"Everything is fine but the level is unplayable."**
That's not a bug, that's level design. Welcome. Move something and reload.

---

## Where to go next

- Read the `intro` text of the four levels in `packs/Base/` — each teaches one
  mechanic, in order, and that ordering is itself a lesson in level design.
- Make a new pack: create a folder next to `Base` and `Big` under `packs/`, put
  a `level1.tmj` in it, and add its folder name to `packs/index.json`.
- If you break something and want to start over, delete your level file and
  download a fresh copy of the game.
