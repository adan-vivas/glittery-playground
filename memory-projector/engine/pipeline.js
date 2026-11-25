// The pipeline: frames → cut-out (kept figures only) → steady → depth → loop → depth-only bytes, ready to encode.
// Privacy: what leaves this function is depth alone. The frames' colours and shading never reach it.
import { labelFigures, keepMask, nearKept, trackNear } from './figures.js';
import { measure, steadyTransforms } from './steady.js';
import { inflate, smoothTemporal } from './depth.js';
import { crossfadeLoop } from './loop.js';
import { SIZE, FPS, encodeDepthFrame } from '../lib/depth-format.js';

const tick = () => new Promise((r) => setTimeout(r, 0));   // let the page draw between frames

// A W × H mask moved and scaled into the SIZE × SIZE frame by T (bilinear, then thresholded softly).
function warp(mask, W, H, T) {
  const out = new Float32Array(SIZE * SIZE), inv = 1 / T.scale;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const sx = (x + 0.5 - T.tx) * inv - 0.5, sy = (y + 0.5 - T.ty) * inv - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    if (x0 < -1 || y0 < -1 || x0 >= W || y0 >= H) continue;
    const at = (xx, yy) => (xx >= 0 && yy >= 0 && xx < W && yy < H ? mask[yy * W + xx] : 0);
    out[y * SIZE + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  }
  return out;
}

/**
 * frames: ImageBitmap[]; matter: { segment }; keep: Set of figure ids in the first frame's labels (labelFigures of
 * firstAlpha, or of the first frame's cut-out). onStage(name, i, n, data) after each step of each frame.
 * → { depth: Float32Array[] (SIZE²), encoded: Uint8ClampedArray[], masks, transforms }
 */
// Detail boost for depth, like sharpening a picture: each pixel moves away from the average of its neighbourhood (inside
// the figure only), so small bumps (a fist, a snout's ridge) stand out from the larger shape. Depth stays in 0..1.
const RELIEF_RADIUS = 6, RELIEF_GAIN = 2.2;
export function boostRelief(d, S, r, gain) {
  const sum = new Float32Array(d.length), cnt = new Float32Array(d.length), tmpS = new Float32Array(d.length), tmpC = new Float32Array(d.length);
  for (let y = 0; y < S; y++) {                     // box blur of the figure's own values, rows then columns
    let s = 0, c = 0;
    for (let x = -r; x < S; x++) {
      const add = x + r, sub = x - r - 1;
      if (add < S) { const v = d[y * S + add]; if (v > 0) { s += v; c++; } }
      if (sub >= 0) { const v = d[y * S + sub]; if (v > 0) { s -= v; c--; } }
      if (x >= 0) { tmpS[y * S + x] = s; tmpC[y * S + x] = c; }
    }
  }
  for (let x = 0; x < S; x++) {
    let s = 0, c = 0;
    for (let y = -r; y < S; y++) {
      const add = y + r, sub = y - r - 1;
      if (add < S) { s += tmpS[add * S + x]; c += tmpC[add * S + x]; }
      if (sub >= 0) { s -= tmpS[sub * S + x]; c -= tmpC[sub * S + x]; }
      if (y >= 0) { sum[y * S + x] = s; cnt[y * S + x] = c; }
    }
  }
  const out = new Float32Array(d.length);
  for (let p = 0; p < d.length; p++) if (d[p] > 0) out[p] = Math.min(1, Math.max(0.02, d[p] + gain * (d[p] - sum[p] / Math.max(1, cnt[p]))));
  return out;
}

// Real depth, from a depth model (bigger = nearer), turned into 0..1 inside the kept figures: the 3rd to 99.5th percentile
// of the figures' own values, eased over time so the figure doesn't pump as it moves. → Float32Array, 0 outside.
function figureDepth(raw, mask, ease) {
  const vals = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) vals.push(raw[i]);
  const out = new Float32Array(mask.length);
  if (!vals.length) return out;
  vals.sort((a, b) => a - b);
  // the nearest few per cent are often the detail (a fist, a snout): don't clip them flat
  let lo = vals[Math.floor(vals.length * 0.03)], hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))];
  if (ease.lo != null) { lo = ease.lo + 0.35 * (lo - ease.lo); hi = ease.hi + 0.35 * (hi - ease.hi); }
  ease.lo = lo; ease.hi = hi;
  const span = Math.max(1e-6, hi - lo);
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0.5) out[i] = Math.min(1, Math.max(0, (raw[i] - lo) / span));
  return out;
}

/**
 * depthModel (optional): { estimate(frame) → { depth: Float32Array at the frame's size, bigger = nearer } }. With it, the
 * figures get their real shape (an arm in front of the chest, a snout); without, the silhouette is inflated like a balloon.
 */
export async function runPipeline({ frames, matter, keep, firstAlpha, minArea, depthModel, onStage = () => {} }) {
  const n = frames.length, W = frames[0].width, H = frames[0].height, masks = [];
  // Kept figures are followed against the last frame that had any: a frame where the cut-out misses everyone (or the
  // child runs out of shot) doesn't lose them for good. A figure counts as the same one if it lands within `reach` of
  // where kept figures were, so a small ball moving faster than its own size is still followed.
  const reach = Math.max(4, Math.round(0.06 * Math.max(W, H)));
  let near = null;
  const real = [], ease = {};
  for (let i = 0; i < n; i++) {
    const alpha = i === 0 && firstAlpha ? firstAlpha : (await matter.segment(frames[i])).alpha;
    const lab = labelFigures(alpha, W, H, minArea ? { minArea } : undefined);
    const ids = i === 0 ? keep : near ? trackNear(near, lab) : new Set();
    const m = keepMask(alpha, lab.labels, ids);
    masks.push(m);
    if (depthModel) real.push(figureDepth((await depthModel.estimate(frames[i])).depth, m, ease));
    if (m.some((v) => v > 0.5)) near = nearKept(m, W, H, reach);
    onStage('cutout', i, n, { frame: frames[i], mask: masks[i], w: W, h: H });
    await tick();
  }

  const measures = masks.map((m) => measure(m, W, H));
  const T = steadyTransforms(measures, { out: SIZE, fps: FPS });
  onStage('steady', n - 1, n, { transforms: T });

  const depth = [];
  let last = null;
  for (let i = 0; i < n; i++) {
    const warped = warp(masks[i], W, H, T[i]);
    const heightPx = (measures[i] ? measures[i].height : 0.8 * SIZE / T[i].scale) * T[i].scale;
    let d = inflate(warped, SIZE, SIZE, { heightPx, cut: !!measures[i]?.cut });   // the balloon: thin at the edges
    if (depthModel) {
      const shape = warp(real[i], W, H, T[i]);
      // mostly the real shape, a touch of the balloon so the edges stay thin, then small bumps brought out
      for (let p = 0; p < d.length; p++) if (d[p] > 0) d[p] = 0.85 * shape[p] / Math.max(warped[p], 1e-3) + 0.15 * d[p];
      d = boostRelief(d, SIZE, RELIEF_RADIUS, RELIEF_GAIN);
      for (let p = 0; p < d.length; p++) if (d[p] > 0) d[p] = Math.min(1, 0.12 + 0.88 * d[p]);
    }
    d = smoothTemporal(last, d, 0.5);
    depth.push(d); last = d;
    onStage('depth', i, n, { depth: d });
    if (i % 4 === 3) await tick();
  }

  const looped = crossfadeLoop(depth, 6);
  onStage('loop', looped.length - 1, looped.length, { depth: looped });
  return { depth: looped, encoded: looped.map((d) => encodeDepthFrame(d)), masks, transforms: T };
}
