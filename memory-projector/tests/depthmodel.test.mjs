import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openPage, mount } from './helpers/browser.mjs';

// The real model (~100 MB) from MP_MODEL_DIR/depth/model.onnx and the private frame from MP_PRIVATE_FRAME; never committed.
const MODEL_DIR = process.env.MP_MODEL_DIR, FRAME = process.env.MP_PRIVATE_FRAME;
const have = !!(MODEL_DIR && FRAME && fs.existsSync(path.join(MODEL_DIR, 'depth/model.onnx')) && fs.existsSync(FRAME));
if (have) { mount('/_model/', MODEL_DIR); mount('/_private/', path.dirname(FRAME)); }

test('Depth Anything: the child is nearer than the wall behind him', { skip: !have && 'set MP_MODEL_DIR and MP_PRIVATE_FRAME', timeout: 300000 }, async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html');
  try {
    const r = await t.page.evaluate(async (frame) => {
      const { createDepthModel } = await import('/memory-projector/engine/depthmodel.js');
      const m = await createDepthModel({ base: '/_model/depth/' });
      const img = await createImageBitmap(await (await fetch(frame)).blob(), { resizeWidth: 288, resizeHeight: 512 });
      const t0 = performance.now(), { depth, w, h } = await m.estimate(img), ms = performance.now() - t0;
      const mean = (x0, y0, x1, y1) => { let s = 0, n = 0;
        for (let y = Math.floor(y0 * h); y < y1 * h; y++) for (let x = Math.floor(x0 * w); x < x1 * w; x++) { s += depth[y * w + x]; n++; } return s / n; };
      return { name: m.name, license: m.license, device: m.device, w, h, ms, body: mean(0.4, 0.15, 0.6, 0.35), wall: mean(0.8, 0.02, 0.98, 0.2) };   // the far wall, top right
    }, '/_private/' + path.basename(FRAME));
    console.log(`depth: ${r.name} ${r.device} ${Math.round(r.ms)} ms/frame, body ${r.body.toFixed(2)}, wall ${r.wall.toFixed(2)}`);
    assert.equal(r.w, 288); assert.equal(r.h, 512); assert.equal(r.license, 'Apache-2.0');
    assert.ok(r.body > r.wall * 1.5, `body ${r.body} vs wall ${r.wall}`);
  } finally { await t.close(); }
});
