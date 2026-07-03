I want to update the menus. Here are my starting ideas, I welcome refinements and better counter-suggestions.

Clicking on "hamburger" reveals the main menu, whose top descriptor would become "main menu" (not the Pack/Level stuff):

- The menu would continue to include the ability to enable the "lab" panel and "test" mode.
- It would add a new "Help" option, which would show a modal briefly describing how to play and scoring (the modal would have "OK" at the bottom, and like all modals, a small sound would trigger when opened). I'm sure you can come up with plausible starting text explaining how to move, the goals, etc.
- It would add a new "About" option, showing another brief modal with "OK" at the bottom. Proposed text: "This game was developed by David A. Wheeler based on an idea by Kenneth A. Wheeler. It was built using the Phaser 2D game framework and Tiled level editor with help from Claude Code." The text may change, make sure the modal can reflow it.
- It would have a "Current pack" info section, showing the pack name, # levels in the pack, # levels completed, total score (which could be 0 or -), and a button for "Details". Clicking on "details" would show a "Pack details" panel, which would (again) show the current pack's info section, along with the list of levels and state (similar to what we do now).
- Under the main menu's "current pack" info section and its "Details" button, there would be header "All packs", followed below by the list of all packs we know of, showing the pack name and total score (total score is stored in local storage). Clicking on any of these buttons would show its corresponding "Pack details" panel. We only show the number of levels when we show a "Pack details" panel, so the system *never* needs to figure out the number of levels in all packs at once.

## Help modal text (draft)

Shown word-wrapped in the Help modal, with a single "OK" button (and the usual
open sound). Wording can change; keep it terse enough to reflow well on a phone.

> In each level you're helping a pair of brothers, David and Ken,
> reach a goal with as few moves as possible.
>
> **How to play**
>
> **Move:** One brother glows — that's the one you can move. Drag it back like a
> slingshot and release to fling it toward its partner. The two are joined by an
> elastic band, so they travel together.
>
> **Aim:** A red ✗ means you can't launch from there (a wall, the edge, or the
> other brother is in the way). Reposition and release again.
>
> **Turns & moves:** Each launch spends one move, then it becomes the other
> brother's turn. Every level gives you a limited number of moves ("#Left").
>
> **Goal:** Bring a brother to rest inside the goal ring to clear the level.
>
> **Teleporters:** Fly into a portal to warp the pair to its matching target.
> Bombs can teleport too.
>
> **Bombs:** Avoid them. Before they wake up (after your first launch) a spinning
> arrow shows which way each will travel and how fast. Touching one ends the game
> — a few only cost you the turn.
>
> **Walls:** Solid. You and the bombs bounce off them.
>
> **Camera:** Zoom with the mouse wheel or a pinch; drag empty space to pan.
>
> **Scoring:** *Best* is the most moves you had left when you won a level —
> higher is better, so clearing a level in fewer launches raises it. *Pack* is
> the sum of your Bests across the pack. "-" means not won yet; "0" is a real
> score (a win with no moves to spare).

## Tooltips

Every menu item gets a tooltip, revealed on hover (desktop) and press (touch) —
same mechanism as the HUD tooltips, and reusing the on-screen placement logic so
they never run off-screen. The goal is to make the symbols (★, ✓, 🔒, —) and the
tap-to-jump behavior self-explanatory.

**Menu chrome**
- Menu/hamburger button: "Open the menu."
- Close (×): "Close the menu."
- ‹ Back (in Pack details): "Back to the main menu."

**Main menu**
- Lab: On/Off: "Developer tool: show a panel to live-tune slingshot and physics values."
- Test: On/Off: "Test mode: unlock every level and jump freely, ignoring the normal 'win to advance' rule."
- Help: "How to play, and how scoring works."
- About: "Credits and the tools behind the game."
- Details (button): "See every level in this pack and your best on each."

**Current pack info section** (same fields appear atop Pack details)
- Pack name: "The pack you're currently playing."
- Levels: N — "Number of levels in this pack."
- Completed: N — "Levels in this pack you've cleared at least once."
- Total: N / - — "Sum of your best results across this pack (higher is better). '-' means none cleared yet."

**All packs list**
- "All packs" header: "Every pack the game knows about."
- A pack row (name + total): "Open this pack's details. The number is your total best score across it ('-' if you haven't cleared any)."

**Pack details — level rows.** The value shown differs by state, so the tooltip
does too:
- Completed, e.g. "✓ 3 ★": "Cleared! Your best here is 3 (moves left when you won — higher is better). Tap to play it again."
- Available, "—": "Not cleared yet. Tap to play this level."
- Locked, "🔒": "Locked — clear the previous level first (or turn on Test mode)."

**Pack details — other**
- Forget pack scores (enabled): "Erase your saved best scores for this pack. This can't be undone."
- Forget pack scores (disabled/gray): "No saved scores in this pack to forget yet."

## Polish checklist

The menu doesn't need to be fancy, just intentional. All of this is cheap in
procedural UI (spacing, type, colour, motion, feedback). Values below are
starting points; put them in shared tokens (see "Shared helpers") so the whole
menu is consistent by construction rather than per-widget.

**Layout & rhythm**

- [ ] One spacing unit (8px) drives every gap/pad/row height: xs 4, sm 8, md 16, lg 24.
- [ ] Equal row height (keep 44) and equal card padding (16). Labels share a left edge; values share a right edge.
- [ ] Right-align all numbers (scores/counts) on a common right margin (tabular feel); labels left.

**Type hierarchy** (3 clear tiers)

- [ ] Title ~20px bold (`#ffffff`).
- [ ] Section header ~13px, letter-spaced/upper-ish, muted (`#9aa0a6`).
- [ ] Row label 17px (`#ffffff`); secondary value muted (`#9aa0a6`), accent gold for scores (`#ffd479`).

**Colour** (small, reused palette)

- [ ] Surfaces: card `0x23232c`, row `0xffffff@0.06`, row-hover `0xffffff@0.12`, border/divider `0xffffff@0.08`.
- [ ] Accent gold `0xffd479` (scores, current marker); danger red `0x9b3a3a` (Forget).
- [ ] Text: primary `#ffffff`, muted `#9aa0a6`, disabled `#6b6b75`. No ad-hoc colours.

**Feedback / micro-interactions**

- [ ] Every tappable item: hover-lighten + subtle press (flash or scale 0.98) + `useHandCursor` + a soft tick sound.
- [ ] Disabled items visibly grayed and non-interactive (no hover/tick).

**Motion** (gentle, uniform)

- [ ] One easing (`Sine.Out`) and duration (~150ms) for menu transitions.
- [ ] Panel fades/rises in on open; list rows fade in staggered (~25ms each) so the list "settles."

**Structure & detail**

- [ ] Thin divider rule (`0xffffff@0.08`) between sections; section headers above groups.
- [ ] A 2–3px gold bar on the left edge of the current pack/level row ("you are here").
- [ ] Graceful edge states: "-"/"none yet" empties, wrapped long names, grayed disabled buttons, and the tooltips above.

## Shared helpers to build

Create these once so the checklist is enforced everywhere (and existing ad-hoc
copies collapse into them):

- **`Config.ui` tokens** (in `config.js`): `space` (xs/sm/md/lg), `radius`
  (14 / 8), `color` (surface, rowHover, divider, accent, danger, and text
  primary/muted/disabled), `type` (title/header/row/value/small style objects),
  and `motion` (dur, ease, rowStagger). Everything below reads from here.
- **`sfx.tick()`** (in `Sfx.js`): a soft, short UI click for taps/toggles —
  quieter and higher than `hit()`, distinct from the modal `bonk()`.
- **`_attachTooltip(target, text)`**: wire hover/press reveal + hide + on-screen
  placement, reusing the entity-label placement logic (`_placeEntityInfo`). Folds
  in the repeated tooltip wiring in `_buildHudStat`, the icon buttons, and the
  new menu items — one path, so every tooltip stays on-screen.
- **`_hoverable(gameObject, { onTap, tip })`**: standard interactive wiring —
  hover-lighten, press flash/scale, `useHandCursor`, `sfx.tick()`, the
  drag-vs-tap + off-clip guards already in `_menuRow`, and (optionally) a
  tooltip. Replaces the duplicated pointer handlers in `_menuRow`,
  `_menuContentButton`, `_devButton`, and the HUD icons.
- **Menu building helpers**: `_menuSectionHeader(y, text)` and `_menuDivider(y)`
  (consistent header style + divider rule), and a current-row accent-bar draw,
  so `_showPackList`/`_showPackDetail`/the new main-menu view compose from the
  same pieces.
- **`_staggerIn(objects)`**: fade a freshly built list in with per-item delay
  (used by `_finishMenuContent`).
- **`_showMessage(title, body, onOk)`**: a single-"OK", word-wrapped, auto-height
  message modal (for Help/About) — generalized from `_showConfirm` (which stays
  the Yes/No variant); both share the backdrop/`bonk`/depth-40 chrome.

## Record number of levels in long-term storage

We may get feedback that users really want to see the level counts
for every pack on the main menu. For now, whenever we determine the number
of levels in a pack, store that in our long-term storage.
Later on, we could choose to show that number in the main menu, and
verify/update when we actually load the pack.
