# Levels with Tiled

## Decision

We use **[Tiled](https://www.mapeditor.org/)** (the open-source 2D level editor)
to author levels. Tiled runs on Linux (apt, snap, AppImage, itch.io). It is a
desktop app — there is no official web version — but that's fine: levels are
just data files committed to the repo; the browser game loads them.

Goal: **edit a level in Tiled → save → reload the tab → it's live**, with no
build step and as little glue as possible. Adding a brand-new *level* requires
one extra line (list its file in the pack manifest); editing an existing level
requires nothing but saving.

## Making the Tiled version not matter

apt installs older Tiled versions, and we never want that to break us. The
strategy:

1. **Use only object layers.** Our levels are object placement (spawns, a goal,
   teleporter points, rectangular walls), not tile painting. Avoiding tile
   layers/tilesets sidesteps everything that churns between versions: tile-data
   encoding (CSV/base64/zlib/zstd), infinite-map chunks, `gid`/tileset formats.
   An object layer — a list of `{name, x, y, width, height, point, class,
   properties}` — has been stable for years.
2. **One thin adapter** (`loadTiledLevel` in `src/levels.js`) is the *only* code
   that knows Tiled's JSON shape. It outputs our own clean level model, so the
   rest of the game never sees Tiled. Any version quirk is contained there.
3. **Normalize the fields that changed across versions:**
   - object **`type` → `class`**: Tiled 1.9 renamed "Type" to "Class". We read
     `obj.class ?? obj.type`, covering old and new.
   - **`properties`**: modern Tiled exports an array `[{name,value,type}]`; very
     old exports an object map. We normalize both to a plain `{}`.
4. **Read only what we need; ignore the rest.** Unknown object classes, extra
   fields, and the `version`/`tiledversion` strings are ignored — so newer
   exports don't break us and older ones just omit fields (we default them).
5. **Arena size comes from the map's pixel size** (`width*tilewidth ×
   height*tileheight`), so any tile size works and the arena is whatever you
   size the map to in Tiled.

The loader is written to **just work**: every field has a sensible default,
optional objects (e.g. a level with no teleporter) are fine, and malformed or
missing pieces degrade gracefully rather than throwing.

## File format & layout

Levels are Tiled **JSON maps** (`.tmj` — save as JSON in Tiled). They're fetched
with `fetch()` and `response.json()` (which parses regardless of MIME), so the
dev server doesn't need special configuration.

Levels are grouped into **packs**. A pack is a directory with a manifest:

```
levels/
  <packId>/
    pack.json        # { "name": "...", "levels": ["level1.tmj", ...] }  (ordered)
    level1.tmj
    level2.tmj
    ...
```

`pack.json` gives the pack a display name and the ordered list of level files.
The first pack is **Base** (`levels/base/`), currently one level.

## Schema (object classes & properties)

Set each object's **Class** (older Tiled: **Type**) to one of the following. The
Class is the **JS class name verbatim** (PascalCase) — the loader is generic and
the registry maps each Class straight to its `src/world/` class by name, so the
two must match exactly.

| Class              | Shape  | Properties                          | Meaning |
| ------------------ | ------ | ----------------------------------- | ------- |
| `Wall`             | rect   | —                                   | A solid wall (deflects balls). Any number. |
| `David`            | point  | `radiusMult`, `massMult` (optional) | David's start position. Name the controlled one **David**. |
| `Ken`              | point  | `radiusMult`, `massMult` (optional) | Ken's start position. Name the controlled one **Ken**. |
| `Goal`             | point  | `radius` (number)                   | A goal zone. **Any number — reaching any one wins.** |
| `Teleporter`       | point  | `radius` (number), `retain` (0–1), `target` (target name) | Portal entrance. Any number. |
| `TeleporterTarget` | point  | (Tiled **Name**)                    | Portal exit. Any number. |

Goals, teleporters, and targets are each independent — a level may have as many
as you like. A teleporter sends the pair to the `TeleporterTarget` whose Tiled
**Name** matches its `target` property (`dest`/`destination` are also accepted);
if it's omitted (or names no target), the **first** target is used. One target
may be the destination of many teleporters.

Normally there's one `David` and one `Ken`. The slingshot pair is chosen by
Tiled **Name** (`David`/`Ken`), so a level may later place extra, uncontrolled
brothers (doppelgängers) that render but aren't slingshotted. `radiusMult` /
`massMult` (optional) scale that brother off the base size/mass (default 1;
David's default comes from the lab). Mass is independent of size unless
`massMult` is set.

Map-level custom properties:

| Property          | Type  | Meaning                                   |
| ----------------- | ----- | ----------------------------------------- |
| `moves`           | int   | Moves allowed this level.                 |
| `wallRestitution` | float | Wall bounciness (0–1).                    |

Rectangle objects use Tiled's top-left coordinates; the adapter converts walls to
center coordinates. Point objects use their `x,y` directly. A teleporter with no
reachable target is simply inert.

### Arena size

**The arena is the map itself** — its size is the map's pixel dimensions
(`map width × tile width` by `map height × tile height`), so the canvas you see
in Tiled *is* the play area. It drives the physics bounds, the floor, the grid,
and the camera fit, and every level may be a different rectangle (the two base
levels are 1024×768 and 1280×800).

To set it in Tiled:

- **New map:** the *New Map* dialog's **Map size** (width/height in tiles) ×
  **Tile size** — the product is the arena in pixels.
- **Existing map:** **Map → Resize Map…** to change the width/height (in tiles),
  or **Map → Map Properties** to change the tile size. Use *Resize*'s offset if
  you want existing objects to stay put.

Because the size is *tiles × tile size*, the arena changes in whole-tile steps
(our maps use 32px tiles, so 32px steps). For a pixel-exact size, pick a tile
size that divides your target (or set the tile size to 1). Objects may sit
anywhere on the canvas; the arena clamps to the map bounds.

## Adding a new object type later

Each entity type is a small class in `src/world/` (a subclass of `Entity`) that
owns its visuals, physics body, and behaviour; the manager (`World`, in
`src/world/World.js`) builds them from the level model and the scene stays
generic. The loader is **type-agnostic** — it records every classed object into
one generic `level.objects` array (`kind`, centre `x,y`, size, `name`, custom
props) and knows nothing about goals or teleporters. So adding a type is just
two small steps:

1. In Tiled, place an object and set its **Class** to the new JS class name,
   exactly (PascalCase), plus any properties. No project/types file is required —
   a plain class string works in every Tiled version (the adapter reads
   `class`/`type`). A Tiled `.tiled-project` defining the classes is *optional*
   and is intentionally avoided here because that feature is version-specific.
   **No `loadTiledLevel` change is needed** — the new `kind` flows through
   automatically.
2. Add an `Entity` subclass that builds it, and add the class to the `CLASSES`
   list in `registry.js` — the only place that knows the type set. The kind →
   class map is derived from that list by class name, so there is no separate
   string key to keep in sync (the Tiled Class must equal the JS class name).
   Each subclass is constructed as
   `new Cls(scene, def, level)`; override only the hooks it needs:
   `onBrotherContact()` (trigger sensors), `isReached(brothers)` (win
   conditions), or `needsUpdate`+`update(ctx)` (per-frame dynamics; culled to
   the view). An unknown `kind` with no `KINDS` entry is simply ignored.

A sensor body is tagged `body.entity = this`, so the scene's collision
router dispatches contacts to the right instance without label strings. Nothing
else changes — old levels without the new type still load.

## Loading architecture

- **`src/levels.js`** — `loadTiledLevel(map)` (the adapter) and `loadPack(id)`
  (fetches `pack.json` + each level file, adapts them). Exposes the active pack,
  the current level, and level metadata.
- **`src/main.js`** — `await loadPack('base')` *before* creating the Phaser game
  (top-level await; the resilient loader in `boot.js` already awaits this, so a
  failed fetch retries/reloads).
- **`src/scenes/GameScene.js`** — reads the current level model and builds from
  it. Everything level-specific (arena size, moves, walls, spawns, goal,
  teleporter) comes from the level data, not from `Config`. `Config` keeps only
  global tuning (physics, zoom, animation, the fixed canvas/HUD size).
- **`Brothers`** receives the level (spawns, walls, arena bounds).

`Config.view.width/height` remains the fixed logical **canvas** size (and HUD
layout); the **arena** size is per-level and drives the matter bounds, the floor
rectangle, the floor grid, and the camera fit/clamp.

## Workflow

1. Open `levels/base/level1.tmj` in Tiled (or start a new JSON map, object layer).
2. Edit objects / map properties; save as `.tmj` in `levels/<pack>/`.
3. New level? Add its filename to that pack's `pack.json` (ordered).
4. Reload the tab.
