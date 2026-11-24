import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, inkCells } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';

test('the homepage runs the memory projector, with the scene lab and P for power', async () => {
  const t = await openPage('/?lab', { waitFor: READY, viewport: { width: 1440, height: 900 } });
  try {
    assert.equal(await t.page.locator('temporal-projector').count(), 0);
    await t.page.waitForTimeout(1500);
    assert.ok(await t.page.evaluate(() => !!document.querySelector('memory-projector').getScene().room));
    await t.page.keyboard.press('p');
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').state.power), true);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('with memories, the hologram stands on the table, and "Talk to me" is not on it', async () => {
  const t = await openPage('/', { waitFor: READY, viewport: { width: 1440, height: 900 }, routes: [
    ['**/memory-projector/memories/memories.json', (r) => r.fulfill({ body: JSON.stringify([{ id: 'demo-dance', src: '../demo/demo-dance.mp4', story: 'A demo.', fps: 12, seconds: 7, aspect: 1 }]), contentType: 'application/json' })],
  ] });
  try {
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForFunction(() => document.querySelector('memory-projector').state.developing === false, null, { timeout: 15000 });
    await t.page.waitForTimeout(800);
    const h = await t.page.evaluate(() => document.querySelector('memory-projector').anchor('hologram'));
    assert.ok(await inkCells(t.page, { x: h.x - 60, y: h.y - 120, width: 120, height: 240 }) > 40, 'no figure on the homepage');
    await t.page.mouse.move(h.x, h.y);
    await t.page.waitForTimeout(400);
    const pill = await t.page.evaluate(() => { const p = document.getElementById('pill'); return { away: p.classList.contains('away'), label: p.querySelector('.lbl .on')?.textContent }; });
    assert.ok(pill.away || pill.label !== 'Talk to me', `the hologram offers "${pill.label}"`);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('the archived homepage still runs the Temporal Projector', async () => {
  const t = await openPage('/archive/projector/', { waitFor: 'temporal-projector[data-ready]' });
  try { assert.deepEqual(t.errors, []); } finally { await t.close(); }
});
