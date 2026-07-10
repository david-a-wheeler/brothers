/**
 * Tiny persistent preferences store, backed by localStorage like {@link
 * import('./scores.js')}. It remembers where the player was (pack + level) and
 * which developer tools were on (Test mode, the Lab panel), plus whether boot
 * goes to the title screen or straight into the game.
 *
 * All access is wrapped in try/catch so private-mode / disabled storage degrades
 * to the default rather than throwing. Nothing here is authoritative: a stored
 * pack or level may have vanished since it was written, so readers must treat
 * these as *hints* and be ready to fall back (see main.js's boot restore).
 */

const SKIP_KEY = 'skip_title_screen';
const PACK_KEY = 'last_pack';
const LEVEL_KEY = 'last_level';
const TEST_KEY = 'test_mode';
const LAB_KEY = 'lab_open';

/** Read a stored string, or null when absent/unreadable. @param {string} k @returns {string|null} */
function read(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Write a string, ignoring an unavailable store. @param {string} k @param {string} v @returns {void} */
function write(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Storage unavailable: nothing to persist; the next boot uses the default.
  }
}

/**
 * Should boot skip the title screen and go straight to the game? True only when
 * the flag is explicitly stored `'true'`; a missing or any other value means
 * show the title (so a first-time visitor always sees it).
 *
 * @returns {boolean}
 */
export function skipTitle() {
  return read(SKIP_KEY) === 'true';
}

/**
 * Persist whether to skip the title screen on future boots. Pressing "Play"
 * sets this true; the menu's "Show title screen" sets it false.
 *
 * @param {boolean} value
 * @returns {void}
 */
export function setSkipTitle(value) {
  write(SKIP_KEY, value ? 'true' : 'false');
}

/**
 * The pack the player was last in, or null if none is stored. Only a hint: the
 * pack may have been renamed or removed since, so the caller must verify it
 * against the live pack list before loading it.
 *
 * @returns {string|null}
 */
export function lastPack() {
  return read(PACK_KEY);
}

/** Remember the active pack (its directory name / id). @param {string} id @returns {void} */
export function setLastPack(id) {
  write(PACK_KEY, id);
}

/**
 * The 0-based level index the player was last on; 0 when absent or unparseable.
 * Also only a hint — the pack may now have fewer levels (loading clamps).
 *
 * @returns {number}
 */
export function lastLevel() {
  const n = Number.parseInt(read(LEVEL_KEY) ?? '', 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Remember the current level index (0-based). @param {number} index @returns {void} */
export function setLastLevel(index) {
  write(LEVEL_KEY, String(index));
}

/** @returns {boolean} Was Test mode (and so god mode) left on? */
export function testMode() {
  return read(TEST_KEY) === 'true';
}

/** @param {boolean} value @returns {void} */
export function setTestMode(value) {
  write(TEST_KEY, value ? 'true' : 'false');
}

/** @returns {boolean} Was the Lab panel left open? */
export function labOpen() {
  return read(LAB_KEY) === 'true';
}

/** @param {boolean} value @returns {void} */
export function setLabOpen(value) {
  write(LAB_KEY, value ? 'true' : 'false');
}
