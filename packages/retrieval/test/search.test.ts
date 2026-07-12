import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryItemSchema, type MemoryItem, type MemoryScope } from '@memlume/contracts';
import { openDatabase, type SqliteDatabase } from '@memlume/database/internal';
import { afterEach, describe, expect, test } from 'vitest';

import * as retrieval from '../src/index.js';

type MemoryDraft = {
  readonly kind: 'policy' | 'preference' | 'fact' | 'decision';
  readonly canonicalText: string;
  readonly structuredData: Record<string, unknown>;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly priority?: number;
  readonly confidence?: number;
  readonly explicitness?: number;
};

type MemoryStore = {
  save(input: MemoryDraft): MemoryItem;
  update(id: string, input: Partial<Omit<MemoryDraft, 'kind'>> & { readonly actor: string; readonly reason: string }): MemoryItem;
  get(id: string): MemoryItem | undefined;
  list(filters?: { readonly scope?: MemoryScope; readonly status?: string; readonly kinds?: readonly string[] }): MemoryItem[];
  search(query: string, filters?: { readonly status?: string; readonly kinds?: readonly string[] }): MemoryItem[];
  listVersions(id: string): Array<{
    readonly version: number;
    readonly canonicalText: string;
    readonly changedBy: string;
    readonly changeReason: string;
  }>;
};

type MemoryStoreConstructor = new (database: SqliteDatabase) => MemoryStore;
const { MemoryStore } = retrieval as { MemoryStore?: MemoryStoreConstructor };

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

function createStore(): { database: SqliteDatabase; store: MemoryStore } {
  const directory = mkdtempSync(join(tmpdir(), 'memlume-retrieval-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'memlume.sqlite'));
  databases.push(database);

  expect(MemoryStore).toBeTypeOf('function');
  return { database, store: new MemoryStore!(database) };
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
  test('writes incrementing prior snapshots atomically with a required actor and reason', () => {
    const { database, store } = createStore();
    const fact = store.save({
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
        kind: 'preference',
        canonicalText: 'A malformed preference.',
        structuredData: null,
        scope: { level: 'global' },
      },
      {
        kind: 'fact',
        canonicalText: 'A malformed fact.',
        structuredData: { subject: 'logo', predicate: 'source_size', object: null, confidence: 1 },
        scope: { level: 'global' },
      },
      {
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
    const { store } = createStore();
    const fact = store.save({
      kind: 'fact',
      title: 'Storage choice',
      canonicalText: 'SQLite is the local durable memory store.',
      structuredData: { subject: 'Memlume', predicate: 'uses', object: 'SQLite', confidence: 1 },
      scope: { level: 'global' },
      priority: 10,
    });

    expect(MemoryItemSchema.parse(fact)).toEqual(fact);
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
        kind: 'procedure' as never,
        canonicalText: 'This cannot be manually saved in v0.1.',
        structuredData: {},
        scope: { level: 'global' },
      }),
    ).toThrow(/policy|preference|fact|decision/i);
  });
});
