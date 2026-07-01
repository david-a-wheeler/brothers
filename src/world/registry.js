import { David } from './David.js';
import { Goal } from './Goal.js';
import { Ken } from './Ken.js';
import { TeleportSource } from './TeleportSource.js';
import { TeleportTarget } from './TeleportTarget.js';
import { Wall } from './Wall.js';

/**
 * The single manifest of world-object types: maps a Tiled object class (the
 * level model's `kind`) to its {@link Entity} subclass. This is the *only*
 * place that names the set of types, so the manager ({@link World}) stays
 * agnostic — it imports this table, never the concrete classes.
 *
 * Adding a type is two steps: write the subclass file, then add one line here.
 */
export const KINDS = {
  david: David,
  ken: Ken,
  goal: Goal,
  'teleporter-source': TeleportSource,
  'teleporter-target': TeleportTarget,
  wall: Wall,
};
