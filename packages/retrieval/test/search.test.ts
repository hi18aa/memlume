import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PERSONAL_BRAIN_ID, MemoryItemSchema, type MemoryItem, type MemoryScope } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import * as retrieval from '../src/index.js';
import { SourceEventBrainMismatchError } from '../src/index.js';

type MemoryDraft = {
  readonly kind: 'policy' | 'preference' | 'fact' | 'decision';
  readonly canonicalText: string;
  readonly structuredData: Record<string, unknown>;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly explicitness?: number;
  readonly brainId: string;
  readonly sourceEventId?: string;
};

type MemoryFilters = {
  readonly scope?: MemoryScope;
  readonly status?: string;
  readonly kinds?: readonly string[];
  readonly brainIds?: readonly string[];
};

type MemoryStore = {
  save(input: MemoryDraft): MemoryItem;
  saveCandidate(input: MemoryDraft): MemoryItem;
  approveCandidate(
    id: string,
    input: { readonly actor: string; readonly reason: string; readonly supersedeMemoryId?: string },
    brainIds?: readonly string[],
  ): MemoryItem;
  rejectCandidate(
    id: string,
    input: { readonly actor: string; readonly reason: string },
    brainIds?: readonly string[],
  ): MemoryItem;
  update(
    id: string,
    input: Partial<Omit<MemoryDraft, 'kind'>> & { readonly actor: string; readonly reason: string },
    brainIds?: readonly string[],
  ): MemoryItem;
  get(id: string, brainIds?: readonly string[]): MemoryItem | undefined;
  list(filters?: MemoryFilters): MemoryItem[];
  search(query: string, filters?: MemoryFilters): MemoryItem[];
  findApplicable(scope: MemoryScope, filters?: MemoryFilters): MemoryItem[];
  listHistory(id: string, brainIds?: readonly string[]): MemoryItem[];
  listVersions(id: string, brainIds?: readonly string[]): Array<{
    readonly version: number;
    readonly canonicalText: string;
    readonly changedBy: string;
    readonly changeReason: string;
  }>;
};

type MemoryStoreConstructor = new (
  database: SqliteDatabase,
  options?: { readonly allowLegacyWrites?: boolean },
) => MemoryStore;
const { MemoryStore } = retrieval as { MemoryStore?: MemoryStoreConstructor };

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

function createStore(): { database: SqliteDatabase; store: MemoryStore } {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-retrieval-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  expect(MemoryStore).toBeTypeOf('function');
  return { database, store: new MemoryStore!(database, { allowLegacyWrites: true }) };
}

function createBrain(database: SqliteDatabase, id: string): void {
  database
    .prepare(`
      INSERT INTO brains (id, kind, name, created_at, updated_at)
      VALUES (?, 'project', ?, '2026-07-12T15:00:00.000Z', '2026-07-12T15:00:00.000Z')
    `)
    .run(id, `Test ${id}`);
}

function insertUnmappedMemory(database: SqliteDatabase): string {
  const id = '018f9d4e-7c25-7b91-8dc0-61749dbcc015';
  const canonicalText = 'An unmapped memory is not a personal memory.';
  database
    .prepare(`
      INSERT INTO memory_items (
        id, kind, title, canonical_text, structured_data, scope_data, status, priority,
        confidence, explicitness, source_event_id, created_at, updated_at, valid_from,
        valid_until, superseded_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      'fact',
      null,
      canonicalText,
      JSON.stringify({ subject: 'memory', predicate: 'mapping', object: 'missing', confidence: 1 }),
      JSON.stringify({ level: 'global' }),
      'active',
      0,
      1,
      1,
      null,
      '2026-07-12T15:00:00.000Z',
      '2026-07-12T15:00:00.000Z',
      null,
      null,
      null,
    );
  database
    .prepare(`
      INSERT INTO memory_search (memory_id, title, canonical_text, summary, keywords, entities, content)
      VALUES (?, '', ?, ?, '', '', ?)
    `)
    .run(id, canonicalText, canonicalText, canonicalText);
  return id;
}

function insertEvent(database: SqliteDatabase, id: string, brainId: string): void {
  database
    .prepare(`
      INSERT INTO events (
        id, event_type, raw_content, structured_data, source_type, source_agent, source_reference,
        source_data, occurred_at, ingested_at, content_hash
      ) VALUES (?, 'user_statement', 'Source event.', NULL, 'cli', 'codex-cli', ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      `source:${id}`,
      JSON.stringify({ type: 'cli', agent: 'codex-cli', reference: `source:${id}` }),
      '2026-07-12T15:00:00.000Z',
      '2026-07-12T15:00:00.000Z',
      '0'.repeat(64),
    );
  database
    .prepare('INSERT INTO event_brains (event_id, brain_id, created_at) VALUES (?, ?, ?)')
    .run(id, brainId, '2026-07-12T15:00:00.000Z');
}

afterEach(() => {
  while (databases.length > 0) {
    databases.pop()?.close();
  }
  while (directories.length > 0) {
    rmSync(directories.pop()!, { force: true, recursive: true });
  }
});

describe('MemoryStore', () => {
  test('requires an explicit legacy-write opt-in when no Markdown authority is configured', () => {
    const { database } = createStore();
    const store = new MemoryStore!(database);
    expect(() => store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'Default writes are disabled.',
      structuredData: { subject: 'writer', predicate: 'mode', object: 'authority', confidence: 1 },
      scope: { level: 'global' },
    })).toThrow(/markdown_authority_required/i);
  });

  test('keeps inferred memories as candidates until approval, then supersedes the corrected active memory', () => {
    const { store } = createStore();
    const oldMemory = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const candidate = store.saveCandidate({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses npm.',
      structuredData: { subject: ' Project ', predicate: 'PACKAGE_MANAGER', object: 'npm', confidence: 0.5 },
      scope: { level: 'project', projectId: 'memlume' },
    });

    expect(candidate.status).toBe('candidate');
    expect(store.get(oldMemory.id)).toMatchObject({ status: 'active', supersededBy: undefined });
    expect(store.list({ status: 'candidate' })).toEqual([candidate]);

    const approved = store.approveCandidate(candidate.id, {
      actor: 'test-user',
      reason: 'The user corrected the project package manager.',
      supersedeMemoryId: oldMemory.id,
    });

    expect(approved).toMatchObject({ id: candidate.id, status: 'active' });
    expect(store.get(oldMemory.id)).toMatchObject({ status: 'superseded', supersededBy: candidate.id });
    expect(store.listVersions(oldMemory.id)).toEqual([
      expect.objectContaining({ canonicalText: oldMemory.canonicalText, changedBy: 'test-user' }),
    ]);
    expect(store.listVersions(candidate.id)).toEqual([
      expect.objectContaining({ canonicalText: candidate.canonicalText, changedBy: 'test-user' }),
    ]);
    expect(store.listHistory(oldMemory.id).map((memory) => memory.id)).toEqual([oldMemory.id, candidate.id]);
  });

  test('rejects a candidate without changing the active memory', () => {
    const { store } = createStore();
    const active = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const candidate = store.saveCandidate({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses npm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'npm', confidence: 0.5 },
      scope: { level: 'project', projectId: 'memlume' },
    });

    expect(store.rejectCandidate(candidate.id, { actor: 'test-user', reason: 'This was only an inference.' })).toMatchObject({
      id: candidate.id,
      status: 'rejected',
    });
    expect(store.get(active.id)).toMatchObject({ status: 'active', supersededBy: undefined });
    expect(store.list({ status: 'candidate' })).toEqual([]);
    expect(store.listVersions(candidate.id)).toEqual([
      expect.objectContaining({ canonicalText: candidate.canonicalText, changedBy: 'test-user' }),
    ]);
  });

  test('does not approve a candidate into an active duplicate', () => {
    const { store } = createStore();
    const candidate = store.saveCandidate({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 0.5 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const active = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });

    expect(() => store.approveCandidate(candidate.id, {
      actor: 'test-user',
      reason: 'Approve the inferred fact.',
    })).toThrow(/duplicate/i);
    expect(store.list({ status: 'active' })).toEqual([active]);
    expect(store.get(candidate.id)).toMatchObject({ status: 'candidate' });
  });

  test('does not let a candidate supersede an unrelated active memory', () => {
    const { store } = createStore();
    const unrelated = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The user lives in Taipei.',
      structuredData: { subject: 'user', predicate: 'location', object: 'Taipei', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const candidate = store.saveCandidate({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 0.5 },
      scope: { level: 'project', projectId: 'memlume' },
    });

    expect(() => store.approveCandidate(candidate.id, {
      actor: 'test-user',
      reason: 'This must not replace an unrelated fact.',
      supersedeMemoryId: unrelated.id,
    })).toThrow(/same subject/i);
    expect(store.get(unrelated.id)).toMatchObject({ status: 'active' });
    expect(store.get(candidate.id)).toMatchObject({ status: 'candidate' });
  });

  test('requires the matching active memory id when a candidate conflicts on its semantic subject', () => {
    const { store } = createStore();
    const conflicting = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses pnpm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const unrelated = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses TypeScript.',
      structuredData: { subject: 'project', predicate: 'language', object: 'TypeScript', confidence: 1 },
      scope: { level: 'project', projectId: 'memlume' },
    });
    const candidate = store.saveCandidate({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'The project uses npm.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'npm', confidence: 0.5 },
      scope: { level: 'project', projectId: 'memlume' },
    });

    expect(() => store.approveCandidate(candidate.id, {
      actor: 'test-user',
      reason: 'Approve without the required supersession target.',
    })).toThrow(/supersede/i);
    expect(() => store.approveCandidate(candidate.id, {
      actor: 'test-user',
      reason: 'Approve with an unrelated target.',
      supersedeMemoryId: unrelated.id,
    })).toThrow(/supersede/i);
    expect(store.get(conflicting.id)).toMatchObject({ status: 'active' });
    expect(store.get(unrelated.id)).toMatchObject({ status: 'active' });
    expect(store.get(candidate.id)).toMatchObject({ status: 'candidate' });
  });

  test('writes incrementing prior snapshots atomically with a required actor and reason', () => {
    const { database, store } = createStore();
    const fact = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      canonicalText: 'SQLite is the local durable memory store.',
      structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
      scope: { level: 'global' },
    });

    expect(() => store.update(fact.id, { canonicalText: 'Invalid update.' } as never)).toThrow();
    expect(store.listVersions(fact.id)).toEqual([]);

    const first = store.update(fact.id, {
      canonicalText: 'PostgreSQL is not the local durable memory store.',
      actor: 'test-user',
      reason: 'Correct the storage statement.',
    });
    const second = store.update(first.id, {
      canonicalText: 'SQLite is the local durable memory store for v0.1.',
      actor: 'test-user',
      reason: 'Clarify the version scope.',
    });

    expect(store.listVersions(fact.id)).toEqual([
      expect.objectContaining({
        version: 1,
        canonicalText: fact.canonicalText,
        changedBy: 'test-user',
        changeReason: 'Correct the storage statement.',
      }),
      expect.objectContaining({
        version: 2,
        canonicalText: first.canonicalText,
        changedBy: 'test-user',
        changeReason: 'Clarify the version scope.',
      }),
    ]);

    database.exec(`
      CREATE TRIGGER reject_memory_update
      BEFORE UPDATE ON memory_items
      BEGIN
        SELECT RAISE(ABORT, 'forced update failure');
      END;
    `);
    expect(() =>
      store.update(second.id, {
        canonicalText: 'This update must roll back.',
        actor: 'test-user',
        reason: 'Exercise the transaction boundary.',
      }),
    ).toThrow(/forced update failure/);
    expect(store.listVersions(fact.id)).toHaveLength(2);
  });

  test('rejects malformed manual payloads before persistence', () => {
    const { store } = createStore();
    const invalid = [
      {
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        kind: 'preference',
        canonicalText: 'A malformed preference.',
        structuredData: null,
        scope: { level: 'global' },
      },
      {
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        kind: 'fact',
        canonicalText: 'A malformed fact.',
        structuredData: { subject: 'logo', predicate: 'source_size', object: null, confidence: 1 },
        scope: { level: 'global' },
      },
      {
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        kind: 'decision',
        canonicalText: 'A malformed decision.',
        structuredData: { rationale: [] },
        scope: { level: 'global' },
      },
    ];

    for (const memory of invalid) {
      expect(() => store.save(memory as never)).toThrow();
    }
    expect(store.list()).toEqual([]);
  });

  test('saves only manual active memories, validates stored JSON, and refreshes FTS5 on update', () => {
    const { database, store } = createStore();
    const fact = store.save({
      brainId: DEFAULT_PERSONAL_BRAIN_ID,
      kind: 'fact',
      title: 'Storage choice',
      canonicalText: 'SQLite is the local durable memory store.',
      structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
      scope: { level: 'global' },
      priority: 10,
    });

    expect(MemoryItemSchema.parse(fact)).toEqual(fact);
    expect(fact.brainId).toBe(DEFAULT_PERSONAL_BRAIN_ID);
    expect(database.prepare('SELECT brain_id FROM memory_brains WHERE memory_id = ?').get(fact.id)).toEqual({
      brain_id: DEFAULT_PERSONAL_BRAIN_ID,
    });
    expect(store.get(fact.id)).toEqual(fact);
    expect(store.search('SQLite durable memory', { status: 'active', kinds: ['fact'] })).toEqual([fact]);

    const updated = store.update(fact.id, {
      canonicalText: 'PostgreSQL is not the local durable memory store.',
      actor: 'test-user',
      reason: 'Correct the storage statement.',
    });
    expect(updated.createdAt).toBe(fact.createdAt);
    expect(updated.updatedAt >= fact.updatedAt).toBe(true);
    expect(store.search('SQLite', { kinds: ['fact'] })).toEqual([]);
    expect(store.search('PostgreSQL durable memory', { kinds: ['fact'] })).toEqual([updated]);
    expect(store.list({ scope: { level: 'global' }, status: 'active', kinds: ['fact'] })).toEqual([updated]);

    expect(() =>
      store.save({
        brainId: DEFAULT_PERSONAL_BRAIN_ID,
        kind: 'procedure' as never,
        canonicalText: 'This cannot be manually saved in v0.1.',
        structuredData: {},
        scope: { level: 'global' },
      }),
    ).toThrow(/policy|preference|fact|decision/i);
  });

  test('isolates memory reads by brain while allowing an explicit multi-brain search', () => {
    const { database, store } = createStore();
    const firstBrainId = '018f9d4e-7c22-7b91-8dc0-61749dbcc012';
    const secondBrainId = '018f9d4e-7c23-7b91-8dc0-61749dbcc013';
    createBrain(database, firstBrainId);
    createBrain(database, secondBrainId);

    const draft = {
      kind: 'fact' as const,
      canonicalText: 'pnpm is the project package manager.',
      structuredData: { subject: 'project', predicate: 'package_manager', object: 'pnpm', confidence: 1 },
      scope: { level: 'global' as const },
    };
    const first = store.save({ ...draft, brainId: firstBrainId });
    const second = store.save({ ...draft, brainId: secondBrainId });

    expect(first.brainId).toBe(firstBrainId);
    expect(second.brainId).toBe(secondBrainId);
    expect(store.get(first.id)).toBeUndefined();
    expect(store.get(first.id, [secondBrainId])).toBeUndefined();
    expect(store.get(first.id, [firstBrainId])).toEqual(first);
    expect(store.list()).toEqual([]);
    expect(store.search('pnpm package manager')).toEqual([]);
    expect(store.findApplicable({ level: 'global' })).toEqual([]);
    expect(store.search('pnpm package manager', { brainIds: [firstBrainId] })).toEqual([first]);
    expect(store.findApplicable({ level: 'global' }, { brainIds: [secondBrainId] })).toEqual([second]);
    expect(store.search('pnpm package manager', { brainIds: [firstBrainId, secondBrainId] })).toEqual(
      expect.arrayContaining([first, second]),
    );

    expect(() =>
      store.update(
        first.id,
        {
          canonicalText: 'This cross-brain update must be rejected.',
          actor: 'test-user',
          reason: 'Verify read/write access is scoped to the selected brain.',
        },
        [secondBrainId],
      ),
    ).toThrow(/Memory not found/);

    const updated = store.update(first.id, {
      canonicalText: 'pnpm is the project package manager for this workspace.',
      brainId: secondBrainId,
      actor: 'test-user',
      reason: 'Verify that updates cannot move a memory between brains.',
    } as never, [firstBrainId]);

    expect(updated.brainId).toBe(firstBrainId);
    expect(store.listVersions(first.id)).toEqual([]);
    expect(store.listVersions(first.id, [secondBrainId])).toEqual([]);
    expect(store.listVersions(first.id, [firstBrainId])).toHaveLength(1);
    expect(database.prepare('SELECT brain_id FROM memory_brains WHERE memory_id = ?').all(first.id)).toEqual([
      { brain_id: firstBrainId },
    ]);
  });

  test('does not expose an unmapped memory row as a personal memory', () => {
    const { database, store } = createStore();
    const id = insertUnmappedMemory(database);

    expect(store.get(id)).toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(store.search('unmapped memory')).toEqual([]);
    expect(store.findApplicable({ level: 'global' })).toEqual([]);
  });

  test('requires a source event from the same brain before writing any memory rows', () => {
    const { database, store } = createStore();
    const memoryBrainId = '018f9d4e-7c26-7b91-8dc0-61749dbcc016';
    const otherBrainId = '018f9d4e-7c27-7b91-8dc0-61749dbcc017';
    const sameBrainEventId = '018f9d4e-7c28-7b91-8dc0-61749dbcc018';
    const otherBrainEventId = '018f9d4e-7c29-7b91-8dc0-61749dbcc019';
    const missingEventId = '018f9d4e-7c2a-7b91-8dc0-61749dbcc020';
    createBrain(database, memoryBrainId);
    createBrain(database, otherBrainId);
    insertEvent(database, sameBrainEventId, memoryBrainId);
    insertEvent(database, otherBrainEventId, otherBrainId);

    const draft = {
      kind: 'fact' as const,
      canonicalText: 'The source event is scoped to this brain.',
      structuredData: { subject: 'source', predicate: 'brain', object: 'same', confidence: 1 },
      scope: { level: 'global' as const },
      brainId: memoryBrainId,
    };
    const saved = store.save({ ...draft, sourceEventId: sameBrainEventId });
    expect(store.get(saved.id, [memoryBrainId])).toEqual(saved);

    let mismatch: unknown;
    try {
      store.save({ ...draft, sourceEventId: otherBrainEventId });
    } catch (error) {
      mismatch = error;
    }
    expect(mismatch).toBeInstanceOf(SourceEventBrainMismatchError);
    expect((mismatch as Error).message).not.toContain(otherBrainEventId);
    expect(() => store.save({ ...draft, sourceEventId: missingEventId })).toThrow(SourceEventBrainMismatchError);
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_brains').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM memory_search').get()).toEqual({ count: 1 });
  });
});
