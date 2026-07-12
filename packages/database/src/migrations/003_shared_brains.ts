import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const DEFAULT_PERSONAL_BRAIN_ID = '00000000-0000-7000-8000-000000000001';

const upSql = `
  CREATE TABLE IF NOT EXISTS brains (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('personal', 'project', 'domain')),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_installations (
    id TEXT PRIMARY KEY,
    client_type TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(client_type, installation_id, profile_id)
  );

  CREATE TABLE IF NOT EXISTS brain_mounts (
    brain_id TEXT NOT NULL,
    agent_installation_id TEXT NOT NULL,
    access TEXT NOT NULL CHECK(access IN ('read', 'read_write')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(brain_id, agent_installation_id),
    FOREIGN KEY(brain_id) REFERENCES brains(id),
    FOREIGN KEY(agent_installation_id) REFERENCES agent_installations(id)
  );

  CREATE TABLE IF NOT EXISTS adapter_tokens (
    id TEXT PRIMARY KEY,
    agent_installation_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    FOREIGN KEY(agent_installation_id) REFERENCES agent_installations(id)
  );

  CREATE TABLE IF NOT EXISTS memory_brains (
    memory_id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(memory_id) REFERENCES memory_items(id),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE TABLE IF NOT EXISTS event_brains (
    event_id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(event_id) REFERENCES events(id),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  INSERT OR IGNORE INTO brains (id, kind, name, created_at, updated_at)
  VALUES (
    '${DEFAULT_PERSONAL_BRAIN_ID}',
    'personal',
    'Personal Brain',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );

  INSERT OR IGNORE INTO memory_brains (memory_id, brain_id, created_at)
  SELECT id, '${DEFAULT_PERSONAL_BRAIN_ID}', created_at
  FROM memory_items;

  INSERT OR IGNORE INTO event_brains (event_id, brain_id, created_at)
  SELECT id, '${DEFAULT_PERSONAL_BRAIN_ID}', ingested_at
  FROM events;
`;

export const sharedBrainsMigration: Migration = {
  id: '003_shared_brains',
  up(database: SqliteDatabase) {
    database.transaction(() => database.exec(upSql))();
  },
};
