import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openDatabase } from '../dist/internal.js';

test('document governance migration adds proposal state and propose ACL without changing existing grants', () => {
  const database = openDatabase(':memory:');
  try {
    assert.equal(database.prepare("SELECT 1 FROM schema_migrations WHERE id = '013_document_governance'").get()?.['1'], 1);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_proposals'").get()?.name, 'document_proposals');
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_audit_events'").get()?.name, 'document_audit_events');
    assert.deepEqual(database.prepare("SELECT dflt_value FROM pragma_table_info('document_projects') WHERE name = 'state'").pluck().get(), "'ready'");
    const mountSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'brain_mounts'").pluck().get();
    const bindingSql = database.prepare("SELECT sql FROM sqlite_master WHERE name = 'workspace_projects'").pluck().get();
    assert.match(mountSql, /'propose'/u);
    assert.match(bindingSql, /'propose'/u);
  } finally {
    database.close();
  }
});
