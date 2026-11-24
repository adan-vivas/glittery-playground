import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapLines, crawlState } from '../lib/crawl.js';

const measure = (s) => s.length * 10;

test('wrapLines keeps every line inside the width', () => {
  const lines = wrapLines('the quick brown fox jumps over the lazy dog again and again', measure, 100);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(measure(l) <= 100, `too wide: "${l}"`);
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog again and again');
});

test('wrapLines breaks a word wider than the line', () => {
  const lines = wrapLines('x'.repeat(60), measure, 100);
  assert.ok(lines.length >= 6);
  for (const l of lines) assert.ok(measure(l) <= 100);
  assert.equal(lines.join(''), 'x'.repeat(60));
});

test('wrapLines of nothing is nothing', () => {
  assert.deepEqual(wrapLines('', measure, 100), []);
  assert.deepEqual(wrapLines('   ', measure, 100), []);
});

const opts = { lineCount: 6, lineHeight: 50, viewHeight: 400, words: 20 };

test('crawlState: the text passes in words / 2 seconds, then pauses, then repeats', () => {
  assert.equal(crawlState(0, opts).offset, -400);
  assert.equal(crawlState(10, opts).offset, 300);                 // gone past the far edge
  assert.equal(crawlState(11, opts).alpha, 0);                    // the pause
  assert.equal(crawlState(12.4, opts).alpha, 0);
  assert.equal(crawlState(12.5, opts).offset, -400);              // and again
  assert.ok(crawlState(5, opts).alpha > 0);
});

test('crawlState: short stories still take at least 4 s', () => {
  const s = crawlState(2, { ...opts, words: 2 });
  assert.equal(s.offset, -400 + (300 + 400) * 0.5);
});

test('crawlState: a 400-word story still loops, moving forward all the way', () => {
  const o = { ...opts, words: 400, lineCount: 120 };
  let last = -Infinity;
  for (let t = 0; t < 200; t += 0.5) { const s = crawlState(t, o); assert.ok(s.offset >= last); last = s.offset; }
  assert.equal(crawlState(201, o).alpha, 0);
  assert.equal(crawlState(202.5, o).offset, -400);
});
