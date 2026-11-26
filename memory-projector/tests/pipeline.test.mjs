import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../engine/pipeline.js';
import { labelFigures } from '../engine/figures.js';
import { SIZE } from '../lib/depth-format.js';
import { disc } from './helpers/masks.mjs';

const W = 120, H = 120;
// A pretend clip: each "frame" carries the alpha the pretend cut-out returns for it.
const clip = (alphas) => ({
  frames: alphas.map((alpha) => ({ width: W, height: H, alpha })),
  readLuma: (f) => f.luma || new Float32Array(W * H).fill(0.5),
  matter: { segment: async (f) => ({ alpha: f.alpha, w: W, h: H }) },
});
const keptPixels = (m) => m.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0);

test('a figure that vanishes for a frame comes back when it returns', async () => {
  const figure = () => disc(W, H, 60, 70, 20), empty = new Float32Array(W * H);
  const { frames, matter, readLuma } = clip([figure(), figure(), empty, figure(), figure()]);
  const first = labelFigures(frames[0].alpha, W, H);
  const r = await runPipeline({ frames, matter, readLuma, keep: new Set(first.figures.map((f) => f.id)) });
  const kept = r.masks.map(keptPixels);
  assert.equal(kept[2], 0);
  assert.ok(kept[3] > 1000 && kept[4] > 1000, `after the gap: ${kept}`);
});

test('a small ball moving faster than its own size stays kept; a far-away dropped figure stays dropped', async () => {
  const alphas = [];
  for (let i = 0; i < 6; i++) {
    const a = disc(W, H, 30, 80, 14);                // the child
    disc(W, H, 50 + i * 9, 40, 3, a);                // a 6-px ball, 9 px a frame
    disc(W, H, 105, 100, 8, a);                      // the reflection, dropped
    alphas.push(a);
  }
  const { frames, matter, readLuma } = clip(alphas);
  const first = labelFigures(frames[0].alpha, W, H, { minArea: 10 });
  const reflection = first.figures.find((f) => f.centroid[0] > 95).id;
  const keep = new Set(first.figures.map((f) => f.id).filter((id) => id !== reflection));
  const r = await runPipeline({ frames, matter, readLuma, keep, minArea: 10 });
  for (let i = 0; i < 6; i++) {
    assert.ok(r.masks[i][40 * W + 50 + i * 9] > 0.5, `frame ${i}: lost the ball`);
    assert.equal(r.masks[i][100 * W + 105], 0, `frame ${i}: kept the reflection`);
  }
});

test('nothing kept in the first frame: an empty memory, no crash', async () => {
  const { frames, matter, readLuma } = clip([disc(W, H, 60, 70, 20), disc(W, H, 60, 70, 20)]);
  const r = await runPipeline({ frames, matter, readLuma, keep: new Set() });
  assert.deepEqual(r.masks.map(keptPixels), [0, 0]);
});

test('with a depth model, the published depth follows its shape inside the figure (nearer = brighter)', async () => {
  const { frames, matter, readLuma } = clip([disc(W, H, 60, 70, 30), disc(W, H, 60, 70, 30)]);
  // a pretend depth model: the left of the frame is near, the right is far (bigger = nearer, like Depth Anything)
  const depthModel = { estimate: async () => { const d = new Float32Array(W * H); for (let i = 0; i < W * H; i++) d[i] = 10 - (i % W) / 12; return { depth: d, w: W, h: H }; } };
  const first = labelFigures(frames[0].alpha, W, H);
  const r = await runPipeline({ frames, matter, readLuma, depthModel, keep: new Set(first.figures.map((f) => f.id)) });
  const d = r.depth[0], S = SIZE, row = Math.round(0.6 * S);
  const xs = []; for (let x = 0; x < S; x++) if (d[row * S + x] > 0) xs.push(x);
  const left = d[row * S + xs[Math.floor(xs.length * 0.2)]], right = d[row * S + xs[Math.floor(xs.length * 0.8)]];
  assert.ok(left > right + 0.2, `left ${left} should be nearer than right ${right}`);
  assert.equal(d[5], 0, 'outside the figure stays empty');
  assert.ok(Math.min(...xs.map((x) => d[row * S + x])) > 0, 'every figure pixel keeps some depth');
});

test('small bumps (a fist in front of a chest) stand out in the published depth', async () => {
  const { frames, matter, readLuma } = clip([disc(W, H, 60, 70, 34), disc(W, H, 60, 70, 34)]);
  // a flat body, a little nearer at its middle, with a small bump (the fist) slightly nearer still
  const depthModel = { estimate: async () => { const d = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d[y * W + x] = 5 - Math.hypot(x - 60, y - 70) / 40 + ((x - 50) ** 2 + (y - 70) ** 2 < 36 ? 0.25 : 0);
    return { depth: d, w: W, h: H }; } };
  const first = labelFigures(frames[0].alpha, W, H);
  const r = await runPipeline({ frames, matter, readLuma, depthModel, keep: new Set(first.figures.map((f) => f.id)) });
  // the fist sits at frame (50, 70): find it on the 256 grid through the steadying transform
  const d = r.depth[0], S = SIZE, T = r.transforms[0];
  const fx = Math.round(50 * T.scale + T.tx), fy = Math.round(70 * T.scale + T.ty), off = Math.round(14 * T.scale);
  const peak = d[fy * S + fx], around = (d[fy * S + fx - off] + d[fy * S + fx + off]) / 2;
  assert.ok(peak - around > 0.27, `the fist stands only ${(peak - around).toFixed(3)} above the chest`);
});


// A figure whose left half is bright and right half dark, with a checkered "face" on top.
function pictureClip(n = 2) {
  const alpha = disc(W, H, 60, 70, 34), luma = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) luma[y * W + x] = x < 60 ? 0.9 : 0.2;
  for (let y = 40; y < 56; y++) for (let x = 52; x < 68; x++) luma[y * W + x] = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 1 : 0;   // the "face": 4-px squares
  const frames = Array.from({ length: n }, () => ({ width: W, height: H, alpha, luma }));
  return { frames, matter: { segment: async (f) => ({ alpha: f.alpha, w: W, h: H }) }, readLuma: (f) => f.luma,
    faces: { detect: async () => [{ x: 52, y: 40, w: 16, h: 16 }] } };
}
const checker = (l, T) => {   // how much the face region still flickers pixel to pixel
  let s = 0, n = 0;
  for (let y = 42; y < 54; y++) for (let x = 54; x < 66; x++) {
    const X = Math.round(x * T.scale + T.tx), Y = Math.round(y * T.scale + T.ty);
    s += Math.abs(l[Y * SIZE + X] - l[Y * SIZE + X + Math.round(4 * T.scale)]); n++;
  }
  return s / n;
};

test('the published picture carries the figure\'s brightness, and nothing outside it', async () => {
  const { frames, matter, readLuma } = pictureClip();
  const keep = new Set(labelFigures(frames[0].alpha, W, H).figures.map((f) => f.id));
  const r = await runPipeline({ frames, matter, readLuma, readLuma, keep });
  const l = r.luma[0], T = r.transforms[0], at = (x, y) => l[Math.round(y * T.scale + T.ty) * SIZE + Math.round(x * T.scale + T.tx)];
  assert.ok(at(45, 75) > 0.8 && at(75, 75) < 0.3, `bright ${at(45, 75)}, dark ${at(75, 75)}`);
  assert.equal(l[0], 0);
  assert.equal(r.encoded[0].length, 2 * SIZE * SIZE);
});

test('faces are blurred when asked, and left sharp when not', async () => {
  const c = pictureClip(), keep = new Set(labelFigures(c.frames[0].alpha, W, H).figures.map((f) => f.id));
  const blurred = await runPipeline({ ...c, keep, blurFaces: true });
  const sharp = await runPipeline({ ...c, keep, blurFaces: false });
  const b = checker(blurred.luma[0], blurred.transforms[0]), s = checker(sharp.luma[0], sharp.transforms[0]);
  assert.ok(s > 0.3, `the unblurred face should keep its detail (${s})`);
  assert.ok(b < 0.1, `the face is still sharp (${b})`);
  assert.equal(blurred.facesBlurred, true); assert.equal(sharp.facesBlurred, false);
});
