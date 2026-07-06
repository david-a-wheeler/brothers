# AGENTS.md

Orientation for AI agents working in this repo. See [README.md](README.md) for
the game itself and how to play.

## What this is

Brothers is a small browser puzzle game. It is written in JavaScript
usign plain ES modules + Phaser 3 (loaded from
a CDN), Matter.js physics, Web Audio sound. **No build step, no bundler, no
TypeScript.** Source is under `src/` (one concern per file); levels are Tiled
`.tmj` maps under `packs/`.

## Conventions

- Plain JS ES modules. Type with **JSDoc**, not TypeScript.
- One concern per file; match the surrounding code's style, naming, and comment
  density (the codebase leans on explanatory comments — keep that up).
- Tunables live in `src/config.js`. Rendering uses two cameras (a world camera
  that pans/zooms and a fixed UI camera).

## Running & testing

- David runs the game and **reloads the browser tab** to see changes. Do **not**
  offer to launch, serve, or open the app.
- `./serve` is the local dev server (login-gated). For headless automation use a
  plain `python3 -m http.server` instead — see the debugging guide.
- There are currently
  no unit tests. `node --check <file>` only *parses*: it passes even
  with errors inside a function body, so treat a clean check as "it's valid
  syntax," never "it works." That's something we intend to fix in the
  future.

## Debugging

Full guide: **[how-to-debug.md](how-to-debug.md)**. It covers the always-on
diagnostics layer (`src/diag.js`), the `?debug` console-trace flag, the
`__diag.report()` problem report, and the headless-browser rig for verifying a
change without a human watching. Read it before chasing a "nothing happened" bug
or writing a headless probe.

## Committing

Commit only when asked. End commit messages with:

```
Co-Authored-By: David A. Wheeler <dwheeler@dwheeler.com>
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Do not push unless specifically told otherwise.
