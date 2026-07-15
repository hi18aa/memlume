import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { configureDatabase, applyMigrations } from '../dist/internal.js';
import { initialMigration } from '../dist/migrations/001_initial.js';
import { eventReferenceDedupMigration } from '../dist/migrations/002_event_reference_dedup.js';
import { sharedBrainsMigration } from '../dist/migrations/003_shared_brains.js';
import { memoryOutcomesMigration } from '../dist/migrations/004_memory_outcomes.js';
import { feedbackReceiptsMigration } from '../dist/migrations/005_feedback_receipts.js';
import { receiptHardeningMigration } from '../dist/migrations/006_receipt_hardening.js';

const defaultPersonalBrainId = '00000000-0000-7000-8000-000000000001';
const timestamp = '2026-07-13T12:00:00.000Z';
const databases = [];

afterEach(() => {
  while (databases.length > 0) {
    databases.pop().close();
  }
});

function createV02Database() {
  const database = new Database(':memory:');
  databases.push(database);
  configureDatabase(database);
  for (const migration of [
    initialMigration,
    eventReferenceDedupMigration,
    sharedBrainsMigration,
    memoryOutcomesMigration,
    feedbackReceiptsMigration,
    receiptHardeningMigration,
  ]) {
    migration.up(database);
  }
  database.exec(`
    CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  for (const id of [
    '001_initial',
    '002_event_reference_dedup',
    '003_shared_brains',
    '004_memory_outcomes',
    '005_feedback_receipts',
    '006_receipt_hardening',
  ]) {
    database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(id, timestamp);
  }

  database
    .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-domain', 'domain', 'Legacy Product', timestamp, timestamp);
  database
    .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-personal', 'personal', 'Imported Personal', timestamp, timestamp);
  database
    .prepare('INSERT INTO agent_installations (id, client_type, installation_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-installation', 'codex', 'legacy', 'default', timestamp, timestamp);
  database
    .prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-domain', 'legacy-installation', 'read_write', timestamp, timestamp);
  database
    .prepare(`
      INSERT INTO events (
        id, event_type, raw_content, source_type, source_data, occurred_at, ingested_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('domain-event', 'note', 'Legacy project event.', 'test', '{}', timestamp, timestamp, 'domain-event-hash');
  database
    .prepare(`
      INSERT INTO memory_items (
        id, kind, canonical_text, structured_data, scope_data, status, source_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('domain-memory', 'fact', 'Legacy project memory.', '{}', '{"level":"global"}', 'active', 'domain-event', timestamp, timestamp);
  database
    .prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)')
    .run('domain-memory', 'legacy-domain', timestamp);
  database
    .prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
    .run('domain-event', 'legacy-domain', timestamp);
  database
    .prepare(`
      INSERT INTO events (
        id, event_type, raw_content, source_type, source_data, occurred_at, ingested_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('personal-event', 'note', 'Pre-Brain event.', 'test', '{}', timestamp, timestamp, 'personal-event-hash');
  database
    .prepare(`
      INSERT INTO memory_items (
        id, kind, canonical_text, structured_data, scope_data, status, source_event_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run('personal-memory', 'fact', 'Pre-Brain memory.', '{}', '{"level":"global"}', 'active', 'personal-event', timestamp, timestamp);
  database
    .prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)')
    .run('personal-memory', defaultPersonalBrainId, timestamp);
  database
    .prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
    .run('personal-event', defaultPersonalBrainId, timestamp);
  return database;
}

describe('project model migration', () => {
  test('converts domain brains without rewriting related ids and preserves aliases', () => {
    const database = createV02Database();

    applyMigrations(database);

    assert.equal(database.prepare('SELECT kind FROM brains WHERE id = ?').pluck().get('legacy-domain'), 'project');
    assert.deepEqual(database.prepare('SELECT brain_id FROM memory_brains WHERE memory_id = ?').pluck().get('domain-memory'), 'legacy-domain');
    assert.deepEqual(database.prepare('SELECT brain_id FROM event_brains WHERE event_id = ?').pluck().get('domain-event'), 'legacy-domain');
    assert.deepEqual(database.prepare('SELECT brain_id FROM brain_mounts WHERE agent_installation_id = ?').pluck().get('legacy-installation'), 'legacy-domain');
    assert.deepEqual(
      database.prepare('SELECT alias, normalized_alias, brain_id FROM brain_aliases WHERE brain_id = ?').get('legacy-domain'),
      { alias: 'Legacy Product', normalized_alias: 'legacy product', brain_id: 'legacy-domain' },
    );
    assert.equal(database.prepare('SELECT brain_id FROM memory_brains WHERE memory_id = ?').pluck().get('personal-memory'), defaultPersonalBrainId);
    assert.equal(database.prepare('SELECT brain_id FROM event_brains WHERE event_id = ?').pluck().get('personal-event'), defaultPersonalBrainId);
    assert.equal(database.prepare("SELECT COUNT(*) FROM brains WHERE kind = 'personal'").pluck().get(), 2);
  });

  test('rejects domain brains after the migration', () => {
    const database = createV02Database();
    applyMigrations(database);

    assert.throws(
      () => database.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('new-domain', 'domain', 'No Domain', timestamp, timestamp),
      /domain Brain kind is retired/,
    );
    assert.throws(
      () => database.prepare('UPDATE brains SET kind = ? WHERE id = ?').run('domain', 'legacy-domain'),
      /domain Brain kind is retired/,
    );
  });

  test('validates project keys and workspace bindings', () => {
    const database = createV02Database();
    applyMigrations(database);

    database
      .prepare('INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('path-key', 'legacy-domain', 'canonical_path', 'C:/work/memlume', timestamp, timestamp);
    database
      .prepare('INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('remote-key', 'legacy-domain', 'git_remote', 'https://github.com/hi18aa/memlume.git', timestamp, timestamp);
    assert.throws(
      () => database
        .prepare('INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('credential-key', 'legacy-domain', 'git_remote', 'https://user:secret@github.com/hi18aa/memlume.git', timestamp, timestamp),
      /git remote must not contain credentials, query, or fragment/,
    );
    assert.throws(
      () => database
        .prepare('INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('query-key', 'legacy-domain', 'git_remote', 'https://github.com/hi18aa/memlume.git?token=1', timestamp, timestamp),
      /git remote must not contain credentials, query, or fragment/,
    );
    assert.throws(
      () => database
        .prepare('INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('duplicate-key', 'legacy-domain', 'canonical_path', 'C:/work/memlume', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );

    database
      .prepare('INSERT INTO workspace_projects (workspace_key, brain_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-a', 'legacy-domain', 'primary', timestamp, timestamp);
    database
      .prepare('INSERT INTO workspace_projects (workspace_key, brain_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('workspace-a', defaultPersonalBrainId, 'linked', timestamp, timestamp);
    assert.equal(database.prepare('SELECT access FROM workspace_projects WHERE workspace_key = ? AND brain_id = ?').pluck().get('workspace-a', defaultPersonalBrainId), 'read');
    assert.throws(
      () => database
        .prepare('INSERT INTO workspace_projects (workspace_key, brain_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('workspace-a', 'legacy-personal', 'primary', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => database
        .prepare('INSERT INTO workspace_projects (workspace_key, brain_id, role, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('workspace-a', defaultPersonalBrainId, 'linked', 'read', timestamp, timestamp),
      /UNIQUE constraint failed/,
    );
  });
});
