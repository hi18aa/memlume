import Database from 'better-sqlite3';

import { applyMigrations, type MigrationPreflightContext } from './migration-runner.js';

export type SqliteDatabase = Database.Database;

export type DatabaseAuthority = 'sqlite' | 'markdown';
export type MigrationStatus = 'ready' | 'preflight' | 'failed';
export type DatabaseState = {
  readonly authority: DatabaseAuthority;
  readonly migration: MigrationStatus;
  readonly updatedAt: string;
};

export type OpenDatabaseOptions = {
  readonly migrationPreflight?: (context: MigrationPreflightContext) => void;
};

export function configureDatabase(database: SqliteDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
}

export function openDatabase(filename: string, options: OpenDatabaseOptions = {}): SqliteDatabase {
  const database = new Database(filename);

  try {
    configureDatabase(database);
    ensureStateTable(database);
    setMigrationStatus(database, 'preflight');
    applyMigrations(database, { preflight: options.migrationPreflight });
    setMigrationStatus(database, 'ready');
    return database;
  } catch (error) {
    try {
      ensureStateTable(database);
      setMigrationStatus(database, 'failed');
    } catch {
      // Preserve the migration error when the database itself is unavailable.
    }
    database.close();
    throw error;
  }
}

export function readDatabaseState(database: SqliteDatabase): DatabaseState {
  ensureStateTable(database);
  const row = database.prepare('SELECT authority, migration, updated_at FROM memlume_state WHERE id = 1').get() as {
    authority: DatabaseAuthority;
    migration: MigrationStatus;
    updated_at: string;
  };
  return { authority: row.authority, migration: row.migration, updatedAt: row.updated_at };
}

export function setDatabaseAuthority(database: SqliteDatabase, authority: DatabaseAuthority): DatabaseState {
  ensureStateTable(database);
  database.prepare('UPDATE memlume_state SET authority = ?, updated_at = ? WHERE id = 1').run(authority, new Date().toISOString());
  return readDatabaseState(database);
}

export function ensureStateTable(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memlume_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      authority TEXT NOT NULL CHECK (authority IN ('sqlite', 'markdown')),
      migration TEXT NOT NULL CHECK (migration IN ('ready', 'preflight', 'failed')),
      updated_at TEXT NOT NULL
    );
  `);
  database.prepare(`
    INSERT OR IGNORE INTO memlume_state (id, authority, migration, updated_at)
    VALUES (1, 'sqlite', 'ready', ?)
  `).run(new Date().toISOString());
}

function setMigrationStatus(database: SqliteDatabase, status: MigrationStatus): void {
  database.prepare('UPDATE memlume_state SET migration = ?, updated_at = ? WHERE id = 1').run(status, new Date().toISOString());
}
