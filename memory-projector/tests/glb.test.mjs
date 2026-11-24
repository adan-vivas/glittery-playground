import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PKG } from './helpers/browser.mjs';

// Reads a GLB's JSON chunk and the min/max of a mesh's POSITION accessor, without dependencies.
function readGlb(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('ascii', 0, 4), 'glTF');
  const len = b.readUInt32LE(12);
  return JSON.parse(b.toString('utf8', 20, 20 + len));
}
const GLB = path.join(PKG, 'assets/memory-projector.glb');

test('ZL 3 exposes the parts the component drives', () => {
  const g = readGlb(GLB), names = new Set(g.nodes.map((n) => n.name));
  for (const n of ['body', 'power_button', 'key_back', 'key_shuffle', 'key_next', 'memory_led', 'strap'])
    assert.ok(names.has(n), `missing node ${n}`);
  for (const n of ['dial', 'prf_key', 'crown', 'crown_axle']) assert.ok(!names.has(n), `ZL 2 part ${n} still there`);
  assert.ok(g.materials.some((m) => m.name === 'memory_led'), 'no memory_led material');
});

test('the case keeps ZL 2 proportions (112 x 64 mm)', () => {
  const g = readGlb(GLB), node = g.nodes.find((n) => n.name === 'body');
  const mesh = g.meshes[node.mesh];
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of mesh.primitives) {
    const a = g.accessors[p.attributes.POSITION];
    min = min.map((v, i) => Math.min(v, a.min[i])); max = max.map((v, i) => Math.max(v, a.max[i]));
  }
  const s = node.scale || [1, 1, 1];
  assert.ok(Math.abs((max[0] - min[0]) * s[0] - 0.112) < 0.001, `width ${(max[0] - min[0]) * s[0]}`);
  assert.ok(Math.abs((max[2] - min[2]) * s[2] - 0.064) < 0.001, `depth ${(max[2] - min[2]) * s[2]}`);
});
