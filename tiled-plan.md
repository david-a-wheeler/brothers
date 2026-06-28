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

Set each object's **Class** (older Tiled: **Type**) to one of:

| Class                | Shape  | Properties                          | Meaning |
| -------------------- | ------ | ----------------------------------- | ------- |
| `wall`               | rect   | —                                   | A solid wall (deflects balls). |
| `spawn`              | point  | `who` = `"david"` \| `"ken"`        | A brother's start position. |
| `goal`               | point  | `radius` (number)                   | The destination zone. |
| `teleporter-source`  | point  | `radius` (number), `retain` (0–1)   | Portal entrance (optional). |
| `teleporter-target`  | point  | —                                   | Portal exit (optional). |

Map-level custom properties:

| Property          | Type  | Meaning                                   |
| ----------------- | ----- | ----------------------------------------- |
| `moves`           | int   | Moves allowed this level.                 |
| `wallRestitution` | float | Wall bounciness (0–1).                    |

Arena size = the map's pixel dimensions. Rectangle objects use Tiled's top-left
coordinates; the adapter converts walls to center coordinates. Point objects use
their `x,y` directly. A teleporter exists only if **both** source and target are
present.

## Adding a new object type later

Because everything funnels through the adapter, adding an object type is small:

1. In Tiled, place an object and set its **Class** to the new name (+ any
   properties). No project/types file is required — a plain class string works
   in every Tiled version (the adapter reads `class`/`type`). A Tiled
   `.tiled-project` defining the classes is *optional* and is intentionally
   avoided here because that feature is version-specific.
2. Add a `case` for the class in `loadTiledLevel` that maps it into the level
   model.
3. Add the build code in the scene that turns that model data into game objects.

Nothing else changes — old levels without the new type still load.

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
