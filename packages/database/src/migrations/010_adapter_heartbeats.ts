import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS adapter_heartbeats (
    agent_installation_id TEXT NOT NULL,
    callback TEXT NOT NULL CHECK(callback IN ('beforeTask', 'onUserMessage', 'onSubagentStart')),
    protocol_version TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(agent_installation_id, callback, protocol_version, adapter_version),
    FOREIGN KEY(agent_installation_id) REFERENCES agent_installations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_adapter_heartbeats_installation
    ON adapter_heartbeats(agent_installation_id, last_seen_at DESC);
`;

export const adapterHeartbeatsMigration: Migration = {
  id: '010_adapter_heartbeats',
  up(database: SqliteDatabase) {
    database.exec(upSql);
  },
};
