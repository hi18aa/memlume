import type { SqliteDatabase } from './database.js';
import { migrations } from './migrations/index.js';

const createLedgerSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

export function applyMigrations(database: SqliteDatabase): void {
  database.exec(createLedgerSql);
  const hasMigration = database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const recordMigration = database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const migration of migrations) {
    if (hasMigration.get(migration.id)) {
      continue;
    }

    database.transaction(() => {
      migration.up(database);
      recordMigration.run(migration.id, new Date().toISOString());
    })();
  }
}
