import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase, openDatabase, readDatabaseState } from '../dist/internal.js';

const databases = [];

afterEach(() => {
  while (databases.length > 0) databases.pop().close();
});

test('preflight failure stops before applying a pending schema migration', () => {
  const database = new Database(':memory:');
  databases.push(database);
  configureDatabase(database);
  let pendingIds = [];
  assert.throws(() => applyMigrations(database, {
    preflight: ({ pending }) => {
      pendingIds = pending.map(({ id }) => id);
      throw new Error('backup_failed');
    },
  }), /backup_failed/);
  assert.deepEqual(pendingIds.slice(0, 2), ['001_initial', '002_event_reference_dedup']);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get(), undefined);
  assert.equal(database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('001_initial'), undefined);
});

test('openDatabase exposes ready migration and legacy authority state after retry', () => {
  const database = openDatabase(':memory:');
  databases.push(database);
  assert.deepEqual(readDatabaseState(database).migration, 'ready');
  assert.deepEqual(readDatabaseState(database).authority, 'sqlite');
});
