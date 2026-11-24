import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordCount, slugify, validateEntry, upsertMemory } from '../engine/manifest.js';

const ok = { id: 'kids-park', src: 'kids-park.mp4', story: 'We played.', fps: 12, seconds: 7, aspect: 1 };

test('wordCount', () => { assert.equal(wordCount('  one two\nthree '), 3); assert.equal(wordCount(''), 0); });
test('slugify', () => { assert.equal(slugify('Kids at the Park!'), 'kids-at-the-park'); assert.equal(slugify('Ñandú día'), 'nandu-dia'); assert.equal(slugify(''), 'memory'); });

test('validateEntry', () => {
  assert.deepEqual(validateEntry(ok), []);
  assert.ok(validateEntry({ ...ok, seconds: 8 }).length);
  assert.ok(validateEntry({ ...ok, id: 'Kids Park' }).length);
  assert.ok(validateEntry({ ...ok, story: '  ' }).length);
  assert.ok(validateEntry({ ...ok, src: 'x.mov' }).length);
  assert.ok(validateEntry({ ...ok, fps: 30 }).length);
});

test('upsertMemory replaces in place, inserts by date', () => {
  const list = [{ ...ok, id: 'a', date: '2020-01-01' }, { ...ok, id: 'b', date: '2024-01-01' }, { ...ok, id: 'c' }];
  const replaced = upsertMemory(list, { ...ok, id: 'b', date: '2024-01-01', story: 'new' });
  assert.deepEqual(replaced.map((m) => m.id), ['a', 'b', 'c']); assert.equal(replaced[1].story, 'new');
  const inserted = upsertMemory(list, { ...ok, id: 'd', date: '2022-06-01' });
  assert.deepEqual(inserted.map((m) => m.id), ['a', 'd', 'b', 'c']);
  const undated = upsertMemory(list, { ...ok, id: 'e' });
  assert.deepEqual(undated.map((m) => m.id), ['a', 'b', 'c', 'e']);
  assert.equal(list.length, 3, 'does not mutate');
});
