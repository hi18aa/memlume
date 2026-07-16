import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS capture_sources (
    capture_id TEXT PRIMARY KEY,
    source_reference TEXT NOT NULL UNIQUE,
    actor TEXT NOT NULL CHECK(actor IN ('user', 'assistant', 'tool')),
    event_type TEXT NOT NULL,
    sanitized_content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS capture_atoms (
    capture_id TEXT NOT NULL,
    atom_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'active', 'candidate', 'event_only', 'routing_required', 'ignored', 'rejected', 'failed')),
    brain_id TEXT,
    memory_id TEXT,
    record_id TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(capture_id, atom_key),
    FOREIGN KEY(capture_id) REFERENCES capture_sources(capture_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_capture_atoms_status ON capture_atoms(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_capture_atoms_brain ON capture_atoms(brain_id, status);
  CREATE TABLE IF NOT EXISTS capture_receipts (
    capture_id TEXT PRIMARY KEY,
    source_reference TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'active', 'candidate', 'event_only', 'routing_required', 'ignored', 'rejected', 'failed')),
    receipt_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(capture_id) REFERENCES capture_sources(capture_id) ON DELETE CASCADE
  );
`;

export const captureReceiptsMigration: Migration = {
  id: '009_capture_receipts',
  up(database: SqliteDatabase) {
    database.exec(upSql);
  },
};
