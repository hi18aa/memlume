import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';
import { strToU8, zipSync } from 'fflate';

import type { SqliteDatabase } from '@memlume/database/internal';

const ENCRYPTED_PREFIX = Buffer.from('MEMLUME-ENCRYPTED-1\n', 'utf8');

export type BackupMappings = {
  readonly brains: readonly { readonly id: string; readonly kind: string; readonly name: string }[];
  readonly installations: readonly {
    readonly id: string;
    readonly clientType: string;
    readonly installationId: string;
    readonly profileId: string;
    readonly displayName: string | null;
  }[];
  readonly mounts: readonly { readonly brainId: string; readonly agentInstallationId: string; readonly access: string }[];
};

export type BackupManifest = {
  readonly format: 'memlume';
  readonly formatVersion: 2;
  readonly scope: 'full' | 'brain';
  readonly createdAt: string;
  readonly brainIds: readonly string[];
  readonly schema: { readonly migrations: readonly string[] };
  readonly mappings: BackupMappings;
  readonly checksums: { readonly 'snapshot.sqlite': string };
  readonly encryption?: { readonly algorithm: 'aes-256-gcm'; readonly kdf: 'scrypt' };
};

export type CreateBackupOptions = {
  readonly database: SqliteDatabase;
  readonly outputPath: string;
  readonly brainId?: string;
  readonly password?: string;
};

export class FullBackupAuthenticationRequiredError extends Error {
  constructor() {
    super('Full backups require a password for authenticated restore.');
    this.name = 'FullBackupAuthenticationRequiredError';
  }
}

type EncryptionHeader = {
  readonly algorithm: 'aes-256-gcm';
  readonly kdf: 'scrypt';
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
};

export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  if (options.brainId === undefined && options.password === undefined) {
    throw new FullBackupAuthenticationRequiredError();
  }
  const directory = mkdtempSync(join(tmpdir(), 'memlume-backup-snapshot-'));
  const snapshotPath = join(directory, 'snapshot.sqlite');

  try {
    await options.database.backup(snapshotPath);
    const snapshotDatabase = new Database(snapshotPath);
    try {
      sanitizeSnapshot(snapshotDatabase, options.brainId);
      const snapshot = snapshotDatabase.serialize();
      const manifest = createManifest(snapshotDatabase, snapshot, options.brainId, options.password !== undefined);
      const bundle = zipSync({
        'manifest.json': strToU8(JSON.stringify(manifest)),
        'snapshot.sqlite': new Uint8Array(snapshot),
      });
      writeBundle(options.outputPath, options.password === undefined ? bundle : encryptBundle(bundle, options.password));
      return manifest;
    } finally {
      snapshotDatabase.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function sanitizeSnapshot(database: Database.Database, brainId: string | undefined): void {
  database.pragma('foreign_keys = OFF');

  if (brainId !== undefined) {
    const selected = database.prepare('SELECT 1 FROM brains WHERE id = ?').get(brainId);
    if (selected === undefined) {
      throw new Error('The requested brain does not exist.');
    }

    const eventTriggers = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('events_reject_update', 'events_reject_delete') ORDER BY name").pluck().all() as string[];
    database.exec('DROP TRIGGER IF EXISTS events_reject_update; DROP TRIGGER IF EXISTS events_reject_delete;');
    try {
      database.transaction(() => {
        // Document Markdown is a Brain-scoped authority.  A selected-Brain
        // snapshot must not retain proposals, audit events, or projections
        // belonging to another Brain. Legacy snapshots may predate documents.
        if (hasTable(database, 'document_projects')) {
          database.prepare('DELETE FROM document_section_search WHERE brain_id <> ?').run(brainId);
          database.prepare('DELETE FROM document_audit_events WHERE brain_id <> ?').run(brainId);
          database.prepare('DELETE FROM document_proposals WHERE brain_id <> ?').run(brainId);
          database.prepare('DELETE FROM document_sections WHERE document_id NOT IN (SELECT id FROM documents WHERE brain_id = ?)').run(brainId);
          database.prepare('DELETE FROM document_versions WHERE document_id NOT IN (SELECT id FROM documents WHERE brain_id = ?)').run(brainId);
          database.prepare('DELETE FROM documents WHERE brain_id <> ?').run(brainId);
          database.prepare('DELETE FROM document_revisions WHERE brain_id <> ?').run(brainId);
          database.prepare('DELETE FROM document_projects WHERE brain_id <> ?').run(brainId);
          database.exec('DELETE FROM profile_document_bindings;');
        }
        database.prepare('DELETE FROM memory_search WHERE memory_id NOT IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').run(brainId);
        database.prepare('DELETE FROM memory_usage WHERE memory_id NOT IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').run(brainId);
        database.prepare('DELETE FROM memory_relations WHERE source_id NOT IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?) OR target_id NOT IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').run(brainId, brainId);
        database.prepare('DELETE FROM memory_versions WHERE memory_id NOT IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').run(brainId);
        database.prepare('DELETE FROM memory_brains WHERE brain_id <> ?').run(brainId);
        database.prepare('DELETE FROM memory_items WHERE id NOT IN (SELECT memory_id FROM memory_brains)').run();
        database.prepare('DELETE FROM event_brains WHERE brain_id <> ?').run(brainId);
        database.prepare('DELETE FROM events WHERE id NOT IN (SELECT event_id FROM event_brains) AND id NOT IN (SELECT source_event_id FROM memory_items WHERE source_event_id IS NOT NULL)').run();
        database.exec('DELETE FROM brain_mounts;');
        database.prepare('DELETE FROM adapter_tokens').run();
        database.exec('DELETE FROM agent_installations;');
        database.prepare('DELETE FROM brains WHERE id <> ?').run(brainId);
        database.exec('DELETE FROM outcomes; DELETE FROM conflicts; DELETE FROM tool_registry;');
      })();
    } finally {
      database.exec(eventTriggers.join(';'));
    }
  } else {
    database.prepare('DELETE FROM adapter_tokens').run();
  }

  if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
    throw new Error('Backup snapshot has invalid foreign keys.');
  }
  database.exec('VACUUM');
  database.pragma('foreign_keys = ON');
}

function createManifest(database: Database.Database, snapshot: Uint8Array, selectedBrainId: string | undefined, encrypted: boolean): BackupManifest {
  const mappings = readMappings(database);
  const brainIds = selectedBrainId === undefined ? mappings.brains.map(({ id }) => id) : [selectedBrainId];
  const migrations = database.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all() as string[];
  return {
    format: 'memlume',
    formatVersion: 2,
    scope: selectedBrainId === undefined ? 'full' : 'brain',
    createdAt: new Date().toISOString(),
    brainIds,
    schema: { migrations },
    mappings,
    checksums: { 'snapshot.sqlite': sha256(snapshot) },
    ...(encrypted ? { encryption: { algorithm: 'aes-256-gcm' as const, kdf: 'scrypt' as const } } : {}),
  };
}

function hasTable(database: Database.Database, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(name) !== undefined;
}

export function readMappings(database: Database.Database): BackupMappings {
  return {
    brains: database.prepare('SELECT id, kind, name FROM brains ORDER BY id').all().map((row) => {
      const value = row as { id: string; kind: string; name: string };
      return { id: value.id, kind: value.kind, name: value.name };
    }),
    installations: database.prepare('SELECT id, client_type, installation_id, profile_id, display_name FROM agent_installations ORDER BY id').all().map((row) => {
      const value = row as { id: string; client_type: string; installation_id: string; profile_id: string; display_name: string | null };
      return { id: value.id, clientType: value.client_type, installationId: value.installation_id, profileId: value.profile_id, displayName: value.display_name };
    }),
    mounts: database.prepare('SELECT brain_id, agent_installation_id, access FROM brain_mounts ORDER BY brain_id, agent_installation_id').all().map((row) => {
      const value = row as { brain_id: string; agent_installation_id: string; access: string };
      return { brainId: value.brain_id, agentInstallationId: value.agent_installation_id, access: value.access };
    }),
  };
}

function writeBundle(outputPath: string, bundle: Uint8Array): void {
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, bundle);
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function encryptBundle(bundle: Uint8Array, password: string): Uint8Array {
  if (password.length === 0) {
    throw new Error('Backup password must not be empty.');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bundle), cipher.final()]);
  const header: EncryptionHeader = {
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
  return Buffer.concat([ENCRYPTED_PREFIX, Buffer.from(JSON.stringify(header), 'utf8'), Buffer.from('\n', 'utf8'), ciphertext]);
}

export function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function encryptedPrefix(): Buffer {
  return ENCRYPTED_PREFIX;
}

export type { EncryptionHeader };
