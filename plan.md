# "Brothers" — Official Game Design Document & Implementation Plan

This document serves as the architectural blueprint and project roadmap for **Brothers**, a turn-based, 2D tactical physics-puzzle game designed for web browsers across desktop, laptop, and mobile devices.

---

## 1. Game Overview & Core Concept

**Brothers** is a physics-based puzzle game with a comedic, personal touch. The game features two distinct billiard balls representing two brothers: **David** (Blue) and **Ken** (Red). They are permanently tethered to each other by an elastic rubber band.

### Core Gameplay Loop

* **Turn-Based Slingshotting:** The game is turn-based. At the start of a turn, one brother is frozen completely solid (the Anchor), while the player can click/touch and drag the other brother (the Launcher) backward like a slingshot.
* **The Hybrid Snap:** Upon release, the Launcher rockets toward the Anchor. The Anchor stays frozen (static) until the moment of impact, at which point it is converted back to a dynamic body so momentum transfers and both balls ricochet across the level. **This static→dynamic hand-off at the instant of collision is the single hardest piece of the game and must be prototyped first** — see the "Hybrid Snap" notes in Phase 3.
* **Friction & Win States:** Both balls slide and bounce around the map, interacting with hazards and walls. Air friction (`frictionAir`) plus the tether's damping naturally bleed off energy. Because the elastic tether keeps applying a restoring force, the balls will jitter slightly before they truly stop, so "settled" is defined by a debounced low-speed threshold (see Phase 3) rather than an exact-zero check. Once both balls are settled, the roles reverse for the next turn.
* **The Goal:** The player must navigate the environment and get *at least one* of the brothers to stop in the designated "Destination Area" before running out of a fixed number of moves allocated for that level. If they fail, they start again until they complete that level.

---

## 2. The Open-Source Technical Stack

To minimize development time while maintaining total architectural control, the game will be built entirely using the following open source software (OSS) components:

* **Game Framework: Phaser 3 (MIT License)**
Handles the core update loops, asset loading, mobile web layout scaling, multi-touch pointer interactions, camera viewport management, and rendering via WebGL (with an automatic Canvas fallback).
* **Physics Engine: Matter.js (MIT License)**
Integrated natively within Phaser 3. It handles rigid body geometry, circular collisions, elastic constraints, air resistance tracking, and overlap sensors.
* **Level Designer: Tiled Map Editor (GPL/Free)**
A visual 2D mapping tool. Levels will be drawn visually in Tiled and exported as standard `.json` files. Phaser will read these files to spawn walls, goal areas, and hazard positions automatically.
* **Audio Generators: sfxr / ChipTone & OpenGameArt (Public Domain/CC0)**
Web-based synthesis engines used to export quick `.wav` or `.mp3` sound effects (impacts, snaps, portal sounds) without dealing with licensing hurdles.

---

## 3. Visuals & Dynamic Expression Matrix

To give the game its unique personality, the face visuals for the balls use a **Decoupled Sprite Layer**. The circular physics bodies handle the spinning, bouncing, and sliding under the hood, but the actual face textures float directly on top, locked at a `rotation` of 0. This ensures the faces remain upright and perfectly legible at all times.

### Character Art Asset Setup

You will need a spritesheet or texture atlas for both David and Ken, containing a grid of their faces with different emotional expressions.

### The Expression & Audio Event Matrix

Here's a first cut at expressions; no doubt there will be tweaks to this after player testing.

| Game Event State | David's Visual Face | Ken's Visual Face | Audio Layer Trigger |
| --- | --- | --- | --- |
| **Idle (David's Turn)** | Smug / Smiling (`😃`) | Neutral / Skeptical (`🤨`) | Low-volume loopable background music active. |
| **Idle (Ken's Turn)** | Neutral / Skeptical (`🤨`) | Smug / Smiling (`😃`) | Low-volume loopable background music active. |
| **Slingshot Dragging** | Straining / Determined (`😤`) | Nervous / Wide-Eyed (`😳`) | Pitch-rising tension click (`click...click...click`). |
| **Ball in Flight (Pre-Impact)** | Rocketing / Confident (`🚀`) | Anticipating Impact (`😨`) | High-speed air whoosh. |
| **Brother-on-Brother Collision** | Impact Flash / Exploding (`💥`) | Impact Flash / Exploding (`💥`) | Sharp, high-velocity billiard "clack" sound. |
| **Wall / Static Obstacle Hit** | Dazed / Ouch Face (`🤕`) | Dazed / Ouch Face (`🤕`) | Hollow wooden or metallic bounce thud. |
| **Trapped in a Teleporter** | Swirling Eyes / Dizzy (`🌀`) | Swirling Eyes / Dizzy (`🌀`) | Sci-fi pitch-bending teleport "zap". |
| **Level Completed (Victory)** | Triumphant Grin (`😎`) | Triumphant Grin (`😎`) | Short, cheerful melodic major-chord fanfare. |
| **Out of Moves (Failure)** | Crying / Regretful (`😭`) | Crying / Regretful (`😭`) | Slow, descending minor-chord sad jingle. |

---

## 4. Environment & Level Hazard Architecture

The game map uses a 2D coordinate system populated by three main types of structural game entities defined inside the Tiled editor:

### A. Solid Surfaces (Walls & Obstacles)

* **Physics Property:** Static, rigid bodies (`{ isStatic: true }`).
* **Behavior:** Infinite mass. The brothers bounce off them cleanly. Bounciness is dictated by a global engine `restitution` variable set between `0.7` and `0.9`.

### B. The Destination Zone (The Goal)

* **Physics Property:** Static Sensor (`{ isSensor: true, isStatic: true }`).
* **Behavior:** Detects physical overlaps without halting ball speed. When a brother body intersects this zone, the update loop checks if the balls have slowed down or triggers an immediate victory condition sequence.

### C. The "Package Deal" Teleporter Pair

* **Physics Property:** Static Sensor linked via custom properties to a target X/Y coordinate vector.
* **Behavior:** 1. The moment *either* brother intersects the source teleporter shape, a collision event fires.
2. The relative position vector offset between David and Ken is calculated so they don't overlap or compress.
3. Both brother objects have their coordinate positions immediately translated to the target penalty area.
4. Their current velocity vectors are multiplied by a dampening scalar (`0.6`) to retain 60% of their kinetic energy, allowing them to shoot out of the penalty zone with manageable whiplash momentum.

---

## 5. Step-by-Step Implementation Roadmap

This phased approach breaks development down into isolated, highly achievable milestones to keep development quick and rewarding.

```
[ Phase 1: Assets ] ──> [ Phase 2: Map Loading ] ──> [ Phase 3: Game Loop ] ──> [ Phase 4: Polish ] ──> [ Phase 5: Final Art ]

```

> **Note on phases:** Phase 1 only needs throwaway placeholder art (even two colored circles) so the physics is playable. Phase 5 is where the real photos and the full expression matrix from Section 3 get produced. Keeping them split lets you build and test the game loop without waiting on final art.

### Phase 1: Basic Assets

* Get a picture each of David and Ken; we'll worry about facial expressions later.
* Create a simple asset folder structure:
* `/assets/images/` (Faces, UI buttons)
* `/assets/audio/` (SFX tracks, looping background music)
* `/assets/maps/` (Tiled exported JSON files)

### Phase 2: Map Infrastructure & Camera Setup (Est. Time: One Evening)

* Open Tiled Map Editor and create `level1.json` (Width: 2000px, Height: 1500px to allow for panning room).
* Draw an outer bounding wall layer. Add an "Objects" layer and place rectangles for the `goal` and a `teleporter_source`/`teleporter_destination`.
* Update the Phaser codebase to load this JSON file using `this.load.tilemapTiledJSON()`.
* Map mouse-drag and pinch-to-zoom listeners to control `this.cameras.main.scrollX`, `scrollY`, and `setZoom()` so the player can effortlessly look around the large level map.
* **Resolve the drag conflict up front.** Both the slingshot and the camera pan are "press and drag" gestures, so they must be disambiguated on `pointerdown`: hit-test the pointer against the current Launcher's body — if it hits, the gesture is a slingshot pull; otherwise it pans the camera. A boolean like `isAiming` set on `pointerdown` routes the subsequent `pointermove`/`pointerup` to the correct handler so a camera pan can never be mistaken for a launch (and vice-versa). This flag is also what Phase 4 uses to decide whether a `pointerup` should consume a move.

### Phase 3: State Machine & Turn Execution Logic (Est. Time: One Evening)

* **The tether constraint.** Connect the two brothers with a single Matter.js `Constraint`, configured as a soft, damped elastic rather than a zero-length spring:
* `length`: a **small non-zero preferred rest separation** — roughly `1.5 ×` the ball diameter (e.g. `~60px` for a `40px`-diameter ball). This gives the pair a natural resting gap so they don't try to occupy the same point and grind against each other.
* `stiffness`: `0.02` (soft, slingshot-like restoring force).
* `damping`: `~0.05–0.1`. This is the key addition — without damping the soft spring stores and returns energy indefinitely and the pair never settles; damping bleeds tether energy out each oscillation so they actually come to rest.
* Tune `stiffness`, `damping`, and `frictionAir` together against the global `restitution` so a typical launch is satisfying but doesn't pump energy into an endless bounce.
* **The Hybrid Snap (prototype this in isolation before anything else).** The Anchor is `isStatic: true` during aiming. On release the Launcher flies at it; in a Matter.js `collisionStart` handler, detect the Launcher↔Anchor pair and flip the Anchor to dynamic (`Body.setStatic(anchor, false)`) so the solver resolves the impact with finite mass and momentum transfers. Watch for: (a) flipping *before* the solver runs so the very first contact transfers momentum, and (b) the velocity jolt from the infinite→finite mass swap — if it's too violent, briefly raise the Anchor's mass or clamp the post-impact speed. Keep this as a standalone test scene until it feels right; it's the riskiest mechanic in the game.
* Code the visual tracking logic that loops over the face sprites and locks their angles to zero while copying the physical ball X/Y coordinates.
* **Settle detection (debounced).** Because the damped tether leaves a little residual jitter, don't test for zero velocity. Evaluate `body.speed` across both characters each frame; once **both** stay below a `~0.15` threshold for `30` consecutive frames, treat the turn as settled: clear both velocities (and angular velocity) to fully kill the jitter, invert the `isStatic` roles between the brothers, and update the turn-indicator overlay. Resetting the consecutive-frame counter whenever either ball exceeds the threshold prevents a brief slow-down mid-bounce from ending the turn early.

### Phase 4: UI, Score Tracking, & Mobile Optimization (Est. Time: 2-3 Hours)

* Create a `movesLeft` counter initialized at the start of each level scene. **Subtract 1 only on an actual launch** — i.e. on a `pointerup` where the `isAiming` flag from Phase 2 is set (the gesture began on the Launcher) *and* the slingshot was pulled past a minimum drag distance. Camera pans, stray clicks, and taps that don't move the ball must not consume a move.
* Add a simple checking conditional: if `movesLeft === 0` and the state machine switches from `MOVING` back to `AIMING` without a goal trigger, show an "Out of moves" indicator with a restart level option.
* Implement Phaser's scale manager configuration (`Phaser.Scale.FIT`) to verify that testing on an actual mobile device scales responsively across Chrome, Firefox, and Safari, for both laptops and mobile.
* Hook up the audio playback lines to match the event triggers listed in the Asset Matrix.

### Phase 5: Asset Preparation (Est. Time: 1-2 Hours)

* Take portrait photos of David and Ken. Use a free photo editor to crop them into clean circular face images.
* Create the different facial expressions corresponding to the matrix in Section 3.
