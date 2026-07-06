import { Config } from '../config.js';
import { sfx } from '../Sfx.js';

/**
 * A small labelled "chip" button: text on a coloured background with a hover
 * colour swap, a click tick, and a handler. Shared by the overlays' chrome (the
 * close × and Back) and the Lab panel's steppers. Returned so the caller can
 * re-depth / reposition / group / destroy it (the default depth is 21).
 *
 * @param {Phaser.Scene} scene
 * @param {number} x @param {number} y @param {string} label @param {() => void} onClick
 * @param {{bg?:string, bgHover?:string, guard?:((p:Phaser.Input.Pointer)=>boolean)|null}} [opts]
 *   `guard` is passed the release pointer; returning true skips the tap, so a
 *   scroll-drag that ends over the control doesn't also trigger it.
 * @returns {Phaser.GameObjects.Text}
 */
export function chipButton(scene, x, y, label, onClick, { bg = '#444444', bgHover = '#666666', guard = null } = {}) {
  const btn = scene.add
    .text(x, y, label, { ...Config.ui.type.control, backgroundColor: bg, padding: { x: 8, y: 2 } })
    .setOrigin(0.5, 0.5)
    .setDepth(21)
    .setInteractive({ useHandCursor: true });
  btn.on('pointerover', () => btn.setBackgroundColor(bgHover));
  btn.on('pointerout', () => btn.setBackgroundColor(bg));
  btn.on('pointerup', (pointer) => {
    if (guard && guard(pointer)) return; // release ended a scroll-drag, not a tap
    sfx.tick();
    onClick();
  });
  return btn;
}
