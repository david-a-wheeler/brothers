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

- **WebGL screenshots are blank *by default* — but you can fix that.** Phaser
  runs WebGL with `preserveDrawingBuffer: false`, so a headless screenshot reads
  the cleared buffer (flat background) and you wrongly conclude "blank". It's a
  capture quirk, not an app bug. To actually see the frame, boot the scene in a
  throwaway harness with `render: { preserveDrawingBuffer: true }` (see
  "Single-scene harness") and grab it via geckodriver's screenshot endpoint. This
  is how the "Brothers" wordmark ghost-on-resize bug was caught — invisible to
  geometry checks, obvious in a screenshot.
  - The Canvas renderer (`type: Phaser.CANVAS`) also screenshots, but **WebGL-only
    effects throw there**: `postFX`/`preFX` (`addShine`, `addGlow`, …) raise
    inside `create()` and abort the scene half-built (you'll see only the first
    object it managed to add). If the scene uses postFX, Canvas is not an option —
    use the `preserveDrawingBuffer` WebGL harness.

- **Prefer reading geometry over screenshots — it's renderer-independent.** You
  can read `text.x`, positions, font sizes, `getBounds()`, etc. via `execute`
  with no rendering at all, which verifies layout *math* directly. Powerful
  diagnostic: compare an object's geometry after an *in-place resize* against a
  *fresh load* at that same size. If they match but it still looks wrong, the bug
  is in the rendering layer (e.g. a stale postFX render target that didn't track
  a font-size change) — switch to a `preserveDrawingBuffer` screenshot to see it.

- **Firefox clamps the min window width to ~500px.** `POST .../window/rect` won't
  go narrower, so you can't reproduce very-narrow (phone-portrait) layouts
  directly — read the geometry at 500px and extrapolate from the formula.

- **`Phaser.GAMES` isn't exposed** in the UMD build, so you can't reach the game
  object from outside. Temporarily add `window.__game = game;` after
  `new Phaser.Game(...)` in `main.js` to reach scenes, then remove it — or, better
  for one scene, use a single-scene harness that assigns `window.__game` itself
  (below) so `main.js` stays untouched.

- **Don't pixel-tap buttons.** The canvas's CSS rect and Phaser's internal
  coordinates don't match under `Scale.RESIZE`, so a synthetic click at
  `rect.width/2` often misses. Fire the Phaser input event directly instead:
  `scene._playHit.emit('pointerup', {})`.

- **Capture errors yourself** *before* the action — install a `window`
  `error` listener and read it back after:
  `window.addEventListener('error', e => (window.__errs ??= []).push(e.error?.stack || e.message))`.
  Separately, when an `execute` script itself throws, geckodriver replies **HTTP
  500 with a JSON body** carrying the real `message` + `stacktrace` — read
  `HTTPError.read()` instead of letting `urlopen` raise, or you lose it.

- **Detecting a frozen loop / stalled transition:** read
  `game.loop.frame` before and after — if it stops advancing, an exception
  killed the rAF loop. Scene readiness is
  `scene.sys.settings.status` (Phaser `Scenes.CONST`:
  `1 INIT, 3 LOADING, 4 CREATING, 5 RUNNING, 8 SHUTDOWN, 9 DESTROYED`).

## Minimal driver

`geckodriver` exposes a WebDriver REST API on `127.0.0.1:4444`. Skeleton that
boots the page, waits for a scene, runs JS, and reads a value back:

```python
import json, time, base64, urllib.request, subprocess
BASE = "http://127.0.0.1:4444"
def rq(m, p, b=None):
    d = json.dumps(b).encode() if b is not None else None
    r = urllib.request.Request(BASE+p, data=d, method=m,
                               headers={"Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(r, timeout=60).read())
    except urllib.error.HTTPError as e:
        return {"__err": e.read().decode()[:400]}  # real JS error lives here

gd = subprocess.Popen(["geckodriver", "--port", "4444"],
                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    time.sleep(2)
    sid = rq("POST", "/session", {"capabilities": {"alwaysMatch":
             {"moz:firefoxOptions": {"args": ["-headless"]}}}})["value"]["sessionId"]
    def ex(s):
        r = rq("POST", f"/session/{sid}/execute/sync", {"script": s, "args": []})
        return r.get("value", r)
    def shot(name):  # capture the current frame (WebGL needs preserveDrawingBuffer)
        png = rq("GET", f"/session/{sid}/screenshot").get("value", "")
        if png: open(f"/tmp/{name}.png", "wb").write(base64.b64decode(png))
    rq("POST", f"/session/{sid}/window/rect", {"width": 1024, "height": 768})
    rq("POST", f"/session/{sid}/url", {"url": "http://localhost:8099/index.html"})
    # requires window.__game (temp in main.js, or a single-scene harness below)
    for _ in range(40):
        time.sleep(0.5)
        if ex("const g=window.__game; return !!(g && g.scene.getScene('title')?._ready)") is True:
            break
    ex("window.__errs=[]; addEventListener('error',e=>window.__errs.push(e.error?.stack||e.message))")
    ex("window.__game.scene.getScene('title')._playHit.emit('pointerup', {})")  # press Play
    time.sleep(2)
    print("errors:", ex("return window.__errs || []"))
    print("game status:", ex("return window.__game.scene.getScene('game').sys.settings.status"))  # 5 = RUNNING
    shot("after_play")
    rq("DELETE", f"/session/{sid}")
finally:
    gd.terminate()
```

Note `GET /session/{id}/screenshot` returns a base64 PNG and captures the live
DOM/canvas on demand — far more reliable than `firefox --headless --screenshot`,
which fires at load (before a rAF-driven canvas has drawn) and won't run a second
instance.

## Single-scene harness

To exercise one scene in isolation — and to force `preserveDrawingBuffer` so WebGL
screenshots work — serve a throwaway page that imports the scene directly and
exposes the game. This needs same-origin Phaser (`vendor_phaser.js`) and keeps
`main.js` untouched. Skip any global boot the scene doesn't need (e.g. pack
loading) if the scene doesn't require it.

```html
<!DOCTYPE html><html><head><meta charset="utf-8">
  <link rel="stylesheet" href="css/style.css" />   <!-- so #game fills the window -->
  <script src="vendor_phaser.js"></script>
</head><body><div id="game"></div>
<script type="module">
import { TitleScene } from './src/scenes/TitleScene.js';
window.__game = new Phaser.Game({
  type: Phaser.WEBGL, parent: 'game', width: 800, height: 600,
  backgroundColor: '#14141b',
  render: { preserveDrawingBuffer: true },          // <-- makes WebGL screenshots real
  physics: { default: 'matter', matter: { gravity: { x: 0, y: 0 } } },
  scale: { mode: Phaser.Scale.RESIZE },
  scene: [TitleScene],
});
</script></body></html>
```

Then drive it like the skeleton above (it navigates to this harness instead of
`index.html`). To test a **resize** bug, `POST .../window/rect` to a new size, wait
~1s for it to settle, and `shot(...)` or read geometry. Comparing that against a
fresh load at the same size isolates layout (geometry) bugs from render-layer ones.
