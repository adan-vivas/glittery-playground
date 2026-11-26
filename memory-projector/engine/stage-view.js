// The stage view: the clip, its cut-out, its depth and the dots, side by side, as the engine works and then playing in
// a loop. It shows the original video, so it is for Adán only: stills and recordings of it are never published.
import * as THREE from 'three';
import { DepthHologram } from '../holo-depth.js';
import { SIZE, FPS, encodeDepthValue } from '../lib/depth-format.js';

const PANES = [['video', 'Video'], ['cutout', 'Cut-out'], ['depth', 'Depth'], ['dots', 'Dots']];
const BG = '#e4e4e2';

export function createStageView(root) {
  root.textContent = '';
  const panes = {};
  for (const [key, label] of PANES) {
    const fig = document.createElement('figure');
    fig.className = 'pane'; fig.dataset.pane = key;
    const c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const cap = document.createElement('figcaption');
    cap.textContent = label;
    fig.append(c, cap);
    root.append(fig);
    panes[key] = c;
  }

  // the dots: the projector's own hologram code, on a plain card
  const renderer = new THREE.WebGLRenderer({ canvas: panes.dots, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(30, 1, 0.01, 10);
  camera.position.set(0.35, 0.55, 2.1); camera.lookAt(0, 0.5, 0);
  const holo = new DepthHologram({ grid: 256, frame: { w: 1, h: 1, gap: 0 }, ink: new THREE.Vector3(0.11, 0.18, 1.0) });
  scene.add(holo.object3d);
  let playing = null, raf = 0, t0 = performance.now();

  const ctx = (k) => panes[k].getContext('2d');
  const fit = (g, img, w, h) => {
    g.fillStyle = BG; g.fillRect(0, 0, SIZE, SIZE);
    const s = Math.min(SIZE / w, SIZE / h);
    g.drawImage(img, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
  };
  const scratch = new OffscreenCanvas(1, 1);

  const view = {
    drawVideo(frame) { fit(ctx('video'), frame, frame.width, frame.height); },
    drawCutout(frame, mask, w, h) {
      scratch.width = w; scratch.height = h;
      const g = scratch.getContext('2d', { willReadFrequently: true });
      g.drawImage(frame, 0, 0, w, h);
      const img = g.getImageData(0, 0, w, h);
      for (let i = 0; i < w * h; i++) {   // kept figures in their colours, the rest faded to the page
        const a = mask[i];
        for (let c = 0; c < 3; c++) img.data[i * 4 + c] = img.data[i * 4 + c] * a + 228 * (1 - a);
      }
      g.putImageData(img, 0, 0);
      fit(ctx('cutout'), scratch, w, h);
    },
    drawDepth(depth) {
      const g = ctx('depth'), img = g.createImageData(SIZE, SIZE);
      for (let i = 0; i < SIZE * SIZE; i++) {
        const v = depth[i] > 0 ? encodeDepthValue(depth[i]) : 0;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    },
    /** Show the encoded memory as dots (a blob: URL). */
    setDots(url) { holo.show(url, { format: 2 }); },
    /** Loop all panes in step: frames, masks (frame size) and depth, at the memory's rate. */
    play({ frames, masks, depth }) { playing = { frames, masks, depth }; t0 = performance.now(); },
    /** A PNG of the four panes side by side. */
    async still() {
      const c = composite();
      return c.convertToBlob({ type: 'image/png' });
    },
    /** A WebM of the four panes playing, `seconds` long. */
    record(seconds = 7) {
      const c = document.createElement('canvas');
      c.width = SIZE * 4; c.height = SIZE;
      const g = c.getContext('2d'), stream = c.captureStream(FPS), rec = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      let on = true;
      const copy = () => { if (!on) return; g.drawImage(composite(), 0, 0); requestAnimationFrame(copy); };
      copy();
      return new Promise((ok) => {
        rec.onstop = () => ok(new Blob(chunks, { type: 'video/webm' }));
        rec.start();
        setTimeout(() => { on = false; rec.stop(); }, seconds * 1000);
      });
    },
    dispose() { cancelAnimationFrame(raf); renderer.dispose(); },
  };

  function composite() {
    const c = new OffscreenCanvas(SIZE * 4, SIZE), g = c.getContext('2d');
    PANES.forEach(([k], i) => g.drawImage(panes[k], i * SIZE, 0));
    return c;
  }

  let last = performance.now();
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (playing && playing.depth.length) {
      // (an animation frame's timestamp can be a little older than play()'s: never a negative index)
      const i = Math.floor(Math.max(0, now - t0) / 1000 * FPS) % playing.depth.length;
      if (i !== playing.i) {
        playing.i = i;
        view.drawVideo(playing.frames[i]);
        view.drawCutout(playing.frames[i], playing.masks[i], playing.frames[i].width, playing.frames[i].height);
        view.drawDepth(playing.depth[i]);
      }
    }
    holo.update(dt, now / 1000, { power: 1, size: 2.4 * camera.position.length() });
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  return view;
}
