import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../engine/pipeline.js';
import { labelFigures } from '../engine/figures.js';
import { disc } from './helpers/masks.mjs';

const W = 120, H = 120;
// A pretend clip: each "frame" carries the alpha the pretend cut-out returns for it.
const clip = (alphas) => ({
  frames: alphas.map((alpha) => ({ width: W, height: H, alpha })),
  matter: { segment: async (f) => ({ alpha: f.alpha, w: W, h: H }) },
});
const keptPixels = (m) => m.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0);

test('a figure that vanishes for a frame comes back when it returns', async () => {
  const figure = () => disc(W, H, 60, 70, 20), empty = new Float32Array(W * H);
  const { frames, matter } = clip([figure(), figure(), empty, figure(), figure()]);
  const first = labelFigures(frames[0].alpha, W, H);
  const r = await runPipeline({ frames, matter, keep: new Set(first.figures.map((f) => f.id)) });
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
  const { frames, matter } = clip(alphas);
  const first = labelFigures(frames[0].alpha, W, H, { minArea: 10 });
  const reflection = first.figures.find((f) => f.centroid[0] > 95).id;
  const keep = new Set(first.figures.map((f) => f.id).filter((id) => id !== reflection));
  const r = await runPipeline({ frames, matter, keep, minArea: 10 });
  for (let i = 0; i < 6; i++) {
    assert.ok(r.masks[i][40 * W + 50 + i * 9] > 0.5, `frame ${i}: lost the ball`);
    assert.equal(r.masks[i][100 * W + 105], 0, `frame ${i}: kept the reflection`);
  }
});

test('nothing kept in the first frame: an empty memory, no crash', async () => {
  const { frames, matter } = clip([disc(W, H, 60, 70, 20), disc(W, H, 60, 70, 20)]);
  const r = await runPipeline({ frames, matter, keep: new Set() });
  assert.deepEqual(r.masks.map(keptPixels), [0, 0]);
});

test('with a depth model, the published depth follows its shape inside the figure (nearer = brighter)', async () => {
  const { frames, matter } = clip([disc(W, H, 60, 70, 30), disc(W, H, 60, 70, 30)]);
  // a pretend depth model: the left of the frame is near, the right is far (bigger = nearer, like Depth Anything)
  const depthModel = { estimate: async () => { const d = new Float32Array(W * H); for (let i = 0; i < W * H; i++) d[i] = 10 - (i % W) / 12; return { depth: d, w: W, h: H }; } };
  const first = labelFigures(frames[0].alpha, W, H);
  const r = await runPipeline({ frames, matter, depthModel, keep: new Set(first.figures.map((f) => f.id)) });
  const d = r.depth[0], S = 256, row = Math.round(0.6 * S);
  const xs = []; for (let x = 0; x < S; x++) if (d[row * S + x] > 0) xs.push(x);
  const left = d[row * S + xs[Math.floor(xs.length * 0.2)]], right = d[row * S + xs[Math.floor(xs.length * 0.8)]];
  assert.ok(left > right + 0.2, `left ${left} should be nearer than right ${right}`);
  assert.equal(d[5], 0, 'outside the figure stays empty');
  assert.ok(Math.min(...xs.map((x) => d[row * S + x])) > 0, 'every figure pixel keeps some depth');
});
