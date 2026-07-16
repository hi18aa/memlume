import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compileCapture } from '../dist/index.js';

describe('compileCapture', () => {
  test('splits mixed personal and project assertions without Brain UUIDs', async () => {
    const result = await compileCapture({ captureId: 'capture-1', rawContent: '記住，我偏好簡潔回答。這個專案使用 Vue。' });
    assert.equal(result.status, 'accepted');
    assert.deepEqual(result.atoms.map((atom) => atom.scope), ['personal', 'project']);
    assert.equal(result.atoms.some((atom) => Object.hasOwn(atom, 'brainId')), false);
    assert.equal(new Set(result.atoms.map((atom) => atom.atomKey)).size, result.atoms.length);
  });

  test('filters secrets before invoking a provider', async () => {
    let calls = 0;
    const result = await compileCapture({
      rawContent: '記住 API_KEY=secret-not-for-memory',
      provider: { extract: async () => { calls += 1; return { atoms: [] }; } },
    });
    assert.equal(result.status, 'rejected');
    assert.equal(calls, 0);
  });

  test('rejects provider output that attempts to select a Brain', async () => {
    const result = await compileCapture({
      rawContent: 'Please classify this assertion.',
      provider: { extract: async () => ({ atoms: [{ text: 'Use Vue.', scope: 'project', brainId: '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e' }] }) },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'provider_failed');
  });

  test('greetings are ignored and assistant assertions stay low-confidence', async () => {
    assert.equal((await compileCapture({ rawContent: 'Hello!' })).status, 'ignored');
    assert.equal((await compileCapture({ rawContent: 'Thanks, that helps.' })).status, 'ignored');
    const result = await compileCapture({ rawContent: 'The project uses pnpm.', actor: 'assistant' });
    assert.equal(result.atoms[0].confidence, 0.25);
  });
});
