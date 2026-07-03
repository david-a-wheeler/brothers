import { Config } from '../config.js';
import { FACES } from '../faces.js';
import { sfx } from '../Sfx.js';
import { setSkipTitle } from '../prefs.js';
import { David } from '../world/David.js';
import { Ken } from '../world/Ken.js';
import { Goal } from '../world/Goal.js';
import { drawBand, pulsingGlow } from '../world/effects.js';

/**
 * The intro / title screen: an arced "Brothers" wordmark with a gold shimmer,
 * the premise, a looping scripted demo of a shot reaching the goal, and a Play
 * button — over looping music.
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

    this._buildBackground();
    this._buildTitle();
    this._buildPremise();
    this._buildDemo();
    this._buildPlayButton();
    this._buildHint();

    this._layoutStatic();
    this._startDemo();

    this._wireAudio();

    // When the game loses focus the music pauses (Phaser's pauseOnBlur), so
    // silence the elastic-band sound too and keep it muted until focus returns —
    // otherwise the stretch sound plays on without the music. The demo's band
    // calls check `_audioPaused` (see _demoSteps). A hidden tab is already handled
    // by main.js (sfx.suspend() + sleeping the game loop).
    const onBlur = () => {
      this._audioPaused = true;
      sfx.stopBand();
    };
    const onFocus = () => {
      this._audioPaused = false;
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
      .text(0, 0, 'Help the brothers, David and Ken, reach the goal\nin as few turns as possible.', {
        fontFamily: 'system-ui, sans-serif',
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
      this._playText.setScale(1);
      this._drawPlayButton();
    });
    this._playHit.on('pointerdown', () => this._playText.setScale(0.96));
    // On pressup: remember the choice, silence the music, enter the game.
    this._playHit.on('pointerup', () => {
      this._playText.setScale(1);
      sfx.tick();
      setSkipTitle(true);
      this._stopMusic();
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
    // is going (see _wireAudio).
    this._hint = this.add
      .text(0, 0, '🔊 tap for sound', {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#9aa0a6',
      })
      .setOrigin(0.5)
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

    // Play pill, sized to its label.
    this._playText.setFontSize(Phaser.Math.Clamp(Math.round(W / 26), 22, 32));
    this._playText.setPosition(cx, H * 0.88);
    this._playBox = {
      x: cx,
      y: H * 0.88,
      w: this._playText.width + 72,
      h: this._playText.height + 30,
    };
    this._drawPlayButton();
    this._playHit.setPosition(this._playBox.x, this._playBox.y).setSize(this._playBox.w, this._playBox.h);

    this._hint.setPosition(cx, H * 0.955);
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
    /** Pulsing "this one moves" halo on the selected brother (David). */
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
    // When Ken settles into the goal, the Ken and Goal labels line up horizontally.
    // The goal's label already sits (goalR - kenR) lower; drop it enough further
    // that its top clears the bottom of Ken's label, plus a small gap.
    const goalExtra = Math.max(0, kenLbl.height + 6 - (this.goal.radius - Config.ball.radius));
    this._labels = [
      { txt: davidLbl, of: this.david, drop },
      { txt: kenLbl, of: this.ken, drop },
      { txt: goalLbl, of: this.goal, drop: drop + goalExtra },
    ];

    // Everything that fades out during the blank between loops.
    this._faders = [
      this.david.go, this.david.face, this.david.feature,
      this.ken.go, this.ken.face, this.ken.feature,
      this.goal.gfx, this.goal.reticle,
      ...this._labels.map((l) => l.txt),
    ];
  }

  /**
   * @param {string} text
   * @returns {Phaser.GameObjects.Text}
   */
  _nameLabel(text) {
    return this.add
      .text(0, 0, text, {
        fontFamily: 'system-ui, sans-serif',
        fontSize: '15px',
        color: '#ffffff',
        backgroundColor: '#000000cc',
        padding: { x: 6, y: 3 },
      })
      .setOrigin(0.5, 0)
      .setDepth(9);
  }

  /**
   * The demo's key positions for the current window size. All in world space
   * (the actors aren't parented to a scaled container, so the goal's win ring —
   * spawned in world space — stays aligned).
   *
   * @returns {{demoY:number, davidX:number, kenX:number, goalX:number, pullX:number, arcY:number}}
   */
  _computeGeo() {
    const W = this.scale.width;
    const H = this.scale.height;
    const gap = Config.tether.restLength; // the usual starting distance between them
    const kenX = W * 0.4;
    const davidX = kenX - gap; // David is furthest left
    const goalX = Math.min(W * 0.8, W - this.goal.radius - 24);
    const pullX = Math.max(davidX - 170, this.david.go.radius + 24); // stay on-screen
    const demoY = H * 0.6;
    return { demoY, davidX, kenX, goalX, pullX, arcY: demoY - 90 };
  }

  /**
   * Reset the actors to the start pose for `geo`: positions, idle faces, full
   * opacity, glow shown on David.
   *
   * @param {ReturnType<TitleScene['_computeGeo']>} geo
   * @returns {void}
   */
  _resetDemo(geo) {
    this.david.go.setPosition(geo.davidX, geo.demoY);
    this.ken.go.setPosition(geo.kenX, geo.demoY);
    this._placeGoal(geo.goalX, geo.demoY);

    this.david.setFace(FACES.idle.launcher);
    this.ken.setFace(FACES.idle.anchor);
    this.david.update(); // glue face + glasses to the new spot at once
    this.ken.update();

    for (const o of this._faders) o.setAlpha(1);
    this.band.setAlpha(1);

    this.tweens.killTweensOf(this.goal.gfx);
    this.goal.gfx.setScale(1);

    this.glow.radius = this.david.go.radius + 8;
    this.glow.setPosition(this.david.go.x, this.david.go.y).setVisible(true);
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
      this._blankTimer = this.time.delayedCall(2000, () => this._startDemo());
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
    const ctrlX = (geo.davidX + geo.pullX) / 2;
    const gap = Config.tether.restLength; // final resting separation (rest length)
    // Centre-to-centre distance at which the two circles just touch. David stops
    // here on impact and the pair never closes nearer than this while travelling
    // (gap > contact, so the linearly-interpolated separation stays >= contact).
    const contact = this.david.go.radius + this.ken.go.radius;
    return [
      // Hold on the opening pose so the player can read it.
      { duration: 5000 },
      // Pull back, arcing up then down to Ken's height (shows up/down + left).
      {
        duration: 3200,
        ease: 'Sine.InOut',
        onStart: () => {
          this.david.setFace(FACES.drag.launcher);
          this.ken.setFace(FACES.drag.anchor);
          if (!this._audioPaused) sfx.startBand();
        },
        onUpdate: (t) => {
          this.david.go.setPosition(
            qbez(geo.davidX, ctrlX, geo.pullX, t),
            qbez(geo.demoY, geo.arcY, geo.demoY, t)
          );
          if (!this._audioPaused) sfx.updateBand(t);
        },
      },
      // Beat at full stretch.
      { duration: 500 },
      // Release: straight (horizontal) into Ken.
      {
        duration: 360,
        ease: 'Quad.In',
        onStart: () => {
          sfx.stopBand();
          this.david.setFace(FACES.flight.launcher);
          this.ken.setFace(FACES.flight.anchor);
          this.glow.setVisible(false);
          this.glow.getData('pulse')?.pause();
        },
        // Fly in from the left and stop the instant he touches Ken (never over him).
        onUpdate: (t) => this.david.go.setPosition(lerp(geo.pullX, geo.kenX - contact, t), geo.demoY),
      },
      // Impact flash.
      {
        duration: 160,
        onStart: () => {
          this.david.setFace(FACES.collision);
          this.ken.setFace(FACES.collision);
        },
      },
      // The elastic band carries the pair to the goal, settling `gap` apart.
      {
        duration: 1300,
        ease: 'Quad.Out',
        onStart: () => {
          this.david.setFace(FACES.flight.launcher);
          this.ken.setFace(FACES.flight.anchor);
        },
        // Ken leads to the goal; David trails from the contact point out to the
        // rest length, so their separation only ever grows (contact -> gap).
        onUpdate: (t) => {
          this.ken.go.setPosition(lerp(geo.kenX, geo.goalX, t), geo.demoY);
          this.david.go.setPosition(lerp(geo.kenX - contact, geo.goalX - gap, t), geo.demoY);
        },
        onComplete: () => {
          this.goal.celebrate(); // win pop, but NO win sound (music owns the audio)
          this.david.setFace(FACES.win);
          this.ken.setFace(FACES.win);
        },
      },
      // Bask in the win.
      { duration: 5000 },
      // Fade the whole demo out.
      {
        duration: 600,
        onUpdate: (t) => {
          const a = 1 - t;
          for (const o of this._faders) o.setAlpha(a);
          this.band.setAlpha(a);
        },
      },
    ];
  }

  /**
   * Halt the running demo (active phase tween + pending loop timer + any held
   * band sound) so it can be restarted against fresh geometry (resize) or torn
   * down (shutdown). Removing the active tween skips its onComplete, so the
   * phase recursion stops here.
   *
   * @returns {void}
   */
  _stopDemo() {
    this._active?.remove();
    this._active = null;
    this._blankTimer?.remove();
    this._blankTimer = null;
    sfx.stopBand();
  }

  // --- Audio --------------------------------------------------------------

  /** @returns {void} */
  _wireAudio() {
    // The first pointer gesture unlocks both audio paths (procedural SFX + the
    // music) and starts the loop, then retires the "tap for sound" hint. A
    // DOM-level listener catches the press even over the Play button (which
    // stops Phaser propagation).
    const canvas = this.game.canvas;
    const start = () => {
      sfx.unlock();
      this._startMusic();
      if (this._hint?.active) {
        this.tweens.add({
          targets: this._hint,
          alpha: 0,
          duration: 400,
          onComplete: () => this._hint?.destroy(),
        });
      }
      canvas.removeEventListener('pointerdown', start);
    };
    canvas.addEventListener('pointerdown', start);
    this.events.once('shutdown', () => canvas.removeEventListener('pointerdown', start));
  }

  /**
   * Start the looping title music. Driven directly off the decoded Web Audio
   * buffer (not a Phaser Sound) so the loop can skip the file's silent padding:
   * a single AudioBufferSourceNode with `loop = true` repeats seamlessly in the
   * audio thread, and trimming `loopStart`/`loopEnd` to the actual sound removes
   * the ~0.4s gap this "loopable" mp3 carries at its tail. Idempotent.
   *
   * @returns {void}
   */
  _startMusic() {
    if (this._musicWanted) return;
    this._musicWanted = true;
    const ctx = this.sound?.context;
    const buffer = this.cache.audio.get('titleMusic');
    if (ctx && buffer?.duration) {
      const { start, end } = this._musicLoopBounds(buffer);
      const begin = () => {
        if (!this._musicWanted || this._musicSrc) return; // stopped/started meanwhile
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.loopStart = start;
        src.loopEnd = end; // trim trailing silence -> gapless repeat
        const gain = ctx.createGain();
        gain.gain.value = 0.5;
        src.connect(gain).connect(ctx.destination);
        src.start(0, start);
        this._musicSrc = src;
        this._musicGain = gain;
      };
      // In a gesture, but the context may still be resuming from locked.
      if (ctx.state === 'suspended') ctx.resume().then(begin);
      else begin();
    } else {
      // No decoded Web Audio buffer (rare): fall back to Phaser's looping sound.
      this._fallbackMusic = this.sound.add('titleMusic', { loop: true, volume: 0.5 });
      this._fallbackMusic.play();
    }
  }

  /** Stop and release the title music (either playback path). @returns {void} */
  _stopMusic() {
    this._musicWanted = false;
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
    // Glue each brother's face + feature to its (tweened) body position.
    this.david.update();
    this.ken.update();
    drawBand(this.band, this.david.go.x, this.david.go.y, this.ken.go.x, this.ken.go.y);
    if (this.glow.visible) this.glow.setPosition(this.david.go.x, this.david.go.y);

    // Keep the name labels sitting just under their (possibly moving) entities,
    // plus each label's `drop` (see _buildDemo) to clear the glow / goal rings.
    for (const { txt, of, drop } of this._labels) {
      const c = of.go ?? of.def; // brother has a `go`; the goal is placed via `def`
      const r = of.go ? of.go.radius : this.goal.radius;
      txt.setPosition(c.x, c.y + r + 8 + drop);
    }
  }

  /** @returns {void} */
  _onResize() {
    this._layoutStatic();
    // Debounce: a drag-resize fires many events; restart the demo once it settles.
    this._resizeTimer?.remove();
    this._resizeTimer = this.time.delayedCall(120, () => {
      this._stopDemo();
      this._startDemo();
    });
  }
}
