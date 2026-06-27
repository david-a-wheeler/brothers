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
    maxSpeed: 170, // launch speed at a full-strength pull
    curve: 2, // >1 eases in: small pulls give proportionally less, for fine control
  },

  /**
   * "Settled" = both balls below `speedThreshold` for `frames` frames in a
   * row. Debounced so a momentary slow-down mid-bounce won't end the turn.
   */
  settle: { speedThreshold: 0.15, frames: 30 },

  /**
   * Zone animation feel. Idle loops keep the goal/teleporter looking "alive";
   * the one-shot bursts fire on win and on teleport. All subtle by design so
   * the motion never competes with aiming. Tune freely.
   */
  anim: {
    /** Destination: slow scale + alpha "beckoning" pulse, plus win burst. */
    destination: {
      pulseScale: 1.12, // peak scale of the idle breath
      pulseAlpha: 0.55, // peak fill alpha of the idle breath (base is 0.35)
      pulseDuration: 1400, // ms for one half of the yoyo
      winBurstScale: 1.8, // one-shot pop when the level is cleared
      winBurstDuration: 320,
    },
    /** Teleporter source: breathing fill + a slow counter-rotating ring. */
    teleporter: {
      pulseAlpha: 0.8, // peak fill alpha of the idle breath (base is 0.5)
      pulseDuration: 1100,
      ringRotateDuration: 6000, // ms per full rotation of the overlay ring
      ringRadiusScale: 1.5, // overlay ring radius relative to source radius
    },
    /** Teleport target: calm idle breathe, arrival ring on warp-in. */
    target: {
      idleAlphaLow: 0.3,
      idleAlphaHigh: 0.75,
      idleDuration: 1300,
    },
    /** Shared expanding-ring effect (teleport out/in, reusable). */
    ring: {
      growScale: 2.6, // how far the ring expands from its start radius
      duration: 480,
    },
  },

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
    /**
     * Short interior brick walls (centre x/y, width/height). A few light
     * obstacles that force indirect shots without sealing off any route.
     * `restitution` is how bouncy they are off the balls.
     */
    walls: [
      { x: 640, y: 470, width: 220, height: 22 }, // mid-field barrier
      { x: 780, y: 300, width: 22, height: 170 }, // shields the goal's lower-left
      { x: 380, y: 250, width: 160, height: 22 }, // upper-left barrier
    ],
    wallRestitution: 0.6,
  },
};
