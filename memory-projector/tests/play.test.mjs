import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, inkCells } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';
async function on(page) {
  await page.evaluate(() => document.querySelector('memory-projector').togglePower());
  await page.waitForFunction(() => document.querySelector('memory-projector').state.developing === false, null, { timeout: 20000 });
  await page.waitForTimeout(600);
}
const around = async (page) => { const h = await page.evaluate(() => document.querySelector('memory-projector').anchor('hologram')); return { x: h.x - 70, y: h.y - 120, width: 140, height: 240 }; };

test('the hologram\'s look is part of the scene: density, colour, dot size, depth', async () => {
  const t = await openPage('/memory-projector/tests/fixtures/table.html', { waitFor: READY, viewport: { width: 1280, height: 860 } });
  try {
    await on(t.page);
    const cfg = await t.page.evaluate(() => document.querySelector('memory-projector').getScene());
    for (const k of ['dotSize', 'density', 'brightness', 'contrast', 'depth', 'scanlines', 'flicker', 'glitch', 'color']) assert.ok(k in cfg.hologram, `hologram.${k}`);
    for (const k of ['speed', 'size', 'opacity', 'light']) assert.ok(k in cfg.story, `story.${k}`);
    assert.ok(await inkCells(t.page, await around(t.page)) > 40);
    await t.page.evaluate(() => document.querySelector('memory-projector').setScene({ hologram: { density: 0 } }));
    await t.page.waitForTimeout(300);
    assert.ok(await inkCells(t.page, await around(t.page)) < 5, 'density 0 should hide the dots');
    const u = await t.page.evaluate(() => {
      const el = document.querySelector('memory-projector');
      el.setScene({ hologram: { density: 1, color: '#ff0000', depth: 0.5 } });
      const m = el.depth.material.uniforms;
      return { r: m.uInk.value.x, g: m.uInk.value.y, thick: m.uThick.value };
    });
    assert.ok(u.r > 0.9 && u.g < 0.1, JSON.stringify(u)); assert.equal(u.thick, 0.5);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('the story\'s size and speed are live', async () => {
  const t = await openPage('/memory-projector/tests/fixtures/table.html', { waitFor: READY });
  try {
    await on(t.page);
    const font = await t.page.evaluate(async () => {
      const el = document.querySelector('memory-projector');
      el.setScene({ story: { size: 60, speed: 3 } });
      await new Promise((r) => setTimeout(r, 900));
      return el._crawl.font;
    });
    assert.match(font, /60px/);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('moving the cursor through the memory disturbs the dots, and they settle back', async () => {
  const t = await openPage('/memory-projector/tests/fixtures/table.html', { waitFor: READY });
  try {
    await on(t.page);
    const h = await t.page.evaluate(() => document.querySelector('memory-projector').anchor('hologram'));
    const strength = () => t.page.evaluate(() => Math.max(...document.querySelector('memory-projector').depth.material.uniforms.uTouches.value.map((v) => v.w)));
    assert.ok(await strength() < 0.01);
    await t.page.mouse.move(h.x - 60, h.y); await t.page.mouse.move(h.x + 60, h.y, { steps: 10 });
    assert.ok(await strength() > 0.3, 'no touch registered');
    await t.page.waitForTimeout(3000);
    assert.ok(await strength() < 0.05, 'the dots never settled');
    await t.page.evaluate(() => document.querySelector('memory-projector').setScene({ touch: { on: false } }));
    await t.page.mouse.move(h.x - 60, h.y + 20, { steps: 10 });
    assert.ok(await strength() < 0.05, 'touch off still disturbs the dots');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
