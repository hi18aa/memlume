import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

/**
 * Outcome records were part of the original schema, but their indexes are
 * versioned separately so existing databases gain predictable feedback
 * lookup performance without rewriting append-only history.
 */
const upSql = `
  CREATE INDEX IF NOT EXISTS idx_memory_usage_memory_used_at
    ON memory_usage(memory_id, used_at DESC);

  CREATE INDEX IF NOT EXISTS idx_memory_usage_task_used_at
    ON memory_usage(task_id, used_at DESC);

  CREATE INDEX IF NOT EXISTS idx_outcomes_task_created_at
    ON outcomes(task_id, created_at DESC);
`;

export const memoryOutcomesMigration: Migration = {
  id: '004_memory_outcomes',
  up(database: SqliteDatabase) {
    database.transaction(() => database.exec(upSql))();
  },
};
