import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase, migrations } from '../dist/internal.js';

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
    assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('006_receipt_hardening'));
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_memory_usage_memory_used_at', 'idx_memory_usage_task_used_at', 'idx_outcomes_task_created_at', 'idx_context_receipts_agent_expires', 'idx_memory_usage_trace_id', 'idx_memory_usage_trace_memory_outcome', 'idx_user_confirmations_expires_at', 'idx_feedback_signal_claims_agent_memory_at')")
      .pluck()
      .all()
      .sort();
    assert.deepEqual(indexes, [
      'idx_context_receipts_agent_expires',
      'idx_feedback_signal_claims_agent_memory_at',
      'idx_memory_usage_memory_used_at',
      'idx_memory_usage_task_used_at',
      'idx_memory_usage_trace_id',
      'idx_memory_usage_trace_memory_outcome',
      'idx_outcomes_task_created_at',
      'idx_user_confirmations_expires_at',
    ]);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_receipts'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_confirmations'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_signal_claims'").get());
    assert.ok(database.prepare('SELECT 1 FROM pragma_table_info(\'memory_usage\') WHERE name = \'trace_id\'').get());
    assert.ok(database.prepare('SELECT 1 FROM pragma_table_info(\'context_receipts\') WHERE name = \'source_memory_ids\'').get());
  });

  test('upgrades a database that already recorded the original receipt migration', () => {
    const database = new Database(':memory:');
    databases.push(database);
    configureDatabase(database);
    database.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const recordMigration = database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
    for (const migration of migrations.slice(0, 5)) {
      migration.up(database);
      recordMigration.run(migration.id, '2026-07-13T00:00:00.000Z');
    }

    assert.equal(database.prepare('SELECT 1 FROM pragma_table_info(\'context_receipts\') WHERE name = \'source_memory_ids\'').get(), undefined);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_confirmations'").get(), undefined);

    applyMigrations(database);

    assert.ok(database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('006_receipt_hardening'));
    assert.ok(database.prepare('SELECT 1 FROM pragma_table_info(\'context_receipts\') WHERE name = \'source_memory_ids\'').get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_confirmations'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback_signal_claims'").get());
  });
});
