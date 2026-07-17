import type { SqliteDatabase } from '../database.js';

import type { Migration } from './001_initial.js';

const upSql = `
  CREATE TABLE IF NOT EXISTS document_projects (
    brain_id TEXT PRIMARY KEY,
    source_root TEXT NOT NULL,
    authority_mode TEXT NOT NULL DEFAULT 'markdown' CHECK(authority_mode = 'markdown'),
    active_revision_id TEXT,
    capture_mode TEXT NOT NULL DEFAULT 'manual_only' CHECK(capture_mode = 'manual_only'),
    retrieval_policy TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(brain_id) REFERENCES brains(id),
    FOREIGN KEY(active_revision_id) REFERENCES document_revisions(id)
  );

  CREATE TABLE IF NOT EXISTS document_revisions (
    id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256) = 64),
    status TEXT NOT NULL CHECK(status IN ('staged', 'active', 'superseded')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE INDEX IF NOT EXISTS idx_document_revisions_brain
    ON document_revisions(brain_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL,
    logical_path TEXT NOT NULL CHECK(length(trim(logical_path)) > 0),
    document_type TEXT NOT NULL DEFAULT 'markdown',
    active_version_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'missing')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(brain_id, logical_path),
    FOREIGN KEY(brain_id) REFERENCES brains(id),
    FOREIGN KEY(active_version_id) REFERENCES document_versions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_documents_brain_status
    ON documents(brain_id, status, logical_path);

  CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
    source_path TEXT NOT NULL,
    markdown_body TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    heading_index_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'missing')),
    created_at TEXT NOT NULL,
    UNIQUE(document_id, source_sha256),
    FOREIGN KEY(document_id) REFERENCES documents(id),
    FOREIGN KEY(revision_id) REFERENCES document_revisions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_document_versions_document
    ON document_versions(document_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS document_sections (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    heading_path_json TEXT NOT NULL,
    text TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    estimated_text_units INTEGER NOT NULL CHECK(estimated_text_units > 0),
    FOREIGN KEY(document_id) REFERENCES documents(id),
    FOREIGN KEY(version_id) REFERENCES document_versions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_document_sections_version
    ON document_sections(version_id, priority DESC, id);

  CREATE VIRTUAL TABLE IF NOT EXISTS document_section_search USING fts5(
    section_id UNINDEXED,
    brain_id UNINDEXED,
    document_id UNINDEXED,
    version_id UNINDEXED,
    logical_path UNINDEXED,
    heading_path,
    text,
    tokenize = 'unicode61'
  );

  CREATE TABLE IF NOT EXISTS profile_document_bindings (
    agent_installation_id TEXT NOT NULL,
    brain_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('always_core', 'task_conditional', 'explicit_only')),
    default_document_paths TEXT NOT NULL DEFAULT '[]',
    max_context_budget INTEGER NOT NULL DEFAULT 320 CHECK(max_context_budget >= 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(agent_installation_id, brain_id),
    FOREIGN KEY(agent_installation_id) REFERENCES agent_installations(id),
    FOREIGN KEY(brain_id) REFERENCES brains(id)
  );

  CREATE INDEX IF NOT EXISTS idx_profile_document_bindings_installation
    ON profile_document_bindings(agent_installation_id, brain_id);
`;

export const documentProjectsMigration: Migration = {
  id: '012_document_projects',
  up(database: SqliteDatabase) {
    database.exec(upSql);
  },
};
