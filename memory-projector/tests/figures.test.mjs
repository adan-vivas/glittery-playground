import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFigures, trackFigures, keepMask } from '../engine/figures.js';
import { disc } from './helpers/masks.mjs';

const W = 80, H = 60;

test('two discs are two figures; a speck is dropped', () => {
  const a = disc(W, H, 20, 30, 8); disc(W, H, 60, 30, 8, a);
  a[2 * W + 2] = 1; a[2 * W + 3] = 1; a[3 * W + 2] = 1;          // 3-px speck
  const { labels, figures } = labelFigures(a, W, H);
  assert.equal(figures.length, 2);
  assert.equal(labels[2 * W + 2], 0);
  const [f1, f2] = figures.sort((p, q) => p.centroid[0] - q.centroid[0]);
  assert.ok(Math.abs(f1.centroid[0] - 20) < 0.5 && Math.abs(f2.centroid[0] - 60) < 0.5);
  assert.deepEqual(f1.box, [12, 22, 28, 38]);
  assert.ok(f1.area > 190 && f1.area < 215);
});

test('a moving figure stays kept; the one left alone never becomes kept', () => {
  let prev = null, keep = null;
  for (let i = 0; i < 10; i++) {
    const a = disc(W, H, 12 + i * 3, 30, 7); disc(W, H, 68, 30, 7, a);   // left one moves 3 px/frame toward the right one
    const cur = labelFigures(a, W, H);
    if (!prev) {
      const left = cur.figures.find((f) => f.centroid[0] < 40);
      keep = new Set([left.id]);
    } else keep = trackFigures(prev.labels, keep, cur);
    const m = keepMask(a, cur.labels, keep);
    assert.equal(m[30 * W + 68], 0, `frame ${i}: the right disc got kept`);
    assert.equal(m[30 * W + 12 + i * 3], 1, `frame ${i}: lost the moving disc`);
    prev = cur;
  }
});

test('keepMask keeps the alpha of kept figures only', () => {
  const a = disc(W, H, 20, 30, 8); disc(W, H, 60, 30, 8, a);
  for (let i = 0; i < a.length; i++) if (a[i]) a[i] = 0.8;
  const cur = labelFigures(a, W, H);
  const id = cur.labels[30 * W + 20];
  const m = keepMask(a, cur.labels, new Set([id]));
  assert.ok(Math.abs(m[30 * W + 20] - 0.8) < 1e-6);
  assert.equal(m[30 * W + 60], 0);
});
