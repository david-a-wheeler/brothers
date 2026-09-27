/**
 * Run `fn` on the next tick instead of synchronously.
 *
 * Use this to wrap the action of any discrete tap/click whose effect might
 * destroy the very game object Phaser is currently dispatching *this* event
 * through, or its container: a menu row that navigates (rebuilding the scroll
 * body it's part of), a close button that hides its own overlay, a confirm
 * button that closes its own modal. Destroying that object mid-dispatch can
 * stop Phaser from finishing its own event pipeline for this press/release.
 * In one traced case that left a ScrollView's drag mode stuck permanently
 * "dragging" after the row that started it was destroyed out from under the
 * release that should have ended it (see Menu.wireTap's history). One tick is
 * enough for Phaser to finish the current event, undisturbed, first.
 *
 * Not needed for handlers whose effect doesn't destroy anything they're
 * dispatching through. A scene restart/transition is already deferred
 * internally by Phaser's own scene manager, and a handler that only mutates
 * data (not game objects) has nothing to derail.
 *
 * @param {Phaser.Scene} scene
 * @param {() => void} fn
 * @returns {void}
 */
export function deferTap(scene, fn) {
  scene.time.delayedCall(0, fn);
}
