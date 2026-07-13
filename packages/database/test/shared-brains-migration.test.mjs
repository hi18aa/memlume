import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { configureDatabase, applyMigrations } from '../dist/internal.js';
import { initialMigration } from '../dist/migrations/001_initial.js';
import { eventReferenceDedupMigration } from '../dist/migrations/002_event_reference_dedup.js';

const DEFAULT_PERSONAL_BRAIN_ID = '00000000-0000-7000-8000-000000000001';
const timestamp = '2026-07-13T12:00:00.000Z';
const databases = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop().close();
  }
});

function createLegacyDatabase() {
  const database = new Database(':memory:');
  databases.push(database);
  configureDatabase(database);
  initialMigration.up(database);
  eventReferenceDedupMigration.up(database);
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('001_initial', timestamp);
  database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run('002_event_reference_dedup', timestamp);
  database
    .prepare(`
      INSERT INTO events (
        id, event_type, raw_content, structured_data, source_type, source_agent, source_reference, source_data,
        occurred_at, ingested_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('legacy-event', 'note', 'Keep SQLite local.', null, 'test', null, null, '{}', timestamp, timestamp, 'event-hash');
  database
    .prepare(`
      INSERT INTO memory_items (
        id, kind, name, title, canonical_text, structured_data, scope_data, status, priority, confidence,
        explicitness, source_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      'legacy-memory',
      'fact',
      null,
      'Storage',
      'Memlume uses SQLite.',
      '{}',
      '{"level":"global"}',
      'active',
      0,
      1,
      1,
      'legacy-event',
      timestamp,
      timestamp,
    );
  return database;
}

function count(database, table) {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

describe('shared brains migration', () => {
  test('upgrades legacy events and memories into the default personal brain without duplication', () => {
    const database = createLegacyDatabase();

    applyMigrations(database);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('brains', 'agent_installations', 'brain_mounts', 'adapter_tokens', 'memory_brains', 'event_brains') ORDER BY name")
      .pluck()
      .all();
    assert.deepEqual(tables, ['adapter_tokens', 'agent_installations', 'brain_mounts', 'brains', 'event_brains', 'memory_brains']);
    assert.equal(database.prepare('SELECT kind FROM brains WHERE id = ?').pluck().get(DEFAULT_PERSONAL_BRAIN_ID), 'personal');
    assert.equal(database.prepare('SELECT brain_id FROM memory_brains WHERE memory_id = ?').pluck().get('legacy-memory'), DEFAULT_PERSONAL_BRAIN_ID);
    assert.equal(database.prepare('SELECT brain_id FROM event_brains WHERE event_id = ?').pluck().get('legacy-event'), DEFAULT_PERSONAL_BRAIN_ID);
    assert.equal(database.prepare('SELECT canonical_text FROM memory_items WHERE id = ?').pluck().get('legacy-memory'), 'Memlume uses SQLite.');

    const counts = { brains: count(database, 'brains'), memories: count(database, 'memory_brains'), events: count(database, 'event_brains') };
    database.prepare('DELETE FROM schema_migrations WHERE id = ?').run('003_shared_brains');
    applyMigrations(database);
    assert.deepEqual({ brains: count(database, 'brains'), memories: count(database, 'memory_brains'), events: count(database, 'event_brains') }, counts);
  });

  test('enforces shared-brain foreign keys, uniqueness, and access constraints without storing plaintext tokens', () => {
    const database = createLegacyDatabase();
    applyMigrations(database);
    database
      .prepare('INSERT INTO agent_installations (id, client_type, installation_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('installation-1', 'codex', 'desktop', 'default', timestamp, timestamp);
    database
      .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('project-brain', 'project', 'Memlume', timestamp, timestamp);
    database
      .prepare(`
        INSERT INTO memory_items (
          id, kind, canonical_text, structured_data, scope_data, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run('unmapped-memory', 'fact', 'Unmapped memory.', '{}', '{"level":"global"}', 'active', timestamp, timestamp);
    database
      .prepare(`
        INSERT INTO events (
          id, event_type, raw_content, source_type, source_data, occurred_at, ingested_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run('unmapped-event', 'note', 'Unmapped event.', 'test', '{}', timestamp, timestamp, 'unmapped-event-hash');

    assert.throws(
      () => database.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('invalid-brain', 'team', 'Invalid', timestamp, timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO agent_installations (id, client_type, installation_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('installation-2', 'codex', 'desktop', 'default', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('missing-brain', 'installation-1', 'read', timestamp, timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('project-brain', 'missing-installation', 'read', timestamp, timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('project-brain', 'installation-1', 'admin', timestamp, timestamp),
      /CHECK constraint failed/,
    );
    database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('project-brain', 'installation-1', 'read_write', timestamp, timestamp);
    assert.throws(
      () => database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('project-brain', 'installation-1', 'read', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)').run('missing-memory', DEFAULT_PERSONAL_BRAIN_ID, timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)').run('unmapped-memory', 'missing-brain', timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run('missing-event', DEFAULT_PERSONAL_BRAIN_ID, timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run('unmapped-event', 'missing-brain', timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('missing-token-installation', 'missing-installation', 'a'.repeat(64), timestamp),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('plain-token', 'installation-1', 'plain-token', timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('uppercase-token', 'installation-1', 'A'.repeat(64), timestamp),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('short-token', 'installation-1', 'a'.repeat(63), timestamp),
      /CHECK constraint failed/,
    );
    database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('token-1', 'installation-1', 'a'.repeat(64), timestamp);
    assert.throws(
      () => database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run('token-2', 'installation-1', 'a'.repeat(64), timestamp),
      /UNIQUE constraint failed/,
    );

    const tokenColumns = database.prepare('PRAGMA table_info(adapter_tokens)').all().map((column) => column.name);
    assert.equal(tokenColumns.includes('token_hash'), true);
    assert.equal(tokenColumns.includes('token'), false);
  });
});
