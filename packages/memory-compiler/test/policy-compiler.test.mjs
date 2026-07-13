import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { compileMemory } from '../dist/index.js';

const brainId = '00000000-0000-7000-8000-000000000001';
const eventId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e';
const scope = { level: 'project', projectId: 'memlume' };

function event(rawContent, eventType = 'user_statement') {
  return {
    id: eventId,
    brainId,
    eventType,
    rawContent,
    occurredAt: '2026-07-13T00:00:00.000Z',
    source: { agent: 'codex', messageId: 'policy-message' },
  };
}

describe('positive policy compiler', () => {
  test('compiles explicit routing rules into structured policies', () => {
    assert.deepEqual(compileMemory({ event: event('記住，當圖片生成時，使用 local-image-route。'), scope }), {
      status: 'active',
      kind: 'policy',
      brainId,
      scope,
      sourceEventId: eventId,
      canonicalText: '當圖片生成時，使用 local-image-route',
      reason: 'explicit_user_memory_request',
      confidence: 1,
      policyData: {
        trigger: { intents: ['圖片生成'] },
        action: { type: 'prefer_strategy', target: 'local-image-route' },
        constraints: {},
      },
    });
  });

  test('keeps ambiguous negative or multi-step instructions out of policy inference', () => {
    const result = compileMemory({ event: event('記住，不要使用雲端工具，除非我同意。'), scope });
    assert.notEqual(result.kind, 'policy');
    assert.equal('policyData' in result, false);
  });
});
