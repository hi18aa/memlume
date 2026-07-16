import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveApproval, stableApprovalKey } from '../dist/index.js';

test('a short approval activates only a valid buffered assistant final', async () => {
  const result = await resolveApproval({ finalAnswer: 'I use Vue for the frontend.', approval: '可以' });
  assert.equal(result.status, 'active');
  assert.equal(result.mode, 'approval');
  assert.equal(result.atoms.length, 1);
  assert.equal(result.atoms[0].explicitness, 1);
  assert.equal(result.atoms[0].actor, 'user');
});

test('approval without a buffer and conversational chatter stay ignored', async () => {
  assert.equal((await resolveApproval({ approval: '可以' })).reason, 'no_buffer');
  assert.equal((await resolveApproval({ finalAnswer: 'I use Vue.', approval: '收到' })).reason, 'not_approval');
});

test('expired buffers, secrets, and corrections are deterministic', async () => {
  assert.equal((await resolveApproval({ finalAnswer: 'I use Vue.', approval: 'yes', finalCapturedAt: '2026-07-14T00:00:00.000Z', now: '2026-07-16T00:00:00.000Z' })).reason, 'expired');
  assert.equal((await resolveApproval({ finalAnswer: 'api_key=secret', approval: 'yes' })).status, 'rejected');
  const correction = await resolveApproval({ finalAnswer: 'I use Vue.', approval: '修正：I use React.' });
  assert.equal(correction.status, 'active');
  assert.equal(correction.mode, 'correction');
  assert.equal(correction.approvalKey, stableApprovalKey('I use Vue.', '修正：I use React.'));
});
