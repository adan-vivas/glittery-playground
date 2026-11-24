import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';
const two = JSON.stringify([
  { id: 'one', src: 'demo-dance.mp4', story: 'First story.', title: 'One', fps: 12, seconds: 7, aspect: 1 },
  { id: 'two', src: 'demo-dance.mp4', story: 'Second story.', title: 'Two', fps: 12, seconds: 7, aspect: 1 },
]);
const manifest = (body, status = 200) => [['**/demo/memories.json', (r) => r.fulfill({ status, body, contentType: 'application/json' })]];
const state = (page) => page.evaluate(() => ({ ...document.querySelector('memory-projector').state }));

test('loads the demo memories, off, on the first one', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY });
  try {
    await t.page.waitForFunction(() => document.querySelector('memory-projector').state.id === 'demo-dance');
    const s = await state(t.page);
    assert.equal(s.index, 0); assert.equal(s.power, false);
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').setDate), undefined);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('next, back, shuffle and power, by API, keys and clicks', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest(two) });
  const { page } = t;
  try {
    await page.waitForFunction(() => document.querySelector('memory-projector').state.id === 'one');
    const detail = await page.evaluate(() => new Promise((ok) => {
      const el = document.querySelector('memory-projector');
      el.addEventListener('memorychange', (e) => ok(e.detail), { once: true });
      el.next();
    }));
    assert.deepEqual(detail, { id: 'two', index: 1, title: 'Two', story: 'Second story.' });
    const click = async (part) => {
      const p = await page.evaluate((n) => document.querySelector('memory-projector').anchor(n), part);
      assert.ok(p, `no anchor ${part}`);
      await page.mouse.click(p.x, p.y);
    };
    await click('next'); assert.equal((await state(page)).id, 'one');
    await click('back'); assert.equal((await state(page)).id, 'two');
    await page.focus('memory-projector');
    await page.keyboard.press('ArrowRight'); assert.equal((await state(page)).id, 'one');
    await page.keyboard.press('s'); assert.equal((await state(page)).id, 'two');
    await page.keyboard.press('Enter'); assert.equal((await state(page)).id, 'one');
    await page.keyboard.press('p'); assert.equal((await state(page)).power, true);
    await click('power'); assert.equal((await state(page)).power, false);
    await click('shuffle'); assert.equal((await state(page)).id, 'two');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('a missing manifest leaves a working, empty projector', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest('nope', 404) });
  try {
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(400);
    const s = await state(t.page);
    assert.equal(s.power, true); assert.equal(s.id, null);
    assert.deepEqual(t.errors, []);
    assert.equal(t.warnings.filter((w) => /memories/i.test(w)).length, 1, t.warnings.join('\n'));
  } finally { await t.close(); }
});
