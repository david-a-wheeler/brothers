/**
 * The seam between `levels.js` (must stay UI-agnostic: no Phaser, no Modal) and
 * whichever scene can actually show the player something. `levels.js` calls
 * {@link reportLoadFailure} at the moment it classifies a fetch as a genuine
 * network/loading problem (see LoadError there); the game registers a handler
 * once, via {@link onLoadFailure}, as soon as a scene exists that can show a
 * dialog.
 *
 * Nothing registers a handler during boot, so a boot-time failure calls into
 * an unregistered (no-op) reporter and is left entirely to main.js's own
 * resilience logic and boot.js's reload fallback, unchanged. This is timing,
 * not a special case to maintain: whoever registers last is the one target
 * (there's ever only one live scene that can show a dialog), so no menu/HUD
 * code anywhere needs its own error handling for a load failure; every call
 * into levels.js gets this for free.
 */

/** @type {((e: Error) => void)|null} */
let handler = null;

/**
 * Register the handler that runs on a load failure, replacing any previous
 * one. Call this once, as soon as a scene exists that can show a dialog.
 *
 * @param {(e: Error) => void} fn
 * @returns {void}
 */
export function onLoadFailure(fn) {
  handler = fn;
}

/**
 * Report a load failure to whatever's registered. A no-op before anything has
 * registered (i.e. during boot).
 *
 * @param {Error} e
 * @returns {void}
 */
export function reportLoadFailure(e) {
  handler?.(e);
}
