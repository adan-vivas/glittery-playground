import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, inkCells } from './helpers/browser.mjs';

test('the homepage is the playground lab again: the Temporal Projector, scene lab and all', async () => {
  const t = await openPage('/?lab', { waitFor: 'temporal-projector[data-ready]', viewport: { width: 1440, height: 900 } });
  try {
    assert.equal(await t.page.locator('memory-projector').count(), 0);
    assert.ok(await t.page.evaluate(() => !!document.querySelector('temporal-projector').getScene().room));
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('the Memory Projector has its own page, playing the memories', async () => {
  const list = [{ id: 'demo-dance', src: '../demo/demo-dance.mp4', story: 'A demo.', title: 'A demo dance', fps: 12, seconds: 7, aspect: 1 }];
  const t = await openPage('/memory-projector/', { waitFor: 'memory-projector[data-ready]', viewport: { width: 1440, height: 900 },
    routes: [['**/memory-projector/memories/memories.json', (r) => r.fulfill({ body: JSON.stringify(list), contentType: 'application/json' })]] });
  try {
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').hasAttribute('table')), true);
    await t.page.keyboard.press('p');
    await t.page.waitForFunction(() => document.querySelector('memory-projector').state.developing === false, null, { timeout: 15000 });
    await t.page.waitForTimeout(800);
    const h = await t.page.evaluate(() => document.querySelector('memory-projector').anchor('hologram'));
    assert.ok(await inkCells(t.page, { x: h.x - 80, y: h.y - 140, width: 160, height: 280 }) > 40, 'no memory on the page');
    assert.match(await t.page.textContent('#readout'), /A demo dance/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
