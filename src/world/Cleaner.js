import { Config } from '../config.js';
import { Region } from './Region.js';

/**
 * A cleaner area (water): a body-less {@link Region} that washes a brother's mud
 * off when it enters. Loose (normal) mud always comes off; sticky mud comes off
 * only if this area sets `cleanSticky`, so a plain puddle of water rinses off
 * ordinary mud but leaves sticky mud stuck.
 *
 * Its own `viscosity` is a small drag that applies ONLY while the brother is
 * inside (the {@link Region} base wires this up via {@link inViscosity}); it lives
 * on the area, never on the brother, so it doesn't perpetuate after exit.
 *
 * Reads (defaulted from `Config.cleaner`): `viscosity`, and `cleanSticky` (bool).
 * See mud-plan.md.
 */
export class Cleaner extends Region {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.cleaner.viscosity;
    this.cleanSticky = def.cleanSticky ?? false;
  }

  /** The Cleaner's whole friction effect is transient (while-inside only). */
  get inViscosity() {
    return this.viscosity ?? Config.cleaner.viscosity;
  }

  /** Strip mud on entry: loose always, sticky only when this area cleans sticky. */
  _entered(b) {
    b._wash(this.cleanSticky);
  }

  _buildView(scene, def) {
    return this._fillShape(scene, def, {
      color: Config.cleaner.color,
      alpha: 0.4, // translucent, so it reads as water
      depth: Config.cleaner.depth,
    });
  }
}
