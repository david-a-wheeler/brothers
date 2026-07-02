/**
 * The level-lifecycle contract — the hooks the game dispatches to its
 * "participants" as a level plays out.
 *
 * JavaScript has no `interface` keyword, so this is a JSDoc typedef standing in
 * for one. A class declares that it satisfies the contract with
 * `@implements {import('.../lifecycle.js').LevelParticipant}`; the editor / TS
 * language server then checks conformance (any hook it does define must match
 * the signature here) with no runtime code and no build step. This is a
 * types-only module — nothing imports it at runtime.
 *
 * Every hook is **optional**: a participant defines only the ones it cares about.
 * The base {@link import('./world/Entity.js').Entity} supplies inert defaults for
 * all of them (so every world object is a participant), and
 * {@link import('./Brothers.js').Brothers} — the pair coordinator, which is *not*
 * an Entity — implements the ones relevant to it. This is the lightweight,
 * inheritance-free way the two share a lifecycle (see the discussion that led
 * here: Brothers is a coordinator, not a placed world object).
 *
 * Who dispatches these today:
 *  - {@link import('./world/World.js').World}#notifyPlayStart / #notifyLevelEnd
 *    fan `onPlayStart` / `onLevelEnd` out to every Entity.
 *  - {@link import('./scenes/GameScene.js').GameScene} calls `Brothers.onLevelEnd`
 *    (and `Brothers.update`) directly, and ticks entities via `World.update`.
 *
 * @typedef {Object} LevelParticipant
 * @property {() => void} [onPlayStart] Kickoff: the first launch has connected.
 * @property {() => void} [onLevelEnd] The level ended (win or loss, any reason).
 * @property {(ctx?: {brothers: import('./Brothers.js').Brothers,
 *   view: Phaser.Geom.Rectangle}) => void} [update] Per-frame tick.
 */

export {}; // module marker so `import('./lifecycle.js').LevelParticipant` resolves
