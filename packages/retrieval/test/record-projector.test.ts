import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createUuidV7 } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import { MemoryStore, RecordProjector } from '../src/index.js';

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()!.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'memlume-projector-'));
  directories.push(root);
  const database = openDatabase(join(root, 'memlume.sqlite'));
  databases.push(database);
  const brainId = createUuidV7();
  database
    .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(brainId, 'project', 'Project', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
  return { database, brainId };
}

function semanticRecord(brainId: string, overrides: Record<string, unknown> = {}) {
  const recordId = createUuidV7();
  return {
    schemaVersion: '0.3',
    recordType: 'semantic' as const,
    recordId,
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
    ...overrides,
    recordId,
  };
}

describe('RecordProjector', () => {
  test('projects active records into memory, brain mapping, source event and FTS idempotently', () => {
    const { database, brainId } = createFixture();
    const record = semanticRecord(brainId);
    const projector = new RecordProjector(database);

    expect(projector.project({ record, relativePath: `brains/${brainId}/records/2026/07/${record.recordId}.md`, checksum: 'a'.repeat(64) }).status).toBe('active');
    expect(projector.project({ record, relativePath: `brains/${brainId}/records/2026/07/${record.recordId}.md`, checksum: 'a'.repeat(64) }).status).toBe('active');

    const store = new MemoryStore(database);
    expect(store.get(record.memoryId, [brainId])?.canonicalText).toBe(record.canonicalText);
    expect(store.search('Vue', { brainIds: [brainId] }).map((item) => item.id)).toEqual([record.memoryId]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM record_projections').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT source_event_id FROM memory_items WHERE id = ?').pluck().get(record.memoryId)).toBe(record.recordId);
  });

  test('binds an explicit source event without replacing its captured content', () => {
    const { database, brainId } = createFixture();
    const sourceEventId = createUuidV7();
    const rawContent = '原始對話：前端使用 Vue。';
    const contentHash = createHash('sha256').update(rawContent, 'utf8').digest('hex');
    database.prepare(`
      INSERT INTO events (
        id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
        source_data, occurred_at, ingested_at, processing_status, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sourceEventId,
      'user_message',
      rawContent,
      null,
      'adapter',
      'test',
      'capture://test',
      '{}',
      '2026-07-16T00:00:00.000Z',
      '2026-07-16T00:00:00.000Z',
      'processed',
      contentHash,
    );
    database.prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
      .run(sourceEventId, brainId, '2026-07-16T00:00:00.000Z');

    const record = semanticRecord(brainId, { sourceEventId });
    new RecordProjector(database).project({
      record,
      relativePath: `brains/${brainId}/records/2026/07/${record.recordId}.md`,
      checksum: 'e'.repeat(64),
    });

    expect(database.prepare('SELECT source_event_id FROM memory_items WHERE id = ?').pluck().get(record.memoryId)).toBe(sourceEventId);
    expect(database.prepare('SELECT raw_content FROM events WHERE id = ?').pluck().get(sourceEventId)).toBe(rawContent);
    expect(database.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 1 });
  });

  test('does not make event_only records searchable and rejects checksum conflicts', () => {
    const { database, brainId } = createFixture();
    const record = semanticRecord(brainId, { status: 'event_only', kind: 'event', structuredData: { event: 'turn' } });
    const projector = new RecordProjector(database);
    projector.project({ record, relativePath: 'brains/event.md', checksum: 'b'.repeat(64) });
    expect(new MemoryStore(database).search('Vue', { brainIds: [brainId] })).toHaveLength(0);
    expect(() => projector.project({ record, relativePath: 'brains/event.md', checksum: 'c'.repeat(64) })).toThrow(/record_conflict/i);
  });

  test('rejects cross-Brain supersession and cycles', () => {
    const { database, brainId } = createFixture();
    const otherBrainId = createUuidV7();
    database
      .prepare('INSERT INTO brains (id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(otherBrainId, 'project', 'Other', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z');
    const first = semanticRecord(brainId);
    const second = semanticRecord(otherBrainId, { supersedesRecordId: first.recordId });
    const projector = new RecordProjector(database);
    projector.project({ record: first, relativePath: `brains/${brainId}/first.md`, checksum: '1'.repeat(64) });
    expect(() => projector.project({ record: second, relativePath: `brains/${otherBrainId}/second.md`, checksum: '2'.repeat(64) })).toThrow(/cross.*brain|brain.*supersed/i);

    const cycleA = semanticRecord(brainId);
    const cycleB = semanticRecord(brainId, { supersedesRecordId: cycleA.recordId });
    const cyclicA = { ...cycleA, supersedesRecordId: cycleB.recordId };
    expect(() => projector.projectRecords([
      { record: cyclicA, relativePath: 'brains/cycle-a.md', checksum: '3'.repeat(64) },
      { record: cycleB, relativePath: 'brains/cycle-b.md', checksum: '4'.repeat(64) },
    ])).toThrow(/supersedes_cycle/i);
  });

  test('projects revisions and tombstones without deleting authority records', () => {
    const { database, brainId } = createFixture();
    const first = semanticRecord(brainId);
    const second = semanticRecord(brainId, { supersedesRecordId: first.recordId, canonicalText: '使用 Vue 3 開發前端。' });
    const projector = new RecordProjector(database);
    projector.projectRecords([
      { record: first, relativePath: 'brains/first.md', checksum: '5'.repeat(64) },
      { record: second, relativePath: 'brains/second.md', checksum: '6'.repeat(64) },
    ]);
    const store = new MemoryStore(database);
    expect(store.get(first.memoryId, [brainId])?.status).toBe('superseded');
    expect(store.get(first.memoryId, [brainId])?.supersededBy).toBe(second.memoryId);
    expect(store.get(second.memoryId, [brainId])?.status).toBe('active');

    const tombstone = {
      schemaVersion: '0.3',
      recordType: 'tombstone' as const,
      recordId: createUuidV7(),
      memoryId: second.memoryId,
      brainId,
      status: 'superseded' as const,
      kind: 'event' as const,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      captureId: createUuidV7(),
      atomKey: 'tombstone:vue',
      supersedesRecordId: second.recordId,
      reason: '使用者撤回這項記憶。',
    };
    projector.project({ record: tombstone, relativePath: 'brains/tombstone.md', checksum: '7'.repeat(64) });
    expect(store.get(second.memoryId, [brainId])?.status).toBe('superseded');
    expect(store.search('Vue', { brainIds: [brainId] })).toHaveLength(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM record_projections').get()).toEqual({ count: 3 });
  });

  test('rebuild preserves runtime usage, relation, and version rows', () => {
    const { database, brainId } = createFixture();
    const first = semanticRecord(brainId);
    const second = semanticRecord(brainId, { canonicalText: '使用 TypeScript 開發前端。' });
    const inputs = [
      { record: first, relativePath: 'brains/first.md', checksum: '8'.repeat(64) },
      { record: second, relativePath: 'brains/second.md', checksum: '9'.repeat(64) },
    ];
    const projector = new RecordProjector(database);
    projector.projectRecords(inputs);

    database.prepare(`
      INSERT INTO memory_usage (id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), first.memoryId, createUuidV7(), createUuidV7(), 1, 1, 'success', '2026-07-16T00:01:00.000Z');
    database.prepare(`
      INSERT INTO memory_relations (source_id, target_id, relation_type, confidence, source_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(first.memoryId, second.memoryId, 'supports', 1, first.recordId, '2026-07-16T00:01:00.000Z');
    database.prepare(`
      INSERT INTO memory_versions (id, memory_id, version, canonical_text, structured_data, changed_by, change_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), first.memoryId, 1, first.canonicalText, JSON.stringify(first.structuredData), 'test', 'baseline', '2026-07-16T00:01:00.000Z');

    projector.rebuild(inputs);

    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_usage').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_relations').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_versions').get()).toEqual({ count: 1 });
  });

  test('rebuild archives active memories without an authority projection and keeps runtime history', () => {
    const { database, brainId } = createFixture();
    const authority = semanticRecord(brainId);
    const input = {
      record: authority,
      relativePath: 'brains/authority.md',
      checksum: 'a'.repeat(64),
    };
    const projector = new RecordProjector(database);
    projector.project(input);

    const legacyMemoryId = createUuidV7();
    const now = '2026-07-16T00:00:00.000Z';
    database.prepare(`
      INSERT INTO memory_items (
        id, kind, title, canonical_text, structured_data, scope_data, status, priority,
        confidence, explicitness, source_event_id, created_at, updated_at, valid_from,
        valid_until, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      legacyMemoryId,
      'fact',
      null,
      'legacy memory',
      JSON.stringify({ subject: 'legacy', predicate: 'state', object: 'active' }),
      JSON.stringify({ level: 'global' }),
      'active',
      0,
      1,
      1,
      null,
      now,
      now,
      null,
      null,
      null,
    );
    database.prepare('INSERT INTO memory_brains (memory_id, brain_id, created_at) VALUES (?, ?, ?)')
      .run(legacyMemoryId, brainId, now);
    database.prepare(`
      INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(legacyMemoryId, '', 'legacy memory', 'legacy memory', '', '', 'legacy memory');
    database.prepare(`
      INSERT INTO memory_usage (id, memory_id, task_id, agent_id, retrieval_rank, was_included, outcome, used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), legacyMemoryId, createUuidV7(), createUuidV7(), 1, 1, 'success', now);
    database.prepare(`
      INSERT INTO memory_relations (source_id, target_id, relation_type, confidence, source_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(legacyMemoryId, authority.memoryId, 'supports', 1, null, now);
    database.prepare(`
      INSERT INTO memory_versions (id, memory_id, version, canonical_text, structured_data, changed_by, change_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), legacyMemoryId, 1, 'legacy memory', JSON.stringify({}), 'test', 'baseline', now);
    database.prepare(`
      INSERT INTO outcomes (id, task_id, agent_id, result, correction_type, correction_data, used_memory_ids, used_tool_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createUuidV7(), createUuidV7(), createUuidV7(), 'success', null, null, JSON.stringify([legacyMemoryId]), JSON.stringify([]), now);

    projector.rebuild([input]);

    expect(database.prepare('SELECT status FROM memory_items WHERE id = ?').pluck().get(legacyMemoryId)).toBe('archived');
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_search WHERE memory_id = ?').get(legacyMemoryId)).toEqual({ count: 0 });
    expect(new MemoryStore(database).search('legacy', { brainIds: [brainId] })).toHaveLength(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_usage WHERE memory_id = ?').get(legacyMemoryId)).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_relations WHERE source_id = ?').get(legacyMemoryId)).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_versions WHERE memory_id = ?').get(legacyMemoryId)).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM outcomes WHERE used_memory_ids LIKE ?').get(`%${legacyMemoryId}%`)).toEqual({ count: 1 });
  });
});
