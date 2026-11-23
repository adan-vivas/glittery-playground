# Memory Projector — design

Date: 2026-11-23
Status: draft for review

## Intent

The Temporal Projector (a speculative palm-sized device that projected eras from 1996 to three plausible 2036s) becomes a
**personal holographic memory projector**: a device that tells Adán's story one memory at a time. Each memory is a short
moment from his life (for example, playing with his kids) floating above the lens as a Star Wars–style hologram, with a
paragraph of the story crawling across the table in front of it.

Two reasons drive it:

1. **A portable object.** The device must live in its own self-contained folder so it can be dropped into other pages.
   The homepage keeps using it.
2. **The engine is part of the story.** Adán is building the code that turns a phone/glasses clip into a 3D hologram,
   and wants to talk about it (portfolio, write-ups, talks). The engine is not a hidden tool; it is the device's insides
   made visible.

### The speculative story (narrative only)

In this future we don't carry phones; we wear glasses. You hit record and capture your day. Moments you choose are sent
automatically to your projector, which *develops* them: your glasses remember flat, the projector makes them whole. One day
you could share holographic memories with others. The device has no camera; capture happens elsewhere. Its only sign of
capture is a small light that glows when a new memory has arrived.

On the website, "arriving" means Adán commits a memory file produced by the engine page. Visitors only see memories that
have already arrived.

## Goals

- A new `<memory-projector>` web component in its own folder, rendering the redesigned device with the existing renderer
  (three.js, table scene, lighting, shadows, materials, lift-and-drop, scene lab).
- Controls: **slide power** (on/off), **back**, **next**, **shuffle** (random memory). No dial.
- A **memory-arrived light** on the top face.
- A **carry loop**: a small metal lug at a back corner with a short wrist strap; the device is carried in one hand.
- **Hologram**: each memory is a looping (≤ 7 s) 3D point-cloud reconstruction of the people in a real video, background
  removed, rendered in a Star Wars–inspired hologram look (blue translucent light, scanlines, flicker, glitches), not a copy.
- **Table crawl**: the memory's story as a left-aligned paragraph with no heading, projected from the front lens onto the
  table, scrolling away from the viewer in perspective like the Star Wars opening crawl, slow enough to read.
- **Engine page**: a private, unlinked page where Adán uploads a clip, writes the story, watches it be rebuilt stage by
  stage, and exports a memory file. Runs entirely in his browser; adding a memory never needs Claude.
- The engine page shows its stages side by side (video → cut-out → depth → dots) and can export stills and a short clip of
  that view, as material for talking about it.
- The homepage switches from `<temporal-projector>` to `<memory-projector>`.

## Non-goals

- Visitor uploads, accounts, servers, or any processing on a visitor's device beyond playback.
- Sharing memories between people (narrative only).
- Real per-frame depth estimation in v1 (see Approaches; the pipeline keeps a swappable depth stage for it later).
- Changing the case's overall proportions or materials (they stay ZL 2's: 112 × 64 × 20 mm, warm-white moulded body).
- Animating the strap when the device is lifted (it is rigid in v1).

## Anti-goals (would be a failure even if it works)

- Recognisable faces of Adán's children on a public site. Detail is deliberately coarse; people read as people, not as
  identifiable faces.
- A literal Star Wars copy (logos, the Star Wars typeface, the yellow crawl colour). Inspired, not copied.
- Story text that moves too fast to read comfortably.
- Long loads: a memory must start within about a second on a normal connection.
- Breaking the homepage's existing behaviour that isn't about content (lift-and-drop, paper letter, scene lab, hint).

## Approaches considered

### How a memory gets into the device (story)

1. **Phone/glasses record, device develops — chosen.** No camera on the device; a light shows arrivals. Honest to how
   the engine actually works and keeps the device to four controls.
2. One lens records and projects (like the Lumières' 1895 Cinématographe). Rejected: you'd carry the projector to record,
   and it needs a fifth control.
3. Set the phone on the device to pour a memory in. Rejected: it's option 1 plus a landing pad on the case.

### What the hologram is made from

1. **Cut-out figures with inflated depth — chosen.** Segment the people in each frame; give silhouettes volume with a
   distance transform (thick in the middle, thin at the edges) plus fine relief from shading — the technique
   `temporal-projector/holo-scenes.js` already uses on still images. Real motion, cheap, coarse enough to anonymise.
2. Real depth from a monocular depth model per frame. Deferred: heavier, bigger files, faces clearer. The pipeline keeps
   depth as its own stage so this can replace stage 3 later without touching anything else.
3. Video-driven skeletons on faceless mannequins. Rejected: retargeting is fiddly and it's the most work.
4. Hand-modelled generic figures from reference photos. Rejected: every new memory would need a Blender session, and
   hand-animated people look stiff.

### What the engine saves, and how the device plays it

1. **Depth video — chosen.** One small H.264 MP4 per memory. Each frame is two halves side by side: left the people's
   brightness, right their depth (black = not a person). The GPU rebuilds the dots from it as it plays. ~1–2 MB per memory,
   smooth, and the depth half is the only thing that changes if real depth arrives. This is the "combined per pixel"
   layout volumetric-video tools ship.
2. Baked dot clouds per frame. Rejected: 10–15 MB per memory, slower to load, harder to change.

### How the case is changed

Edit the ZL 2 Blender script into ZL 3 and export a new GLB, running Blender here as the `bpy` Python package
(5.x is installable; the container has Python 3.13). Building the case in three.js code instead was rejected: the case
already exists as a procedural Blender script with baked Cycles shadow and AO.

## The design

### 1. Folder and files

A new self-contained folder, `memory-projector/`, modelled on `temporal-projector/`:

| Path | What |
| --- | --- |
| `memory-projector/memory-projector.js` | `<memory-projector>` web component |
| `memory-projector/index.html` | Demo page for the component (the device's own environment) |
| `memory-projector/engine/index.html` (+ `engine/*.js`) | The engine page (private, unlinked, `noindex`) |
| `memory-projector/memories/memories.json` | Manifest of memories, in story order |
| `memory-projector/memories/<id>.mp4` | One depth video per memory |
| `memory-projector/assets/` | `memory-projector.glb`, `shadow.png`, `ao.jpg` |
| `memory-projector/blender/memory_projector.py` | ZL 3 procedural model (from root `zeitlinse.py`, which is ZL 2) |
| `memory-projector/blender/export_web.py` | Bakes shadow + AO, exports GLB (from root `export_web.py`) |
| `memory-projector/README.md` | How to use the component, run the engine, rebuild the model |

`temporal-projector/` is left untouched as the earlier experiment. Before the homepage switches, the current homepage is
tagged `homepage-v2-projector` and copied to `archive/projector/`, per the README's convention.

### 2. The device (ZL 3)

Starts from ZL 2 (root `zeitlinse.py`): same body, footprint, materials, top fog-projection lens with its perforation
ring, front rectangular projection aperture, slide power toggle with the green strip it uncovers.

Changes:

- **Crown removed**, and its pocket in the right end face closed.
- **Shuffle key** stays a rectangular key, now centred in a row between two smaller **back** and **next** keys. Icons
  are geometry, engraved or printed in the trim grey: `‹`, a shuffle glyph (two crossing arrows), `›`. No fonts needed.
- **Memory light**: a small round emissive dot near the power slide, its own material so the page drives it.
- **Carry loop**: a small metal lug at one back corner (the lens side, away from the controls) and a short flat wrist
  strap looping from it, lying on the table. Strap material: a woven fabric or soft leather in a warm grey that sits with
  the warm-white body. Static in the GLB.

Rough top-face layout (not to scale):

```
 ┌──────────────────────────────────────────┐
 │   .  .  .  .                 [ I ═○  ]    │  slide power
 │ .  ┌──────┐  .               ●            │  memory light
 │ .  │ lens │  .                            │
 │ .  └──────┘  .           [‹] [ ⤨ ] [›]   │  back · shuffle · next
 │   .  .  .  .                              │
 └──────────────[ front lens ]──────────────┘
  ○═ strap lug at the back corner on the lens side
```

GLB object names the component relies on: `body`, `power_button`, `key_back`, `key_shuffle`, `key_next`, `memory_led`,
`strap`. Material names keep ZL 2's where they exist so `makeMaterials()` keeps working, plus `memory_led`.

Re-bake `shadow.png` and `ao.jpg` in Cycles (CPU here). Akzidenz fonts are not available here; ZL 3 must not need them.

### 3. Interaction

- **Power** (slide, `P`): on → the beam grows, the current memory's dots rise out of the lens, the crawl fades in.
  Off → reverse. Starts off on the homepage, as today.
- **Back / next** (click the keys, `←` / `→`): previous / next memory in manifest order, wrapping around. Each press
  depresses its key with the existing key spring and click sound.
- **Shuffle** (click, `S` or `Enter`): a random memory, never the one showing.
- **Switching memory**: the current dots pour back down into the lens and the next memory's dots shoot up into place —
  the existing transition between subjects — while the crawl dissolves and restarts with the new story.
- **Memory light**: glows softly while a memory is being shown for the first time in this browser ("developing"), and on
  that first showing the dots assemble out of the lens more slowly. Seen-state is per browser (`localStorage`, wrapped in
  try/catch; without it, every memory counts as new).
- Lift-and-drop (`movable`), table scene, orbit mode and the scene lab keep working as today.
- With no memories loaded, power still works: the beam and mist appear with no figure and no crawl.

### 4. The hologram (playback)

- The memory's MP4 plays in a hidden `<video>` (muted, `loop`, `playsinline`) as a texture.
- A fixed grid of dots (resolution matched to the depth half, e.g. ~160 rows) samples the frame in the vertex shader:
  depth half → black means discard; otherwise depth sets the dot's distance toward the viewer; brightness half sets the
  dot's intensity. A back surface is mirrored behind so turning shows volume, as `holo-scenes.js` does.
- Look, inspired by Star Wars holograms: monochrome blue, translucent, horizontal scanlines drifting up, brightness
  flicker, occasional horizontal shear/glitch bands, slight noise. On a light page the hologram is drawn as blue ink
  (brighter = denser blue), as today, so it reads on `#e4e4e2`.
- Keeps the beam cone, the rising motes and the mist from the perforation ring.
- Size and placement: the people stand on the hologram's foot above the top lens, fitted into the existing `HOLO` frame.
- Reduced motion: no flicker or glitches; the clip shows its first frame as a still; switching is a plain dissolve.

### 5. The table crawl

- Projected from the front lens onto the table in front of the device, in the beam's blue (as the year is today).
- The story paragraph: left-aligned, no heading, in the page's sans-serif. Not the Star Wars typeface or colour.
- Within a fixed projected rectangle on the table, the text scrolls away from the viewer (up the screen, toward the lens),
  fading in at the near edge and out at the far edge; perspective comes from the table itself.
- Speed: a reading pace, set by a constant (start around 2 words per second of text passing the middle of the rectangle);
  tune by eye. When the paragraph has gone, a pause, then it starts again.
- Stories are a paragraph; the engine page warns above about 120 words.
- Accessibility: the full story is also in the component's live region / accessible description, so it is readable
  without the animation.

### 6. The engine page

Runs in Adán's browser. Not linked from anywhere, `noindex`. It is publicly reachable on the static host, which is
harmless: it processes locally and writes nothing to the site.

Flow:

1. **Load**: drop a video. If longer than 7 s, choose the start with a slider; 7 s is taken from there.
2. **Write**: the story paragraph (with word count), optional short title (used only for screen readers and events), and
   an optional date (for ordering).
3. **Process**, in stages, each visible as it runs:
   1. **Frames** — decode at ~12 fps (≈85 frames).
   2. **Cut-out** — a person-segmentation model separates the people in every frame; masks smoothed over time so edges
      don't boil. Must handle several people, small children and full bodies. Candidates for the builder to evaluate:
      MediaPipe Image Segmenter (models served from `storage.googleapis.com`), Robust Video Matting (ONNX), or the
      models in `@imgly/background-removal`.
   3. **Depth** — distance-transform inflation of the silhouettes plus shading relief, smoothed over time. A separate,
      swappable stage.
   4. **Dots** — a live preview using the device's own playback shader.
4. **Frame and loop**: the crop is the union of the people's bounds across the clip, so they stand on the hologram's
   foot without jumping. The last ~0.5 s crossfades into the first so the loop has no seam.
5. **Coarseness**: the depth video is small (around 256 px tall per half) so faces don't resolve.
6. **Export**: encodes the side-by-side frames to H.264 MP4 (WebCodecs + an MP4 muxer such as `mp4-muxer`), and downloads
   `<id>.mp4` plus an updated `memories.json` (it loads the current manifest and adds or replaces the entry). Adán drops
   both into `memory-projector/memories/` and commits.
7. **Show the engine**: a stage view with the four stages side by side while the clip plays; "Save still" (PNG) and
   "Record clip" (records that view as a short video).

Manifest entry:

```json
{ "id": "kids-park", "src": "kids-park.mp4", "story": "…", "title": "Playing at the park", "date": "2026-06-14",
  "fps": 12, "seconds": 7, "aspect": 0.8 }
```

### 7. Component API

`<memory-projector>` keeps the Temporal Projector's scene and placement API so the homepage and scene lab carry over:
`table`, `movable`, `power`, `src`, `shadow`, `ao`, `zoom`, `muted`; `--stage-x/-y/-scale`; `setScene`, `getScene`,
`tickers`, `floorRay`, `toScreen`, `keyLight`, `lightDir`, `rig`, `footprintSDF`, `roomSDF`, `footprint()`,
`hologramHit(x, y)`.

New or changed:

- Attribute `memories`: URL of a manifest (default `./memories/memories.json` next to the script).
- Methods: `setMemories(list)`, `next()`, `back()`, `shuffle()`, `show(id)`, `togglePower()`.
- `anchor(part)`: `power`, `back`, `shuffle`, `next`, `light`, `lens`, `hologram`.
- Events: `memorychange` → `{ id, index, title, story }`; `powerchange` → `{ on }`.
- `state`: `{ power, index, id }`.

Removed: `date`, `setDate`, `randomFuture`, `setContent`, `datechange`, the dial and the dithered-image hologram.

### 8. Homepage

- Swap `<temporal-projector>` for `<memory-projector table movable power="off">`, keeping its placement CSS.
- Replace the `DATES`/`FUTURES` content with the memories manifest.
- Update code that depends on dates: `faceHit` (checks `projected === '2026'`), the hint and anything listening for
  `datechange`. The scene lab keeps working through `getScene`/`setScene`.
- The paper letter, contact links and pill are unchanged.

## Constraints

- Static site, no build step: ES modules from a CDN via an import map (three.js 0.170.0 today).
- From this container, `cdn.jsdelivr.net`, `unpkg.com` and `huggingface.co` are blocked; npm and
  `storage.googleapis.com` are reachable. Testing here needs local copies of dependencies (from npm) served alongside the
  page; the shipped pages keep using the CDN.
- Must run on mobile (iOS Safari): H.264 MP4, muted inline autoplay, shader limits as today.
- Memory files: target ≤ 2 MB each.

## Left to the builder

- Segmentation model choice (criteria above), the exact inflation/relief parameters, temporal smoothing.
- Dot grid resolution, dot size, the exact scanline/flicker/glitch shader.
- Crawl rectangle size and position, font size, exact speed (tuned by eye from the starting point).
- Key, light and lug dimensions and exact positions on the case; strap material values.
- Engine page layout and styling (it is a tool; plain is fine).
- Whether to share code between `memory-projector.js` and `temporal-projector.js` or copy (copy is fine: the
  temporal projector is frozen).

## Calls made without asking (check these)

- New folder `memory-projector/` and element name `<memory-projector>`; `temporal-projector/` frozen.
- Archive the current homepage (tag + `archive/projector/`) before switching.
- Strap lug at the back corner on the lens side; strap static.
- Keyboard: `←`/`→` back/next, `S`/`Enter` shuffle, `P` power.
- "Developing" first showing, tracked per browser.
- Story length warning at ~120 words; crawl repeats after a pause.
- The engine page lives on the public static host, unlinked and `noindex`.
