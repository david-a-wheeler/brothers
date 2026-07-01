/**
 * Emoji faces per game state, shared by the brothers and their views. Faces
 * float on top of the physics bodies and are kept upright, so they stay legible
 * no matter how the balls spin.
 *
 * This is intentionally extracted as a separate* file, as opposed to
 * being part of "Brother" or "Brothers".
 * We need David to be able to read the win emoji without a
 * Brother into Brothers import cycle
 * (Brothers re-exports it, so GameScene is unchanged).
 *
 * Role-relative states (such as `drag` and `flight`) carry a
 * `launcher` and `anchor` emoji.
 * The single-emoji states apply to both brothers at once.
 */
export const FACES = {
  idle: { launcher: '😃', anchor: '🤨' },
  drag: { launcher: '😏', anchor: '😳' },
  flight: { launcher: '😁', anchor: '😨' },
  collision: '😬',
  dizzy: '😖',
  win: '😎',
  lose: '😭',
};
