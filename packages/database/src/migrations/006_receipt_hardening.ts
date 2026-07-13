import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE INDEX IF NOT EXISTS idx_memory_usage_trace_memory_outcome
    ON memory_usage(trace_id, memory_id, outcome);

  CREATE TABLE IF NOT EXISTS user_confirmations (
    signature TEXT PRIMARY KEY,
    consumed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_user_confirmations_expires_at
    ON user_confirmations(expires_at);

  CREATE TABLE IF NOT EXISTS feedback_signal_claims (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    signal_kind TEXT NOT NULL,
    signal_value TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_feedback_signal_claims_agent_memory_at
    ON feedback_signal_claims(agent_id, memory_id, recorded_at DESC);
`;

export const receiptHardeningMigration: Migration = {
  id: '006_receipt_hardening',
  up(database: SqliteDatabase) {
    database.transaction(() => {
      const columns = database.prepare('PRAGMA table_info(context_receipts)').all() as Array<{ readonly name: string }>;
      if (!columns.some(({ name }) => name === 'source_memory_ids')) {
        database.exec("ALTER TABLE context_receipts ADD COLUMN source_memory_ids TEXT NOT NULL DEFAULT '[]'");
      }
      database.exec(upSql);
    })();
  },
};
