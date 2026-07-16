import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase } from '../dist/internal.js';

describe('adapter heartbeat migration', () => {
  test('creates an idempotent, installation-owned heartbeat ledger', () => {
    const database = new Database(':memory:');
    try {
      configureDatabase(database);
      applyMigrations(database);
      const columns = database.prepare('PRAGMA table_info(adapter_heartbeats)').all().map(({ name }) => name);
      assert.deepEqual(columns, [
        'agent_installation_id',
        'callback',
        'protocol_version',
        'adapter_version',
        'first_seen_at',
        'last_seen_at',
      ]);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').pluck().get('010_adapter_heartbeats'), 1);
      applyMigrations(database);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').pluck().get('010_adapter_heartbeats'), 1);
    } finally {
      database.close();
    }
  });
});
