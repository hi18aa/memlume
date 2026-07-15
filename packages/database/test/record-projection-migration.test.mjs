import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase } from '../dist/internal.js';

describe('record projection migration', () => {
  test('creates an idempotent projection ledger without runtime metadata', () => {
    const database = new Database(':memory:');
    try {
      configureDatabase(database);
      applyMigrations(database);
      const columns = database.prepare('PRAGMA table_info(record_projections)').all().map(({ name }) => name);
      assert.deepEqual(columns, [
        'record_id',
        'relative_path',
        'checksum',
        'memory_id',
        'brain_id',
        'supersedes_record_id',
        'projected_at',
      ]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').pluck().get('008_record_projection'), 1);
      applyMigrations(database);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').pluck().get('008_record_projection'), 1);
    } finally {
      database.close();
    }
  });
});
