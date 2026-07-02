/**
 * Persistent best-score store, backed by localStorage so totals survive page
 * reloads (the in-memory Phaser registry is cleared on reload).
 *
 * A "best" is the number of moves left when a level was won (higher is better);
 * `null` means the level has never been completed. Scores are keyed by the same
 * stable level key the game uses elsewhere: `${packId}/${levelFilename}` (see
 * `currentLevelKey` in levels.js).
 *
 * All localStorage access is wrapped in try/catch so private-mode / disabled
 * storage degrades to an in-memory cache rather than breaking the game.
 */

const LS_KEY = 'brothers:bests';

/** @type {Record<string, number>|null} Lazily-loaded cache of all bests. */
let cache = null;

/**
 * Parse the stored blob once into {@link cache}.
 *
 * @returns {Record<string, number>}
 */
function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Best score for a level, or `null` if it has never been completed.
 *
 * @param {string} levelKey  `${packId}/${levelFilename}`.
 * @returns {number|null}
 */
export function bestFor(levelKey) {
  const v = load()[levelKey];
  return typeof v === 'number' ? v : null;
}

/**
 * Record a win, keeping the higher (better) of any existing best. Persists the
 * whole blob back to localStorage.
 *
 * @param {string} levelKey  `${packId}/${levelFilename}`.
 * @param {number} movesLeft  Moves remaining at the win (higher = better).
 * @returns {void}
 */
export function recordBest(levelKey, movesLeft) {
  const c = load();
  if (c[levelKey] == null || movesLeft > c[levelKey]) {
    c[levelKey] = movesLeft;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(c));
    } catch {
      // Storage unavailable/full: keep the in-memory cache only.
    }
  }
}

/**
 * Forget (delete) the best scores for the given level keys, persisting the
 * result. Used by the menu's "Forget pack scores".
 *
 * @param {string[]} levelKeys  `${packId}/${levelFilename}` keys to clear.
 * @returns {void}
 */
export function forget(levelKeys) {
  const c = load();
  let changed = false;
  for (const k of levelKeys) {
    if (k in c) {
      delete c[k];
      changed = true;
    }
  }
  if (changed) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(c));
    } catch {
      // Storage unavailable: the in-memory cache is already updated.
    }
  }
}

/**
 * The full best-score cache (for computing pack totals in the menu).
 *
 * @returns {Record<string, number>}
 */
export function allBests() {
  return load();
}

/**
 * A pack's total best score and completed-level count, computed purely from
 * stored keys under `${packName}/` — so it works for ANY pack without knowing
 * its level count (the menu's "All packs" list needs this). The trailing slash
 * makes the prefix exact, so pack "Base" doesn't match "Base2/…".
 *
 * @param {string} packName
 * @returns {{total:number, completed:number}}
 */
export function packTotal(packName) {
  const prefix = `${packName}/`;
  const all = load();
  let total = 0;
  let completed = 0;
  for (const key in all) {
    if (key.startsWith(prefix) && typeof all[key] === 'number') {
      total += all[key];
      completed += 1;
    }
  }
  return { total, completed };
}

// --- Pack level counts ----------------------------------------------------
// A pack's level count is discovered by probing (see levels.js). We persist the
// last-known count per pack so the menu could later show counts for every pack
// without re-probing them all. This is advisory: it's refreshed whenever a pack
// is actually probed/loaded, so a stale value self-corrects. Nothing reads it
// for display yet — see menu-plan.md ("Record number of levels...").

const LC_KEY = 'brothers:levelcounts';

/** @type {Record<string, number>|null} Lazily-loaded cache of pack -> count. */
let lcCache = null;

/** @returns {Record<string, number>} */
function loadCounts() {
  if (lcCache) return lcCache;
  try {
    lcCache = JSON.parse(localStorage.getItem(LC_KEY) || '{}') || {};
  } catch {
    lcCache = {};
  }
  return lcCache;
}

/**
 * Last-known level count for a pack, or `null` if never recorded.
 *
 * @param {string} packName
 * @returns {number|null}
 */
export function levelCountFor(packName) {
  const v = loadCounts()[packName];
  return typeof v === 'number' ? v : null;
}

/**
 * Persist a pack's level count (no-op if unchanged). Called whenever the count
 * is determined, so the stored value tracks reality.
 *
 * @param {string} packName
 * @param {number} count
 * @returns {void}
 */
export function recordLevelCount(packName, count) {
  const c = loadCounts();
  if (c[packName] === count) return;
  c[packName] = count;
  try {
    localStorage.setItem(LC_KEY, JSON.stringify(c));
  } catch {
    // Storage unavailable: keep the in-memory cache only.
  }
}

/**
 * The full pack -> level-count cache (for the menu, later).
 *
 * @returns {Record<string, number>}
 */
export function allLevelCounts() {
  return loadCounts();
}
