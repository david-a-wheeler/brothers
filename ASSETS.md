# Asset licensing

This document records the provenance and license of every non-code asset in
the game, so the project's licensing is unambiguous.

## Audio

Nearly all sound effects are **synthesised at runtime** in `src/Sfx.js` using
the browser's Web Audio API — the waveforms are generated entirely by our own
code. The one exception is the recorded "oof" voice pack, documented under
[Recorded audio](#recorded-audio) below.

| Cue    | Trigger                         | How it's made                                                  |
| ------ | ------------------------------- | -------------------------------------------------------------- |
| `hit`  | Brother hits a wall or the edge | Bandpassed white-noise burst + short tonal knock (click)       |
| `oof`  | Brother hits his brother        | **Not synthesised** — a random grunt from the recorded voice sprite (below) |
| `band` | While aiming, when draw changes | Looping noise → two resonant bandpasses, gain gated by stretch speed (friction creak; silent when held) |
| `teleport` | A teleport occurs           | Quick upward pitch sweep ("vwoop") — triangle + sine an octave below |
| `win`  | Level cleared                   | Rising C-major arpeggio (C5–E5–G5–C6) + sparkle                |
| `lose` | Out of moves                    | Two downward-bending lowpass tones ("awww")                    |

**License:** Not applicable / fully owned. Because these sounds are produced by
original code at runtime rather than from recorded media, there is nothing to
license: no royalties, no attribution requirements, and no usage restrictions.
The generating code in `src/Sfx.js` is covered by this project's own software
license.

## Recorded audio

`assets/audio/brotherbounce/oofs.wav` — the "oof!" grunts a brother lets out when
he collides with his brother. It holds **23 grunts in one file** (an audio
"sprite"); `src/oofs.js` records where each one starts and how long it runs, and
`Sfx.oof()` picks one at random per collision so repeated hits don't sound
mechanical.

One file rather than 23 means one request and one decode. Nothing is ever sliced
at runtime: Web Audio's `source.start(when, offset, duration)` plays a sub-region
of the decoded buffer directly. The offsets are in **seconds, not samples**,
because `decodeAudioData` resamples the file to the AudioContext's rate (48 kHz
in practice) — sample indices would not survive that.

| Field | Value |
| ----- | ----- |
| Source | ["Short Male Pain Sounds (kinda silly)" by **unfa**](https://freesound.org/people/unfa/sounds/588557/) (Freesound, sound #588557) |
| License | **CC0 1.0 Universal** (public domain dedication) — no attribution required, commercial use permitted |
| Original | One 28.5 s FLAC (48 kHz, mono, 16-bit) containing 23 grunts separated by silence |
| Modification | Split at the silences into one clip per grunt, then reassembled into a single sprite with 30 ms of guard silence between clips. Each grunt is peak-normalised to −1 dBFS (the source varied by ~16 dB between takes) with 6 ms/20 ms fades on the cut edges so no splice clicks. Resampled to 24 kHz mono: the discarded band above 12 kHz measures 20–41 dB below the signal — inaudible for a 0.3 s cue heard over gameplay — and it halves the asset to 522 KB. |

Although CC0 imposes **no** attribution requirement, we credit unfa here as a
courtesy. Note that the author asks that their sounds not be used to train
generative AI models; we don't, and this entry records the request.

## Icons

| File | Source | License |
| ---- | ------ | ------- |
| `assets/icons/arrow-clockwise.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`arrow-clockwise`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/chevron-left.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`chevron-left`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/chevron-right.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`chevron-right`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/flag.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`flag`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/flag-fill.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`flag-fill`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/controller.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`controller`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/list.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`list`) | MIT — see `assets/icons/LICENSE` |
| `assets/icons/beaker.svg` | [Heroicons](https://github.com/tailwindlabs/heroicons) (`beaker`, solid; no longer used) | MIT — see `assets/icons/LICENSE` |

The only modification is setting the fill color to white so it reads on the dark
HUD ribbon. The MIT license text and copyright are preserved in
`assets/icons/LICENSE`.

## Pack images (Item pictures)

Level packs may reference images for Item objects, stored in the pack's
`assets/` directory (`packs/<Pack>/assets/`, the directory the pack's Tiled
maps resolve relative paths against).

| File | Source | License |
| ---- | ------ | ------- |
| `packs/Base/assets/star.png` | Self-made for this project (a gold five-pointed star drawn by a small PIL script; no third-party artwork) | This project's own license |

## Other assets

- **Graphics:** Remaining visuals (balls, walls' brick pattern, target, grid,
  HUD panel) are drawn procedurally with Phaser's graphics primitives — no image
  files.
- **Fonts:** Default Phaser/browser fonts only; none bundled.
- **Emoji:** Faces use standard Unicode emoji rendered by the system font; no
  emoji image assets are bundled.
- **`favicon.ico`:** The smiling-face-with-sunglasses (😎, U+1F60E) icon was
  rendered from the **Noto Color Emoji** font, which is licensed under the
  **SIL Open Font License 1.1** (https://github.com/googlefonts/noto-emoji) —
  a clearly open, royalty-free license. The font itself is not bundled; only
  this one rendered raster icon is committed.

If any third-party asset is ever added, prefer a clearly open, royalty-free
license (e.g. CC0 1.0 / public domain), and add a row here documenting the
source URL and license before committing the file.
