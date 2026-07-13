import { createDecipheriv, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { strFromU8, unzipSync } from 'fflate';

import { encryptedPrefix, readMappings, sha256, type BackupManifest, type BackupMappings, type EncryptionHeader } from './create-backup.js';

export type VerifyBackupOptions = {
  readonly backupPath: string;
  readonly password?: string;
};

export type VerifiedBackup = {
  readonly manifest: BackupManifest;
  readonly snapshot: Uint8Array;
};

export async function verifyBackup(options: VerifyBackupOptions): Promise<BackupManifest> {
  return (await readVerifiedBackup(options)).manifest;
}

export async function readVerifiedBackup(options: VerifyBackupOptions): Promise<VerifiedBackup> {
  const bundle = await import('node:fs/promises').then(({ readFile }) => readFile(options.backupPath));
  const decrypted = decryptBundle(bundle, options.password);
  const files = unzipSync(decrypted);
  if (Object.keys(files).length !== 2 || files['manifest.json'] === undefined || files['snapshot.sqlite'] === undefined) {
    throw new Error('Invalid Memlume backup bundle.');
  }

  const manifest = parseManifest(strFromU8(files['manifest.json']));
  const snapshot = files['snapshot.sqlite'];
  if (manifest.checksums['snapshot.sqlite'] !== sha256(snapshot)) {
    throw new Error('Backup checksum verification failed.');
  }
  inspectSnapshot(snapshot, manifest);
  return { manifest, snapshot };
}

export function inspectSnapshot(snapshot: Uint8Array, manifest: BackupManifest): void {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-backup-verify-'));
  const snapshotPath = join(directory, 'snapshot.sqlite');
  try {
    writeFileSync(snapshotPath, snapshot);
    inspectSnapshotPath(snapshotPath, manifest);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function inspectSnapshotPath(snapshotPath: string, manifest: BackupManifest): void {
  const database = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('Backup SQLite integrity check failed.');
    }
    if ((database.pragma('foreign_key_check') as unknown[]).length > 0) {
      throw new Error('Backup foreign key verification failed.');
    }
    const migrations = database.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all() as string[];
    if (JSON.stringify(migrations) !== JSON.stringify(manifest.schema.migrations)) {
      throw new Error('Backup schema verification failed.');
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
  } finally {
    database.close();
  }
}

function decryptBundle(bundle: Uint8Array, password: string | undefined): Uint8Array {
  const prefix = encryptedPrefix();
  const value = Buffer.from(bundle);
  if (!value.subarray(0, prefix.length).equals(prefix)) {
    return value;
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
    return Buffer.concat([decipher.update(value.subarray(separator + 1)), decipher.final()]);
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
    && manifest.formatVersion === 1
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
