import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';
const probe = (page) => page.evaluate(() => {
  const el = document.querySelector('memory-projector');
  return { developing: el.state.developing, glow: el.memoryGlow.material.opacity };
});

test('a new memory develops slowly with the light on; next time it does not', async () => {
  const t = await openPage('/memory-projector/demo/', { waitFor: READY });
  try {
    await t.page.waitForFunction(() => document.querySelector('memory-projector').state.id === 'demo-dance');
    await t.page.evaluate(() => document.querySelector('memory-projector').togglePower());
    await t.page.waitForTimeout(1200);
    const during = await probe(t.page);
    assert.equal(during.developing, true);
    assert.ok(during.glow > 0.5, `light at ${during.glow}`);
    // it develops for 2.4 s once its video has loaded (which takes a while in headless Chromium)
    await t.page.waitForFunction(() => document.querySelector('memory-projector').state.developing === false, null, { timeout: 10000 });
    await t.page.waitForTimeout(800);
    const after = await probe(t.page);
    assert.equal(after.developing, false);
    assert.ok(after.glow < 0.1, `light still at ${after.glow}`);
    const storageState = await t.context.storageState();
    await t.close();

    const u = await openPage('/memory-projector/demo/', { waitFor: READY, storageState });
    try {
      await u.page.waitForFunction(() => document.querySelector('memory-projector').state.id === 'demo-dance');
      await u.page.evaluate(() => document.querySelector('memory-projector').togglePower());
      await u.page.waitForTimeout(400);
      assert.equal((await probe(u.page)).developing, false);
    } finally { await u.close(); }
  } finally { await t.close().catch(() => {}); }
});
