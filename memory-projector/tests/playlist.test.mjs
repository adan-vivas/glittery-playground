import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaylist } from '../lib/playlist.js';

const three = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('next and back wrap around', () => {
  const p = createPlaylist(three);
  assert.equal(p.size, 3); assert.equal(p.index, 0); assert.equal(p.current.id, 'a');
  p.next(); p.next(); assert.equal(p.next().id, 'a');
  assert.equal(p.back().id, 'c'); assert.equal(p.index, 2);
});

test('shuffle never repeats the current memory', () => {
  const p = createPlaylist(three);
  for (let i = 0; i < 200; i++) { const before = p.current.id; assert.notEqual(p.shuffle().id, before); }
});

test('shuffle with one memory stays on it', () => {
  const p = createPlaylist([{ id: 'only' }]);
  assert.equal(p.shuffle().id, 'only');
});

test('an empty playlist has nothing to show', () => {
  const p = createPlaylist([]);
  assert.equal(p.current, null);
  assert.equal(p.next(), null); assert.equal(p.back(), null); assert.equal(p.shuffle(), null);
});

test('show jumps by id and refuses unknown ids', () => {
  const p = createPlaylist(three);
  assert.equal(p.show('c'), true); assert.equal(p.index, 2);
  assert.equal(p.show('nope'), false); assert.equal(p.index, 2);
});

test('shuffle uses the injected random source', () => {
  const p = createPlaylist(three, () => 0);          // always the first of the others
  assert.equal(p.shuffle().id, 'b');
});
