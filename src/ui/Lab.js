import { Config, applyRubberBandDefaults } from '../config.js';
import { setLabOpen } from '../prefs.js';
import * as diag from '../diag.js';
import { Panel } from './Panel.js';
import { chipButton } from './chipButton.js';

/**
 * The modeless Lab tuning panel: rows of -/+ steppers for the slingshot and
 * tether parameters, edited live. Mutating these Config values takes effect
 * immediately — the slingshot reads Config per shot, and the tether is
 * re-synced from Config each frame (see Brothers._applyPullOnlyTether). Values
 * persist across restarts (Config is a module object) but reset on a full page
 * reload, which is the point: find good numbers, then bake them in.
 *
 * Owns the {@link Panel} shell, the parameter descriptors, and the row edit
 * logic. Gameplay effects stay the scene's job: the "More turns" button calls
 * back into {@link import('../scenes/GameScene.js').GameScene#_moreTurns}.
 *
 * Only the Panel object is made at construction (during the scene's create);
 * its display objects are built lazily on show() so they land after the UI
 * camera's ignore snapshot.
 */
export class Lab {
  /**
   * @param {import('../scenes/GameScene.js').GameScene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Rows come in two kinds. A *number* row steps by `step` (clamped to
    // min/max) and its value can be typed directly. An *options* row cycles a
    // fixed list, so a boolean is just the list [false, true].
    //
    // `obj` is either the object holding `key`, or a function returning it, for
    // targets that don't exist yet or are replaced on every scene restart (the
    // brothers) — the row re-resolves it on each read and shows "--" when it's
    // missing. `onChange` applies a value that isn't picked up automatically.
    this._sections = [
      {
        heading: 'Slingshot & tether',
        params: [
          { obj: Config.slingshot, key: 'maxSpeed', step: 10, dp: 0, min: 0, desc: 'Launch speed at a full-strength pull.' },
          { obj: Config.slingshot, key: 'minSpeed', step: 5, dp: 0, min: 0, desc: 'Launch-speed floor for the shortest valid pull.' },
          { obj: Config.slingshot, key: 'curve', step: 0.1, dp: 2, min: 0.1, desc: 'Easing exponent; higher softens short/mid pulls (ends fixed).' },
          { obj: Config.slingshot, key: 'maxPull', step: 10, dp: 0, min: 10, desc: 'Furthest the launcher can be stretched from the anchor.' },
          { obj: Config.slingshot, key: 'minPull', step: 2, dp: 0, min: 0, desc: 'Pulls shorter than this count as a mis-click, not a launch.' },
          { obj: Config.tether, key: 'restLength', step: 5, dp: 0, min: 0, desc: 'Tether resting length; beyond it the band pulls them together.' },
          { obj: Config.tether, key: 'stiffness', step: 0.005, dp: 3, min: 0, desc: 'Tether spring strength once stretched past rest length.' },
          { obj: Config.tether, key: 'damping', step: 0.02, dp: 2, min: 0, desc: 'How quickly tether oscillations settle.' },
        ],
      },
      {
        heading: 'Brothers',
        params: [
          { obj: Config.ball, key: 'davidRadiusMult', label: 'David size', step: 0.01, dp: 2, min: 1, max: 2, desc: "David's radius as a multiple of Ken's (1.00-2.00)." },
          { obj: Config.ball, key: 'davidMassMult', label: 'David mass', step: 0.01, dp: 2, min: 1, max: 3, desc: "David's mass as a multiple of Ken's (1.00-3.00)." },
          this._mudTurnsParam('David', () => scene.brothers?.david),
          this._mudTurnsParam('Ken', () => scene.brothers?.ken),
        ],
      },
      {
        heading: 'Level',
        params: [
          {
            obj: () => scene.level,
            key: 'pinEnabled',
            label: 'Pin moving',
            options: [false, true],
            format: (v) => (v ? 'allowed' : 'off'),
            desc: 'Whether the player may drag the anchor\'s aiming pin off-centre.',
            // Turning it off mid-aim would strand an already-placed pin off-centre.
            onChange: (level) => {
              if (!level.pinEnabled) scene.brothers?._resetAnchorPin();
            },
          },
          {
            obj: () => scene.level,
            key: 'pinResetOn',
            label: 'Pin resets on',
            options: ['impact', 'settle'],
            format: (v) => v,
            desc: 'When a placed pin recentres: at impact (aim-only) or once the balls settle (live off-centre tether).',
          },
        ],
      },
    ];

    /** @type {{param: object, value: Phaser.GameObjects.Text}[]} */
    this._rows = [];
    this.panel = new Panel(scene, {
      position: () => ({ x: 12, y: scene._hudHeight + 10 }),
      width: 280, // roomy enough that a param's tooltip wraps to ~2 tidy lines
      title: 'Lab tuning',
      build: (view) => this._buildBody(view),
    });
    // Closing (via the × or the menu toggle) clears the persisted-open flag.
    this.panel.onHidden = () => setLabOpen(false);
  }

  /** @returns {boolean} true while the panel is showing. */
  get open() {
    return this.panel.open;
  }

  /**
   * Show the panel without touching the persisted-open flag — the restore path
   * for a flag that's already set (see the scene's create).
   *
   * @returns {void}
   */
  show() {
    this.panel.show();
  }

  /**
   * Show/hide the panel (toggled by the Lab control in the menu, or its own ×).
   * The persisted-open flag is set here on open and cleared by the panel's
   * `onHidden` on close (see the constructor), so the × path clears it too.
   *
   * @returns {void}
   */
  toggle() {
    if (this.panel.open) {
      this.panel.hide();
    } else {
      this.panel.show();
      setLabOpen(true); // survive scene restarts and reloads
    }
  }

  /**
   * Keep the panel fitted to the (possibly resized) screen by rebuilding it in
   * place: re-anchors it below the ribbon and re-fits its scroll viewport to
   * the new height. No-op when closed. Runs on every resize (via the scene's
   * _layoutHud).
   *
   * @returns {void}
   */
  rebuild() {
    this.panel.rebuild();
  }

  /**
   * Refresh the rows from live state. Rows showing values the *game* moves (a
   * brother's mud turns count down at each settle) would otherwise go stale
   * while the panel sits open, so this runs with the HUD refresh. No-op when
   * closed.
   *
   * @returns {void}
   */
  refreshRows() {
    if (!this.panel.open) return;
    this._rows.forEach((r) => this._setRowText(r));
  }

  /**
   * Build the "turns left being muddy" row for one brother. The brother is
   * resolved lazily because a scene restart replaces the entity, and the panel
   * outlives it. Writes go through {@link Movable#setMudTurns}, which keeps the
   * splat and the friction consistent with the number.
   *
   * @param {string} name  'David' or 'Ken', for the row label.
   * @param {() => (import('../world/Brother.js').Brother|undefined)} get
   * @returns {object} A param descriptor.
   */
  _mudTurnsParam(name, get) {
    return {
      obj: get,
      key: 'mudTurnsLeft',
      label: `${name} mud turns`,
      step: 1,
      dp: 0,
      min: 0,
      max: 9,
      desc: `Settles of mud left on ${name}. Raise it to muddy him now; drop it to 0 to wash the (non-sticky) mud off.`,
      onChange: (b) => b.setMudTurns(b.mudTurnsLeft),
    };
  }

  /**
   * Resolve a param's target object. Rows bound to a function (the brothers,
   * the level) re-resolve on every read, so they survive a scene restart; the
   * target can legitimately be absent before the world is built.
   *
   * @param {{obj: object|(() => object|undefined)}} param
   * @returns {object|undefined}
   */
  _paramTarget(param) {
    return typeof param.obj === 'function' ? param.obj() : param.obj;
  }

  /**
   * Fill the panel's scroll body (local coords: 0,0 = viewport top-left) with
   * a heading per section, its parameter rows, and the More turns / Reset
   * buttons. Called by the {@link Panel} on each (re)build; returns the body's
   * full height.
   *
   * @param {import('./ScrollView.js').ScrollView} view
   * @returns {number}
   */
  _buildBody(view) {
    const scene = this.scene;
    const w = 280;
    const rowH = 30;
    const headingH = 26;
    // A control ignores its tap when the press that ended on it moved far enough
    // to be a scroll-drag (computed from the press/release distance).
    const moved = (p) => this.panel.movedFromPress(p);

    this._rows = [];
    let y = 14; // half a line of headroom, so the first heading isn't clipped
    for (const section of this._sections) {
      const heading = scene.add
        .text(12, y, section.heading, { ...Config.ui.type.small, color: Config.ui.color.accentText })
        .setOrigin(0, 0.5)
        .setDepth(21);
      view.add([heading]);
      y += headingH;

      for (const param of section.params) {
        const minus = chipButton(scene, 24, y, '-', () => this._adjustParam(param, -1), { guard: moved });
        const plus = chipButton(scene, w - 24, y, '+', () => this._adjustParam(param, 1), { guard: moved });
        // Click the value to type one directly (number rows) or advance it
        // (options rows) — prompt works on desktop + mobile.
        const value = scene.add
          .text(44, y, '', Config.ui.type.small)
          .setOrigin(0, 0.5)
          .setDepth(21);
        const row = { param, value };
        this._setRowText(row); // set text before setInteractive so the hit area fits
        value.setInteractive({ useHandCursor: true }).on('pointerup', (pointer) => {
          if (moved(pointer)) return; // release ended a scroll-drag, not a tap
          this._promptParam(param);
        });
        // Explain the parameter on hover/press of any of its controls, via the
        // shared tooltip (anchored below the control, wrapped to ~the panel width).
        for (const ctrl of [minus, value, plus]) {
          scene.tip.attach(ctrl, param.desc, { place: 'anchor', maxWidth: w - 20 });
        }
        view.add([minus, value, plus]);
        this._rows.push(row);
        y += rowH;
      }
    }

    const moreTurnsY = y + 20; // a small gap below the last row
    const resetY = moreTurnsY + 36;
    // "More turns" lets us keep experimenting past a win/loss — a gameplay
    // change, so it's the scene's to make (see GameScene._moreTurns).
    view.add([
      chipButton(scene, w / 2, moreTurnsY, 'More turns', () => scene._moreTurns(), { guard: moved }),
      chipButton(scene, w / 2, resetY, 'Reset parameters', () => this._resetParams(), { guard: moved }),
    ]);

    return resetY + 26; // full height of the scrollable body
  }

  /**
   * Handle a click on a row's value. A number row prompts for a value directly
   * (clamped to its min/max); window.prompt works on desktop and mobile without
   * a DOM input. An options row has nothing to type, so a click just advances it,
   * matching its "+".
   *
   * @param {object} param  A descriptor from the constructor's sections.
   * @returns {void}
   */
  _promptParam(param) {
    if (param.options) {
      this._adjustParam(param, 1);
      return;
    }
    const obj = this._paramTarget(param);
    if (!obj) return; // e.g. a brother row before the world exists
    const label = param.label ?? param.key;
    const input = window.prompt(`Set ${label}`, String(obj[param.key]));
    if (input === null) return; // cancelled
    const v = parseFloat(input);
    if (!Number.isFinite(v)) return; // not a number
    obj[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min, v));
    this._applyParam(param, obj);
  }

  /**
   * Reset the tunable parameters to their defaults (the single source in
   * config.js), then refresh the panel rows.
   *
   * @returns {void}
   */
  _resetParams() {
    applyRubberBandDefaults();
    this._rows.forEach((r) => this._setRowText(r));
    this.scene.brothers?._applyDavidPhysique(); // David's size/mass are among the defaults
  }

  /**
   * Update one row's "label: value" text from the live value. A row whose
   * target doesn't exist yet (no brothers before the world is built) shows "--"
   * rather than blanking or throwing.
   *
   * @param {{param: object, value: Phaser.GameObjects.Text}} row
   * @returns {void}
   */
  _setRowText(row) {
    const { param } = row;
    const label = param.label ?? param.key;
    const obj = this._paramTarget(param);
    if (!obj) {
      row.value.setText(`${label}: --`);
      return;
    }
    const v = obj[param.key];
    row.value.setText(`${label}: ${param.format ? param.format(v) : v.toFixed(param.dp)}`);
  }

  /**
   * Change a parameter by one step: a number row moves by ±`step` (clamped to
   * its min and optional max), an options row advances to the next/previous
   * entry, wrapping. Then apply and refresh.
   *
   * @param {object} param  A descriptor from the constructor's sections.
   * @param {number} dir  -1 or +1.
   * @returns {void}
   */
  _adjustParam(param, dir) {
    const obj = this._paramTarget(param);
    if (!obj) return; // e.g. a brother row before the world exists

    if (param.options) {
      const opts = param.options;
      const at = opts.indexOf(obj[param.key]);
      // An unrecognised current value (hand-edited level prop) lands on the first.
      obj[param.key] = at < 0 ? opts[0] : opts[(at + dir + opts.length) % opts.length];
    } else {
      const raw = obj[param.key] + dir * param.step;
      obj[param.key] = Math.min(param.max ?? Infinity, Math.max(param.min, Number(raw.toFixed(param.dp))));
    }
    this._applyParam(param, obj);
  }

  /**
   * Push a just-edited value into the game and refresh every row (one edit can
   * change another row's display — setting mud turns to 0 washes the mud off).
   *
   * @param {object} param @param {object} obj  The resolved target.
   * @returns {void}
   */
  _applyParam(param, obj) {
    const scene = this.scene;
    // A Lab edit reaches straight into live game state, so it's a prime suspect
    // whenever something goes strange right afterwards. Record the whole world
    // on both sides of the write: the "after" of one edit and the "before" of
    // the next also bracket whatever the *game* did in between.
    const key = param.label ?? param.key;
    const snap = (tag) =>
      diag.trace('lab', `${tag} ${key}`, {
        value: obj[param.key],
        phase: scene.phase,
        status: scene.status,
        ...(scene.brothers ? scene.brothers.snapshot() : {}),
      });

    snap('before');
    param.onChange?.(obj);
    this._rows.forEach((r) => this._setRowText(r));
    scene.brothers?._applyDavidPhysique(); // apply if this was a David size/mass row
    snap('after');
  }
}
