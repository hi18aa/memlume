import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import Database from 'better-sqlite3';
import { openDatabase } from '@memlume/database/internal';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import * as backup from '../dist/index.js';

const directories = [];
const createdAt = '2026-07-13T00:00:00.000Z';
const defaultBrainId = '00000000-0000-7000-8000-000000000001';
const projectBrainId = '00000000-0000-7000-8000-000000000011';
const personalBrainId = '00000000-0000-7000-8000-000000000012';
const pauseWrites = () => {};
const fullBackupPassword = 'backup-password-for-full-restore';

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop(), { force: true, recursive: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-backup-'));
  directories.push(directory);
  return directory;
}

function seedDatabase(filename) {
  const database = openDatabase(filename);
  database.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(projectBrainId, 'project', 'Memlume', createdAt, createdAt);
  database.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(personalBrainId, 'personal', 'Personal', createdAt, createdAt);
  database.prepare('INSERT INTO agent_installations (id, client_type, installation_id, profile_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    '00000000-0000-7000-8000-000000000021', 'codex', 'desktop', 'default', 'Codex', createdAt, createdAt,
  );
  database.prepare('INSERT INTO agent_installations (id, client_type, installation_id, profile_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    '00000000-0000-7000-8000-000000000022', 'hermes', 'desktop', 'default', 'Hermes', createdAt, createdAt,
  );
  database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    projectBrainId, '00000000-0000-7000-8000-000000000021', 'read_write', createdAt, createdAt,
  );
  database.prepare('INSERT INTO brain_mounts (brain_id, agent_installation_id, access, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    personalBrainId, '00000000-0000-7000-8000-000000000022', 'read', createdAt, createdAt,
  );
  database.prepare('INSERT INTO adapter_tokens (id, agent_installation_id, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    '00000000-0000-7000-8000-000000000031', '00000000-0000-7000-8000-000000000021', createHash('sha256').update('adapter-secret-not-in-backup').digest('hex'), createdAt,
  );

  for (const [brainId, eventId, memoryId, text] of [
    [projectBrainId, '00000000-0000-7000-8000-000000000041', '00000000-0000-7000-8000-000000000051', 'This project uses pnpm.'],
    [personalBrainId, '00000000-0000-7000-8000-000000000042', '00000000-0000-7000-8000-000000000052', 'Use concise answers.'],
  ]) {
    database.prepare('INSERT INTO events (id, event_type, raw_content, source_type, source_data, occurred_at, ingested_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      eventId, 'user_message', text, 'test', '{}', createdAt, createdAt, `hash-${eventId}`,
    );
    database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run(eventId, brainId, createdAt);
    database.prepare('INSERT INTO memory_items (id, kind, title, canonical_text, structured_data, scope_data, status, source_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      memoryId, 'fact', text, text, '{}', '{"level":"project"}', 'active', eventId, createdAt, createdAt,
    );
    database.prepare('INSERT INTO memory_versions (id, memory_id, version, canonical_text, structured_data, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      `00000000-0000-7000-8000-${memoryId.slice(-12)}`, memoryId, 1, text, '{}', 'user', createdAt,
    );
    database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)').run(memoryId, brainId, createdAt);
    database.prepare('INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      memoryId, text, text, text, 'pnpm', '', text,
    );
  }
  return database;
}

function seedImportTarget(filename) {
  const database = openDatabase(filename);
  const brainId = '00000000-0000-7000-8000-000000000111';
  const eventId = '00000000-0000-7000-8000-000000000121';
  const memoryId = '00000000-0000-7000-8000-000000000101';
  database.prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(brainId, 'project', 'Existing target', createdAt, createdAt);
  database.prepare('INSERT INTO events (id, event_type, raw_content, source_type, source_data, occurred_at, ingested_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    eventId, 'user_message', 'Existing target fact.', 'test', '{}', createdAt, createdAt, 'target-event-hash',
  );
  database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run(eventId, brainId, createdAt);
  database.prepare('INSERT INTO memory_items (id, kind, title, canonical_text, structured_data, scope_data, status, source_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    memoryId, 'fact', 'Existing target fact.', 'Existing target fact.', '{}', '{"level":"project"}', 'active', eventId, createdAt, createdAt,
  );
  database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)').run(memoryId, brainId, createdAt);
  database.prepare('INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    memoryId, 'Existing target fact.', 'Existing target fact.', 'Existing target fact.', '', '', 'Existing target fact.',
  );
  return database;
}

describe('Memlume backup bundle', () => {
  test('requires a password when creating a full backup', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));

    await assert.rejects(
      backup.createBackup({ database: source, outputPath: join(directory, 'full.memlume') }),
      /full backups.*password/i,
    );
    source.close();
  });

  test('round-trips a full snapshot with mappings and without adapter tokens', async () => {
    assert.equal(typeof backup.createBackup, 'function');
    const directory = temporaryDirectory();
    const sourcePath = join(directory, 'source.sqlite');
    const targetPath = join(directory, 'target.sqlite');
    const bundlePath = join(directory, 'full.memlume');
    const source = seedDatabase(sourcePath);

    const manifest = await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.scope, 'full');
    assert.deepEqual((await backup.verifyBackup({ backupPath: bundlePath, password: fullBackupPassword })).brainIds, [defaultBrainId, projectBrainId, personalBrainId]);
    const restored = await backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, password: fullBackupPassword, pauseWrites });
    const target = openDatabase(targetPath);

    assert.deepEqual(manifest.mappings.mounts, [{ brainId: projectBrainId, agentInstallationId: '00000000-0000-7000-8000-000000000021', access: 'read_write' }, { brainId: personalBrainId, agentInstallationId: '00000000-0000-7000-8000-000000000022', access: 'read' }]);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 2);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM memory_versions').get().count, 2);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM brain_mounts').get().count, 2);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM adapter_tokens').get().count, 0);
    assert.equal(readFileSync(bundlePath).includes(Buffer.from('adapter-secret-not-in-backup')), false);
    assert.equal(existsSync(restored.rollbackPath), false);
    target.close();
  });

  test('imports one exported brain as a new unmounted brain without changing existing data', async () => {
    assert.equal(typeof backup.createBackup, 'function');
    const directory = temporaryDirectory();
    const sourcePath = join(directory, 'source.sqlite');
    const targetPath = join(directory, 'target.sqlite');
    const bundlePath = join(directory, 'project.memlume');
    const source = seedDatabase(sourcePath);

    const manifest = await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    assert.equal(manifest.scope, 'brain');
    assert.deepEqual(manifest.mappings.installations, []);
    assert.deepEqual(manifest.mappings.mounts, []);
    await assert.rejects(backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, pauseWrites }), /brain import/i);

    const target = seedImportTarget(targetPath);
    const imported = await backup.importBrain({ backupPath: bundlePath, database: target });

    assert.deepEqual(manifest.brainIds, [projectBrainId]);
    assert.notEqual(imported.brain.id, projectBrainId);
    assert.deepEqual(imported.source, { brainId: projectBrainId, name: 'Memlume' });
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM brains').get().count, 3);
    assert.equal(target.prepare('SELECT canonical_text FROM memory_items WHERE id IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').pluck().get(imported.brain.id), 'This project uses pnpm.');
    assert.equal(target.prepare('SELECT keywords FROM memory_search WHERE memory_id IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').pluck().get(imported.brain.id), 'pnpm');
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM brain_mounts WHERE brain_id = ?').get(imported.brain.id).count, 0);
    assert.equal(target.prepare('SELECT canonical_text FROM memory_items WHERE id IN (SELECT memory_id FROM memory_brains WHERE brain_id = ?)').pluck().get('00000000-0000-7000-8000-000000000111'), 'Existing target fact.');
    assert.throws(
      () => target.prepare('UPDATE events SET raw_content = ? WHERE id IN (SELECT event_id FROM event_brains WHERE brain_id = ?)').run('tampered', imported.brain.id),
      /append-only/,
    );
    target.close();
  });

  test('rejects an imported brain event conflict without changing the target database', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    source.prepare('INSERT INTO events (id, event_type, raw_content, source_type, source_reference, source_data, occurred_at, ingested_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '00000000-0000-7000-8000-000000000141', 'user_message', 'Exported duplicate source.', 'test', 'shared-source', '{}', createdAt, createdAt, 'shared-event-hash',
    );
    source.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run('00000000-0000-7000-8000-000000000141', projectBrainId, createdAt);
    const bundlePath = join(directory, 'project.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const target = seedImportTarget(join(directory, 'target.sqlite'));
    target.prepare('INSERT INTO events (id, event_type, raw_content, source_type, source_reference, source_data, occurred_at, ingested_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      '00000000-0000-7000-8000-000000000131', 'user_message', 'Existing duplicate source.', 'test', 'shared-source', '{}', createdAt, createdAt, 'shared-event-hash',
    );
    target.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)').run('00000000-0000-7000-8000-000000000131', '00000000-0000-7000-8000-000000000111', createdAt);

    await assert.rejects(backup.importBrain({ backupPath: bundlePath, database: target }), { name: 'BrainImportConflictError' });
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM brains').get().count, 2);
    assert.equal(target.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 1);
    target.close();
  });

  test('encrypts a bundle and rejects a wrong password before restore', async () => {
    assert.equal(typeof backup.createBackup, 'function');
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'encrypted.memlume');

    await backup.createBackup({ database: source, outputPath: bundlePath, password: 'correct horse battery staple' });
    source.close();
    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath, password: 'wrong password' }), /password|decrypt|authenticate/i);
    assert.deepEqual((await backup.verifyBackup({ backupPath: bundlePath, password: 'correct horse battery staple' })).encryption.algorithm, 'aes-256-gcm');
  });

  test('rejects a zip entry whose declared unpacked size exceeds the backup safety limit before decompression', async () => {
    const directory = temporaryDirectory();
    const bundlePath = join(directory, 'declared-huge.memlume');
    const bundle = zipSync({ 'manifest.json': strToU8('{}'), 'snapshot.sqlite': new Uint8Array([0]) });
    setCentralDirectoryUncompressedSize(bundle, 'snapshot.sqlite', 65 * 1024 * 1024);
    writeFileSync(bundlePath, bundle);

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /uncompressed size/i);
  });

  test('rejects unexpected zip entries before attempting to decompress them', async () => {
    const directory = temporaryDirectory();
    const bundlePath = join(directory, 'unexpected-entry.memlume');
    const bundle = zipSync({ 'manifest.json': strToU8('{}'), 'snapshot.sqlite': new Uint8Array([0]), 'surplus.bin': new Uint8Array([0]) });
    setCentralDirectoryUncompressedSize(bundle, 'surplus.bin', 65 * 1024 * 1024);
    writeFileSync(bundlePath, bundle);

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /unexpected backup entry/i);
  });

  test('rejects an oversized bundle before reading it into memory', async () => {
    const directory = temporaryDirectory();
    const bundlePath = join(directory, 'oversized.memlume');
    writeFileSync(bundlePath, '');
    truncateSync(bundlePath, 65 * 1024 * 1024);

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /compressed size/i);
  });

  test('rejects a tampered snapshot before it can be restored', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'tampered.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    files['snapshot.sqlite'][0] ^= 0xff;
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /checksum/i);
  });

  test('rejects a selected Brain snapshot whose manifest scope is forged as full', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'project.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.scope = 'full';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /scope|authenticated/i);
  });

  test('rejects a forged full scope for an unencrypted default Personal Brain export before restore', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'default-brain.memlume');
    const targetPath = join(directory, 'target.sqlite');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: defaultBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.scope = 'full';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(
      backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, pauseWrites }),
      /authenticated|encrypted/i,
    );
    assert.equal(existsSync(targetPath), false);
  });

  test('verifies manifest schema against the SQLite snapshot', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'schema-tampered.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.schema.migrations = [];
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /schema/i);
  });

  test('rejects a snapshot whose migration ledger is intact but required schema objects are missing', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'schema-object-tampered.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const snapshotPath = join(directory, 'tampered.sqlite');
    writeFileSync(snapshotPath, files['snapshot.sqlite']);
    const snapshot = new Database(snapshotPath);
    snapshot.pragma('foreign_keys = OFF');
    snapshot.exec('DROP TRIGGER events_reject_update; DROP TRIGGER events_reject_delete; DROP TABLE events;');
    snapshot.close();
    files['snapshot.sqlite'] = readFileSync(snapshotPath);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.checksums['snapshot.sqlite'] = createHash('sha256').update(files['snapshot.sqlite']).digest('hex');
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /schema/i);
  });

  test('rejects a manifest whose listed brains do not match the snapshot mappings', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'brain-ids-tampered.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.brainIds = [defaultBrainId];
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /brain|mapping/i);
  });

  test('rejects a snapshot with broken foreign-key relationships', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'foreign-key-tampered.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, brainId: projectBrainId });
    source.close();
    const files = unzipSync(readFileSync(bundlePath));
    const snapshotPath = join(directory, 'tampered.sqlite');
    writeFileSync(snapshotPath, files['snapshot.sqlite']);
    const snapshot = new Database(snapshotPath);
    snapshot.pragma('foreign_keys = OFF');
    snapshot.prepare('UPDATE memory_items SET source_event_id = ? WHERE id = ?').run('00000000-0000-7000-8000-000000000099', '00000000-0000-7000-8000-000000000051');
    snapshot.close();
    files['snapshot.sqlite'] = readFileSync(snapshotPath);
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.checksums['snapshot.sqlite'] = createHash('sha256').update(files['snapshot.sqlite']).digest('hex');
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    writeFileSync(bundlePath, zipSync(files));

    await assert.rejects(backup.verifyBackup({ backupPath: bundlePath }), /foreign key/i);
  });

  test('backs up the current database before atomically replacing it', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'source.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    const targetPath = join(directory, 'target.sqlite');
    const current = seedDatabase(targetPath);
    current.prepare('UPDATE memory_items SET canonical_text = ? WHERE id = ?').run('Old database content.', '00000000-0000-7000-8000-000000000051');
    current.close();

    const restored = await backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, password: fullBackupPassword, pauseWrites });
    const target = openDatabase(targetPath);
    const rollback = openDatabase(restored.rollbackPath);
    assert.equal(target.prepare('SELECT canonical_text FROM memory_items').pluck().get(), 'This project uses pnpm.');
    assert.equal(rollback.prepare('SELECT canonical_text FROM memory_items WHERE id = ?').pluck().get('00000000-0000-7000-8000-000000000051'), 'Old database content.');
    target.close();
    rollback.close();
  });

  test('rolls back the replacement and reopens the original runtime when resume fails', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'source.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    const targetPath = join(directory, 'target.sqlite');
    const current = seedDatabase(targetPath);
    current.prepare('UPDATE memory_items SET canonical_text = ? WHERE id = ?').run('Old database content.', '00000000-0000-7000-8000-000000000051');
    current.close();
    let resumes = 0;

    await assert.rejects(
      backup.restoreBackup({
        backupPath: bundlePath,
        databasePath: targetPath,
        password: fullBackupPassword,
        pauseWrites: () => () => {
          resumes += 1;
          if (resumes === 1) throw new Error('runtime reopen failed');
        },
      }),
      /runtime reopen failed/,
    );

    const intact = openDatabase(targetPath);
    assert.equal(intact.prepare('SELECT canonical_text FROM memory_items WHERE id = ?').pluck().get('00000000-0000-7000-8000-000000000051'), 'Old database content.');
    intact.close();
    assert.equal(resumes, 2);
  });

  test('does not resume a replacement database when the rollback copy is unavailable', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'source.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    const targetPath = join(directory, 'target.sqlite');
    seedDatabase(targetPath).close();
    let resumes = 0;

    await assert.rejects(
      backup.restoreBackup({
        backupPath: bundlePath,
        databasePath: targetPath,
        password: fullBackupPassword,
        pauseWrites: () => () => {
          resumes += 1;
          if (resumes === 1) {
            for (const name of readdirSync(directory)) {
              if (name.includes('.pre-restore-')) rmSync(join(directory, name), { force: true });
            }
            throw new Error('runtime reopen failed');
          }
        },
      }),
      /manual recovery/i,
    );

    assert.equal(resumes, 1);
  });

  test('leaves the main database unchanged when a sidecar prevents replacement', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'source.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    const targetPath = join(directory, 'target.sqlite');
    const current = seedDatabase(targetPath);
    current.prepare('UPDATE memory_items SET canonical_text = ? WHERE id = ?').run('Old database content.', '00000000-0000-7000-8000-000000000051');
    current.close();
    mkdirSync(`${targetPath}-wal`);

    await assert.rejects(backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, password: fullBackupPassword, pauseWrites }), /unable to open|EISDIR|directory/i);
    rmSync(`${targetPath}-wal`, { force: true, recursive: true });

    const intact = openDatabase(targetPath);
    assert.equal(intact.prepare('SELECT canonical_text FROM memory_items WHERE id = ?').pluck().get('00000000-0000-7000-8000-000000000051'), 'Old database content.');
    intact.close();
  });

  test('rejects invalid snapshots and leaves the current database intact', async () => {
    assert.equal(typeof backup.restoreBackup, 'function');
    const directory = temporaryDirectory();
    const targetPath = join(directory, 'target.sqlite');
    const target = seedDatabase(targetPath);
    target.close();
    const invalidBundlePath = join(directory, 'invalid.memlume');
    readFileSync(targetPath);
    await assert.rejects(backup.restoreBackup({ backupPath: invalidBundlePath, databasePath: targetPath, pauseWrites }));

    const intact = openDatabase(targetPath);
    assert.equal(intact.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count, 2);
    intact.close();
    assert.equal(readdirSync(directory).filter((name) => name.includes('pre-restore')).length, 0);
  });

  test('requires exclusive database access before restoring a valid bundle', async () => {
    const directory = temporaryDirectory();
    const source = seedDatabase(join(directory, 'source.sqlite'));
    const bundlePath = join(directory, 'source.memlume');
    await backup.createBackup({ database: source, outputPath: bundlePath, password: fullBackupPassword });
    source.close();
    const targetPath = join(directory, 'target.sqlite');
    const target = seedDatabase(targetPath);
    target.prepare('UPDATE memory_items SET canonical_text = ? WHERE id = ?').run('Current database content.', '00000000-0000-7000-8000-000000000051');
    target.close();

    await assert.rejects(backup.restoreBackup({ backupPath: bundlePath, databasePath: targetPath, password: fullBackupPassword }), /pause writes|exclusive/i);

    const intact = openDatabase(targetPath);
    assert.equal(intact.prepare('SELECT canonical_text FROM memory_items WHERE id = ?').pluck().get('00000000-0000-7000-8000-000000000051'), 'Current database content.');
    intact.close();
  });
});

function setCentralDirectoryUncompressedSize(bundle, filename, size) {
  for (let offset = 0; offset <= bundle.length - 46; offset += 1) {
    if (bundle[offset] !== 0x50 || bundle[offset + 1] !== 0x4b || bundle[offset + 2] !== 0x01 || bundle[offset + 3] !== 0x02) continue;
    const nameLength = bundle[offset + 28] | bundle[offset + 29] << 8;
    const name = strFromU8(bundle.subarray(offset + 46, offset + 46 + nameLength));
    if (name !== filename) continue;
    bundle[offset + 24] = size & 0xff;
    bundle[offset + 25] = size >>> 8 & 0xff;
    bundle[offset + 26] = size >>> 16 & 0xff;
    bundle[offset + 27] = size >>> 24 & 0xff;
    return;
  }
  throw new Error(`Missing ${filename} central directory entry.`);
}
