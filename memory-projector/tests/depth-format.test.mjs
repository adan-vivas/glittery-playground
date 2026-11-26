import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE, FPS, MAX_SECONDS, EMPTY_BELOW, FORMAT, encodeDepthValue, decodeDepthValue, encodeDepthFrame, encodeMemoryFrame } from '../lib/depth-format.js';

test('format constants match the spec', () => {
  assert.equal(SIZE, 512); assert.equal(FORMAT, 2); assert.equal(FPS, 12); assert.equal(MAX_SECONDS, 7); assert.equal(EMPTY_BELOW, 32);
});

test('round-trips depth', () => {
  for (const d of [0, 0.25, 0.5, 1]) assert.ok(Math.abs(decodeDepthValue(encodeDepthValue(d)) - d) < 1 / 191);
});

test('empty stays empty', () => {
  assert.equal(decodeDepthValue(0), null);
  assert.equal(decodeDepthValue(31), null);
  assert.equal(encodeDepthValue(0), 64);            // the farthest figure pixel is still a figure
  const f = encodeDepthFrame(new Float32Array([0, 0.5, NaN]));   // in a depth map, 0 and NaN mean "no figure"
  assert.deepEqual([...f], [0, 160, 0]);
});

test('encodeDepthFrame clamps and reuses the output buffer', () => {
  const out = new Uint8ClampedArray(2);
  const r = encodeDepthFrame(new Float32Array([2, 1e-6]), out);
  assert.equal(r, out);
  assert.deepEqual([...out], [255, 64]);
});

test('format 2: picture on the left, depth on the right, nothing outside the figure', () => {
  const S = 2, luma = new Float32Array([0.5, 1, 0.2, 0.9]), depth = new Float32Array([0, 1, 0.5, 0]);
  const f = encodeMemoryFrame(luma, depth, S);
  assert.equal(f.length, 2 * S * S);
  // row 0: luma (0 where no figure), then depth
  assert.deepEqual([...f.slice(0, 4)], [0, 255, 0, 255]);
  assert.deepEqual([...f.slice(4, 8)], [51, 0, 160, 0]);
});
