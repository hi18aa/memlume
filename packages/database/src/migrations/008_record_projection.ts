import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS record_projections (
    record_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    memory_id TEXT,
    brain_id TEXT,
    supersedes_record_id TEXT,
    projected_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memory_items(id),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE INDEX IF NOT EXISTS idx_record_projections_memory
    ON record_projections(memory_id);

  CREATE INDEX IF NOT EXISTS idx_record_projections_brain
    ON record_projections(brain_id);
`;

export const recordProjectionMigration: Migration = {
  id: '008_record_projection',
  up(database: SqliteDatabase) {
    database.exec(upSql);
  },
};
