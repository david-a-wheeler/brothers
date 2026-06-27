# "Brothers" — Official Game Design Document & Implementation Plan

This document serves as the architectural blueprint and project roadmap for **Brothers**, a turn-based, 2D tactical physics-puzzle game designed for web browsers across desktop, laptop, and mobile devices.

---

## 1. Game Overview & Core Concept

**Brothers** is a physics-based puzzle game with a comedic, personal touch. The game features two distinct billiard balls representing two brothers: **David** (Blue) and **Ken** (Red). They are permanently tethered to each other by an elastic rubber band.

### Core Gameplay Loop

* **Turn-Based Slingshotting:** The game is turn-based. At the start of a turn, one brother is frozen completely solid (the Anchor), while the player can click/touch and drag the other brother (the Launcher) backward like a slingshot.
* **The Hybrid Snap:** Upon release, the Launcher rockets toward the Anchor. The Anchor remains frozen until the exact millisecond of impact. When they collide, the Anchor unfreezes, momentum transfers, and both balls ricochet across the level.
* **Friction & Win States:** Both balls slide and bounce around the map, interacting with hazards and walls. Air friction naturally slows them down. Once both balls completely settle to a stop, the roles reverse for the next turn.
* **The Goal:** The player must navigate the environment and get *at least one* of the brothers to stop in the designated "Destination Area" before running out of a fixed number of moves allocated for that level. If they fail, they start again until they complete that level.

---

## 2. The Open-Source Technical Stack

To minimize development time while maintaining total architectural control, the game will be built entirely using the following open source software (OSS) components:

* **Game Framework: Phaser 3 (MIT License)**
Handles the core update loops, asset loading, mobile web layout scaling, multi-touch pointer interactions, camera viewport management, and rendering via WebGL/WebGPU.
* **Physics Engine: Matter.js (MIT License)**
Integrated natively within Phaser 3. It handles rigid body geometry, circular collisions, elastic constraints, air resistance tracking, and overlap sensors.
* **Level Designer: Tiled Map Editor (GPL/Free)**
A visual 2D mapping tool. Levels will be drawn visually in Tiled and exported as standard `.json` files. Phaser will read these files to spawn walls, destination areas, and hazard positions automatically.
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
[ Phase 1: Assets ] ──> [ Phase 2: Map Loading ] ──> [ Phase 3: Game Loop ] ──> [ Phase 4: Polish ]

```

### Phase 1: Basic Assets

* Get a picture each of David and Ken; we'll worry about facial expressions later.
* Create a simple asset folder structure:
* `/assets/images/` (Faces, UI buttons)
* `/assets/audio/` (SFX tracks, looping background music)
* `/assets/maps/` (Tiled exported JSON files)

### Phase 2: Map Infrastructure & Camera Setup (Est. Time: One Evening)

* Open Tiled Map Editor and create `level1.json` (Width: 2000px, Height: 1500px to allow for panning room).
* Draw an outer bounding wall layer. Add an "Objects" layer and place rectangles for the `destination` and a `teleporter_source`/`teleporter_destination`.
* Update the Phaser codebase to load this JSON file using `this.load.tilemapTiledJSON()`.
* Map mouse-drag and pinch-to-zoom listeners to control `this.cameras.main.scrollX`, `scrollY`, and `setZoom()` so the player can effortlessly look around the large level map.

### Phase 3: State Machine & Turn Execution Logic (Est. Time: One Evening)

* Integrate the updated hybrid physics code: set the Matter.js constraint length to `0` and stiffness to `0.02`.
* Code the visual tracking logic that loops over the face sprites and locks their angles to zero while copying the physical ball X/Y coordinates.
* Wire up the turn swapping mechanism: evaluate `body.speed` across both characters. Once it falls below `0.15` for 30 consecutive frames, clear velocities, invert the static properties between the brothers, and alter the text layout overlay to show whose turn it is.

### Phase 4: UI, Score Tracking, & Mobile Optimization (Est. Time: 2-3 Hours)

* Create a `movesLeft` counter initialized at the start of each level scene. Subtract 1 on every `pointerup` event.
* Add a simple checking conditional: if `movesLeft === 0` and the state machine switches from `MOVING` back to `AIMING` without a goal trigger, show an "Out of moves" indicator with a restart level option.
* Implement Phaser's scale manager configuration (`Phaser.Scale.FIT`) to verify that testing on an actual mobile device scales responsively across Chrome, Firefox, and Safari, for both laptops and mobile.
* Hook up the audio playback lines to match the event triggers listed in the Asset Matrix.

### Phase 5: Asset Preparation (Est. Time: 1-2 Hours)

* Take portrait photos of David and Ken. Use a free photo editor to crop them into clean circular face images.
* Create the different facial expressions corresponding to the matrix in Section 3.
