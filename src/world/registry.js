import { David } from './David.js';
import { Goal } from './Goal.js';
import { Ken } from './Ken.js';
import { TeleportSource } from './TeleportSource.js';
import { TeleportTarget } from './TeleportTarget.js';
import { Wall } from './Wall.js';

/**
 * The single manifest of world-object types. A level object's Tiled **Class**
 * is the JS class name verbatim (PascalCase, e.g. `TeleportSource`), so the
 * kind → class map is derived from the class list itself — there are no
 * hand-written string keys to keep in sync. This is the *only* place that names
 * the set of types, so the manager ({@link World}) stays agnostic (it imports
 * this table, never the concrete classes).
 *
 * Adding a type is two steps: write the subclass file, then add it here.
 */
const CLASSES = [David, Ken, Goal, Wall, TeleportSource, TeleportTarget];

/** @type {Record<string, typeof import('./Entity.js').Entity>} kind → class. */
export const KINDS = Object.fromEntries(CLASSES.map((C) => [C.name, C]));
