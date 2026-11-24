import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPage } from './helpers/browser.mjs';

test('the old projector renders through the local CDN routes (WebGL works headless)', async () => {
  const t = await openPage('/temporal-projector/index.html', { waitFor: 'temporal-projector[data-ready]' });
  try {
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});
