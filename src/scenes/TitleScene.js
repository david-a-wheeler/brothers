import { Config } from '../config.js';
import { FACES } from '../faces.js';
import { sfx } from '../Sfx.js';
import { setSkipTitle } from '../prefs.js';
import { David } from '../world/David.js';
import { Ken } from '../world/Ken.js';
import { Goal } from '../world/Goal.js';
import { drawBand, pulsingGlow } from '../world/effects.js';
import * as diag from '../diag.js';

/** Every face emoji the demo shows, pre-warmed at create (see _warmFaces). */
const DEMO_GLYPHS = [
  FACES.idle.launcher, FACES.idle.anchor,
  FACES.drag.launcher, FACES.drag.anchor,
  FACES.flight.launcher, FACES.flight.anchor,
  FACES.collision, FACES.win,
];

/**
 * The demo's fixed layout, in its own local units. The whole animation is one
 * container scaled to fit the screen (see {@link TitleScene._layoutDemo}), so the
 * geometry never collapses — David always draws back the correct direction — it
 * just shrinks uniformly on a narrow screen.
 */
const DEMO_PULL = 170; // how far left the launcher draws back from its rest spot
const DEMO_TRAVEL = 280; // the anchor's rest spot to the goal
const DEMO_ARC = 90; // how high the launcher rises during the pull-back

/**
 * Timing (ms) for one demo cycle, shared by BOTH turns (David-launches-Ken and
 * Ken-launches-David run the same {@link TitleScene._demoSteps} with the roles
 * swapped). Pulling the phase durations out here means a pacing tweak applies to
 * both turns at once — change a number, and both brothers' turns retime together.
 */
const DEMO_TIMING = {
  openHold: 5000, // hold the opening pose so it can be read
  pullBack: 3200, // draw back along the arc
  stretchHold: 500, // beat at full stretch
  release: 360, // sling straight into the anchor
  impact: 160, // collision flash
  travel: 1300, // the band carries the pair to the goal
  winHold: 5000, // bask in the win
  fade: 600, // fade the demo out
  blank: 2000, // blank beat before the next turn begins
};

/**
 * The intro / title screen: an arced "Brothers" wordmark with a gold shimmer,
 * the premise, a looping scripted demo of a shot reaching the goal, and a Play
 * button — over looping music.
 *
 * The demo mirrors the real game's turn-taking: each loop the brothers swap
 * roles, so one turn David launches Ken into the goal and the next Ken launches
 * David. Rather than script two animations, we script it *once* against abstract
 * `launcher`/`anchor` roles ({@link _assignRoles}) and re-point those at David or
 * Ken each cycle ({@link _startDemo}) — the faces are already role-relative, so
 * the same steps read correctly whoever is slinging.
 *
 * Reuse over reinvention: the demo's David, Ken, and Goal are the *real* world
 * entities ({@link David}/{@link Ken}/{@link Goal}), created in visual-only mode
 * (`physics: false`) so they carry their exact in-game look — colours, faces,
 * glasses/beard, the goal's rings + reticle + win pop — with no Matter bodies to
 * fight. Their motion is *scripted* with tweens (deterministic, so the shot
 * always lands and the loop is seamless) rather than simulated. The elastic band
 * and the launcher glow come from the same shared helpers the game uses
 * ({@link drawBand}/{@link pulsingGlow}), so they match exactly.
 *
 * Everything is laid out to the live window size and reflows on resize (see
 * {@link _layoutStatic} / {@link _computeGeo}); a resize simply restarts the demo
 * loop against the new geometry.
 */
export class TitleScene extends Phaser.Scene {
  constructor() {
    super('title');
  }

  /** @returns {void} */
  preload() {
    // The one audio *file* in the project (every game SFX is procedural; see
    // Sfx.js). Loaded only here, so a straight-to-game boot never fetches it.
    if (!this.cache.audio.exists('titleMusic')) {
      this.load.audio(
        'titleMusic',
        'assets/music/don-t-resist-the-groove-ska-loopable-esmFfRGNHc7DKfGHzk6mRE.mp3'
      );
    }
  }

  /** @returns {void} */
  create() {
    this.cameras.main.setBackgroundColor('#14141b');

    // Phaser reuses this scene instance across visits (title -> game -> title), so
    // create() re-runs but instance fields persist. Reset per-visit audio state so
    // this visit starts silent and needs its own "tap for sound" (the music flags
    // are already cleared by _stopMusic on the way out).
    this._soundOn = false;
    this._audioPaused = false;
    // Pressing Play to leave sets this and never clears it (we navigate away before
    // pointerout), so it would leak into the next visit and suppress that visit's
    // "tap for sound" (see _wireAudio). Clear it so each visit starts fresh.
    this._playArmed = false;

    this._buildBackground();
    this._buildTitle();
    this._buildPremise();
    this._buildDemo();
    this._warmFaces(); // rasterize every face emoji now, before music (see below)
    this._buildPlayButton();
    this._buildHint();

    this._layoutStatic();
    this._startDemo();

    this._wireAudio();

    // On focus loss, suspend the shared SFX context — this pauses BOTH the band
    // sound and the music (music now plays through that context, see _startMusic),
    // and keep the band muted until focus returns (the demo's band calls check
    // `_audioPaused`, see _demoSteps). A hidden tab is also handled by main.js
    // (sfx.suspend + loop sleep).
    const onBlur = () => {
      this._audioPaused = true;
      sfx.suspend();
    };
    const onFocus = () => {
      this._audioPaused = false;
      sfx.resume();
    };
    this.game.events.on(Phaser.Core.Events.BLUR, onBlur);
    this.game.events.on(Phaser.Core.Events.FOCUS, onFocus);

    // Reflow on window resize / device rotation. Static UI repositions at once;
    // the demo loop restarts (debounced) so a drag-resize doesn't thrash it.
    this.scale.on('resize', this._onResize, this);
    // On shutdown, only tear down what Phaser DOESN'T own: the scale listener, the
    // focus/blur hooks, the procedural band sound, and the raw-audio music. Phaser
    // destroys the scene's tweens and timers itself — calling `.remove()` on them
    // here (as _stopDemo does) throws mid-teardown and kills the game loop,
    // stalling the next scene.
    this.events.once('shutdown', () => {
      this.scale.off('resize', this._onResize, this);
      this.game.events.off(Phaser.Core.Events.BLUR, onBlur);
      this.game.events.off(Phaser.Core.Events.FOCUS, onFocus);
      sfx.stopBand();
      this._stopMusic();
    });

    // Mobile scale managers often report the final size a tick after create().
    this.time.delayedCall(0, () => this._onResize());
    this._ready = true;
    diag.breadcrumb('title: create');
  }

  // --- Static UI ----------------------------------------------------------

  /** @returns {void} */
  _buildBackground() {
    /** Full-screen vertical gradient (redrawn to size in {@link _layoutStatic}). */
    this._bg = this.add.graphics().setDepth(-10);
  }

  /** @returns {void} */
  _buildTitle() {
    // "Brothers" as separate letters so they can sit on an arc, each in gold. A
    // shimmer (Phaser 3.60 postFX Shine) sweeps over them while the letters stay
    // put, so it's dynamic but legible. The Shine is (re)applied in _layoutStatic
    // rather than here — a postFX left over from the previous font size ghosts the
    // old letters on resize, so it must be rebuilt whenever the layout changes.
    // (No glow: a per-letter low-quality glow read as a blobby halo artifact.)
    this._titleLetters = [...'Brothers'].map((ch) =>
      this.add
        .text(0, 0, ch, {
          fontFamily: 'Georgia, "Times New Roman", serif',
          fontStyle: 'bold',
          fontSize: '72px',
          color: '#ffd479',
        })
        .setOrigin(0.5)
        .setDepth(6)
    );
  }

  /** @returns {void} */
  _buildPremise() {
    this._premise = this.add
      .text(0, 0, 'Help the brothers, David and Ken,\nreach the goal in as few turns as possible.', {
        fontSize: '20px',
        color: '#e6e6ea',
        align: 'center',
        lineSpacing: 4,
      })
      .setOrigin(0.5)
      .setDepth(6);
  }

  /** @returns {void} */
  _buildPlayButton() {
    this._playG = this.add.graphics().setDepth(6);
    this._playText = this.add
      .text(0, 0, 'Play', {
        fontFamily: 'Georgia, serif',
        fontStyle: 'bold',
        fontSize: '30px',
        color: '#14141b',
      })
      .setOrigin(0.5)
      .setDepth(7);
    // A transparent rectangle carries the input so the whole pill is clickable.
    this._playHit = this.add
      .rectangle(0, 0, 10, 10, 0xffffff, 0)
      .setDepth(8)
      .setInteractive({ useHandCursor: true });

    this._playHit.on('pointerover', () => {
      this._playHover = true;
      this._drawPlayButton();
    });
    this._playHit.on('pointerout', () => {
      this._playHover = false;
      this._playArmed = false; // dragged off Play: a release elsewhere may start audio
      this._playText.setScale(1);
      this._drawPlayButton();
    });
    this._playHit.on('pointerdown', () => {
      this._playText.setScale(0.96);
      // Suppress the "first tap starts the title audio" behaviour for THIS press:
      // pressing Play means "go play the game", not "start the music" (see
      // _wireAudio). Cleared on pointerout so a drag-off still enables sound.
      this._playArmed = true;
    });
    // On pressup: remember the choice, silence the music, enter the game.
    this._playHit.on('pointerup', () => {
      this._playText.setScale(1);
      // If Play is the first interaction, _wireAudio's kick was suppressed, so the
      // context is still locked and the tick would be silent — unlock here (a
      // silent warm-up) purely so the tick sounds as button feedback. This starts
      // NO music: _startMusic only runs from kick, which stays suppressed.
      sfx.unlock();
      sfx.tick();
      setSkipTitle(true);
      this._stopMusic();
      diag.breadcrumb('title: Play → game');
      this.scene.start('game');
    });
  }

  /**
   * Draw the Play pill at its current geometry, tinted for hover. Positions come
   * from {@link _layoutStatic} (stored on `this._playBox`).
   *
   * @returns {void}
   */
  _drawPlayButton() {
    const b = this._playBox;
    if (!b) return;
    const U = Config.ui;
    const fill = this._playHover ? 0xffe6a6 : U.color.accent;
    this._playG.clear();
    this._playG
      .fillStyle(fill, 1)
      .fillRoundedRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, b.h / 2);
    if (this._playHover) this._playText.setScale(1.05);
  }

  /** @returns {void} */
  _buildHint() {
    // Browsers block audio until a user gesture, so the very first thing on boot
    // can't autoplay; this invites the tap that starts it, then fades once sound
    // is going (see _wireAudio). Sits in the bottom-left corner (bottom-left
    // origin), away from the Play CTA, so it can be legible without competing with
    // it. Size/position set in _layoutStatic.
    this._hint = this.add
      .text(0, 0, '🔊 Tap anywhere for sound', {
        color: '#c3c8cf',
      })
      .setOrigin(0, 1)
      .setDepth(6);
  }

  /**
   * Position/scale everything that isn't the demo to the live window size.
   *
   * @returns {void}
   */
  _layoutStatic() {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;

    // Background gradient: a touch lighter at the top so the gold title lifts off it.
    this._bg.clear();
    this._bg.fillGradientStyle(0x1d2233, 0x1d2233, 0x0d0d13, 0x0d0d13, 1);
    this._bg.fillRect(0, 0, W, H);

    // Title: fill ~90% of the width. Rather than guess a font from the width and
    // hope the word fits, we size the font so the word's ACTUAL rendered width
    // spans the target — measuring at a reference size and scaling (text width is
    // ~linear in font size) — then cap it by height so it can't get too tall on a
    // short screen. Letters are then laid out by their real widths, so nothing
    // overlaps and the word stays centred and full at any size.
    const n = this._titleLetters.length;
    const titleY = H * 0.15;
    const targetW = W * 0.9;
    const gapFrac = 0.06; // inter-letter gap as a fraction of the font size
    const REF = 100;
    this._titleLetters.forEach((t) => t.setFontSize(REF));
    const refW = this._titleLetters.reduce((s, t) => s + t.width, 0) * (1 + gapFrac);
    const fontPx = Math.round(
      Phaser.Math.Clamp((targetW / refW) * REF, 28, Math.min(H * 0.17, 130))
    );
    this._titleLetters.forEach((t) => t.setFontSize(fontPx));

    const widths = this._titleLetters.map((t) => t.width);
    const gapPx = fontPx * gapFrac;
    const totalW = widths.reduce((a, b) => a + b, 0) + gapPx * (n - 1);
    const arcH = fontPx * 0.35;
    let x = cx - totalW / 2; // left edge of the whole word, so it's centred
    this._titleLetters.forEach((t, i) => {
      const lx = x + widths[i] / 2; // this letter's centre
      const frac = totalW ? (lx - cx) / (totalW / 2) : 0; // -1 .. 1 across the word
      t.setPosition(lx, titleY - (1 - frac * frac) * arcH);
      t.setRotation(frac * 0.16); // gentle fan; letters stay upright enough to read
      x += widths[i] + gapPx;
      // Rebuild the shimmer so its render target matches the new font/position;
      // a postFX from the previous size otherwise ghosts the old letters. (postFX
      // is WebGL-only — on a Canvas fallback it's absent and the gold text stands.)
      if (t.postFX) {
        t.postFX.clear();
        t.postFX.addShine(0.6, 0.2, 5);
      }
    });

    this._premise.setStyle({ wordWrap: { width: Math.min(W * 0.82, 660) } });
    this._premise.setFontSize(Phaser.Math.Clamp(Math.round(W / 34), 15, 21));
    this._premise.setPosition(cx, H * 0.31);

    // Play pill, sized to its label. The font floor is modest so the button can
    // shrink on small screens rather than staying chunky, but not below a readable
    // size. The pill padding scales with the font so the whole button shrinks as a
    // unit — with floors so it stays an easy tap target on the smallest screens.
    const playFont = Phaser.Math.Clamp(Math.round(W / 26), 18, 32);
    this._playText.setFontSize(playFont);
    this._playText.setPosition(cx, H * 0.88);
    this._playBox = {
      x: cx,
      y: H * 0.88,
      w: this._playText.width + Math.max(44, Math.round(playFont * 2.2)),
      h: this._playText.height + Math.max(22, Math.round(playFont * 0.9)),
    };
    this._drawPlayButton();
    this._playHit.setPosition(this._playBox.x, this._playBox.y).setSize(this._playBox.w, this._playBox.h);

    // Hint: bottom-left corner, larger than before so it's actually noticed.
    // It's destroyed (and nulled) once audio starts on the first tap, so guard —
    // touching a destroyed Text here throws inside the resize step and kills the
    // render loop (screen goes dark). See _wireAudio.
    if (this._hint) {
      const margin = Math.round(Math.min(W, H) * 0.04);
      this._hint.setFontSize(Phaser.Math.Clamp(Math.round(W / 36), 16, 24));
      // Wrap within the gap left of the (centred) Play pill so the hint reflows
      // onto more lines instead of running under the button on a narrow screen.
      const playLeft = this._playBox.x - this._playBox.w / 2;
      this._hint.setAlign('left');
      this._hint.setWordWrapWidth(Math.max(70, playLeft - margin - 16));
      this._hint.setPosition(margin, H - margin);
    }

    this._layoutDemo(); // scale/position the demo container to fit
  }

  // --- The scripted demo --------------------------------------------------

  /**
   * Create the demo actors once: the real David/Ken/Goal in visual-only mode, the
   * shared elastic band + launcher glow, and always-on name labels. Positions and
   * the animation are (re)applied by {@link _startDemo}.
   *
   * @returns {void}
   */
  _buildDemo() {
    // A throwaway "level" — Brother reads only `arena` (for containment, which is
    // inert on a body-less brother). Size doesn't matter here.
    const level = { arena: { width: this.scale.width, height: this.scale.height } };
    this.david = new David(this, { x: 0, y: 0, name: 'David', physics: false }, level);
    this.ken = new Ken(this, { x: 0, y: 0, name: 'Ken', physics: false }, level);
    this.goal = new Goal(this, { x: 0, y: 0, radius: 50, name: 'Goal', physics: false });

    /** Elastic band, drawn between the pair each frame (shared look with the game). */
    this.band = this.add.graphics().setDepth(4);
    /** Pulsing "this one moves" halo on the current launcher (David starts). */
    this.glow = pulsingGlow(this, 0, 0, this.david.go.radius + 8);

    // Always-on name labels (the premise says "tooltips permanently enabled"). The
    // wording reuses each entity's own infoText(), so it reads exactly as in-game.
    // `drop` nudges each label further below its entity (by Ken's radius) to clear
    // things that extend past the body — David's pulsing "look at me" glow and the
    // goal's rings/reticle — and applies to all three so they sit uniformly.
    const drop = Config.ball.radius;
    const davidLbl = this._nameLabel(this.david.infoText());
    const kenLbl = this._nameLabel(this.ken.infoText());
    const goalLbl = this._nameLabel(this.goal.infoText());
    this._labels = [
      { txt: davidLbl, of: this.david, drop },
      { txt: kenLbl, of: this.ken, drop },
      { txt: goalLbl, of: this.goal, drop },
    ];
    // When a brother settles into the goal, his label and the goal's line up
    // horizontally, so the goal's label must drop enough that its top clears the
    // bottom of that brother's label. WHICH brother reaches the goal alternates
    // each turn (it's the anchor), and David is larger than Ken — so he sits (and
    // labels) lower — so this drop is recomputed per turn / per resize from the
    // current anchor by {@link _updateGoalDrop}. `_labelScale` is the legibility
    // counter-scale it measures against (set in _layoutDemo).
    this._labelScale = 1;
    this._goalExtraDrop = 0;

    // Everything that fades out during the blank between loops.
    this._faders = [
      this.david.go, this.david.face, this.david.feature,
      this.ken.go, this.ken.face, this.ken.feature,
      this.goal.gfx, this.goal.reticle,
      ...this._labels.map((l) => l.txt),
    ];

    // Parent the whole animation into one container so it can be scaled to fit as
    // a unit (see _layoutDemo). Added back-to-front; the geometry the demo uses is
    // now fixed local coordinates (_computeGeo), independent of screen size.
    this.stage = this.add.container(0, 0).setDepth(1);
    // A container renders its children in insertion order and ignores their per-
    // object depth, so each brother's parts must be added back-to-front to match
    // the depth stack they use in-game: body, then face, then the facial feature
    // ON TOP (David's glasses at depth 7 sit over the face at depth 6). Feature
    // after face — otherwise the face emoji paints over the glasses and hides them.
    this.stage.add(
      [
        this.goal.gfx, this.goal.reticle,
        this.band, this.glow,
        this.ken.go, this.ken.face, this.ken.feature,
        this.david.go, this.david.face, this.david.feature,
        ...this._labels.map((l) => l.txt),
      ].filter(Boolean)
    );

    // The first turn is David-launches-Ken (matching the game's usual opener).
    // `_swapped` flips after each cycle (see _runStep) to alternate turns.
    this._swapped = false;
    this._assignRoles();
  }

  /**
   * Point the `launcher`/`anchor` roles at David and Ken for the current turn.
   * Everything the demo animates is written against these roles, not the brothers
   * directly, so alternating `_swapped` swaps who slings and who ends in the goal
   * without duplicating a line of the animation.
   *
   * @returns {void}
   */
  _assignRoles() {
    this.launcher = this._swapped ? this.ken : this.david;
    this.anchor = this._swapped ? this.david : this.ken;
  }

  /**
   * Recompute how far the goal's name label drops so its top clears the bottom of
   * the label belonging to the brother settling into the goal (the anchor). Ken is
   * the baseline size; David is larger, so when he's the anchor his body and label
   * sit lower and the goal label must drop further. Called per turn (roles just
   * changed) and per resize (the counter-scale just changed).
   *
   * @returns {void}
   */
  _updateGoalDrop() {
    const c = this._labelScale;
    const anchorLabel = this._labels.find((l) => l.of === this.anchor).txt;
    // The goal already sits (goalR - anchorR) below where the anchor's label rides;
    // add whatever extra is needed for the anchor label's (scaled) height + a gap.
    const clearance = this.goal.radius - this.anchor.go.radius;
    this._goalExtraDrop = Math.max(0, anchorLabel.height * c + 6 - clearance);
  }

  /**
   * Pre-render every face emoji the demo will use, once, at create time. The
   * FIRST time a colour-emoji glyph is drawn the browser rasterizes it — a
   * main-thread stall long enough to underrun the audio (heard as a click the
   * first time a demo phase changes a face WITH music playing; e.g. David's arc.
   * Cached after, so it never recurs). Cycling each brother's real face Text
   * through all the glyphs here warms the cache before the tap starts the music,
   * so no phase pays that cost mid-playback. _resetDemo restores the idle faces.
   *
   * @returns {void}
   */
  _warmFaces() {
    for (const b of [this.david, this.ken]) {
      for (const g of DEMO_GLYPHS) b.setFace(g); // each setText rasterizes that glyph
    }
  }

  /**
   * @param {string} text
   * @returns {Phaser.GameObjects.Text}
   */
  _nameLabel(text) {
    // Always-on demo labels — a plain Text, not the in-game Tooltip box, but they
    // borrow the tooltip token's size/colour/padding so the two read consistently
    // (the font is the global UI default). Own look: a translucent black
    // background (the demo shows through).
    const tk = Config.ui.tooltip;
    return this.add
      .text(0, 0, text, {
        fontSize: tk.fontSize,
        color: tk.color,
        backgroundColor: '#000000cc',
        padding: tk.padding,
      })
      .setOrigin(0.5, 0)
      .setDepth(9);
  }

  /**
   * The demo's key positions, in the stage container's FIXED local coordinates
   * (not screen-relative), keyed by ROLE so they hold whichever brother is
   * slinging: the launcher at the origin, the anchor a rest-length to the right,
   * the goal a fixed travel beyond, the launcher's draw-back to the left. {@link
   * _layoutDemo} scales/positions the container so this always fits — the layout
   * itself never collapses, so the launcher can't sling the wrong way.
   *
   * @returns {{demoY:number, launcherX:number, anchorX:number, goalX:number, pullX:number, arcY:number}}
   */
  _computeGeo() {
    const gap = Config.tether.restLength; // the usual starting distance between them
    const launcherX = 0;
    const anchorX = launcherX + gap; // the launcher is furthest left
    const goalX = anchorX + DEMO_TRAVEL;
    const pullX = launcherX - DEMO_PULL;
    const demoY = 0;
    return { demoY, launcherX, anchorX, goalX, pullX, arcY: demoY - DEMO_ARC };
  }

  /**
   * Scale + position the demo container so its whole animation fits the space
   * between the premise and the Play button, centred. This is the ONLY place the
   * demo depends on screen size — narrow/short screens just shrink it (capped at
   * 1× so it never balloons on a big screen). Called from {@link _layoutStatic}.
   *
   * @returns {void}
   */
  _layoutDemo() {
    const W = this.scale.width;
    const H = this.scale.height;
    const g = this._computeGeo();
    // David is the larger brother, so bounding the launcher's extent by his radius
    // fits EITHER turn's launcher (a Ken-launches turn only ever needs less room).
    const launchR = this.david.go.radius;
    const goalR = this.goal.radius;

    // Bounding box of everything the animation touches (local units): the
    // launcher's draw-back on the left, the goal on the right, the arc peak on top,
    // and room under the goal for its name label at the bottom.
    const left = g.pullX - launchR;
    const right = g.goalX + goalR;
    const top = g.arcY - launchR;
    const bottom = goalR + Config.ball.radius + 56; // goal + label drop + a line
    const natW = right - left;
    const natH = bottom - top;

    // The band of screen between the premise (~0.31H) and the Play pill (~0.88H).
    // Width is capped at 86% so the animation keeps a left/right margin even when
    // it's the binding constraint (a narrow, tall screen).
    const bandTop = H * 0.4;
    const bandBottom = H * 0.82;
    const s = Math.min(1, (W * 0.86) / natW, (bandBottom - bandTop) / natH);

    this.stage.setScale(s);
    this.stage.setPosition(
      W / 2 - ((left + right) / 2) * s,
      (bandTop + bandBottom) / 2 - ((top + bottom) / 2) * s
    );

    // The name labels ride the container, so they'd shrink with it to unreadable
    // sizes on small phones. Counter-scale them (uniformly, so they stay a set)
    // toward a legibility floor — but conservatively: hold their on-screen size at
    // ~LABEL_FLOOR_PX and never enlarge past LABEL_MAX_COMP, past which enlarged
    // labels start crowding each other horizontally. Both bounds are gentle: on a
    // roomy screen (s near 1) the clamp lands on 1 and nothing changes.
    const LABEL_NATIVE_PX = 15; // matches _nameLabel's fontSize
    const LABEL_FLOOR_PX = 15; // don't let on-screen text drop below this
    const LABEL_MAX_COMP = 1.8; // cap the counter-scale so labels don't collide
    const c = Phaser.Math.Clamp(LABEL_FLOOR_PX / (LABEL_NATIVE_PX * s), 1, LABEL_MAX_COMP);
    for (const l of this._labels) l.txt.setScale(c);

    // The counter-scale just changed the anchor label's on-container height, so
    // re-derive the goal label's drop against the current anchor (see
    // _updateGoalDrop). Remember the scale it's measured at for the per-turn recompute.
    this._labelScale = c;
    this._updateGoalDrop();
  }

  /**
   * The goal's win burst, done in the demo container (Goal.celebrate spawns its
   * ring in world space, which wouldn't line up under the scaled/offset stage).
   * Pops the rings and expands a ring, both parented to the stage.
   *
   * @returns {void}
   */
  _celebrateGoal() {
    const a = Config.anim.goal;
    this.tweens.killTweensOf(this.goal.gfx);
    this.goal.gfx.setScale(1);
    this.tweens.add({
      targets: this.goal.gfx,
      scale: a.winBurstScale,
      duration: a.winBurstDuration,
      ease: 'Back.Out',
      yoyo: true,
    });
    const ring = this.add
      .circle(this.goal.gfx.x, this.goal.gfx.y, this.goal.radius)
      .setStrokeStyle(3, 0x2ecc71, 0.9);
    this.stage.add(ring);
    this.tweens.add({
      targets: ring,
      scale: Config.anim.ring.growScale,
      alpha: 0,
      duration: Config.anim.ring.duration,
      ease: 'Cubic.Out',
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * Reset the actors to the start pose for `geo`: positions, idle faces, full
   * opacity, glow shown on David.
   *
   * @param {ReturnType<TitleScene['_computeGeo']>} geo
   * @returns {void}
   */
  _resetDemo(geo) {
    // Place by role: the launcher on the left, the anchor a rest-length to its
    // right. Which brother that is was just set for this turn by _assignRoles.
    this.launcher.go.setPosition(geo.launcherX, geo.demoY);
    this.anchor.go.setPosition(geo.anchorX, geo.demoY);
    this._placeGoal(geo.goalX, geo.demoY);

    this.launcher.setFace(FACES.idle.launcher);
    this.anchor.setFace(FACES.idle.anchor);
    this.launcher.update(); // glue face + feature to the new spot at once
    this.anchor.update();

    for (const o of this._faders) o.setAlpha(1);
    this.band.setAlpha(1);

    this.tweens.killTweensOf(this.goal.gfx);
    this.goal.gfx.setScale(1);

    this.glow.radius = this.launcher.go.radius + 8;
    this.glow.setPosition(this.launcher.go.x, this.launcher.go.y).setVisible(true);
    this.glow.getData('pulse')?.resume();
  }

  /**
   * Move the goal (rings + reticle) as a unit; keep its `def`/`zone` in sync so
   * {@link Goal#celebrate}'s world-space ring lands on it.
   *
   * @param {number} x @param {number} y @returns {void}
   */
  _placeGoal(x, y) {
    this.goal.gfx.setPosition(x, y);
    this.goal.reticle.setPosition(x, y);
    this.goal.def.x = x;
    this.goal.def.y = y;
    this.goal.zone.x = x;
    this.goal.zone.y = y;
  }

  /**
   * Reset and run one demo cycle, then loop. The cycle is a list of timed phases
   * ({@link _demoSteps}) run in sequence by {@link _runStep}: pose → pull back
   * (arc) → release straight into Ken → the pair travels to the goal → win pop →
   * hold → fade; then a blank beat and repeat. Scripted (not simulated), so it
   * always lands and seams cleanly.
   *
   * @returns {void}
   */
  _startDemo() {
    this._assignRoles(); // David or Ken into launcher/anchor for THIS turn
    this._updateGoalDrop(); // goal label drop for whoever now ends in the goal
    const geo = this._computeGeo();
    this._resetDemo(geo);
    this._runStep(this._demoSteps(geo), 0);
  }

  /**
   * Run one phase as a 0→1 tween, then advance to the next; after the last, wait
   * out the blank beat and loop. Each step may animate via `onUpdate(t)`.
   *
   * @param {Array<{duration:number, ease?:string, onStart?:()=>void, onUpdate?:(t:number)=>void, onComplete?:()=>void}>} steps
   * @param {number} i
   * @returns {void}
   */
  _runStep(steps, i) {
    if (i >= steps.length) {
      // Turn-taking: swap who launches before the next cycle, so the loop alternates
      // David-launches-Ken and Ken-launches-David (see _assignRoles).
      this._swapped = !this._swapped;
      this._blankTimer = this.time.delayedCall(DEMO_TIMING.blank, () => this._startDemo());
      return;
    }
    const s = steps[i];
    const p = { t: 0 };
    s.onStart?.();
    this._active = this.tweens.add({
      targets: p,
      t: 1,
      duration: s.duration,
      ease: s.ease || 'Linear',
      onUpdate: s.onUpdate ? () => s.onUpdate(p.t) : undefined,
      onComplete: () => {
        s.onComplete?.();
        this._runStep(steps, i + 1);
      },
    });
  }

  /**
   * The demo phases for the current geometry. Coordinates are captured here so a
   * resize (which rebuilds the list) can't leave a running tween on stale points.
   *
   * @param {ReturnType<TitleScene['_computeGeo']>} geo
   * @returns {Array<object>}
   */
  _demoSteps(geo) {
    const qbez = (a, c, b, t) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * c + t * t * b;
    const lerp = Phaser.Math.Linear;
    const ctrlX = (geo.launcherX + geo.pullX) / 2;
    const gap = Config.tether.restLength; // final resting separation (rest length)
    // Centre-to-centre distance at which the two circles just touch. The launcher
    // stops here on impact and the pair never closes nearer than this while
    // travelling (gap > contact, so the interpolated separation stays >= contact).
    // Uses both current radii, so it's correct whichever brother is slinging.
    const contact = this.launcher.go.radius + this.anchor.go.radius;
    return [
      // Hold on the opening pose so the player can read it.
      { duration: DEMO_TIMING.openHold },
      // Pull back, arcing up then down to the anchor's height (shows up/down + left).
      {
        duration: DEMO_TIMING.pullBack,
        ease: 'Sine.InOut',
        onStart: () => {
          this.launcher.setFace(FACES.drag.launcher);
          this.anchor.setFace(FACES.drag.anchor);
          if (this._soundOn && !this._audioPaused) sfx.startBand();
        },
        onUpdate: (t) => {
          this.launcher.go.setPosition(
            qbez(geo.launcherX, ctrlX, geo.pullX, t),
            qbez(geo.demoY, geo.arcY, geo.demoY, t)
          );
          if (this._soundOn && !this._audioPaused) sfx.updateBand(t);
        },
      },
      // Beat at full stretch.
      { duration: DEMO_TIMING.stretchHold },
      // Release: straight (horizontal) into the anchor.
      {
        duration: DEMO_TIMING.release,
        ease: 'Quad.In',
        onStart: () => {
          sfx.stopBand();
          this.launcher.setFace(FACES.flight.launcher);
          this.anchor.setFace(FACES.flight.anchor);
          this.glow.setVisible(false);
          this.glow.getData('pulse')?.pause();
        },
        // Fly in from the left, stopping the instant it touches the anchor (never over it).
        onUpdate: (t) =>
          this.launcher.go.setPosition(lerp(geo.pullX, geo.anchorX - contact, t), geo.demoY),
      },
      // Impact flash.
      {
        duration: DEMO_TIMING.impact,
        onStart: () => {
          this.launcher.setFace(FACES.collision);
          this.anchor.setFace(FACES.collision);
        },
      },
      // The elastic band carries the pair to the goal, settling `gap` apart.
      {
        duration: DEMO_TIMING.travel,
        ease: 'Quad.Out',
        onStart: () => {
          this.launcher.setFace(FACES.flight.launcher);
          this.anchor.setFace(FACES.flight.anchor);
        },
        // The anchor leads into the goal; the launcher trails from the contact point
        // out to the rest length, so their separation only ever grows (contact -> gap).
        onUpdate: (t) => {
          this.anchor.go.setPosition(lerp(geo.anchorX, geo.goalX, t), geo.demoY);
          this.launcher.go.setPosition(lerp(geo.anchorX - contact, geo.goalX - gap, t), geo.demoY);
        },
        onComplete: () => {
          this._celebrateGoal(); // win pop, but NO win sound (music owns the audio)
          this.launcher.setFace(FACES.win);
          this.anchor.setFace(FACES.win);
        },
      },
      // Bask in the win.
      { duration: DEMO_TIMING.winHold },
      // Fade the whole demo out.
      {
        duration: DEMO_TIMING.fade,
        onUpdate: (t) => {
          const a = 1 - t;
          for (const o of this._faders) o.setAlpha(a);
          this.band.setAlpha(a);
        },
      },
    ];
  }

  // --- Audio --------------------------------------------------------------

  /** @returns {void} */
  _wireAudio() {
    // Unlock audio + start the music on the first interaction, then retire the
    // "tap for sound" hint. Fire on press-UP (`pointerup`/`touchend`), never
    // press-down: a press that goes to the Play button means "play the game", and
    // its pointerdown arms `_playArmed` so the release here is skipped — the game
    // starts in silence instead of the music wheeping up as we leave. (Press-up is
    // also where mobile actually resumes the AudioContext; a bare `pointerdown`
    // often doesn't.) We listen on both event types and retry the unlock on each
    // until the context is running; _startMusic then starts the loop the moment
    // the context reaches 'running' (its statechange handler). A DOM-level
    // listener catches the press even over the Play button (which stops Phaser
    // propagation).
    const canvas = this.game.canvas;
    const events = ['pointerup', 'touchend'];
    const stop = () => events.forEach((ev) => canvas.removeEventListener(ev, kick));
    const kick = () => {
      if (this._playArmed) return; // this press is a Play tap → jump to the game, no title audio
      this._soundOn = true; // the "tap for sound" happened: the demo band may sound now
      sfx.unlock();
      this._startMusic();
      if (this._hint?.active) {
        this.tweens.add({
          targets: this._hint,
          alpha: 0,
          duration: 400,
          onComplete: () => {
            this._hint?.destroy();
            this._hint = null; // so _layoutStatic skips it on later resizes
          },
        });
      }
      if (sfx.context?.state === 'running') stop(); // unlocked; no need to keep retrying
    };
    events.forEach((ev) => canvas.addEventListener(ev, kick));
    this.events.once('shutdown', stop);
  }

  /**
   * Start the looping title music. Driven directly off the decoded Web Audio
   * buffer (not a Phaser Sound) so the loop can skip the file's silent padding:
   * a single AudioBufferSourceNode with `loop = true` repeats seamlessly in the
   * audio thread, and trimming `loopStart`/`loopEnd` to the actual sound removes
   * the ~0.4s gap this "loopable" mp3 carries at its tail. Idempotent.
   *
   * Plays through the SFX context (sfx.context), not Phaser's, so the music and
   * the procedural band sound share ONE output stream. With two contexts, the
   * first time the band produced sound the OS spun up a second stream and
   * hiccuped the music (once, right as David's arc began). Falls back to Phaser's
   * context if the SFX one isn't up yet (it is — unlocked on the same tap).
   *
   * @returns {void}
   */
  _startMusic() {
    if (this._musicWanted) return;
    this._musicWanted = true;
    const ctx = sfx.context || this.sound?.context;
    const buffer = this.cache.audio.get('titleMusic');
    if (!ctx || !buffer?.duration) {
      // No decoded Web Audio buffer (rare): fall back to Phaser's looping sound.
      this._fallbackMusic = this.sound.add('titleMusic', { loop: true, volume: 0.5 });
      this._fallbackMusic.play();
      return;
    }
    const { start, end } = this._musicLoopBounds(buffer);
    // Start only once the context is actually 'running'. Don't hinge on a single
    // resume() promise: on mobile the unlocking tap may not flip the context to
    // running until a later event (a pointerup, or a focus). The statechange
    // listener fires begin() whenever that finally happens — so the music starts
    // as soon as the context is live, no matter which interaction unlocked it.
    const play = () => {
      if (!this._musicWanted || this._musicSrc) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end; // trim trailing silence -> gapless repeat
      const gain = ctx.createGain();
      gain.gain.value = 0.5;
      src.connect(gain).connect(ctx.destination);
      src.start(ctx.currentTime, start); // now, from the loop start
      this._musicSrc = src;
      this._musicGain = gain;
    };
    const begin = () => {
      if (!this._musicWanted || this._musicSrc || ctx.state !== 'running') return;
      ctx.removeEventListener('statechange', begin); // committing now
      // Warm the band's DSP path first, BEFORE the music, so the first arc's
      // stretch doesn't pay the one-time init cost (the click). Start the music
      // only once that warm has finished playing (primeBand's callback) — not on a
      // guessed delay. If it can't/needn't warm, start the music now.
      if (!sfx.primeBand(play)) play();
    };
    this._musicCtx = ctx; // kept so _stopMusic can detach the listener
    this._onMusicState = begin;
    ctx.addEventListener('statechange', begin);
    ctx.resume?.().catch(() => {});
    begin(); // in case it's already running (desktop)
  }

  /** Stop and release the title music (either playback path). @returns {void} */
  _stopMusic() {
    this._musicWanted = false;
    if (this._musicCtx && this._onMusicState) {
      this._musicCtx.removeEventListener('statechange', this._onMusicState);
    }
    this._musicCtx = null;
    this._onMusicState = null;
    if (this._musicSrc) {
      try {
        this._musicSrc.stop();
      } catch {
        // Already stopped; ignore.
      }
      this._musicSrc.disconnect();
      this._musicSrc = null;
    }
    this._musicGain?.disconnect();
    this._musicGain = null;
    this._fallbackMusic?.stop();
    this._fallbackMusic?.destroy();
    this._fallbackMusic = null;
  }

  /**
   * The [start, end] seconds of actual sound in `buffer`, so the loop skips the
   * MP3's silent padding — the browser's decodeAudioData ignores gapless tags, so
   * the decoded buffer carries ~11ms of leading encoder ramp and ~0.38s of
   * trailing silence that would otherwise be a gap at every loop. Scans in from
   * each end for the first sample above a low threshold, so it stays correct if
   * the track is swapped.
   *
   * The bounds are the EXACT content edges — no safety margin. A margin here does
   * the opposite of helping: pushing `end` past the last sound (or `start` before
   * the first) re-includes silence and is exactly what made the loop audible. The
   * content-edge seam is continuous anyway (measured amplitude jump ~0.007), so
   * there's no click to guard against.
   *
   * @param {AudioBuffer} buffer
   * @returns {{start:number, end:number}}
   */
  _musicLoopBounds(buffer) {
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const thresh = 0.003; // ~ -50 dB: quieter than this reads as silence
    let end = data.length - 1;
    while (end > 0 && Math.abs(data[end]) < thresh) end--;
    let head = 0;
    while (head < data.length && Math.abs(data[head]) < thresh) head++;
    return { start: head / rate, end: (end + 1) / rate };
  }

  // --- Per-frame + resize -------------------------------------------------

  /** @returns {void} */
  update() {
    if (!this._ready) return;
    // Glue each brother's face + feature to its (tweened) body position (both,
    // regardless of role) and draw the band between them (order-independent).
    this.david.update();
    this.ken.update();
    drawBand(this.band, this.david.go.x, this.david.go.y, this.ken.go.x, this.ken.go.y);
    // The glow marks the mover, so it tracks whichever brother is the launcher.
    if (this.glow.visible) this.glow.setPosition(this.launcher.go.x, this.launcher.go.y);

    // Keep the name labels sitting just under their (possibly moving) entities,
    // plus each label's `drop` (see _buildDemo) to clear the glow / goal rings.
    for (const { txt, of, drop } of this._labels) {
      const c = of.go ?? of.def; // brother has a `go`; the goal is placed via `def`
      const r = of.go ? of.go.radius : this.goal.radius;
      const extra = of === this.goal ? this._goalExtraDrop : 0;
      txt.setPosition(c.x, c.y + r + 8 + drop + extra);
    }
  }

  /** @returns {void} */
  _onResize() {
    // Guarded: runs inside Phaser's resize step, so an unhandled throw here kills
    // the render loop (the screen goes dark). Log it and carry on instead. The
    // demo runs in fixed local coordinates, so a resize just re-fits its container
    // (_layoutDemo, via _layoutStatic) — no restart, no thrash.
    try {
      this._layoutStatic();
    } catch (e) {
      diag.error('title resize', e);
    }
  }
}
