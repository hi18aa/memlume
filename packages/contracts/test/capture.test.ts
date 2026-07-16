import { describe, expect, test } from 'vitest';

import { CaptureReceiptSchema, CaptureStatusSchema } from '../src/index.js';

describe('capture contracts', () => {
  test('keeps all durable atom states and complete receipt identity', () => {
    expect(CaptureStatusSchema.options).toHaveLength(8);
    expect(CaptureReceiptSchema.parse({
      captureId: 'capture-1',
      sourceReference: 'codex:message-1',
      status: 'candidate',
      atoms: [{ atomKey: 'atom-a', status: 'candidate' }],
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    }).atoms[0].status).toBe('candidate');
  });
});
