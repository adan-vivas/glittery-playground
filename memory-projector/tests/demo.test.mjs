import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from './helpers/browser.mjs';

test('the demo page reads out the memory while the projector is on', async () => {
  const t = await openPage('/memory-projector/demo/', { waitFor: 'memory-projector[data-ready]' });
  const readout = () => t.page.textContent('#readout');
  try {
    assert.equal(await readout(), 'Off');
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(200);
    assert.equal(await readout(), 'A demo dance');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
