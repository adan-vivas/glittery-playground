import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';
const manifest = (list) => [['**/demo/memories.json', (r) => r.fulfill({ body: JSON.stringify(list), contentType: 'application/json' })]];
const inked = (page) => page.evaluate(() => {
  const c = document.querySelector('memory-projector')._crawlCanvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let s = 0; for (let i = 3; i < d.length; i += 4) s += d[i];
  return s;
});

test('the story crawls on the table and is read out', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY });
  try {
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(3000);
    const live = await t.page.evaluate(() => document.querySelector('memory-projector').shadowRoot.querySelector('.sr').textContent);
    assert.match(live, /This is a demo memory\./);
    assert.ok(await inked(t.page) > 1000, 'nothing drawn on the table');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('an empty story leaves the table dark', async () => {
  const list = [{ id: 'quiet', src: 'demo-dance.mp4', story: '', fps: 12, seconds: 7, aspect: 1 }];
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest(list) });
  try {
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(2500);
    assert.equal(await inked(t.page), 0);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('a fan of light runs from the front lens to the story, only while on', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY });
  try {
    const fan = () => t.page.evaluate(() => { const el = document.querySelector('memory-projector'); return { a: el.projBeam.material.uniforms.uAlpha.value, visible: el.projBeam.visible }; });
    assert.ok((await fan()).a < 0.01);
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(1500);
    const on = await fan();
    assert.ok(on.visible && on.a > 0.3, `fan at ${on.a}`);
    // it starts at the lens and reaches the story's far edge
    const ends = await t.page.evaluate(() => { const b = document.querySelector('memory-projector').projBeam.geometry; b.computeBoundingBox(); return [b.boundingBox.min.z, b.boundingBox.max.z]; });
    assert.ok(ends[0] < 0.04, `starts at ${ends[0]}`); assert.ok(ends[1] > 0.15, `ends at ${ends[1]}`);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
