import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openPage, PKG } from './helpers/browser.mjs';
import { validateEntry } from '../engine/manifest.js';

const CLIP = path.join(PKG, 'tests/fixtures/magenta-clip.mp4');

test('the engine turns a shaky clip into a steady, depth-only memory', { timeout: 300000 }, async () => {
  const t = await openPage('/memory-projector/engine/?matter=fake', { waitFor: '#file', viewport: { width: 1400, height: 1000 } });
  const { page } = t, foreign = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', 'cdn.jsdelivr.net', 'huggingface.co'].includes(u.hostname) && !/^(blob|data):/.test(r.url())) foreign.push(r.url());
  });
  try {
    // 1. load: a 9 s clip, 7 s taken from the start
    await page.setInputFiles('#file', CLIP);
    await page.waitForFunction(() => /7 s of 9\.0 s/.test(document.querySelector('#trim-note').textContent), null, { timeout: 30000 });
    assert.equal(await page.inputValue('#start'), '0');

    // 2. write: the word count and the warning past 120 words
    await page.fill('#story', Array(125).fill('word').join(' '));
    assert.equal(await page.textContent('#words'), '125');
    assert.ok(await page.isVisible('#words-warn'));
    await page.fill('#story', 'A magenta figure dances in a shaky hallway while its reflection watches.');
    assert.ok(!(await page.isVisible('#words-warn')));
    await page.fill('#title', 'Magenta dance');
    assert.equal(await page.inputValue('#id'), 'magenta-dance');

    // 3. pick: two figures in the first frame; drop the one on the right (the "reflection")
    await page.waitForFunction(() => document.querySelectorAll('button.figure').length === 2, null, { timeout: 60000 });
    const right = await page.evaluate(() => [...document.querySelectorAll('button.figure')].sort((a, b) => b.dataset.cx - a.dataset.cx)[0].dataset.id);
    await page.click(`button.figure[data-id="${right}"]`);
    assert.equal(await page.getAttribute(`button.figure[data-id="${right}"]`, 'aria-pressed'), 'false');

    // 4. process: every stage runs, the stage view has its four panes
    await page.click('#process');
    await page.waitForFunction(() => document.querySelector('#public').getAttribute('src'), null, { timeout: 240000 });
    for (const s of ['frames', 'cutout', 'steady', 'depth', 'loop']) assert.equal(await page.getAttribute(`.stage[data-stage="${s}"]`, 'data-state'), 'done', s);
    assert.equal(await page.locator('#stage-view .pane').count(), 4);

    // 5. check: the public preview says what it is
    assert.match(await page.textContent('label[for="public"]'), /This is what anyone can download/);

    // 6. export: the memory and the updated list
    const downloads = [];
    page.on('download', (d) => downloads.push(d));
    await page.click('#export');
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && downloads.length < 2; i++) await page.waitForTimeout(100);
    const byName = Object.fromEntries(await Promise.all(downloads.map(async (d) => [d.suggestedFilename(), await d.path()])));
    assert.deepEqual(Object.keys(byName).sort(), ['magenta-dance.mp4', 'memories.json']);
    const mp4 = fs.readFileSync(byName['magenta-dance.mp4']);
    assert.ok(mp4.length < 1e6, `${mp4.length} bytes`);
    const list = JSON.parse(fs.readFileSync(byName['memories.json'], 'utf8'));
    const entry = list.find((m) => m.id === 'magenta-dance');
    assert.ok(entry); assert.deepEqual(validateEntry(entry), []);
    assert.equal(entry.story, 'A magenta figure dances in a shaky hallway while its reflection watches.');

    // a memories.json that exists but can't be read: export refuses rather than write a list holding only this memory
    const before = downloads.length;
    await t.context.route('**/memory-projector/memories/memories.json', (r) => r.fulfill({ body: '{ not json', contentType: 'application/json' }));
    await page.click('#export');
    await page.waitForTimeout(1500);
    assert.equal(downloads.length, before, 'exported over an unreadable list');
    assert.match(await page.textContent('#status'), /couldn.t read/i);
    // no list yet (404): fine, it starts one, and says so
    await t.context.route('**/memory-projector/memories/memories.json', (r) => r.fulfill({ status: 404, body: '' }));
    await page.click('#export');
    for (let i = 0; i < 30 && downloads.length < before + 2; i++) await page.waitForTimeout(100);
    assert.equal(downloads.length, before + 2);
    assert.match(await page.textContent('#status'), /first memory/i);

    // the published file: one figure (the reflection is gone), standing still despite the shaky camera
    const r = await page.evaluate(async (b64) => {
      const { labelFigures } = await import('/memory-projector/engine/figures.js');
      const { measure } = await import('/memory-projector/engine/steady.js');
      const v = document.createElement('video');
      v.muted = true; v.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'video/mp4' }));
      await new Promise((ok) => v.addEventListener('loadeddata', ok, { once: true }));
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight), g = c.getContext('2d', { willReadFrequently: true });
      const out = { w: v.videoWidth, h: v.videoHeight, figures: [], ground: [], colour: 0 };
      for (const s of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
        v.currentTime = s;
        await new Promise((ok) => v.addEventListener('seeked', ok, { once: true }));
        g.drawImage(v, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data, m = new Float32Array(c.width * c.height);
        for (let i = 0; i < m.length; i++) { m[i] = d[i * 4] >= 32 ? 1 : 0; out.colour = Math.max(out.colour, Math.abs(d[i * 4] - d[i * 4 + 2])); }
        out.figures.push(labelFigures(m, c.width, c.height).figures.length);
        out.ground.push(measure(m, c.width, c.height).ground);
      }
      return out;
    }, mp4.toString('base64'));
    assert.equal(r.w, 256); assert.equal(r.h, 256);
    assert.deepEqual(r.figures, [1, 1, 1, 1, 1, 1], 'the dropped reflection came back');
    assert.ok(r.colour < 24, `the file has colour in it (${r.colour})`);
    const sd = (xs) => { const m = xs.reduce((a, b) => a + b) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    assert.ok(sd(r.ground.map((p) => p[0])) < 3, `ground x jitter ${sd(r.ground.map((p) => p[0]))}`);
    assert.ok(sd(r.ground.map((p) => p[1])) < 3, `ground y jitter ${sd(r.ground.map((p) => p[1]))}`);

    assert.deepEqual(foreign, [], 'the engine talked to an unexpected host');
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
