import { describe, expect, test } from 'vitest';

import {
  ImportQuarantineRecordSchema,
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryStatusSchema,
  RoutingInboxRecordSchema,
  SemanticRecordSchema,
  TombstoneRecordSchema,
} from '../src/index.js';

const ids = {
  record: '018f9d4e-7c2a-7b91-8dc0-61749dbcc01e',
  memory: '018f9d4e-7c2b-7b91-8dc0-61749dbcc01f',
  brain: '018f9d4e-7c2b-7b91-8dc0-61749dbcc020',
  capture: 'capture-codex-1',
} as const;

const record = {
  recordType: 'semantic',
  schemaVersion: '0.3',
  recordId: ids.record,
  memoryId: ids.memory,
  brainId: ids.brain,
  status: 'active',
  kind: 'fact',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  captureId: ids.capture,
  atomKey: 'capture-codex-1:0',
  sourceAtom: '使用 Vue 開發前端。',
  canonicalText: '前端使用 Vue 開發。',
  structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue' },
} as const;

describe('v0.3 brain record contracts', () => {
  test('only supports personal and project brains through the public kind enum', async () => {
    const { BrainKindSchema } = await import('../src/index.js');

    expect(BrainKindSchema.safeParse('domain').success).toBe(false);
    expect(BrainKindSchema.safeParse('personal').success).toBe(true);
    expect(BrainKindSchema.safeParse('project').success).toBe(true);
  });

  test('requires a brain on memory records', () => {
    expect(
      MemoryItemSchema.safeParse({
        id: record.memoryId,
        kind: 'fact',
        canonicalText: record.canonicalText,
        structuredData: { subject: 'frontend', predicate: 'framework', object: 'Vue', confidence: 1 },
        scope: { level: 'global' },
        status: 'active',
        priority: 0,
        confidence: 1,
        explicitness: 1,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }).success,
    ).toBe(false);
  });

  test('keeps immutable record identity separate from semantic memory identity', () => {
    const parsed = SemanticRecordSchema.parse(record);

    expect(parsed.recordId).not.toBe(parsed.memoryId);
    expect(SemanticRecordSchema.safeParse({ ...record, unexpected: true }).success).toBe(false);
  });

  test('models tombstones as strict immutable records', () => {
    const tombstone = {
      recordType: 'tombstone',
      schemaVersion: '0.3',
      recordId: ids.record,
      memoryId: ids.memory,
      brainId: ids.brain,
      status: 'superseded',
      kind: 'fact',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
      captureId: ids.capture,
      atomKey: 'capture-codex-1:0',
      supersedesRecordId: ids.record,
      reason: 'forgotten by user',
    };

    expect(TombstoneRecordSchema.parse(tombstone).status).toBe('superseded');
    expect(TombstoneRecordSchema.safeParse({ ...tombstone, sourceAtom: 'must not be present' }).success).toBe(false);
  });

  test('keeps unresolved routing records outside any brain', () => {
    const inboxItem = {
      recordType: 'routing_inbox',
      schemaVersion: '0.3',
      recordId: ids.record,
      captureId: ids.capture,
      atomKey: 'capture-codex-1:0',
      status: 'routing_required',
      statement: '這段內容需要使用者指定專案。',
      evidenceRef: 'session://codex/capture-codex-1#0',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };

    const parsed = RoutingInboxRecordSchema.parse(inboxItem);
    expect(parsed).not.toHaveProperty('brainId');
    expect(RoutingInboxRecordSchema.safeParse({ ...inboxItem, brainId: ids.brain }).success).toBe(false);
  });

  test('quarantines import conflicts without overwriting a record', () => {
    const conflict = {
      recordType: 'import_quarantine',
      schemaVersion: '0.3',
      recordId: ids.record,
      reason: 'record_conflict',
      sourcePath: 'backup/brains/project/records/record.md',
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };

    expect(ImportQuarantineRecordSchema.parse(conflict).reason).toBe('record_conflict');
    expect(ImportQuarantineRecordSchema.safeParse({ ...conflict, unknown: true }).success).toBe(false);
  });

  test('separates event timeline records from active memory', () => {
    expect(MemoryKindSchema.parse('event')).toBe('event');
    expect(MemoryStatusSchema.parse('event_only')).toBe('event_only');
  });
});
