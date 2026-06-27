# Brothers

A small browser puzzle game. Two brothers — **David** (blue, glasses) and
**Ken** (red, mustache) — are joined by an elastic tether. Slingshot one into
the other to fling the pair across the arena and land on the goal before you
run out of moves.

**▶ Play: https://brothers.dwheeler.com**

## How to play

- **Aim & launch:** drag the glowing brother away from the other, then release
  to fling it. On impact the other brother is freed and the pair flies on
  together.
- A launch is refused (a red ✗ appears) if the ball would start on a wall, the
  arena edge, or the other brother, or if the elastic band would cross a wall.
- **Goal:** get either brother to rest on the target (the archery-style rings)
  before the move counter reaches zero.
- **Teleporter:** the purple portal warps the pair to its orange exit.
- **Zoom:** mouse wheel (desktop) or pinch (touch). **Pan:** drag empty space.
- **Restart level:** the button at the top.

## Tech

Plain ES modules with [Phaser 3](https://phaser.io/) loaded from a CDN — no
build step and no bundler. Physics is Matter.js (built into Phaser), advanced
in fixed sub-steps so fast shots can't tunnel through thin walls. All sound is
synthesised at runtime via the Web Audio API.

## Running locally

```bash
./serve            # starts a small static server on http://localhost:8000
```

Then open <http://localhost:8000>. (`serve` is a tiny threaded Python static
server used only for local development; the deployed site is served statically
by GitHub Pages.)

## Licensing

- Code: [MIT](LICENSE.md).
- Assets: there are essentially none to license — graphics are drawn with
  Phaser primitives, sound is synthesised in code, and the favicon is rendered
  from an open-licensed emoji font. Details in [ASSETS.md](ASSETS.md).
