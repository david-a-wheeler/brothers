/**
 * Central tuning values for "Brothers".
 *
 * Everything you'd realistically want to tweak while balancing the game
 * lives here, so feel can be adjusted without digging through game logic.
 */

/** The one UI typeface. Exposed as `ui.font` and installed as the global default
 *  font for every Text in main.js, so no style needs to set `fontFamily` (Phaser's
 *  built-in default is Courier). Only genuine deviations (e.g. the title's serif)
 *  pass their own. */
const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

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
   * it goes "compact": two rows (info text above, icon row below). The icons keep
   * their normal size there (they must NOT grow on small screens) and the icon row
   * is kept tight to save vertical space. The single source for these knobs.
   */
  hud: {
    // Layout tiers. Wide: one row — turn text and Best/#Left at the edges with
    // the icons centred between. Compact: two rows — the info text on one line
    // (turn left, Best/#Left right), icons below. Narrow: three rows — state text,
    // then Best/#Left, then icons — so the two texts can't collide on a phone in
    // portrait. BOTH the wide→compact and compact→narrow breakpoints are computed
    // from the measured text widths (see GameScene._computeLayout), not fixed
    // pixel thresholds, so text never overlaps whatever the font renders to.
    rowHeight: 52, // height of the icon row in wide mode (icons + edge text share it)
    compactRowHeight: 38, // height of the icon row on small screens (icons don't grow, so keep it tight)
    narrowTextRow: 26, // height of a text-only row in compact/narrow mode (tight — pixels are scarce)
    normalIcon: 30, // icon display size (px) — the same on every screen size
    normalGap: 44, // spacing between icon centres
    statGap: 30, // spacing between the right-hand Pack/Best/#Left stats
    pad: 14, // edge padding for text
  },

  /**
   * Shared UI design tokens for the menu and modals (see menu-plan.md). Keeping
   * spacing, radii, colours, type, and motion in one place makes the panels feel
   * consistent by construction. Hex numbers are for shapes; CSS strings for text.
   */
  ui: {
    space: { xs: 4, sm: 8, md: 16, lg: 24 },
    radius: { card: 14, control: 8 },
    color: {
      surface: 0x23232c, // panel/card fill
      surfaceStroke: 0x4d4d55, // panel/card border
      row: 0xffffff, // row background tint (with rowAlpha)
      rowAlpha: 0.06,
      rowHoverAlpha: 0.12,
      divider: 0xffffff, // section rule (with dividerAlpha)
      dividerAlpha: 0.08,
      accent: 0xffd479, // gold — scores + "you are here" marker
      danger: 0x9b3a3a, // destructive (Forget)
      dangerHover: 0xb34a4a,
      dangerOff: 0x33333b, // destructive, disabled
      text: '#ffffff',
      textMuted: '#9aa0a6',
      textDisabled: '#6b6b75',
      accentText: '#ffd479',
    },
    font: UI_FONT, // the shared UI typeface — applied as a global default (see main.js), not per-style
    // Text roles: one place for every UI text size/colour/weight. Spread a role
    // into a style and override only what varies (e.g. a per-state colour). The
    // font is global (see main.js), so it's not repeated here.
    // Six sizes with real steps between them (13 / 16 / 18 / 20 / 24 / 52); the
    // whole 14-17 cluster collapses onto 16, the workhorse. Role names stay
    // semantic even where they share a size, so any can diverge again later.
    type: {
      banner: { fontSize: '52px', color: '#ffffff', fontStyle: 'bold' }, // end-of-level banner
      heading: { fontSize: '24px', color: '#ffffff', fontStyle: 'bold' }, // modal title
      title: { fontSize: '20px', color: '#ffffff', fontStyle: 'bold' }, // card/menu title
      button: { fontSize: '20px', color: '#ffffff' }, // modal button label
      stat: { fontSize: '18px', color: '#dddddd' }, // HUD right-hand stats
      row: { fontSize: '16px', color: '#ffffff' }, // list row label
      value: { fontSize: '16px', color: '#9aa0a6' }, // list row value
      control: { fontSize: '16px', color: '#ffffff' }, // chip button / two-up cell
      toggle: { fontSize: '16px', color: '#ffffff' }, // menu toggle label
      body: { fontSize: '16px', color: '#dddddd' }, // prose
      small: { fontSize: '16px', color: '#ffffff' }, // Lab value / panel title
      header: { fontSize: '13px', color: '#9aa0a6', fontStyle: 'bold' }, // section header
    },
    motion: { dur: 150, ease: 'Sine.Out', rowStagger: 25, hoverScale: 1.12 },
    // Shared tooltip look, used by every tooltip surface (HUD, arena, menu) and,
    // with a couple of overrides, the title's always-on name labels. One place to
    // restyle. `depth.tooltip` sits above cards (31-34), below modals (41-42).
    tooltip: {
      fontSize: '16px', // matches the body/help size in `type`
      color: '#f2f3f5', // refined off-white, softer than harsh pure #fff
      bg: 0x23232c, // = color.surface, so tips read as siblings of the cards
      bgAlpha: 0.94, // mostly opaque; a hint of the background bleeds through
      border: 0x4d4d55, // = color.surfaceStroke; a crisp hairline edge
      radius: 8, // = radius.control, a touch tighter than the cards' 14
      padding: { x: 9, y: 6 },
      shadow: { y: 2, color: 0x000000, alpha: 0.33 }, // soft drop shadow (faked in layers)
    },
    depth: { tooltip: 40 },
  },

  /**
   * Camera zoom. The *minimum* zoom is computed at runtime so the whole arena
   * fits in the world camera's area below the HUD (see GameScene._setupCameras);
   * only the maximum and the wheel step live here.
   */
  zoom: {
    max: 10, // deep enough to place a pin on default-size Ken in fine detail
    wheelStep: 0.1, // fraction of zoom changed per mouse-wheel notch
    // World-pixels of gray kept around the arena when fully zoomed out (so you
    // can see it ends), and how far you may overscroll past an edge into gray
    // when zoomed in. Higher = more breathing room / looser panning.
    edgeMargin: 64,
  },

  /** A faint reference grid on the arena floor, so zooming reads clearly. */
  grid: { size: 64, color: 0xffffff, alpha: 0.06 },

  /**
   * The anchor's aiming "pin" (see pin-plan.md). Before launch, the anchor
   * brother's pin can be moved off-centre to aim the shot; a placed pin shows as
   * a small near-black dot on the tether. `color`/`radius` are its look;
   * `doubleTapMs` is the double-tap window (recenter); `dragThreshold` is the
   * screen-pixel movement that promotes a press into a fine-drag; and a drag
   * dragged past `revertRadiusMult` × the ball's radius is read as a tooltip
   * request instead, ending the drag and reverting the pin.
   */
  pin: {
    color: 0x111114, // nearly-black dot on the band
    radius: 4, // small; slightly wider than the 4px-wide band line
    doubleTapMs: 350, // max gap between two taps to count as a double-tap
    dragThreshold: 6, // screen px of movement that promotes a press to a drag
    revertRadiusMult: 1.5, // drag past this × ball radius ends + reverts the gesture
  },

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
   * Mud areas (world class `Mud`): shaped regions that make a brother passing
   * through them muddy. Muddiness is extra `frictionAir` carried on the brother,
   * so a muddy brother drags and settles sooner; it persists after leaving the
   * puddle until shed (a settle-time wiggle) or washed (a `Cleaner`). See
   * mud-plan.md. `viscosity` is a level-overridable per-area default; the rest
   * are look/feel.
   */
  mud: {
    viscosity: 0.08, // persistent friction picked up on entry (base frictionAir is 0.025)
    inViscosity: 0, // extra friction only WHILE inside (0 = none; opt-in per area, e.g. a bog)
    color: 0x6b4423, // normal mud fill (brown)
    stickyColor: 0x2a1a0e, // sticky mud fill (near-black brown)
    overlayAlpha: 0.85, // strength of the muddy-brother splat overlay
    depth: 0, // below the brothers (depth 3) and walls; above the background
    // The end-of-turn shimmy that sheds normal (non-sticky) mud.
    wiggle: { angleDeg: 12, duration: 90, repeats: 5 },
  },

  /**
   * Cleaner areas (world class `Cleaner`, looks like water): entering one washes
   * a brother's loose mud off (and sticky mud too if the area sets `cleanSticky`).
   * Its own `viscosity` is a small drag that applies only WHILE inside and never
   * perpetuates (held on the area, not the brother). See mud-plan.md.
   */
  cleaner: {
    viscosity: 0.01, // very small transient drag while in the water
    color: 0x3aa0d8, // watery blue (drawn translucent)
    depth: 0,
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
      // The near-black ball loses its silhouette on the dark arena floor, so a
      // thin, muted rim just barely defines the edge (subtle by design — it should
      // add contrast, not draw the eye) and a top-left highlight reads as a glossy
      // sphere. Nudge outlineAlpha/outlineColor up for a stronger edge, or swap
      // outlineColor to a warm red (e.g. 0xff5a3c) for a danger cue.
      outlineColor: 0x8a8a94,
      outlineWidth: 1,
      outlineAlpha: 0.5,
    },
    /**
     * Pre-launch direction arrow (a general indicator, see effects.directionArrow):
     * shown for a dynamic hazard before play begins so the player can read where
     * it will go and — from the head's spin rate — roughly how fast. The head
     * always points along the shaft; it fakes a 3D spin about the shaft axis by
     * oscillating its width (scaleY), a half-turn every `spinBaseMs / speed` ms
     * (faster hazard → faster spin), clamped so extremes stay legible. Translucent
     * fill + a contrasting outline keep it visible over any background while still
     * showing what's underneath.
     */
    arrow: {
      length: 34, // shaft length (px)
      thickness: 6, // shaft thickness
      headLength: 20, // arrowhead length along the shaft (tip reach)
      headHalfWidth: 13, // arrowhead half-width at its base (face-on)
      gap: 8, // clearance between the hazard's edge and the arrow's tail
      color: 0xffffff, // fill
      fillAlpha: 0.5, // translucent so what's underneath still reads
      outlineColor: 0x101014, // dark rim so the light fill stays visible on light art
      outlineAlpha: 0.7,
      outlineWidth: 2,
      spinBaseMs: 800, // ms per half-turn at speed 1; half-turn = spinBaseMs / speed
      spinMinMs: 90, // clamp so a very fast hazard doesn't strobe
      spinMaxMs: 2600, // clamp so a very slow hazard still visibly turns
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
