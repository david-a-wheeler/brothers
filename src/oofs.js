/**
 * Offsets into the "oof" audio sprite (oofs.wav): the grunts a brother
 * lets out when he collides with his brother.
 *
 * The 23 grunts live in ONE file rather than 23, so the game makes one request
 * and one decode. Web Audio can play any sub-region of a decoded buffer
 * directly — `source.start(when, offset, duration)` — so nothing is ever
 * "sliced"; these pairs simply say which region is which grunt.
 *
 * Generated from the source pack; see ASSETS.md for provenance and licensing.
 * Values are SECONDS (not sample indices): decodeAudioData resamples the file
 * to the AudioContext's rate, so sample indices would not survive the load.
 */

/** Path to the sprite, relative to the page. */
export const OOF_SPRITE_URL = 'assets/audio/brotherbounce/oofs.wav';

/** `[offset, duration]` in seconds, one per grunt. @type {ReadonlyArray<[number, number]>} */
export const OOF_CLIPS = [
  [0.000000, 0.476792], // oof-01
  [0.506792, 0.735792], // oof-02
  [1.272583, 0.356625], // oof-03
  [1.659208, 0.393125], // oof-04
  [2.082333, 0.374625], // oof-05
  [2.486958, 0.500708], // oof-06
  [3.017667, 0.530125], // oof-07
  [3.577792, 0.474625], // oof-08
  [4.082417, 0.424792], // oof-09
  [4.537208, 0.447708], // oof-10
  [5.014917, 0.290500], // oof-11
  [5.335417, 0.326917], // oof-12
  [5.692333, 0.347000], // oof-13
  [6.069333, 0.346917], // oof-14
  [6.446250, 0.356708], // oof-15
  [6.832958, 0.517625], // oof-16
  [7.380583, 0.342208], // oof-17
  [7.752792, 0.560208], // oof-18
  [8.343000, 0.434708], // oof-19
  [8.807708, 0.518417], // oof-20
  [9.356125, 0.470625], // oof-21
  [9.856750, 0.542125], // oof-22
  [10.428875, 0.675208], // oof-23
];
