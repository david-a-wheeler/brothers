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
 * The full best-score cache (for computing pack totals in the menu).
 *
 * @returns {Record<string, number>}
 */
export function allBests() {
  return load();
}
