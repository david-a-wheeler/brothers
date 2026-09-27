/**
 * Actions queued by {@link deferTap}, drained once per frame by
 * {@link flushDeferredTaps} (see GameScene.update).
 * @type {Array<() => void>}
 */
let queue = [];

/**
 * Queue `fn` to run after this frame's input handling finishes, instead of
 * running it synchronously right now.
 *
 * Use this to wrap the action of any discrete tap/click whose effect might
 * destroy the very game object Phaser is currently dispatching *this* event
 * through, or its container: a menu row that navigates (rebuilding the scroll
 * body it's part of), a close button that hides its own overlay, a confirm
 * button that closes its own modal. Destroying that object mid-dispatch can
 * stop Phaser from finishing its own event pipeline for this press/release.
 * In one traced case that left a ScrollView's drag mode stuck permanently
 * "dragging" after the row that started it was destroyed out from under the
 * release that should have ended it (see Menu.wireTap's history).
 *
 * Not needed for handlers whose effect doesn't destroy anything they're
 * dispatching through. A scene restart/transition is already deferred
 * internally by Phaser's own scene manager, and a handler that only mutates
 * data (not game objects) has nothing to derail.
 *
 * @param {() => void} fn
 * @returns {void}
 */
export function deferTap(fn) {
  queue.push(fn);
}

/**
 * Run every action queued by {@link deferTap}, in order, then clear the
 * queue. Called once per frame from GameScene.update(), after Phaser has
 * already finished dispatching this frame's input, so a deferred action can
 * safely destroy whatever it needs to without disturbing dispatch that's
 * already complete. An action a flushed callback itself queues (there's no
 * current case that does) runs on the next flush, not this one, since the
 * queue is swapped out before any of the current batch runs.
 *
 * @returns {void}
 */
export function flushDeferredTaps() {
  const pending = queue;
  queue = [];
  for (const fn of pending) fn();
}
