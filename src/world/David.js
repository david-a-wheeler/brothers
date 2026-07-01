import { Config } from '../config.js';
import { FACES } from '../faces.js';
import { Brother } from './Brother.js';

/**
 * Faces whose eyes sit low enough that David's glasses must drop ~3/4 of their
 * height to stay over them: the aim faces (😏 launcher / 😳 anchor, shown grab
 * through drag) and the flight anchor face (😨, David riding along while Ken is
 * the launcher). Other faces keep the glasses at their default spot.
 */
const LOW_EYE_FACES = new Set([FACES.drag.launcher, FACES.drag.anchor, FACES.flight.anchor]);

/**
 * David: the blue brother, bigger by default (his radius/mass multipliers
 * default to the lab-tunable `Config.ball.david*Mult`, unless the level object
 * overrides them). He wears rectangular glasses over his eyes on every
 * expression except the win face (😎), which already has shades.
 */
export class David extends Brother {
  get _fillColor() {
    return 0x3aa0ff;
  }
  get _cssColor() {
    return '#3aa0ff';
  }
  get _defaultName() {
    return 'David';
  }
  get _defaultRadiusMult() {
    return Config.ball.davidRadiusMult;
  }
  get _defaultMassMult() {
    return Config.ball.davidMassMult;
  }

  /**
   * Two black rectangular lens frames joined by a bridge, drawn around their own
   * origin so {@link _updateFeature} can sit them over the eyes. Lenses are open
   * frames, so the emoji's eyes/eyebrows show through.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createFeature() {
    const g = this.scene.add.graphics().setDepth(7);
    // Thin, slightly translucent frames so the eyes/eyebrows read through them
    // (the lenses are open, but heavy black rims still hid his expression).
    g.lineStyle(1, 0x000000, 0.7);
    g.strokeRoundedRect(-12.5, -4, 11, 7, 2); // left lens
    g.strokeRoundedRect(1.5, -4, 11, 7, 2); // right lens
    g.lineBetween(-1.5, -0.5, 1.5, -0.5); // bridge
    return g;
  }

  _updateFeature() {
    // Drop the glasses ~3/4 of their height over the low-eyed faces (see
    // LOW_EYE_FACES); 7 = the lens height, see _createFeature.
    const t = this.face.text;
    this.feature.setPosition(this.go.x, this.go.y - 7 + (LOW_EYE_FACES.has(t) ? 7 * 0.75 : 0));
    this.feature.setVisible(t !== FACES.win);
  }
}
