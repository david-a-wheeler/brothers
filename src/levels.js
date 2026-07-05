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

import { recordLevelCount } from './scores.js';

/** Defaults applied when a level omits something. */
const DEFAULTS = {
  moves: 6,
  wallRestitution: 0.6,
  pinEnabled: true, // whether the anchor's aiming pin can be moved (see pin-plan.md)
  pinResetOn: 'impact', // when a placed pin recentres: 'impact' (aim-only) or 'settle' (live off-centre tether)
};

/**
 * A placed entity's definition, kept type-agnostic on purpose: the loader
 * doesn't know what a "goal" or "teleporter" is — it just records the Tiled
 * `kind` (class), centre position, size, name, and any custom properties.
 * `src/world` owns all type behaviour and per-type defaults, so adding an entity
 * type needs no loader change.
 *
 * @typedef {{kind:string, x:number, y:number, width:number, height:number,
 *   name:string, [prop:string]:any}} EntityDef
 */

/**
 * @typedef {Object} Level
 * @property {{width:number, height:number}} arena
 * @property {string} name  Optional display name ('' if unnamed); see {@link levelName}.
 * @property {string} intro  Optional intro/briefing text ('' if none); see {@link levelIntro}.
 * @property {number} moves
 * @property {number} wallRestitution
 * @property {boolean} pinEnabled  Whether the anchor's aiming pin can be moved.
 * @property {'impact'|'settle'} pinResetOn  When a placed pin recentres (see pin-plan.md).
 * @property {EntityDef[]} objects  Every placed entity (brothers, goals, teleporters, walls, …).
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
    name: mapProps.name ?? '',
    intro: mapProps.intro ?? '',
    moves: mapProps.moves ?? DEFAULTS.moves,
    wallRestitution: mapProps.wallRestitution ?? DEFAULTS.wallRestitution,
    pinEnabled: mapProps.pinEnabled ?? DEFAULTS.pinEnabled,
    pinResetOn: mapProps.pinResetOn ?? DEFAULTS.pinResetOn,
    objects: [],
  };

  // Collect objects across every object layer (ignore tile/image/group layers).
  const objects = [];
  for (const layer of map.layers || []) {
    if (layer.type === 'objectgroup') objects.push(...(layer.objects || []));
  }

  // The loader is fully type-agnostic: every classed object — brothers, goals,
  // teleporters, walls — is recorded generically for the world layer to
  // interpret. Rect objects (e.g. walls) are converted from Tiled's top-left to
  // centre coordinates; points have zero size so their centre is just their
  // x,y. Unclassed objects are skipped.
  for (const o of objects) {
    const cls = o.class ?? o.type ?? '';
    if (!cls) continue;
    level.objects.push({
      ...propsToObject(o.properties), // custom props (radius, retain, target, radiusMult, …)
      kind: cls,
      name: o.name || '',
      x: o.x + (o.width || 0) / 2,
      y: o.y + (o.height || 0) / 2,
      width: o.width || 0,
      height: o.height || 0,
    });
  }

  return level;
}

/**
 * A level's display name, or '' if unnamed. i18n-ready: today it returns the
 * single `name`; later it can resolve `name_<lang>` with a fallback to `name`.
 *
 * @param {Level} level @returns {string}
 */
export function levelName(level) {
  return level.name ?? '';
}

/**
 * A level's intro/briefing text, or '' if none. i18n-ready: today it returns the
 * single `intro`; later it can resolve `intro_<lang>` with a fallback to `intro`.
 *
 * @param {Level} level @returns {string}
 */
export function levelIntro(level) {
  return level.intro ?? '';
}

/** Root directory holding every pack (one sub-directory per pack). */
const PACKS_ROOT = 'packs';
/** A pack's level filename for a 0-based index (levels are 1-based, consecutive). */
const levelFile = (index) => `level${index + 1}.tmj`;
/** Guard so a mis-served directory can't make probing loop forever. */
const MAX_LEVELS = 999;

/**
 * The active pack: its directory name (which is also its id and display name)
 * plus a sparse cache of loaded {@link Level}s (filled lazily by
 * {@link ensureLevel}). `count` is discovered by probing; level bodies are
 * fetched only when first needed.
 * @type {{name:string, count:number, levels:Level[]}|null}
 */
let activePack = null;
let activeIndex = 0;

/**
 * Session cache of probed level counts, keyed by pack name. Held in memory only
 * (not persisted): a pack's level count can't change mid-session but may differ
 * after a reload, so it's recomputed fresh each page load and reused thereafter.
 * @type {Map<string, number>}
 */
const levelCountCache = new Map();

/**
 * Count a pack's consecutive `levelN.tmj` files with HEAD requests (no bodies
 * downloaded). Relies on levels being numbered consecutively from 1 — the whole
 * point: dropping `levelN.tmj` into the pack directory makes it appear, with no
 * manifest to edit. Rather than scan linearly (N+1 requests), it **gallops** —
 * probe indices 1, 2, 4, 8, … until one is missing — then **binary-searches**
 * the boundary, so it's O(log N) requests. The result is cached
 * ({@link levelCountCache}) so repeat callers (e.g. re-opening the menu) don't
 * re-probe.
 *
 * @param {string} packName  Pack directory name.
 * @returns {Promise<number>}  Number of consecutive levels present (0-based
 *   index of the first missing level).
 */
async function probeLevelCount(packName) {
  const cached = levelCountCache.get(packName);
  if (cached !== undefined) return cached;

  /** @param {number} i 0-based level index. @returns {Promise<boolean>} */
  const exists = async (i) =>
    (await fetch(`${PACKS_ROOT}/${packName}/${levelFile(i)}`, { method: 'HEAD' })).ok;

  let count;
  if (!(await exists(0))) {
    count = 0; // empty pack (no level1.tmj)
  } else {
    // Gallop to an upper bound: `lo` stays a present index, `hi` becomes a
    // missing one (or the runaway cap MAX_LEVELS).
    let lo = 0;
    let hi = 1;
    while (hi < MAX_LEVELS && (await exists(hi))) {
      lo = hi;
      hi *= 2;
    }
    hi = Math.min(hi, MAX_LEVELS);
    // Binary-search the boundary. Invariant: level `lo` present, level `hi`
    // missing; narrow until adjacent, so `hi` is the first missing index.
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await exists(mid)) lo = mid;
      else hi = mid;
    }
    count = hi;
  }

  levelCountCache.set(packName, count);
  recordLevelCount(packName, count); // persist for the menu (advisory; see scores.js)
  return count;
}

/**
 * Fetch and adapt one level of a pack.
 *
 * @param {string} packName @param {number} index  0-based.
 * @returns {Promise<Level>}
 */
async function fetchLevel(packName, index) {
  const res = await fetch(`${PACKS_ROOT}/${packName}/${levelFile(index)}`);
  if (!res.ok) throw new Error(`Missing level: ${packName}/${levelFile(index)}`);
  return loadTiledLevel(await res.json());
}

/**
 * Make a pack current: probe how many levels it has (no bodies downloaded) and
 * load only its first level, ready to play. Throws if the pack has no levels
 * (the resilient bootstrap in boot.js turns a throw into a retry).
 *
 * @param {string} packName  Pack directory name (also its id and display name).
 * @returns {Promise<void>}
 */
export async function loadPack(packName) {
  const count = await probeLevelCount(packName);
  if (count === 0) throw new Error(`Pack "${packName}" has no levels`);
  activePack = { name: packName, count, levels: new Array(count) };
  activeIndex = 0;
  await ensureLevel(0);
}

/**
 * Ensure the given level of the active pack is loaded (fetched + cached), then
 * return it. Cheap if already cached.
 *
 * @param {number} index  0-based (clamped to the pack).
 * @returns {Promise<Level>}
 */
export async function ensureLevel(index) {
  const i = Math.max(0, Math.min(index, activePack.count - 1));
  if (!activePack.levels[i]) activePack.levels[i] = await fetchLevel(activePack.name, i);
  return activePack.levels[i];
}

/**
 * Make `index` the current level, loading it first if needed. Await this before
 * restarting the scene onto another level, so {@link currentLevel} is ready
 * synchronously in the scene's create().
 *
 * @param {number} index  0-based (clamped to the pack).
 * @returns {Promise<void>}
 */
export async function selectLevel(index) {
  await ensureLevel(index);
  activeIndex = Math.max(0, Math.min(index, activePack.count - 1));
}

/** @returns {string} The active pack's name (also its id). */
export function activePackName() {
  return activePack.name;
}

/** @returns {string} The active pack's id (its directory name). */
export function activePackId() {
  return activePack.name;
}

/**
 * The active pack's manifest shape `{id, name, levelIds}` for pack-wide UI (e.g.
 * the HUD pack total). Level ids are the deterministic filenames; no fetch.
 *
 * @returns {{id:string, name:string, levelIds:string[]}}
 */
export function activePackManifest() {
  return {
    id: activePack.name,
    name: activePack.name,
    levelIds: Array.from({ length: activePack.count }, (_, i) => levelFile(i)),
  };
}

/** @type {Array<{id:string, name:string}>|null} Cached pack registry. */
let packList = null;

/**
 * The available packs from `packs/index.json` — a minimal array of pack
 * directory names, e.g. `["Base"]` (cached after first fetch). The directory
 * name is the pack's id and display name; everything else about a pack is
 * discovered by convention, so this file is the only per-pack ceremony.
 *
 * @returns {Promise<Array<{id:string, name:string}>>}
 */
export async function listPacks() {
  if (packList) return packList;
  const names = await (await fetch(`${PACKS_ROOT}/index.json`)).json();
  packList = names.map((name) => ({ id: name, name }));
  return packList;
}

/**
 * A pack's manifest `{id, name, levelIds}` WITHOUT loading any level bodies — so
 * the menu can show another pack's level list and per-level bests. The level
 * count is HEAD-probed; ids are the deterministic filenames. Level keys are
 * `${id}/${levelId}` (see {@link currentLevelKey}).
 *
 * @param {string} packName
 * @returns {Promise<{id:string, name:string, levelIds:string[]}>}
 */
export async function loadPackManifest(packName) {
  const count = await probeLevelCount(packName);
  return {
    id: packName,
    name: packName,
    levelIds: Array.from({ length: count }, (_, i) => levelFile(i)),
  };
}

/** @returns {Level} The current level model (loaded — see {@link selectLevel}). */
export function currentLevel() {
  return activePack.levels[activeIndex];
}

/** @returns {number} Number of levels in the active pack. */
export function levelCount() {
  return activePack.count;
}

/** @returns {number} Index of the current level within the pack. */
export function currentIndex() {
  return activeIndex;
}

/**
 * Stable identity for the current level: pack name + the level's filename, used
 * to key the per-level "best" value. Stable as long as levels aren't renumbered.
 *
 * @returns {string}
 */
export function currentLevelKey() {
  return `${activePack.name}/${levelFile(activeIndex)}`;
}
