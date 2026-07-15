import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS brain_aliases (
    id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(brain_id, normalized_alias),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE INDEX IF NOT EXISTS idx_brain_aliases_normalized
    ON brain_aliases(normalized_alias);

  CREATE TABLE IF NOT EXISTS project_keys (
    id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    key_type TEXT NOT NULL CHECK(key_type IN ('canonical_path', 'git_remote')),
    canonical_value TEXT NOT NULL CHECK(length(trim(canonical_value)) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(canonical_value),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE TABLE IF NOT EXISTS workspace_projects (
    workspace_key TEXT NOT NULL,
    brain_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('primary', 'linked')),
    access TEXT NOT NULL DEFAULT 'read' CHECK(access IN ('read', 'read_write')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(workspace_key, brain_id),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_projects_primary
    ON workspace_projects(workspace_key)
    WHERE role = 'primary';

  CREATE TRIGGER IF NOT EXISTS brains_reject_domain_insert
    BEFORE INSERT ON brains
    WHEN NEW.kind = 'domain'
  BEGIN
    SELECT RAISE(ABORT, 'domain Brain kind is retired; use project');
  END;

  CREATE TRIGGER IF NOT EXISTS brains_reject_domain_update
    BEFORE UPDATE OF kind ON brains
    WHEN NEW.kind = 'domain'
  BEGIN
    SELECT RAISE(ABORT, 'domain Brain kind is retired; use project');
  END;

  CREATE TRIGGER IF NOT EXISTS project_keys_reject_unsafe_git_remote_insert
    BEFORE INSERT ON project_keys
    WHEN NEW.key_type = 'git_remote'
      AND (
        instr(NEW.canonical_value, '?') > 0
        OR instr(NEW.canonical_value, '#') > 0
        OR (
          instr(NEW.canonical_value, '://') > 0
          AND instr(substr(NEW.canonical_value, instr(NEW.canonical_value, '://') + 3), '@') > 0
        )
      )
  BEGIN
    SELECT RAISE(ABORT, 'git remote must not contain credentials, query, or fragment');
  END;

  CREATE TRIGGER IF NOT EXISTS project_keys_reject_unsafe_git_remote_update
    BEFORE UPDATE OF key_type, canonical_value ON project_keys
    WHEN NEW.key_type = 'git_remote'
      AND (
        instr(NEW.canonical_value, '?') > 0
        OR instr(NEW.canonical_value, '#') > 0
        OR (
          instr(NEW.canonical_value, '://') > 0
          AND instr(substr(NEW.canonical_value, instr(NEW.canonical_value, '://') + 3), '@') > 0
        )
      )
  BEGIN
    SELECT RAISE(ABORT, 'git remote must not contain credentials, query, or fragment');
  END;
`;

export const projectModelMigration: Migration = {
  id: '007_project_model',
  up(database: SqliteDatabase) {
    database.exec(upSql);

    // Keep the pre-migration name before changing the Brain kind. Alias rows
    // are intentionally additive so multiple legacy Personal Brains remain
    // distinct and no routing decision is inferred during migration.
    database.exec(`
      INSERT OR IGNORE INTO brain_aliases (id, brain_id, alias, normalized_alias, created_at, updated_at)
      SELECT id || ':legacy-domain-name', id, name, lower(trim(name)), created_at, updated_at
      FROM brains
      WHERE kind = 'domain';

      UPDATE brains
      SET kind = 'project'
      WHERE kind = 'domain';
    `);
  },
};
