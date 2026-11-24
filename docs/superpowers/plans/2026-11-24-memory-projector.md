# Memory Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Temporal Projector into a self-contained `<memory-projector>`: a redesigned ZL 3 device (power, back,
shuffle, next, memory light, carry strap) that plays depth-only memory videos as Star Wars–inspired holograms with a story
crawl on the table, plus a private in-browser engine page that turns a clip into such a memory.

**Architecture:** Everything lives in `memory-projector/`. The component is forked from
`temporal-projector/temporal-projector.js` (frozen) and keeps its renderer and scene API; the dial, dated content and
dithered/point-cloud subjects are replaced by a playlist, a GPU depth-video hologram (`holo-depth.js`) and a canvas crawl.
The engine is a static page whose pure stages (figures, steady, depth, loop, manifest) are plain ES modules tested in
Node; browser-only parts (frame extraction, matting, H.264 encoding, UI) are tested in headless Chromium via Playwright.
One shared module, `lib/depth-format.js`, fixes how depth is written into and read out of the video.

**Tech Stack:** three.js 0.170.0 (import map, CDN), WebGL2 shaders, WebCodecs + `mp4-muxer` 5.2.2, a browser matting
model chosen in Task 8, Blender 5.3 as the `bpy` Python package (Cycles CPU), Node 22 `node --test`, Playwright Chromium
(pre-installed), ffmpeg/libx264 for fixtures.

**Spec:** `docs/superpowers/specs/2026-11-23-memory-projector-design.md` (approved). Read it before any task.

## Global Constraints

- Everything new lives in `memory-projector/`; nothing in it may reference files outside it. `temporal-projector/` is not modified.
- Static site, no build step: pages load three.js 0.170.0 and other deps from `https://cdn.jsdelivr.net/npm/...` via import map. Tests reroute those URLs to `memory-projector/node_modules` (the CDN is blocked in this container).
- **Privacy:** original videos are never committed, uploaded or written anywhere. Published memory files are depth only. The private reference frame lives only at the path in env `MP_PRIVATE_FRAME` (scratch space); tests that need it skip when it is unset, and nothing derived from it is committed.
- Depth file format (`lib/depth-format.js`, verbatim): `SIZE = 256` (square frames), `FPS = 12`, `MAX_SECONDS = 7`, empty pixel value `0`, empty threshold `EMPTY_BELOW = 32` (luma < 32 ⇒ no figure), figure depth `d ∈ [0,1]` (1 = nearest) stored as `64 + round(d * 191)`, decoded `d = (v - 64) / 191`.
- Encoding: H.264 `avc1.42001f`, 400 kbps, 12 fps, MP4 via `mp4-muxer` with `fastStart: 'in-memory'`. Target well under 1 MB per memory.
- Element `<memory-projector>`; GLB object names `body`, `power_button`, `key_back`, `key_shuffle`, `key_next`, `memory_led`, `strap`; material `memory_led`.
- Keyboard: `←`/`→` back/next, `S` or `Enter` shuffle, `P` power. Events `memorychange` `{ id, index, title, story }`, `powerchange` `{ on }`.
- Hologram look: monochrome blue ink (`HOLO_INK` from the old component), scanlines, flicker, glitch bands; reduced motion ⇒ none of those, still first frame, plain dissolve.
- Crawl: left-aligned, no heading, page sans-serif, beam blue; never the Star Wars typeface or yellow.
- No page actions attached to the device or the hologram (no "Talk to me" on the model).
- Desktop first; mobile not targeted.
- Commit after every task; commit messages end with the session's attribution lines.

## Review Focus

1. **Missing or broken data**: manifest 404 / invalid JSON / an entry whose `.mp4` 404s ⇒ device still powers on with beam and mist, no figure, no crawl for that entry, one `console.warn`, no thrown error. (Tests in Task 3 and Task 4.)
2. **Rapid input during a transition**: pressing next five times in 300 ms ⇒ it settles on the memory five steps on, with that memory's figure risen and its crawl showing; no frozen half-drained state. (Test in Task 4.)
3. **Autoplay refused**: `video.play()` rejects ⇒ the hologram shows the first frame still, and retries on the next power-on or next/back. (Test in Task 4.)
4. **Story extremes**: empty story ⇒ no crawl, no error; 400-word story ⇒ crawl still loops with the pause, lines never exceed the area's width; a single 60-character word wraps by breaking. (Tests in Task 5.)
5. **Figures leaving frame / short clips**: frames where the kept figures vanish ⇒ empty depth frames, steadying holds the last good transform; a 3 s clip ⇒ 36 frames, no padding to 7 s. (Tests in Task 9.)

---

### Task 1: Dev harness and depth format

**Files:**
- Create: `memory-projector/package.json`, `memory-projector/.gitignore`, `memory-projector/lib/depth-format.js`
- Create: `memory-projector/tests/helpers/browser.mjs`, `memory-projector/tests/depth-format.test.mjs`, `memory-projector/tests/harness.test.mjs`
- Create: `memory-projector/tests/fixtures/make-demo.py`, outputs `memory-projector/demo/demo-dance.mp4`, `memory-projector/demo/memories.json`

**Interfaces:**
- Produces: `lib/depth-format.js` exports `SIZE, FPS, MAX_SECONDS, EMPTY_BELOW, encodeDepthValue(d: number) → number (0..255)`, `decodeDepthValue(v: number) → number | null` (null when empty), `encodeDepthFrame(depth: Float32Array, out?: Uint8ClampedArray) → Uint8ClampedArray` (0 ⇒ empty in, 0 out).
- Produces: `tests/helpers/browser.mjs` exports `async openPage(path: string, { reducedMotion?, storageState?, onConsole? }) → { page, browser, errors: string[], close() }`. It serves the repo root on an ephemeral localhost port (secure context, needed for WebCodecs), launches Playwright Chromium, and routes `https://cdn.jsdelivr.net/npm/three@0.170.0/*` and `https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/*` to `memory-projector/node_modules`. Collects page errors and `console.error`.
- Produces: `demo/memories.json` — one synthetic memory `{ id: "demo-dance", src: "demo-dance.mp4", story, title, fps: 12, seconds: 7, aspect: 1 }` (synthetic figure only; safe to commit).

- [ ] **Step 1:** `package.json` (`"private": true`, `"type": "module"`, devDependencies `three@0.170.0`, `mp4-muxer@5.2.2`, script `"test": "node --test tests/"`); `.gitignore` with `node_modules/` and the source-video guard: `*.mov *.MOV *.m4v *.hevc *.heic *.HEIC *.avi *.mkv`, and `*.mp4` except `!memories/*.mp4` and `!demo/*.mp4`. `npm install` in `memory-projector/`.
- [ ] **Step 2: Write failing tests** `depth-format.test.mjs`:

```js
test('round-trips depth', () => {
  for (const d of [0, 0.25, 0.5, 1]) assert.ok(Math.abs(decodeDepthValue(encodeDepthValue(d)) - d) < 1 / 191);
});
test('empty stays empty', () => {
  assert.equal(decodeDepthValue(0), null); assert.equal(decodeDepthValue(31), null);
  assert.equal(encodeDepthValue(0), 64);           // nearest-far figure pixel is still a figure
  const f = encodeDepthFrame(new Float32Array([0, 0.5, NaN]));   // 0 in the depth map means "no figure"
  assert.deepEqual([...f], [0, 160, 0]);
});
```

  Note: in a depth *map* (`Float32Array`), `0` and `NaN` mean "no figure"; a figure pixel's depth is `> 0`. `encodeDepthFrame` maps `d > 0` to `64 + round(d*191)`.
- [ ] **Step 3:** Run `npm test` in `memory-projector/` → FAIL (module missing). Implement `lib/depth-format.js`. Run → PASS.
- [ ] **Step 4:** `make-demo.py` (numpy + ffmpeg/libx264, `-pix_fmt yuv420p -profile:v baseline`, 256×256, 12 fps, 84 frames, constants copied from `depth-format.js` with a comment pointing there): a synthetic dancing figure (ellipsoid torso, sphere head, capsule arms/legs swaying, depth from the ellipsoid profile) and a ball bouncing beside it. Write `demo/demo-dance.mp4` and `demo/memories.json` with a ~70-word placeholder story in English that clearly reads as a demo. Check `ffprobe` shows h264 256×256 12 fps and the file is < 500 KB.
- [ ] **Step 5: Write `harness.test.mjs`**: `openPage('/temporal-projector/index.html')` reaches `temporal-projector[data-ready]` within 20 s with `errors.length === 0`. Run → PASS (proves routing + WebGL).
- [ ] **Step 6: Commit** `memory-projector/` (no `node_modules`).

### Task 2: ZL 3 device model

**Files:**
- Create: `memory-projector/blender/memory_projector.py` (from root `zeitlinse.py`, ZL 2), `memory-projector/blender/export_web.py` (from root `export_web.py`)
- Create: `memory-projector/assets/memory-projector.glb`, `memory-projector/assets/shadow.png`, `memory-projector/assets/ao.jpg`
- Test: `memory-projector/tests/glb.test.mjs`

**Interfaces:**
- Produces: GLB with top-level nodes `body`, `power_button`, `key_back`, `key_shuffle`, `key_next`, `memory_led`, `strap`; materials keep ZL 2's names (the old component's `makeMaterials()` keys, e.g. `coated_glass`, `front_core`, `projector_core`, `power_on`, `led_green`) plus `memory_led`. Units metres, same origin and top height as ZL 2 (`TOP_Y = 0.021`).
- Produces (for Task 3): the world positions of each key's top centre, the LED, and the lens, printed by the export script and copied into constants in `memory-projector.js`.

- [ ] **Step 1: Write failing `glb.test.mjs`**: parse the GLB's JSON chunk (no deps: read header, chunk 0). Assert node names include all seven above; exclude `dial`, `prf_key`, `crown`, `crown_axle`; a material named `memory_led` exists; the `body` mesh's POSITION accessor min/max span x ≈ 0.112 and z ≈ 0.064 (±0.001). Run → FAIL (no GLB).
- [ ] **Step 2:** `pip install bpy==5.3.0` (wheel cached in the scratch dir from planning is fine). Confirm `python3 -c "import bpy; print(bpy.app.version)"`.
- [ ] **Step 3:** Edit `memory_projector.py` per spec §2: drop the crown, crown axle and `pocket_cut` (the right end face stays closed); replace the single shuffle key with a row centred where `KEY_C` is: `key_shuffle` (the current key's size), `key_back` and `key_next` (smaller, ~9 × 9 mm, 2.5 mm gaps), icons as thin extruded/inset geometry in the trim grey (`‹`, two crossing arrows, `›`), named `<key>_icon*`; `memory_led` a ~2.2 mm emissive dot near the power slide; a small metal lug at the back corner on the lens side plus a flat ~10 mm-wide strap loop (~70 mm long) lying on the table, woven warm-grey material, no fonts anywhere. Keep everything else. Header comment says ZL 3.
- [ ] **Step 4:** Edit `export_web.py`: GROUPS become `key_back`, `key_shuffle`, `key_next` (each with its icons), `power_button`, `memory_led`, `strap`; output `memory-projector.glb`, `shadow.png`, `ao.jpg` into `memory-projector/assets/`; print each group's top-centre world position. Run `python3 memory-projector/blender/export_web.py -- memory-projector/assets` (adapt the invocation: with `bpy` as a module the script runs under plain `python3`; keep `sys.argv` parsing working for both).
- [ ] **Step 5:** Run `npm test` → `glb.test.mjs` PASS.
- [ ] **Step 6:** Render a hero still (`python3 memory-projector/blender/memory_projector.py -- <scratch>/zl3_hero.png hero 1200 1500 64`) and a top view; look at them; send them to Adán. Fix anything that looks wrong before committing.
- [ ] **Step 7: Commit.**

### Task 3: Component fork, controls and playlist

**Files:**
- Create: `memory-projector/memory-projector.js` (forked from `temporal-projector/temporal-projector.js`), `memory-projector/lib/playlist.js`
- Create: `memory-projector/index.html` (demo page, `memories="./demo/memories.json"`, controls legend: power, back/next, shuffle)
- Test: `memory-projector/tests/playlist.test.mjs`, `memory-projector/tests/component.test.mjs`

**Interfaces:**
- Consumes: GLB names and positions from Task 2.
- Produces: `lib/playlist.js` → `createPlaylist(memories: Memory[], rng = Math.random) → { size, index, current: Memory|null, next(), back(), shuffle(), show(id: string) → boolean }` (each mover returns the new `current`).
- Produces: `class MemoryProjector extends HTMLElement`, registered as `memory-projector`; attributes `table movable power src shadow ao zoom muted memories`; `setMemories(list) → Promise`, `next()`, `back()`, `shuffle()`, `show(id)`, `togglePower()`, `state: { power, index, id }`, `anchor(part)` for `power|back|shuffle|next|light|lens|hologram`, plus the unchanged scene API listed in spec §7. Internal hook for later tasks: `this._onMemory(memory, { first: boolean })` called on every change of current memory (power on included), and `this._content` replaced by `this.playlist`.

- [ ] **Step 1: Write failing `playlist.test.mjs`**: next/back wrap (3 items: next×3 returns to index 0; back from 0 → 2); `shuffle()` with 3 items never returns the current id (200 tries with `Math.random`); with 1 item returns it; empty list ⇒ `current === null` and movers return null; `show('nope') === false` and index unchanged.
- [ ] **Step 2:** Run → FAIL; implement; run → PASS.
- [ ] **Step 3: Write failing `component.test.mjs`** using `openPage('/memory-projector/index.html')`:
  - ready within 20 s, no errors; `state.index === 0`, `state.power === false`;
  - `el.next()` fires `memorychange` with `id` of entry 1 (add a second synthetic entry to a test manifest served via `page.route`);
  - clicking at `anchor('next')` advances; `anchor('back')` goes back; pressing `S` changes id; `P` toggles `powerchange`;
  - **Review Focus 1:** manifest route returns 404 ⇒ ready, `togglePower()` works, no page errors, exactly one warning containing `memories`;
  - legacy API gone: `el.setDate === undefined`.
- [ ] **Step 4:** Run → FAIL. Fork the component: rename class/element; load `assets/memory-projector.glb`; remove `DATES`, the crown/dial springs, drag/wheel on the dial, `setDate`, `randomFuture`, `setContent`, `datechange`, `holo-scenes.js` imports and the dithered image + point-cloud subjects (keep beam, motes, mist, lens glow, the floor projection plane); bind the three keys (raycast picks, invisible hit boxes, a key spring each, click sound); add `memories` fetch (default `new URL('./memories/memories.json', import.meta.url)`), playlist, events, keyboard, anchors. Leave `_onMemory` as a stub that the next tasks fill.
- [ ] **Step 5:** Run → PASS. Screenshot the demo page (power off and on) and look at it.
- [ ] **Step 6: Commit.**

### Task 4: Depth-video hologram

**Files:**
- Create: `memory-projector/holo-depth.js`
- Modify: `memory-projector/memory-projector.js` (`_buildHologram`, `_onMemory`, `_tickHologram`, `hologramHit`)
- Test: `memory-projector/tests/hologram.test.mjs`

**Interfaces:**
- Consumes: `lib/depth-format.js` constants (as shader `#define`s), `HOLO` frame and `HOLO_INK` from the component.
- Produces: `class DepthHologram { constructor({ grid = 160, frame: { w, h, gap }, ink: THREE.Vector3, reduceMotion }); object3d: THREE.Object3D; async show(url: string|null, { developing = false }): Promise<void>; update(dt: number, t: number, { power: 0..1, glitch: 0..1 }); bounds(): THREE.Box3 }`. `show` sequences drain (0.6 s) → swap source → rise (0.9 s; 2.4 s when `developing`); a newer `show` call supersedes a pending one (latest wins).

- [ ] **Step 1: Write failing `hologram.test.mjs`** (Playwright on the demo page; power on, wait 3 s): count ink-blue pixels (b > r + 40 and b > g + 20) inside `anchor('hologram')`'s rect in a screenshot: > 800. Swap to an all-empty fixture video (generate with `make-demo.py --empty`) ⇒ < 50 inside the figure rect (beam excluded by sampling only the middle third horizontally above the beam's apex region; compute rect from `bounds()` via `toScreen`). **Review Focus 2:** call `next()` 5× within 300 ms with a 3-entry manifest ⇒ after 3 s `state.id` is entry `(0+5)%3` and the figure pixel count > 800. **Review Focus 3:** `page.addInitScript` stubs `HTMLMediaElement.prototype.play` to reject ⇒ figure pixel count still > 800 (first frame shown) and no page errors; restoring `play` and calling `next()` makes `video.paused === false`. **Review Focus 1:** entry with a 404 `src` ⇒ no page errors, one warning. Reduced motion context ⇒ two screenshots 500 ms apart inside the figure rect are identical.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `DepthHologram`: hidden `<video muted loop playsinline crossorigin>` → `THREE.VideoTexture` (nearest filtering so empty edges don't smear); `grid × grid` front dots plus a mirrored back layer (`aSide = ±1`); vertex shader samples luma, discards (moves off-screen) below `EMPTY_BELOW/255`, places the dot at `x,y` in the frame and `z = side * d * h * 0.5` scaled like the old cloud (`uDepth = HOLO.h * 0.5`); normals from a 3-tap gradient of the depth texture; shading as the old `HOLO_CLOUD_FS` language (key from top left, rim, thin parts glow). Hologram look in the fragment shader: scanlines drifting up (period ~ 1/90 of frame height), flicker (low-freq noise ±12%), glitch bands (rare, `uGlitch` driven), slight noise; all off under reduced motion. Drain/rise: per-dot delay from `aRand`; dots travel to/from the lens point (`uLensY`) as the old cloud did. Handle `play()` rejection by drawing the first decoded frame (`requestVideoFrameCallback` or `loadeddata`) and retrying `play()` on the next `show`/power-on.
- [ ] **Step 4:** Wire into the component: `_onMemory(m, { first })` → `holo.show(m ? resolve(m.src) : null, { developing: first })`; `hologramHit` uses `bounds()`; turn and lean behaviour toward the camera as the old cloud.
- [ ] **Step 5:** Run → PASS. Screenshot power-on mid-rise and steady; look at them against the spec's look.
- [ ] **Step 6: Commit.**

### Task 5: Story crawl on the table

**Files:**
- Create: `memory-projector/lib/crawl.js`
- Modify: `memory-projector/memory-projector.js` (`_drawProjection` replaced by `_drawCrawl`, projection plane size/position, live region)
- Test: `memory-projector/tests/crawl.test.mjs`, `memory-projector/tests/crawl-browser.test.mjs`

**Interfaces:**
- Produces: `wrapLines(text: string, measure: (s) => number, maxWidth: number) → string[]` (words; a word wider than `maxWidth` is broken across lines); `crawlState(t: number, { lineCount, lineHeight, viewHeight, wordsPerSecond = 2, words, pause = 2.5 }) → { offset: number, alpha: number }` — `offset` runs from `-viewHeight` (text below the near edge) to `lineCount*lineHeight` (gone past the far edge) over `max(words / wordsPerSecond, 4)` seconds, then holds `alpha = 0` for `pause` s, then repeats.
- Starting values (tune by eye, then record what you settled on in a comment): projection plane 0.15 m wide × 0.11 m deep, centred 0.105 m in front of the device centre on the table; canvas 1024 × 752; font `400 44px` page sans-serif; left margin 64 px; line height 1.35; fade 18 % at each end; colour as the old projection (beam blue).

- [ ] **Step 1: Write failing `crawl.test.mjs`**: wrap with `measure = s => s.length * 10`, width 100 ⇒ no line > 100; 60-char word ⇒ broken; empty string ⇒ `[]`. `crawlState`: 20 words ⇒ cycle = 10 s + 2.5 s; at t = 0 offset = −viewHeight; at t = 10 offset = lineCount × lineHeight; t ∈ (10, 12.5) ⇒ alpha 0; t = 12.5 restarts. **Review Focus 4:** 400 words ⇒ cycle 200 s + pause, offsets monotonic.
- [ ] **Step 2:** Run → FAIL; implement; run → PASS.
- [ ] **Step 3: Write failing `crawl-browser.test.mjs`**: after power on with the demo memory, the component's live region text includes the demo story; with an entry whose story is `""` no error and the projection canvas is fully transparent (read via `el._crawlCanvas` pixel sum).
- [ ] **Step 4:** Implement `_drawCrawl` (redraw the canvas each frame only while moving; perspective comes from the plane lying on the table; text moves toward the lens); dissolve on memory change; respect `projFade` for power. Run → PASS.
- [ ] **Step 5:** Screenshot at 1440×900 in the table scene (`table` attribute, as on the homepage) and in the demo page; check legibility; adjust size/speed; note final values in a comment.
- [ ] **Step 6: Commit.**

### Task 6: Memory light and "developing"

**Files:**
- Create: `memory-projector/lib/seen.js`
- Modify: `memory-projector/memory-projector.js`
- Test: `memory-projector/tests/seen.test.mjs`, `memory-projector/tests/light.test.mjs`

**Interfaces:**
- Produces: `createSeen(storage = safeLocalStorage(), key = 'memory-projector:seen') → { has(id): boolean, mark(id): void }`, never throws (storage getter or methods may throw; then all ids count as unseen and `mark` is a no-op).

- [ ] **Step 1: Write failing `seen.test.mjs`**: Map-backed storage round-trips; a storage whose `getItem`/`setItem` throw ⇒ `has` false, `mark` no throw; corrupted JSON ⇒ treated as empty.
- [ ] **Step 2:** Run → FAIL; implement; run → PASS.
- [ ] **Step 3: Write failing `light.test.mjs`**: fresh context, power on ⇒ `el.state.developing === true` and the LED glow sprite's opacity > 0.5 during the first 1.5 s; after 3.5 s `developing === false`; reload with the same `storageState` and power on ⇒ `developing === false` from the start.
- [ ] **Step 4:** Implement: `memory_led` material emissive driven by a spring (soft pulse while developing, off otherwise), a glow sprite at the LED position, `state.developing`, `_onMemory` passes `first = !seen.has(id)`, mark seen when the rise completes. Run → PASS.
- [ ] **Step 5: Commit.**

### Task 7: Demo page polish and README

**Files:**
- Modify: `memory-projector/index.html`
- Create: `memory-projector/README.md`

- [ ] **Step 1:** Demo page: device full-bleed like the old demo, footer legend (`01` power, `02` back / next, `03` shuffle) and a readout of the current memory's title; light page colours as the old demo.
- [ ] **Step 2:** README: what it is (the speculative story in 3–4 lines), files table, run the demo (`python3 -m http.server` from the repo root, open `/memory-projector/`), component usage and API (from spec §7), memory manifest format, how to add a memory with the engine (Task 10's flow), the privacy rules (originals never committed; depth-only files; `.gitignore` guard), rebuild the model (`pip install bpy==5.3.0`, the two commands), running tests (`npm install && npm test`).
- [ ] **Step 3:** Run the whole suite → PASS. Grep `memory-projector/` for `../` in URLs/imports outside `tests/` and `blender/` ⇒ none (self-contained).
- [ ] **Step 4: Commit.**

### Task 8: Matting model choice and wrapper

**Files:**
- Create: `memory-projector/engine/matte.js`
- Test: `memory-projector/tests/matte.test.mjs`
- Modify: `memory-projector/package.json` (the chosen library), spec's "Left to the builder" (record the decision)

**Interfaces:**
- Produces: `createMatter({ onProgress }) → Promise<{ name: string, license: string, segment(frame: ImageBitmap) → Promise<{ alpha: Float32Array, w: number, h: number }> }>` (alpha 0..1 at the frame's size or a fixed working size, stated in `w/h`); `createFakeMatter()` with the same shape that keys on magenta (`r > 200 && g < 60 && b > 200`) — the engine uses it when the URL has `?matter=fake` (tests only).

- [ ] **Step 1:** Evaluate candidates against the spec's criteria: keeps held objects and pets; handles a small child, full body; runs in Chrome on a Mac in < 1.5 s per frame at ≤ 512 px; weights loadable in Adán's browser from a CDN and, for tests, here (npm or a reachable host; `huggingface.co` is blocked here); licence fine for a public personal site. Candidates: `@huggingface/transformers` (Apache-2.0) with an MIT/Apache matting model (e.g. BiRefNet-lite, MODNet), `onnxruntime-web` (MIT) with Robust Video Matting, `@imgly/background-removal` (read `LICENSE.md`: if AGPL/commercial, it needs Adán's explicit OK). MediaPipe is out (people only).
- [ ] **Step 2:** If no candidate passing licence + quality has weights reachable here, **stop and ask Adán** (likely: allow `huggingface.co` for this environment). Do not pick a weaker model silently.
- [ ] **Step 3: Write failing `matte.test.mjs`** (browser): `createFakeMatter` on a magenta-disc canvas ⇒ alpha > 0.9 inside, < 0.1 outside. Real matter on a synthetic frame (`tests/fixtures/person.png`, a licence-free or self-made image of a person-like figure on a busy background; if none can be made convincingly, use `MP_PRIVATE_FRAME` and skip when unset): mean alpha over the figure box > 0.6, over the background corners < 0.1; time per frame logged.
- [ ] **Step 4:** Implement; run → PASS. Run on `MP_PRIVATE_FRAME` if set; save the mask to the scratch dir (never the repo) and look at it: boy kept, reflection present as a separate blob (to be dropped by picking).
- [ ] **Step 5:** Record the choice, licence and timings in the spec's "Left to the builder" section. **Commit** (no private-derived files).

### Task 9: Engine stages (pure)

**Files:**
- Create: `memory-projector/engine/figures.js`, `engine/steady.js`, `engine/depth.js`, `engine/loop.js`, `engine/manifest.js`
- Test: `memory-projector/tests/figures.test.mjs`, `steady.test.mjs`, `depth.test.mjs`, `loop.test.mjs`, `manifest.test.mjs`

**Interfaces:**
- `figures.js`: `labelFigures(alpha, w, h, { threshold = 0.5, minArea = 0.002 * w * h }) → { labels: Int32Array, figures: { id, area, box: [x0, y0, x1, y1], centroid: [x, y] }[] }` (4-connected; components < `minArea` dropped, label 0); `trackFigures(prevLabels, prevKeep: Set<number>, cur) → Set<number>` (keep a current figure when ≥ 20 % of its pixels were kept pixels last frame); `keepMask(alpha, labels, keep: Set<number>) → Float32Array`.
- `steady.js`: `measure(mask, w, h) → { ground: [x, y], height, cut: boolean } | null` (ground x = mean x of mask pixels in the lowest 10 % of the figure's rows, y = lowest row; `cut` when lowest row ≥ h − 2; `null` when empty); `smooth(values: number[], tau: number, fps = 12) → number[]` (forward-backward exponential, zero phase); `steadyTransforms(measures, { out = 256, foot = 0.92, fill = 0.8, fps = 12 }) → { scale, tx, ty }[]` — `null` measures hold the last good value (first good value back-filled); ground smoothed with τ = 0.25 s, height with τ = 0.6 s; maps the smoothed ground to `(out/2, foot*out)` and the smoothed height to `fill*out`.
- `depth.js`: `distanceTransform(mask, w, h) → Float32Array` (two-pass chamfer, 1 and 1.414, as in `temporal-projector/holo-scenes.js`); `inflate(mask, w, h, { heightPx, relief = 0.15, shading?: Float32Array, cut = false }) → Float32Array` with `d = sqrt(min(dt / (0.25 * heightPx), 1))`, blended `(1 − relief) * d + relief * shadingBlur`, clamped to `(0, 1]` inside, `0` outside; when `cut`, multiply by a smoothstep over the bottom 12 % of `heightPx`; `smoothTemporal(prev: Float32Array|null, cur, a = 0.5) → Float32Array` (only where both are figure pixels).
- `loop.js`: `crossfadeLoop(frames: Float32Array[], n = 6) → Float32Array[]` — output length `L − n`; for `i < n`: `lerp(frames[L − n + i], frames[i], (i + 1) / (n + 1))` per pixel (figure-ness from either), then `frames[n .. L − n)`; clips with `L < 3n` returned unchanged.
- `manifest.js`: `wordCount(s) → number`; `slugify(s) → string` (`/^[a-z0-9-]+$/`); `validateEntry(e) → string[]` (id pattern, non-empty story, `seconds ≤ 7`, `src` ends `.mp4`, `fps === 12`); `upsertMemory(list, entry) → Memory[]` (replace by id in place, else append; then stable sort by `date` where both have one; undated keep relative order).

- [ ] **Step 1: Write the failing tests**, one file per module, including: two discs ⇒ 2 figures; a 3-px speck dropped; a disc moving 6 px/frame stays tracked over 10 frames while an untouched second disc never becomes kept; `measure` of a disc touching the bottom ⇒ `cut === true`; a fixed-size disc shaken by seeded random offsets ±20 px ⇒ after `steadyTransforms`, ground positions' std < 2 px and scale std < 2 %; **Review Focus 5:** frames 10–14 empty ⇒ `measure` null, transforms for 10–14 equal frame 9's; `inflate` of a disc ⇒ centre ≈ 1, edge pixels < 0.4, outside 0; `cut` fades the bottom; `crossfadeLoop` on a 0..83 ramp ⇒ length 78 and `|out[77] − out[0]|` smaller than one ramp step × 2; a 36-frame (3 s) input ⇒ 30 out, nothing padded; `upsertMemory` replace keeps position, insert sorts by date; `validateEntry` rejects `seconds: 8`, id `"Kids Park"`, empty story.
- [ ] **Step 2:** Run → FAIL. Implement the five modules. Run → PASS.
- [ ] **Step 3: Commit.**

### Task 10: Engine page

**Files:**
- Create: `memory-projector/engine/index.html`, `engine/app.js`, `engine/frames.js`, `engine/encode.js`, `engine/pipeline.js`, `engine/stage-view.js`
- Create: `memory-projector/tests/fixtures/make-clip.py` → `tests/fixtures/magenta-clip.mp4` (synthetic: a magenta figure and a magenta "reflection" disc on a textured background, camera shake, 9 s)
- Test: `memory-projector/tests/engine.test.mjs`

**Interfaces:**
- Consumes: Task 1 `depth-format`, Task 8 `createMatter`/`createFakeMatter`, Task 9 stages, Task 4 `DepthHologram` (preview), `mp4-muxer` 5.2.2 from the CDN.
- Produces: `extractFrames(src: File|string, { start = 0, seconds = 7, fps = 12, maxSide = 512 }) → Promise<ImageBitmap[]>` (seek-per-frame on a `<video>`; clamps to the clip's real length); `encodeDepthMp4(frames: Uint8ClampedArray[], { fps = 12 }) → Promise<Blob>` (luma = value, chroma neutral; WebCodecs `avc1.42001f`, 400 kbps; throws `Error('H.264 encoding is not supported in this browser')` when `isConfigSupported` says no); `runPipeline({ frames, matter, keep: Set<number>, onStage }) → Promise<{ depth: Float32Array[], encoded: Uint8ClampedArray[] }>` with `onStage(name: 'frames'|'cutout'|'steady'|'depth'|'loop', i, n, canvasForThisStage)`.

- [ ] **Step 1: Write failing `engine.test.mjs`** (Playwright, `?matter=fake`): set the file input to `magenta-clip.mp4`; start slider defaults to 0 and the trim note says 7 s of 9 s; type a story (word count updates; warning shows past 120 words); the picker shows 2 figures in frame 1; drop the right one; Process runs all stages (stage view shows 4 panes); the Public check plays a video element labelled "This is what anyone can download"; Export triggers two downloads: `<id>.mp4` (< 1 MB; when decoded, the dropped disc's region stays < 32 and the figure's ground point jitters < 3 px across frames) and `memories.json` containing the new entry that passes `validateEntry`. `localStorage`, network requests during processing: none other than same-origin and the model/CDN hosts (assert via `page.on('request')`).
- [ ] **Step 2:** Run → FAIL. Build the page: plain tool styling, sections Load → Write → Pick → Process → Check → Export, stage view with Save still (PNG) / Record clip (`MediaRecorder` on the stage canvas, WebM) and a note that those include the original and are for Adán only; `noindex`; HEVC/decode failure message suggests "Most Compatible". Loads the current `../memories/memories.json` to upsert. Never writes or uploads the original.
- [ ] **Step 3:** Run → PASS. Run once with the real matter on `MP_PRIVATE_FRAME` animated by synthetic shake (scratch only) and look at the dots preview and the public-check video.
- [ ] **Step 4: Commit** (fixture is synthetic; nothing from the private frame).

### Task 11: Homepage interim switch

**Files:**
- Create: `archive/projector/index.html` (copy of the current `index.html` with relative URLs fixed to `../../`)
- Modify: `index.html`, `scene-lab.js:10`, `README.md`
- Create: `memory-projector/memories/memories.json` (`[]`)
- Test: `memory-projector/tests/homepage.test.mjs`

- [ ] **Step 1:** `git tag homepage-v2-projector` on the commit before this task (local only; ask Adán before pushing the tag). Copy the current homepage to `archive/projector/` following how `archive/dither/` was done; verify it loads with `openPage('/archive/projector/')` and no errors.
- [ ] **Step 2: Write failing `homepage.test.mjs`**: `/` reaches `memory-projector[data-ready]`, no errors; `?lab` opens the scene lab and `getScene()` works; P toggles power; with `memories.json` routed to the demo manifest, power-on shows the figure (pixel test from Task 4) and the pill never reads "Talk to me" while hovering the hologram's centre.
- [ ] **Step 3:** Run → FAIL. Swap the element and script, keep placement CSS, replace `DATES`/`FUTURES` with the `memories` attribute (`./memory-projector/memories/memories.json`), remove `faceHit` and the `'face'` zone, update the hint and `datechange` listeners, `scene-lab.js` queries `memory-projector, temporal-projector`. README: homepage line and the experiments list.
- [ ] **Step 4:** Run the full suite → PASS. Screenshot the homepage at 1440×900 (power off and on with the demo manifest routed) and send to Adán.
- [ ] **Step 5: Commit.** The homepage goes live only when Adán merges after committing his first memories.
