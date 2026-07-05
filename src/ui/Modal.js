import { Config } from '../config.js';
import { sfx } from '../Sfx.js';
import { Overlay } from './Overlay.js';

/**
 * A centred, blocking dialog: a dimming backdrop, a rounded card with a title, an
 * optional word-wrapped (scrollable) body, and a row of buttons. Auto-sizes to
 * its content, capped to the viewport; if the body overflows it scrolls so the
 * buttons are never pushed off. Depths 40-42 sit ABOVE the menu (30-33), so a
 * modal opened over the menu is never overdrawn.
 *
 * Use the {@link Modal.info} / {@link Modal.confirm} factories rather than the
 * constructor.
 */
export class Modal extends Overlay {
  /**
   * @param {Phaser.Scene} scene
   * @param {{title:string, subtitle?:string, body?:string, nowrap?:boolean, warn?:boolean,
   *   buttons:Array<{label:string, bg:string, onClick:(btn:Phaser.GameObjects.Text)=>void}>}} spec
   *   `subtitle` is a fixed line under the title (outside the scroll body).
   *   `nowrap` makes the body a left-aligned log that scrolls horizontally instead
   *   of wrapping.
   */
  constructor(scene, spec) {
    super(scene, { depth: 42 });
    this.spec = spec;
  }

  /**
   * An informational modal: word-wrapped body and a single "OK" that dismisses,
   * then runs `onOk`. No warning bonk (the control that opened it already ticked).
   *
   * @param {Phaser.Scene} scene @param {string} title @param {string} body
   * @param {() => void} [onOk] @returns {Modal}
   */
  static info(scene, title, body, onOk) {
    const m = new Modal(scene, {
      title,
      body,
      warn: false,
      buttons: [
        {
          label: 'OK',
          bg: '#3a3a44',
          onClick: () => {
            m.hide();
            onOk?.();
          },
        },
      ],
    });
    return m.show();
  }

  /**
   * A Yes/No confirmation: `Yes` dismisses then runs `onYes`; `No` just dismisses.
   *
   * @param {Phaser.Scene} scene @param {string} message @param {() => void} onYes
   * @returns {Modal}
   */
  static confirm(scene, message, onYes) {
    const m = new Modal(scene, {
      title: message,
      buttons: [
        {
          label: 'Yes',
          bg: '#2e7d46',
          onClick: () => {
            m.hide();
            onYes?.();
          },
        },
        { label: 'No', bg: '#555560', onClick: () => m.hide() },
      ],
    });
    return m.show();
  }

  /** @override — a warning bonk (unless info-only) before the normal open. */
  show() {
    if (this.open) return this;
    if (this.spec.warn !== false) sfx.bonk();
    return super.show();
  }

  /** @override */
  _build(animate) {
    const { title, subtitle = '', body = '', buttons, nowrap = false } = this.spec;
    const U = Config.ui;
    const L = this.scene._layout;
    const add = this.scene.add;
    const cx = L.w / 2;
    const cy = L.h / 2;
    const pad = U.space.lg;
    // Confirms stay narrow (a short question); a body-text modal (Help/About/the
    // report) may grow wider on a wide screen so it isn't a tall, narrow column —
    // still capped so prose lines don't get uncomfortably long to read.
    const pw = Math.min(body ? 640 : 440, L.w - 2 * L.pad);
    const innerW = pw - 2 * pad;
    const closeReserve = 48; // keep the (centred) title/subtitle clear of the top-right ×

    // Build the text first so we can measure it and size the card to fit. Title
    // and the optional subtitle stay centred (wrapping a little narrower so a long
    // one can't tuck under the ×). A `nowrap` body (e.g. a log) is left-aligned
    // and scrolls horizontally; otherwise the body is centred prose that wraps.
    const titleTxt = add
      .text(cx, 0, title, {
        fontSize: '24px',
        color: U.color.text,
        fontStyle: 'bold',
        align: 'center',
        wordWrap: { width: innerW - closeReserve },
      })
      .setOrigin(0.5, 0)
      .setDepth(42);
    let subtitleTxt = null;
    if (subtitle) {
      subtitleTxt = add
        .text(cx, 0, subtitle, { ...U.type.body, color: U.color.textMuted, align: 'center', wordWrap: { width: innerW - closeReserve } })
        .setOrigin(0.5, 0)
        .setDepth(42);
    }
    let bodyTxt = null;
    if (body) {
      const style = nowrap
        ? { ...U.type.body, align: 'left', lineSpacing: 5 }
        : { ...U.type.body, align: 'left', lineSpacing: 5, wordWrap: { width: innerW } };
      bodyTxt = add.text(0, 0, body, style).setOrigin(nowrap ? 0 : 0.5, 0).setDepth(42);
    }

    const btnH = 44;
    const maxPh = L.h - 2 * L.pad;
    const subBlock = subtitleTxt ? U.space.sm + subtitleTxt.height : 0;
    // The title/subtitle and buttons are pinned; the body lives in a fixed region
    // between them. If the body fits under the remaining height, the card shrinks
    // to it (no scroll); otherwise the card caps at the screen and the body scrolls.
    const chromeH = pad + titleTxt.height + subBlock + (bodyTxt ? U.space.md : 0) + U.space.lg + btnH + pad;
    const fullBodyH = bodyTxt ? bodyTxt.height : 0;
    const bodyViewH = bodyTxt ? Math.max(0, Math.min(fullBodyH, maxPh - chromeH)) : 0;
    const ph = chromeH + bodyViewH;

    const backdrop = this._backdrop(0.82, 40);
    const panel = add.graphics().setDepth(41);
    panel.fillStyle(U.color.surface, 1).fillRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, U.radius.card);
    panel.lineStyle(2, U.color.surfaceStroke, 1).strokeRoundedRect(cx - pw / 2, cy - ph / 2, pw, ph, U.radius.card);

    const top = cy - ph / 2 + pad;
    titleTxt.setPosition(cx, top);
    if (subtitleTxt) subtitleTxt.setPosition(cx, top + titleTxt.height + U.space.sm);
    // Top-right × (cancel: on a Yes/No confirm it's the "No"/dismiss path).
    const close = this._closeButton(cx + pw / 2 - 20, cy - ph / 2 + 22, 42);
    this.parts = [backdrop, panel, titleTxt, close];
    if (subtitleTxt) this.parts.push(subtitleTxt);

    if (bodyTxt) {
      const bodyTop = top + titleTxt.height + subBlock + U.space.md;
      const innerLeft = cx - pw / 2 + pad;
      // Local (container) coords: top-left for a left-aligned log, else centred.
      bodyTxt.setPosition(nowrap ? 0 : innerW / 2, 0);
      this.scrollView.add(bodyTxt);
      this.scrollView.layout({ x: innerLeft, y: bodyTop, w: innerW, h: bodyViewH }, fullBodyH, nowrap ? bodyTxt.width : innerW);
    } else {
      this.scrollView.layout({ x: 0, y: 0, w: 0, h: 0 }, 0); // nothing to scroll
    }

    const btnObjs = this._layoutButtons(cx, cy + ph / 2 - pad - btnH / 2, buttons);
    this.parts.push(...btnObjs);

    this.scene.cameras.main.ignore(this.parts); // HUD camera only
    this._fadeIn(animate);
  }

  /**
   * Create the buttons and centre them as a row at `y`.
   *
   * @param {number} cx @param {number} y
   * @param {Array<{label:string, bg:string, onClick:(btn:Phaser.GameObjects.Text)=>void}>} buttons
   * @returns {Phaser.GameObjects.Text[]}
   */
  _layoutButtons(cx, y, buttons) {
    const gap = Config.ui.space.lg;
    const objs = buttons.map((b) => this._button(0, y, b.label, b.bg, b.onClick));
    const total = objs.reduce((s, o) => s + o.width, 0) + gap * (objs.length - 1);
    let x = cx - total / 2;
    objs.forEach((o) => {
      o.setPosition(x + o.width / 2, y);
      x += o.width + gap;
    });
    return objs;
  }

  /**
   * A pill button: rounded text with a hover lift, a click sound, and a handler.
   *
   * @param {number} x @param {number} y @param {string} label
   * @param {string} bg  CSS background colour.
   * @param {(btn:Phaser.GameObjects.Text)=>void} onClick  Receives the button, so
   *   a handler that stays open (e.g. "Copy") can update its own label.
   * @returns {Phaser.GameObjects.Text}
   */
  _button(x, y, label, bg, onClick) {
    const btn = this.scene.add
      .text(x, y, label, { fontSize: '20px', color: '#ffffff', backgroundColor: bg, padding: { x: 24, y: 8 } })
      .setOrigin(0.5)
      .setDepth(42)
      .setInteractive({ useHandCursor: true });
    btn.on('pointerover', () => btn.setAlpha(0.85));
    btn.on('pointerout', () => btn.setAlpha(1));
    btn.on('pointerup', () => {
      sfx.tick();
      onClick(btn);
    });
    return btn;
  }
}
