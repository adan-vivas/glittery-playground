import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceTransform, inflate, smoothTemporal } from '../engine/depth.js';
import { disc } from './helpers/masks.mjs';

const W = 64, H = 64;

test('distance transform: zero outside, growing inward', () => {
  const d = distanceTransform(disc(W, H, 32, 32, 20), W, H);
  assert.equal(d[0], 0);
  assert.ok(d[32 * W + 32] > 18 && d[32 * W + 32] < 22);
  assert.ok(d[32 * W + 13] <= 2);
});

test('inflate: a dome, 1 in the middle, thin at the edge, 0 outside', () => {
  const d = inflate(disc(W, H, 32, 32, 20), W, H, { heightPx: 41 });
  assert.ok(d[32 * W + 32] > 0.95);
  assert.ok(d[32 * W + 13] > 0 && d[32 * W + 13] < 0.4);
  assert.equal(d[0], 0);
  for (const v of d) assert.ok(v >= 0 && v <= 1);
});

test('inflate with cut fades the bottom out', () => {
  const m = disc(W, H, 32, 50, 20);
  const plain = inflate(m, W, H, { heightPx: 30 }), cut = inflate(m, W, H, { heightPx: 30, cut: true });
  assert.ok(cut[63 * W + 32] < plain[63 * W + 32] * 0.5 || plain[63 * W + 32] === 0);
  assert.ok(Math.abs(cut[40 * W + 32] - plain[40 * W + 32]) < 1e-6);
});

test('smoothTemporal blends only where both frames have a figure', () => {
  const a = new Float32Array([0, 0.2, 0.8]), b = new Float32Array([0.6, 0.4, 0]);
  assert.deepEqual([...smoothTemporal(a, b, 0.5)].map((v) => +v.toFixed(3)), [0.6, 0.3, 0]);
  assert.deepEqual([...smoothTemporal(null, b)], [...b]);
});
