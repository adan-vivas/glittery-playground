# Memory Projector — design

Date: 2026-11-23 (revised 2026-11-24 after review)
Status: approved 2026-11-24

## Intent

The Temporal Projector (a speculative palm-sized device that projected eras from 1996 to three plausible 2036s) becomes a
**personal holographic memory projector**: a device that tells Adán's story one memory at a time. Each memory is a short
moment from his life (for example, his son dancing in a Spider-Man suit) floating above the lens as a Star Wars–inspired
hologram, with a paragraph of the story crawling across the table in front of it. As a whole, the object is Adán's
"about me".

Why:

1. **A portable object for the new portfolio.** The final home of the projector is Adán's new portfolio. It must live in
   its own self-contained folder and drop into another site cleanly. On this repo's homepage it is an interim for a
   couple of days only.
2. **The engine is part of the story.** Adán is building the code that turns a clip into a 3D hologram and wants to talk
   about it (portfolio, write-ups, talks). The engine is the device's insides made visible.

### The speculative story (narrative only)

In this future we don't carry phones; we wear glasses. You hit record and capture your day. Moments you choose are sent
automatically to your projector, which *develops* them: your glasses remember flat, the projector makes them whole. One
day you could share holographic memories with others. The device has no camera; its only sign of capture is a small
light that glows when a new memory has arrived.

On the website, "arriving" means Adán commits a memory file produced by the engine page. Visitors only see memories that
have already arrived.

## Goals

- A `<memory-projector>` web component in its own folder, rendering the redesigned device with the existing renderer
  (three.js, table scene, lighting, shadows, materials, lift-and-drop, scene lab).
- Controls: **slide power** (on/off), **back**, **next**, **shuffle** (random memory). No dial.
- A **memory-arrived light** on the top face.
- A **carry loop**: a small metal lug at a back corner with a short wrist strap; carried in one hand.
- **Hologram**: each memory is a looping (≤ 7 s) 3D point-cloud reconstruction of the people (and what they hold or play
  with) in a real video, background removed, in a Star Wars–inspired hologram look.
- **Table crawl**: the memory's story as a left-aligned paragraph with no heading, projected from the front lens onto the
  table and scrolling away from the viewer in perspective, slow enough to read.
- **Engine page**: a page that runs only in Adán's browser. He loads a clip, picks who to keep, writes the story, watches
  it be rebuilt stage by stage, and exports a memory file. Adding a memory never needs Claude.
- The engine page shows its stages side by side and can export stills and a short clip of that view, for talking about it.
- Interim: the homepage switches from `<temporal-projector>` to `<memory-projector>`.

## Non-goals

- Visitor uploads, accounts, servers, or processing on a visitor's device beyond playback.
- Sharing memories between people (narrative only).
- Real per-frame depth estimation in v1 (the depth stage is swappable for it later).
- Changing the case's proportions or materials (ZL 2's 112 × 64 × 20 mm warm-white moulded body stays).
- Animating the strap when the device is lifted (rigid in v1).
- **Phones in v1.** The immersive experience is for desktop. Mobile gets whatever falls out naturally; how to solve it
  is a later conversation.
- Integrating into the new portfolio site itself (a later task; this work makes that a drop-in).

## Anti-goals (a failure even if it works)

- **Anyone but Adán seeing his videos.** Original clips never leave his Mac: they are not uploaded, not committed, not
  published. The engine processes them locally in the browser. What is published is depth only (see §6).
- Recognisable faces of his children anywhere public, including in the published files and in git history.
- Page controls attached to the object. Buttons such as "Talk to me" are never part of the device's design or its
  hologram; they are page UI that sits beside it.
- A literal Star Wars copy (logos, its typeface, the yellow crawl colour). Inspired, not copied.
- Story text that moves too fast to read comfortably.
- A memory taking more than about a second to start on a normal connection.

## Approaches considered

### How a memory gets into the device (story)

1. **Glasses/phone record, device develops — chosen.** No camera on the device; a light shows arrivals. Honest to how
   the engine works and keeps the device to four controls.
2. One lens records and projects (like the Lumières' 1895 Cinématographe). Rejected: you'd carry it to record, and it
   needs a fifth control.
3. Set the phone on the device to pour a memory in. Rejected: option 1 plus a landing pad on the case.

### What the hologram is made from

1. **Cut-out figures with inflated depth — chosen.** Separate the foreground in each frame; give silhouettes volume with
   a distance transform (thick in the middle, thin at the edges) — the technique `temporal-projector/holo-scenes.js`
   already uses on stills. Real motion, cheap, anonymous.
2. Real depth from a monocular depth model. Deferred: heavier, faces clearer. Depth is its own stage so this can replace
   it later.
3. Video-driven skeletons on faceless mannequins. Rejected: fiddly retargeting, most work.
4. Hand-modelled generic figures from reference photos. Rejected: a Blender session per memory; stiff animation.

### What the engine publishes, and how the device plays it

1. **Depth video — chosen**, then narrowed by the privacy decision below. One small H.264 MP4 per memory; the GPU
   rebuilds the dots from it as it plays. Small (well under 1 MB), smooth, and the swappable depth stage writes straight
   into it.
2. Baked dot clouds per frame. Rejected: 10–15 MB per memory, slower to load, harder to change.

### What the published file contains (privacy)

1. **Depth only — chosen.** The file holds only the coarse shape: a greyscale map of how far each part of the figures is
   from the camera, black where there is no one. No colour, texture or faces. Opened directly it is a soft grey moving
   silhouette. The hologram's light and shade come from that shape. Fine surface detail (e.g. a costume's web pattern) is
   lost, which suits the monochrome hologram.
2. Depth plus a blurred greyscale picture. Rejected: opened directly, the file is a recognisable, if blurry, video of
   the children.

### How the case is changed

Edit the ZL 2 Blender script into ZL 3 and export a new GLB, running Blender here as the `bpy` Python package (5.x
installs on the container's Python 3.13). Building the case in three.js instead was rejected: the case already exists
as a procedural Blender script with baked Cycles shadow and AO.

## The design

### 1. Folder and files

A self-contained folder, `memory-projector/`, modelled on `temporal-projector/`:

| Path | What |
| --- | --- |
| `memory-projector/memory-projector.js` | `<memory-projector>` web component |
| `memory-projector/index.html` | Demo page: the device in its own environment |
| `memory-projector/engine/index.html` (+ `engine/*.js`) | The engine page (unlinked, `noindex`) |
| `memory-projector/memories/memories.json` | Manifest of memories, in story order |
| `memory-projector/memories/<id>.mp4` | One depth-only video per memory |
| `memory-projector/assets/` | `memory-projector.glb`, `shadow.png`, `ao.jpg` |
| `memory-projector/blender/memory_projector.py` | ZL 3 procedural model (from root `zeitlinse.py`, which is ZL 2) |
| `memory-projector/blender/export_web.py` | Bakes shadow + AO, exports GLB (from root `export_web.py`) |
| `memory-projector/README.md` | Using the component, running the engine, rebuilding the model, the privacy rules |

Nothing in the folder may reference files outside it, so it can be copied into the new portfolio as is. The memories
manifest URL is an attribute, so the portfolio can keep its memories wherever it likes.

`temporal-projector/` stays untouched as the earlier experiment. Before the homepage switches, the current homepage is
tagged `homepage-v2-projector` and copied to `archive/projector/`, per the README's convention.

A `.gitignore` rule keeps common source-video formats (`*.mov`, `*.MOV`, `*.heic`, `*.hevc`, `*.m4v`, …) out of
`memory-projector/` except `memories/*.mp4`, as a guard against committing an original by accident.

### 2. The device (ZL 3)

Starts from ZL 2 (root `zeitlinse.py`): same body, footprint, materials, top fog-projection lens with its perforation
ring, front rectangular projection aperture, slide power toggle with the green strip it uncovers.

Changes:

- **Crown removed**, and its pocket in the right end face closed.
- **Shuffle key** stays a rectangular key, now centred in a row between smaller **back** and **next** keys. Icons are
  geometry, engraved or printed in the trim grey: `‹`, a shuffle glyph (two crossing arrows), `›`. No fonts needed.
- **Memory light**: a small round emissive dot near the power slide, with its own material so the page drives it.
- **Carry loop**: a small metal lug at the back corner on the lens side (away from the controls) and a short flat wrist
  strap looping from it, lying on the table. Strap: woven fabric or soft leather in a warm grey that sits with the
  warm-white body. Static in the GLB.

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

Re-bake `shadow.png` and `ao.jpg` in Cycles (CPU here). Akzidenz fonts aren't available here; ZL 3 must not need them.

### 3. Interaction

- **Power** (slide, `P`): on → the beam grows, the current memory's dots rise out of the lens, the crawl fades in.
  Off → reverse. Starts off on the homepage, as today.
- **Back / next** (click the keys, `←` / `→`): previous / next memory in manifest order, wrapping around. Keys depress
  with the existing key spring and click sound.
- **Shuffle** (click, `S` or `Enter`): a random memory, never the one showing.
- **Switching memory**: the current dots pour back down into the lens and the next memory's dots shoot up into place —
  the existing transition between subjects — while the crawl dissolves and restarts with the new story.
- **Memory light**: glows softly while a memory is shown for the first time in this browser ("developing"); on that
  first showing the dots assemble out of the lens more slowly. Seen-state is per browser (`localStorage`, wrapped in
  try/catch; without it every memory counts as new).
- Lift-and-drop (`movable`), table scene, orbit mode and the scene lab keep working as today.
- With no memories loaded, power still works: beam and mist, no figure, no crawl.
- The hologram is not a button. `hologramHit()` stays in the API for pages that need geometry, but the component itself
  attaches no page actions to it.

### 4. The hologram (playback)

- The memory's MP4 plays in a hidden `<video>` (muted, `loop`, `playsinline`) as a texture.
- A fixed grid of dots, matched to the depth map's resolution, samples each frame in the vertex shader: black → discard;
  otherwise the value sets the dot's distance toward the viewer. A mirrored back surface gives volume when it turns, as
  `holo-scenes.js` does.
- Shading comes from the shape: normals from the depth map's gradient give a soft key from the top left, a rim, and
  ridges catching light — the same shading language as the current point clouds. Thin parts (arms, edges) glow a little.
- Look, inspired by Star Wars holograms: monochrome blue, translucent, horizontal scanlines drifting up, brightness
  flicker, occasional horizontal shear/glitch bands, slight noise. On the light page the hologram is drawn as blue ink
  (brighter = denser blue), as today, so it reads on `#e4e4e2`.
- Keeps the beam cone, the rising motes and the mist from the perforation ring.
- The figures stand on the hologram's foot above the top lens, fitted into the existing `HOLO` frame.
- Reduced motion: no flicker or glitches; the first frame shows as a still; switching is a plain dissolve.

### 5. The table crawl

- Projected from the front lens onto the table in front of the device, in the beam's blue (as the year is today).
- The story paragraph: left-aligned, no heading, in the page's sans-serif. Not the Star Wars typeface or colour.
- Within a fixed projected area on the table, the text scrolls away from the viewer (up the screen, toward the lens),
  fading in at the near edge and out at the far edge; the table gives the perspective. The area may spread wider than
  the device so it stays readable on desktop; size tuned by eye from screenshots.
- Speed: a reading pace, set by a constant (start around 2 words per second); tuned by eye. When the paragraph has gone,
  a pause, then it starts again.
- Stories are a paragraph; the engine page warns above about 120 words.
- Accessibility: the full story is also in the component's live region, readable without the animation.

### 6. The engine page

Runs in Adán's browser; target **Chrome on his Mac**. Unlinked, `noindex`. It's reachable on the static host, which is
harmless: it processes locally and sends nothing anywhere (models load from their CDNs; the video never leaves the
machine). If a clip won't decode (some iPhone HEVC/HDR clips), export it from Photos as "Most Compatible" first.

Flow:

1. **Load**: drop a video. If longer than 7 s, choose the start with a slider; 7 s is taken from there.
2. **Write**: the story paragraph (with word count), an optional short title (screen readers and events only), and an
   optional date (ordering).
3. **Pick who to keep**: the first frame shows everything the cut-out model found as foreground, outlined. Click to keep
   or drop each figure — e.g. keep the boy, drop his reflection in the mirror. Kept figures are followed through the
   clip (by overlap from frame to frame).
4. **Process**, in stages, each visible as it runs:
   1. **Frames** — decode at ~12 fps (≈85 frames).
   2. **Cut-out** — a general foreground matting model, so people *and* what they hold or play with (a ball, a swing,
      a dog) stay. Masks are smoothed over time so edges don't boil. Candidates for the builder to evaluate: Robust Video
      Matting (ONNX), the models in `@imgly/background-removal`. Person-only models (MediaPipe) don't fit.
   3. **Steady** — clips are often handheld and moving. Per frame, find the kept figures' ground point (lowest part of
      the silhouette) and centre; smooth both over time; re-centre and re-scale each frame so the figures stand still on
      the hologram's foot while they move naturally. If feet are cut off, anchor on the bottom of the silhouette and fade
      it out like it's sinking into the beam.
   4. **Depth** — distance-transform inflation of the silhouettes, plus relief from the frame's own shading (used only
      inside the engine; it does not reach the file), smoothed over time. A separate, swappable stage.
   5. **Dots** — a live preview using the device's own playback shader.
5. **Loop**: the last ~0.5 s crossfades into the first, so the loop has no seam.
6. **Public check**: before export, the page plays exactly what will be published — the raw depth-only file — labelled
   "This is what anyone can download".
7. **Export**: encodes the depth frames (about 256 px tall, greyscale) to H.264 MP4 (WebCodecs + an MP4 muxer such as
   `mp4-muxer`), and downloads `<id>.mp4` plus an updated `memories.json` (it loads the current manifest and adds or
   replaces the entry). Adán drops both into `memories/` and commits. The original is never written anywhere.
8. **Show the engine**: a stage view with the stages side by side while the clip plays; "Save still" (PNG) and "Record
   clip" (records that view). These include the original video, so they are for Adán's own use; the page says so.

Manifest entry:

```json
{ "id": "spider-dance", "src": "spider-dance.mp4", "story": "…", "title": "Spider-Man in the hallway",
  "date": "2026-10-31", "fps": 12, "seconds": 7, "aspect": 0.56 }
```

**Testing without originals**: while building, the engine is developed against a still frame Adán shared (kept only in
the session's scratch space, never committed) animated with synthetic camera shake and motion, plus synthetic shapes.
Final tuning happens on Adán's real clips, on his machine.

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

### 8. Homepage (interim)

- Swap `<temporal-projector>` for `<memory-projector table movable power="off">`, keeping its placement CSS.
- Replace the `DATES`/`FUTURES` content with the memories manifest.
- Remove the "Talk to me" face zone (`faceHit` and its `'face'` case in `zoneAt`); the pill stays the page's own control.
  Update the hint and anything listening for `datechange`. The scene lab keeps working through `getScene`/`setScene`.
- The paper letter, contact links and pill are otherwise unchanged.
- This is the last step, done on the branch; it goes live when Adán has committed his first memories.

## Constraints

- Static site, no build step: ES modules from a CDN via an import map (three.js 0.170.0 today).
- From this container, `cdn.jsdelivr.net`, `unpkg.com` and `huggingface.co` are blocked; npm and
  `storage.googleapis.com` are reachable. Testing here uses local copies of dependencies (from npm) served alongside the
  page; the shipped pages keep using the CDN. Model weights the engine needs must load in Adán's browser; for testing
  here they must also be obtainable from npm or a reachable host.
- Desktop first (Chrome, Safari, Firefox current versions). Mobile not targeted in v1.
- Memory files: target well under 1 MB each.

## Left to the builder

- Matting model choice (criteria above), inflation parameters, temporal smoothing, steadying filter.
  - **Decided (2026-11-24):** BiRefNet-lite (MIT, onnx-community/BiRefNet_lite-ONNX) on WebGPU through onnxruntime-web
    1.31.1, half precision where the GPU supports it; it keeps held objects. It needs WebGPU (at its fixed 1024 px input
    it does not fit in WebAssembly's 4 GB) and a GPU allowing 11 storage buffers per shader (Macs do; SwiftShader does
    not). Fallback: MODNet (Apache-2.0), portrait matting, runs anywhere, ~3.5 s/frame on CPU here; the engine page says
    when it falls back and that held objects may be lost. On the reference frame both cut the boy out cleanly (body
    alpha 0.93, floor 0.00) and neither picked up the mirror reflection. Rejected: @imgly/background-removal (AGPL),
    Robust Video Matting (GPL-3.0), RMBG (non-commercial), MediaPipe (people only).
- Dot grid resolution, dot size, the exact scanline/flicker/glitch shader, depth-derived shading.
- Crawl area size and position, font size, exact speed (tuned by eye).
- Key, light and lug dimensions and exact positions; strap material values.
- Engine page layout and styling (a tool; plain is fine).
- Copy rather than share code between `memory-projector.js` and `temporal-projector.js` (the temporal projector is
  frozen).

## Calls made without asking (check these)

- Folder `memory-projector/`, element `<memory-projector>`; `temporal-projector/` frozen.
- Archive the current homepage (tag + `archive/projector/`) before the interim switch.
- Strap lug at the back corner on the lens side; strap static.
- Keyboard: `←`/`→` back/next, `S`/`Enter` shuffle, `P` power.
- "Developing" first showing, tracked per browser.
- Story length warning at ~120 words; crawl repeats after a pause.
- Engine page lives on the public static host, unlinked and `noindex`; it uploads nothing.
- A `.gitignore` guard against committing original video formats.
- Engine target: Chrome on Mac; "Most Compatible" export as the fallback for clips that won't decode.
