import Database from 'better-sqlite3';

import { initialMigration } from './migrations/001_initial.js';

export type SqliteDatabase = Database.Database;

export function configureDatabase(database: SqliteDatabase): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
}

export function openDatabase(filename: string): SqliteDatabase {
  const database = new Database(filename);

  try {
    configureDatabase(database);
    initialMigration.up(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
