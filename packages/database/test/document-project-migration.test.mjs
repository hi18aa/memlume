import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import Database from 'better-sqlite3';

import { applyMigrations, configureDatabase } from '../dist/internal.js';

describe('document project migration', () => {
  test('creates the source/version/section projection and profile binding tables idempotently', () => {
    const database = new Database(':memory:');
    try {
      configureDatabase(database);
      applyMigrations(database);
      applyMigrations(database);
      for (const table of ['document_projects', 'document_revisions', 'documents', 'document_versions', 'document_sections', 'profile_document_bindings']) {
        assert.deepEqual(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), { 1: 1 });
      }
      assert.deepEqual(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'document_section_search'").get(), { 1: 1 });
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?').pluck().get('012_document_projects'), 1);
    } finally {
      database.close();
    }
  });
});
