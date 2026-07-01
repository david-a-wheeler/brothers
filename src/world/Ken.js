import { Brother } from './Brother.js';

/**
 * Ken: the red brother, the baseline size (radius/mass multipliers default to
 * 1), who sports a small chin beard on every expression.
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
   * A small chin beard (goatee) — a soft downward tuft drawn around its own
   * origin so {@link _updateFeature} can sit it at the bottom of his face. Kept
   * low so it doesn't hide his eyes or mouth the way the old mustache did.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  _createFeature() {
    const g = this.scene.add.graphics().setDepth(7);
    g.fillStyle(0x000000, 1);
    g.fillTriangle(-5, -4, 5, -4, 0, 6); // downward tuft at the chin
    return g;
  }

  _updateFeature() {
    this.feature.setPosition(this.go.x, this.go.y + 12); // bottom of the face
  }
}
