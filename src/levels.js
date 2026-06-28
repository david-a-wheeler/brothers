/**
 * Level loading from Tiled JSON maps, grouped into "packs". See tiled-plan.md.
 *
 * We presume that the levels are in the format saved by the "Tiled" program.
 * `loadTiledLevel` is the single adapter that knows Tiled's JSON shape; it is
 * written to be relatively insensitive to the version of Tiled
 * (the format stored by Tiled has varied over time). In particular:
 * - it considers the object layers only
 * - it is tolerant of the word `type` vs `class`
 * - array vs map `properties`
 * - unknown fields are ignored;
 * - every field defaulted.
 * - it tries to "just work" on imperfect input.
 */

/** Defaults applied when a level omits something. */
const DEFAULTS = {
  moves: 6,
  wallRestitution: 0.6,
  goalRadius: 60,
  teleporterRadius: 44,
  retainVelocity: 0.6,
  // Per-brother size/mass multipliers a level can override (e.g. "David goes on
  // a diet"). Applied on top of the global defaults; 1 = no change. Ken's are
  // relative to Config.ball.radius/mass; David's are relative to Ken (so they
  // stack with the lab's Config.ball.davidRadiusMult / davidMassMult).
  kenRadiusMult: 1,
  kenMassMult: 1,
  davidRadiusMult: 1,
  davidMassMult: 1,
};

/**
 * @typedef {Object} Level
 * @property {{width:number, height:number}} arena
 * @property {number} moves
 * @property {number} wallRestitution
 * @property {{x:number,y:number}|null} david
 * @property {{x:number,y:number}|null} ken
 * @property {{x:number,y:number,radius:number}|null} goal
 * @property {{source:{x:number,y:number,radius:number}, target:{x:number,y:number}, retainVelocity:number}|null} teleporter
 * @property {{x:number,y:number,width:number,height:number}[]} walls
 * @property {number} kenRadiusMult
 * @property {number} kenMassMult
 * @property {number} davidRadiusMult
 * @property {number} davidMassMult
 */

/**
 * Normalise a Tiled `properties` value (modern array `[{name,value}]` or
 * legacy object map) into a plain `{ name: value }` object.
 *
 * @param {Array|Object|undefined} props
 * @returns {Object}
 */
function propsToObject(props) {
  if (!props) return {};
  if (Array.isArray(props)) {
    const out = {};
    for (const p of props) out[p.name] = p.value;
    return out;
  }
  return { ...props };
}

/**
 * Convert a parsed Tiled JSON map into our {@link Level} model.
 *
 * @param {Object} map  Parsed Tiled JSON.
 * @returns {Level}
 */
export function loadTiledLevel(map) {
  const arena = {
    width: (map.width || 0) * (map.tilewidth || 1),
    height: (map.height || 0) * (map.tileheight || 1),
  };
  const mapProps = propsToObject(map.properties);

  /** @type {Level} */
  const level = {
    arena,
    moves: mapProps.moves ?? DEFAULTS.moves,
    wallRestitution: mapProps.wallRestitution ?? DEFAULTS.wallRestitution,
    kenRadiusMult: mapProps.kenRadiusMult ?? DEFAULTS.kenRadiusMult,
    kenMassMult: mapProps.kenMassMult ?? DEFAULTS.kenMassMult,
    davidRadiusMult: mapProps.davidRadiusMult ?? DEFAULTS.davidRadiusMult,
    davidMassMult: mapProps.davidMassMult ?? DEFAULTS.davidMassMult,
    david: null,
    ken: null,
    goal: null,
    teleporter: null,
    walls: [],
  };

  // Collect objects across every object layer (ignore tile/image/group layers).
  const objects = [];
  for (const layer of map.layers || []) {
    if (layer.type === 'objectgroup') objects.push(...(layer.objects || []));
  }

  let source = null;
  let target = null;
  for (const o of objects) {
    const cls = o.class ?? o.type ?? '';
    const p = propsToObject(o.properties);
    switch (cls) {
      case 'wall':
        // Tiled rects are top-left; our walls are centre-based.
        level.walls.push({
          x: o.x + (o.width || 0) / 2,
          y: o.y + (o.height || 0) / 2,
          width: o.width || 0,
          height: o.height || 0,
        });
        break;
      case 'spawn':
        if (p.who === 'ken') level.ken = { x: o.x, y: o.y };
        else level.david = { x: o.x, y: o.y };
        break;
      case 'goal':
        level.goal = { x: o.x, y: o.y, radius: p.radius ?? DEFAULTS.goalRadius };
        break;
      case 'teleporter-source':
        source = { x: o.x, y: o.y, radius: p.radius ?? DEFAULTS.teleporterRadius, retain: p.retain };
        break;
      case 'teleporter-target':
        target = { x: o.x, y: o.y };
        break;
      default:
        break; // unknown class — ignored for forward-compatibility
    }
  }

  // A teleporter needs both ends; otherwise the level simply has none.
  if (source && target) {
    level.teleporter = {
      source: { x: source.x, y: source.y, radius: source.radius },
      target: { x: target.x, y: target.y },
      retainVelocity: source.retain ?? DEFAULTS.retainVelocity,
    };
  }

  return level;
}

/** @type {{id:string, name:string, levels:Level[]}|null} */
let activePack = null;
let activeIndex = 0;

/**
 * Fetch a pack's manifest and all its level files, adapting each.
 * Sets it as the active pack.
 * Throws if a file can't be fetched/parsed (the resilient bootstrap
 * in boot.js turns that into a retry).
 *
 * @param {string} packId  Directory name under `levels/`.
 * @returns {Promise<{id:string, name:string, levels:Level[]}>}
 */
export async function loadPack(packId) {
  const base = `levels/${packId}`;
  const manifest = await (await fetch(`${base}/pack.json`)).json();
  const levels = [];
  const levelIds = []; // stable per-level ids (the source filenames)
  for (const file of manifest.levels || []) {
    const tiled = await (await fetch(`${base}/${file}`)).json();
    levels.push(loadTiledLevel(tiled));
    levelIds.push(file);
  }
  activePack = { id: packId, name: manifest.name || packId, levels, levelIds };
  activeIndex = 0;
  return activePack;
}

/** @returns {string} Human-readable name of the active pack. */
export function activePackName() {
  return activePack.name;
}

/** @returns {string} Id of the active pack. */
export function activePackId() {
  return activePack.id;
}

/** @type {Array<{id:string, name?:string}>|null} Cached pack registry. */
let packList = null;

/**
 * The list of available packs from `levels/packs.json` (cached after first
 * fetch). Each entry has at least an `id`; names come from each pack's own
 * `pack.json` (see {@link loadPackManifest}).
 *
 * @returns {Promise<Array<{id:string, name?:string}>>}
 */
export async function listPacks() {
  if (packList) return packList;
  packList = await (await fetch('levels/packs.json')).json();
  return packList;
}

/**
 * Fetch only a pack's manifest (its `pack.json`) — NOT its level files — so the
 * menu can show a pack's name, level list, and per-level best scores without
 * disturbing the active pack/level. Level keys are `${id}/${levelId}`.
 *
 * @param {string} packId
 * @returns {Promise<{id:string, name:string, levelIds:string[]}>}
 */
export async function loadPackManifest(packId) {
  const manifest = await (await fetch(`levels/${packId}/pack.json`)).json();
  return { id: packId, name: manifest.name || packId, levelIds: manifest.levels || [] };
}

/** @returns {Level} The current level model. */
export function currentLevel() {
  return activePack.levels[activeIndex];
}

/** @returns {number} Number of levels in the active pack. */
export function levelCount() {
  return activePack.levels.length;
}

/** @returns {number} Index of the current level within the pack. */
export function currentIndex() {
  return activeIndex;
}

/**
 * Select the current level by index (clamped to the pack).
 *
 * @param {number} i
 * @returns {void}
 */
export function setLevelIndex(i) {
  activeIndex = Math.max(0, Math.min(i, activePack.levels.length - 1));
}

/**
 * Stable identity for the current level: pack id + the level's file id
 * (not its ordinal index, so reordering a pack doesn't reassign
 * per-level state like best scores).
 * Used to key the per-level "best" value (which is nil until first won).
 *
 * @returns {string}
 */
export function currentLevelKey() {
  return `${activePack.id}/${activePack.levelIds[activeIndex]}`;
}
