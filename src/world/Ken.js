import { Brother } from './Brother.js';

/**
 * Ken: the red brother, the baseline size (radius/mass multipliers default to
 * 1), who sports a mustache above his mouth on every expression.
 */
export class Ken extends Brother {
  get _fillColor() {
    return 0xff5a4d;
  }
  get _cssColor() {
    return '#ff5a4d';
  }
  get _defaultName() {
    return 'Ken';
  }

  /**
   * Two black lobes meeting at the centre, drawn around their own origin so
   * {@link _updateFeature} can sit them above his mouth.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createFeature() {
    const g = this.scene.add.graphics().setDepth(7);
    g.fillStyle(0x000000, 1);
    g.fillEllipse(-5, 0, 10, 3); // left half
    g.fillEllipse(5, 0, 10, 3); // right half
    return g;
  }

  _updateFeature() {
    this.feature.setPosition(this.go.x, this.go.y + 1);
  }
}
