# Tooltip consolidation plan

Unify the four accreted tooltip implementations (HUD, arena/entity, menu, title)
into one behavior + one look. The differences today are mostly accidental drift,
not design; consolidating first makes the later "more interesting look" a
single-place change.

## Background: are the four really different?

| Difference | Essential? |
|---|---|
| Multiple HUD `Text`s vs one shared label | Accidental — only one tip is ever visible; the ~8 objects are just how it grew. |
| Anchored-below-ribbon vs float-near-pointer | The one genuine option, and it's small (see `place`). |
| Style drift (14 vs 15px, padding, bg alpha) | Accidental, except depth (per-context z-order). |
| Content static vs `infoText()` | Not a difference — "a string, or a function returning one." |
| Trigger wiring (inline / `_enableInfo` / `attachTooltip`) | Accidental — three spellings of the same hover/press logic. |
| Menu gate (`_overCard`) | **Not a tooltip concern** — a Phaser workaround (masks clip rendering, not input, so a scrolled-off row's hit area leaks outside the card). Becomes an optional `clip` predicate, no-op everywhere else. |
| Anti-flicker + touch-hide | **Universal**, not per-context — they follow from "one shared label moving between adjacent targets" + "touch has no hover." Menu currently lacks the guard (latent flicker) and is blunt on touch-hide. Make them always-on. |
| Title name labels | Genuinely different — always-on labels, not tooltips. Share the look + wording only. |

## 1. Style token (kills the literal sprawl first)

The same tip literal is repeated ~11× (HUD ×8, arena, menu, title-variant). Lift it into config:

```js
// config.js -> ui:
tooltip: { fontSize: '15px', color: '#ffffff', backgroundColor: '#000000',
           padding: { x: 8, y: 4 } },
depth: { tooltip: 40 },   // above cards (31-34) & HUD (10-11), below modals
```

- Menu's `14px`/`pad y:5` and title's `#000000cc`/`system-ui` are accidental drifts -> collapse to this token. Title passes its two overrides (`{ backgroundColor:'#000000cc', fontFamily:'system-ui, sans-serif' }`) via spread.
- Pure, zero-behavior refactor. Ship and eyeball before touching logic.

## 2. The service — `src/ui/Tooltip.js`

One instance per scene, owning **one** reused label (replaces `entityInfoText`, the ~8 HUD `Text`s, and Menu's `_tip`). Deliberately single-purpose: wrap, place, show/hide, anti-flicker, touch-hide — and nothing else.

```js
const tip = new Tooltip(scene);   // builds one label at Config.ui.depth.tooltip,
                                  // registered ignored by the world camera (UI space only)

tip.attach(target, textOrFn, {
  place: 'anchor',      // default. 'pointer' = follow cursor
  anchorY,              // anchor mode only: baseline y (default = target bottom + gap)
  clip,                 // (pointer) => boolean; gate a show. default: always true
});                     // wires pointerover/down -> show, out -> hide, up -> touch-hide.
                        // returns a detach() fn.

tip.setEnabled(false);  // suppression (launcher drag, open modal)
```

**Always-on internals** (the behaviors that are universal, not per-context):
- **Anti-flicker**: the service tracks the last target that requested show; a `hide` from any *other* target is ignored. `attach` passes `target` as the token automatically, so entities *and* menu rows get it — the menu's latent flicker is fixed for free.
- **Touch-hide**: `pointerup` hides only when `pointer.wasTouch` (preserves mouse-hover-after-click). One rule everywhere.
- **Pointer-follow**: one scene-level `pointermove` listener repositions the visible tip when it's in `'pointer'` mode. Absorbs `GameScene.js:1963`.

`place:'anchor'` reproduces `_placeHudTip` (center on target x, top at `anchorY`, clamp to screen). `place:'pointer'` reproduces `_placeFloatingLabel` (above-right -> flip -> clamp).

**Not the service's job:** button-state feedback (icon brighten/dim) is *not* folded in — no `onShow`/`onHide`. That logic is conditional and asymmetric (the "off" path calls `_refreshResetButton`/`_refreshNavButtons` to recompute alpha from enabled state, not a fixed dim), and it would exist with or without a tooltip. Callers keep their own hover handlers alongside `attach` — Phaser runs multiple listeners per object fine.

## 3. What each call site becomes

**Arena** — `Entity._enableInfo` collapses to one call; `showEntityInfo`/`hideEntityInfo`/`_infoEntity`/`_placeEntityInfo` all delete:
```js
scene.tip.attach(view, () => this.infoText(), { place: 'pointer' });
```
`_infoSuppressed` -> `scene.tip.setEnabled(false)` during launcher drag.

**Menu** — takes the service in (like `placeLabel` is passed now); `attachTooltip`/`_showTip`/`_hideTip` and the `_tip` object all delete. The clip *is* the old gate:
```js
this._tip.attach(target, text, { place: 'pointer', clip: (p) => this._overCard(p) });
```

**HUD** — each of the ~8 inline blocks (`_buildHudStat`, `_buildNavIcon`, restart/status/menu/turn) splits into the tooltip (one `attach`) plus its own tiny brighten/dim handlers, which stay where their conditional/refresh logic already lives:
```js
scene.tip.attach(icon, () => 'Restart Level' + suffix(), { place: 'anchor', anchorY: hudHeight + 6 });
icon.on('pointerover', () => { if (this._resetEnabled()) icon.setAlpha(1); })
    .on('pointerout',  () => this._refreshResetButton());
```
`_placeHudTip` and every per-anchor tooltip handler delete.

**Title** — *not* a service consumer. Keeps its always-on labels; only adopts the token (§1) + `infoText()` wording (already does).

## Migration order (each independently shippable + verifiable)

1. **Style token** (§1) — pure refactor, no behavior change.
2. **Build `Tooltip.js`** (§2) — no callers yet.
3. **Arena** — cleanest single consumer; verify hover/press/touch, anti-flicker between adjacent entities, follow, and suppression during launcher drag.
4. **Menu** — pass the service in, drop `_tip`; verify scrolled-row gating (clip) and that the anti-flicker guard doesn't over-hide.
5. **HUD** (×8) — split each into `attach` + its own brighten/dim handlers; verify reveal position, dynamic text (restart/nav/status), edge-clamping, and brighten/dim.
6. **Title** — swap the style literal for the token.
7. **Cleanup** — delete `_placeFloatingLabel`/`_placeHudTip`/`_infoEntity` remnants; reconcile the accidental wrap-width (320 vs 360) and depth drift into the one token.

Then the "more interesting look" (rounded corners, tail, shadow, fade/delay) is step 8 — isolated to `Tooltip.js` + the token.

## Honest risks to watch (all from real details in the code)

- **Camera**: the shared label must render in UI space only — the world camera must `ignore` it, as `entityInfoText` and Menu's `_tip` (`Menu.js:103`) do now. Register once in the service ctor.
- **Menu lifecycle**: the label is now scene-owned and persists across menu open/close — Menu must **not** add it to `parts` or destroy it on hide.
- **Dropping `_menuOpen` suppression**: works only if the menu backdrop blocks arena `pointerover` (full-screen interactive rect above the world, so it should). Verify; if hover leaks through, keep an explicit gate.
- **Modals**: keep `_modalOpen` suppression as `tip.setEnabled(false)` on modal open, since the token depth (40) sits above cards.
