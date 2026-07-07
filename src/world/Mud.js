import { Config } from '../config.js';
import { Region } from './Region.js';

/**
 * A mud area: a body-less {@link Region} that makes a brother muddy on entry. The
 * pickup is *persistent* — the brother keeps the extra `frictionAir` after it
 * leaves the puddle (until it sheds or is washed), which is the whole mechanic —
 * so this only needs an enter hook, not an exit one.
 *
 * Reads these level-model fields (all defaulted from `Config.mud`):
 * - `viscosity`   — friction picked up on entry (persistent).
 * - `inViscosity` — extra friction only while inside (a "bog"; 0 = none).
 * - `numberTurns` — extra turns the (non-sticky) mud lingers on the brother
 *   before it shakes off at settle (0 = gone after the first shimmy).
 * - `sticky`      — sticky mud is dark and only comes off in a `cleanSticky`
 *   {@link import('./Cleaner.js').Cleaner}, never at settle (≈ infinite turns).
 *
 * See mud-plan.md.
 */
export class Mud extends Region {
  /**
   * @param {Phaser.Scene} scene
   * @param {import('../levels.js').EntityDef} def
   */
  constructor(scene, def) {
    super(scene, def);
    this.viscosity = def.viscosity ?? Config.mud.viscosity;
    this._inViscosity = def.inViscosity ?? Config.mud.inViscosity;
    this.sticky = def.sticky ?? false;
    this.numberTurns = def.numberTurns ?? Config.mud.numberTurns;
  }

  /** While-inside extra drag; the Region base registers/drops it on enter/exit. */
  get inViscosity() {
    return this._inViscosity;
  }

  /** Persistent pickup — into the sticky or loose bucket per {@link sticky}. */
  _entered(b) {
    b._pickUpMud(this.viscosity, this.sticky, this.numberTurns);
  }

  _buildView(scene, def) {
    // Runs inside super() — before this.sticky is set — so read the raw def.
    const C = Config.mud;
    return this._fillShape(scene, def, {
      color: def.sticky ? C.stickyColor : C.color,
      alpha: 0.6,
      depth: C.depth,
    });
  }
}
