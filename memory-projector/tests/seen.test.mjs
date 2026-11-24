import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeen } from '../lib/seen.js';

const mapStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };

test('remembers which memories were shown, across instances', () => {
  const st = mapStorage();
  const a = createSeen(st);
  assert.equal(a.has('kids'), false);
  a.mark('kids');
  assert.equal(a.has('kids'), true);
  assert.equal(createSeen(st).has('kids'), true);
});

test('a storage that throws makes everything new, quietly', () => {
  const st = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const s = createSeen(st);
  assert.equal(s.has('kids'), false);
  assert.doesNotThrow(() => s.mark('kids'));
});

test('no storage at all is fine', () => {
  const s = createSeen(null);
  assert.equal(s.has('x'), false);
  s.mark('x');
});

test('corrupted data counts as empty', () => {
  const st = mapStorage();
  st.setItem('memory-projector:seen', '{not json');
  assert.equal(createSeen(st).has('kids'), false);
  st.setItem('memory-projector:seen', '"a string"');
  assert.equal(createSeen(st).has('a'), false);
});
