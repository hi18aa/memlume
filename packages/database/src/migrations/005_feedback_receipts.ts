import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS context_receipts (
    trace_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    brain_ids TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_context_receipts_agent_expires
    ON context_receipts(agent_id, expires_at DESC);

  CREATE INDEX IF NOT EXISTS idx_memory_usage_trace_id
    ON memory_usage(trace_id, used_at DESC);
`;

export const feedbackReceiptsMigration: Migration = {
  id: '005_feedback_receipts',
  up(database: SqliteDatabase) {
    database.transaction(() => {
      const columns = database.prepare('PRAGMA table_info(memory_usage)').all() as Array<{ readonly name: string }>;
      if (!columns.some(({ name }) => name === 'trace_id')) {
        database.exec('ALTER TABLE memory_usage ADD COLUMN trace_id TEXT');
      }
      database.exec(upSql);
    })();
  },
};
