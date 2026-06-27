# Asset licensing

This document records the provenance and license of every non-code asset in
the game, so the project's licensing is unambiguous.

## Audio

All sound effects are **synthesised at runtime** in `src/Sfx.js` using the
browser's Web Audio API. There are **no audio files** and **no third-party
samples** bundled or downloaded — the waveforms are generated entirely by our
own code.

| Cue    | Trigger                         | How it's made                                                  |
| ------ | ------------------------------- | -------------------------------------------------------------- |
| `hit`  | Brother hits brother/wall/edge  | Bandpassed white-noise burst + short tonal knock (click)       |
| `band` | While aiming, when draw changes | Looping noise → two resonant bandpasses, gain gated by stretch speed (friction creak; silent when held) |
| `teleport` | A teleport occurs           | Quick upward pitch sweep ("vwoop") — triangle + sine an octave below |
| `win`  | Level cleared                   | Rising C-major arpeggio (C5–E5–G5–C6) + sparkle                |
| `lose` | Out of moves                    | Two downward-bending lowpass tones ("awww")                    |

**License:** Not applicable / fully owned. Because these sounds are produced by
original code at runtime rather than from recorded media, there is nothing to
license: no royalties, no attribution requirements, and no usage restrictions.
The generating code in `src/Sfx.js` is covered by this project's own software
license.

## Icons

| File | Source | License |
| ---- | ------ | ------- |
| `assets/icons/arrow-clockwise.svg` | [Bootstrap Icons](https://icons.getbootstrap.com) (`arrow-clockwise`) | MIT — see `assets/icons/LICENSE` |

The only modification is setting the fill color to white so it reads on the dark
HUD ribbon. The MIT license text and copyright are preserved in
`assets/icons/LICENSE`.

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
