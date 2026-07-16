import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeState } from '../dist/index.js';

test('latches one degraded notification per area and clears after success', () => {
  let tick = 0;
  const state = new RuntimeState(() => `2026-07-16T00:00:0${tick++}.000Z`);
  assert.equal(state.markReadFailure('daemon timeout'), true);
  assert.equal(state.markReadFailure('daemon timeout'), false);
  assert.equal(state.snapshot().degraded[0].count, 2);
  state.markSuccess('context');
  assert.deepEqual(state.snapshot().degraded, []);
  assert.equal(state.snapshot().lastReadAt, '2026-07-16T00:00:02.000Z');
});
