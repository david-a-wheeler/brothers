/**
 * Persistent best-score store, backed by localStorage so totals survive page
 * reloads (the in-memory Phaser registry is cleared on reload).
 *
 * A "best" is the number of turns left when a level was won (higher is better);
 * `null` means the level has never been completed. Scores are keyed by the same
 * stable level key the game uses elsewhere: `${packId}/${levelFilename}` (see
 * `currentLevelKey` in levels.js).
 *
 * Each entry is an object `{best, localDateTime, timezone, offset, utcDateTime}`
 * recording when the best was achieved. An *older* format stored just the number
 * (the best) with no timestamp; readers accept both, treating the missing fields
 * as `null` (see {@link bestOf} / {@link entryFor}).
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
 * The best turn count out of a stored value, accepting both the object format
 * and the legacy bare number. `null` if the value isn't a completed score.
 *
 * @param {number|object|undefined} v
 * @returns {number|null}
 */
function bestOf(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v.best === 'number') return v.best;
  return null;
}

/**
 * Best score for a level, or `null` if it has never been completed.
 *
 * @param {string} levelKey  `${packId}/${levelFilename}`.
 * @returns {number|null}
 */
export function bestFor(levelKey) {
  return bestOf(load()[levelKey]);
}

/**
 * @typedef {Object} ScoreEntry
 * @property {number} best  Moves left at the win (higher is better).
 * @property {string|null} localDateTime  ISO-with-offset local time of the win.
 * @property {string|null} timezone  IATA zone, e.g. "America/New_York".
 * @property {string|null} offset  Local UTC offset, e.g. "-05:00".
 * @property {string|null} utcDateTime  ISO UTC time of the win.
 */

/**
 * The full normalized entry for a level, or `null` if not completed. Legacy
 * number-only records return `best` with the timestamp fields `null`.
 *
 * @param {string} levelKey
 * @returns {ScoreEntry|null}
 */
export function entryFor(levelKey) {
  const v = load()[levelKey];
  const best = bestOf(v);
  if (best == null) return null;
  const meta = v && typeof v === 'object' ? v : {};
  return {
    best,
    localDateTime: meta.localDateTime ?? null,
    timezone: meta.timezone ?? null,
    offset: meta.offset ?? null,
    utcDateTime: meta.utcDateTime ?? null,
  };
}

/** Zero-pad to two digits. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local UTC offset of `d` as an ISO string, e.g. "-05:00". */
function isoOffset(d) {
  const mins = -d.getTimezoneOffset(); // getTimezoneOffset is minutes *behind* UTC
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Local wall-clock time of `d` as an ISO-with-offset string. */
function localIso(d) {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${isoOffset(d)}`
  );
}

/** Best IATA zone name, or `null` if the environment doesn't expose one. */
function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Record a win, keeping the higher (better) of any existing best. A new best
 * captures when it happened (local + UTC time, zone, and offset). Persists the
 * whole blob back to localStorage.
 *
 * @param {string} levelKey  `${packId}/${levelFilename}`.
 * @param {number} movesLeft  Moves remaining at the win (higher = better).
 * @returns {void}
 */
export function recordBest(levelKey, movesLeft) {
  const c = load();
  const prev = bestOf(c[levelKey]);
  if (prev != null && movesLeft <= prev) return; // not a new best
  const now = new Date();
  c[levelKey] = {
    best: movesLeft,
    localDateTime: localIso(now),
    timezone: localZone(),
    offset: isoOffset(now),
    utcDateTime: now.toISOString(),
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch {
    // Storage unavailable/full: keep the in-memory cache only.
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
    if (!key.startsWith(prefix)) continue;
    const b = bestOf(all[key]);
    if (b != null) {
      total += b;
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
