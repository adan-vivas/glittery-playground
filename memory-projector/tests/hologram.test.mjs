import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage, inkCells, clampToViewport, pixelDiff } from './helpers/browser.mjs';

const READY = 'memory-projector[data-ready]';
const entry = (id, src) => ({ id, src, story: `Story ${id}.`, title: id, fps: 12, seconds: 7, aspect: 1 });
const manifest = (list) => [['**/demo/memories.json', (r) => r.fulfill({ body: JSON.stringify(list), contentType: 'application/json' })]];
const FIGURE = 60, NONE = 5;   // dense ink cells: a figure has well over FIGURE, the beam alone under NONE
const DANCE = 'demo-dance.mp4', EMPTY = '../tests/fixtures/empty.mp4';

// The middle third (across) of the hologram's frame on screen, from a little above its foot to its top: where the figure
// stands, clear of most of the beam's edges.
async function figureRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector('memory-projector'), f = el.holo.frame, w = 0.15, h = 0.15;
    f.updateMatrixWorld(true);
    const at = (x, y) => el.toScreen(f.localToWorld(f.position.clone().set(x, y, 0)));
    const a = at(-w / 6, -h / 2 + h * 0.08), b = at(w / 6, h / 2);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  });
}
const powerOn = (page) => page.evaluate(() => document.querySelector('memory-projector').togglePower());

test('a memory rises out of the lens as blue dots', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY });
  try {
    await powerOn(t.page);
    await t.page.waitForTimeout(3000);
    const n = await inkCells(t.page, await figureRect(t.page));
    assert.ok(n > FIGURE, `only ${n} figure ink cells`);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('an empty memory shows no figure', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest([entry('e', EMPTY)]) });
  try {
    await powerOn(t.page);
    await t.page.waitForTimeout(3000);
    const n = await inkCells(t.page, await figureRect(t.page));
    assert.ok(n < NONE, `${n} figure ink cells from an empty memory`);
  } finally { await t.close(); }
});

test('rapid presses settle on the last memory, risen', async () => {
  const list = [entry('a', DANCE), entry('b', EMPTY), entry('c', DANCE)];
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest(list) });
  try {
    await powerOn(t.page);
    await t.page.waitForTimeout(1500);
    await t.page.evaluate(async () => {
      const el = document.querySelector('memory-projector');
      for (let i = 0; i < 5; i++) { el.next(); await new Promise((r) => setTimeout(r, 60)); }
    });
    await t.page.waitForTimeout(3000);
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').state.id), 'c');   // (0 + 5) % 3 = 2
    const n = await inkCells(t.page, await figureRect(t.page));
    assert.ok(n > FIGURE, `only ${n} figure ink cells after rapid presses`);
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('when autoplay is refused it shows the first frame, and plays on the next press', async () => {
  const initScript = () => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return window.__allowPlay ? play.call(this) : Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    };
  };
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, initScript });
  try {
    await powerOn(t.page);
    await t.page.waitForTimeout(3000);
    const n = await inkCells(t.page, await figureRect(t.page));
    assert.ok(n > FIGURE, `only ${n} figure ink cells with autoplay refused`);
    assert.deepEqual(t.errors, []);
    await t.page.evaluate(() => { window.__allowPlay = true; document.querySelector('memory-projector').next(); });
    await t.page.waitForTimeout(800);
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').depth.video.paused), false);
  } finally { await t.close(); }
});

test('a missing memory video warns once and shows nothing', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, routes: manifest([entry('gone', 'gone.mp4')]) });
  try {
    await powerOn(t.page);
    const gone = () => t.warnings.filter((w) => /gone\.mp4/.test(w)).length;
    for (let i = 0; i < 40 && !gone(); i++) await t.page.waitForTimeout(200);   // the video's error arrives when it arrives
    await t.page.waitForTimeout(1000);                                        // and only once after that
    assert.deepEqual(t.errors, []);
    assert.equal(gone(), 1, t.warnings.join('\n'));
    const n = await inkCells(t.page, await figureRect(t.page));
    assert.ok(n < NONE, `${n} figure ink cells without a video`);
    await t.page.waitForTimeout(800);
    const after = await t.page.evaluate(() => {
      const el = document.querySelector('memory-projector'), c = el._crawlCanvas, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let ink = 0; for (let i = 3; i < d.length; i += 4) ink += d[i];
      return { developing: el.state.developing, glow: el.memoryGlow.material.opacity, ink };
    });
    assert.equal(after.developing, false, 'the memory light still says a memory is developing');
    assert.ok(after.glow < 0.1, `memory light at ${after.glow}`);
    assert.equal(after.ink, 0, 'the story of a broken memory is on the table');
  } finally { await t.close(); }
});

test('reduced motion: a still figure', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY, reducedMotion: 'reduce' });
  try {
    await powerOn(t.page);
    await t.page.waitForTimeout(2500);
    const r = clampToViewport(t.page, await figureRect(t.page));
    const a = await t.page.screenshot({ clip: r });
    await t.page.waitForTimeout(500);
    const b = await t.page.screenshot({ clip: r });
    const moved = await pixelDiff(t.page, a, b);
    assert.ok(moved < 20, `the hologram moved under reduced motion (${moved} px)`);
    assert.ok(await inkCells(t.page, r) > FIGURE, 'no figure under reduced motion');
  } finally { await t.close(); }
});

test('a format-2 file plays as format 2 even when the list doesn\'t say so', async () => {
  const t = await openPage('/memory-projector/index.html', { waitFor: READY,
    routes: manifest([entry('f2', '../tests/fixtures/format2.mp4')]) });   // no "format" in the entry
  try {
    await powerOn(t.page);
    await t.page.waitForFunction(() => document.querySelector('memory-projector').depth.ready, null, { timeout: 20000 });
    await t.page.waitForTimeout(300);
    assert.equal(await t.page.evaluate(() => document.querySelector('memory-projector').depth.material.uniforms.uFormat.value), 2);
  } finally { await t.close(); }
});
