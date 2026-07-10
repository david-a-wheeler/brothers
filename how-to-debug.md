# How to debug Brothers

This game is a browser-only, no-build app (Phaser + native ES modules). There
are currently no unit tests to catch a runtime error, and `node --check` only *parses* — it
won't run code inside function bodies. So debugging leans on two things: an
always-on in-app diagnostics layer (`src/diag.js`) that records what happened and
can be read back at any time, and — when you need to verify something without a
human at the keyboard — driving a real headless browser.

Most problems start in the browser console, so this doc goes lightest-touch
first: the diagnostics layer, then static checks, then the full headless rig.

## Quick reference — symptom → where to start

| Symptom | Start here |
| --- | --- |
| An exception fired (error banner appeared), or a player hit a bug | `__diag.report()` / "Report a problem" — see [Diagnostics layer](#the-diagnostics-layer-srcdiagjs) |
| "I clicked X and nothing happened" — no error at all | `?debug` console traces + the trace ring in the report — see [Live console tracing](#live-console-tracing-debug) |
| Layout looks wrong / runs off-screen | Read geometry headless (renderer-independent) — see [Headless debugging](#headless--automated-debugging) |
| Need to see the actual rendered frame | `preserveDrawingBuffer` screenshot harness — see [Single-scene harness](#single-scene-harness) |
| Frozen / stalled — nothing moves or advances | `game.loop.frame` stops advancing — see [gotchas](#gotchas-each-cost-real-time-to-learn); the log persists in localStorage across the freeze |
| Just verify a change boots without opening a browser | Headless driver — see [Minimal driver](#minimal-driver) |

## The diagnostics layer (`src/diag.js`)

Installed once at boot (`main.js` → `diag.install()`). It:

- captures every uncaught error and unhandled promise rejection, plus
  breadcrumbs we record along the way, into a rolling log (last 60 entries)
  **mirrored to `localStorage`** — so it survives a reload or a frozen frame;
- keeps a separate in-memory **trace ring** (last 120 discrete events) as a
  flight recorder for the "expected action silently didn't happen" class of bug;
- on an error, shows a small DOM banner ("Something went wrong — Copy problem
  report"), built from plain DOM + CSS so it works even when the game canvas is
  dead and under a strict CSP;
- exposes `window.__diag` for console use.

No data ever leaves the page on its own — reporting is copy-to-clipboard only.

### Getting a report from a player

A non-expert player can hand you everything you need:

- **On a crash**, the banner appears automatically. They press **Copy problem
  report**, then paste it to David.
- **Any time**, the in-game menu's **"Report a problem"** item opens the same
  report in a read-only box with Copy / Close.

The report is plain text: environment (version, URL, browser, viewport,
language), then the log (most recent last), then the trace ring. That trace tail
is what turns "it just didn't work" into a diagnosable event sequence.

### Reading the diagnostics yourself

When you're driving the app (not a single-scene harness — see below), retrieval
is free from the console:

- `__diag.report()` — the full plain-text report (same text the banner and menu
  item produce). This is the one you'll use most.
- Open `…/index.html#diag` — pops the report overlay on boot.
- `localStorage.getItem('brothers:diag')` — the raw JSON log. Persisted, so read
  it **even after a crash that killed the render loop**, or after a reload.
- `__diag.clear()` — reset the log between runs.

### Live console tracing (`?debug`)

`diag.trace(category, message, data)` always records to the in-memory ring
(above). Separately, a **debug flag** mirrors each trace to the browser console
as it happens (`console.debug`).

> **`?debug` changes nothing on screen.** It does not add an overlay or a HUD —
> it only turns on the live console echo of `trace()` calls. The ring records
> either way, so a problem report is always a flight recorder even with debug
> off. (This trips people up: open the devtools **console** to see the traces.)

Turn the console mirror on/off:

- Add `?debug` (or `#debug`) to the URL — e.g. `http://localhost:8000/?debug`.
- Or from the console: `__diag.setDebug(true)` / `__diag.setDebug(false)`. This
  is **persisted** (`localStorage: brothers:debug`), so it survives reloads until
  you turn it off — handy when a URL flag is inconvenient. `__diag.isDebug()`
  reports the current state.

With it on you'll see lines like `[trace:input] menu down {x: 412, y: 233}`,
`[trace:input] menu row tap`, and — the useful one — `menu row tap suppressed
(drag)` when a guard swallows a release.

### Adding instrumentation with `trace()`

Reach for `trace()` when an *expected action silently didn't happen* — there's no
exception to catch, so an error log tells you nothing. It's cheap and safe to
sprinkle on **discrete** events (input, navigation, a guard that suppressed
something) but **not per-frame** — it's not for the game loop.

```js
import * as diag from '../diag.js';
diag.trace('input', `${this.role} row tap suppressed (drag)`);
```

Keep the `category` a short area tag so traces group cleanly. Instrument new
"silent" surfaces the same way as you find them. The categories in use:

| Category | What it records |
| --- | --- |
| `input` | `Overlay` press/release, drag-shield up/down, and `Menu.wireTap` — which traces both a tap that **fired** and one that was **suppressed** (the exact guard line where the "menu taps swallowed" bug lived) |
| `play` | `level start`, `launch`, `settle`, `shimmy done`, `turn decided`, `level end`, `update threw` |
| `mud` | `pick up`, `shed`, `set turns` |
| `lab` | `before`/`after` **each** Lab parameter edit |
| `brothers` | `vanished` — the watchdog below |

Most `play` and `lab` traces carry `Brothers.snapshot()`: both brothers'
position, radius, visibility, alpha, body presence, static flag, speed,
`frictionAir`, mass and mud state, plus the roles and the camera. That's the
evidence you want for "a ball went missing" or "the turn never advanced", and
the `after` of one Lab edit plus the `before` of the next bracket whatever the
*game* did in between.

### The trace ring is persisted too

`trace()` mirrors the ring to `localStorage` (`brothers:trace`), throttled to
about once a second, and `error()` flushes it immediately — so the events leading
up to a crash survive even if the loop never runs again. On the next page load
the recovered ring is reported separately, under **"trace from the previous page
load"**, so stale events can't be mistaken for current ones. (It only appears
while this run's ring is still short — i.e. right after a reload, when it's
actually relevant.) `__diag.clear()` wipes both rings and the log.

### Watchdogs

Two checks report *once* (per scene / per run) rather than per frame, so a stuck
value can't flood the log or the banner:

- **`Brothers._checkBrothersPresent()`** (every frame) — a brother with no body,
  hidden, fully transparent, at non-finite coordinates, or flung an arena's width
  outside the world is reported with a full snapshot. It tests the *model*, not
  what's on screen: a brother may legitimately leave the view when the camera pans.
- **`Movable._recomputeFriction()`** — a non-finite `frictionAir` is refused
  (the old value stays) and reported. Matter integrates such a body straight to
  `NaN`, which teleports it out of the world; catching it at the write is far
  easier to read than the wreckage several frames later.

`GameScene.update()` is likewise wrapped: an exception is reported once and the
loop keeps stepping. A wrong frame beats a dead one, and it keeps the menu's
"Report a problem" reachable.

### Graceful degradation with `guard()`

`diag.guard('label', fn)` wraps a callback so a thrown exception is **logged
(and the banner shown) instead of bubbling into Phaser's step and killing the
render loop**. Use it on callbacks that run inside the game step — resize,
lifecycle, per-frame. The scenes' `_onResize` are wrapped this way. `breadcrumb`
(records a non-error context line) is the low-key sibling for tracing normal
flow.

### Forcing a test error

- Uncomment the marked `setTimeout(() => { throw … })` block after
  `new Phaser.Game(...)` in `main.js` (uncaught error ~2.5s after boot → banner +
  log entry).
- Or from a driver:
  `ex("window.dispatchEvent(new ErrorEvent('error',{message:'boom',error:new Error('boom')}))")`,
  then read `window.__diag.report()`.
- To confirm graceful degradation, trigger an error inside a `guard`ed callback
  and check `game.loop.frame` still advances (see
  [Detecting a frozen loop](#gotchas-each-cost-real-time-to-learn)).

## Static checks

- `node --check src/foo.js` catches **syntax** errors only. It lazily parses
  function bodies, so a bad reference or typo *inside* a function passes the
  check and only fails at runtime. Treat a clean `node --check` as "it parses",
  never "it works".
- There are no unit tests. Verifying real behaviour means running it — in the
  browser, or headless (below).

## Headless / automated debugging

When you need to *actually* verify a change without a human watching (a scene
boots, no exception is thrown, a transition isn't stalled, a layout is roughly
right), drive a real headless browser and read the JS state back out.

On David's Linux machine use **Firefox**, not Chrome. Chrome on Linux has flaky
OpenGL behavior when running on top of macOS.

### Prerequisites

- `firefox` and `geckodriver` (geckodriver speaks the WebDriver HTTP protocol,
  which we drive from plain Python `urllib` — no Selenium/Playwright needed).
- A **plain** static server. Do NOT use `./serve` for automation: it gates
  everything behind a login cookie. Use:

  ```bash
  python3 -m http.server 8099        # from the repo root; Ctrl-C to stop
  ```

### Gotchas (each cost real time to learn)

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

- **Tweens don't run headless, and you can't fast-forward them.** A headless
  window never paints, so `requestAnimationFrame` never fires and the game loop
  sleeps: `game.loop.frame` sits still and *nothing animates*. Read a tween's
  target once and you'll wrongly conclude the animation is broken. Three traps,
  in the order they bit:
  1. Phaser 3.60's `TweenManager.update(time, delta)` **ignores both arguments** —
     `getDelta()` reads `Date.now()`. You cannot advance a tween by passing a
     fake delta; you must let *real* time pass.
  2. `getDelta()` **skips** any gap longer than `maxLag` (500 ms), to avoid a
     post-pause jump. Sleep a second, tick once, and the tween barely moves —
     stranded mid-flight at whatever value it held.
  3. A WebDriver `execute` round-trip costs ~50 ms, so sampling from Python
     overshoots short animations entirely. A 355 ms cascade finished between two
     reads and looked like it never fired.

  The recipe that works: do it all **inside one `execute` call**, busy-waiting in
  frame-sized steps and ticking the manager each step.

  ```js
  const wait = (ms) => { const s = Date.now(); while (Date.now() - s < ms) {} };
  scene.tweens.tick();              // promote pending tweens
  scene.someAnimation();
  const samples = {};
  for (let e = 20; e <= 800; e += 20) {
    wait(20); scene.tweens.tick();  // ~one frame
    if (e === 100 || e === 240) samples[e] = readState();
  }
  ```

  The *idle* case is easier: a looping tween is already running, so sleeping in
  Python and calling `scene.tweens.tick()` between reads is enough to watch it
  move (keep each sleep well under `maxLag`).

- **`Phaser.GAMES` isn't exposed** in the UMD build, so you can't reach the game
  object from outside. Temporarily add `window.__game = game;` after
  `new Phaser.Game(...)` in `main.js` to reach scenes, then remove it — or, better
  for one scene, use a single-scene harness that assigns `window.__game` itself
  (below) so `main.js` stays untouched.

- **Don't pixel-tap buttons.** The canvas's CSS rect and Phaser's internal
  coordinates don't match under `Scale.RESIZE`, so a synthetic click at
  `rect.width/2` often misses. Fire the Phaser input event directly instead:
  `scene._playHit.emit('pointerup', {})`.

- **Capture errors yourself** *before* the action, in a single-scene harness —
  install a `window` `error` listener and read it back after:
  `window.addEventListener('error', e => (window.__errs ??= []).push(e.error?.stack || e.message))`.
  (When you drive the *full* app you don't need this — `window.__diag` already
  captures everything; see [Reading the diagnostics
  yourself](#reading-the-diagnostics-yourself). A single-scene harness doesn't
  load `main.js`, so it has no `__diag` unless you add it.) Separately, when an
  `execute` script itself throws, geckodriver replies **HTTP 500 with a JSON
  body** carrying the real `message` + `stacktrace` — read `HTTPError.read()`
  instead of letting `urlopen` raise.

- **Detecting a frozen loop / stalled transition:** read
  `game.loop.frame` before and after — if it stops advancing, an exception
  killed the rAF loop. Scene readiness is
  `scene.sys.settings.status` (Phaser `Scenes.CONST`:
  `1 INIT, 3 LOADING, 4 CREATING, 5 RUNNING, 8 SHUTDOWN, 9 DESTROYED`).

### Minimal driver

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
    print("report:", ex("return window.__diag && window.__diag.report()"))  # full app only
    shot("after_play")
    rq("DELETE", f"/session/{sid}")
finally:
    gd.terminate()
```

Note `GET /session/{id}/screenshot` returns a base64 PNG and captures the live
DOM/canvas on demand — far more reliable than `firefox --headless --screenshot`,
which fires at load (before a rAF-driven canvas has drawn) and won't run a second
instance.

**Reading the diag log from a driver.** On the full app, `ex("return
window.__diag.report()")` gives you the whole flight recorder (errors +
breadcrumbs + traces) in one call — usually more useful than your own error
array. Two timing notes:

- **Breadcrumbs land a beat after the canvas appears.** Scene `create()` (which
  records e.g. `title: create`) runs a step *after* `new Phaser.Game(...)` builds
  the `#game canvas`, and on the real app the CDN Phaser + pack fetches add ~1s.
  Poll `report()` / localStorage over a few seconds rather than reading once the
  canvas first exists (this bit me — an early read showed only `boot`).
- The report already includes the error **message** even on Firefox (whose
  `Error.stack` omits it) — diag prepends it — so you don't need your own listener
  just to see what the error said, when the full app is loaded.

### Single-scene harness

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

A single-scene harness imports one scene, not `main.js`, so `diag.install()`
never runs and there is **no `window.__diag`**. Either hook your own `error`
listener (above) or add `import * as diag from './src/diag.js'; diag.install();`
to the harness to get the full report machinery.
