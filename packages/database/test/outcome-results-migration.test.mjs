import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openDatabase } from '../dist/internal.js';
import { outcomeResultsMigration } from '../dist/migrations/011_outcome_results.js';

test('normalizes legacy task outcomes and preserves correction evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'memlume-outcome-migration-'));
  const database = openDatabase(join(root, 'memlume.sqlite'));
  try {
    database.prepare('INSERT INTO outcomes (id, task_id, agent_id, result, correction_type, correction_data, used_memory_ids, used_tool_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '018f9d4e-7c2f-7b91-8dc0-61749dbcc011', 'legacy-success', 'agent', 'success', null, null, '[]', '[]', '2026-07-16T00:00:00.000Z',
    );
    database.prepare('INSERT INTO outcomes (id, task_id, agent_id, result, correction_type, correction_data, used_memory_ids, used_tool_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '018f9d4e-7c2f-7b91-8dc0-61749dbcc012', 'legacy-corrected', 'agent', 'corrected', null, '{"note":"Use pnpm"}', '[]', '[]', '2026-07-16T00:00:00.000Z',
    );
    outcomeResultsMigration.up(database);
    assert.equal(database.prepare('SELECT result FROM outcomes WHERE task_id = ?').get('legacy-success').result, 'completed');
    const corrected = database.prepare('SELECT result, correction_type, correction_data FROM outcomes WHERE task_id = ?').get('legacy-corrected');
    assert.deepEqual(corrected, { result: 'unknown', correction_type: 'legacy_corrected', correction_data: '{"note":"Use pnpm"}' });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
