import { Depth } from '../config.js';
import { Brother } from './Brother.js';

/**
 * Ken: the red brother, the baseline size
 * (radius/mass multipliers default to 1).
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
   * A soft beard: a filled crescent band that follows the lower edge of his
   * face and wraps up the sides, drawn around its own origin so
   * {@link _updateFeature} can centre it on his face. It hugs the jaw rather than
   * covering his mouth/eyes the way the old mustache did.
   *
   * @returns {Phaser.GameObjects.Graphics}
   */
  // _createFeature() {
  //   const g = this.scene.add.graphics().setDepth(Depth.feature);
  //   g.fillStyle(0x000000, 0.85); // near-solid black: strong contrast on red, but not harsh
  //   // A thin crescent centred on his face: the curved bottom follows the face
  //   // edge (so it always connects), and the top edge dips down in the middle so
  //   // the centre is thin and reveals more of the face. `R` ~ the emoji face
  //   // radius; `a` is where it meets the face on each side; `dip` is how far the
  //   // centre of the top drops (larger = thinner centre).
  //   const R = 15;
  //   const a = Phaser.Math.DegToRad(32);
  //   const dip = 12;
  //   g.beginPath();
  //   g.arc(0, 0, R, a, Math.PI - a, false); // curved bottom, along the face edge
  //   g.lineTo(0, dip); // top edge dips down in the centre...
  //   g.closePath(); // ...back up to the far side -> a thin crescent
  //   g.fillPath();
  //   return g;
  // }
  //
  // _updateFeature() {
  //   this.feature.setPosition(this.go.x, this.go.y); // centred on his face
  // }
}
