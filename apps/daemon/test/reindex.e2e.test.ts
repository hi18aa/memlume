import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUuidV7 } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { MemoryStore } from '@memlume/retrieval';
import { MarkdownRecordStore, RoutingInboxStore } from '@memlume/shared-brains';
import { afterEach, describe, expect, test } from 'vitest';

import { reindex } from '../src/reindex-service.js';

const databases: SqliteDatabase[] = [];
const roots: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'memlume-reindex-'));
  roots.push(dataRoot);
  const databasePath = join(dataRoot, 'memlume.sqlite');
  const database = openDatabase(databasePath);
  databases.push(database);
  const brainId = createUuidV7();
  database
    .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(brainId, 'project', 'Reindex project', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  const store = new MarkdownRecordStore({ rootDir: dataRoot });
  const record = {
    schemaVersion: '0.3',
    recordType: 'semantic' as const,
    recordId: createUuidV7(),
    memoryId: createUuidV7(),
    brainId,
    status: 'active' as const,
    kind: 'fact' as const,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    captureId: createUuidV7(),
    atomKey: 'fact:vue',
    sourceAtom: '使用 Vue 開發前端。',
    canonicalText: '使用 Vue 開發前端。',
    structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 1 },
  };
  store.append(record);
  const inbox = new RoutingInboxStore({ rootDir: dataRoot });
  inbox.addPending({
    recordType: 'routing_inbox',
    schemaVersion: '0.3',
    recordId: createUuidV7(),
    captureId: createUuidV7(),
    atomKey: 'project:unknown',
    status: 'routing_required',
    statement: '未指定專案的記憶。',
    evidenceRef: 'test://capture',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  });
  return { dataRoot, databasePath, database, brainId, record };
}

describe('reindex service', () => {
  test('projects Markdown, keeps Inbox top-level, and rebuilds after SQLite deletion', () => {
    const { dataRoot, databasePath, database, brainId, record } = fixture();
    const first = reindex({ dataRoot, database });
    expect(first.projected).toHaveLength(1);
    expect(first.inbox.pending).toHaveLength(1);
    expect(new MemoryStore(database).search('Vue', { brainIds: [brainId] }).map((memory) => memory.id)).toEqual([record.memoryId]);

    database.close();
    databases.splice(databases.indexOf(database), 1);
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });

    const rebuilt = reindex({ dataRoot, databasePath });
    expect(rebuilt.projected).toHaveLength(1);
    const reopened = openDatabase(databasePath);
    databases.push(reopened);
    expect(new MemoryStore(reopened).search('Vue', { brainIds: [brainId] }).map((memory) => memory.id)).toEqual([record.memoryId]);
    expect(rebuilt.inbox.pending).toHaveLength(1);
  });

  test('validates all records before transaction and preserves an existing projection on corruption', () => {
    const { dataRoot, database, brainId, record } = fixture();
    reindex({ dataRoot, database });
    const path = join(dataRoot, 'brains', brainId, 'records', '2026', '07', `${record.recordId}.md`);
    const before = readFileSync(path, 'utf8');
    writeFileSync(path, before.replace('使用 Vue 開發前端。', '使用 React 開發前端。'));
    expect(() => reindex({ dataRoot, database })).toThrow(/checksum|integrity/i);
    expect(new MemoryStore(database).search('Vue', { brainIds: [brainId] })).toHaveLength(1);
  });
});
