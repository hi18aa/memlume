import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as compiler from '../dist/index.js';

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
    source: { agent: 'codex', messageId: 'message-1' },
  };
}

describe('compileMemory', () => {
  test('promotes explicit Chinese and English user requests to active proposals', () => {
    assert.equal(typeof compiler.compileMemory, 'function');

    const cases = [
      {
        rawContent: '記住，我使用 Vue 開發前端。',
        canonicalText: '我使用 Vue 開發前端',
      },
      {
        rawContent: 'remember this project uses pnpm',
        canonicalText: 'this project uses pnpm',
      },
      {
        rawContent: '記住，我偏好簡潔回答。',
        canonicalText: '我偏好簡潔回答',
        kind: 'preference',
      },
    ];

    for (const value of cases) {
      assert.deepEqual(compiler.compileMemory({ event: event(value.rawContent), scope }), {
        status: 'active',
        kind: value.kind ?? 'fact',
        brainId,
        scope,
        sourceEventId: eventId,
        canonicalText: value.canonicalText,
        reason: 'explicit_user_memory_request',
        confidence: 1,
      });
    }
  });

  test('keeps inferred user statements as candidate proposals', () => {
    assert.deepEqual(compiler.compileMemory({ event: event('This project uses pnpm.'), scope }), {
      status: 'candidate',
      kind: 'fact',
      brainId,
      scope,
      sourceEventId: eventId,
      canonicalText: 'This project uses pnpm',
      reason: 'inferred_from_user_statement',
      confidence: 0.5,
    });
  });

  test('never promotes an agent inference beyond a candidate', () => {
    assert.deepEqual(compiler.compileMemory({ event: event('remember this project uses pnpm', 'agent_inference'), scope }), {
      status: 'candidate',
      kind: 'fact',
      brainId,
      scope,
      sourceEventId: eventId,
      canonicalText: 'remember this project uses pnpm',
      reason: 'agent_inference_requires_review',
      confidence: 0.25,
    });
  });

  test('ignores transcripts and non-user events by default', () => {
    assert.deepEqual(compiler.compileMemory({ event: event('User: use pnpm\nAgent: I will.', 'conversation_transcript'), scope }), {
      status: 'ignore',
      reason: 'transcript_not_captured',
      confidence: 0,
    });
    assert.deepEqual(compiler.compileMemory({ event: event('Implemented the feature.', 'task_completed'), scope }), {
      status: 'ignore',
      reason: 'unsupported_event_type',
      confidence: 0,
    });
  });

  test('rejects secret-bearing content without returning the secret', () => {
    const secret = 'sk-live-not-for-memory';
    const result = compiler.compileMemory({ event: event(`記住，API_KEY=${secret}`), scope });

    assert.deepEqual(result, {
      status: 'rejected',
      reason: 'secret_detected',
      confidence: 0,
      redactedContent: '記住，API_KEY=[redacted]',
    });
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  test('rejects explicit memory requests carrying common credentials', () => {
    const cases = [
      ['OPENAI_API_KEY=sk-live-environment-secret', 'sk-live-environment-secret'],
      ['AUTH_TOKEN=authentication-secret-value', 'authentication-secret-value'],
      ['Authorization: Bearer bearer-secret-value', 'bearer-secret-value'],
    ];

    for (const [credential, secret] of cases) {
      const result = compiler.compileMemory({ event: event(`remember ${credential}`), scope });
      assert.equal(result.status, 'rejected');
      assert.equal(JSON.stringify(result).includes(secret), false);
    }
  });
});
