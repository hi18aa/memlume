import { createDecipheriv, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { strFromU8, unzipSync } from 'fflate';

import { DEFAULT_PERSONAL_BRAIN_ID } from '@memlume/contracts';
import { configureDatabase, ensureStateTable, migrations } from '@memlume/database/internal';
import { encryptedPrefix, FullBackupAuthenticationRequiredError, readMappings, sha256, type BackupManifest, type BackupMappings, type EncryptionHeader } from './create-backup.js';

const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
const backupEntryNames = new Set(['manifest.json', 'snapshot.sqlite']);
const expectedSchemas = new Map<string, readonly SchemaObject[]>();

export type VerifyBackupOptions = {
  readonly backupPath: string;
  readonly password?: string;
};

export type VerifiedBackup = {
  readonly manifest: BackupManifest;
  readonly snapshot: Uint8Array;
  readonly authenticated: boolean;
};

export async function verifyBackup(options: VerifyBackupOptions): Promise<BackupManifest> {
  return (await readVerifiedBackup(options)).manifest;
}

export async function readVerifiedBackup(options: VerifyBackupOptions): Promise<VerifiedBackup> {
  const metadata = await stat(options.backupPath);
  if (!metadata.isFile() || metadata.size > MAX_BACKUP_BYTES) {
    throw new Error('Backup compressed size exceeds the safety limit.');
  }
  const bundle = await readFile(options.backupPath);
  const decrypted = decryptBundle(bundle, options.password);
  let uncompressedBytes = 0;
  const files = unzipSync(decrypted.bundle, {
    filter(file) {
      if (!backupEntryNames.has(file.name)) {
        throw new Error('Unexpected backup entry.');
      }
      uncompressedBytes += file.originalSize;
      if (!Number.isSafeInteger(file.originalSize) || !Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_BACKUP_BYTES) {
        throw new Error('Backup uncompressed size exceeds the safety limit.');
      }
      return true;
    },
  });
  if (Object.keys(files).length !== 2 || files['manifest.json'] === undefined || files['snapshot.sqlite'] === undefined) {
    throw new Error('Invalid Memlume backup bundle.');
  }

  const manifest = parseManifest(strFromU8(files['manifest.json']));
  if ((manifest.encryption !== undefined) !== decrypted.authenticated) {
    throw new Error('Backup encryption metadata verification failed.');
  }
  const snapshot = files['snapshot.sqlite'];
  if (manifest.checksums['snapshot.sqlite'] !== sha256(snapshot)) {
    throw new Error('Backup checksum verification failed.');
  }
  inspectSnapshot(snapshot, manifest, decrypted.authenticated);
  return { manifest, snapshot, authenticated: decrypted.authenticated };
}

export function inspectSnapshot(snapshot: Uint8Array, manifest: BackupManifest, authenticated = manifest.encryption !== undefined): void {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-backup-verify-'));
  const snapshotPath = join(directory, 'snapshot.sqlite');
  try {
    writeFileSync(snapshotPath, snapshot);
    inspectSnapshotPath(snapshotPath, manifest, authenticated);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function inspectSnapshotPath(snapshotPath: string, manifest: BackupManifest, authenticated = manifest.encryption !== undefined): void {
  const database = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const migrationsInSnapshot = database.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all() as string[];
    migrationPrefixLength(migrationsInSnapshot);
    if (JSON.stringify(migrationsInSnapshot) !== JSON.stringify(manifest.schema.migrations)) {
      throw new Error('Backup schema verification failed.');
    }
    const snapshotSchema = readSchema(database);
    const hasStateTable = snapshotSchema.some(({ type, name }) => type === 'table' && name === 'memlume_state');
    if (JSON.stringify(snapshotSchema) !== JSON.stringify(expectedSchemaObjects(migrationsInSnapshot, hasStateTable))) {
      throw new Error('Backup schema verification failed.');
    }
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Backup SQLite integrity check failed.');
    }
    if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('Backup foreign key verification failed.');
    }
    const tokens = database.prepare('SELECT COUNT(*) AS count FROM adapter_tokens').get() as { count: number };
    if (tokens.count !== 0) {
      throw new Error('Backup contains adapter tokens.');
    }
    const mappings = readMappings(database);
    if (JSON.stringify(mappings) !== JSON.stringify(manifest.mappings)) {
      throw new Error('Backup mapping verification failed.');
    }
    if (JSON.stringify(mappings.brains.map(({ id }) => id)) !== JSON.stringify(manifest.brainIds)) {
      throw new Error('Backup brain mapping verification failed.');
    }
    verifyScope(manifest, mappings, authenticated);
  } finally {
    database.close();
  }
}

function verifyScope(manifest: BackupManifest, mappings: BackupMappings, authenticated: boolean): void {
  if (manifest.scope === 'brain') {
    if (mappings.brains.length !== 1 || mappings.installations.length !== 0 || mappings.mounts.length !== 0) {
      throw new Error('Backup scope verification failed.');
    }
    return;
  }
  if (!authenticated) {
    throw new FullBackupAuthenticationRequiredError();
  }
  if (!mappings.brains.some(({ id }) => id === DEFAULT_PERSONAL_BRAIN_ID)) {
    throw new Error('Backup scope verification failed.');
  }
}

type SchemaObject = { readonly type: string; readonly name: string; readonly sql: string };

function migrationPrefixLength(migrationIds: readonly string[]): number {
  const expectedMigrationIds = migrations.map(({ id }) => id);
  if (migrationIds.length === 0 || migrationIds.length > expectedMigrationIds.length) {
    throw new Error('Backup schema verification failed.');
  }
  for (let index = 0; index < migrationIds.length; index += 1) {
    if (migrationIds[index] !== expectedMigrationIds[index]) {
      throw new Error('Backup schema verification failed.');
    }
  }
  return migrationIds.length;
}

function expectedSchemaObjects(migrationIds: readonly string[], includeStateTable: boolean): readonly SchemaObject[] {
  const key = `${migrationIds.join('|')}|state:${includeStateTable ? 'yes' : 'no'}`;
  const cached = expectedSchemas.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const database = new Database(':memory:');
  try {
    configureDatabase(database);
    database.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
    `);
    // `openDatabase` creates this daemon-owned state table before applying
    // migrations. Legacy snapshots may predate it, so mirror the snapshot's
    // presence rather than requiring a particular internal metadata version.
    if (includeStateTable) ensureStateTable(database);
    const recordMigration = database.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
    for (let index = 0; index < migrationIds.length; index += 1) {
      migrations[index]!.up(database);
      recordMigration.run(migrationIds[index], '1970-01-01T00:00:00.000Z');
    }
    const schema = readSchema(database);
    expectedSchemas.set(key, schema);
    return schema;
  } finally {
    database.close();
  }
}

function readSchema(database: Database.Database): readonly SchemaObject[] {
  return database
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => row as SchemaObject);
}

function decryptBundle(bundle: Uint8Array, password: string | undefined): { readonly bundle: Uint8Array; readonly authenticated: boolean } {
  const prefix = encryptedPrefix();
  const value = Buffer.from(bundle);
  if (!value.subarray(0, prefix.length).equals(prefix)) {
    return { bundle: value, authenticated: false };
  }
  if (password === undefined || password.length === 0) {
    throw new Error('Backup password is required.');
  }
  const separator = value.indexOf(0x0a, prefix.length);
  if (separator === -1) {
    throw new Error('Invalid encrypted backup header.');
  }
  let header: EncryptionHeader;
  try {
    header = JSON.parse(value.subarray(prefix.length, separator).toString('utf8')) as EncryptionHeader;
  } catch {
    throw new Error('Invalid encrypted backup header.');
  }
  if (header.algorithm !== 'aes-256-gcm' || header.kdf !== 'scrypt' || !header.salt || !header.iv || !header.tag) {
    throw new Error('Invalid encrypted backup header.');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, Buffer.from(header.salt, 'base64url'), 32), Buffer.from(header.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(header.tag, 'base64url'));
    return { bundle: Buffer.concat([decipher.update(value.subarray(separator + 1)), decipher.final()]), authenticated: true };
  } catch {
    throw new Error('Backup password could not decrypt this bundle.');
  }
}

function parseManifest(value: string): BackupManifest {
  let manifest: unknown;
  try {
    manifest = JSON.parse(value);
  } catch {
    throw new Error('Invalid Memlume backup manifest.');
  }
  if (!isManifest(manifest)) {
    throw new Error('Invalid Memlume backup manifest.');
  }
  return manifest;
}

function isManifest(value: unknown): value is BackupManifest {
  if (value === null || typeof value !== 'object') return false;
  const manifest = value as Partial<BackupManifest>;
  return manifest.format === 'memlume'
    && manifest.formatVersion === 2
    && (manifest.scope === 'full' || manifest.scope === 'brain')
    && typeof manifest.createdAt === 'string'
    && Array.isArray(manifest.brainIds)
    && manifest.brainIds.every((id) => typeof id === 'string')
    && Array.isArray(manifest.schema?.migrations)
    && manifest.schema.migrations.every((id) => typeof id === 'string')
    && typeof manifest.checksums?.['snapshot.sqlite'] === 'string'
    && isMappings(manifest.mappings)
    && (manifest.encryption === undefined || (manifest.encryption.algorithm === 'aes-256-gcm' && manifest.encryption.kdf === 'scrypt'));
}

function isMappings(value: unknown): value is BackupMappings {
  if (value === null || typeof value !== 'object') return false;
  const mappings = value as Partial<BackupMappings>;
  return Array.isArray(mappings.brains) && Array.isArray(mappings.installations) && Array.isArray(mappings.mounts);
}
