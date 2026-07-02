/**
 * Central tuning values for "Brothers".
 *
 * Everything you'd realistically want to tweak while balancing the game
 * lives here, so feel can be adjusted without digging through game logic.
 */
export const Config = {
  /**
   * Show developer-only tools (the Lab parameter panel and Test mode) in the
   * menu. Always on for now; this is the single switch to flip (or wire to a
   * production check) when we want to hide them in the deployed build.
   */
  devTools: true,

  /**
   * Design reference size. The canvas now uses Scale.RESIZE (fills the window),
   * so width/height are only a starting/default size — the live size comes from
   * the window (see GameScene._computeLayout). Colors are still used.
   */
  view: {
    width: 1024,
    height: 768,
    background: '#4d4d55', // "outside the arena" gray: canvas clear + page letterbox
    arenaColor: 0x1b1b22, // the play-area floor, so anything gray reads as out of bounds
  },

  /**
   * HUD layout. The ribbon is laid out to the live window size each frame it
   * changes (see GameScene._computeLayout/_layoutHud). On a small/narrow screen
   * it goes "compact": two rows (info text above, icon row below) with larger,
   * touch-friendly icons. The single source for these knobs.
   */
  hud: {
    // Layout tiers. Wide: one row — turn text and Best/#Left at the edges with
    // the icons centred between. The wide→compact breakpoint isn't a fixed width:
    // it's computed from the measured text width so the edge text never collides
    // with the icon cluster (see GameScene._computeLayout). Compact: two rows —
    // the info text on one line, icons below. Narrow (<= narrowMaxWidth): three
    // rows — state text, then Best/#Left, then icons — so the two texts can't
    // collide on a phone in portrait.
    narrowMaxWidth: 520,
    rowHeight: 52, // height of one HUD row (sized for the icon touch targets)
    narrowTextRow: 30, // height of a text-only row in narrow mode (tighter than icons)
    normalIcon: 30, // icon display size (px) on wide screens
    compactIcon: 44, // icon display size (px) on small screens (touch target)
    normalGap: 44, // spacing between icon centres, wide
    compactGap: 56, // spacing between icon centres, compact
    pad: 14, // edge padding for text
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

  /**
   * Shared rigid-body settings — the base every brother is sized from. `radius`
   * is the base radius; each brother scales it by its own `radiusMult`/`massMult`
   * (default 1, i.e. Ken). David's defaults come from `davidRadiusMult` /
   * `davidMassMult`, which are lab-tunable and live in applyRubberBandDefaults()
   * (so the lab's Reset restores them). A level's `david`/`ken` object can
   * override either per-brother multiplier (see world/Brother.js).
   */
  ball: {
    radius: 30, // base radius (a brother with radiusMult 1, e.g. Ken)
    restitution: 0.8, // bounciness off walls and each other (plan: 0.7-0.9)
    frictionAir: 0.025, // passive per-frame slowdown
    // davidRadiusMult / davidMassMult are set in applyRubberBandDefaults().
  },

  /**
   * Default hazard ("Bomb") settings — a self-propelled body that bounces
   * around the arena at a constant speed and menaces the brothers. A level
   * object overrides any of these per-bomb (Tiled `speed`, `angle`, `radius`/
   * `size`, `mode`). `speed` is in the same per-frame units as the slingshot
   * speeds; `restitution: 1` (perfectly elastic) plus the frictionless body in
   * Entity._dynCircleBody is what keeps a bounce from bleeding off energy.
   *
   * TUNNELING: a bomb is dynamic and can be small + fast — the case the
   * `physics.substeps` note below warns about. Keep radius/speed within the
   * substep budget (fastest per-sub-step move < obstacle thickness + 2·radius),
   * or raise `physics.substeps`, or a fast bomb can pass through a thin wall.
   */
  bomb: {
    radius: 22, // default circle radius when the level omits `radius`/`size`
    // Constant travel speed in the same per-frame units as the slingshot speeds
    // (a full launch is ~220; below ~3 is a near-stopped crawl). 15 drifts across
    // the arena in ~1s — a deliberate, dodgeable menace. Expect to tune this.
    speed: 15,
    restitution: 1, // perfectly elastic: bounces preserve speed
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
   * frame, so each sub-step moves ~maxSpeed / substeps.
   * That must stay below the
   * contact window of the thinnest obstacle, its thickness plus twice the ball
   * radius. For a 22px wall and a 30px-radius ball that window is ~82px; at
   * 220 / 8 ≈ 28px per sub-step we're well under it. (If you ever add a thin,
   * fast, *small-radius* object, raise `substeps` accordingly.) Raising it is
   * safe for feel: Matter normalises velocities and `body.speed` to per-frame
   * units, so launch strength, friction, and the settle/brake thresholds are
   * all sub-step-independent. CPU use cost scales linearly with it.
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
     * Goal: an archery target (concentric rings) that stays a fixed
     * size so it reads as a goal, not a collectible. Motion comes from a slow-
     * rotating reticle/crosshair overlay; the rings themselves never move,
     * except for a one-shot pop on win.
     */
    goal: {
      reticleRotateDuration: 9000, // ms per full rotation of the crosshair
      winBurstScale: 1.8, // one-shot pop of the whole target when cleared
      winBurstDuration: 320,
    },
    /** Teleporter source: breathing fill + motes pulled straight to the centre. */
    teleporter: {
      pulseAlpha: 0.8, // peak fill alpha of the idle breath (base is 0.5)
      pulseDuration: 1100,
      pullSpeed: 2.5, // inward speed factor (per second); higher = swifter pull-in
      pullLifespan: 450, // ms ≈ time to reach the centre; mote fades as arrives
      pullFrequency: 55, // ms between spawns (lower=more motes active at once)
      pullQuantity: 1, // motes per spawn
      // Destination exit motes: burst out of the centre, decelerate (friction)
      // to a stop, and fade — mirroring the source. They reuse pullFrequency /
      // pullQuantity so the exit rate matches the intake rate. Stop distance ≈
      // exitSpeed * exitLifespan / 2000 px (here ~18px, about halfway out).
      exitSpeed: 72, // initial outward speed (px/s)
      exitLifespan: 500, // ms; a mote decelerates to stop and fades out by here
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
    /** Bomb: the fuse spark flicker (a looping tween) + explosion ring colour. */
    bomb: {
      sparkFlickerDuration: 180, // ms per half-cycle of the fuse-tip flicker
      sparkAlphaLow: 0.35, // dimmest the spark fades to
      sparkScaleHigh: 1.4, // largest the spark swells to
      explosionColor: 0xff7a1a, // one-shot burst ring on contact
    },
  },
};

/**
 * The single source of truth for the tunable lab defaults (slingshot, tether,
 * and David's size/mass multipliers). Called once at load to populate Config,
 * and again by the dev panel's Reset button. To change a default, change it
 * here — it then applies to both startup and reset.
 *
 * @returns {void}
 */
export function applyRubberBandDefaults() {
  Object.assign(Config.slingshot, {
    maxPull: 260, // furthest the launcher can be stretched from the anchor
    minPull: 24, // shorter pulls are treated as a mis-click, not a launch
    maxSpeed: 220, // launch speed at a full-strength pull (the t=1 endpoint)
    minSpeed: 0, // floor: a tiny pull still nudges enough to reach the anchor
    curve: 2.0, // >1 eases in; lower lifts the mid-pull impulse, ends unchanged
  });
  Object.assign(Config.tether, {
    restLength: 90, // preferred resting gap (~1.5x ball diameter)
    stiffness: 0.02, // soft, slingshot-like restoring force
    damping: 0.08, // energy lost per oscillation (0 = a perpetual spring)
  });
  Object.assign(Config.ball, {
    davidRadiusMult: 1.2, // David's radius as a multiple of Ken's (lab 1.0-2.0)
    davidMassMult: 1.2, // David's mass as a multiple of Ken's (lab 1.0-3.0)
  });
}

applyRubberBandDefaults(); // initialise Config.slingshot / Config.tether at load
