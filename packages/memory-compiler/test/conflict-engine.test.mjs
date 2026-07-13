import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import * as compiler from '../dist/index.js';

const brainId = '00000000-0000-7000-8000-000000000001';
const scope = { level: 'project', projectId: 'memlume' };

function fact({ id, text, object, status = 'active' }) {
  return {
    id,
    brainId,
    kind: 'fact',
    canonicalText: text,
    structuredData: { subject: 'project', predicate: 'package_manager', object, confidence: 1 },
    scope,
    status,
  };
}

describe('assessMemoryConflict', () => {
  test('reuses a complete duplicate in the same brain and scope', () => {
    assert.equal(typeof compiler.assessMemoryConflict, 'function');

    assert.deepEqual(
      compiler.assessMemoryConflict({
        proposal: fact({ id: 'proposal', text: 'The project uses pnpm.', object: 'pnpm' }),
        existing: [fact({ id: 'existing', text: 'the   project uses pnpm', object: 'pnpm' })],
      }),
      { action: 'reuse', memoryId: 'existing', requiresConfirmation: false },
    );
  });

  test('matches scopes by fields rather than JSON property order', () => {
    assert.deepEqual(
      compiler.assessMemoryConflict({
        proposal: {
          ...fact({ id: 'proposal', text: 'The project uses pnpm.', object: 'pnpm' }),
          scope: { level: 'project', workspace: 'tools', projectId: 'memlume' },
        },
        existing: [{
          ...fact({ id: 'existing', text: 'The project uses pnpm.', object: 'pnpm' }),
          scope: { projectId: 'memlume', workspace: 'tools', level: 'project' },
        }],
      }),
      { action: 'reuse', memoryId: 'existing', requiresConfirmation: false },
    );
  });

  test('requires confirmation for an explicit high-risk factual contradiction', () => {
    assert.deepEqual(
      compiler.assessMemoryConflict({
        proposal: fact({ id: 'proposal', text: 'The project uses npm.', object: 'npm' }),
        existing: [fact({ id: 'existing', text: 'The project uses pnpm.', object: 'pnpm' })],
      }),
      { action: 'review', memoryId: 'existing', requiresConfirmation: true },
    );
  });

  test('keeps inferred candidates from replacing an active memory', () => {
    assert.deepEqual(
      compiler.assessMemoryConflict({
        proposal: fact({ id: 'proposal', text: 'The project uses npm.', object: 'npm', status: 'candidate' }),
        existing: [fact({ id: 'existing', text: 'The project uses pnpm.', object: 'pnpm' })],
      }),
      { action: 'create', requiresConfirmation: false },
    );
  });
});
