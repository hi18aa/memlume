import type { SqliteDatabase } from './database.js';
import type { Migration } from './migrations/001_initial.js';
import { migrations } from './migrations/index.js';

export type MigrationPreflightContext = {
  readonly database: SqliteDatabase;
  readonly pending: readonly Migration[];
};

export type MigrationRunnerOptions = {
  /** Run once before any pending migration. Throwing leaves the schema untouched. */
  readonly preflight?: (context: MigrationPreflightContext) => void;
  /** Alias retained for callers that name the hook after the migration phase. */
  readonly beforeMigration?: (context: MigrationPreflightContext) => void;
};

const createLedgerSql = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`;

export function applyMigrations(database: SqliteDatabase, options: MigrationRunnerOptions = {}): void {
  database.exec(createLedgerSql);
  const hasMigration = database.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const recordMigration = database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  const pending = migrations.filter((migration) => hasMigration.get(migration.id) === undefined);
  if (pending.length > 0) {
    (options.preflight ?? options.beforeMigration)?.({ database, pending });
  }

  for (const migration of pending) {
    database.transaction(() => {
      migration.up(database);
      recordMigration.run(migration.id, new Date().toISOString());
    })();
  }
}
