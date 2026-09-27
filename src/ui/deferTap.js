/**
 * Queue `fn` to run once, on `scene`'s next `Phaser.Scenes.Events.UPDATE`,
 * instead of running it synchronously right now.
 *
 * That event is the library's own boundary between "this frame's input is
 * fully dispatched" and "this frame's game logic starts": Phaser updates its
 * input manager during the earlier game-level `PRE_STEP` (see `Phaser.Game#step`),
 * then each scene's `Systems#step` emits `UPDATE` before calling the scene's
 * own `update()` method. Listening for it here needs no queue of our own and
 * no change to any scene's `update()`; Phaser already fires it every frame.
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
 * @param {Phaser.Scene} scene
 * @param {() => void} fn
 * @returns {void}
 */
export function deferTap(scene, fn) {
  scene.events.once(Phaser.Scenes.Events.UPDATE, fn);
}
