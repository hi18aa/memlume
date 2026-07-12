import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

export const eventReferenceDedupMigration: Migration = {
  id: '002_event_reference_dedup',
  up(database: SqliteDatabase) {
    database.exec(`
      DROP INDEX IF EXISTS idx_events_content_hash;
      CREATE UNIQUE INDEX idx_events_content_hash
        ON events(content_hash, source_reference)
        WHERE source_reference IS NOT NULL;
    `);
  },
};
