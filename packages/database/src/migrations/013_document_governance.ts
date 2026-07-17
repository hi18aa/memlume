import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

/**
 * Extends project ACLs without weakening existing rows.  SQLite cannot alter
 * a CHECK constraint in place, so the two small ACL tables are rebuilt while
 * preserving their primary/foreign-key data.
 */
export const documentGovernanceMigration: Migration = {
  id: '013_document_governance',
  up(database: SqliteDatabase) {
    database.transaction(() => {
      database.pragma('foreign_keys = OFF');
      database.exec(`
        ALTER TABLE brain_mounts RENAME TO brain_mounts_legacy_013;
        CREATE TABLE brain_mounts (
          brain_id TEXT NOT NULL,
          agent_installation_id TEXT NOT NULL,
          access TEXT NOT NULL CHECK(access IN ('read', 'propose', 'read_write')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(brain_id, agent_installation_id),
          FOREIGN KEY(brain_id) REFERENCES brains(id),
          FOREIGN KEY(agent_installation_id) REFERENCES agent_installations(id)
        );
        INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at)
        SELECT brain_id, agent_installation_id, access, created_at, updated_at FROM brain_mounts_legacy_013;
        DROP TABLE brain_mounts_legacy_013;

        DROP INDEX IF EXISTS idx_workspace_projects_primary;
        ALTER TABLE workspace_projects RENAME TO workspace_projects_legacy_013;
        CREATE TABLE workspace_projects (
          workspace_key TEXT NOT NULL,
          brain_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('primary', 'linked')),
          access TEXT NOT NULL DEFAULT 'read' CHECK(access IN ('read', 'propose', 'read_write')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(workspace_key, brain_id),
          FOREIGN KEY(brain_id) REFERENCES brains(id)
        );
        INSERT INTO workspace_projects (workspace_key, brain_id, role, access, created_at, updated_at)
        SELECT workspace_key, brain_id, role, access, created_at, updated_at FROM workspace_projects_legacy_013;
        DROP TABLE workspace_projects_legacy_013;
        CREATE UNIQUE INDEX idx_workspace_projects_primary
          ON workspace_projects(workspace_key) WHERE role = 'primary';

        CREATE TABLE IF NOT EXISTS document_proposals (
          id TEXT PRIMARY KEY,
          brain_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          logical_path TEXT NOT NULL,
          base_revision_id TEXT NOT NULL,
          base_source_sha256 TEXT NOT NULL CHECK(length(base_source_sha256) = 64),
          proposed_body TEXT NOT NULL,
          reason TEXT NOT NULL,
          evidence_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'applied', 'conflict', 'apply_failed')),
          actor_id TEXT NOT NULL,
          reviewer_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          reviewed_at TEXT,
          applied_at TEXT,
          FOREIGN KEY(brain_id) REFERENCES brains(id),
          FOREIGN KEY(document_id) REFERENCES documents(id),
          FOREIGN KEY(base_revision_id) REFERENCES document_revisions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_document_proposals_brain_status
          ON document_proposals(brain_id, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_document_proposals_document
          ON document_proposals(document_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS document_audit_events (
          id TEXT PRIMARY KEY,
          brain_id TEXT NOT NULL,
          proposal_id TEXT,
          event_type TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY(brain_id) REFERENCES brains(id),
          FOREIGN KEY(proposal_id) REFERENCES document_proposals(id)
        );

        CREATE INDEX IF NOT EXISTS idx_document_audit_brain_created
          ON document_audit_events(brain_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_document_audit_proposal
          ON document_audit_events(proposal_id, created_at DESC);
      `);
      if (database.prepare("SELECT 1 FROM pragma_table_info('document_projects') WHERE name = 'state'").get() === undefined) {
        database.exec(`
          ALTER TABLE document_projects ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'
            CHECK(state IN ('ready', 'drift', 'repair_required'));
        `);
      }
      database.pragma('foreign_keys = ON');
    })();
  },
};
