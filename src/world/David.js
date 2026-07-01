import { Config } from '../config.js';
import { FACES } from '../faces.js';
import { Brother } from './Brother.js';

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
    g.lineStyle(2, 0x000000, 1);
    g.strokeRoundedRect(-12.5, -4, 11, 7, 2); // left lens
    g.strokeRoundedRect(1.5, -4, 11, 7, 2); // right lens
    g.lineBetween(-1.5, -0.5, 1.5, -0.5); // bridge
    return g;
  }

  _updateFeature() {
    this.feature.setPosition(this.go.x, this.go.y - 7);
    this.feature.setVisible(this.face.text !== FACES.win);
  }
}
