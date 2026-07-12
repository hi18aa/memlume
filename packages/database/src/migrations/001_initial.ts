import type { SqliteDatabase } from '../database.js';

export interface Migration {
  readonly id: string;
  up(database: SqliteDatabase): void;
  down?(database: SqliteDatabase): void;
}

const upSql = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    raw_content TEXT NOT NULL,
    structured_data TEXT,
    source_type TEXT NOT NULL,
    source_agent TEXT,
    source_reference TEXT,
    source_data TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    content_hash TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_content_hash
    ON events(content_hash, source_reference)
    WHERE source_reference IS NOT NULL;

  CREATE TRIGGER IF NOT EXISTS events_reject_update
    BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;

  CREATE TRIGGER IF NOT EXISTS events_reject_delete
    BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;

  CREATE TABLE IF NOT EXISTS memory_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT,
    title TEXT,
    canonical_text TEXT NOT NULL,
    structured_data TEXT NOT NULL,
    scope_data TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 1.0,
    explicitness REAL NOT NULL DEFAULT 1.0,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    valid_from TEXT,
    valid_until TEXT,
    last_used_at TEXT,
    superseded_by TEXT,
    FOREIGN KEY(source_event_id) REFERENCES events(id),
    FOREIGN KEY(superseded_by) REFERENCES memory_items(id)
  );

  CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    canonical_text TEXT NOT NULL,
    structured_data TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    change_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memory_items(id),
    UNIQUE(memory_id, version)
  );

  CREATE TABLE IF NOT EXISTS memory_relations (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 1.0,
    source_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(source_id, target_id, relation_type),
    FOREIGN KEY(source_id) REFERENCES memory_items(id),
    FOREIGN KEY(target_id) REFERENCES memory_items(id)
  );

  CREATE TABLE IF NOT EXISTS memory_usage (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    retrieval_rank INTEGER,
    was_included INTEGER NOT NULL,
    outcome TEXT,
    used_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memory_items(id)
  );

  CREATE TABLE IF NOT EXISTS outcomes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    result TEXT NOT NULL,
    correction_type TEXT,
    correction_data TEXT,
    used_memory_ids TEXT NOT NULL,
    used_tool_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    conflict_type TEXT NOT NULL,
    memory_ids TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    status TEXT NOT NULL,
    resolution_strategy TEXT,
    resolution_data TEXT,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tool_registry (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    intents TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    availability TEXT NOT NULL,
    adapter_type TEXT NOT NULL,
    status TEXT NOT NULL,
    metadata TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(
    memory_id UNINDEXED,
    title,
    canonical_text,
    summary,
    keywords,
    entities,
    content,
    tokenize = 'unicode61'
  );
`;

const downSql = `
  DROP TRIGGER IF EXISTS events_reject_update;
  DROP TRIGGER IF EXISTS events_reject_delete;
  DROP TABLE IF EXISTS memory_search;
  DROP TABLE IF EXISTS memory_usage;
  DROP TABLE IF EXISTS memory_relations;
  DROP TABLE IF EXISTS memory_versions;
  DROP TABLE IF EXISTS outcomes;
  DROP TABLE IF EXISTS conflicts;
  DROP TABLE IF EXISTS tool_registry;
  DROP TABLE IF EXISTS memory_items;
  DROP TABLE IF EXISTS events;
`;

export const initialMigration: Migration = {
  id: '001_initial',
  up(database) {
    database.transaction(() => database.exec(upSql))();
  },
  down(database) {
    database.transaction(() => database.exec(downSql))();
  },
};
