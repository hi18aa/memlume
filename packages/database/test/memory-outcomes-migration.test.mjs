import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase } from '../dist/internal.js';

const databases = [];

afterEach(() => {
  while (databases.length > 0) databases.pop().close();
});

describe('memory outcomes migration', () => {
  test('records the migration and creates explainable feedback indexes', () => {
    const database = new Database(':memory:');
    databases.push(database);
    configureDatabase(database);
    applyMigrations(database);

    assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('004_memory_outcomes'));
    assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('005_feedback_receipts'));
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_memory_usage_memory_used_at', 'idx_memory_usage_task_used_at', 'idx_outcomes_task_created_at', 'idx_context_receipts_agent_expires', 'idx_memory_usage_trace_id')")
      .pluck()
      .all()
      .sort();
    assert.deepEqual(indexes, [
      'idx_context_receipts_agent_expires',
      'idx_memory_usage_memory_used_at',
      'idx_memory_usage_task_used_at',
      'idx_memory_usage_trace_id',
      'idx_outcomes_task_created_at',
    ]);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_receipts'").get());
    assert.ok(database.prepare('SELECT 1 FROM pragma_table_info(\'memory_usage\') WHERE name = \'trace_id\'').get());
  });
});
