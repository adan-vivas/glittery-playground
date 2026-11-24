import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossfadeLoop } from '../engine/loop.js';

const ramp = (n) => Array.from({ length: n }, (_, i) => new Float32Array([i + 1]));

test('crossfade: n frames shorter, and the end flows into the start', () => {
  const out = crossfadeLoop(ramp(84), 6);
  assert.equal(out.length, 78);
  // across the seam (last → first) the jump is no bigger than inside the blend
  const seam = Math.abs(out[0][0] - out[77][0]), inside = Math.max(...out.slice(1, 6).map((f, i) => Math.abs(f[0] - out[i][0])));
  assert.ok(seam <= inside * 2 + 1, `seam ${seam} vs ${inside}`);
});

test('a short clip is left alone, never padded', () => {
  const out = crossfadeLoop(ramp(36), 6);
  assert.equal(out.length, 30);
  const tiny = ramp(12);
  assert.equal(crossfadeLoop(tiny, 6).length, 12);
});

test('figure-ness: a pixel empty in one frame and full in the other stays a figure', () => {
  const f = Array.from({ length: 30 }, (_, i) => new Float32Array([i < 15 ? 0 : 0.5]));
  const out = crossfadeLoop(f, 6);
  assert.ok(out[0][0] > 0);
});
