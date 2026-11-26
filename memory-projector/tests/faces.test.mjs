import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openPage, mount } from './helpers/browser.mjs';

// A portrait (MP_FACE_IMAGE, e.g. MediaPipe's own test portrait) and the face model under MP_MODEL_DIR/face/; never committed.
const IMG = process.env.MP_FACE_IMAGE, MODEL_DIR = process.env.MP_MODEL_DIR;
const have = !!(IMG && MODEL_DIR && fs.existsSync(IMG) && fs.existsSync(path.join(MODEL_DIR, 'face/blaze_face_short_range.tflite')));
if (have) { mount('/_faces/', path.dirname(IMG)); mount('/_model/', MODEL_DIR); }
const SKIP = !have && 'set MP_FACE_IMAGE and MP_MODEL_DIR';

const detect = (page, scale) => page.evaluate(async ({ img, scale }) => {
  const { createFaceDetector } = await import('/memory-projector/engine/faces.js');
  const d = await createFaceDetector({ model: '/_model/face/blaze_face_short_range.tflite' });
  const bmp = await createImageBitmap(await (await fetch(img)).blob());
  // the portrait as is, or shrunk into a corner of a big empty frame (a child far from the camera)
  const W = 960, H = 540, c = new OffscreenCanvas(scale ? W : bmp.width, scale ? H : bmp.height), g = c.getContext('2d');
  g.fillStyle = '#777'; g.fillRect(0, 0, c.width, c.height);
  if (scale) g.drawImage(bmp, 40, 300, bmp.width * scale, bmp.height * scale); else g.drawImage(bmp, 0, 0);
  const boxes = await d.detect(c.transferToImageBitmap());
  return { boxes, w: c.width, h: c.height, name: d.name, license: d.license };
}, { img: '/_faces/' + path.basename(IMG), scale });

test('finds the face in a portrait', { skip: SKIP, timeout: 120000 }, async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html');
  try {
    const r = await detect(t.page, 0);
    assert.equal(r.license, 'Apache-2.0');
    assert.ok(r.boxes.length >= 1, 'no face found');
    const b = r.boxes[0];
    assert.ok(b.w > 80 && b.x > 0 && b.x + b.w < r.w, JSON.stringify(b));
  } finally { await t.close(); }
});

test('finds a small, far-away face too', { skip: SKIP, timeout: 120000 }, async () => {
  const t = await openPage('/memory-projector/tests/fixtures/blank.html');
  try {
    const r = await detect(t.page, 0.2);   // the face is ~30 px wide in a 960 px frame
    assert.ok(r.boxes.length >= 1, 'missed the small face');
    const b = r.boxes[0];
    assert.ok(b.x > 30 && b.x < 220 && b.y > 290, `box in the wrong place: ${JSON.stringify(b)}`);
  } finally { await t.close(); }
});
