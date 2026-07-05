/**
 * Per-level "intro seen" flags, backed by localStorage like {@link
 * import('./scores.js')} / {@link import('./prefs.js')}. A level's intro modal
 * shows on load until the player OKs it (which marks it seen); the main menu's
 * "See level intro" clears the flag to re-show it. Deliberately marking seen only
 * on OK means quitting mid-intro leaves it unseen, so it shows again next time.
 *
 * Keyed by `${packId}/${levelFilename}` (see `currentLevelKey` in levels.js). All
 * access is try/catch-wrapped so private-mode / disabled storage degrades to
 * "always show the intro" rather than throwing.
 */

const LS_KEY = 'intros_seen';

/** @returns {Record<string, true>} */
function load() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

/** @param {Record<string, true>} map @returns {void} */
function save(map) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: nothing to persist (the intro will show again).
  }
}

/** @param {string} levelKey @returns {boolean} true once its intro has been OK'd. */
export function introSeen(levelKey) {
  return load()[levelKey] === true;
}

/** Mark a level's intro seen (from the modal's OK). @param {string} levelKey @returns {void} */
export function markIntroSeen(levelKey) {
  const m = load();
  if (m[levelKey] !== true) {
    m[levelKey] = true;
    save(m);
  }
}

/** Clear a level's seen flag so its intro shows again. @param {string} levelKey @returns {void} */
export function clearIntroSeen(levelKey) {
  const m = load();
  if (levelKey in m) {
    delete m[levelKey];
    save(m);
  }
}
