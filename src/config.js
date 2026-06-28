/**
 * Central tuning values for "Brothers".
 *
 * Everything you'd realistically want to tweak while balancing the game
 * lives here, so feel can be adjusted without digging through game logic.
 * Later, the per-level data should come from Tiled JSON instead of `level`.
 */
export const Config = {
  /** Logical resolution; the Scale manager fits this to the screen. */
  view: {
    width: 1024,
    height: 768,
    background: '#4d4d55', // "outside the arena" gray: canvas clear + page letterbox
    arenaColor: 0x1b1b22, // the play-area floor, so anything gray reads as out of bounds
  },

  /**
   * Camera zoom. The *minimum* zoom is computed at runtime so the whole arena
   * fits in the world camera's area below the HUD (see GameScene._setupCameras);
   * only the maximum and the wheel step live here.
   */
  zoom: {
    max: 3,
    wheelStep: 0.1, // fraction of zoom changed per mouse-wheel notch
    // World-pixels of gray kept around the arena when fully zoomed out (so you
    // can see it ends), and how far you may overscroll past an edge into gray
    // when zoomed in. Higher = more breathing room / looser panning.
    edgeMargin: 64,
  },

  /** A faint reference grid on the arena floor, so zooming reads clearly. */
  grid: { size: 64, color: 0xffffff, alpha: 0.06 },

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
  tether: {}, // populated by applyRubberBandDefaults() — the single source

  /** Slingshot feel; populated by applyRubberBandDefaults() — the single source. */
  slingshot: {},

  /**
   * "Settled" = both balls below `speedThreshold` for `frames` frames in a
   * row. Debounced so a momentary slow-down mid-bounce won't end the turn.
   */
  settle: {
    speedThreshold: 0.15,
    frames: 30,
    // The slow "crawl" at the end of a shot decays painfully slowly under air
    // friction alone. Once a ball drops below `brakeSpeed`, actively bleed off
    // its velocity (keep `brakeFactor` of it each frame) so it comes to rest
    // quickly. Faster motion stays above the threshold and is untouched.
    brakeSpeed: 3.0,
    brakeFactor: 0.7,
  },

  /**
   * Physics stepping. We advance Matter in a fixed number of small sub-steps
   * per frame so fast bodies can't tunnel through thin (and, later, moving)
   * obstacles: Matter has no continuous collision, so a body that moves farther
   * in one step than an obstacle is thick passes straight through it.
   *
   * Sizing `substeps`: the fastest launch covers ~`slingshot.maxSpeed` px in a
   * frame, so each sub-step moves ~maxSpeed / substeps. That must stay below the
   * contact window of the thinnest obstacle — its thickness plus twice the ball
   * radius. For a 22px wall and a 30px-radius ball that window is ~82px; at
   * 220 / 8 ≈ 28px per sub-step we're well under it. (If you ever add a thin,
   * fast, *small-radius* object, raise `substeps` accordingly.) Raising it is
   * safe for feel: Matter normalises velocities and `body.speed` to per-frame
   * units, so launch strength, friction, and the settle/brake thresholds are
   * all sub-step-independent. Cost scales linearly with it.
   */
  physics: {
    substeps: 8,
    maxFrameDelta: 1000 / 30, // clamp a stalled frame so sub-steps stay stable
  },

  /**
   * Zone animation feel. Idle loops keep the goal/teleporter looking "alive";
   * the one-shot bursts fire on win and on teleport. All subtle by design so
   * the motion never competes with aiming. Tune freely.
   */
  anim: {
    /**
     * Destination: an archery target (concentric rings) that stays a fixed
     * size so it reads as a goal, not a collectible. Motion comes from a slow-
     * rotating reticle/crosshair overlay; the rings themselves never move,
     * except for a one-shot pop on win.
     */
    destination: {
      reticleRotateDuration: 9000, // ms per full rotation of the crosshair
      winBurstScale: 1.8, // one-shot pop of the whole target when cleared
      winBurstDuration: 320,
    },
    /** Teleporter source: breathing fill + motes pulled straight to the centre. */
    teleporter: {
      pulseAlpha: 0.8, // peak fill alpha of the idle breath (base is 0.5)
      pulseDuration: 1100,
      pullSpeed: 2.5, // inward speed factor (per second); higher = swifter pull-in
      pullLifespan: 450, // ms ≈ time to reach the centre, so a mote fades as it arrives
      pullFrequency: 55, // ms between spawns (lower = more motes active at once)
      pullQuantity: 1, // motes per spawn
      // Destination exit motes: burst out of the centre, decelerate (friction)
      // to a stop, and fade — mirroring the source. They reuse pullFrequency /
      // pullQuantity so the exit rate matches the intake rate. Stop distance ≈
      // exitSpeed * exitLifespan / 2000 px (here ~18px, about halfway out).
      exitSpeed: 72, // initial outward speed (px/s)
      exitLifespan: 500, // ms; a mote decelerates to a stop and fades out by here
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
      source: { x: 620, y: 300, radius: 44 }, // centred in the gap between the upper-left barrier and the goal-shield wall
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

/**
 * The single source of truth for the tunable "rubber band" defaults (slingshot
 * + tether). Called once at load to populate Config, and again by the dev
 * panel's Reset button. To change a default, change it here — it then applies
 * to both startup and reset.
 *
 * @returns {void}
 */
export function applyRubberBandDefaults() {
  Object.assign(Config.slingshot, {
    maxPull: 260, // furthest the launcher can be stretched from the anchor
    minPull: 24, // shorter pulls are treated as a mis-click, not a launch
    maxSpeed: 220, // launch speed at a full-strength pull (the t=1 endpoint)
    minSpeed: 15, // floor: a tiny pull still nudges enough to reach the anchor
    curve: 2.3, // >1 eases in; lower lifts the mid-pull impulse, ends unchanged
  });
  Object.assign(Config.tether, {
    restLength: 90, // preferred resting gap (~1.5x ball diameter)
    stiffness: 0.02, // soft, slingshot-like restoring force
    damping: 0.08, // energy lost per oscillation (0 = a perpetual spring)
  });
}

applyRubberBandDefaults(); // initialise Config.slingshot / Config.tether at load
