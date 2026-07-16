import { describe, expect, test } from 'vitest';

import { planCapture } from '../src/capture-pipeline.js';

const personal = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e';
const project = '018f9d4e-7c2a-7b91-8dc0-61749dbcc01f';

describe('capture pipeline', () => {
  test('returns one receipt per atom and routes personal/project independently', async () => {
    const result = await planCapture({
      captureId: 'capture-1',
      rawContent: '記住，我偏好簡潔回答。這個專案使用 Vue。',
      catalog: [
        { brainId: personal, kind: 'personal', role: 'personal', access: 'read_write' },
        { brainId: project, kind: 'project', role: 'primary', access: 'read_write', name: 'memlume' },
      ],
      now: '2026-07-16T00:00:00.000Z',
    });
    expect(result.receipt.atoms).toHaveLength(2);
    expect(result.receipt.atoms.map((atom) => atom.status)).toEqual(['active', 'active']);
    expect(result.receipt.status).toBe('active');
  });

  test('keeps unknown project assertions in routing_required', async () => {
    const result = await planCapture({
      captureId: 'capture-2',
      rawContent: '記住，未知專案使用 Vue。',
      catalog: [{ brainId: personal, kind: 'personal', role: 'personal', access: 'read_write' }],
      now: '2026-07-16T00:00:00.000Z',
    });
    expect(result.receipt.status).toBe('routing_required');
  });
});
