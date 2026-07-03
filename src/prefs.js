/**
 * Tiny persistent preferences store, backed by localStorage like {@link
 * import('./scores.js')}. Currently just the one flag that decides whether the
 * boot goes to the title screen or straight into the game.
 *
 * All access is wrapped in try/catch so private-mode / disabled storage degrades
 * to the default (show the title) rather than throwing.
 */

const SKIP_KEY = 'skip_title_screen';

/**
 * Should boot skip the title screen and go straight to the game? True only when
 * the flag is explicitly stored `'true'`; a missing or any other value means
 * show the title (so a first-time visitor always sees it).
 *
 * @returns {boolean}
 */
export function skipTitle() {
  try {
    return localStorage.getItem(SKIP_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Persist whether to skip the title screen on future boots. Pressing "Play"
 * sets this true; the menu's "Show title screen" sets it false.
 *
 * @param {boolean} value
 * @returns {void}
 */
export function setSkipTitle(value) {
  try {
    localStorage.setItem(SKIP_KEY, value ? 'true' : 'false');
  } catch {
    // Storage unavailable: nothing to persist; boot falls back to the default.
  }
}
