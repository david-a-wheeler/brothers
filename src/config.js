/**
 * Central tuning values for "Brothers".
 *
 * Everything you'd realistically want to tweak while balancing the game
 * lives here, so feel can be adjusted without digging through game logic.
 * Later, the per-level data should come from Tiled JSON instead of `level`.
 */
export const Config = {
  /** Logical resolution; the Scale manager fits this to the screen. */
  view: { width: 1024, height: 768, background: '#1b1b22' },

  /** Shared rigid-body settings for both brothers. */
  ball: {
    radius: 30,
    restitution: 0.8, // bounciness off walls and each other (plan: 0.7-0.9)
    frictionAir: 0.025, // passive per-frame slowdown
  },

  /**
   * The elastic tether joining the two brothers.
   * A small non-zero rest length keeps them from grinding together at the
   * same point, and damping bleeds spring energy so a turn can settle.
   */
  tether: {
    restLength: 90, // preferred resting gap (~1.5x ball diameter)
    stiffness: 0.02, // soft, slingshot-like restoring force
    damping: 0.08, // energy lost per oscillation (0 = a perpetual spring)
  },

  /** Slingshot feel. */
  slingshot: {
    maxPull: 260, // furthest the launcher can be stretched from the anchor
    minPull: 24, // shorter pulls are treated as a mis-click, not a launch
    power: 0.8, // launch speed applied per pixel of pull
  },

  /**
   * "Settled" = both balls below `speedThreshold` for `frames` frames in a
   * row. Debounced so a momentary slow-down mid-bounce won't end the turn.
   */
  settle: { speedThreshold: 0.15, frames: 30 },

  /** Per-level data (placeholder until Tiled map loading lands). */
  level: {
    moves: 6,
    david: { x: 350, y: 540 }, // 90px from Ken => tether starts at rest length
    ken: { x: 440, y: 540 },
    destination: { x: 880, y: 160, radius: 60 },
    teleporter: {
      source: { x: 512, y: 300, radius: 44 },
      target: { x: 160, y: 160 },
      retainVelocity: 0.6, // keep 60% of speed coming out of the portal
    },
  },
};
