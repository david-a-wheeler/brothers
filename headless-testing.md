# Headless debugging

This game is a browser-only, no-build app (Phaser + native ES modules). There are no unit tests to catch a runtime error, and `node --check` only parses; it won't run code inside function bodies. So sometimes the fastest way to *actually* verify a change or debug it (a scene boots, no exception is thrown, a transition isn't stalled, a layout is roughly right) is to drive it in a real headless browser and read the JS state back out.

On David's Linux machine use **Firefox**, not Chrome. Chrome on Linux has flaky OpenGL behavior when running on top of macOS.

## Prerequisites

- `firefox` and `geckodriver` (geckodriver speaks the WebDriver HTTP protocol,
  which we drive from plain Python `urllib` — no Selenium/Playwright needed).
- A **plain** static server. Do NOT use `./serve` for automation: it gates
  everything behind a login cookie. Use:

  ```bash
  python3 -m http.server 8099        # from the repo root; Ctrl-C to stop
  ```

## Gotchas (each cost real time to learn)

- **Cross-origin CDN hides errors.** `index.html` loads Phaser from jsdelivr, so
  any exception thrown *inside* Phaser is sanitized by the browser to the
  useless `"Script error."` with no stack. To get a real stack trace, serve
  Phaser same-origin and point a probe page at it:

  ```bash
  curl -s https://cdn.jsdelivr.net/npm/phaser@3.60.0/dist/phaser.js -o vendor_phaser.js
  # probe.html = copy of index.html with <script src="vendor_phaser.js"> instead
  # of the CDN URL. (vendor_phaser.js is kept untracked in the repo for this.)
  ```

- **Headless WebGL screenshots come out blank.** Phaser renders with
  `preserveDrawingBuffer: false`, so a screenshot reads the cleared buffer (you
  get the flat background color). This is a capture artifact, NOT an app bug —
  trust the console/no-error signal instead. If you truly need a screenshot of
  the *layout*, force the Canvas renderer in a throwaway harness
  (`type: Phaser.CANVAS`); note WebGL-only effects (postFX shimmer/glow) won't
  appear, but positions/text/shapes will.

- **`Phaser.GAMES` isn't exposed** in the UMD build, so you can't reach the game
  object from outside. Temporarily add `window.__game = game;` after
  `new Phaser.Game(...)` in `main.js` to reach scenes, then remove it.

- **Don't pixel-tap buttons.** The canvas's CSS rect and Phaser's internal
  coordinates don't match under `Scale.RESIZE`, so a synthetic click at
  `rect.width/2` often misses. Fire the Phaser input event directly instead:
  `scene._playHit.emit('pointerup', {})`.

- **Capture errors yourself** *before* the action — install a `window`
  `error` listener and read it back after:
  `window.addEventListener('error', e => (window.__errs ??= []).push(e.error?.stack || e.message))`.

- **Detecting a frozen loop / stalled transition:** read
  `game.loop.frame` before and after — if it stops advancing, an exception
  killed the rAF loop. Scene readiness is
  `scene.sys.settings.status` (Phaser `Scenes.CONST`:
  `1 INIT, 3 LOADING, 4 CREATING, 5 RUNNING, 8 SHUTDOWN, 9 DESTROYED`).

## Minimal driver

`geckodriver` exposes a WebDriver REST API on `127.0.0.1:4444`. Skeleton that
boots the page, waits for a scene, runs JS, and reads a value back:

```python
import json, time, urllib.request, subprocess
BASE = "http://127.0.0.1:4444"
def rq(m, p, b=None):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE+p, data=d, method=m,
                               headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r, timeout=60).read())

gd = subprocess.Popen(["geckodriver", "--port", "4444"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(2)
    sid = rq("POST", "/session", {"capabilities": {"alwaysMatch":
             {"moz:firefoxOptions": {"args": ["-headless"]}}}})["value"]["sessionId"]
    ex = lambda s: rq("POST", f"/session/{sid}/execute/sync",
                      {"script": s, "args": []})["value"]
    rq("POST", f"/session/{sid}/url", {"url": "http://localhost:8099/index.html"})
    # requires a temporary `window.__game = game;` in main.js
    for _ in range(40):
        time.sleep(0.5)
        if ex("const g=window.__game; return !!(g && g.scene.getScene('title')?._ready)"):
            break
    ex("window.__errs=[]; addEventListener('error',e=>window.__errs.push(e.error?.stack||e.message))")
    ex("window.__game.scene.getScene('title')._playHit.emit('pointerup', {})")  # press Play
    time.sleep(2)
    print("errors:", ex("return window.__errs || []"))
    print("game status:", ex("return window.__game.scene.getScene('game').sys.settings.status"))  # 5 = RUNNING
    rq("DELETE", f"/session/{sid}")
finally:
    gd.terminate()
```

## Quick layout screenshot (Firefox)

For a one-off visual check (subject to the WebGL-blank caveat above):

```bash
firefox --headless --window-size=1024,768 --screenshot=/tmp/shot.png \
  http://localhost:8099/index.html
```
