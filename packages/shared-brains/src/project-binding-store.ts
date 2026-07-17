import { createUuidV7, BrainSchema, NonEmptyTextSchema, UuidV7Schema, type Brain } from '@memlume/contracts';
import type { SqliteDatabase } from '@memlume/database/internal';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';

import { MarkdownRecordStore } from './markdown-record-store.js';

export type ProjectBindingStoreOptions = {
  /** Optional Markdown authority root used to create each project's brain.md. */
  readonly markdownRoot?: string;
};

export type ProjectBindingRole = 'primary' | 'linked';
export type ProjectBindingAccess = 'read' | 'propose' | 'read_write';
export type ProjectKeyType = 'canonical_path' | 'git_remote';

export type ProjectBinding = {
  readonly workspaceKey: string;
  readonly brainId: string;
  readonly role: ProjectBindingRole;
  readonly access: ProjectBindingAccess;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectKey = {
  readonly id: string;
  readonly brainId: string;
  readonly keyType: ProjectKeyType;
  readonly canonicalValue: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectInspection = {
  readonly brain: Brain;
  readonly aliases: readonly string[];
  readonly keys: readonly ProjectKey[];
};

export class AmbiguousProjectAliasError extends Error {
  constructor(readonly alias: string, readonly brainIds: readonly string[]) {
    super(`Project alias is ambiguous: ${alias}.`);
    this.name = 'AmbiguousProjectAliasError';
  }
}

export class ProjectBindingStore {
  private readonly markdownRoot?: string;

  constructor(private readonly database: SqliteDatabase, options: ProjectBindingStoreOptions = {}) {
    this.markdownRoot = options.markdownRoot === undefined ? undefined : absoluteRoot(options.markdownRoot);
  }

  createProject(name: string): Brain {
    const value = NonEmptyTextSchema.parse(name);
    const now = new Date().toISOString();
    const brain = BrainSchema.parse({
      id: createUuidV7(),
      kind: 'project',
      name: value,
      createdAt: now,
      updatedAt: now,
    });
    this.database.prepare(
      'INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(brain.id, brain.kind, brain.name, brain.createdAt, brain.updatedAt);
    this.ensureBrainDocument(brain);
    return brain;
  }

  addAlias(brainId: string, alias: string): { readonly brainId: string; readonly alias: string; readonly normalizedAlias: string } {
    const brain = this.projectBrain(brainId);
    const value = NonEmptyTextSchema.parse(alias);
    const normalizedAlias = normalizeAlias(value);
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO brain_aliases (id, brain_id, alias, normalized_alias, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(brain_id, normalized_alias) DO UPDATE SET alias = excluded.alias, updated_at = excluded.updated_at`,
    ).run(createUuidV7(), brain.id, value, normalizedAlias, now, now);
    return { brainId: brain.id, alias: value, normalizedAlias };
  }

  removeAlias(brainId: string, alias: string): boolean {
    const id = UuidV7Schema.parse(brainId);
    const result = this.database.prepare('DELETE FROM brain_aliases WHERE brain_id = ? AND normalized_alias = ?')
      .run(id, normalizeAlias(alias));
    return result.changes > 0;
  }

  resolveAlias(alias: string): Brain | undefined {
    const normalizedAlias = normalizeAlias(alias);
    const rows = this.database.prepare(
      `SELECT brains.id, brains.kind, brains.name, brains.created_at, brains.updated_at
       FROM brain_aliases JOIN brains ON brains.id = brain_aliases.brain_id
       WHERE brain_aliases.normalized_alias = ? ORDER BY brains.id`,
    ).all(normalizedAlias) as BrainRow[];
    if (rows.length > 1) {
      throw new AmbiguousProjectAliasError(alias, rows.map((row) => row.id));
    }
    return rows[0] === undefined ? undefined : toBrain(rows[0]);
  }

  bindWorkspace(input: {
    readonly workspacePath: string;
    readonly brainId: string;
    readonly role?: ProjectBindingRole;
    readonly access?: ProjectBindingAccess;
  }): ProjectBinding {
    const brain = this.projectBrain(input.brainId);
    const workspaceKey = canonicalWorkspacePath(input.workspacePath);
    const role = input.role ?? 'linked';
    const access = input.access ?? (role === 'primary' ? 'read_write' : 'read');
    if (role === 'primary') {
      const existing = this.database.prepare(
        `SELECT brain_id AS brainId FROM workspace_projects
         WHERE workspace_key = ? AND role = 'primary' AND brain_id <> ?`,
      ).get(workspaceKey, brain.id) as { readonly brainId: string } | undefined;
      if (existing !== undefined) {
        throw new Error(`workspace_primary_exists: ${workspaceKey}`);
      }
    }
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO workspace_projects (workspace_key, brain_id, role, access, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_key, brain_id) DO UPDATE SET
         role = excluded.role, access = excluded.access, updated_at = excluded.updated_at`,
    ).run(workspaceKey, brain.id, role, access, now, now);
    return {
      workspaceKey,
      brainId: brain.id,
      role,
      access,
      createdAt: now,
      updatedAt: now,
    };
  }

  unbindWorkspace(workspacePath: string, brainId?: string): number {
    const workspaceKey = canonicalWorkspacePath(workspacePath);
    if (brainId === undefined) {
      return this.database.prepare('DELETE FROM workspace_projects WHERE workspace_key = ?').run(workspaceKey).changes;
    }
    return this.database.prepare('DELETE FROM workspace_projects WHERE workspace_key = ? AND brain_id = ?')
      .run(workspaceKey, UuidV7Schema.parse(brainId)).changes;
  }

  listWorkspace(workspacePath: string): ProjectBinding[] {
    const workspaceKey = canonicalWorkspacePath(workspacePath);
    const rows = this.database.prepare(
      `SELECT workspace_key AS workspaceKey, brain_id AS brainId, role, access, created_at AS createdAt, updated_at AS updatedAt
       FROM workspace_projects WHERE workspace_key = ? ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, brain_id`,
    ).all(workspaceKey) as ProjectBindingRow[];
    return rows.map(toBinding);
  }

  /** Unknown workspaces deliberately return an empty set; no Brain is created. */
  resolveWorkspace(workspacePath: string): ProjectBinding[] {
    return this.listWorkspace(workspacePath);
  }

  addProjectKey(input: {
    readonly brainId: string;
    readonly keyType: ProjectKeyType;
    readonly value: string;
  }): ProjectKey {
    const brain = this.projectBrain(input.brainId);
    const canonicalValue = input.keyType === 'canonical_path'
      ? canonicalWorkspacePath(input.value)
      : canonicalGitRemote(input.value);
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO project_keys (id, brain_id, key_type, canonical_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_value) DO UPDATE SET brain_id = excluded.brain_id, key_type = excluded.key_type, updated_at = excluded.updated_at`,
    ).run(createUuidV7(), brain.id, input.keyType, canonicalValue, now, now);
    return { id: projectKeyId(this.database, canonicalValue), brainId: brain.id, keyType: input.keyType, canonicalValue, createdAt: now, updatedAt: now };
  }

  findByProjectKey(keyType: ProjectKeyType, value: string): Brain | undefined {
    const canonicalValue = keyType === 'canonical_path' ? canonicalWorkspacePath(value) : canonicalGitRemote(value);
    let row = this.database.prepare(
      `SELECT brains.id, brains.kind, brains.name, brains.created_at, brains.updated_at
       FROM project_keys JOIN brains ON brains.id = project_keys.brain_id
       WHERE project_keys.key_type = ? AND project_keys.canonical_value = ?`,
    ).get(keyType, canonicalValue) as BrainRow | undefined;
    if (row === undefined && keyType === 'git_remote') {
      const identity = remoteIdentity(canonicalValue);
      const candidates = this.database.prepare(
        `SELECT project_keys.canonical_value AS canonicalValue,
                brains.id, brains.kind, brains.name, brains.created_at, brains.updated_at
         FROM project_keys JOIN brains ON brains.id = project_keys.brain_id
         WHERE project_keys.key_type = 'git_remote'`,
      ).all() as Array<BrainRow & { canonicalValue: string }>;
      row = candidates.find((candidate) => remoteIdentity(candidate.canonicalValue) === identity);
    }
    return row === undefined ? undefined : toBrain(row);
  }

  listKeys(brainId?: string): ProjectKey[] {
    const rows = brainId === undefined
      ? this.database.prepare('SELECT id, brain_id AS brainId, key_type AS keyType, canonical_value AS canonicalValue, created_at AS createdAt, updated_at AS updatedAt FROM project_keys ORDER BY canonical_value').all()
      : this.database.prepare('SELECT id, brain_id AS brainId, key_type AS keyType, canonical_value AS canonicalValue, created_at AS createdAt, updated_at AS updatedAt FROM project_keys WHERE brain_id = ? ORDER BY canonical_value').all(UuidV7Schema.parse(brainId));
    return (rows as ProjectKeyRow[]).map(toProjectKey);
  }

  inspect(brainId?: string): ProjectInspection[] {
    const brains = brainId === undefined
      ? (this.database.prepare(`SELECT id, kind, name, created_at, updated_at FROM brains WHERE kind = 'project' ORDER BY created_at, id`).all() as BrainRow[]).map(toBrain)
      : [this.projectBrain(brainId)];
    return brains.map((brain) => {
      const aliases = this.database.prepare('SELECT alias FROM brain_aliases WHERE brain_id = ? ORDER BY normalized_alias').pluck().all(brain.id) as string[];
      return { brain, aliases, keys: this.listKeys(brain.id) };
    });
  }

  private projectBrain(brainId: string): Brain {
    const id = UuidV7Schema.parse(brainId);
    const row = this.database.prepare('SELECT id, kind, name, created_at, updated_at FROM brains WHERE id = ?').get(id) as BrainRow | undefined;
    if (row === undefined) throw new Error(`Unknown Brain: ${id}.`);
    const brain = toBrain(row);
    if (brain.kind !== 'project') throw new Error(`Brain ${id} is not a project Brain.`);
    return brain;
  }

  private ensureBrainDocument(brain: Brain): void {
    if (this.markdownRoot === undefined) return;
    new MarkdownRecordStore({ rootDir: this.markdownRoot }).ensureBrainDocument(brain.id, { name: brain.name });
  }
}

export function normalizeAlias(value: string): string {
  return NonEmptyTextSchema.parse(value).trim().toLocaleLowerCase('en-US');
}

export function canonicalWorkspacePath(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('workspace path is required.');
  const input = value.trim();
  const absolute = resolve(input);
  let canonical = absolute;
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute);
    canonical = stat.isSymbolicLink() ? realpathSync.native(absolute) : absolute;
  }
  canonical = normalize(canonical);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export function canonicalGitRemote(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('git remote is required.');
  let input = value.trim();
  const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(input);
  if (scp !== null && !input.includes('://')) input = `ssh://${scp[1]}/${scp[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('git remote must be an HTTPS or SSH URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') {
    throw new Error('git remote must be an HTTPS or SSH URL.');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `/${parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return parsed.toString().replace(/\/$/, '');
}

function remoteIdentity(value: string): string {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
}

type BrainRow = { id: string; kind: string; name: string; created_at: string; updated_at: string };
type ProjectBindingRow = { workspaceKey: string; brainId: string; role: string; access: string; createdAt: string; updatedAt: string };
type ProjectKeyRow = { id: string; brainId: string; keyType: string; canonicalValue: string; createdAt: string; updatedAt: string };

function toBrain(row: BrainRow): Brain {
  return BrainSchema.parse({ id: row.id, kind: row.kind, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at });
}

function toBinding(row: ProjectBindingRow): ProjectBinding {
  if ((row.role !== 'primary' && row.role !== 'linked') || (row.access !== 'read' && row.access !== 'propose' && row.access !== 'read_write')) throw new Error('Invalid project binding row.');
  return { workspaceKey: row.workspaceKey, brainId: UuidV7Schema.parse(row.brainId), role: row.role, access: row.access, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function toProjectKey(row: ProjectKeyRow): ProjectKey {
  if (row.keyType !== 'canonical_path' && row.keyType !== 'git_remote') throw new Error('Invalid project key row.');
  return { id: UuidV7Schema.parse(row.id), brainId: UuidV7Schema.parse(row.brainId), keyType: row.keyType, canonicalValue: row.canonicalValue, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

function absoluteRoot(value: string): string {
  if (!isAbsolute(value)) throw new Error('markdownRoot must be absolute.');
  return resolve(value);
}

function projectKeyId(database: SqliteDatabase, canonicalValue: string): string {
  const row = database.prepare('SELECT id FROM project_keys WHERE canonical_value = ?').get(canonicalValue) as { id: string } | undefined;
  if (row === undefined) throw new Error('Project key was not persisted.');
  return row.id;
}
