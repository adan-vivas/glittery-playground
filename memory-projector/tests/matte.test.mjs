import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openPage, mount } from './helpers/browser.mjs';

// The real models are big: tests use local copies under MP_MODEL_DIR (birefnet/model.onnx [+ model_fp16.onnx],
// modnet/model.onnx) and the private reference frame from MP_PRIVATE_FRAME. Neither is ever committed; without them
// the real-model tests are skipped.
const MODEL_DIR = process.env.MP_MODEL_DIR, FRAME = process.env.MP_PRIVATE_FRAME;
const haveReal = !!(MODEL_DIR && FRAME && fs.existsSync(path.join(MODEL_DIR, 'modnet/model.onnx')) && fs.existsSync(FRAME));
const SKIP = !haveReal && 'set MP_MODEL_DIR and MP_PRIVATE_FRAME';
if (haveReal) { mount('/_model/', MODEL_DIR); mount('/_private/', path.dirname(FRAME)); }

test('the fake matter keys on magenta', async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html');
  try {
    const r = await t.page.evaluate(async () => {
      const { createFakeMatter } = await import('/memory-projector/engine/matte.js');
      const c = new OffscreenCanvas(64, 64), g = c.getContext('2d');
      g.fillStyle = '#3a6'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#ff00ff'; g.beginPath(); g.arc(32, 32, 16, 0, Math.PI * 2); g.fill();
      const out = await createFakeMatter().segment(c.transferToImageBitmap());
      return { w: out.w, h: out.h, centre: out.alpha[32 * 64 + 32], corner: out.alpha[2 * 64 + 2] };
    });
    assert.equal(r.w, 64); assert.equal(r.h, 64);
    assert.ok(r.centre > 0.9); assert.ok(r.corner < 0.1);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

// Runs createMatter on the private frame and measures the alpha over the boy's body and over the empty floor.
const cutOut = (page) => page.evaluate(async (frame) => {
  const { createMatter } = await import('/memory-projector/engine/matte.js');
  const m = await createMatter({ models: { birefnet: '/_model/birefnet/', modnet: '/_model/modnet/' } });
  const img = await createImageBitmap(await (await fetch(frame)).blob());
  const t0 = performance.now(), { alpha, w, h } = await m.segment(img), ms = performance.now() - t0;
  const mean = (x0, y0, x1, y1) => { let s = 0, n = 0;
    for (let y = Math.floor(y0 * h); y < y1 * h; y++) for (let x = Math.floor(x0 * w); x < x1 * w; x++) { s += alpha[y * w + x]; n++; }
    return s / n; };
  return { name: m.name, device: m.device, license: m.license, fallback: m.fallback || '', ms, w, h,
    body: mean(0.35, 0.2, 0.65, 0.5), floor: mean(0.7, 0.8, 1, 1) };
}, '/_private/' + path.basename(FRAME));

test('without WebGPU it falls back to MODNet, says why, and still cuts the figure out', { skip: SKIP, timeout: 300000 }, async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html');
  try {
    const r = await cutOut(t.page);
    console.log(`matte: ${r.name} ${r.device} ${Math.round(r.ms)} ms/frame, body ${r.body.toFixed(2)}, floor ${r.floor.toFixed(2)}`);
    assert.equal(r.name, 'MODNet'); assert.equal(r.license, 'Apache-2.0');
    assert.match(r.fallback, /no WebGPU/);
    assert.ok(r.body > 0.6, `body alpha ${r.body}`); assert.ok(r.floor < 0.1, `floor alpha ${r.floor}`);
  } finally { await t.close(); }
});

// Slow: on software WebGPU BiRefNet itself now runs (it fits ORT 1.20's buffer use) and takes far over 20 minutes.
test('on a GPU, BiRefNet runs or falls back with the reason (software WebGPU)', { skip: SKIP || (!process.env.MP_SLOW && 'set MP_SLOW=1'), timeout: 3600000 }, async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html', { webgpu: true });
  try {
    const r = await cutOut(t.page);
    console.log(`matte: ${r.name} ${r.device}: ${r.fallback.slice(0, 120)}`);
    // SwiftShader allows 10 storage buffers per shader; BiRefNet needs 11. A real GPU runs BiRefNet instead.
    if (r.name === 'BiRefNet-lite') assert.equal(r.license, 'MIT');
    else assert.match(r.fallback, /could not run on this GPU/i);
    assert.ok(r.body > 0.6, `body alpha ${r.body}`); assert.ok(r.floor < 0.1, `floor alpha ${r.floor}`);
  } finally { await t.close(); }
});
