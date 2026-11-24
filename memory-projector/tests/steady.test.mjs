import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measure, smooth, steadyTransforms } from '../engine/steady.js';
import { disc, seeded, std } from './helpers/masks.mjs';

const W = 160, H = 160;

test('measure finds the ground point and height; a figure touching the bottom is cut', () => {
  const m = measure(disc(W, H, 80, 100, 20), W, H);
  assert.equal(m.ground[1], 120); assert.ok(Math.abs(m.ground[0] - 80) < 1.5);
  assert.equal(m.height, 41); assert.equal(m.cut, false);
  assert.equal(measure(disc(W, H, 80, 150, 20), W, H).cut, true);
  assert.equal(measure(new Float32Array(W * H), W, H), null);
});

test('smooth is zero-phase: a constant stays put, a step stays centred', () => {
  assert.deepEqual(smooth([5, 5, 5, 5], 0.25), [5, 5, 5, 5]);
  const s = smooth([0, 0, 0, 0, 0, 0, 10, 10, 10, 10, 10, 10], 0.25);
  assert.ok(Math.abs((s[5] + s[6]) / 2 - 5) < 0.5);
});

test('a shaken figure stands still after steadying', () => {
  const r = seeded(7), ms = [];
  for (let i = 0; i < 48; i++) ms.push(measure(disc(W, H, 80 + (r() - 0.5) * 40, 90 + (r() - 0.5) * 40, 18), W, H));
  const T = steadyTransforms(ms, { out: 256 });
  const gx = ms.map((m, i) => m.ground[0] * T[i].scale + T[i].tx), gy = ms.map((m, i) => m.ground[1] * T[i].scale + T[i].ty);
  assert.ok(std(gx) < 2, `x jitter ${std(gx)}`); assert.ok(std(gy) < 2, `y jitter ${std(gy)}`);
  const sc = T.map((t) => t.scale);
  assert.ok(std(sc) / (sc.reduce((a, b) => a + b) / sc.length) < 0.02);
  assert.ok(Math.abs(gy[10] - 0.92 * 256) < 3); assert.ok(Math.abs(gx[10] - 128) < 3);
});

test('frames without the figure hold the last good transform', () => {
  const ms = [];
  for (let i = 0; i < 20; i++) ms.push(i >= 10 && i <= 14 ? null : measure(disc(W, H, 80, 90, 18), W, H));
  ms[9] = measure(disc(W, H, 70, 90, 18), W, H);
  const T = steadyTransforms(ms, { out: 256 });
  for (let i = 10; i <= 14; i++) assert.deepEqual(T[i], T[9]);
  const lead = [null, null, ...ms.slice(0, 5)];                   // nothing at the start: back-filled
  const L = steadyTransforms(lead, { out: 256 });
  assert.deepEqual(L[0], L[2]);
});
